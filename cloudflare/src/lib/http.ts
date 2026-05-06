import type { Context, Next } from 'hono';
import type { Env } from '../types';

export const jsonOk = <T>(data: T, init?: ResponseInit) => Response.json({ ok: true, data }, init);
export const jsonErr = (message: string, status = 400, code = 'bad_request') =>
  Response.json({ ok: false, error: { code, message } }, { status });

export function getNum(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function securityHeaders(c: Context<{ Bindings: Env }>, next: Next) {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
}

export async function requestId(c: Context, next: Next) {
  const id = c.req.header('CF-Ray') || crypto.randomUUID();
  c.set('requestId', id);
  c.header('X-Request-Id', id);
  await next();
}
