import { createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { StateStore, UserRecord } from '@pushpost/core';
import type { ServerConfig } from './config.js';
import { HttpError, safeEqual, sha256 } from './http.js';

export type Role = 'admin' | 'editor' | 'publisher';
export interface AuthUser { id: string; email: string; displayName: string; role: Role }
export interface AuthenticatedRequest extends FastifyRequest { authUser: AuthUser; sessionToken: string }

const cookieName = 'pushpost_session';
const roles = new Set<Role>(['admin', 'editor', 'publisher']);

export function publicUser(user: UserRecord): AuthUser {
  return { id: user.id, email: user.email, displayName: user.displayName, role: user.role as Role };
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || password.length > 1024) throw new HttpError(400, 'Password must contain 12 to 1024 characters', 'invalid_password');
  const salt = randomBytes(16);
  const derived = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, { N: 16_384, r: 8, p: 1 }, (error, key) => error ? reject(error) : resolve(key));
  });
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded: string | null): Promise<boolean> {
  if (!encoded) return false;
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (n !== 16_384 || r !== 8 || p !== 1 || !parts[4] || !parts[5]) return false;
  try {
    const salt = Buffer.from(parts[4], 'base64url');
    const expected = Buffer.from(parts[5], 'base64url');
    const derived = await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, expected.length, { N: n, r, p }, (error, key) => error ? reject(error) : resolve(key));
    });
    return expected.length === derived.length && timingSafeEqual(expected, derived);
  } catch {
    return false;
  }
}

export class AuthService {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly config: ServerConfig, private readonly store: StateStore) {}

  async bootstrap(): Promise<void> {
    const count = this.store.db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
    if (count.count === 0 && this.config.adminEmail && this.config.adminPassword) {
      this.store.createUser({
        email: this.config.adminEmail.toLowerCase(),
        displayName: 'Administrator',
        role: 'admin',
        passwordHash: await hashPassword(this.config.adminPassword),
      });
    }
  }

  async login(email: string, password: string, ip: string): Promise<{ token: string; user: AuthUser; csrfToken: string }> {
    const now = Date.now();
    const attempt = this.attempts.get(ip);
    if (attempt && attempt.resetAt > now && attempt.count >= 5) throw new HttpError(429, 'Too many login attempts', 'rate_limited');
    if (!attempt || attempt.resetAt <= now) this.attempts.set(ip, { count: 0, resetAt: now + 15 * 60_000 });
    const record = this.store.getUserByEmail(email.toLowerCase());
    const valid = await verifyPassword(password, record?.passwordHash ?? null);
    if (!record || !valid || !roles.has(record.role as Role)) {
      const current = this.attempts.get(ip)!;
      current.count += 1;
      throw new HttpError(401, 'Invalid email or password', 'invalid_credentials');
    }
    this.attempts.delete(ip);
    const token = randomBytes(32).toString('base64url');
    this.store.createSession({
      userId: record.id,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + this.config.sessionTtlMs),
    });
    return { token, user: publicUser(record), csrfToken: this.csrfToken(token) };
  }

  setSessionCookie(reply: FastifyReply, token: string): void {
    reply.setCookie(cookieName, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: this.config.cookieSecure,
      maxAge: Math.floor(this.config.sessionTtlMs / 1000),
    });
  }

  clearSessionCookie(reply: FastifyReply): void {
    reply.clearCookie(cookieName, { path: '/', httpOnly: true, sameSite: 'strict', secure: this.config.cookieSecure });
  }

  csrfToken(token: string): string {
    return createHmac('sha256', this.config.sessionSecret).update(`csrf:${token}`).digest('base64url');
  }

  authenticate = async (request: FastifyRequest): Promise<void> => {
    const token = request.cookies[cookieName];
    if (!token) throw new HttpError(401, 'Authentication required', 'unauthorized');
    const session = this.store.getSessionByTokenHash(sha256(token));
    const user = session ? this.store.getUserById(session.userId) : null;
    if (!session || !user || !roles.has(user.role as Role)) throw new HttpError(401, 'Authentication required', 'unauthorized');
    this.store.touchSession(session.id);
    Object.assign(request, { authUser: publicUser(user), sessionToken: token });
  };

  csrf = async (request: FastifyRequest): Promise<void> => {
    const authenticated = request as AuthenticatedRequest;
    if (!authenticated.sessionToken) throw new HttpError(401, 'Authentication required', 'unauthorized');
    const supplied = request.headers['x-csrf-token'];
    if (typeof supplied !== 'string' || !safeEqual(supplied, this.csrfToken(authenticated.sessionToken))) {
      throw new HttpError(403, 'Invalid CSRF token', 'csrf_failed');
    }
    const origin = request.headers.origin;
    if (origin) {
      const requestOrigin = `${request.protocol}://${request.headers.host ?? ''}`;
      if (origin !== new URL(this.config.siteUrl).origin && origin !== requestOrigin) {
        throw new HttpError(403, 'Invalid request origin', 'csrf_failed');
      }
    }
  };

  requireRoles(...allowed: Role[]) {
    return async (request: FastifyRequest): Promise<void> => {
      const role = (request as AuthenticatedRequest).authUser?.role;
      if (!role || !allowed.includes(role)) throw new HttpError(403, 'Insufficient permissions', 'forbidden');
    };
  }

  logout(request: FastifyRequest): void {
    const token = request.cookies[cookieName];
    if (!token) return;
    const session = this.store.getSessionByTokenHash(sha256(token));
    if (session) this.store.deleteSession(session.id);
  }

  cleanup(): void {
    this.store.deleteExpiredSessions();
    const now = Date.now();
    for (const [key, value] of this.attempts) if (value.resetAt <= now) this.attempts.delete(key);
  }

  newUserId(): string {
    return randomUUID();
  }
}
