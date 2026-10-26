import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import type { StateStore } from '@pushpost/core';
import type { ServerConfig } from './config.js';

const require = createRequire(import.meta.url);

const fields = [
  { label: 'ID', name: 'id', widget: 'uuid', required: true, readonly: true },
  { label: 'Title', name: 'title', widget: 'string', required: true },
  { label: 'Slug', name: 'slug', widget: 'string', required: true, pattern: ['^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$', 'Lowercase letters, numbers and hyphens'] },
  { label: 'Summary', name: 'summary', widget: 'text', required: false },
  { label: 'Status', name: 'status', widget: 'select', options: ['draft', 'published', 'archived'], default: 'draft', required: true },
  { label: 'Published at', name: 'published_at', widget: 'datetime', required: false },
  { label: 'Language', name: 'lang', widget: 'string', required: false },
  { label: 'Tags', name: 'tags', widget: 'list', required: false, default: [] },
  { label: 'Cover', name: 'cover', widget: 'image', required: false, media_folder: './assets', public_folder: './assets' },
  { label: 'Canonical URL', name: 'canonical_url', widget: 'string', required: false },
  {
    label: 'Distribution', name: 'distribution', widget: 'list', required: false, default: [],
    fields: [
      { label: 'Target', name: 'target', widget: 'string', required: true },
      { label: 'Mode', name: 'mode', widget: 'select', options: ['draft', 'published'], required: false },
      { label: 'Trigger', name: 'trigger', widget: 'select', options: ['auto', 'manual'], required: false },
    ],
  },
  { label: 'Body', name: 'body', widget: 'markdown', required: false },
];

export async function registerDecap(app: FastifyInstance, config: ServerConfig, store: StateStore): Promise<void> {
  const distribution = require.resolve('decap-cms/dist/decap-cms.js');
  const dist = path.dirname(distribution);
  await app.register(fastifyStatic, { root: dist, prefix: '/admin/decap/vendor/', decorateReply: false, index: false, redirect: false });
  app.get('/admin/decap', async (_request, reply) => {
    reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store');
    return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>PushPost Content</title></head><body><script src="/admin/decap/vendor/decap-cms.js"></script></body></html>';
  });
  app.get('/admin/decap/config.yml', async (_request, reply) => {
    if (!config.contentRoot && !config.decapGitHubRepo) {
      return reply.code(503).type('text/plain; charset=utf-8').send('Decap GitHub backend is not configured');
    }
    const snapshot = store.getLatestSnapshot(config.repositoryId);
    const categories = snapshot?.categories.map((category) => category.name) ?? [];
    const backend = config.contentRoot
      ? { name: 'git-gateway', branch: config.branch }
      : { name: 'github', repo: config.decapGitHubRepo, branch: config.decapGitHubBranch, ...(config.decapBaseUrl ? { base_url: config.decapBaseUrl } : {}) };
    const value = {
      backend,
      ...(config.contentRoot ? { local_backend: true } : {}),
      locale: 'zh_Hans',
      collections: categories.map((category) => ({
        name: `category-${Buffer.from(category).toString('base64url')}`,
        label: category,
        folder: `content/${category}`,
        extension: 'md',
        format: 'frontmatter',
        create: true,
        delete: true,
        slug: '{{slug}}',
        media_folder: './assets',
        public_folder: './assets',
        fields,
      })),
    };
    reply.type('text/yaml; charset=utf-8').header('Cache-Control', 'no-store');
    return JSON.stringify(value);
  });
  app.get('/admin/decap/', async (_request, reply) => reply.redirect('/admin/decap', 302));
}

export async function registerAdminUi(app: FastifyInstance): Promise<void> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
  const files = new Map([
    ['/admin', 'index.html'],
    ['/admin/', 'index.html'],
    ['/admin/app.js', 'app.js'],
    ['/admin/style.css', 'style.css'],
  ]);
  for (const [route, filename] of files) {
    app.get(route, async (_request, reply) => {
      const content = await readFile(path.join(root, filename));
      const type = filename.endsWith('.html') ? 'text/html; charset=utf-8' : filename.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8';
      reply.type(type).header('Cache-Control', 'no-cache').header('X-Content-Type-Options', 'nosniff');
      return content;
    });
  }
}
