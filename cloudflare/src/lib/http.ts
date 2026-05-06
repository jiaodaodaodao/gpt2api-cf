import type { Context, Next } from 'hono';
import type { Env } from '../types';

export function jsonOk<T>(data: T, init?: ResponseInit) {
  const traceId = init?.headers instanceof Headers ? init.headers.get('X-Request-Id') : undefined;
  return Response.json({ code: 0, msg: 'ok', data, trace_id: traceId || undefined }, init);
}

export function jsonErr(message: string, status = 400, code = 'bad_request') {
  const numericCode = status * 1000 + 101;
  return Response.json({ code: numericCode, msg: message, error: code }, { status });
}

export const openAiError = (message: string, status = 500, type = 'server_error') =>
  Response.json({ error: { message, type, code: type } }, { status });

export function getNum(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export async function securityHeaders(c: Context<{ Bindings: Env }>, next: Next) {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
}

export async function requestId(c: Context, next: Next) {
  const id = c.req.header('X-Request-Id') || c.req.header('CF-Ray') || crypto.randomUUID();
  c.set('requestId', id);
  c.header('X-Request-Id', id);
  await next();
}
