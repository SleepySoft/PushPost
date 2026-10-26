import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type {
  CurrentRelease,
  Deployment,
  DeploymentManagerOptions,
  DeploymentRequest,
} from './types.js';
import type { StateStore } from './state-store.js';

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.stack ?? error.message : String(error)).slice(0, 32_000);
}

export class DeploymentManager {
  readonly repositoryId: string;
  readonly releasesDir: string;
  readonly currentFile: string;
  private readonly store: StateStore;
  private readonly build: DeploymentManagerOptions['build'];
  private readonly keepReleases: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: DeploymentManagerOptions) {
    if (!options.repositoryId) throw new TypeError('repositoryId is required');
    this.repositoryId = options.repositoryId;
    this.releasesDir = path.resolve(options.releasesDir);
    this.currentFile = path.join(this.releasesDir, 'current.json');
    this.store = options.store;
    this.build = options.build;
    this.keepReleases = options.keepReleases ?? 2;
    if (!Number.isSafeInteger(this.keepReleases) || this.keepReleases < 2) {
      throw new TypeError('keepReleases must be at least 2 so the previous release remains available');
    }
  }

  deploy(request: DeploymentRequest): Promise<Deployment> {
    return this.serialize(async () => {
      await mkdir(this.releasesDir, { recursive: true });
      const { snapshot } = request;
      const existing = this.store.findDeployment(this.repositoryId, snapshot.sourceCommit, snapshot.visibilityHash);
      if (existing) return existing;
      const id = randomUUID();
      const releaseDir = path.join(this.releasesDir, id);
      const deployment = this.store.createDeployment({
        id,
        repositoryId: this.repositoryId,
        sourceCommit: snapshot.sourceCommit,
        visibilityHash: snapshot.visibilityHash,
        releasePath: releaseDir,
      });
      if (deployment.id !== id || deployment.status !== 'queued') return deployment;
      let activated = false;
      let previous: CurrentRelease | null = null;
      try {
        await mkdir(releaseDir, { recursive: false });
        this.store.markDeploymentBuilding(id);
        await this.build({ deploymentId: id, releaseDir, snapshot });
        const releaseStat = await stat(releaseDir);
        if (!releaseStat.isDirectory()) throw new Error('Build did not produce a release directory');
        previous = await this.getCurrentRelease();
        await this.activate({ deployment, deployedAt: new Date().toISOString() });
        activated = true;
        const completed = this.store.completeDeployment(id);
        await this.pruneReleases(completed.id, previous?.deploymentId).catch(() => undefined);
        return completed;
      } catch (error) {
        if (activated) await this.restorePointer(previous);
        try {
          this.store.failDeployment(id, errorMessage(error));
        } catch {
          void 0;
        }
        await rm(releaseDir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  rollback(deploymentId?: string): Promise<Deployment> {
    return this.serialize(async () => {
      const current = this.store.getCurrentDeployment(this.repositoryId);
      const target = deploymentId === undefined
        ? this.store.listDeployments(this.repositoryId, 1000).find((deployment) =>
          deployment.status === 'succeeded' && deployment.id !== current?.id && existsSync(deployment.releasePath))
        : this.store.getDeployment(deploymentId);
      if (!target || target.repositoryId !== this.repositoryId || target.status !== 'succeeded') {
        throw new Error(deploymentId ? `Deployment ${deploymentId} is not eligible for rollback` : 'No previous release is available for rollback');
      }
      if (path.dirname(path.resolve(target.releasePath)) !== this.releasesDir) {
        throw new Error('Refusing to activate a release outside releasesDir');
      }
      const targetStat = await stat(target.releasePath);
      if (!targetStat.isDirectory()) throw new Error(`Release directory is missing: ${target.releasePath}`);
      const previous = await this.getCurrentRelease();
      await this.activate({ deployment: target, deployedAt: new Date().toISOString() });
      try {
        return this.store.setCurrentDeployment(target.id);
      } catch (error) {
        await this.restorePointer(previous);
        throw error;
      }
    });
  }

  async getCurrentRelease(): Promise<CurrentRelease | null> {
    let text: string;
    try {
      text = await readFile(this.currentFile, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const value = JSON.parse(text) as Partial<CurrentRelease>;
    if (typeof value.deploymentId !== 'string' || value.repositoryId !== this.repositoryId
      || typeof value.sourceCommit !== 'string' || typeof value.visibilityHash !== 'string'
      || typeof value.releasePath !== 'string' || typeof value.deployedAt !== 'string') {
      throw new Error(`Invalid current release pointer: ${this.currentFile}`);
    }
    const releasePath = path.resolve(value.releasePath);
    if (path.dirname(releasePath) !== this.releasesDir) throw new Error('Current release pointer escapes releasesDir');
    return {
      deploymentId: value.deploymentId,
      repositoryId: value.repositoryId,
      sourceCommit: value.sourceCommit,
      visibilityHash: value.visibilityHash,
      releasePath,
      deployedAt: value.deployedAt,
    };
  }

  async getCurrentStaticRoot(): Promise<string | null> {
    const current = await this.getCurrentRelease();
    if (!current) return null;
    const releaseStat = await stat(current.releasePath);
    if (!releaseStat.isDirectory()) throw new Error(`Current release is not a directory: ${current.releasePath}`);
    return current.releasePath;
  }

  private async activate(input: { deployment: Deployment; deployedAt: string }): Promise<void> {
    const current: CurrentRelease = {
      deploymentId: input.deployment.id,
      repositoryId: this.repositoryId,
      sourceCommit: input.deployment.sourceCommit,
      visibilityHash: input.deployment.visibilityHash,
      releasePath: input.deployment.releasePath,
      deployedAt: input.deployedAt,
    };
    await this.writePointer(current);
  }

  private async writePointer(current: CurrentRelease): Promise<void> {
    const temporary = path.join(this.releasesDir, `.current-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(current, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, this.currentFile);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  private async restorePointer(previous: CurrentRelease | null): Promise<void> {
    if (previous) await this.writePointer(previous);
    else await unlink(this.currentFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  private async pruneReleases(currentId: string, previousId?: string): Promise<void> {
    const keep = new Set([currentId, previousId]);
    const successful = this.store.listDeployments(this.repositoryId, 1000)
      .filter((deployment) => deployment.status === 'succeeded')
      .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''));
    for (const deployment of successful) {
      if (keep.size >= this.keepReleases) break;
      keep.add(deployment.id);
    }
    await Promise.all(successful.filter((deployment) => !keep.has(deployment.id)).map(async (deployment) => {
      if (path.dirname(path.resolve(deployment.releasePath)) === this.releasesDir) {
        await rm(deployment.releasePath, { recursive: true, force: true });
      }
    }));
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
