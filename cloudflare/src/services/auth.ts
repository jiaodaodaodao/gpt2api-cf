import type { Context, Next } from 'hono';
import type { Env, JwtPayload } from '../types';
import { jsonErr, getNum, openAiError } from '../lib/http';
import { sha256Hex, signJwt, verifyJwt } from '../lib/crypto';
import { getApiKey, getUserById } from './db';

async function userFromBearer(c: Context<{ Bindings: Env; Variables: any }>) {
  const header = c.req.header('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  const payload = await verifyJwt<JwtPayload>(token, c.env.JWT_SECRET);
  if (!payload) return null;
  const user = await getUserById(c.env, payload.sub);
  return user && user.status === 'active' ? user : null;
}

export const hashPassword = (password: string) => sha256Hex(`gpt2api:${password}`);

export async function issueToken(env: Env, userId: string, role: 'user' | 'admin') {
  const exp = Math.floor(Date.now() / 1000) + getNum(env.JWT_TTL_SECONDS, 604800);
  return signJwt({ sub: userId, role, exp, iss: env.JWT_ISSUER || 'gpt2api-cf' }, env.JWT_SECRET);
}
export async function authUser(c: Context<{ Bindings: Env; Variables: any }>, next: Next) {
  const user = await userFromBearer(c);
  if (!user) return jsonErr('未登录', 401, 'unauthorized');
  c.set('user', user);
  await next();
}
export async function authAdmin(c: Context<{ Bindings: Env; Variables: any }>, next: Next) {
  const user = await userFromBearer(c);
  if (!user) return jsonErr('未登录', 401, 'unauthorized');
  if (user.role !== 'admin') return jsonErr('权限不足', 403, 'forbidden');
  c.set('user', user);
  await next();
}
export function apiKeyAllows(scopeText = '', required: 'chat' | 'image' | 'video') {
  const scopes = scopeText.split(',').map((s) => s.trim()).filter(Boolean);
  return scopes.includes('*') || scopes.includes(required) || (required === 'image' && scopes.includes('images'));
}
async function enforceApiKeyQuota(c: Context<{ Bindings: Env; Variables: any }>, keyId: string, rpmLimit = 0, dailyQuota = 0) {
  const minute = Math.floor(Date.now() / 60000);
  if (rpmLimit > 0) {
    const mk = `apikey_rpm:${keyId}:${minute}`;
    const v = Number((await c.env.CACHE.get(mk)) || '0') + 1;
    await c.env.CACHE.put(mk, String(v), { expirationTtl: 90 });
    if (v > rpmLimit) return openAiError('rate limit exceeded', 429, 'rate_limit_exceeded');
  }
  if (dailyQuota > 0) {
    const day = new Date().toISOString().slice(0, 10);
    const dk = `apikey_daily:${keyId}:${day}`;
    const v = Number((await c.env.CACHE.get(dk)) || '0') + 1;
    await c.env.CACHE.put(dk, String(v), { expirationTtl: 93600 });
    if (v > dailyQuota) return openAiError('daily quota exceeded', 429, 'quota_exceeded');
  }
  return null;
}
export async function authApiKey(c: Context<{ Bindings: Env; Variables: any }>, next: Next) {
  const header = c.req.header('Authorization') || '';
  const raw = header.startsWith('Bearer ') ? header.slice(7) : c.req.header('X-API-Key') || '';
  if (!raw) return openAiError('api key required', 401, 'invalid_api_key');
  const apiKey = await getApiKey(c.env, raw);
  if (!apiKey) return openAiError('API Key 无效', 401, 'invalid_api_key');
  const quota = await enforceApiKeyQuota(c, apiKey.id, Number(apiKey.rpm_limit || 0), Number(apiKey.daily_quota || 0));
  if (quota) return quota;
  const user = await getUserById(c.env, apiKey.user_id);
  if (!user || user.status !== 'active') return openAiError('user disabled', 403, 'invalid_request_error');
  c.set('apiKey', apiKey);
  c.set('user', user);
  await next();
}
