import type { Env, Provider } from '../types';
import { decryptText, sha256Hex } from '../lib/crypto';
import { getNum } from '../lib/http';
import { markAccountResult, selectHealthyAccount } from './db';

export function providerForModel(model = ''): Provider {
  return /grok/i.test(model) ? 'grok' : 'gpt';
}
function upstreamBase(env: Env, provider: Provider) {
  return provider === 'grok' ? env.GROK_UPSTREAM_BASE || 'https://grok.com' : env.GPT_UPSTREAM_BASE || 'https://chatgpt.com';
}
async function boundedFetch(input: RequestInfo | URL, init: RequestInit, timeoutMs: number) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort('upstream timeout'), timeoutMs);
  try { return await fetch(input, { ...init, signal: ac.signal }); } finally { clearTimeout(t); }
}

export async function callModel(env: Env, provider: Provider, body: any, path: 'chat' | 'images' | 'video') {
  const account = await selectHealthyAccount(env, provider);
  if (!account) throw new Error(`no healthy ${provider} account available`);
  const cookie = await decryptText(account.cookie_encrypted, env.ENCRYPTION_KEY);
  const token = account.access_token_encrypted ? await decryptText(account.access_token_encrypted, env.ENCRYPTION_KEY) : '';
  const endpoint = new URL(`/cf-native/${path}`, upstreamBase(env, provider));
  const headers = new Headers({ 'Content-Type': 'application/json', Cookie: cookie, 'User-Agent': 'gpt2api-cf-worker/1.0' });
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (account.proxy_url || env.GLOBAL_PROXY_URL) headers.set('X-GPT2API-Proxy', account.proxy_url || env.GLOBAL_PROXY_URL || '');

  // Cloudflare Workers 不能直接创建 TCP CONNECT 代理；这里保留账号级/全局代理配置语义，供上游兼容网关识别。
  // 若 GPT/Grok Web 协议变化导致直连失败，响应会回退为 OpenAI 兼容错误，并触发账号熔断。
  const res = await boundedFetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) }, getNum(env.UPSTREAM_TIMEOUT_MS, 110000));
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    await markAccountResult(env, account.id, false, text || res.statusText);
    throw new Error(`${provider} upstream failed: ${res.status} ${text.slice(0, 300)}`);
  }
  await markAccountResult(env, account.id, true);
  const data = await res.json().catch(() => null);
  return { data, accountId: account.id, provider };
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
