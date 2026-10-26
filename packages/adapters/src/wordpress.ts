import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PublicationMode } from '@pushpost/core/types';
import { isRemoteAsset, resolveContentFile } from './content.js';
import {
  AdapterError,
  type AdapterInput,
  type AdapterResult,
  type PlatformAdapter,
  type RemoteAdapterResult,
} from './types.js';

export interface WordPressCredential {
  baseUrl: string;
  username: string;
  appPassword: string;
}

export interface WordPressAdapterOptions {
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

interface RequestOptions {
  method: 'POST' | 'PUT';
  body?: BodyInit;
  headers?: Record<string, string>;
}

interface WordPressPost {
  id: number | string;
  link?: unknown;
  status?: unknown;
}

interface WordPressMedia {
  source_url?: unknown;
}

const imagePattern = /<img\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1/gi;

const contentTypes: Record<string, string> = {
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

function credential(value: unknown): WordPressCredential {
  if (typeof value !== 'object' || value === null) {
    throw new AdapterError('authentication', 'WordPress credentials are required');
  }
  const candidate = value as Partial<WordPressCredential>;
  if (!candidate.baseUrl || !candidate.username || !candidate.appPassword) {
    throw new AdapterError('authentication', 'WordPress baseUrl, username and appPassword are required');
  }
  let baseUrl: URL;
  try {
    baseUrl = new URL(candidate.baseUrl);
  } catch (cause) {
    throw new AdapterError('content', 'WordPress baseUrl is invalid', { cause });
  }
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password) {
    throw new AdapterError('content', 'WordPress baseUrl must be an HTTP(S) URL without embedded credentials');
  }
  baseUrl.search = '';
  baseUrl.hash = '';
  return {
    baseUrl: baseUrl.toString().replace(/\/+$/, ''),
    username: candidate.username,
    appPassword: candidate.appPassword,
  };
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function responseError(status: number, statusText: string, retryAfter: string | null): AdapterError {
  const message = `WordPress request failed with ${status} ${statusText}`.trim();
  if (status === 401 || status === 403) {
    return new AdapterError('authentication', message, { statusCode: status });
  }
  if (status === 429 || status >= 500) {
    return new AdapterError('retryable', message, {
      statusCode: status,
      retryAfterMs: retryAfterMs(retryAfter),
    });
  }
  return new AdapterError('content', message, { statusCode: status });
}

export class WordPressAdapter implements PlatformAdapter {
  readonly type = 'wordpress';
  private readonly fetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(options: WordPressAdapterOptions = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new AdapterError('content', 'WordPress timeoutMs must be positive');
    }
  }

  async execute(input: AdapterInput): Promise<AdapterResult> {
    const auth = credential(input.credential);
    const mode = this.mode(input);
    const existingId = input.remoteObject?.remoteId;

    if (input.operation === 'unpublish') {
      if (!existingId) {
        throw new AdapterError('content', 'Cannot unpublish a WordPress post without a remote ID');
      }
      return this.savePost(input, auth, null, 'draft', existingId);
    }
    if (input.operation === 'update' && !existingId) {
      throw new AdapterError('content', 'Cannot update a WordPress post without a remote ID');
    }
    const html = await this.uploadImages(input, auth);
    return this.savePost(input, auth, html, mode, existingId);
  }

  private mode(input: AdapterInput): PublicationMode {
    if (input.operation === 'create_draft') return 'draft';
    if (input.operation === 'publish') return 'published';
    if (input.operation === 'update') return input.mode ?? input.target.defaultMode;
    if (input.operation === 'unpublish') return 'draft';
    throw new AdapterError('content', `WordPress does not support operation: ${input.operation}`);
  }

  private endpoint(auth: WordPressCredential, resource: string): string {
    return `${auth.baseUrl}/wp-json/wp/v2/${resource}`;
  }

  private authorization(auth: WordPressCredential): string {
    return `Basic ${Buffer.from(`${auth.username}:${auth.appPassword}`).toString('base64')}`;
  }

  private async request(
    url: string,
    auth: WordPressCredential,
    options: RequestOptions,
  ): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetch(url, {
        method: options.method,
        headers: {
          Authorization: this.authorization(auth),
          Accept: 'application/json',
          ...options.headers,
        },
        body: options.body,
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.arrayBuffer().catch(() => undefined);
        throw responseError(response.status, response.statusText, response.headers.get('retry-after'));
      }
      try {
        return await response.json();
      } catch (cause) {
        throw new AdapterError('uncertain', 'WordPress returned an unreadable success response; verify the remote object before retrying', { cause });
      }
    } catch (cause) {
      if (cause instanceof AdapterError) throw cause;
      if (timedOut) {
        throw new AdapterError('uncertain', 'WordPress request timed out; verify the remote object before retrying', { cause });
      }
      throw new AdapterError('retryable', 'WordPress network request failed', { cause });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async uploadImages(input: AdapterInput, auth: WordPressCredential): Promise<string> {
    const replacements = new Map<string, string>();
    let html = '';
    let offset = 0;

    for (const match of input.article.html.matchAll(imagePattern)) {
      const index = match.index;
      const reference = match[2];
      if (reference === undefined) continue;
      html += input.article.html.slice(offset, index);
      let replacement = match[0];
      if (!isRemoteAsset(reference)) {
        let url = replacements.get(reference);
        if (!url) {
          url = await this.uploadImage(reference, input.contentRoot, auth);
          replacements.set(reference, url);
        }
        replacement = match[0].replace(reference, url);
      }
      html += replacement;
      offset = index + match[0].length;
    }
    return html + input.article.html.slice(offset);
  }

  private async uploadImage(reference: string, contentRoot: string | undefined, auth: WordPressCredential): Promise<string> {
    const filePath = await resolveContentFile(contentRoot, reference);
    const filename = path.basename(filePath);
    const data = await readFile(filePath).catch((cause) => {
      throw new AdapterError('content', `Asset cannot be read: ${reference}`, { cause });
    });
    const safeFilename = filename.replace(/["\\\r\n]/g, '_');
    const result = await this.request(this.endpoint(auth, 'media'), auth, {
      method: 'POST',
      headers: {
        'Content-Type': contentTypes[path.extname(filename).toLowerCase()] ?? 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${safeFilename}"`,
      },
      body: data,
    }) as WordPressMedia;
    if (typeof result.source_url !== 'string' || !result.source_url) {
      throw new AdapterError('uncertain', 'WordPress media response has no source_url; verify the upload before retrying');
    }
    return result.source_url;
  }

  private async savePost(
    input: AdapterInput,
    auth: WordPressCredential,
    html: string | null,
    status: PublicationMode,
    remoteId?: string,
  ): Promise<RemoteAdapterResult> {
    const result = await this.request(this.endpoint(auth, remoteId ? `posts/${encodeURIComponent(remoteId)}` : 'posts'), auth, {
      method: remoteId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(html === null ? { status: status === 'published' ? 'publish' : 'draft' } : {
        title: input.article.title,
        slug: input.article.slug,
        excerpt: input.article.summary,
        content: html,
        status: status === 'published' ? 'publish' : 'draft',
      }),
    }) as WordPressPost;
    if ((typeof result.id !== 'number' && typeof result.id !== 'string') || String(result.id).length === 0) {
      throw new AdapterError('uncertain', 'WordPress post response has no ID; verify the remote object before retrying');
    }
    return {
      status: 'succeeded',
      remoteId: String(result.id),
      url: typeof result.link === 'string' ? result.link : null,
      remoteStatus: typeof result.status === 'string' ? result.status : status,
    };
  }
}
