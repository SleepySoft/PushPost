import type { StateStore } from './state-store.js';

export type ContentStatus = 'draft' | 'published' | 'archived';
export type PublicationMode = 'draft' | 'published';
export type PublicationTrigger = 'auto' | 'manual';

export interface DistributionIntent {
  target: string;
  mode: PublicationMode;
  trigger: PublicationTrigger;
}

export interface Article {
  id: string;
  title: string;
  slug: string;
  summary: string;
  status: ContentStatus;
  publishedAt: string | null;
  lang: string;
  tags: string[];
  cover: string | null;
  canonicalUrl: string | null;
  distribution: DistributionIntent[];
  category: string;
  sourcePath: string;
  markdown: string;
  html: string;
  assets: string[];
}

export interface SnapshotArticle extends Article {
  visible: boolean;
}

export interface Category {
  name: string;
  path: string;
  articleCount: number;
}

export interface PlatformTarget {
  alias: string;
  type: string;
  enabled: boolean;
  credentialRef?: string;
  defaultMode: PublicationMode;
  defaultTrigger: PublicationTrigger;
  options: Record<string, unknown>;
}

export interface RedirectRule {
  from: string;
  articleId: string;
  status: 301 | 302;
}

export interface SiteSettings {
  schemaVersion: 1;
  defaultLang: string;
  timezone: string;
}

export interface SiteSnapshot {
  sourceCommit: string;
  generatedAt: string;
  visibilityHash: string;
  settings: SiteSettings;
  siteUrl: string;
  siteTitle: string;
  articles: SnapshotArticle[];
  categories: Category[];
  targets: PlatformTarget[];
  redirects: RedirectRule[];
}

export interface ContentValidationIssue {
  sourceCommit: string;
  sourcePath: string;
  field: string | null;
  reason: string;
}

export interface LoadContentOptions {
  rootDir: string;
  sourceCommit: string;
  siteUrl: string;
  siteTitle: string;
  registeredAdapterTypes: Iterable<string>;
  now?: Date;
  allowExternalImages?: boolean;
  maxAssetBytes?: number;
}

export type TaskStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'manual_required' | 'cancelled';
export type TaskOperation = 'create_draft' | 'publish' | 'update' | 'unpublish' | 'export';

export interface DistributionTask {
  id: string;
  repositoryId: string;
  articleId: string;
  targetAlias: string;
  operation: TaskOperation;
  sourceCommit: string;
  contentHash: string;
  status: TaskStatus;
  attemptCount: number;
  availableAt: string;
  lastError: string | null;
  leaseOwner: string | null;
  leaseUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteObject {
  repositoryId: string;
  articleId: string;
  targetAlias: string;
  remoteId: string;
  remoteUrl: string | null;
  remoteStatus: string;
  updatedAt: string;
}

export type DeploymentStatus = 'queued' | 'building' | 'succeeded' | 'failed';

export interface Deployment {
  id: string;
  repositoryId: string;
  sourceCommit: string;
  visibilityHash: string;
  releasePath: string;
  status: DeploymentStatus;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CurrentRelease {
  deploymentId: string;
  repositoryId: string;
  sourceCommit: string;
  visibilityHash: string;
  releasePath: string;
  deployedAt: string;
}

export interface DeploymentBuildContext {
  deploymentId: string;
  releaseDir: string;
  snapshot: SiteSnapshot;
}

export interface DeploymentRequest {
  snapshot: SiteSnapshot;
}

export interface DeploymentManagerOptions {
  repositoryId: string;
  releasesDir: string;
  store: StateStore;
  build: (context: DeploymentBuildContext) => Promise<void>;
  keepReleases?: number;
}
