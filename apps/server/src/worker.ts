import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { DistributionTask, StateStore } from '@pushpost/core';
import {
  AdapterError,
  credentialEnvName,
  type AdapterRegistry,
  type PlatformAdapter,
} from '@pushpost/adapters';
import type { ServerConfig } from './config.js';
import { requireSnapshotAssets } from './build.js';
import { modeFor } from './distribution.js';

export class DistributionWorker {
  readonly workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly config: ServerConfig,
    private readonly store: StateStore,
    private readonly registry: AdapterRegistry,
  ) {}

  start(): void {
    const now = new Date().toISOString();
    this.store.db.transaction(() => {
      this.store.db.prepare(`UPDATE distribution_tasks SET status = 'manual_required', lease_owner = NULL, lease_until = NULL,
        last_error = 'Worker stopped during a create operation; verify the remote platform before retrying', updated_at = ?
        WHERE status = 'running' AND operation IN ('create_draft', 'publish')
          AND NOT EXISTS (SELECT 1 FROM remote_objects WHERE remote_objects.repository_id = distribution_tasks.repository_id
            AND remote_objects.article_id = distribution_tasks.article_id
            AND remote_objects.target_alias = distribution_tasks.target_alias)`).run(now);
      this.store.db.prepare(`UPDATE distribution_tasks SET status = 'failed', lease_owner = NULL, lease_until = NULL,
        last_error = 'Worker stopped before completion', updated_at = ? WHERE status = 'running' AND attempt_count >= max_attempts`)
        .run(now);
      this.store.db.prepare(`UPDATE distribution_tasks SET status = 'pending', lease_owner = NULL, lease_until = NULL,
        updated_at = ? WHERE status = 'running' AND attempt_count < max_attempts`).run(now);
    })();
    this.timer = setInterval(() => void this.run(), 1_000);
    this.timer.unref();
    void this.run();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.active;
  }

  run(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.active) return this.active;
    this.active = this.processAvailable().finally(() => { this.active = null; });
    return this.active;
  }

  private async processAvailable(): Promise<void> {
    while (!this.closed) {
      const tasks = this.store.claimTasks(this.workerId, 10, 120_000);
      if (tasks.length === 0) return;
      for (const task of tasks) {
        if (this.closed) return;
        await this.execute(task).catch(() => undefined);
      }
    }
  }

  private async execute(task: DistributionTask): Promise<void> {
    try {
      const snapshot = this.store.getSnapshotForTask(task);
      const article = snapshot?.articles.find((item) => item.id === task.articleId);
      const target = snapshot?.targets.find((item) => item.alias === task.targetAlias);
      if (!snapshot || !article || !target) throw new AdapterError('content', 'The task snapshot, article, or target is unavailable');
      if (!target.enabled) throw new AdapterError('content', 'The distribution target is disabled');
      const adapter = this.registry.forTarget(target);
      const snapshotRoot = await requireSnapshotAssets(this.config, snapshot);
      const contentRoot = path.join(snapshotRoot, 'content', article.category);
      const result = await adapter.execute({
        article,
        snapshot,
        target,
        operation: task.operation,
        credential: this.credentials(target, adapter),
        remoteObject: this.store.getRemoteObject(task.repositoryId, task.articleId, task.targetAlias),
        mode: modeFor(article, target),
        contentRoot,
        exportDir: this.config.exportsDir,
      });
      if (result.status === 'manual_required') {
        const archive = path.resolve(result.exportPath);
        if (path.dirname(archive) !== path.resolve(this.config.exportsDir)) throw new Error('Adapter returned an export outside exportsDir');
        this.store.recordAuditEvent({
          repositoryId: task.repositoryId,
          action: 'distribution.exported',
          entityType: 'task',
          entityId: task.id,
          details: { exportPath: archive, articleId: task.articleId, targetAlias: task.targetAlias },
        });
        this.store.failTask(task.id, 'Manual export is ready; remote result registration is required', {
          manualRequired: true,
          workerId: this.workerId,
        });
      } else {
        this.store.upsertRemoteObject({
          repositoryId: task.repositoryId,
          articleId: task.articleId,
          targetAlias: task.targetAlias,
          remoteId: result.remoteId,
          remoteUrl: result.url,
          remoteStatus: result.remoteStatus,
        });
        this.store.succeedTask(task.id, this.workerId);
        this.store.recordAuditEvent({
          repositoryId: task.repositoryId,
          action: 'distribution.succeeded',
          entityType: 'task',
          entityId: task.id,
          details: { articleId: task.articleId, targetAlias: task.targetAlias, remoteId: result.remoteId },
        });
      }
    } catch (error) {
      this.fail(task, error);
    }
  }

  private credentials(target: Parameters<typeof credentialEnvName>[0], adapter: PlatformAdapter): unknown {
    if (adapter.type !== 'wordpress') return undefined;
    const username = process.env[credentialEnvName(target, 'username')];
    const appPassword = process.env[credentialEnvName(target, 'app_password')];
    const configuredBaseUrl = target.options.baseUrl;
    const baseUrl = typeof configuredBaseUrl === 'string'
      ? configuredBaseUrl
      : process.env[credentialEnvName(target, 'base_url')];
    if (!username || !appPassword || !baseUrl) throw new AdapterError('authentication', 'WordPress environment credentials are incomplete');
    return { username, appPassword, baseUrl };
  }

  private fail(task: DistributionTask, error: unknown): void {
    const adapterError = error instanceof AdapterError ? error : null;
    const category = adapterError?.category ?? 'retryable';
    const message = error instanceof Error ? error.message.slice(0, 2000) : 'Distribution failed';
    try {
      if (category === 'retryable') {
        const retryAfter = adapterError?.retryAfterMs;
        const backoff = Math.min(300_000, 1_000 * 2 ** Math.max(0, task.attemptCount - 1));
        this.store.failTask(task.id, message, {
          workerId: this.workerId,
          retryAt: new Date(Date.now() + Math.max(backoff, retryAfter ?? 0)),
        });
      } else {
        this.store.failTask(task.id, message, { workerId: this.workerId, manualRequired: category === 'uncertain' });
      }
      this.store.recordAuditEvent({
        repositoryId: task.repositoryId,
        action: 'distribution.failed',
        entityType: 'task',
        entityId: task.id,
        details: { articleId: task.articleId, targetAlias: task.targetAlias, category, error: message },
      });
    } catch {
      return;
    }
  }
}
