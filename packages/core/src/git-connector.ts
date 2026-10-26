import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

export interface GitConnectorOptions {
  remoteUrl: string;
  branch: string;
  workDir: string;
  timeoutMs?: number;
}

export interface GitSyncResult {
  commit: string;
  workDir: string;
}

interface GitResult {
  stdout: string;
  stderr: string;
}

export class GitCommandError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(args: string[], exitCode: number | null, stderr: string) {
    super(`git ${args.join(' ')} failed${exitCode === null ? '' : ` with exit code ${exitCode}`}: ${stderr.trim() || 'no error output'}`);
    this.name = 'GitCommandError';
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

function validBranch(branch: string): boolean {
  return branch.length > 0
    && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)
    && !branch.includes('..')
    && !branch.includes('@{')
    && !branch.includes('//')
    && !branch.endsWith('/')
    && !branch.endsWith('.')
    && !branch.split('/').some((part) => part.endsWith('.lock'));
}

function validCommit(commit: string): boolean {
    return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit);
}

function redact(value: string): string {
  return value.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1<credentials>@');
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

export class GitConnector {
  readonly remoteUrl: string;
  readonly branch: string;
  readonly workDir: string;
  private readonly timeoutMs: number;
  private readonly hooksDir: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: GitConnectorOptions) {
    if (!options.remoteUrl || hasControlCharacter(options.remoteUrl)) {
      throw new TypeError('remoteUrl must be non-empty and contain no control characters');
    }
    if (!validBranch(options.branch)) throw new TypeError(`Invalid Git branch: ${options.branch}`);
    if (!options.workDir) throw new TypeError('workDir is required');
    this.remoteUrl = options.remoteUrl;
    this.branch = options.branch;
    this.workDir = path.resolve(options.workDir);
    this.hooksDir = `${this.workDir}.empty-hooks`;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) throw new TypeError('timeoutMs must be a positive integer');
  }

  private async run(args: string[], cwd = this.workDir): Promise<GitResult> {
    const safeArgs = [
      '-c', `core.hooksPath=${this.hooksDir}`,
      '-c', 'submodule.recurse=false',
      '-c', 'core.askPass=',
      ...args,
    ];
    return new Promise<GitResult>((resolve, reject) => {
      const child = spawn('git', safeArgs, {
        cwd,
        shell: false,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_CONFIG_NOSYSTEM: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const append = (current: string, chunk: Buffer): string => (current + chunk.toString('utf8')).slice(-1_000_000);
      child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`git ${args.join(' ')} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(new Error(`Unable to execute git: ${error.message}`, { cause: error }));
      });
      child.once('close', (code, signal) => {
        clearTimeout(timeout);
        if (code === 0) resolve({ stdout, stderr });
        else reject(new GitCommandError(args.map(redact), code, redact(signal ? `${stderr}\nterminated by ${signal}` : stderr)));
      });
    });
  }

  async clone(): Promise<void> {
    if (existsSync(this.workDir)) throw new Error(`Cannot clone into existing workDir: ${this.workDir}`);
    await mkdir(path.dirname(this.workDir), { recursive: true });
    await mkdir(this.hooksDir, { recursive: true });
    try {
      await this.run([
        'clone', '--no-checkout', '--no-recurse-submodules', '--no-hardlinks', '--single-branch',
        '--branch', this.branch, '--', this.remoteUrl, this.workDir,
      ], path.dirname(this.workDir));
    } catch (error) {
      await rm(this.workDir, { recursive: true, force: true });
      throw error;
    }
  }

  async fetch(): Promise<void> {
    this.assertReady();
    const configured = await this.run(['remote', 'get-url', 'origin']);
    const actual = configured.stdout.trim();
    const normalize = (remote: string): string => remote.includes('://') || /^[^/\\]+@[^/\\]+:/.test(remote)
      ? remote
      : path.normalize(path.resolve(remote));
    if (normalize(actual) !== normalize(this.remoteUrl)) {
      throw new Error(`Git origin does not match configured remoteUrl (actual: ${redact(actual)})`);
    }
    await this.run(['fetch', '--no-tags', '--prune', 'origin', `+refs/heads/${this.branch}:refs/remotes/origin/${this.branch}`]);
  }

  async getRemoteHead(): Promise<string> {
    this.assertReady();
    const result = await this.run(['ls-remote', '--exit-code', 'origin', `refs/heads/${this.branch}`]);
    const line = result.stdout.split(/\r?\n/).find((value) => value.trim().length > 0);
    const commit = line?.split(/\s+/)[0] ?? '';
    if (!validCommit(commit)) throw new Error(`Remote branch ${this.branch} did not return a valid commit`);
    return commit;
  }

  async getCommit(): Promise<string> {
    this.assertReady();
    const result = await this.run(['rev-parse', '--verify', 'HEAD^{commit}']);
    const commit = result.stdout.trim();
    if (!validCommit(commit)) throw new Error('git rev-parse returned an invalid commit');
    return commit;
  }

  async checkout(commit: string): Promise<void> {
    this.assertReady();
    if (!validCommit(commit)) throw new TypeError('checkout requires a full SHA-1 or SHA-256 commit ID');
    await this.run(['checkout', '--detach', '--force', commit]);
    await this.run(['clean', '-ffd']);
    const actual = await this.getCommit();
    if (actual.toLowerCase() !== commit.toLowerCase()) throw new Error(`Checked out ${actual}, expected ${commit}`);
  }

  sync(commit?: string): Promise<GitSyncResult> {
    if (commit !== undefined && !validCommit(commit)) return Promise.reject(new TypeError('sync requires a full commit ID'));
    const operation = this.queue.then(async () => {
      if (!existsSync(path.join(this.workDir, '.git'))) await this.clone();
      await this.fetch();
      const target = commit ?? await this.getRemoteHead();
      await this.checkout(target);
      return { commit: target.toLowerCase(), workDir: this.workDir };
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private assertReady(): void {
    if (!existsSync(path.join(this.workDir, '.git'))) throw new Error(`Git workDir is not initialized: ${this.workDir}`);
  }
}
