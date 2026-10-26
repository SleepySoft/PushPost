import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type {
  Article,
  Deployment,
  DistributionTask,
  RemoteObject,
  SiteSnapshot,
  TaskOperation,
  TaskStatus,
} from './types.js';

export interface RepositoryRecord {
  id: string;
  remoteUrl: string;
  branch: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformAccountRecord {
  id: string;
  repositoryId: string;
  targetAlias: string;
  adapterType: string;
  credentialRef: string | null;
  options: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEventRecord {
  id: string;
  repositoryId: string | null;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface UserRecord {
  id: string;
  email: string;
  displayName: string;
  role: string;
  passwordHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
  lastSeenAt: string;
}

interface TaskRow {
  id: string;
  repository_id: string;
  article_id: string;
  target_alias: string;
  operation: TaskOperation;
  source_commit: string;
  content_hash: string;
  status: TaskStatus;
  attempt_count: number;
  max_attempts: number;
  available_at: string;
  last_error: string | null;
  lease_owner: string | null;
  lease_until: string | null;
  created_at: string;
  updated_at: string;
}

interface DeploymentRow {
  id: string;
  repository_id: string;
  source_commit: string;
  visibility_hash: string;
  release_path: string;
  status: Deployment['status'];
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface CreateTaskInput {
  id?: string;
  repositoryId: string;
  articleId: string;
  targetAlias: string;
  operation: TaskOperation;
  sourceCommit: string;
  contentHash: string;
  availableAt?: string | Date;
  maxAttempts?: number;
}

export interface TaskFilter {
  repositoryId?: string;
  articleId?: string;
  targetAlias?: string;
  status?: TaskStatus;
  limit?: number;
}

export interface CreateDeploymentInput {
  id?: string;
  repositoryId: string;
  sourceCommit: string;
  visibilityHash: string;
  releasePath: string;
}

function iso(value: string | Date = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`Invalid date: ${String(value)}`);
  return date.toISOString();
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, child]) => [key, normalize(child)]));
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

export function articleContentHash(article: Article): string {
  return createHash('sha256').update(canonicalJson(article)).digest('hex');
}

function parseJson(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}

