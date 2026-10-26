import type { PlatformTarget } from '@pushpost/core/types';
import { AdapterError, type PlatformAdapter } from './types.js';

export class AdapterRegistry {
  private readonly adapters = new Map<string, PlatformAdapter>();

  register(adapter: PlatformAdapter): this {
    if (this.adapters.has(adapter.type)) {
      throw new AdapterError('content', `Adapter already registered for type: ${adapter.type}`);
    }
    this.adapters.set(adapter.type, adapter);
    return this;
  }

  get(type: string): PlatformAdapter | undefined {
    return this.adapters.get(type);
  }

  require(type: string): PlatformAdapter {
    const adapter = this.get(type);
    if (!adapter) {
      throw new AdapterError('content', `No adapter registered for type: ${type}`);
    }
    return adapter;
  }

  forTarget(target: PlatformTarget): PlatformAdapter {
    return this.require(target.type);
  }

  has(type: string): boolean {
    return this.adapters.has(type);
  }
}

export function credentialEnvName(target: PlatformTarget, credentialKey: string): string {
  const normalize = (value: string) => value.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
  const alias = normalize(target.credentialRef ?? target.alias);
  const key = normalize(credentialKey);
  if (!alias || !key) {
    throw new AdapterError('content', 'Credential environment names require a target reference and key');
  }
  return `PUSHPOST_${alias}_${key}`;
}
