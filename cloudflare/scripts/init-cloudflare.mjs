import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

function run(args, optional = false) {
  try { return execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { if (optional) return `${e.stdout || ''}${e.stderr || ''}`; throw e; }
}
function patchToml(kind, id) {
  const path = 'wrangler.toml';
  let text = readFileSync(path, 'utf8');
  if (kind === 'd1') text = text.replace(/database_id = "[^"]+"/, `database_id = "${id}"`);
  if (kind === 'kv') text = text.replace(/id = "[^"]+"\npreview_id/, `id = "${id}"\npreview_id`);
  writeFileSync(path, text);
}

const d1Out = run(['d1', 'create', 'gpt2api_d1'], true);
const d1Id = d1Out.match(/database_id\s*=\s*"([^"]+)"/)?.[1] || d1Out.match(/([0-9a-f-]{36})/)?.[1];
if (d1Id) { patchToml('d1', d1Id); console.log(`D1 database_id=${d1Id}`); } else console.log('D1 may already exist; keep current database_id or patch it manually.');

const kvOut = run(['kv', 'namespace', 'create', 'CACHE'], true);
const kvId = kvOut.match(/id\s*=\s*"([^"]+)"/)?.[1] || kvOut.match(/([0-9a-f]{32})/)?.[1];
if (kvId) { patchToml('kv', kvId); console.log(`KV id=${kvId}`); } else console.log('KV may already exist; keep current id or patch it manually.');

const r2Out = run(['r2', 'bucket', 'create', 'gpt2api-media'], true);
console.log(r2Out.trim() || 'R2 bucket may already exist; keep bucket_name=gpt2api-media or patch wrangler.toml manually.');

console.log('Next: npx wrangler d1 migrations apply gpt2api_d1 --remote && npx wrangler secret put JWT_SECRET && npx wrangler secret put ENCRYPTION_KEY');
