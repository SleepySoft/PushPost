import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { StateStore } from '@pushpost/core';
import type { ServerConfig } from './config.js';
import { HttpError, safeEqual } from './http.js';
import type { SyncCoordinator } from './sync.js';

export function registerWebhook(
  app: FastifyInstance,
  config: ServerConfig,
  store: StateStore,
  sync: SyncCoordinator,
): void {
  app.post('/api/webhooks/github', async (request, reply) => {
    if (!config.webhookSecret) throw new HttpError(503, 'GitHub webhook is not configured', 'webhook_disabled');
    const signature = request.headers['x-hub-signature-256'];
    const delivery = request.headers['x-github-delivery'];
    const event = request.headers['x-github-event'];
    if (typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/i.test(signature)
      || typeof delivery !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(delivery)
      || typeof event !== 'string' || !/^[a-z_]{1,64}$/.test(event)
      || !Buffer.isBuffer(request.body)) {
      throw new HttpError(400, 'Invalid webhook request', 'invalid_webhook');
    }
    const expected = `sha256=${createHmac('sha256', config.webhookSecret).update(request.body).digest('hex')}`;
    if (!safeEqual(signature.toLowerCase(), expected)) throw new HttpError(401, 'Invalid webhook signature', 'invalid_signature');
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(request.body.toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Object required');
      payload = parsed as Record<string, unknown>;
    } catch {
      throw new HttpError(400, 'Invalid webhook JSON', 'invalid_webhook');
    }
    const repository = typeof payload.repository === 'object' && payload.repository !== null
      ? (payload.repository as Record<string, unknown>).full_name
      : null;
    if (config.webhookRepository && repository !== config.webhookRepository) {
      throw new HttpError(400, 'Repository is not allowed', 'repository_not_allowed');
    }
    if (event === 'push' && payload.ref !== `refs/heads/${config.branch}`) {
      throw new HttpError(400, 'Branch is not allowed', 'branch_not_allowed');
    }
    if (!['push', 'ping'].includes(event)) return reply.code(202).send({ accepted: false, reason: 'event_ignored' });
    const inserted = store.recordWebhookEvent({
      repositoryId: config.repositoryId,
      eventId: delivery,
      eventType: event,
      payload,
    });
    if (!inserted) return reply.code(202).send({ accepted: true, duplicate: true });
    if (event === 'push') void sync.sync().catch((error: unknown) => request.log.error({ err: error }, 'Webhook synchronization failed'));
    return reply.code(202).send({ accepted: true, duplicate: false });
  });
}
