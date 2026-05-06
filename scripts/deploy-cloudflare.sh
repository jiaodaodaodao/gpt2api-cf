#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CF_DIR="$ROOT_DIR/cloudflare"

cd "$CF_DIR"
if [ ! -d node_modules ]; then
  npm install
fi
npm run typecheck
npm run dry-run
npm run deploy
