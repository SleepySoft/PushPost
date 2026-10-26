import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  articleContentHash,
  loadContentRepository,
  type Deployment,
  type DeploymentManager,
  type DistributionTask,
  type GitConnector,
  type SiteSnapshot,
  type StateStore,
} from '@pushpost/core';
import type { AdapterRegistry } from '@pushpost/adapters';
import type { ServerConfig } from './config.js';
import { cacheSnapshotAssets } from './build.js';
import { operationFor } from './distribution.js';

export interface SyncResult {
  snapshot: SiteSnapshot;
  deployment: Deployment;
  tasks: DistributionTask[];
}

async function hashLocalTree(root: string): Promise<string> {
  const hash = createHash('sha256');
  async function walk(directory: string, relative = ''): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(child, name);
      else if (entry.isFile()) {
        hash.update(name);
        hash.update(await readFile(child));
      } else throw new Error(`Unsupported local content entry: ${name}`);
    }
  }
  await walk(root);
  return `local-${hash.digest('hex')}`;
}

export class SyncCoordinator {
  private queue: Promise<unknown> = Promise.resolve();
  private root: string;

  constructor(
    private readonly config: ServerConfig,
    private readonly store: StateStore,
    private readonly git: GitConnector | null,
    private readonly registry: AdapterRegistry,
    private readonly deployments: DeploymentManager,
  ) {
    this.root = config.contentRoot ?? config.workDir;
  }

  sync(actorUserId: string | null = null): Promise<SyncResult> {
    const operation = this.queue.then(() => this.perform(actorUserId));
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private async perform(actorUserId: string | null): Promise<SyncResult> {
    let sourceCommit = 'unknown';
    try {
      if (this.config.contentRoot) {
        this.root = this.config.contentRoot;
        sourceCommit = await hashLocalTree(this.root);
      } else {
        if (!this.git) throw new Error('Git connector is not configured');
        const result = await this.git.sync();
        this.root = result.workDir;
        sourceCommit = result.commit;
      }
      const snapshot = loadContentRepository({
        rootDir: this.root,
        sourceCommit,
        siteUrl: this.config.siteUrl,
        siteTitle: this.config.siteTitle,
        registeredAdapterTypes: ['wordpress', 'export'].filter((type) => this.registry.has(type)),
        now: new Date(),
      });
      await cacheSnapshotAssets(this.config, snapshot, this.root);
      this.store.saveSnapshot(this.config.repositoryId, snapshot);
      for (const target of snapshot.targets) {
        this.store.upsertPlatformAccount({
          id: randomUUID(),
          repositoryId: this.config.repositoryId,
          targetAlias: target.alias,
          adapterType: target.type,
          credentialRef: target.credentialRef ?? null,
          options: target.options,
          enabled: target.enabled,
        });
      }
      const deployment = await this.deployments.deploy({ snapshot });
      const tasks = this.plan(snapshot);
      this.store.recordAuditEvent({
        repositoryId: this.config.repositoryId,
        actorUserId,
        action: 'repository.synchronized',
        entityType: 'deployment',
        entityId: deployment.id,
        details: { sourceCommit, visibilityHash: snapshot.visibilityHash, plannedTasks: tasks.length },
      });
      return { snapshot, deployment, tasks };
    } catch (error) {
      this.store.recordAuditEvent({
        repositoryId: this.config.repositoryId,
        actorUserId,
        action: 'repository.sync_failed',
        entityType: 'repository',
        entityId: this.config.repositoryId,
        details: { sourceCommit, error: error instanceof Error ? error.message.slice(0, 2000) : 'Unknown sync error' },
      });
      throw error;
    }
  }

  private plan(snapshot: SiteSnapshot): DistributionTask[] {
    const tasks: DistributionTask[] = [];
    for (const article of snapshot.articles.filter((item) => item.visible)) {
      for (const intent of article.distribution.filter((item) => item.trigger === 'auto')) {
        const target = snapshot.targets.find((item) => item.alias === intent.target);
        if (!target?.enabled) continue;
        const remote = this.store.getRemoteObject(this.config.repositoryId, article.id, target.alias);
        const operation = operationFor(article, target, remote !== null);
        const contentHash = articleContentHash(article);
        const existing = this.store.listTasks({ repositoryId: this.config.repositoryId, articleId: article.id, targetAlias: target.alias, limit: 1000 });
        if (existing.some((task) => task.contentHash === contentHash)) continue;
        tasks.push(this.store.createTask({
          repositoryId: this.config.repositoryId,
          articleId: article.id,
          targetAlias: target.alias,
          operation,
          sourceCommit: snapshot.sourceCommit,
          contentHash,
        }));
      }
    }
    return tasks;
  }
}
