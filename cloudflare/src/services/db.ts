import type { AccountRecord, ApiKeyRecord, Env, UserRecord } from '../types';
import { sha256Hex } from '../lib/crypto';

export const nowIso = () => new Date().toISOString();
export const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;

export async function getUserByEmail(env: Env, email: string) {
  return env.DB.prepare('select * from users where lower(email)=lower(?) limit 1').bind(email).first<UserRecord>();
}
export async function getUserById(env: Env, userId: string) {
  return env.DB.prepare('select * from users where id=? limit 1').bind(userId).first<UserRecord>();
}
export async function createUser(env: Env, email: string, passwordHash: string, role: 'user' | 'admin' = 'user') {
  const userId = id('usr');
  const credits = Number(env.DEFAULT_USER_CREDITS || 100);
  await env.DB.prepare('insert into users(id,email,password_hash,role,status,credits,created_at,updated_at) values(?,?,?,?,?,?,?,?)')
    .bind(userId, email, passwordHash, role, 'active', credits, nowIso(), nowIso()).run();
  return getUserById(env, userId);
}
export async function getApiKey(env: Env, raw: string) {
  const hash = await sha256Hex(raw);
  const key = await env.DB.prepare('select * from api_keys where key_hash=? and status="active" and (expire_at is null or expire_at > ?) limit 1')
    .bind(hash, nowIso()).first<ApiKeyRecord>();
  if (key) await env.DB.prepare('update api_keys set last_used_at=?, updated_at=? where id=?').bind(nowIso(), nowIso(), key.id).run();
  return key;
}
export async function createApiKey(env: Env, userId: string, name = 'default', scopes = 'chat,image,images,video', rpmLimit = 0, dailyQuota = 0, expireDays = 0) {
  const raw = `sk-g2cf-${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '')}`;
  const recId = id('key');
  const expireAt = expireDays > 0 ? new Date(Date.now() + expireDays * 86400_000).toISOString() : null;
  await env.DB.prepare('insert into api_keys(id,user_id,key_hash,name,status,scopes,prefix,last4,rpm_limit,daily_quota,expire_at,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(recId, userId, await sha256Hex(raw), name, 'active', scopes, raw.slice(0, 10), raw.slice(-4), rpmLimit, dailyQuota, expireAt, nowIso(), nowIso()).run();
  return { id: recId, key: raw, plain: raw, prefix: raw.slice(0, 10), last4: raw.slice(-4), scope: scopes, created_at: Math.floor(Date.now() / 1000) };
}
export async function listApiKeys(env: Env, userId: string) {
  const rows = await env.DB.prepare('select id,name,prefix,last4,scopes as scope,rpm_limit,daily_quota,status,expire_at,last_used_at,created_at from api_keys where user_id=? order by created_at desc')
    .bind(userId).all<Record<string, unknown>>();
  return rows.results.map((k) => ({ ...k, mask: `${k.prefix || 'sk-***'}...${k.last4 || '****'}` }));
}
export async function setApiKeyEnabled(env: Env, userId: string, keyId: string, enabled: boolean) {
  await env.DB.prepare('update api_keys set status=?, updated_at=? where id=? and user_id=?').bind(enabled ? 'active' : 'disabled', nowIso(), keyId, userId).run();
}
export async function deleteApiKey(env: Env, userId: string, keyId: string) {
  await env.DB.prepare('update api_keys set status="deleted", updated_at=? where id=? and user_id=?').bind(nowIso(), keyId, userId).run();
}

export async function selectHealthyAccount(env: Env, provider: 'gpt' | 'grok') {
  const rows = await env.DB.prepare(`select * from accounts where provider=? and status='active' and (circuit_until is null or circuit_until < ?) order by last_used_at asc nulls first, weight desc limit 20`)
    .bind(provider, nowIso()).all<AccountRecord>();
  for (const account of rows.results) {
    const health = await env.CACHE.get(`account_health:${account.id}`);
    if (!health || JSON.parse(health).status !== 'down') {
      await env.DB.prepare('update accounts set last_used_at=?, updated_at=? where id=?').bind(nowIso(), nowIso(), account.id).run();
      return account;
    }
  }
  return null;
}
export async function recordAccountHealth(env: Env, accountId: string, status: 'healthy' | 'degraded' | 'down', message = '') {
  await env.CACHE.put(`account_health:${accountId}`, JSON.stringify({ status, message: message.slice(0, 300), checked_at: nowIso() }), { expirationTtl: 3600 });
}
export async function markAccountResult(env: Env, accountId: string, ok: boolean, error?: string) {
  if (ok) {
    await recordAccountHealth(env, accountId, 'healthy');
    await env.DB.prepare('update accounts set fail_count=0, status="active", circuit_until=null, last_error=null, updated_at=? where id=?').bind(nowIso(), accountId).run();
    return;
  }
  const account = await env.DB.prepare('select fail_count from accounts where id=?').bind(accountId).first<{ fail_count: number }>();
  const fail = (account?.fail_count || 0) + 1;
  const status = fail >= 5 ? 'cooldown' : 'active';
  const until = fail >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null;
  await recordAccountHealth(env, accountId, fail >= 5 ? 'down' : 'degraded', error || 'upstream error');
  await env.DB.prepare('update accounts set fail_count=?, status=?, circuit_until=?, last_error=?, updated_at=? where id=?')
    .bind(fail, status, until, error?.slice(0, 500) || null, nowIso(), accountId).run();
}
export async function charge(env: Env, userId: string, amount: number, kind: string, requestId: string, meta: unknown) {
  const result = await env.DB.prepare('update users set credits=credits-?, updated_at=? where id=? and credits>=?')
    .bind(amount, nowIso(), userId, amount).run();
  if (!result.meta.changes) return false;
  await env.DB.prepare('insert into billing_records(id,user_id,amount,kind,request_id,metadata,created_at) values(?,?,?,?,?,?,?)')
    .bind(id('bill'), userId, -amount, kind, requestId, JSON.stringify(meta), nowIso()).run();
  return true;
}
export async function recordGeneration(env: Env, row: { id?: string; userId: string; provider: string; kind: string; prompt?: string; status?: string; resultUrl?: string; r2Url?: string; r2Key?: string; cacheKey?: string; metadata?: unknown }) {
  const recId = row.id || id('gen');
  await env.DB.prepare('insert into generations(id,user_id,provider,kind,prompt,status,result_url,r2_key,r2_url,cache_key,metadata,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(recId, row.userId, row.provider, row.kind, row.prompt || null, row.status || 'succeeded', row.resultUrl || row.r2Url || null, row.r2Key || null, row.r2Url || null, row.cacheKey || null, row.metadata ? JSON.stringify(row.metadata).slice(0, 20000) : null, nowIso(), nowIso()).run();
  return recId;
}

export async function logRequest(env: Env, row: { requestId: string; userId?: string; apiKeyId?: string; path: string; status: number; provider?: string; accountId?: string; cost?: number; error?: string }) {
  await env.DB.prepare('insert into request_logs(id,request_id,user_id,api_key_id,path,status,provider,account_id,cost,error,created_at) values(?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id('log'), row.requestId, row.userId || null, row.apiKeyId || null, row.path, row.status, row.provider || null, row.accountId || null, row.cost || 0, row.error || null, nowIso()).run();
}
export async function logApiCall(env: Env, row: { requestId: string; userId: string; apiKeyId: string; method: string; path: string; model?: string; provider?: string; accountId?: string; status: number; cost?: number; latencyMs?: number; error?: string; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }) {
  await env.DB.prepare('insert into api_call_records(id,request_id,user_id,api_key_id,method,path,model,provider,account_id,status,cost,prompt_tokens,completion_tokens,total_tokens,latency_ms,error,created_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id('call'), row.requestId, row.userId, row.apiKeyId, row.method, row.path, row.model || null, row.provider || null, row.accountId || null, row.status, row.cost || 0, row.usage?.prompt_tokens || 0, row.usage?.completion_tokens || 0, row.usage?.total_tokens || 0, row.latencyMs || 0, row.error || null, nowIso()).run();
}
