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

npm run typecheck
npm run db:migrate:remote
npm run dry-run
npm run deploy
