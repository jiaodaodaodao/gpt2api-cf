import { Hono } from 'hono';
import type { Env, AppVariables } from '../types';
import { apiKeyAllows, authApiKey } from '../services/auth';
import { charge, logApiCall, logRequest, recordGeneration } from '../services/db';
import { forwardOpenAIRequest, persistGenerationAssets, providerForModel } from '../services/upstream';
import { getNum, openAiError } from '../lib/http';

export const openaiRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

const dockerModels = [
  { id: 'gpt-4o-mini', object: 'model', owned_by: 'kleinai', kind: 'text', endpoint: '/v1/chat/completions' },
  { id: 'gpt-image-2', object: 'model', owned_by: 'openai', kind: 'image', endpoint: '/v1/images/generations', meta: { edits: true, mode: 'responses_image_generation' } },
  { id: 'grok-imagine-video', object: 'model', owned_by: 'grok', kind: 'video', endpoint: '/v1/video/generations', meta: { modes: ['text_to_video', 'image_to_video', 'multi_image_to_video'] } },
  { id: 'vid-v1', object: 'model', owned_by: 'kleinai', kind: 'video', endpoint: '/v1/video/generations', meta: { alias_of: 'grok-imagine-video' } },
  { id: 'vid-i2v', object: 'model', owned_by: 'kleinai', kind: 'video', endpoint: '/v1/video/generations', meta: { alias_of: 'grok-imagine-video' } },
  { id: 'grok-3', object: 'model', owned_by: 'grok', kind: 'text', endpoint: '/v1/chat/completions' },
  { id: 'grok-3-mini', object: 'model', owned_by: 'grok', kind: 'text', endpoint: '/v1/chat/completions' },
];

