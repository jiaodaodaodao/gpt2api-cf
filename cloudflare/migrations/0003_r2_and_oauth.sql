alter table accounts add column refresh_token_encrypted text;
alter table accounts add column access_token_expires_at text;
alter table accounts add column last_refresh_at text;
alter table accounts add column oauth_meta text;
alter table generations add column r2_key text;
alter table generations add column r2_url text;
