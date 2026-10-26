import { mkdir } from 'node:fs/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import {
  DeploymentManager,
  GitConnector,
  StateStore,
} from '@pushpost/core';
import { AdapterRegistry, ExportAdapter, WordPressAdapter } from '@pushpost/adapters';
import { loadConfig, type ServerConfig } from './config.js';
import { AuthService } from './auth.js';
import { createDeploymentBuilder } from './build.js';
import { registerAdminRoutes } from './admin-routes.js';
import { registerAdminUi, registerDecap } from './decap.js';
import { redactingStream } from './logging.js';
import { HttpError, publicError } from './http.js';
import { registerPublicSite } from './static-site.js';
import { SyncCoordinator } from './sync.js';
import { registerWebhook } from './webhook.js';
import { DistributionWorker } from './worker.js';

export interface AppServices {
  config: ServerConfig;
  store: StateStore;
  auth: AuthService;
  sync: SyncCoordinator;
  deployments: DeploymentManager;
  worker: DistributionWorker;
}

declare module 'fastify' {
  interface FastifyInstance { pushpost: AppServices }
}

export async function buildServer(config: ServerConfig = loadConfig()): Promise<FastifyInstance> {
  await mkdir(config.dataDir, { recursive: true });
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info', stream: redactingStream(process.stdout) },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: process.env.PUSHPOST_TRUST_PROXY === 'true',
  });
  const store = new StateStore(process.env.PUSHPOST_STATE_DB ?? `${config.dataDir}/state.db`);
  try {
    const auth = new AuthService(config, store);
    await auth.bootstrap();
    store.upsertRepository({ id: config.repositoryId, remoteUrl: config.remoteUrl ?? `local://${config.repositoryId}`, branch: config.branch });
    const registry = new AdapterRegistry().register(new WordPressAdapter()).register(new ExportAdapter());
    const git = config.contentRoot || !config.remoteUrl ? null : new GitConnector({ remoteUrl: config.remoteUrl, branch: config.branch, workDir: config.workDir });
    const deployments = new DeploymentManager({
      repositoryId: config.repositoryId,
      releasesDir: config.releasesDir,
      store,
      build: createDeploymentBuilder(config),
    });
    const sync = new SyncCoordinator(config, store, git, registry, deployments);
    const worker = new DistributionWorker(config, store, registry);
    const services: AppServices = { config, store, auth, sync, deployments, worker };
    app.decorate('pushpost', services);
    await app.register(fastifyCookie);
    app.removeContentTypeParser('application/json');
    app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
      if (request.raw.url?.split('?', 1)[0] === '/api/webhooks/github') {
        done(null, body);
        return;
      }
      try {
        done(null, JSON.parse(body.toString('utf8')) as unknown);
      } catch {
        done(new HttpError(400, 'Invalid JSON', 'invalid_json'), undefined);
      }
    });
    app.setErrorHandler((error, request, reply) => {
      const result = publicError(error);
      if (result.statusCode >= 500) request.log.error({ err: error }, 'Request failed');
      reply.code(result.statusCode).send({ error: { code: result.code, message: result.message } });
    });
    app.get('/health', async () => {
      const current = store.getCurrentDeployment(config.repositoryId);
      return { status: 'ok', repositoryId: config.repositoryId, sourceCommit: current?.sourceCommit ?? null };
    });
    registerAdminRoutes(app, services);
    registerWebhook(app, config, store, sync);
    await registerDecap(app, config, store);
    await registerAdminUi(app);
    registerPublicSite(app, deployments);
    app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } }));
    worker.start();
    const reconcile = setInterval(() => {
      auth.cleanup();
      void sync.sync().catch((error: unknown) => app.log.error({ err: error }, 'Scheduled reconciliation failed'));
    }, config.reconcileIntervalMs);
    reconcile.unref();
    void sync.sync().catch((error: unknown) => app.log.error({ err: error }, 'Initial synchronization failed'));
    app.addHook('onClose', async () => {
      clearInterval(reconcile);
      await worker.close();
      store.close();
    });
    return app;
  } catch (error) {
    store.close();
    await app.close().catch(() => undefined);
    throw error;
  }
}

export const createApp = buildServer;
