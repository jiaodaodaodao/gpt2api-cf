import type { Context, Next } from 'hono';
import type { Env, JwtPayload } from '../types';
import { jsonErr, getNum } from '../lib/http';
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
  if (!user) return jsonErr('invalid token', 401, 'unauthorized');
  c.set('user', user);
  await next();
}
export async function authAdmin(c: Context<{ Bindings: Env; Variables: any }>, next: Next) {
  const user = await userFromBearer(c);
  if (!user) return jsonErr('invalid token', 401, 'unauthorized');
  if (user.role !== 'admin') return jsonErr('admin required', 403, 'forbidden');
  c.set('user', user);
  await next();
}
export async function authApiKey(c: Context<{ Bindings: Env; Variables: any }>, next: Next) {
  const header = c.req.header('Authorization') || '';
  const raw = header.startsWith('Bearer ') ? header.slice(7) : c.req.header('X-API-Key') || '';
  if (!raw) return Response.json({ error: { message: 'missing API key', type: 'invalid_request_error' } }, { status: 401 });
  const apiKey = await getApiKey(c.env, raw);
  if (!apiKey) return Response.json({ error: { message: 'invalid API key', type: 'invalid_request_error' } }, { status: 401 });
  const user = await getUserById(c.env, apiKey.user_id);
  if (!user || user.status !== 'active') return Response.json({ error: { message: 'user disabled', type: 'invalid_request_error' } }, { status: 403 });
  c.set('apiKey', apiKey);
  c.set('user', user);
  await next();
}
