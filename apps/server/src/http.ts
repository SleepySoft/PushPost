import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export class HttpError extends Error {
  constructor(readonly statusCode: number, message: string, readonly code = 'request_error') {
    super(message);
    this.name = 'HttpError';
  }
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function bodyObject(request: FastifyRequest): Record<string, unknown> {
  if (typeof request.body !== 'object' || request.body === null || Array.isArray(request.body)) {
    throw new HttpError(400, 'A JSON object is required', 'invalid_body');
  }
  return request.body as Record<string, unknown>;
}

export function strictKeys(body: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new HttpError(400, 'Request contains unknown fields', 'invalid_body');
  }
}

export function stringField(value: unknown, name: string, maximum = 256): string {
  const hasControl = typeof value === 'string' && Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || hasControl) {
    throw new HttpError(400, `${name} is invalid`, 'invalid_field');
  }
  return value.trim();
}

export function idField(value: unknown, name = 'id'): string {
  const result = stringField(value, name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(result)) throw new HttpError(400, `${name} is invalid`, 'invalid_field');
  return result;
}

export function noCache(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store');
  reply.header('X-Content-Type-Options', 'nosniff');
}

export function publicError(error: unknown): { statusCode: number; code: string; message: string } {
  if (error instanceof HttpError) return { statusCode: error.statusCode, code: error.code, message: error.message };
  if (typeof error === 'object' && error !== null && 'statusCode' in error) {
    const statusCode = Number((error as { statusCode?: unknown }).statusCode);
    if (statusCode >= 400 && statusCode < 500) {
      return { statusCode, code: 'invalid_request', message: statusCode === 404 ? 'Not found' : 'Invalid request' };
    }
  }
  return { statusCode: 500, code: 'internal_error', message: 'Internal server error' };
}
