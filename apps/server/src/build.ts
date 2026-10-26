import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, lstat, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DeploymentBuildContext, SiteSnapshot } from '@pushpost/core';
import type { ServerConfig } from './config.js';

interface AssetPlan {
  category: string;
  parts: string[];
}

interface AssetManifestEntry {
  path: string;
  size: number;
  sha256: string;
}

interface AssetManifest {
  version: 1;
  sourceCommit: string;
  visibilityHash: string;
  assets: AssetManifestEntry[];
}

const manifestFilename = '.snapshot-assets.json';

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function safeAssetParts(reference: string): string[] {
  if (!reference.startsWith('./assets/') || reference.includes('\\') || reference.includes('\0')) {
    throw new Error('Snapshot contains an invalid asset reference');
  }
  const decoded = decodeURIComponent(reference);
  const parts = decoded.split('/');
  if (parts[0] !== '.' || parts[1] !== 'assets' || parts.length < 3
    || parts.some((part, index) => index > 1 && (!part || part === '.' || part === '..'))
    || decoded.includes('?') || decoded.includes('#')) {
    throw new Error('Snapshot asset path is unsafe');
  }
  return parts.slice(2);
}

function safeCategory(category: string): void {
  if (!category || category === '.' || category === '..' || /[/\\\0]/.test(category)) {
    throw new Error('Snapshot contains an unsafe category');
  }
}

function assetPlans(snapshot: SiteSnapshot, visibleOnly: boolean): Map<string, AssetPlan> {
  const plans = new Map<string, AssetPlan>();
  for (const article of snapshot.articles) {
    if (visibleOnly && !article.visible) continue;
    safeCategory(article.category);
    for (const asset of article.assets) {
      const parts = safeAssetParts(asset);
      plans.set(`content/${article.category}/assets/${parts.join('/')}`, { category: article.category, parts });
    }
  }
  return plans;
}

async function digestFile(filename: string): Promise<{ size: number; sha256: string }> {
  const data = await readFile(filename);
  return { size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
}

async function copyAssets(
  snapshot: SiteSnapshot,
  sourceRoot: string,
  destinationRoot: string,
  visibleOnly: boolean,
): Promise<AssetManifestEntry[]> {
  const realSourceRoot = await realpath(sourceRoot);
  const entries: AssetManifestEntry[] = [];
  for (const [relativePath, plan] of assetPlans(snapshot, visibleOnly)) {
    const assetsRoot = path.resolve(realSourceRoot, 'content', plan.category, 'assets');
    const source = path.resolve(assetsRoot, ...plan.parts);
    const destination = path.resolve(destinationRoot, ...relativePath.split('/'));
    if (!inside(assetsRoot, source) || !inside(destinationRoot, destination)) throw new Error('Asset path escapes its allowed root');
    const [realAssetsRoot, realSource, sourceStat] = await Promise.all([realpath(assetsRoot), realpath(source), lstat(source)]);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || !inside(realAssetsRoot, realSource)) {
      throw new Error('Asset must be a regular file inside the category assets directory');
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(realSource, destination);
    entries.push({ path: relativePath, ...await digestFile(destination) });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function cacheKey(snapshot: SiteSnapshot): string {
  return createHash('sha256').update(snapshot.sourceCommit).update('\0').update(snapshot.visibilityHash).digest('hex');
}

export function snapshotAssetsRoot(config: ServerConfig, snapshot: SiteSnapshot): string {
  return path.join(config.snapshotsDir, cacheKey(snapshot));
}

function validManifest(value: unknown, snapshot: SiteSnapshot): value is AssetManifest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<AssetManifest>;
  return candidate.version === 1 && candidate.sourceCommit === snapshot.sourceCommit
    && candidate.visibilityHash === snapshot.visibilityHash && Array.isArray(candidate.assets)
    && candidate.assets.every((entry) => typeof entry === 'object' && entry !== null
      && typeof entry.path === 'string' && Number.isSafeInteger(entry.size) && entry.size >= 0
      && typeof entry.sha256 === 'string' && /^[a-f0-9]{64}$/.test(entry.sha256));
}

async function verifyCache(root: string, snapshot: SiteSnapshot): Promise<void> {
  const manifest: unknown = JSON.parse(await readFile(path.join(root, manifestFilename), 'utf8'));
  if (!validManifest(manifest, snapshot)) throw new Error('Snapshot asset manifest is invalid');
  const expected = [...assetPlans(snapshot, false).keys()].sort();
  const actual = manifest.assets.map((entry) => entry.path).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected) || new Set(actual).size !== actual.length) {
    throw new Error('Snapshot asset manifest does not match the snapshot');
  }
  const realRoot = await realpath(root);
  for (const entry of manifest.assets) {
    const candidate = path.resolve(root, ...entry.path.split('/'));
    if (!inside(root, candidate)) throw new Error('Snapshot asset cache path is unsafe');
    const [realCandidate, sourceStat, digest] = await Promise.all([
      realpath(candidate),
      lstat(candidate),
      digestFile(candidate),
    ]);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || !inside(realRoot, realCandidate)
      || digest.size !== entry.size || digest.sha256 !== entry.sha256) {
      throw new Error('Snapshot asset cache is incomplete or modified');
    }
  }
}

