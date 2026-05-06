$ErrorActionPreference = "Stop"
$RootDir = Split-Path -Parent $PSScriptRoot
& (Join-Path $RootDir "cloudflare/scripts/deploy-cloudflare.ps1")
