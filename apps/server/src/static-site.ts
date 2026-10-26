import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DeploymentManager } from '@pushpost/core';

const mimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function sendPublicFile(request: FastifyRequest, reply: FastifyReply, deployments: DeploymentManager): Promise<FastifyReply> {
  const root = await deployments.getCurrentStaticRoot();
  if (!root) return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
  const rawPath = (request.raw.url ?? '/').split('?', 1)[0] ?? '/';
  let pathname: string;
  try {
    pathname = decodeURIComponent(rawPath);
  } catch {
    return reply.code(400).type('text/plain; charset=utf-8').send('Bad request');
  }
  if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some((part) => part === '.' || part === '..')) {
    return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
  }
  let candidate = path.resolve(root, `.${pathname}`);
  if (!inside(root, candidate)) return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
  try {
    let info = await stat(candidate);
    if (info.isDirectory()) {
      candidate = path.join(candidate, 'index.html');
      info = await stat(candidate);
    }
    if (!info.isFile()) throw new Error('Not a file');
    const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
    if (!inside(realRoot, realCandidate)) return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
    reply.type(mimeTypes[path.extname(candidate).toLowerCase()] ?? 'application/octet-stream');
    reply.header('Content-Length', info.size);
    reply.header('X-Content-Type-Options', 'nosniff');
    if (request.method === 'HEAD') return reply.send();
    return reply.send(createReadStream(realCandidate));
  } catch {
    return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
  }
}

export function registerPublicSite(app: FastifyInstance, deployments: DeploymentManager): void {
  app.route({
    method: ['GET', 'HEAD'],
    url: '/*',
    handler: (request, reply) => sendPublicFile(request, reply, deployments),
  });
}
