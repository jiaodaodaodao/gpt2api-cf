import type { AccountRecord, Env, Provider } from '../types';
import { decryptText, encryptText, sha256Hex } from '../lib/crypto';
import { getNum } from '../lib/http';
import { markAccountResult, nowIso, recordAccountHealth, selectHealthyAccount } from './db';

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
function readSetCookies(headers: Headers) {
  const anyHeaders = headers as Headers & { getSetCookie?: () => string[] };
  const multi = anyHeaders.getSetCookie?.() || [];
  const single = headers.get('set-cookie');
  return single ? [...multi, single] : multi;
}
function cookiePair(setCookie: string) {
  return setCookie.split(';', 1)[0]?.trim() || '';
}
function mergeCookies(current: string, setCookies: string[]) {
  const jar = new Map<string, string>();
  const add = (pair: string) => {
    const idx = pair.indexOf('=');
    if (idx <= 0) return;
    jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  };
  current.split(';').map((p) => p.trim()).filter(Boolean).forEach(add);
  setCookies.map(cookiePair).filter(Boolean).forEach(add);
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
function buildGrokCookie(credential: string) {
  const cred = credential.trim();
  if (!cred) return '';
  if (cred.includes('=')) {
    if (cred.includes('sso=') && !cred.includes('sso-rw=')) {
      const token = cred.split(';').map((p) => p.trim()).find((p) => p.startsWith('sso='))?.slice(4);
      return token ? `${cred.replace(/[;\s]+$/, '')}; sso-rw=${token}` : cred;
    }
    return cred;
  }
  return `sso=${cred}; sso-rw=${cred}`;
}
function commonBrowserHeaders(base: string) {
  return {
    'Accept': '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.6',
    'Cache-Control': 'no-cache',
    'Origin': base,
    'Pragma': 'no-cache',
    'Referer': `${base}/`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
    'Sec-Ch-Ua': '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"',
    'Sec-Ch-Ua-Arch': '"x86"',
    'Sec-Ch-Ua-Bitness': '"64"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Model': '""',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
  };
}
function safeJsonObject(raw?: string | null) {
  if (!raw) return {} as Record<string, any>;
  try { return JSON.parse(raw) as Record<string, any>; } catch { return {} as Record<string, any>; }
}
function applyProviderHeaders(headers: Headers, provider: Provider, base: string, path: string, accountId: string) {
  const browser = commonBrowserHeaders(base);
  for (const [key, value] of Object.entries(browser)) headers.set(key, value);
  headers.set('Priority', 'u=1, i');
  if (provider === 'grok') {
    headers.set('Baggage', 'sentry-environment=production,sentry-public_key=b311e0f2690c81f25e2c4cf6d4f7ce1c');
    headers.set('X-Statsig-ID', 'YXV0aGVudGljYXRlZA==');
    headers.set('X-XAI-Request-ID', crypto.randomUUID());
    return;
  }
  headers.set('Oai-Language', 'zh-CN');
  headers.set('Oai-Client-Version', 'prod-81e0c5cdf6140e8c5db714d613337f4aeab94029');
  headers.set('Oai-Client-Build-Number', '6128297');
  headers.set('Oai-Device-Id', `cf-${accountId.slice(-16)}`);
  headers.set('X-Openai-Target-Path', path);
  headers.set('X-Openai-Target-Route', path);
}
async function saveAccountSecret(env: Env, accountId: string, field: 'cookie_encrypted' | 'access_token_encrypted' | 'refresh_token_encrypted', plain: string) {
  await env.DB.prepare(`update accounts set ${field}=?, updated_at=? where id=?`).bind(await encryptText(plain, env.ENCRYPTION_KEY), nowIso(), accountId).run();
}
function jwtExpMs(token: string) {
  const part = token.split('.')[1];
  if (!part) return 0;
  try {
    const padded = part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (part.length % 4)) % 4);
    const json = JSON.parse(atob(padded));
    return Number(json.exp || 0) * 1000;
  } catch { return 0; }
}
function tokenNeedsRefresh(account: AccountRecord, token: string) {
  const explicit = account.access_token_expires_at ? Date.parse(account.access_token_expires_at) : 0;
  const exp = explicit || jwtExpMs(token);
  return !token || !exp || exp < Date.now() + 10 * 60_000;
}
async function refreshGptOAuthToken(env: Env, account: AccountRecord, refreshToken: string) {
  const clientId = safeJsonObject(account.oauth_meta).client_id || env.OPENAI_OAUTH_CLIENT_ID || '';
  if (!clientId) throw new Error('GPT OAuth refresh requires client_id or OPENAI_OAUTH_CLIENT_ID');
  const form = new URLSearchParams();
  form.set('grant_type', 'refresh_token');
  form.set('refresh_token', refreshToken);
  form.set('client_id', clientId);
  form.set('scope', 'openid profile email');
  const tokenUrl = env.OPENAI_OAUTH_TOKEN_URL || 'https://auth.openai.com/oauth/token';
  const res = await boundedFetch(tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json', 'User-Agent': 'codex-cli/0.91.0' }, body: form }, 30000);
  const text = await res.text();
  if (!res.ok) throw new Error(`GPT OAuth refresh failed: ${res.status} ${text.slice(0, 200)}`);
  const data = JSON.parse(text) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; id_token?: string };
  if (!data.access_token) throw new Error('GPT OAuth refresh response missing access_token');
  const expiresAt = new Date(Date.now() + Number(data.expires_in || 3600) * 1000).toISOString();
  await env.DB.prepare('update accounts set access_token_encrypted=?, refresh_token_encrypted=coalesce(?,refresh_token_encrypted), access_token_expires_at=?, last_refresh_at=?, oauth_meta=?, updated_at=? where id=?')
    .bind(await encryptText(data.access_token, env.ENCRYPTION_KEY), data.refresh_token ? await encryptText(data.refresh_token, env.ENCRYPTION_KEY) : null, expiresAt, nowIso(), JSON.stringify({ ...safeJsonObject(account.oauth_meta), client_id: clientId, scope: data.scope || '', id_token_present: !!data.id_token, updated: Math.floor(Date.now() / 1000) }), nowIso(), account.id).run();
  return data.access_token;
}
async function bootstrapProviderSession(env: Env, account: AccountRecord, provider: Provider, cookie: string) {
  const base = upstreamBase(env, provider, account);
  const headers = new Headers(commonBrowserHeaders(base));
  headers.set('Cookie', provider === 'grok' ? buildGrokCookie(cookie) : cookie);
  if (provider === 'grok') {
    headers.set('Content-Type', 'application/json');
    headers.set('X-Statsig-ID', 'YXV0aGVudGljYXRlZA==');
    headers.set('X-XAI-Request-ID', crypto.randomUUID());
    const res = await boundedFetch(`${base}/rest/rate-limits`, { method: 'POST', headers, body: JSON.stringify({ modelName: 'grok-3' }) }, 15000);
    const merged = mergeCookies(headers.get('Cookie') || '', readSetCookies(res.headers));
    if (merged && merged !== cookie) await saveAccountSecret(env, account.id, 'cookie_encrypted', merged);
    if (res.status === 401 || res.status === 403) throw new Error(`Grok cookie login failed: ${res.status}`);
    return { cookie: merged || cookie, token: '' };
  }
  const res = await boundedFetch(`${base}/`, { method: 'GET', headers }, 15000);
  const merged = mergeCookies(cookie, readSetCookies(res.headers));
  if (merged && merged !== cookie) await saveAccountSecret(env, account.id, 'cookie_encrypted', merged);
  return { cookie: merged || cookie, token: '' };
}
async function prepareAccountAuth(env: Env, account: AccountRecord, provider: Provider) {
  let cookie = account.cookie_encrypted ? await decryptText(account.cookie_encrypted, env.ENCRYPTION_KEY) : '';
  let token = account.access_token_encrypted ? await decryptText(account.access_token_encrypted, env.ENCRYPTION_KEY) : '';
  const refreshToken = account.refresh_token_encrypted ? await decryptText(account.refresh_token_encrypted, env.ENCRYPTION_KEY) : '';
  if (provider === 'gpt' && refreshToken && tokenNeedsRefresh(account, token)) token = await refreshGptOAuthToken(env, account, refreshToken);
  if (cookie || provider === 'grok') {
    const session = await bootstrapProviderSession(env, account, provider, cookie || token);
    cookie = session.cookie || cookie;
  }
  return { cookie, token };
}
function cloneHeaders(request: Request, provider: Provider, base: string, path: string, accountId: string, cookie: string, token: string, proxyUrl: string) {
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('content-length');
  applyProviderHeaders(headers, provider, base, path, accountId);
  if (cookie) headers.set('cookie', provider === 'grok' ? buildGrokCookie(cookie) : cookie);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (proxyUrl) headers.set('x-gpt2api-proxy', proxyUrl);
  headers.set('x-gpt2api-worker', 'cloudflare-native');
  return headers;
}