async function parseBody(c: any) {
  const raw = await c.req.raw.clone().text();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return null; }
}
function costFor(c: any, kind: 'chat' | 'image' | 'video') {
  if (kind === 'chat') return getNum(c.env.CHAT_DEFAULT_COST, 1);
  if (kind === 'image') return getNum(c.env.IMAGE_DEFAULT_COST, 5);
  return getNum(c.env.VIDEO_DEFAULT_COST, 20);
}
async function forwardCompat(c: any, kind: 'chat' | 'image' | 'video', requiredScope: 'chat' | 'image' | 'video') {
  const body = await parseBody(c);
  if (!body) return openAiError('invalid JSON body', 400, 'invalid_request_error');
  if (!apiKeyAllows(c.get('apiKey').scopes, requiredScope)) return openAiError(`current api key does not allow ${requiredScope}`, 403, 'scope_not_allowed');
  if (kind === 'chat' && !body.messages) return openAiError('messages is required', 400, 'invalid_request_error');
  if ((kind === 'image' || kind === 'video') && !String(body.prompt || '').trim()) return openAiError('prompt is required', 400, 'invalid_request_error');
  const cost = costFor(c, kind);
  const user = c.get('user');
  const apiKey = c.get('apiKey');
  const requestId = c.get('requestId');
  if (!(await charge(c.env, user.id, cost, kind, requestId, { model: body.model, path: c.req.path }))) return openAiError('insufficient credits', 402, 'insufficient_quota');
  const provider = providerForModel(body.model || (kind === 'video' ? 'grok-imagine-video' : 'gpt-image-2'));
  const started = Date.now();
  try {
    const result = await forwardOpenAIRequest(c.env, c.req.raw, provider);
    const headers = new Headers(result.response.headers);
    headers.set('X-Request-Id', requestId);
    const contentType = headers.get('content-type') || '';
    if (!body.stream && contentType.includes('application/json')) {
      const data = await result.response.clone().json().catch(() => null) as any;
      if (data && (kind === 'image' || kind === 'video')) {
        const persisted = await persistGenerationAssets(c.env, kind, data);
        persisted.payload._cloudflare = { r2_urls: persisted.r2Urls };
        const taskId = await recordGeneration(c.env, { userId: user.id, provider, kind, prompt: body.prompt, resultUrl: persisted.r2Urls[0] || undefined, r2Url: persisted.r2Urls[0] || undefined, metadata: { model: body.model, request_id: requestId, r2_urls: persisted.r2Urls } });
        persisted.payload.id = persisted.payload.id || taskId;
        const responseBody = JSON.stringify(persisted.payload);
        headers.delete('content-encoding');
        headers.delete('transfer-encoding');
        headers.set('content-length', String(new TextEncoder().encode(responseBody).byteLength));
        await logApiCall(c.env, { requestId, userId: user.id, apiKeyId: apiKey.id, method: c.req.raw.method, path: c.req.path, model: body.model, provider, accountId: result.accountId, status: result.response.status, cost, latencyMs: result.latencyMs, usage: data?.usage });
        await logRequest(c.env, { requestId, userId: user.id, apiKeyId: apiKey.id, path: c.req.path, status: result.response.status, provider, accountId: result.accountId, cost });
        return new Response(responseBody, { status: result.response.status, statusText: result.response.statusText, headers });
      }
      await logApiCall(c.env, { requestId, userId: user.id, apiKeyId: apiKey.id, method: c.req.raw.method, path: c.req.path, model: body.model, provider, accountId: result.accountId, status: result.response.status, cost, latencyMs: result.latencyMs, usage: data?.usage });
    } else {
      await logApiCall(c.env, { requestId, userId: user.id, apiKeyId: apiKey.id, method: c.req.raw.method, path: c.req.path, model: body.model, provider, accountId: result.accountId, status: result.response.status, cost, latencyMs: result.latencyMs });
    }
    await logRequest(c.env, { requestId, userId: user.id, apiKeyId: apiKey.id, path: c.req.path, status: result.response.status, provider, accountId: result.accountId, cost });
    return new Response(result.response.body, { status: result.response.status, statusText: result.response.statusText, headers });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await logApiCall(c.env, { requestId, userId: user.id, apiKeyId: apiKey.id, method: c.req.raw.method, path: c.req.path, model: body.model, provider, status: 502, cost, latencyMs: Date.now() - started, error: message });
    await logRequest(c.env, { requestId, userId: user.id, apiKeyId: apiKey.id, path: c.req.path, status: 502, provider, cost, error: message });
    return openAiError(message, 502, 'upstream_error');
  }
}

openaiRoutes.get('/v1/health', () => Response.json({ ok: true }));
openaiRoutes.get('/v1/models', authApiKey, () => Response.json({ object: 'list', data: dockerModels }));
openaiRoutes.post('/v1/chat/completions', authApiKey, (c) => forwardCompat(c, 'chat', 'chat'));
openaiRoutes.post('/v1/images/generations', authApiKey, (c) => forwardCompat(c, 'image', 'image'));
openaiRoutes.post('/v1/images/edits', authApiKey, (c) => forwardCompat(c, 'image', 'image'));
openaiRoutes.post('/v1/video/generations', authApiKey, (c) => forwardCompat(c, 'video', 'video'));
openaiRoutes.post('/v1/videos/generations', authApiKey, (c) => forwardCompat(c, 'video', 'video'));
openaiRoutes.get('/v1/images/generations/:task_id', authApiKey, async (c) => {
  const task = await c.env.DB.prepare('select * from generations where id=?').bind(c.req.param('task_id')).first();
  return task ? Response.json(task) : openAiError('task not found', 404, 'not_found');
});
openaiRoutes.get('/v1/video/generations/:task_id', authApiKey, async (c) => {
  const task = await c.env.DB.prepare('select * from generations where id=?').bind(c.req.param('task_id')).first();
  return task ? Response.json(task) : openAiError('task not found', 404, 'not_found');
});
openaiRoutes.get('/v1/videos/generations/:task_id', authApiKey, async (c) => {
  const task = await c.env.DB.prepare('select * from generations where id=?').bind(c.req.param('task_id')).first();
  return task ? Response.json(task) : openAiError('task not found', 404, 'not_found');
});
