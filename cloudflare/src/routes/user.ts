import { Hono } from 'hono';
import type { Env, AppVariables } from '../types';
import { authUser } from '../services/auth';
import { createApiKey, deleteApiKey, listApiKeys, setApiKeyEnabled } from '../services/db';
import { jsonOk } from '../lib/http';

export const userRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

userRoutes.get('/api/v1/ping', (c) => c.json({ pong: true }));
userRoutes.use('/api/v1/*', authUser);
userRoutes.get('/api/v1/users/me', (c) => jsonOk({ user: c.get('user') }));
userRoutes.get('/api/v1/keys', async (c) => jsonOk({ list: await listApiKeys(c.env, c.get('user').id) }));
userRoutes.post('/api/v1/keys', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const created = await createApiKey(c.env, c.get('user').id, body.name || 'default', body.scope || body.scopes || 'chat,image,images,video', Number(body.rpm_limit || 0), Number(body.daily_quota || 0), Number(body.expire_days || 0));
  return jsonOk(created);
});
userRoutes.post('/api/v1/keys/:id/toggle', async (c) => {
  const enable = new URL(c.req.raw.url).searchParams.get('enable') !== '0';
  await setApiKeyEnabled(c.env, c.get('user').id, c.req.param('id'), enable);
  return jsonOk(null);
});
userRoutes.delete('/api/v1/keys/:id', async (c) => {
  await deleteApiKey(c.env, c.get('user').id, c.req.param('id'));
  return jsonOk(null);
});
userRoutes.get('/api/v1/billing/logs', async (c) => jsonOk({ list: (await c.env.DB.prepare('select * from billing_records where user_id=? order by created_at desc limit 100').bind(c.get('user').id).all()).results }));
userRoutes.get('/api/v1/calls', async (c) => jsonOk({ list: (await c.env.DB.prepare('select * from api_call_records where user_id=? order by created_at desc limit 100').bind(c.get('user').id).all()).results }));
userRoutes.get('/api/v1/gen/history', async (c) => jsonOk({ list: (await c.env.DB.prepare('select * from generations where user_id=? order by created_at desc limit 100').bind(c.get('user').id).all()).results }));
userRoutes.get('/api/v1/gen/tasks/:task_id', async (c) => jsonOk(await c.env.DB.prepare('select * from generations where id=? and user_id=?').bind(c.req.param('task_id'), c.get('user').id).first()));

// 兼容上一版 cloudflare 目录的短路径，便于平滑升级。
userRoutes.get('/api/wallet', authUser, (c) => jsonOk({ credits: c.get('user').credits }));
userRoutes.get('/api/billing', authUser, async (c) => jsonOk((await c.env.DB.prepare('select * from billing_records where user_id=? order by created_at desc limit 100').bind(c.get('user').id).all()).results));
