import type { PlatformTarget, PublicationMode, SnapshotArticle, TaskOperation } from '@pushpost/core';

export function operationFor(
  article: SnapshotArticle,
  target: PlatformTarget,
  hasRemote: boolean,
  requestedMode?: PublicationMode,
): TaskOperation {
  if (target.type === 'export') return 'export';
  if (hasRemote) return 'update';
  const mode = requestedMode ?? article.distribution.find((item) => item.target === target.alias)?.mode ?? target.defaultMode;
  return mode === 'published' ? 'publish' : 'create_draft';
}

export function modeFor(article: SnapshotArticle, target: PlatformTarget): PublicationMode {
  return article.distribution.find((item) => item.target === target.alias)?.mode ?? target.defaultMode;
}
