import { Hono } from 'hono';
import type { Env, AppVariables } from '../types';
import { authUser } from '../services/auth';
import { jsonOk } from '../lib/http';

export const userRoutes = new Hono<{ Bindings: Env; Variables: AppVariables }>();
userRoutes.use('/api/*', authUser);
userRoutes.get('/api/wallet', (c) => jsonOk({ credits: c.get('user')!.credits }));
userRoutes.get('/api/billing', async (c) => jsonOk((await c.env.DB.prepare('select * from billing_records where user_id=? order by created_at desc limit 100').bind(c.get('user')!.id).all()).results));
userRoutes.get('/api/generations', async (c) => jsonOk((await c.env.DB.prepare('select * from generations where user_id=? order by created_at desc limit 100').bind(c.get('user')!.id).all()).results));
