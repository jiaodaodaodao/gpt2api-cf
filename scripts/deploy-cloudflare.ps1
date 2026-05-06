$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $PSScriptRoot
$CfDir = Join-Path $RootDir "cloudflare"

Set-Location $CfDir
if (-not (Test-Path "node_modules")) {
  npm install
}
npm run typecheck
npm run dry-run
npm run deploy
