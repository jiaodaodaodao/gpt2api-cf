$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $PSScriptRoot
$CfDir = Join-Path $RootDir "cloudflare"

Set-Location $CfDir
if (Test-Path ".env.local") {
  Get-Content ".env.local" | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
      $parts = $line.Split("=", 2)
      [Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim().Trim('"').Trim("'"), "Process")
    }
  }
}
if (-not (Test-Path "node_modules")) {
  npm install
}
npm run typecheck
npm run dry-run
npm run deploy
