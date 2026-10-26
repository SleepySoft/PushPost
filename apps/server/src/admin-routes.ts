import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  articleContentHash,
  type DeploymentManager,
  type StateStore,
  type TaskOperation,
  type TaskStatus,
} from '@pushpost/core';
import type { ServerConfig } from './config.js';
import { hashPassword, publicUser, type AuthService, type AuthenticatedRequest, type Role } from './auth.js';
import { bodyObject, HttpError, idField, noCache, strictKeys, stringField } from './http.js';
import { operationFor } from './distribution.js';
import type { SyncCoordinator } from './sync.js';
import type { DistributionWorker } from './worker.js';

interface AdminServices {
  config: ServerConfig;
  store: StateStore;
  auth: AuthService;
  sync: SyncCoordinator;
  deployments: DeploymentManager;
  worker: DistributionWorker;
}

const taskStatuses = new Set<TaskStatus>(['pending', 'running', 'succeeded', 'failed', 'manual_required', 'cancelled']);
const operations = new Set<TaskOperation>(['create_draft', 'publish', 'update', 'unpublish', 'export']);

function actor(request: FastifyRequest): string {
  return (request as AuthenticatedRequest).authUser.id;
}

function query(request: FastifyRequest): Record<string, unknown> {
  return request.query as Record<string, unknown>;
}

function limit(value: unknown, fallback = 100): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1000) throw new HttpError(400, 'Invalid limit', 'invalid_query');
  return parsed;
}

