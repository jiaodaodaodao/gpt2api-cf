import { Hono } from 'hono';
import type { Env, AppVariables } from '../types';
import { jsonErr, jsonOk } from '../lib/http';
import { encryptText, sha256Hex } from '../lib/crypto';
import { authAdmin, hashPassword, issueToken } from '../services/auth';
import { getUserByEmail, id, nowIso } from '../services/db';

export const adminRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

adminRoutes.get('/admin/api/v1/ping', (c) => c.json({ pong: true, scope: 'admin' }));
adminRoutes.post('/admin/api/v1/auth/login', async (c) => {
  const { email, password } = await c.req.json().catch(() => ({}));
  const user = email ? await getUserByEmail(c.env, email) : null;
  if (!user || user.role !== 'admin' || user.status !== 'active') return jsonErr('登录凭证无效', 401, 'unauthorized');
  const stored = (await c.env.DB.prepare('select password_hash from users where id=?').bind(user.id).first()) as { password_hash: string } | null;
  if (!stored || stored.password_hash !== await hashPassword(password || '')) return jsonErr('登录凭证无效', 401, 'unauthorized');
  return jsonOk({ token: await issueToken(c.env, user.id, 'admin'), admin: user });
});
adminRoutes.get('/admin/api/v1/logs/generations/:task_id/preview', async (c) => jsonOk(await c.env.DB.prepare('select * from generations where id=?').bind(c.req.param('task_id')).first()));
adminRoutes.use('/admin/api/v1/*', authAdmin);

adminRoutes.get('/admin/api/v1/auth/me', (c) => jsonOk({ admin: c.get('user') }));
adminRoutes.get('/admin/api/v1/dashboard/overview', async (c) => {
  const [users, keys, accounts, logs] = await Promise.all([
    c.env.DB.prepare('select count(*) n, coalesce(sum(credits),0) credits from users').first(),
    c.env.DB.prepare('select count(*) n from api_keys where status="active"').first(),
    c.env.DB.prepare('select provider,status,count(*) n from accounts group by provider,status').all(),
    c.env.DB.prepare('select * from api_call_records order by created_at desc limit 50').all(),
  ]);
  return jsonOk({ users, keys, accounts: accounts.results, recent_calls: logs.results });
});
adminRoutes.get('/admin/api/v1/users', async (c) => jsonOk({ list: (await c.env.DB.prepare('select id,email,role,status,credits,created_at from users order by created_at desc limit 200').all()).results }));
adminRoutes.post('/admin/api/v1/users/:id/points', async (c) => {
  const { points, credits } = await c.req.json().catch(() => ({}));
  const delta = Number(points ?? credits ?? 0);
  await c.env.DB.prepare('update users set credits=credits+?, updated_at=? where id=?').bind(delta, nowIso(), c.req.param('id')).run();
  return jsonOk(null);
});
adminRoutes.get('/admin/api/v1/accounts', async (c) => jsonOk({ list: (await c.env.DB.prepare('select id,provider,label,proxy_url,upstream_base_url,weight,status,fail_count,circuit_until,last_used_at,last_error,created_at from accounts order by created_at desc').all()).results }));
adminRoutes.post('/admin/api/v1/accounts', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (!['gpt', 'grok'].includes(body.provider) || !(body.cookie || body.credential || body.access_token || body.refresh_token)) return jsonErr('provider and credential required');
  const recId = id('acc');
  await c.env.DB.prepare('insert into accounts(id,provider,label,cookie_encrypted,access_token_encrypted,refresh_token_encrypted,access_token_expires_at,oauth_meta,proxy_url,upstream_base_url,weight,status,fail_count,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(recId, body.provider, body.label || body.name || body.provider, await encryptText(body.cookie || body.credential || '', c.env.ENCRYPTION_KEY), body.access_token ? await encryptText(body.access_token, c.env.ENCRYPTION_KEY) : null, body.refresh_token ? await encryptText(body.refresh_token, c.env.ENCRYPTION_KEY) : null, body.access_token_expires_at || null, body.client_id ? JSON.stringify({ client_id: body.client_id }) : (body.oauth_meta ? JSON.stringify(body.oauth_meta) : null), body.proxy_url || null, body.upstream_base_url || body.base_url || null, Number(body.weight || 1), 'active', 0, nowIso(), nowIso()).run();
  return jsonOk({ id: recId });
});

