create table if not exists users (
  id text primary key,
  email text not null unique,
  password_hash text not null,
  role text not null default 'user' check(role in ('user','admin')),
  status text not null default 'active',
  credits integer not null default 0,
  created_at text not null,
  updated_at text not null
);
create table if not exists api_keys (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  key_hash text not null unique,
  name text not null,
  status text not null default 'active',
  scopes text not null default 'chat,images,video',
  created_at text not null,
  updated_at text not null
);
create table if not exists accounts (
  id text primary key,
  provider text not null check(provider in ('gpt','grok')),
  label text not null,
  cookie_encrypted text not null,
  access_token_encrypted text,
  proxy_url text,
  weight integer not null default 1,
  status text not null default 'active' check(status in ('active','cooldown','disabled','dead')),
  fail_count integer not null default 0,
  circuit_until text,
  last_used_at text,
  last_error text,
  created_at text not null,
  updated_at text not null
);
create index if not exists idx_accounts_provider_status on accounts(provider,status,circuit_until,last_used_at);
create table if not exists billing_records (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  amount integer not null,
  kind text not null,
  request_id text,
  metadata text,
  created_at text not null
);
create index if not exists idx_billing_user_created on billing_records(user_id,created_at desc);
create table if not exists generations (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  provider text not null,
  kind text not null,
  prompt text,
  status text not null,
  result_url text,
  cache_key text,
  metadata text,
  created_at text not null,
  updated_at text not null
);
create table if not exists proxies (
  id text primary key,
  name text not null,
  url text not null,
  status text not null default 'active',
  created_at text not null,
  updated_at text not null
);
create table if not exists system_configs (
  key text primary key,
  value text not null,
  description text,
  updated_at text not null
);
create table if not exists request_logs (
  id text primary key,
  request_id text not null,
  user_id text,
  api_key_id text,
  path text not null,
  status integer not null,
  provider text,
  account_id text,
  cost integer not null default 0,
  error text,
  created_at text not null
);
create index if not exists idx_logs_created on request_logs(created_at desc);
