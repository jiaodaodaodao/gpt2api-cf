$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
npm install
npm run typecheck
npm run db:migrate:remote
npm run dry-run
npm run deploy
