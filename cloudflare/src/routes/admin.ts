import { Hono } from 'hono';
import type { Env, AppVariables } from '../types';
import { jsonErr, jsonOk } from '../lib/http';
import { encryptText, sha256Hex } from '../lib/crypto';
import { authAdmin } from '../services/auth';
import { id, nowIso } from '../services/db';

export const adminRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();
adminRoutes.use('/admin/api/*', authAdmin);

adminRoutes.get('/admin/api/dashboard', async (c) => {
  const [users, keys, accounts, logs] = await Promise.all([
    c.env.DB.prepare('select count(*) n, coalesce(sum(credits),0) credits from users').first(),
    c.env.DB.prepare('select count(*) n from api_keys where status="active"').first(),
    c.env.DB.prepare('select provider,status,count(*) n from accounts group by provider,status').all(),
    c.env.DB.prepare('select * from request_logs order by created_at desc limit 50').all(),
  ]);
  return jsonOk({ users, keys, accounts: accounts.results, logs: logs.results });
});
adminRoutes.get('/admin/api/users', async (c) => jsonOk((await c.env.DB.prepare('select id,email,role,status,credits,created_at from users order by created_at desc limit 200').all()).results));
adminRoutes.patch('/admin/api/users/:id/credits', async (c) => {
  const { credits } = await c.req.json().catch(() => ({}));
  if (!Number.isFinite(Number(credits))) return jsonErr('credits required');
  await c.env.DB.prepare('update users set credits=?, updated_at=? where id=?').bind(Number(credits), nowIso(), c.req.param('id')).run();
  return jsonOk({ updated: true });
});
adminRoutes.get('/admin/api/accounts', async (c) => jsonOk((await c.env.DB.prepare('select id,provider,label,proxy_url,weight,status,fail_count,circuit_until,last_used_at,last_error,created_at from accounts order by created_at desc').all()).results));
adminRoutes.post('/admin/api/accounts', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!['gpt', 'grok'].includes(body.provider) || !body.cookie) return jsonErr('provider and cookie required');
  const recId = id('acc');
  await c.env.DB.prepare('insert into accounts(id,provider,label,cookie_encrypted,access_token_encrypted,proxy_url,weight,status,fail_count,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?,?)')
    .bind(recId, body.provider, body.label || body.provider, await encryptText(body.cookie, c.env.ENCRYPTION_KEY), body.access_token ? await encryptText(body.access_token, c.env.ENCRYPTION_KEY) : null, body.proxy_url || null, Number(body.weight || 1), 'active', 0, nowIso(), nowIso()).run();
  return jsonOk({ id: recId });
});
adminRoutes.patch('/admin/api/accounts/:id', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  await c.env.DB.prepare('update accounts set label=coalesce(?,label),proxy_url=?,weight=coalesce(?,weight),status=coalesce(?,status),updated_at=? where id=?')
    .bind(body.label || null, body.proxy_url || null, body.weight == null ? null : Number(body.weight), body.status || null, nowIso(), c.req.param('id')).run();
  return jsonOk({ updated: true });
});
adminRoutes.get('/admin/api/apikeys', async (c) => jsonOk((await c.env.DB.prepare('select k.id,k.user_id,u.email,k.name,k.status,k.scopes,k.created_at from api_keys k left join users u on u.id=k.user_id order by k.created_at desc limit 200').all()).results));
adminRoutes.post('/admin/api/apikeys', async (c) => {
  const { user_id, name, scopes } = await c.req.json().catch(() => ({}));
  if (!user_id) return jsonErr('user_id required');
  const raw = `sk-g2cf-${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '')}`;
  const recId = id('key');
  await c.env.DB.prepare('insert into api_keys(id,user_id,key_hash,name,status,scopes,created_at,updated_at) values(?,?,?,?,?,?,?,?)')
    .bind(recId, user_id, await sha256Hex(raw), name || 'admin-created', 'active', scopes || 'chat,images,video', nowIso(), nowIso()).run();
  return jsonOk({ id: recId, key: raw });
});
adminRoutes.get('/admin/api/logs', async (c) => jsonOk((await c.env.DB.prepare('select * from request_logs order by created_at desc limit 200').all()).results));
adminRoutes.get('/admin/api/configs', async (c) => jsonOk((await c.env.DB.prepare('select key,value,description,updated_at from system_configs order by key').all()).results));
adminRoutes.put('/admin/api/configs/:key', async (c) => {
  const { value, description } = await c.req.json().catch(() => ({}));
  await c.env.DB.prepare('insert into system_configs(key,value,description,updated_at) values(?,?,?,?) on conflict(key) do update set value=excluded.value,description=excluded.description,updated_at=excluded.updated_at')
    .bind(c.req.param('key'), String(value ?? ''), description || null, nowIso()).run();
  return jsonOk({ updated: true });
});
