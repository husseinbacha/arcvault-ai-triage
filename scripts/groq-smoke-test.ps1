# Stage 2 smoke test: confirms Groq model IDs and strict JSON-schema output, outside n8n.
# Usage (in YOUR PowerShell window, from the project root):
#   .\scripts\groq-smoke-test.ps1                              # default model openai/gpt-oss-120b
#   .\scripts\groq-smoke-test.ps1 -Model openai/gpt-oss-20b    # fallback model
# The key is read from $env:GROQ_API_KEY, or prompted (masked) if unset. It is never printed or saved.
# Compatible with Windows PowerShell 5.1 and PowerShell 7.

param([string]$Model = 'openai/gpt-oss-120b')

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$key = $env:GROQ_API_KEY
if (-not $key) {
    $secure = Read-Host 'Groq API key (input hidden)' -AsSecureString
    $key = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}
# Tolerate common paste mistakes (surrounding spaces, a copied "Bearer " prefix), then sanity-check the shape
# without revealing the key: only its length and whether it starts with the Groq prefix are shown.
$key = ($key.Trim() -replace '^Bearer\s+', '')
Write-Host ("Key check: length={0}, starts with gsk_={1}" -f $key.Length, $key.StartsWith('gsk_'))
if (-not $key.StartsWith('gsk_') -or $key -match '\s' -or ([regex]::Matches($key, 'gsk_').Count -gt 1)) {
    Write-Host 'Key does not look like a single Groq key (expected one value starting gsk_, no spaces). Re-paste it once.' -ForegroundColor Red
    exit 1
}
$headers = @{ Authorization = "Bearer $key" }
$base = 'https://api.groq.com/openai/v1'

function Show-HttpError($err) {
    Write-Host "FAILED: $($err.Exception.Message)" -ForegroundColor Red
    if ($err.ErrorDetails.Message) { Write-Host $err.ErrorDetails.Message }
}

# --- 1. Which gpt-oss models does this key see? ---
Write-Host "`n[1] GET /models" -ForegroundColor Cyan
try {
    $models = Invoke-RestMethod -Uri "$base/models" -Headers $headers -Method Get
    $ids = $models.data.id | Sort-Object
    $ids | Where-Object { $_ -like '*gpt-oss*' } | ForEach-Object { "  $_" }
    foreach ($m in 'openai/gpt-oss-120b', 'openai/gpt-oss-20b') {
        "  {0,-22} available: {1}" -f $m, ($ids -contains $m)
    }
} catch { Show-HttpError $_; exit 1 }

# --- 2. One strict-schema call on sample 3 ---
# Minimal throwaway schema: tests enums, nullable numbers and nested objects under strict mode.
# The real triage schema is frozen in Stage 3.
$schema = @{
    type = 'object'
    additionalProperties = $false
    required = @('core_issue', 'invoice_numbers', 'billed_amount', 'expected_amount', 'category', 'priority', 'confidence')
    properties = @{
        core_issue      = @{ type = 'string' }
        invoice_numbers = @{ type = 'array'; items = @{ type = 'string' } }
        billed_amount   = @{ type = @('number', 'null') }
        expected_amount = @{ type = @('number', 'null') }
        category        = @{ type = 'string'; enum = @('Bug Report', 'Feature Request', 'Billing Issue', 'Technical Question', 'Incident/Outage') }
        priority        = @{ type = 'string'; enum = @('Low', 'Medium', 'High') }
        confidence      = @{ type = 'number' }
    }
}

$body = @{
    model            = $Model
    temperature      = 0
    reasoning_effort = 'low'
    messages = @(
        @{ role = 'system'; content = 'You triage customer support messages for a B2B software company. Extract facts from the message, then classify it. confidence is 0-1.' }
        @{ role = 'user';   content = 'Invoice #8821 shows a charge of $1,240 but our contract rate is $980/month. Can someone look into this?' }
    )
    response_format = @{
        type = 'json_schema'
        json_schema = @{ name = 'smoke_test'; strict = $true; schema = $schema }
    }
} | ConvertTo-Json -Depth 20

Write-Host "`n[2] POST /chat/completions  model=$Model  strict=true" -ForegroundColor Cyan
try {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $resp = Invoke-RestMethod -Uri "$base/chat/completions" -Headers $headers -Method Post `
        -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
    $sw.Stop()
} catch { Show-HttpError $_; exit 1 }

$content = $resp.choices[0].message.content
"  model returned : $($resp.model)"
"  finish_reason  : $($resp.choices[0].finish_reason)"
"  latency (ms)   : $($sw.ElapsedMilliseconds)"
"  tokens         : prompt=$($resp.usage.prompt_tokens) completion=$($resp.usage.completion_tokens) total=$($resp.usage.total_tokens)"
"  raw content    :"
$content
try {
    $parsed = $content | ConvertFrom-Json
    Write-Host "`n  JSON parse: OK" -ForegroundColor Green
    $parsed | Format-List
} catch {
    Write-Host "`n  JSON parse: FAILED" -ForegroundColor Red
}
