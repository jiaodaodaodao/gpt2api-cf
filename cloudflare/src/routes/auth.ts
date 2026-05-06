import { Hono } from 'hono';
import type { Env, AppVariables } from '../types';
import { jsonErr, jsonOk } from '../lib/http';
import { createApiKey, createUser, getUserByEmail } from '../services/db';
import { authUser, hashPassword, issueToken } from '../services/auth';

export const authRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

authRoutes.post('/auth/register', async (c) => {
  const { email, password } = await c.req.json().catch(() => ({}));
  if (!email || !password) return jsonErr('email and password required');
  if (await getUserByEmail(c.env, email)) return jsonErr('用户已存在', 409, 'exists');
  const user = await createUser(c.env, email, await hashPassword(password));
  const token = await issueToken(c.env, user!.id, user!.role);
  const apiKey = await createApiKey(c.env, user!.id);
  return jsonOk({ token, api_key: apiKey.key, user });
});

authRoutes.post('/auth/login', async (c) => {
  const { email, password } = await c.req.json().catch(() => ({}));
  const user = email ? await getUserByEmail(c.env, email) : null;
  if (!user || user.status !== 'active') return jsonErr('登录凭证无效', 401, 'unauthorized');
  const hash = await hashPassword(password || '');
  const stored = (await c.env.DB.prepare('select password_hash from users where id=?').bind(user.id).first()) as { password_hash: string } | null;
  if (!stored || stored.password_hash !== hash) return jsonErr('登录凭证无效', 401, 'unauthorized');
  return jsonOk({ token: await issueToken(c.env, user.id, user.role), user });
});

authRoutes.post('/auth/refresh', authUser, async (c) => {
  const user = c.get('user');
  return jsonOk({ token: await issueToken(c.env, user.id, user.role) });
});
authRoutes.post('/auth/logout', () => jsonOk(null));
authRoutes.get('/me', authUser, (c) => jsonOk({ user: c.get('user') }));
authRoutes.post('/apikeys', authUser, async (c) => jsonOk(await createApiKey(c.env, c.get('user').id)));
