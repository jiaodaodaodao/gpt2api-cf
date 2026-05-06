$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

npm install
if ($env:CF_INIT -eq "1") {
  npm run init:cf
}
npm run typecheck
npm run db:migrate:remote
npm run dry-run
npm run deploy