export async function requireSnapshotAssets(config: ServerConfig, snapshot: SiteSnapshot): Promise<string> {
  const root = snapshotAssetsRoot(config, snapshot);
  await verifyCache(root, snapshot);
  return root;
}

export async function cacheSnapshotAssets(
  config: ServerConfig,
  snapshot: SiteSnapshot,
  sourceRoot: string,
): Promise<string> {
  const root = snapshotAssetsRoot(config, snapshot);
  try {
    await verifyCache(root, snapshot);
    return root;
  } catch {
    await rm(root, { recursive: true, force: true });
  }
  await mkdir(config.snapshotsDir, { recursive: true });
  const temporary = path.join(config.snapshotsDir, `.${cacheKey(snapshot)}-${randomUUID()}.tmp`);
  try {
    await mkdir(temporary, { recursive: false });
    const manifest: AssetManifest = {
      version: 1,
      sourceCommit: snapshot.sourceCommit,
      visibilityHash: snapshot.visibilityHash,
      assets: await copyAssets(snapshot, sourceRoot, temporary, false),
    };
    await writeFile(path.join(temporary, manifestFilename), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    await verifyCache(temporary, snapshot);
    try {
      await rename(temporary, root);
    } catch (error) {
      await verifyCache(root, snapshot).catch(() => { throw error; });
      await rm(temporary, { recursive: true, force: true });
    }
    return root;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function runAstroBuild(snapshotPath: string, releaseDir: string, projectRoot: string): Promise<void> {
  let output = '';
  const attempt = async (nodeFallback: boolean): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      const executable = nodeFallback ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const npmArgs = ['run', 'build', '-w', '@pushpost/site'];
      const args = nodeFallback
        ? [path.resolve(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), ...npmArgs]
        : npmArgs;
      let retryingWithNode = false;
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(executable, args, {
          cwd: projectRoot,
          shell: false,
          windowsHide: true,
          env: { ...process.env, PUSHPOST_SNAPSHOT: snapshotPath, PUSHPOST_OUT_DIR: releaseDir },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        if (!nodeFallback && process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EINVAL') {
          attempt(true).then(resolve, reject);
        } else reject(error);
        return;
      }
      const append = (chunk: Buffer): void => { output = (output + chunk.toString('utf8')).slice(-32_000); };
      child.stdout!.on('data', append);
      child.stderr!.on('data', append);
      const timeout = setTimeout(() => child.kill(), 10 * 60_000);
      timeout.unref();
      child.once('error', (error: NodeJS.ErrnoException) => {
        clearTimeout(timeout);
        if (!nodeFallback && process.platform === 'win32' && error.code === 'EINVAL') {
          retryingWithNode = true;
          attempt(true).then(resolve, reject);
        } else reject(new Error(`Unable to start the Astro build: ${error.message}`));
      });
      child.once('close', (code, signal) => {
        clearTimeout(timeout);
        if (retryingWithNode) return;
        if (code === 0) resolve();
        else reject(new Error(`Astro build failed (${signal ?? `exit ${String(code)}`}): ${output.trim()}`));
      });
    });
  };
  await attempt(false);
}

export function createDeploymentBuilder(config: ServerConfig): (context: DeploymentBuildContext) => Promise<void> {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  return async (context) => {
    await mkdir(config.temporaryDir, { recursive: true });
    const snapshotPath = path.join(config.temporaryDir, `snapshot-${randomUUID()}.json`);
    const handle = await open(snapshotPath, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(context.snapshot), 'utf8');
    } finally {
      await handle.close();
    }
    try {
      await runAstroBuild(snapshotPath, context.releaseDir, projectRoot);
      const cacheRoot = await requireSnapshotAssets(config, context.snapshot);
      await copyAssets(context.snapshot, cacheRoot, context.releaseDir, true);
    } finally {
      await rm(snapshotPath, { force: true });
    }
  };
}
