import type { Context, Next } from 'hono';
import type { Env } from '../types';
import { getNum, jsonErr } from './http';

export function rateLimit(kind: 'api' | 'admin') {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    const limit = getNum(kind === 'admin' ? c.env.ADMIN_RATE_LIMIT_PER_MINUTE : c.env.API_RATE_LIMIT_PER_MINUTE, kind === 'admin' ? 120 : 60);
    const ip = c.req.header('CF-Connecting-IP') || 'local';
    const minute = Math.floor(Date.now() / 60000);
    const key = `rl:${kind}:${ip}:${minute}`;
    const current = Number((await c.env.CACHE.get(key)) || '0') + 1;
    if (current === 1) await c.env.CACHE.put(key, String(current), { expirationTtl: 90 });
    else await c.env.CACHE.put(key, String(current), { expirationTtl: 90 });
    if (current > limit) return jsonErr('rate limit exceeded', 429, 'rate_limited');
    await next();
  };
}
