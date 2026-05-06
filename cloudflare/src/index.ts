import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env, AppVariables } from './types';
import { jsonErr } from './lib/http';
import { requestId, securityHeaders } from './lib/http';
import { rateLimit } from './lib/rate-limit';
import { authRoutes } from './routes/auth';
import { openaiRoutes } from './routes/openai';
import { adminRoutes } from './routes/admin';
import { userRoutes } from './routes/user';
import { nowIso } from './services/db';

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

function allowedOrigins(raw = '*') { return raw.split(',').map((s) => s.trim()).filter(Boolean); }
app.use('*', requestId, securityHeaders);
app.use('/api/*', cors({ origin: (origin: string, c: any) => allowedOrigins(c.env.CORS_ALLOW_ORIGINS || '*').includes('*') ? origin : (allowedOrigins(c.env.CORS_ALLOW_ORIGINS).includes(origin) ? origin : ''), credentials: true }));
app.use('/admin/api/*', cors({ origin: (origin: string, c: any) => allowedOrigins(c.env.CORS_ALLOW_ORIGINS || '*').includes('*') ? origin : (allowedOrigins(c.env.CORS_ALLOW_ORIGINS).includes(origin) ? origin : ''), credentials: true }));
app.use('/v1/*', cors({ origin: '*', allowHeaders: ['Authorization', 'Content-Type', 'X-API-Key'], allowMethods: ['GET', 'POST', 'OPTIONS'] }));
app.use('/v1/*', rateLimit('api'));
app.use('/admin/api/*', rateLimit('admin'));

app.get('/health', (c) => c.json({ ok: true, service: c.env.APP_NAME || 'gpt2api-cf', native: true, build_sha: c.env.BUILD_SHA || 'dev' }));
app.get('/healthz', (c) => c.json({ ok: true }));
app.route('/api', authRoutes);
app.route('/', userRoutes);
app.route('/', adminRoutes);
app.route('/', openaiRoutes);

app.notFound(async (c) => {
  if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/admin/api/') || c.req.path.startsWith('/v1/')) return jsonErr('not found', 404, 'not_found');
  return c.env.ASSETS.fetch(c.req.raw);
});
app.onError((err, c) => {
  console.error(err);
  if (c.req.path.startsWith('/v1/')) return c.json({ error: { message: err.message, type: 'server_error' } }, 500);
  return jsonErr(err.message || 'internal error', 500, 'internal_error');
});

async function scheduled(env: Env) {
  const cutoff = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
  await env.DB.batch([
    env.DB.prepare('update accounts set status="active", circuit_until=null, updated_at=? where status="cooldown" and circuit_until < ?').bind(nowIso(), nowIso()),
    env.DB.prepare('delete from request_logs where created_at < ?').bind(cutoff),
    env.DB.prepare('delete from billing_records where created_at < ? and kind="debug"').bind(cutoff),
  ]);
  await env.CACHE.put('cron:last_health_check', nowIso(), { expirationTtl: 172800 });
}

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) { await scheduled(env); },
};
