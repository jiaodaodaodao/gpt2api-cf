#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ ! -d node_modules ]; then
  npm install
else
  npm install
fi

if [ "${CF_INIT:-0}" = "1" ]; then
  npm run init:cf
fi

if [ "${CF_BUILD_FRONTEND:-0}" = "1" ] && [ -d ../frontend ]; then
  (cd ../frontend && corepack enable pnpm && pnpm install --frozen-lockfile && pnpm build)
fi

npm run static:sync
npm run typecheck
npm run db:migrate:remote
npm run dry-run
npm run deploy
