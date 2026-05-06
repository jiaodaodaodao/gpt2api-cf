import { Hono } from 'hono';
import type { Env, AppVariables } from '../types';
import { authAdmin, authUser } from '../services/auth';
import { createApiKey, deleteApiKey, id, listApiKeys, nowIso, setApiKeyEnabled } from '../services/db';
import { encryptText } from '../lib/crypto';
import { jsonErr, jsonOk } from '../lib/http';

export const userRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

userRoutes.get('/api/v1/ping', (c) => c.json({ pong: true }));
userRoutes.post('/api/tokens/import', authAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const provider = String(body.provider || '').toLowerCase();
  if (!['gpt', 'grok'].includes(provider)) return jsonErr('provider required: gpt or grok');
  const lines = String(body.text || body.cookies || body.tokens || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const accounts = Array.isArray(body.accounts) ? body.accounts : [];
  const items = [
    ...lines.map((token, idx) => ({ label: `${provider}-${idx + 1}`, credential: token })),
    ...accounts.map((item: any, idx: number) => ({
      label: item.label || item.name || `${provider}-${lines.length + idx + 1}`,
      credential: item.cookie || item.credential || item.sso || item.token || item?.credentials?.cookie || item?.credentials?.refresh_token || '',
      access_token: item.access_token || item?.credentials?.access_token || '',
      refresh_token: item.refresh_token || item?.credentials?.refresh_token || '',
      client_id: item.client_id || item?.credentials?.client_id || '',
      upstream_base_url: item.upstream_base_url || item.base_url || body.upstream_base_url || body.base_url || null,
      proxy_url: item.proxy_url || body.proxy_url || null,
    })),
  ].filter((item) => String(item.credential || item.access_token || item.refresh_token).trim());
  if (!items.length) return jsonErr('no tokens/accounts to import');
  let imported = 0;
  const errors: string[] = [];
  for (const [idx, item] of items.entries()) {
    try {
      const recId = id('acc');
      const credential = String(item.credential || item.refresh_token || item.access_token || '').trim();
      await c.env.DB.prepare('insert into accounts(id,provider,label,cookie_encrypted,access_token_encrypted,refresh_token_encrypted,oauth_meta,proxy_url,upstream_base_url,weight,status,fail_count,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .bind(recId, provider, item.label || `${provider}-${idx + 1}`, await encryptText(credential, c.env.ENCRYPTION_KEY), item.access_token ? await encryptText(String(item.access_token), c.env.ENCRYPTION_KEY) : null, item.refresh_token ? await encryptText(String(item.refresh_token), c.env.ENCRYPTION_KEY) : null, item.client_id ? JSON.stringify({ client_id: item.client_id }) : null, item.proxy_url || null, item.upstream_base_url || null, Number(body.weight || 1), 'active', 0, nowIso(), nowIso()).run();
      imported += 1;
    } catch (e) {
      errors.push(`${idx + 1}:${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return jsonOk({ imported, skipped: errors.length, errors: errors.slice(0, 20) });
});
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
