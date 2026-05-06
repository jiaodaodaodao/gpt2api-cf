import { Hono } from 'hono';
import type { Env, AppVariables } from '../types';
import { authApiKey } from '../services/auth';
import { charge, logRequest } from '../services/db';
import { cacheGeneration, callModel, providerForModel } from '../services/upstream';
import { getNum } from '../lib/http';

export const openaiRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();

function openAiError(message: string, status = 500, type = 'server_error') {
  return Response.json({ error: { message, type, code: type } }, { status });
}
async function billOrFail(c: any, amount: number, kind: string, meta: unknown) {
  const user = c.get('user');
  const ok = await charge(c.env, user.id, amount, kind, c.get('requestId'), meta);
  return ok ? null : openAiError('insufficient credits', 402, 'insufficient_quota');
}

openaiRoutes.get('/v1/models', authApiKey, () => Response.json({ object: 'list', data: [
  { id: 'gpt-4o', object: 'model', owned_by: 'gpt2api-cf' },
  { id: 'gpt-4o-mini', object: 'model', owned_by: 'gpt2api-cf' },
  { id: 'grok-3', object: 'model', owned_by: 'gpt2api-cf' },
  { id: 'grok-3-mini', object: 'model', owned_by: 'gpt2api-cf' }
] }));

openaiRoutes.post('/v1/chat/completions', authApiKey, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return openAiError('invalid JSON body', 400, 'invalid_request_error');
  const cost = getNum(c.env.CHAT_DEFAULT_COST, 1);
  const bill = await billOrFail(c, cost, 'chat', { model: body.model });
  if (bill) return bill;
  const provider = providerForModel(body.model);
  try {
    const result = await callModel(c.env, provider, body, 'chat');
    const data = result.data || { id: `chatcmpl-${crypto.randomUUID()}`, object: 'chat.completion', created: Math.floor(Date.now()/1000), model: body.model || provider, choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] };
    await logRequest(c.env, { requestId: c.get('requestId'), userId: c.get('user')!.id, apiKeyId: c.get('apiKey')!.id, path: c.req.path, status: 200, provider, accountId: result.accountId, cost });
    return Response.json(data);
  } catch (e) {
    await logRequest(c.env, { requestId: c.get('requestId'), userId: c.get('user')!.id, apiKeyId: c.get('apiKey')!.id, path: c.req.path, status: 502, provider, cost, error: e instanceof Error ? e.message : String(e) });
    return openAiError(e instanceof Error ? e.message : 'upstream error', 502, 'upstream_error');
  }
});

openaiRoutes.post('/v1/images/generations', authApiKey, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return openAiError('invalid JSON body', 400, 'invalid_request_error');
  const cost = getNum(c.env.IMAGE_DEFAULT_COST, 5);
  const bill = await billOrFail(c, cost, 'image', { model: body.model, n: body.n || 1 });
  if (bill) return bill;
  const provider = providerForModel(body.model);
  try {
    const result = await callModel(c.env, provider, body, 'images');
    const data = result.data || { created: Math.floor(Date.now()/1000), data: [] };
    await cacheGeneration(c.env, 'image', data);
    await logRequest(c.env, { requestId: c.get('requestId'), userId: c.get('user')!.id, apiKeyId: c.get('apiKey')!.id, path: c.req.path, status: 200, provider, accountId: result.accountId, cost });
    return Response.json(data);
  } catch (e) { return openAiError(e instanceof Error ? e.message : 'upstream error', 502, 'upstream_error'); }
});

openaiRoutes.post('/v1/video/generations', authApiKey, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return openAiError('invalid JSON body', 400, 'invalid_request_error');
  const cost = getNum(c.env.VIDEO_DEFAULT_COST, 20);
  const bill = await billOrFail(c, cost, 'video', { model: body.model });
  if (bill) return bill;
  const provider = providerForModel(body.model);
  try {
    const result = await callModel(c.env, provider, body, 'video');
    const data = result.data || { id: `video-${crypto.randomUUID()}`, status: 'queued' };
    await cacheGeneration(c.env, 'video', data);
    await logRequest(c.env, { requestId: c.get('requestId'), userId: c.get('user')!.id, apiKeyId: c.get('apiKey')!.id, path: c.req.path, status: 200, provider, accountId: result.accountId, cost });
    return Response.json(data);
  } catch (e) { return openAiError(e instanceof Error ? e.message : 'upstream error', 502, 'upstream_error'); }
});
