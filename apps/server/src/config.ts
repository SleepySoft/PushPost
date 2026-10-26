import path from 'node:path';

export interface ServerConfig {
  remoteUrl: string | null;
  branch: string;
  repositoryId: string;
  workDir: string;
  dataDir: string;
  contentRoot: string | null;
  siteUrl: string;
  siteTitle: string;
  port: number;
  host: string;
  webhookSecret: string | null;
  webhookRepository: string | null;
  adminEmail: string | null;
  adminPassword: string | null;
  sessionSecret: string;
  sessionTtlMs: number;
  cookieSecure: boolean;
  reconcileIntervalMs: number;
  releasesDir: string;
  snapshotsDir: string;
  exportsDir: string;
  temporaryDir: string;
  decapGitHubRepo: string | null;
  decapGitHubBranch: string;
  decapBaseUrl: string | null;
}

function text(env: NodeJS.ProcessEnv, name: string, fallback?: string): string | null {
  const value = env[name]?.trim();
  return value || fallback || null;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = text(env, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function boolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = env[name];
  if (value === undefined || value === '') return fallback;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`${name} must be true or false`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dataDir = path.resolve(text(env, 'PUSHPOST_DATA_DIR', path.join(process.cwd(), '.pushpost'))!);
  const contentRoot = text(env, 'PUSHPOST_CONTENT_ROOT');
  const remoteUrl = text(env, 'PUSHPOST_REMOTE_URL');
  if (!contentRoot && !remoteUrl) throw new Error('PUSHPOST_REMOTE_URL is required unless PUSHPOST_CONTENT_ROOT is explicitly set');
  const adminEmail = text(env, 'PUSHPOST_ADMIN_EMAIL');
  const adminPassword = env.PUSHPOST_ADMIN_PASSWORD || null;
  if ((adminEmail === null) !== (adminPassword === null)) {
    throw new Error('PUSHPOST_ADMIN_EMAIL and PUSHPOST_ADMIN_PASSWORD must be provided together');
  }
  if (adminEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) throw new Error('PUSHPOST_ADMIN_EMAIL is invalid');
  if (adminPassword && adminPassword.length < 12) throw new Error('PUSHPOST_ADMIN_PASSWORD must contain at least 12 characters');
  const sessionSecret = required(env, 'PUSHPOST_SESSION_SECRET');
  if (sessionSecret.length < 32) throw new Error('PUSHPOST_SESSION_SECRET must contain at least 32 characters');
  const siteUrl = new URL(text(env, 'PUSHPOST_SITE_URL', 'http://127.0.0.1:3000')!);
  if (!['http:', 'https:'].includes(siteUrl.protocol) || siteUrl.username || siteUrl.password) {
    throw new Error('PUSHPOST_SITE_URL must be an HTTP(S) URL without credentials');
  }
  siteUrl.hash = '';
  siteUrl.search = '';
  const cookieSecure = boolean(env, 'PUSHPOST_COOKIE_SECURE', siteUrl.protocol === 'https:');
  return {
    remoteUrl,
    branch: text(env, 'PUSHPOST_BRANCH', 'main')!,
    repositoryId: text(env, 'PUSHPOST_REPOSITORY_ID', 'default')!,
    workDir: path.resolve(text(env, 'PUSHPOST_WORK_DIR', path.join(dataDir, 'repository'))!),
    dataDir,
    contentRoot: contentRoot ? path.resolve(contentRoot) : null,
    siteUrl: siteUrl.toString().replace(/\/$/, ''),
    siteTitle: text(env, 'PUSHPOST_SITE_TITLE', 'PushPost')!,
    port: integer(env, 'PUSHPOST_PORT', 3000, 1, 65535),
    host: text(env, 'PUSHPOST_HOST', '127.0.0.1')!,
    webhookSecret: env.PUSHPOST_WEBHOOK_SECRET || null,
    webhookRepository: text(env, 'PUSHPOST_WEBHOOK_REPOSITORY'),
    adminEmail,
    adminPassword,
    sessionSecret,
    sessionTtlMs: integer(env, 'PUSHPOST_SESSION_TTL_MS', 8 * 60 * 60 * 1000, 60_000, 7 * 24 * 60 * 60 * 1000),
    cookieSecure,
    reconcileIntervalMs: integer(env, 'PUSHPOST_RECONCILE_INTERVAL_MS', 60_000, 1_000, 24 * 60 * 60 * 1000),
    releasesDir: path.join(dataDir, 'releases'),
    snapshotsDir: path.join(dataDir, 'snapshots'),
    exportsDir: path.join(dataDir, 'exports'),
    temporaryDir: path.join(dataDir, 'tmp'),
    decapGitHubRepo: text(env, 'PUSHPOST_DECAP_GITHUB_REPO'),
    decapGitHubBranch: text(env, 'PUSHPOST_DECAP_GITHUB_BRANCH', text(env, 'PUSHPOST_BRANCH', 'main')!)!,
    decapBaseUrl: text(env, 'PUSHPOST_DECAP_BASE_URL'),
  };
}