function taskFromRow(row: TaskRow): DistributionTask {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    articleId: row.article_id,
    targetAlias: row.target_alias,
    operation: row.operation,
    sourceCommit: row.source_commit,
    contentHash: row.content_hash,
    status: row.status,
    attemptCount: row.attempt_count,
    availableAt: row.available_at,
    lastError: row.last_error,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deploymentFromRow(row: DeploymentRow): Deployment {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    sourceCommit: row.source_commit,
    visibilityHash: row.visibility_hash,
    releasePath: row.release_path,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export class StateStore {
  readonly db: Database.Database;

  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const current = Number(this.db.pragma('user_version', { simple: true }));
    if (current > 1) throw new Error(`Unsupported StateStore schema version ${current}`);
    if (current === 1) return;
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS repositories (
          id TEXT PRIMARY KEY,
          remote_url TEXT NOT NULL,
          branch TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS articles (
          repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
          article_id TEXT NOT NULL,
          slug TEXT NOT NULL,
          source_path TEXT NOT NULL,
          status TEXT NOT NULL,
          deleted_at TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (repository_id, article_id)
        );
        CREATE TABLE IF NOT EXISTS snapshots (
          repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
          source_commit TEXT NOT NULL,
          visibility_hash TEXT NOT NULL,
          snapshot_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (repository_id, source_commit, visibility_hash)
        );
        CREATE TABLE IF NOT EXISTS article_versions (
          repository_id TEXT NOT NULL,
          article_id TEXT NOT NULL,
          source_commit TEXT NOT NULL,
          visibility_hash TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          article_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (repository_id, article_id, source_commit, visibility_hash),
          FOREIGN KEY (repository_id, source_commit, visibility_hash)
            REFERENCES snapshots(repository_id, source_commit, visibility_hash) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS deployments (
          id TEXT PRIMARY KEY,
          repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
          source_commit TEXT NOT NULL,
          visibility_hash TEXT NOT NULL,
          release_path TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('queued', 'building', 'succeeded', 'failed')),
          is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
          error TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT
        );
        CREATE UNIQUE INDEX deployments_active_version
          ON deployments(repository_id, source_commit, visibility_hash)
          WHERE status IN ('queued', 'building');
        CREATE UNIQUE INDEX deployments_one_current ON deployments(repository_id) WHERE is_current = 1;
        CREATE INDEX deployments_history ON deployments(repository_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS platform_accounts (
          id TEXT PRIMARY KEY,
          repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
          target_alias TEXT NOT NULL,
          adapter_type TEXT NOT NULL,
          credential_ref TEXT,
          options_json TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (repository_id, target_alias)
        );
        CREATE TABLE IF NOT EXISTS remote_objects (
          repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
          article_id TEXT NOT NULL,
          target_alias TEXT NOT NULL,
          remote_id TEXT NOT NULL,
          remote_url TEXT,
          remote_status TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (repository_id, article_id, target_alias),
          UNIQUE (repository_id, target_alias, remote_id)
        );
        CREATE TABLE IF NOT EXISTS distribution_tasks (
          id TEXT PRIMARY KEY,
          repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
          article_id TEXT NOT NULL,
          target_alias TEXT NOT NULL,
          operation TEXT NOT NULL,
          source_commit TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'manual_required', 'cancelled')),
          attempt_count INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          available_at TEXT NOT NULL,
          last_error TEXT,
          lease_owner TEXT,
          lease_until TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX distribution_tasks_active
          ON distribution_tasks(repository_id, article_id, target_alias, operation)
          WHERE status IN ('pending', 'running');
        CREATE INDEX distribution_tasks_claim
          ON distribution_tasks(status, available_at, lease_until);
        CREATE INDEX distribution_tasks_article
          ON distribution_tasks(repository_id, article_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS webhook_events (
          repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
          event_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          received_at TEXT NOT NULL,
          PRIMARY KEY (repository_id, event_id)
        );
        CREATE TABLE IF NOT EXISTS audit_events (
          id TEXT PRIMARY KEY,
          repository_id TEXT REFERENCES repositories(id) ON DELETE SET NULL,
          actor_user_id TEXT,
          action TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT,
          details_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX audit_events_history ON audit_events(repository_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL UNIQUE COLLATE NOCASE,
          display_name TEXT NOT NULL,
          role TEXT NOT NULL,
          password_hash TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL
        );
        CREATE INDEX sessions_user ON sessions(user_id);
      `);
      this.db.pragma('user_version = 1');
    })();
  }

  upsertRepository(input: { id: string; remoteUrl: string; branch: string }): RepositoryRecord {
    const now = iso();
    this.db.prepare(`INSERT INTO repositories (id, remote_url, branch, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET remote_url = excluded.remote_url, branch = excluded.branch, updated_at = excluded.updated_at`)
      .run(input.id, input.remoteUrl, input.branch, now, now);
    return this.getRepository(input.id) as RepositoryRecord;
  }

  getRepository(id: string): RepositoryRecord | null {
    const row = this.db.prepare('SELECT * FROM repositories WHERE id = ?').get(id) as Record<string, string> | undefined;
    return row ? { id: row.id!, remoteUrl: row.remote_url!, branch: row.branch!, createdAt: row.created_at!, updatedAt: row.updated_at! } : null;
  }

  saveSnapshot(repositoryId: string, snapshot: SiteSnapshot): void {
    const now = iso();
    const contentHashes = new Map(snapshot.articles.map((article) => [article.id, articleContentHash(article)]));
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO snapshots (repository_id, source_commit, visibility_hash, snapshot_json, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(repository_id, source_commit, visibility_hash) DO NOTHING`)
        .run(repositoryId, snapshot.sourceCommit, snapshot.visibilityHash, json(snapshot), now);
      for (const article of snapshot.articles) {
        this.db.prepare(`INSERT INTO articles (repository_id, article_id, slug, source_path, status, deleted_at, updated_at)
          VALUES (?, ?, ?, ?, ?, NULL, ?)
          ON CONFLICT(repository_id, article_id) DO UPDATE SET slug = excluded.slug, source_path = excluded.source_path,
            status = excluded.status, deleted_at = NULL, updated_at = excluded.updated_at`)
          .run(repositoryId, article.id, article.slug, article.sourcePath, article.status, now);
        this.db.prepare(`INSERT OR IGNORE INTO article_versions
          (repository_id, article_id, source_commit, visibility_hash, content_hash, article_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(repositoryId, article.id, snapshot.sourceCommit, snapshot.visibilityHash,
            contentHashes.get(article.id), json(article), now);
      }
      this.db.prepare(`UPDATE articles SET deleted_at = ?, updated_at = ?
        WHERE repository_id = ? AND article_id NOT IN (SELECT json_each.value FROM json_each(?))`)
        .run(now, now, repositoryId, json(snapshot.articles.map((article) => article.id)));
    })();
  }

  getSnapshot(repositoryId: string, sourceCommit: string, visibilityHash?: string): SiteSnapshot | null {
    const row = visibilityHash === undefined
      ? this.db.prepare(`SELECT snapshot_json FROM snapshots WHERE repository_id = ? AND source_commit = ?
          ORDER BY created_at DESC LIMIT 1`).get(repositoryId, sourceCommit)
      : this.db.prepare(`SELECT snapshot_json FROM snapshots WHERE repository_id = ? AND source_commit = ?
          AND visibility_hash = ?`).get(repositoryId, sourceCommit, visibilityHash);
    return row ? JSON.parse((row as { snapshot_json: string }).snapshot_json) as SiteSnapshot : null;
  }

  getSnapshotForTask(task: DistributionTask): SiteSnapshot | null {
    const row = this.db.prepare(`SELECT s.snapshot_json FROM article_versions av
      INNER JOIN snapshots s ON s.repository_id = av.repository_id
        AND s.source_commit = av.source_commit AND s.visibility_hash = av.visibility_hash
      WHERE av.repository_id = ? AND av.article_id = ? AND av.source_commit = ? AND av.content_hash = ?
      ORDER BY s.created_at DESC, s.rowid DESC LIMIT 1`)
      .get(task.repositoryId, task.articleId, task.sourceCommit, task.contentHash) as { snapshot_json: string } | undefined;
    return row ? JSON.parse(row.snapshot_json) as SiteSnapshot : null;
  }

  getLatestSnapshot(repositoryId: string): SiteSnapshot | null {
    const row = this.db.prepare(`SELECT snapshot_json FROM snapshots WHERE repository_id = ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(repositoryId) as { snapshot_json: string } | undefined;
    return row ? JSON.parse(row.snapshot_json) as SiteSnapshot : null;
  }

  createDeployment(input: CreateDeploymentInput): Deployment {
    const id = input.id ?? randomUUID();
    const now = iso();
    try {
      this.db.prepare(`INSERT INTO deployments
        (id, repository_id, source_commit, visibility_hash, release_path, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'queued', ?)`)
        .run(id, input.repositoryId, input.sourceCommit, input.visibilityHash, input.releasePath, now);
    } catch (error) {
      const existing = this.findActiveDeployment(input.repositoryId, input.sourceCommit, input.visibilityHash);
      if (existing) return existing;
      throw error;
    }
    return this.getDeployment(id) as Deployment;
  }

  private findActiveDeployment(repositoryId: string, sourceCommit: string, visibilityHash: string): Deployment | null {
    const row = this.db.prepare(`SELECT * FROM deployments WHERE repository_id = ? AND source_commit = ?
      AND visibility_hash = ? AND status IN ('queued', 'building')`).get(repositoryId, sourceCommit, visibilityHash) as DeploymentRow | undefined;
    return row ? deploymentFromRow(row) : null;
  }

  getDeployment(id: string): Deployment | null {
    const row = this.db.prepare('SELECT * FROM deployments WHERE id = ?').get(id) as DeploymentRow | undefined;
    return row ? deploymentFromRow(row) : null;
  }

  findDeployment(repositoryId: string, sourceCommit: string, visibilityHash: string): Deployment | null {
    const row = this.db.prepare(`SELECT * FROM deployments WHERE repository_id = ? AND source_commit = ?
      AND visibility_hash = ? AND status = 'succeeded' ORDER BY finished_at DESC LIMIT 1`)
      .get(repositoryId, sourceCommit, visibilityHash) as DeploymentRow | undefined;
    return row ? deploymentFromRow(row) : null;
  }

  listDeployments(repositoryId: string, limit = 50): Deployment[] {
    return (this.db.prepare('SELECT * FROM deployments WHERE repository_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(repositoryId, Math.max(1, Math.min(limit, 1000))) as DeploymentRow[]).map(deploymentFromRow);
  }

  markDeploymentBuilding(id: string): void {
    const result = this.db.prepare(`UPDATE deployments SET status = 'building', started_at = ?
      WHERE id = ? AND status = 'queued'`).run(iso(), id);
    if (result.changes !== 1) throw new Error(`Deployment ${id} is not queued`);
  }

  completeDeployment(id: string): Deployment {
    const now = iso();
    this.db.transaction(() => {
      const deployment = this.getDeployment(id);
      if (!deployment || deployment.status !== 'building') throw new Error(`Deployment ${id} is not building`);
      this.db.prepare('UPDATE deployments SET is_current = 0 WHERE repository_id = ?').run(deployment.repositoryId);
      this.db.prepare(`UPDATE deployments SET status = 'succeeded', is_current = 1, finished_at = ?, error = NULL WHERE id = ?`)
        .run(now, id);
    })();
    return this.getDeployment(id) as Deployment;
  }

  failDeployment(id: string, error: string): Deployment {
    const result = this.db.prepare(`UPDATE deployments SET status = 'failed', is_current = 0,
      error = ?, finished_at = ? WHERE id = ? AND status IN ('queued', 'building')`).run(error, iso(), id);
    if (result.changes !== 1) throw new Error(`Deployment ${id} is not active`);
    return this.getDeployment(id) as Deployment;
  }

  getCurrentDeployment(repositoryId: string): Deployment | null {
    const row = this.db.prepare(`SELECT * FROM deployments WHERE repository_id = ? AND is_current = 1`)
      .get(repositoryId) as DeploymentRow | undefined;
    return row ? deploymentFromRow(row) : null;
  }

  setCurrentDeployment(id: string): Deployment {
    this.db.transaction(() => {
      const deployment = this.getDeployment(id);
      if (!deployment || deployment.status !== 'succeeded') throw new Error(`Deployment ${id} is not a successful deployment`);
      this.db.prepare('UPDATE deployments SET is_current = 0 WHERE repository_id = ?').run(deployment.repositoryId);
      this.db.prepare('UPDATE deployments SET is_current = 1 WHERE id = ?').run(id);
    })();
    return this.getDeployment(id) as Deployment;
  }

  createTask(input: CreateTaskInput): DistributionTask {
    const id = input.id ?? randomUUID();
    const now = iso();
    const availableAt = input.availableAt === undefined ? now : iso(input.availableAt);
    const maxAttempts = input.maxAttempts ?? 3;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('maxAttempts must be a positive integer');
    return this.db.transaction(() => {
      const existing = this.findActiveTask(input);
      if (existing) {
        if (existing.status === 'pending' && (existing.sourceCommit !== input.sourceCommit || existing.contentHash !== input.contentHash)) {
          this.db.prepare(`UPDATE distribution_tasks SET source_commit = ?, content_hash = ?, available_at = ?, updated_at = ?
            WHERE id = ? AND status = 'pending'`).run(input.sourceCommit, input.contentHash, availableAt, now, existing.id);
          return this.getTask(existing.id) as DistributionTask;
        }
        return existing;
      }
      try {
        this.db.prepare(`INSERT INTO distribution_tasks
          (id, repository_id, article_id, target_alias, operation, source_commit, content_hash, status, available_at, max_attempts, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`)
          .run(id, input.repositoryId, input.articleId, input.targetAlias, input.operation, input.sourceCommit,
            input.contentHash, availableAt, maxAttempts, now, now);
      } catch (error) {
        const concurrent = this.findActiveTask(input);
        if (concurrent) return concurrent;
        throw error;
      }
      return this.getTask(id) as DistributionTask;
    })();
  }

  private findActiveTask(input: CreateTaskInput): DistributionTask | null {
    const row = this.db.prepare(`SELECT * FROM distribution_tasks WHERE repository_id = ? AND article_id = ?
      AND target_alias = ? AND operation = ? AND status IN ('pending', 'running')`)
      .get(input.repositoryId, input.articleId, input.targetAlias, input.operation) as TaskRow | undefined;
    return row ? taskFromRow(row) : null;
  }

  getTask(id: string): DistributionTask | null {
    const row = this.db.prepare('SELECT * FROM distribution_tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? taskFromRow(row) : null;
  }

  listTasks(filter: TaskFilter = {}): DistributionTask[] {
    const conditions: string[] = [];
    const values: Array<string | number> = [];
    for (const [column, value] of [
      ['repository_id', filter.repositoryId],
      ['article_id', filter.articleId],
      ['target_alias', filter.targetAlias],
      ['status', filter.status],
    ] as const) {
      if (value !== undefined) {
        conditions.push(`${column} = ?`);
        values.push(value);
      }
    }
    values.push(Math.max(1, Math.min(filter.limit ?? 100, 1000)));
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return (this.db.prepare(`SELECT * FROM distribution_tasks ${where} ORDER BY created_at, id LIMIT ?`)
      .all(...values) as TaskRow[]).map(taskFromRow);
  }

  claimTasks(workerId: string, limit = 10, leaseMs = 60_000): DistributionTask[] {
    if (!workerId || !Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new TypeError('Invalid worker or lease duration');
    const now = new Date();
    const nowIso = iso(now);
    const leaseUntil = iso(new Date(now.getTime() + leaseMs));
    return this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT * FROM distribution_tasks
        WHERE attempt_count < max_attempts AND ((status = 'pending' AND available_at <= ?)
           OR (status = 'running' AND lease_until IS NOT NULL AND lease_until <= ?))
        ORDER BY available_at, created_at, id LIMIT ?`)
        .all(nowIso, nowIso, Math.max(1, Math.min(limit, 100))) as TaskRow[];
      for (const row of rows) {
        this.db.prepare(`UPDATE distribution_tasks SET status = 'running', attempt_count = attempt_count + 1,
          lease_owner = ?, lease_until = ?, updated_at = ? WHERE id = ?`)
          .run(workerId, leaseUntil, nowIso, row.id);
      }
      return rows.map((row) => this.getTask(row.id) as DistributionTask);
    })();
  }

  claimTask(id: string, workerId: string, leaseMs = 60_000): DistributionTask | null {
    if (!workerId || !Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new TypeError('Invalid worker or lease duration');
    const claimed = this.db.transaction(() => {
      const now = new Date();
      const nowIso = iso(now);
      const leaseUntil = iso(new Date(now.getTime() + leaseMs));
      const result = this.db.prepare(`UPDATE distribution_tasks SET status = 'running', attempt_count = attempt_count + 1,
        lease_owner = ?, lease_until = ?, updated_at = ? WHERE id = ? AND attempt_count < max_attempts
        AND ((status = 'pending' AND available_at <= ?) OR (status = 'running' AND lease_until <= ?))`)
        .run(workerId, leaseUntil, nowIso, id, nowIso, nowIso);
      return result.changes === 1;
    })();
    return claimed ? this.getTask(id) : null;
  }

  succeedTask(id: string, workerId?: string): DistributionTask {
    return this.finishTask(id, 'succeeded', null, workerId);
  }

  failTask(id: string, error: string, options: { manualRequired?: boolean; workerId?: string; retryAt?: string | Date } = {}): DistributionTask {
    const task = this.getTask(id);
    if (task && options.retryAt !== undefined && !options.manualRequired) {
      const row = this.db.prepare('SELECT max_attempts FROM distribution_tasks WHERE id = ?').get(id) as { max_attempts: number };
      if (task.attemptCount < row.max_attempts) {
        const condition = options.workerId === undefined ? '' : ' AND lease_owner = ?';
        const values = options.workerId === undefined
          ? [iso(options.retryAt), error, iso(), id]
          : [iso(options.retryAt), error, iso(), id, options.workerId];
        const result = this.db.prepare(`UPDATE distribution_tasks SET status = 'pending', available_at = ?, last_error = ?,
          lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND status = 'running'${condition}`).run(...values);
        if (result.changes !== 1) throw new Error(`Task ${id} is not running or belongs to another worker`);
        return this.getTask(id) as DistributionTask;
      }
    }
    return this.finishTask(id, options.manualRequired ? 'manual_required' : 'failed', error, options.workerId);
  }

  private finishTask(id: string, status: TaskStatus, error: string | null, workerId?: string): DistributionTask {
    const condition = workerId === undefined ? '' : ' AND lease_owner = ?';
    const values = workerId === undefined ? [status, error, iso(), id] : [status, error, iso(), id, workerId];
    const result = this.db.prepare(`UPDATE distribution_tasks SET status = ?, last_error = ?, lease_owner = NULL,
      lease_until = NULL, updated_at = ? WHERE id = ? AND status = 'running'${condition}`).run(...values);
    if (result.changes !== 1) throw new Error(`Task ${id} is not running or belongs to another worker`);
    return this.getTask(id) as DistributionTask;
  }

  retryTask(id: string, availableAt: string | Date = new Date()): DistributionTask {
    const result = this.db.prepare(`UPDATE distribution_tasks SET status = 'pending', attempt_count = 0, available_at = ?,
      lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND status IN ('failed', 'manual_required', 'cancelled')`)
      .run(iso(availableAt), iso(), id);
    if (result.changes !== 1) throw new Error(`Task ${id} cannot be retried from its current status`);
    return this.getTask(id) as DistributionTask;
  }

  cancelTask(id: string): DistributionTask {
    const result = this.db.prepare(`UPDATE distribution_tasks SET status = 'cancelled', lease_owner = NULL,
      lease_until = NULL, updated_at = ? WHERE id = ? AND status IN ('pending', 'failed', 'manual_required')`).run(iso(), id);
    if (result.changes !== 1) throw new Error(`Task ${id} cannot be cancelled while running or after completion`);
    return this.getTask(id) as DistributionTask;
  }

  upsertRemoteObject(input: Omit<RemoteObject, 'updatedAt'> & { updatedAt?: string | Date }): RemoteObject {
    const updatedAt = iso(input.updatedAt ?? new Date());
    this.db.prepare(`INSERT INTO remote_objects
      (repository_id, article_id, target_alias, remote_id, remote_url, remote_status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repository_id, article_id, target_alias) DO UPDATE SET remote_id = excluded.remote_id,
        remote_url = excluded.remote_url, remote_status = excluded.remote_status, updated_at = excluded.updated_at`)
      .run(input.repositoryId, input.articleId, input.targetAlias, input.remoteId, input.remoteUrl, input.remoteStatus, updatedAt);
    return this.getRemoteObject(input.repositoryId, input.articleId, input.targetAlias) as RemoteObject;
  }

  private remoteObjectFromRow(row: Record<string, string | null>): RemoteObject {
    return {
      repositoryId: row.repository_id as string,
      articleId: row.article_id as string,
      targetAlias: row.target_alias as string,
      remoteId: row.remote_id as string,
      remoteUrl: row.remote_url ?? null,
      remoteStatus: row.remote_status as string,
      updatedAt: row.updated_at as string,
    };
  }

  getRemoteObject(repositoryId: string, articleId: string, targetAlias: string): RemoteObject | null {
    const row = this.db.prepare(`SELECT * FROM remote_objects WHERE repository_id = ? AND article_id = ? AND target_alias = ?`)
      .get(repositoryId, articleId, targetAlias) as Record<string, string | null> | undefined;
    return row ? this.remoteObjectFromRow(row) : null;
  }

  listRemoteObjects(repositoryId: string, articleId?: string): RemoteObject[] {
    const rows = articleId === undefined
      ? this.db.prepare('SELECT * FROM remote_objects WHERE repository_id = ? ORDER BY article_id, target_alias').all(repositoryId)
      : this.db.prepare('SELECT * FROM remote_objects WHERE repository_id = ? AND article_id = ? ORDER BY target_alias').all(repositoryId, articleId);
    return (rows as Array<Record<string, string | null>>).map((row) => this.remoteObjectFromRow(row));
  }

  deleteRemoteObject(repositoryId: string, articleId: string, targetAlias: string): boolean {
    return this.db.prepare('DELETE FROM remote_objects WHERE repository_id = ? AND article_id = ? AND target_alias = ?')
      .run(repositoryId, articleId, targetAlias).changes === 1;
  }

  upsertPlatformAccount(input: {
    id: string;
    repositoryId: string;
    targetAlias: string;
    adapterType: string;
    credentialRef?: string | null;
    options?: Record<string, unknown>;
    enabled?: boolean;
  }): PlatformAccountRecord {
    const now = iso();
    this.db.prepare(`INSERT INTO platform_accounts
      (id, repository_id, target_alias, adapter_type, credential_ref, options_json, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repository_id, target_alias) DO UPDATE SET adapter_type = excluded.adapter_type,
        credential_ref = excluded.credential_ref, options_json = excluded.options_json, enabled = excluded.enabled, updated_at = excluded.updated_at`)
      .run(input.id, input.repositoryId, input.targetAlias, input.adapterType, input.credentialRef ?? null,
        json(input.options ?? {}), input.enabled === false ? 0 : 1, now, now);
    return this.getPlatformAccount(input.repositoryId, input.targetAlias) as PlatformAccountRecord;
  }

  getPlatformAccount(repositoryId: string, targetAlias: string): PlatformAccountRecord | null {
    const row = this.db.prepare('SELECT * FROM platform_accounts WHERE repository_id = ? AND target_alias = ?')
      .get(repositoryId, targetAlias) as Record<string, string | number | null> | undefined;
    return row ? {
      id: row.id as string,
      repositoryId: row.repository_id as string,
      targetAlias: row.target_alias as string,
      adapterType: row.adapter_type as string,
      credentialRef: row.credential_ref as string | null,
      options: parseJson(row.options_json as string),
      enabled: row.enabled === 1,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    } : null;
  }

  recordWebhookEvent(input: { repositoryId: string; eventId: string; eventType: string; payload: unknown }): boolean {
    const result = this.db.prepare(`INSERT OR IGNORE INTO webhook_events
      (repository_id, event_id, event_type, payload_json, received_at) VALUES (?, ?, ?, ?, ?)`)
      .run(input.repositoryId, input.eventId, input.eventType, json(input.payload), iso());
    return result.changes === 1;
  }

  recordAuditEvent(input: {
    id?: string;
    repositoryId?: string | null;
    actorUserId?: string | null;
    action: string;
    entityType: string;
    entityId?: string | null;
    details?: Record<string, unknown>;
  }): AuditEventRecord {
    const event: AuditEventRecord = {
      id: input.id ?? randomUUID(),
      repositoryId: input.repositoryId ?? null,
      actorUserId: input.actorUserId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      details: input.details ?? {},
      createdAt: iso(),
    };
    this.db.prepare(`INSERT INTO audit_events
      (id, repository_id, actor_user_id, action, entity_type, entity_id, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(event.id, event.repositoryId, event.actorUserId, event.action, event.entityType, event.entityId, json(event.details), event.createdAt);
    return event;
  }

  listAuditEvents(repositoryId?: string, limit = 100): AuditEventRecord[] {
    const rows = repositoryId === undefined
      ? this.db.prepare('SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?').all(limit)
      : this.db.prepare('SELECT * FROM audit_events WHERE repository_id = ? ORDER BY created_at DESC LIMIT ?').all(repositoryId, limit);
    return (rows as Array<Record<string, string | null>>).map((row) => ({
      id: row.id as string,
      repositoryId: row.repository_id ?? null,
      actorUserId: row.actor_user_id ?? null,
      action: row.action as string,
      entityType: row.entity_type as string,
      entityId: row.entity_id ?? null,
      details: parseJson(row.details_json as string),
      createdAt: row.created_at as string,
    }));
  }

  createUser(input: { id?: string; email: string; displayName: string; role: string; passwordHash?: string | null }): UserRecord {
    const now = iso();
    const id = input.id ?? randomUUID();
    this.db.prepare(`INSERT INTO users (id, email, display_name, role, password_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.email, input.displayName, input.role, input.passwordHash ?? null, now, now);
    return this.getUserById(id) as UserRecord;
  }

  private userFromRow(row: Record<string, string | null>): UserRecord {
    return {
      id: row.id as string,
      email: row.email as string,
      displayName: row.display_name as string,
      role: row.role as string,
      passwordHash: row.password_hash ?? null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  getUserById(id: string): UserRecord | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, string | null> | undefined;
    return row ? this.userFromRow(row) : null;
  }

  getUserByEmail(email: string): UserRecord | null {
    const row = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as Record<string, string | null> | undefined;
    return row ? this.userFromRow(row) : null;
  }

  createSession(input: { id?: string; userId: string; tokenHash: string; expiresAt: string | Date }): SessionRecord {
    const now = iso();
    const session: SessionRecord = {
      id: input.id ?? randomUUID(),
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: iso(input.expiresAt),
      createdAt: now,
      lastSeenAt: now,
    };
    this.db.prepare(`INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(session.id, session.userId, session.tokenHash, session.expiresAt, session.createdAt, session.lastSeenAt);
    return session;
  }

  getSessionByTokenHash(tokenHash: string, now: Date = new Date()): SessionRecord | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?')
      .get(tokenHash, iso(now)) as Record<string, string> | undefined;
    return row ? {
      id: row.id!,
      userId: row.user_id!,
      tokenHash: row.token_hash!,
      expiresAt: row.expires_at!,
      createdAt: row.created_at!,
      lastSeenAt: row.last_seen_at!,
    } : null;
  }

  touchSession(id: string): void {
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(iso(), id);
  }

  deleteSession(id: string): boolean {
    return this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id).changes === 1;
  }

  deleteExpiredSessions(now: Date = new Date()): number {
    return this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(iso(now)).changes;
  }
}
