# Starts n8n 2.41.3 with the settings this project relies on.
# Usage (from the project root):  .\start-n8n.ps1
# Prerequisites: Node.js >= 24, then: npm install -g n8n@2.41.3

$ProjectRoot = $PSScriptRoot
# Same rule as scripts/build-workflow.js: ARCVAULT_OUTPUT_DIR if set, otherwise <repo>\output.
$OutputDir   = if ($env:ARCVAULT_OUTPUT_DIR) { [IO.Path]::GetFullPath($env:ARCVAULT_OUTPUT_DIR) } else { Join-Path $ProjectRoot 'output' }
New-Item -ItemType Directory -Force $OutputDir | Out-Null

# n8n 2.x only lets file nodes read/write inside this folder.
$env:N8N_RESTRICT_FILE_ACCESS_TO = $OutputDir
# Keep timestamps consistent in records and logs.
$env:GENERIC_TIMEZONE = 'UTC'
# Security hardening (found by scripts/security-tests.ps1):
# - listen on localhost only; by default n8n binds to all interfaces, exposing the editor and the
#   unauthenticated webhook to anyone on the same network.
# - production mode; with NODE_ENV unset n8n treats itself as development and returns stack traces
#   (internal paths, Windows user name) in HTTP error responses.
$env:N8N_LISTEN_ADDRESS = '127.0.0.1'
$env:NODE_ENV = 'production'
# Do not send usage telemetry from this local instance.
$env:N8N_DIAGNOSTICS_ENABLED = 'false'
$env:N8N_PERSONALIZATION_ENABLED = 'false'

Write-Host "n8n version : $(n8n --version)"
Write-Host "File access : $env:N8N_RESTRICT_FILE_ACCESS_TO"
Write-Host "Editor URL  : http://localhost:5678"
n8n start
