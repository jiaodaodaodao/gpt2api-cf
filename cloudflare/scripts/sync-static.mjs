#!/usr/bin/env node
import { cp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(new URL('../..', import.meta.url).pathname);
const cfStatic = resolve(root, 'cloudflare/static');
const userCandidates = [resolve(root, 'frontend/apps/user/dist'), resolve(root, 'frontend/apps/user/build'), resolve(root, 'frontend/build/user'), resolve(root, 'frontend/build/apps/user'), resolve(root, 'frontend/build')];
const adminCandidates = [resolve(root, 'frontend/apps/admin/dist'), resolve(root, 'frontend/apps/admin/build'), resolve(root, 'frontend/build/admin'), resolve(root, 'frontend/build/apps/admin')];

async function firstExisting(paths) {
  for (const p of paths) {
    try { if ((await stat(p)).isDirectory()) return p; } catch {}
  }
  return '';
}
async function copyIfExists(src, dest, label) {
  if (!src) {
    console.warn(`[sync-static] ${label} build not found; keeping placeholder for Cloudflare dev.`);
    return false;
  }
  await mkdir(dest, { recursive: true });
  await cp(src, dest, { recursive: true, force: true });
  console.log(`[sync-static] copied ${label}: ${src} -> ${dest}`);
  return true;
}

await mkdir(cfStatic, { recursive: true });
const routes = resolve(cfStatic, '_routes.json');
const userSrc = await firstExisting(userCandidates);
const adminSrc = await firstExisting(adminCandidates);
await rm(cfStatic, { recursive: true, force: true });
await mkdir(cfStatic, { recursive: true });
const copiedUser = await copyIfExists(userSrc, cfStatic, 'user frontend');
const copiedAdmin = await copyIfExists(adminSrc, resolve(cfStatic, 'admin'), 'admin frontend');
if (!copiedUser) await writeFile(resolve(cfStatic, 'index.html'), '<!doctype html><meta charset="utf-8"><title>gpt2api-cf</title><div id="root">Build frontend first: cd frontend && pnpm build</div>');
if (!copiedAdmin) {
  await mkdir(resolve(cfStatic, 'admin'), { recursive: true });
  await writeFile(resolve(cfStatic, 'admin/index.html'), '<!doctype html><meta charset="utf-8"><title>gpt2api-cf admin</title><div id="root">Build admin frontend first: cd frontend && pnpm build</div>');
}
await writeFile(routes, JSON.stringify({ version: 1, include: ['/*'], exclude: ['/assets/*', '/admin/assets/*', '/favicon.ico', '/logo*.png'] }, null, 2) + '\n');
if (!existsSync(routes)) throw new Error('failed to write _routes.json');
