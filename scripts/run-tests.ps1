# Posts every input in a test file to the n8n intake webhook (the same way a real sender would) and
# collects the returned records into one JSON array file.
# Usage (n8n running, workflow published/active):
#   .\scripts\run-tests.ps1                                   # 5 samples -> output/processed-requests.json
#   .\scripts\run-tests.ps1 -InputFile test-data\edge-cases.json -OutFile output\edge-case-results.json
# Use -Url http://localhost:5678/webhook-test/arcvault/intake to hit the editor's test listener instead.

param(
    [string]$InputFile = 'test-data\sample-inputs.json',
    [string]$OutFile = 'output\processed-requests.json',
    [string]$Url = 'http://localhost:5678/webhook/arcvault/intake',
    # Pause between requests to stay under the Groq free-tier tokens-per-minute limit.
    [int]$DelaySeconds = 0
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$utf8 = New-Object System.Text.UTF8Encoding($false)
$inputs = [IO.File]::ReadAllText((Join-Path $root $InputFile), $utf8) | ConvertFrom-Json

function Read-Body($response) {
    $reader = New-Object IO.StreamReader($response.GetResponseStream(), $utf8)
    try { $reader.ReadToEnd() } finally { $reader.Dispose() }
}

$raw = @()
$rows = @()
foreach ($item in $inputs) {
    $payload = @{ source = $item.source; message = $item.message } | ConvertTo-Json -Compress
    $request = [Net.WebRequest]::Create($Url)
    $request.Method = 'POST'
    $request.ContentType = 'application/json; charset=utf-8'
    $request.Timeout = 120000
    $bytes = $utf8.GetBytes($payload)
    $stream = $request.GetRequestStream(); $stream.Write($bytes, 0, $bytes.Length); $stream.Close()

    $sw = [Diagnostics.Stopwatch]::StartNew()
    try {
        $response = $request.GetResponse()
        $status = [int]$response.StatusCode
        $body = Read-Body $response
    } catch [Net.WebException] {
        if (-not $_.Exception.Response) { throw }
        $status = [int]$_.Exception.Response.StatusCode
        $body = Read-Body $_.Exception.Response
    }
    $sw.Stop()

    $raw += $body
    if ($DelaySeconds -gt 0 -and $item -ne $inputs[-1]) { Start-Sleep -Seconds $DelaySeconds }
    $r = $body | ConvertFrom-Json
    $rows += [pscustomobject]@{
        id         = $item.id
        http       = $status
        ms         = $sw.ElapsedMilliseconds
        category   = $r.classification.category
        priority   = $r.classification.priority
        confidence = $r.classification.confidence
        queue      = $r.routing.queue
        intended   = $r.routing.intended_queue
        escalated  = $r.escalation.required
        reasons    = ($r.escalation.reasons.code -join ',')
        status     = if ($r.meta) { $r.meta.status } else { $r.error }
        expected   = $item.expected_queue
        match      = if (-not $item.expected_queue) { '' } elseif ($item.expected_queue -eq $r.routing.queue) { 'YES' } else { 'NO' }
    }
}

# Keep each record byte-for-byte as n8n returned it.
$outPath = Join-Path $root $OutFile
[IO.File]::WriteAllText($outPath, "[`n" + ($raw -join ",`n") + "`n]`n", $utf8)
$rows | Format-Table -AutoSize
Write-Host "Saved $($raw.Count) responses to $OutFile"