export async function forwardOpenAIRequest(env: Env, request: Request, provider: Provider) {
  const account = await selectHealthyAccount(env, provider);
  if (!account) throw new Error(`no healthy ${provider} account available`);
  const { cookie, token } = await prepareAccountAuth(env, account, provider);
  const incoming = new URL(request.url);
  const base = upstreamBase(env, provider, account);
  const path = upstreamPath(env, incoming.pathname);
  const target = new URL(`${base}${path}${incoming.search}`);
  const started = Date.now();
  try {
    const proxyUrl = account.proxy_url || env.GLOBAL_PROXY_URL || '';
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.clone().arrayBuffer();
    const headers = cloneHeaders(request, provider, base, path, account.id, cookie, token, proxyUrl);
    let res = await boundedFetch(target, { method: request.method, headers, body, redirect: 'manual' }, getNum(env.UPSTREAM_TIMEOUT_MS, 110000));
    if ((res.status === 401 || res.status === 403) && (cookie || provider === 'grok')) {
      const refreshed = await bootstrapProviderSession(env, account, provider, cookie || token).catch(() => null);
      if (refreshed?.cookie) headers.set('cookie', provider === 'grok' ? buildGrokCookie(refreshed.cookie) : refreshed.cookie);
      res = await boundedFetch(target, { method: request.method, headers, body, redirect: 'manual' }, getNum(env.UPSTREAM_TIMEOUT_MS, 110000));
    }
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
      const cookie = account.cookie_encrypted ? await decryptText(account.cookie_encrypted, env.ENCRYPTION_KEY) : '';
      await bootstrapProviderSession(env, account, account.provider, cookie);
      await recordAccountHealth(env, account.id, 'healthy', 'cookie/session ok');
    } catch (e) {
      await recordAccountHealth(env, account.id, 'down', e instanceof Error ? e.message : String(e));
    }
  }));
}

