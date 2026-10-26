import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { AdapterError } from './types.js';

function localPathname(reference: string): string {
  const withoutSuffix = reference.split(/[?#]/, 1)[0] ?? '';
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutSuffix);
  } catch (cause) {
    throw new AdapterError('content', `Invalid encoded asset path: ${reference}`, { cause });
  }
  if (!decoded || decoded.includes('\0') || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(decoded) || decoded.startsWith('//')) {
    throw new AdapterError('content', `Asset is not a local content path: ${reference}`);
  }
  return decoded;
}

export function isRemoteAsset(reference: string): boolean {
  return /^(?:[a-zA-Z][a-zA-Z\d+.-]*:|\/\/|#|data:)/i.test(reference);
}

export async function resolveContentFile(contentRoot: string | undefined, reference: string): Promise<string> {
  if (!contentRoot) {
    throw new AdapterError('content', 'contentRoot is required for local assets');
  }
  const pathname = localPathname(reference);
  const root = path.resolve(contentRoot);
  const candidate = path.resolve(root, `.${path.sep}${pathname.replace(/^[/\\]+/, '')}`);
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new AdapterError('content', `Asset path escapes contentRoot: ${reference}`);
  }

  let realRoot: string;
  let realCandidate: string;
  try {
    [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
  } catch (cause) {
    throw new AdapterError('content', `Asset cannot be read: ${reference}`, { cause });
  }
  const realRelative = path.relative(realRoot, realCandidate);
  if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new AdapterError('content', `Asset resolves outside contentRoot: ${reference}`);
  }
  return realCandidate;
}

export function assetArchivePath(reference: string): string {
  const pathname = localPathname(reference).replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = pathname.split('/').filter((segment) => segment && segment !== '.' && segment !== '..');
  if (segments[0] === 'assets') segments.shift();
  const safe = segments.map((segment) => segment.replace(/[^a-zA-Z0-9._-]/g, '_')).join('/');
  return `assets/${safe || 'asset'}`;
}