adminRoutes.post('/admin/api/v1/accounts/import', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const provider = String(body.provider || '').toLowerCase();
  if (!['gpt', 'grok'].includes(provider)) return jsonErr('provider required: gpt or grok');
  const weight = Number(body.weight || 1);
  const baseUrl = body.upstream_base_url || body.base_url || null;
  const proxyUrl = body.proxy_url || null;
  const lines = String(body.text || body.cookies || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const structured = Array.isArray(body.accounts) ? body.accounts : [];
  const items = [
    ...lines.map((cookie, idx) => ({ label: `${provider}-${idx + 1}`, cookie })),
    ...structured.map((item: any, idx: number) => ({
      label: item.label || item.name || `${provider}-${lines.length + idx + 1}`,
      cookie: item.cookie || item.credential || item.sso || item.token || item?.credentials?.cookie || item?.credentials?.refresh_token || '',
      access_token: item.access_token || item?.credentials?.access_token || '',
      refresh_token: item.refresh_token || item?.credentials?.refresh_token || '',
      client_id: item.client_id || item?.credentials?.client_id || '',
    })),
  ].filter((item) => String(item.cookie || item.access_token || item.refresh_token).trim());
  if (!items.length) return jsonErr('no cookies/accounts to import');
  let imported = 0;
  const skipped: string[] = [];
  for (const [idx, item] of items.entries()) {
    try {
      const recId = id('acc');
      const credential = String(item.cookie || item.refresh_token || item.access_token || '').trim();
      await c.env.DB.prepare('insert into accounts(id,provider,label,cookie_encrypted,access_token_encrypted,refresh_token_encrypted,oauth_meta,proxy_url,upstream_base_url,weight,status,fail_count,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .bind(recId, provider, item.label || `${provider}-${idx + 1}`, await encryptText(credential, c.env.ENCRYPTION_KEY), item.access_token ? await encryptText(String(item.access_token), c.env.ENCRYPTION_KEY) : null, item.refresh_token ? await encryptText(String(item.refresh_token), c.env.ENCRYPTION_KEY) : null, item.client_id ? JSON.stringify({ client_id: item.client_id }) : null, proxyUrl, baseUrl, weight, 'active', 0, nowIso(), nowIso()).run();
      imported += 1;
    } catch (e) {
      skipped.push(`${idx + 1}:${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return jsonOk({ imported, skipped: skipped.length, errors: skipped.slice(0, 20) });
});

adminRoutes.put('/admin/api/v1/accounts/:id', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  await c.env.DB.prepare('update accounts set label=coalesce(?,label),proxy_url=?,upstream_base_url=coalesce(?,upstream_base_url),weight=coalesce(?,weight),status=coalesce(?,status),updated_at=? where id=?')
    .bind(body.label || null, body.proxy_url || null, body.upstream_base_url || null, body.weight == null ? null : Number(body.weight), body.status || null, nowIso(), c.req.param('id')).run();
  return jsonOk(null);
});
adminRoutes.delete('/admin/api/v1/accounts/:id', async (c) => { await c.env.DB.prepare('update accounts set status="disabled", updated_at=? where id=?').bind(nowIso(), c.req.param('id')).run(); return jsonOk(null); });
adminRoutes.get('/admin/api/v1/accounts/stats', async (c) => jsonOk({ list: (await c.env.DB.prepare('select provider,status,count(*) n from accounts group by provider,status').all()).results }));
adminRoutes.get('/admin/api/v1/keys', async (c) => jsonOk({ list: (await c.env.DB.prepare('select k.id,k.user_id,u.email,k.name,k.prefix,k.last4,k.status,k.scopes,k.rpm_limit,k.daily_quota,k.expire_at,k.last_used_at,k.created_at from api_keys k left join users u on u.id=k.user_id order by k.created_at desc limit 200').all()).results }));
adminRoutes.post('/admin/api/v1/keys', async (c) => {
  const { user_id, name, scopes } = await c.req.json().catch(() => ({}));
  if (!user_id) return jsonErr('user_id required');
  const raw = `sk-g2cf-${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '')}`;
  const recId = id('key');
  await c.env.DB.prepare('insert into api_keys(id,user_id,key_hash,name,status,scopes,prefix,last4,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?)')
    .bind(recId, user_id, await sha256Hex(raw), name || 'admin-created', 'active', scopes || 'chat,image,images,video', raw.slice(0, 10), raw.slice(-4), nowIso(), nowIso()).run();
  return jsonOk({ id: recId, plain: raw, prefix: raw.slice(0, 10), last4: raw.slice(-4) });
});
adminRoutes.get('/admin/api/v1/logs/generations', async (c) => jsonOk({ list: (await c.env.DB.prepare('select * from api_call_records order by created_at desc limit 200').all()).results }));
adminRoutes.get('/admin/api/v1/system/settings', async (c) => jsonOk({ list: (await c.env.DB.prepare('select key,value,description,updated_at from system_configs order by key').all()).results }));
adminRoutes.put('/admin/api/v1/system/settings', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  for (const [key, value] of Object.entries(body)) {
    await c.env.DB.prepare('insert into system_configs(key,value,updated_at) values(?,?,?) on conflict(key) do update set value=excluded.value,updated_at=excluded.updated_at').bind(key, String(value ?? ''), nowIso()).run();
  }
  return jsonOk(null);
});
