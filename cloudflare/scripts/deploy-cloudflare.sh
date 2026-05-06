#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
npm install
npm run typecheck
npm run db:migrate:remote
npm run dry-run
npm run deploy