export function registerAdminRoutes(app: FastifyInstance, services: AdminServices): void {
  const { config, store, auth, sync, deployments, worker } = services;
  const authenticated = [auth.authenticate];
  const read = [auth.authenticate, auth.requireRoles('admin', 'editor', 'publisher')];
  const publish = [auth.authenticate, auth.requireRoles('admin', 'publisher'), auth.csrf];
  const administer = [auth.authenticate, auth.requireRoles('admin'), auth.csrf];

  app.addHook('onSend', async (request, reply) => {
    if (request.raw.url?.startsWith('/api/admin')) noCache(reply);
  });

  app.post('/api/admin/auth/login', async (request, reply) => {
    const body = bodyObject(request);
    strictKeys(body, ['email', 'password']);
    const email = stringField(body.email, 'email', 320);
    if (typeof body.password !== 'string' || body.password.length < 1 || body.password.length > 1024) {
      throw new HttpError(400, 'Password is invalid', 'invalid_field');
    }
    const result = await auth.login(email, body.password, request.ip);
    auth.setSessionCookie(reply, result.token);
    store.recordAuditEvent({ actorUserId: result.user.id, action: 'auth.login', entityType: 'user', entityId: result.user.id });
    return { user: result.user, csrfToken: result.csrfToken };
  });

  app.post('/api/admin/auth/logout', { preHandler: authenticated.concat(auth.csrf) }, async (request, reply) => {
    const userId = actor(request);
    auth.logout(request);
    auth.clearSessionCookie(reply);
    store.recordAuditEvent({ actorUserId: userId, action: 'auth.logout', entityType: 'user', entityId: userId });
    return { ok: true };
  });

  app.get('/api/admin/auth/me', { preHandler: read }, async (request) => ({
    user: (request as AuthenticatedRequest).authUser,
    csrfToken: auth.csrfToken((request as AuthenticatedRequest).sessionToken),
  }));

  app.get('/api/admin/overview', { preHandler: read }, async () => {
    const snapshot = store.getLatestSnapshot(config.repositoryId);
    const current = store.getCurrentDeployment(config.repositoryId);
    const counts = store.db.prepare(`SELECT status, COUNT(*) AS count FROM distribution_tasks
      WHERE repository_id = ? GROUP BY status`).all(config.repositoryId);
    return {
      repository: store.getRepository(config.repositoryId),
      sourceCommit: snapshot?.sourceCommit ?? null,
      generatedAt: snapshot?.generatedAt ?? null,
      currentDeployment: current,
      articles: snapshot?.articles.length ?? 0,
      visibleArticles: snapshot?.articles.filter((article) => article.visible).length ?? 0,
      taskStatuses: counts,
    };
  });

  app.get('/api/admin/articles', { preHandler: read }, async () => {
    const snapshot = store.getLatestSnapshot(config.repositoryId);
    return {
      sourceCommit: snapshot?.sourceCommit ?? null,
      remoteHead: null,
      articles: (snapshot?.articles ?? []).map((article) => ({
        ...article,
        remotes: store.listRemoteObjects(config.repositoryId, article.id),
      })),
    };
  });

  app.get('/api/admin/articles/:id', { preHandler: read }, async (request) => {
    const id = idField((request.params as Record<string, unknown>).id);
    const snapshot = store.getLatestSnapshot(config.repositoryId);
    const article = snapshot?.articles.find((item) => item.id === id);
    if (!snapshot || !article) throw new HttpError(404, 'Article not found', 'not_found');
    return { sourceCommit: snapshot.sourceCommit, article, remotes: store.listRemoteObjects(config.repositoryId, id) };
  });

  app.get('/api/admin/deployments', { preHandler: read }, async (request) => ({
    deployments: store.listDeployments(config.repositoryId, limit(query(request).limit, 50)),
  }));

  app.post('/api/admin/sync', { preHandler: publish }, async (request) => {
    const result = await sync.sync(actor(request));
    return { sourceCommit: result.snapshot.sourceCommit, deployment: result.deployment, tasks: result.tasks };
  });

  app.post('/api/admin/rollback', { preHandler: publish }, async (request) => {
    const body = bodyObject(request);
    strictKeys(body, ['deploymentId']);
    const deploymentId = body.deploymentId === undefined ? undefined : idField(body.deploymentId, 'deploymentId');
    const deployment = await deployments.rollback(deploymentId);
    store.recordAuditEvent({
      repositoryId: config.repositoryId,
      actorUserId: actor(request),
      action: 'deployment.rollback',
      entityType: 'deployment',
      entityId: deployment.id,
      details: { sourceCommit: deployment.sourceCommit },
    });
    return { deployment };
  });

  app.get('/api/admin/tasks', { preHandler: read }, async (request) => {
    const input = query(request);
    const status = input.status;
    if (status !== undefined && (typeof status !== 'string' || !taskStatuses.has(status as TaskStatus))) {
      throw new HttpError(400, 'Invalid task status', 'invalid_query');
    }
    return {
      tasks: store.listTasks({
        repositoryId: config.repositoryId,
        articleId: input.articleId === undefined ? undefined : idField(input.articleId, 'articleId'),
        targetAlias: input.targetAlias === undefined ? undefined : idField(input.targetAlias, 'targetAlias'),
        status: status as TaskStatus | undefined,
        limit: limit(input.limit),
      }),
    };
  });

  app.post('/api/admin/tasks', { preHandler: publish }, async (request) => {
    const body = bodyObject(request);
    strictKeys(body, ['articleId', 'targetAlias', 'operation']);
    const articleId = idField(body.articleId, 'articleId');
    const targetAlias = idField(body.targetAlias, 'targetAlias');
    const snapshot = store.getLatestSnapshot(config.repositoryId);
    const article = snapshot?.articles.find((item) => item.id === articleId);
    const target = snapshot?.targets.find((item) => item.alias === targetAlias);
    if (!snapshot || !article || !target || !target.enabled) throw new HttpError(400, 'Article or enabled target not found', 'invalid_task');
    if (!article.distribution.some((item) => item.target === targetAlias)) throw new HttpError(400, 'Target is not declared by the article', 'invalid_task');
    const remote = store.getRemoteObject(config.repositoryId, articleId, targetAlias);
    const operation = body.operation === undefined ? operationFor(article, target, remote !== null) : body.operation;
    if (typeof operation !== 'string' || !operations.has(operation as TaskOperation)
      || (target.type === 'export' && operation !== 'export') || (target.type !== 'export' && operation === 'export')) {
      throw new HttpError(400, 'Operation is not supported by this target', 'invalid_task');
    }
    const task = store.createTask({
      repositoryId: config.repositoryId,
      articleId,
      targetAlias,
      operation: operation as TaskOperation,
      sourceCommit: snapshot.sourceCommit,
      contentHash: articleContentHash(article),
    });
    store.recordAuditEvent({
      repositoryId: config.repositoryId,
      actorUserId: actor(request),
      action: 'distribution.task_created',
      entityType: 'task',
      entityId: task.id,
      details: { articleId, targetAlias, operation },
    });
    void worker.run();
    return { task };
  });

  app.post('/api/admin/tasks/:id/retry', { preHandler: publish }, async (request) => {
    const id = idField((request.params as Record<string, unknown>).id);
    if (store.getTask(id)?.repositoryId !== config.repositoryId) throw new HttpError(404, 'Task not found', 'not_found');
    const task = store.retryTask(id);
    store.recordAuditEvent({ repositoryId: config.repositoryId, actorUserId: actor(request), action: 'distribution.retried', entityType: 'task', entityId: id });
    void worker.run();
    return { task };
  });

  app.post('/api/admin/tasks/:id/cancel', { preHandler: publish }, async (request) => {
    const id = idField((request.params as Record<string, unknown>).id);
    if (store.getTask(id)?.repositoryId !== config.repositoryId) throw new HttpError(404, 'Task not found', 'not_found');
    const task = store.cancelTask(id);
    store.recordAuditEvent({ repositoryId: config.repositoryId, actorUserId: actor(request), action: 'distribution.cancelled', entityType: 'task', entityId: id });
    return { task };
  });

  app.post('/api/admin/exports/:taskId/result', { preHandler: publish }, async (request) => {
    const taskId = idField((request.params as Record<string, unknown>).taskId, 'taskId');
    const body = bodyObject(request);
    strictKeys(body, ['remoteId', 'remoteUrl', 'remoteStatus']);
    const remoteId = stringField(body.remoteId, 'remoteId');
    const remoteStatus = body.remoteStatus === undefined ? 'published' : stringField(body.remoteStatus, 'remoteStatus', 64);
    let remoteUrl: string | null = null;
    if (body.remoteUrl !== undefined && body.remoteUrl !== null) {
      const value = stringField(body.remoteUrl, 'remoteUrl', 2048);
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new HttpError(400, 'remoteUrl is invalid', 'invalid_field');
      remoteUrl = parsed.toString();
    }
    const task = store.getTask(taskId);
    if (!task || task.repositoryId !== config.repositoryId || task.operation !== 'export' || task.status !== 'manual_required') {
      throw new HttpError(400, 'Export task cannot be registered', 'invalid_export');
    }
    store.upsertRemoteObject({ repositoryId: task.repositoryId, articleId: task.articleId, targetAlias: task.targetAlias, remoteId, remoteUrl, remoteStatus });
    const changed = store.db.prepare(`UPDATE distribution_tasks SET status = 'succeeded', last_error = NULL,
      lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND status = 'manual_required'`)
      .run(new Date().toISOString(), taskId);
    if (changed.changes !== 1) throw new HttpError(409, 'Export task changed while registering', 'conflict');
    store.recordAuditEvent({ repositoryId: config.repositoryId, actorUserId: actor(request), action: 'distribution.export_registered', entityType: 'task', entityId: taskId, details: { remoteId, remoteUrl, remoteStatus } });
    return { task: store.getTask(taskId) };
  });

  app.get('/api/admin/exports/:taskId/download', { preHandler: read }, async (request, reply) => {
    const taskId = idField((request.params as Record<string, unknown>).taskId, 'taskId');
    const task = store.getTask(taskId);
    if (!task || task.operation !== 'export') throw new HttpError(404, 'Export not found', 'not_found');
    const event = store.listAuditEvents(config.repositoryId, 1000).find((item) => item.action === 'distribution.exported' && item.entityId === taskId);
    const exportPath = event?.details.exportPath;
    if (typeof exportPath !== 'string') throw new HttpError(404, 'Export not found', 'not_found');
    const root = await realpath(config.exportsDir);
    const filename = await realpath(exportPath);
    if (path.dirname(filename) !== root) throw new HttpError(404, 'Export not found', 'not_found');
    const info = await stat(filename);
    if (!info.isFile()) throw new HttpError(404, 'Export not found', 'not_found');
    reply.type('application/zip');
    reply.header('Content-Length', info.size);
    reply.header('Content-Disposition', `attachment; filename="${path.basename(filename).replace(/["\\\r\n]/g, '_')}"`);
    return reply.send(createReadStream(filename));
  });

  app.get('/api/admin/audit', { preHandler: read }, async (request) => ({
    audit: store.listAuditEvents(config.repositoryId, limit(query(request).limit)),
  }));

  app.get('/api/admin/metrics', { preHandler: read }, async () => {
    const tasks = store.db.prepare('SELECT status, COUNT(*) AS count FROM distribution_tasks WHERE repository_id = ? GROUP BY status').all(config.repositoryId);
    const deploymentsByStatus = store.db.prepare('SELECT status, COUNT(*) AS count FROM deployments WHERE repository_id = ? GROUP BY status').all(config.repositoryId);
    return { tasks, deployments: deploymentsByStatus, workerId: worker.workerId };
  });

  app.get('/api/admin/users', { preHandler: [auth.authenticate, auth.requireRoles('admin')] }, async () => {
    const users = (store.db.prepare('SELECT id FROM users ORDER BY email').all() as Array<{ id: string }>)
      .map((row) => store.getUserById(row.id)).filter((user) => user !== null).map(publicUser);
    return { users };
  });

  app.post('/api/admin/users', { preHandler: administer }, async (request) => {
    const body = bodyObject(request);
    strictKeys(body, ['email', 'displayName', 'role', 'password']);
    const email = stringField(body.email, 'email', 320).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Email is invalid', 'invalid_field');
    const displayName = stringField(body.displayName, 'displayName', 128);
    const role = stringField(body.role, 'role', 16) as Role;
    if (!['admin', 'editor', 'publisher'].includes(role) || typeof body.password !== 'string') throw new HttpError(400, 'User is invalid', 'invalid_field');
    const user = store.createUser({ email, displayName, role, passwordHash: await hashPassword(body.password) });
    store.recordAuditEvent({ actorUserId: actor(request), action: 'user.created', entityType: 'user', entityId: user.id, details: { email, role } });
    return { user: publicUser(user) };
  });

  app.patch('/api/admin/users/:id', { preHandler: administer }, async (request) => {
    const id = idField((request.params as Record<string, unknown>).id);
    const body = bodyObject(request);
    strictKeys(body, ['displayName', 'role', 'password']);
    const user = store.getUserById(id);
    if (!user) throw new HttpError(404, 'User not found', 'not_found');
    const displayName = body.displayName === undefined ? user.displayName : stringField(body.displayName, 'displayName', 128);
    const role = body.role === undefined ? user.role : stringField(body.role, 'role', 16);
    if (!['admin', 'editor', 'publisher'].includes(role) || (id === actor(request) && role !== 'admin')) throw new HttpError(400, 'Role is invalid', 'invalid_field');
    const passwordHash = body.password === undefined ? user.passwordHash : await hashPassword(stringField(body.password, 'password', 1024));
    store.db.prepare('UPDATE users SET display_name = ?, role = ?, password_hash = ?, updated_at = ? WHERE id = ?')
      .run(displayName, role, passwordHash, new Date().toISOString(), id);
    store.recordAuditEvent({ actorUserId: actor(request), action: 'user.updated', entityType: 'user', entityId: id, details: { displayName, role, passwordChanged: body.password !== undefined } });
    return { user: publicUser(store.getUserById(id)!) };
  });

  app.delete('/api/admin/users/:id', { preHandler: administer }, async (request) => {
    const id = idField((request.params as Record<string, unknown>).id);
    if (id === actor(request)) throw new HttpError(400, 'You cannot delete your own account', 'invalid_user');
    const result = store.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    if (result.changes !== 1) throw new HttpError(404, 'User not found', 'not_found');
    store.recordAuditEvent({ actorUserId: actor(request), action: 'user.deleted', entityType: 'user', entityId: id });
    return { ok: true };
  });
}
