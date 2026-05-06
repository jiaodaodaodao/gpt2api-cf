$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

npm install
if ($env:CF_INIT -eq "1") {
  npm run init:cf
}
if ($env:CF_BUILD_FRONTEND -eq "1" -and (Test-Path "../frontend")) {
  Push-Location ../frontend
  corepack enable pnpm
  pnpm install --frozen-lockfile
  pnpm build
  Pop-Location
}

npm run static:sync
npm run typecheck
npm run db:migrate:remote
npm run dry-run
npm run deploy
