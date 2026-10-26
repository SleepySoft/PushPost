import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import type { PublicationMode } from '@pushpost/core/types';
import { assetArchivePath, resolveContentFile } from './content.js';
import {
  AdapterError,
  type AdapterInput,
  type ManualAdapterResult,
  type PlatformAdapter,
} from './types.js';

interface ExportManifest {
  articleId: string;
  sourceCommit: string;
  hash: string;
  target: string;
  mode: PublicationMode;
  time: string;
}

function safeFilenamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '') || 'article';
}

function uniqueArchivePath(candidate: string, used: Set<string>): string {
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  const extension = path.posix.extname(candidate);
  const stem = candidate.slice(0, candidate.length - extension.length);
  let version = 2;
  while (used.has(`${stem}-${version}${extension}`)) version += 1;
  const result = `${stem}-${version}${extension}`;
  used.add(result);
  return result;
}

export class ExportAdapter implements PlatformAdapter {
  readonly type = 'export';

  async execute(input: AdapterInput): Promise<ManualAdapterResult> {
    if (!input.exportDir) {
      throw new AdapterError('content', 'exportDir is required for manual export');
    }
    if (input.operation !== 'export') {
      throw new AdapterError('content', `Export adapter only supports the export operation, received: ${input.operation}`);
    }

    const time = new Date().toISOString();
    const hash = createHash('sha256').update(input.article.markdown).update('\0').update(input.article.html).digest('hex');
    const manifest: ExportManifest = {
      articleId: input.article.id,
      sourceCommit: input.snapshot.sourceCommit,
      hash,
      target: input.target.alias,
      mode: input.mode ?? input.target.defaultMode,
      time,
    };
    const zip = new AdmZip();
    zip.addFile('article.md', Buffer.from(input.article.markdown));
    zip.addFile('article.html', Buffer.from(input.article.html));
    zip.addFile('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));

    const usedPaths = new Set(['article.md', 'article.html', 'manifest.json']);
    for (const asset of input.article.assets) {
      const archivePath = uniqueArchivePath(assetArchivePath(asset), usedPaths);
      const filePath = await resolveContentFile(input.contentRoot, asset);
      const data = await readFile(filePath).catch((cause) => {
        throw new AdapterError('content', `Asset cannot be read: ${asset}`, { cause });
      });
      zip.addFile(archivePath, data);
    }

    const exportDir = path.resolve(input.exportDir);
    await mkdir(exportDir, { recursive: true }).catch((cause) => {
      throw new AdapterError('retryable', 'Could not create the manual export directory', { cause });
    });
    const version = time.replace(/[-:]/g, '').replace(/\.(\d{3})Z$/, '$1Z');
    const basename = `${safeFilenamePart(input.article.id)}-${version}-${hash.slice(0, 12)}`;
    const archive = zip.toBuffer();

    for (let collision = 0; collision < 1000; collision += 1) {
      const suffix = collision === 0 ? '' : `-${collision + 1}`;
      const exportPath = path.join(exportDir, `${basename}${suffix}.zip`);
      try {
        await writeFile(exportPath, archive, { flag: 'wx' });
        return { status: 'manual_required', exportPath };
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new AdapterError('retryable', 'Could not write the manual export archive', { cause });
        }
      }
    }
    throw new AdapterError('retryable', 'Could not allocate a unique manual export filename');
  }
}
