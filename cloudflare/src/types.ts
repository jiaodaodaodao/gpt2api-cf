export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ASSETS: Fetcher;
  MEDIA_BUCKET?: R2Bucket;
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
  UPSTREAM_RETRY_MAX?: string;
  GLOBAL_PROXY_URL?: string;
  GPT_UPSTREAM_BASE?: string;
  GROK_UPSTREAM_BASE?: string;
  R2_PUBLIC_BASE_URL?: string;
  OPENAI_OAUTH_CLIENT_ID?: string;
  OPENAI_OAUTH_TOKEN_URL?: string;
  UPSTREAM_OPENAI_COMPAT_PATH?: string;
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
  refresh_token_encrypted?: string | null;
  access_token_expires_at?: string | null;
  last_refresh_at?: string | null;
  oauth_meta?: string | null;
  proxy_url: string | null;
  weight: number;
  status: AccountStatus;
  fail_count: number;
  circuit_until: string | null;
  last_used_at: string | null;
  upstream_base_url?: string | null;
}

export interface ApiKeyRecord {
  id: string;
  user_id: string;
  key_hash: string;
  name: string;
  status: string;
  scopes: string;
  prefix?: string | null;
  last4?: string | null;
  rpm_limit?: number | null;
  daily_quota?: number | null;
  expire_at?: string | null;
  last_used_at?: string | null;
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
