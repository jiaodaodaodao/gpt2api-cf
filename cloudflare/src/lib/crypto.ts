const te = new TextEncoder();
const td = new TextDecoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function unb64url(s: string): Uint8Array {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
export async function sha256Hex(input: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', te.encode(input));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function hmacKey(secret: string) {
  return crypto.subtle.importKey('raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function signJwt(payload: Record<string, unknown>, secret: string): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = `${b64url(te.encode(JSON.stringify(header)))}.${b64url(te.encode(JSON.stringify(payload)))}`;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), te.encode(body));
  return `${body}.${b64url(sig)}`;
}
export async function verifyJwt<T>(token: string, secret: string): Promise<T | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const body = `${parts[0]}.${parts[1]}`;
  const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), unb64url(parts[2]) as BufferSource, te.encode(body));
  if (!ok) return null;
  const payload = JSON.parse(td.decode(unb64url(parts[1]))) as T & { exp?: number };
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}
async function aesKey(secret: string) {
  const digest = await crypto.subtle.digest('SHA-256', te.encode(secret));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encryptText(value: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), te.encode(value));
  return `${b64url(iv)}.${b64url(data)}`;
}
export async function decryptText(value: string, secret: string): Promise<string> {
  const [iv, data] = value.split('.');
  const out = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64url(iv) as BufferSource }, await aesKey(secret), unb64url(data) as BufferSource);
  return td.decode(out);
}
