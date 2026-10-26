import type {
  Article,
  PublicationMode,
  RemoteObject,
  SiteSnapshot,
  TaskOperation,
  PlatformTarget,
} from '@pushpost/core/types';

export type AdapterErrorCategory = 'retryable' | 'authentication' | 'content' | 'uncertain';

export interface AdapterErrorOptions {
  cause?: unknown;
  statusCode?: number;
  retryAfterMs?: number;
}

export class AdapterError extends Error {
  readonly category: AdapterErrorCategory;
  readonly statusCode?: number;
  readonly retryAfterMs?: number;

  constructor(category: AdapterErrorCategory, message: string, options: AdapterErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'AdapterError';
    this.category = category;
    this.statusCode = options.statusCode;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export interface AdapterInput<Credential = unknown> {
  article: Article;
  snapshot: SiteSnapshot;
  target: PlatformTarget;
  operation: TaskOperation;
  credential?: Credential;
  remoteObject?: RemoteObject | null;
  mode?: PublicationMode;
  contentRoot?: string;
  exportDir?: string;
}

export interface RemoteAdapterResult {
  status: 'succeeded';
  remoteId: string;
  url: string | null;
  remoteStatus: string;
}

export interface ManualAdapterResult {
  status: 'manual_required';
  exportPath: string;
}

export type AdapterResult = RemoteAdapterResult | ManualAdapterResult;

export interface PlatformAdapter<Credential = unknown> {
  readonly type: string;
  execute(input: AdapterInput<Credential>): Promise<AdapterResult>;
}
