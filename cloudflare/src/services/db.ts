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
  return env.DB.prepare('select * from api_keys where key_hash=? and status="active" limit 1').bind(hash).first<ApiKeyRecord>();
}
export async function createApiKey(env: Env, userId: string, name = 'default', scopes = 'chat,images,video') {
  const raw = `sk-g2cf-${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '')}`;
  const recId = id('key');
  await env.DB.prepare('insert into api_keys(id,user_id,key_hash,name,status,scopes,created_at,updated_at) values(?,?,?,?,?,?,?,?)')
    .bind(recId, userId, await sha256Hex(raw), name, 'active', scopes, nowIso(), nowIso()).run();
  return { id: recId, key: raw };
}
export async function selectHealthyAccount(env: Env, provider: 'gpt' | 'grok') {
  const rows = await env.DB.prepare(`select * from accounts where provider=? and status='active' and (circuit_until is null or circuit_until < ?) order by last_used_at asc nulls first, weight desc limit 1`)
    .bind(provider, nowIso()).all<AccountRecord>();
  const account = rows.results[0];
  if (account) await env.DB.prepare('update accounts set last_used_at=?, updated_at=? where id=?').bind(nowIso(), nowIso(), account.id).run();
  return account;
}
export async function markAccountResult(env: Env, accountId: string, ok: boolean, error?: string) {
  if (ok) {
    await env.DB.prepare('update accounts set fail_count=0, status="active", circuit_until=null, last_error=null, updated_at=? where id=?').bind(nowIso(), accountId).run();
    return;
  }
  const account = await env.DB.prepare('select fail_count from accounts where id=?').bind(accountId).first<{ fail_count: number }>();
  const fail = (account?.fail_count || 0) + 1;
  const status = fail >= 5 ? 'cooldown' : 'active';
  const until = fail >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null;
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
export async function logRequest(env: Env, row: { requestId: string; userId?: string; apiKeyId?: string; path: string; status: number; provider?: string; accountId?: string; cost?: number; error?: string }) {
  await env.DB.prepare('insert into request_logs(id,request_id,user_id,api_key_id,path,status,provider,account_id,cost,error,created_at) values(?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id('log'), row.requestId, row.userId || null, row.apiKeyId || null, row.path, row.status, row.provider || null, row.accountId || null, row.cost || 0, row.error || null, nowIso()).run();
}
