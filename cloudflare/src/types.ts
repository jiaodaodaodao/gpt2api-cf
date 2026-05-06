export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ASSETS: Fetcher;
  APP_NAME: string;
  BUILD_SHA?: string;
  CORS_ALLOW_ORIGINS?: string;
  JWT_SECRET: string;
  JWT_ISSUER?: string;
  JWT_TTL_SECONDS?: string;
  API_RATE_LIMIT_PER_MINUTE?: string;
  ADMIN_RATE_LIMIT_PER_MINUTE?: string;
  DEFAULT_USER_CREDITS?: string;
  CHAT_DEFAULT_COST?: string;
  IMAGE_DEFAULT_COST?: string;
  VIDEO_DEFAULT_COST?: string;
  CACHE_TTL_SECONDS?: string;
  MAX_KV_CACHE_BYTES?: string;
  UPSTREAM_TIMEOUT_MS?: string;
  GLOBAL_PROXY_URL?: string;
  GPT_UPSTREAM_BASE?: string;
  GROK_UPSTREAM_BASE?: string;
  ENCRYPTION_KEY: string;
}

export type Provider = 'gpt' | 'grok';
export type AccountStatus = 'active' | 'cooldown' | 'disabled' | 'dead';
export interface AccountRecord {
  id: string;
  provider: Provider;
  label: string;
  cookie_encrypted: string;
  access_token_encrypted: string | null;
  proxy_url: string | null;
  weight: number;
  status: AccountStatus;
  fail_count: number;
  circuit_until: string | null;
  last_used_at: string | null;
}
export interface ApiKeyRecord {
  id: string;
  user_id: string;
  key_hash: string;
  name: string;
  status: string;
  scopes: string;
}
export interface UserRecord {
  id: string;
  email: string;
  role: 'user' | 'admin';
  status: string;
  credits: number;
}
export interface JwtPayload {
  sub: string;
  role: 'user' | 'admin';
  exp: number;
  iss: string;
}
export type AppVariables = {
  user?: UserRecord;
  apiKey?: ApiKeyRecord;
  requestId: string;
};