function extensionForContentType(contentType: string, fallback: string) {
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('webp')) return 'webp';
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'jpg';
  if (contentType.includes('gif')) return 'gif';
  if (contentType.includes('mp4')) return 'mp4';
  if (contentType.includes('mpegurl')) return 'm3u8';
  return fallback;
}
function publicR2Url(env: Env, key: string) {
  const base = env.R2_PUBLIC_BASE_URL?.replace(/\/$/, '');
  return base ? `${base}/${key}` : `/cf-media/${key}`;
}
async function putR2(env: Env, key: string, bytes: ArrayBuffer, contentType: string) {
  if (!env.MEDIA_BUCKET) return '';
  await env.MEDIA_BUCKET.put(key, bytes, { httpMetadata: { contentType }, customMetadata: { cached_at: nowIso() } });
  return publicR2Url(env, key);
}
async function downloadAndStore(env: Env, kind: 'image' | 'video', url: string) {
  const res = await boundedFetch(url, { method: 'GET' }, 60000);
  if (!res.ok) return url;
  const contentType = res.headers.get('content-type') || (kind === 'video' ? 'video/mp4' : 'image/png');
  const bytes = await res.arrayBuffer();
  const hash = await sha256Hex(`${url}:${bytes.byteLength}:${Date.now()}`);
  const key = `${kind}/${hash}.${extensionForContentType(contentType, kind === 'video' ? 'mp4' : 'png')}`;
  return await putR2(env, key, bytes, contentType) || url;
}
async function b64ToR2(env: Env, kind: 'image' | 'video', b64: string) {
  const clean = b64.includes(',') ? b64.split(',').pop() || '' : b64;
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  const hash = await sha256Hex(`${clean.slice(0, 256)}:${clean.length}`);
  const contentType = kind === 'video' ? 'video/mp4' : 'image/png';
  const key = `${kind}/${hash}.${kind === 'video' ? 'mp4' : 'png'}`;
  return putR2(env, key, bytes.buffer, contentType);
}
export async function persistGenerationAssets(env: Env, kind: 'image' | 'video', payload: any) {
  const cloned = JSON.parse(JSON.stringify(payload));
  const saved: string[] = [];
  const items = Array.isArray(cloned?.data) ? cloned.data : Array.isArray(cloned?.output) ? cloned.output : [];
  for (const item of items) {
    if (item?.url && /^https?:\/\//i.test(item.url)) {
      const stored = await downloadAndStore(env, kind, item.url).catch(() => item.url);
      if (stored !== item.url) { item.original_url = item.url; item.url = stored; saved.push(stored); }
    } else if (item?.b64_json) {
      const stored = await b64ToR2(env, kind, item.b64_json).catch(() => '');
      if (stored) { item.url = stored; delete item.b64_json; saved.push(stored); }
    }
  }
  return { payload: cloned, r2Urls: saved };
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
