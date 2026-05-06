import type { AccountRecord, Env, Provider } from '../types';
import { decryptText, sha256Hex } from '../lib/crypto';
import { getNum } from '../lib/http';
import { markAccountResult, recordAccountHealth, selectHealthyAccount } from './db';

export function providerForModel(model = ''): Provider {
  return /grok|vid|video/i.test(model) ? 'grok' : 'gpt';
}
function upstreamBase(env: Env, provider: Provider, account?: AccountRecord) {
  const raw = account?.upstream_base_url || (provider === 'grok' ? env.GROK_UPSTREAM_BASE : env.GPT_UPSTREAM_BASE) || 'https://api.openai.com';
  return raw.replace(/\/$/, '');
}
function upstreamPath(env: Env, path: string) {
  const prefix = (env.UPSTREAM_OPENAI_COMPAT_PATH || '/v1').replace(/\/$/, '');
  const normalized = path.endsWith('/videos/generations') ? '/video/generations' : path.replace(/^\/v1/, '');
  return `${prefix}${normalized.startsWith('/') ? normalized : `/${normalized}`}`;
}
async function boundedFetch(input: RequestInfo | URL, init: RequestInit, timeoutMs: number) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort('upstream timeout'), timeoutMs);
  try { return await fetch(input, { ...init, signal: ac.signal }); } finally { clearTimeout(t); }
}
function cloneHeaders(request: Request, cookie: string, token: string, proxyUrl: string) {
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('content-length');
  headers.set('cookie', cookie);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (proxyUrl) headers.set('x-gpt2api-proxy', proxyUrl);
  headers.set('x-gpt2api-worker', 'cloudflare-native');
  return headers;
}

export async function forwardOpenAIRequest(env: Env, request: Request, provider: Provider) {
  const account = await selectHealthyAccount(env, provider);
  if (!account) throw new Error(`no healthy ${provider} account available`);
  const cookie = await decryptText(account.cookie_encrypted, env.ENCRYPTION_KEY);
  const token = account.access_token_encrypted ? await decryptText(account.access_token_encrypted, env.ENCRYPTION_KEY) : '';
  const incoming = new URL(request.url);
  const target = new URL(`${upstreamBase(env, provider, account)}${upstreamPath(env, incoming.pathname)}${incoming.search}`);
  const started = Date.now();
  try {
    const proxyUrl = account.proxy_url || env.GLOBAL_PROXY_URL || '';
    const res = await boundedFetch(target, { method: request.method, headers: cloneHeaders(request, cookie, token, proxyUrl), body: request.body, redirect: 'manual' }, getNum(env.UPSTREAM_TIMEOUT_MS, 110000));
    await markAccountResult(env, account.id, res.ok);
    return { response: res, accountId: account.id, provider, latencyMs: Date.now() - started };
  } catch (e) {
    await markAccountResult(env, account.id, false, e instanceof Error ? e.message : String(e));
    throw e;
  }
}

export async function healthCheckAccounts(env: Env) {
  const rows = await env.DB.prepare("select * from accounts where status in ('active','cooldown') limit 50").all<AccountRecord>();
  await Promise.all(rows.results.map(async (account) => {
    try {
      const base = upstreamBase(env, account.provider, account);
      const res = await boundedFetch(`${base}/`, { method: 'HEAD' }, 8000);
      await recordAccountHealth(env, account.id, res.status < 500 ? 'healthy' : 'degraded', `status=${res.status}`);
    } catch (e) {
      await recordAccountHealth(env, account.id, 'down', e instanceof Error ? e.message : String(e));
    }
  }));
}

export async function cacheGeneration(env: Env, kind: 'image' | 'video', payload: unknown, bytes?: ArrayBuffer) {
  const ttl = getNum(env.CACHE_TTL_SECONDS, 86400);
  const max = getNum(env.MAX_KV_CACHE_BYTES, 20_000_000);
  const key = `${kind}:${await sha256Hex(JSON.stringify(payload))}`;
  if (bytes && bytes.byteLength <= max) {
    await env.CACHE.put(key, bytes, { expirationTtl: ttl, metadata: { kind, size: bytes.byteLength } });
  } else {
    await env.CACHE.put(key, JSON.stringify({ payload, cached_at: new Date().toISOString(), external: !bytes }), { expirationTtl: ttl });
  }
  return key;
}
