# watcher-tests.ps1 — 워처 recovery·idempotency·health fixture 테스트
# Kairen-Ref: TSK-000142
# 실제 vault·codex를 건드리지 않는다: 임시 inbox + stub codex(.cmd)로 검증.
# 사용: powershell -NoProfile -ExecutionPolicy Bypass -File watcher\tests\watcher-tests.ps1
# 주의: UTF-8 BOM 유지.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $PSScriptRoot   # watcher/
$watcherScript = Join-Path $here 'CardCapture_Watcher.ps1'

$pass = 0; $fail = 0
function T($ok, $label) { if ($ok) { $script:pass++; Write-Host "pass  $label" } else { $script:fail++; Write-Host "FAIL  $label" } }

# ---- sandbox setup ----
$sandbox = Join-Path $env:TEMP ("ccw-test-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$sbInbox = Join-Path $sandbox 'inbox'
$sbLog = Join-Path $sandbox 'log'
New-Item -ItemType Directory -Force -Path $sbInbox, $sbLog | Out-Null

# stub codex: 인자 무시, marker 기록, 지정된 exit code 반환
$stubExit = Join-Path $sandbox 'stub-exit.txt'
'0' | Out-File -Encoding ascii $stubExit
$stub = Join-Path $sandbox 'codex-stub.cmd'
"@echo off`r`necho stub-ran >> `"$sandbox\stub-marker.txt`"`r`nset /p X=<`"$stubExit`"`r`nexit /b %X%" | Out-File -Encoding ascii $stub

# ---- load watcher functions in test mode with overridden globals ----
$CardCaptureWatcherTestMode = $true
. $watcherScript
# override paths after dot-source (script top-level vars)
$Inbox = $sbInbox
$Codex = $stub
$Vault = $sandbox
$LogFile = Join-Path $sbLog 'watcher.log'
$HealthFile = Join-Path $sbLog 'watcher-health.json'
$NotifyConf = Join-Path $sbLog 'notify.conf'
$Lock = Join-Path $sbInbox 'processing.lock'

function New-Capture($id, $status, $receivedAt, $processedAt) {
    $d = Join-Path $sbInbox $id
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    $meta = @{ captureId = $id; status = $status; capturer = 'test' }
    if ($receivedAt) { $meta.receivedAt = $receivedAt }
    if ($processedAt) { $meta.processedAt = $processedAt }
    ($meta | ConvertTo-Json) | Out-File -Encoding utf8 (Join-Path $d 'capture.json')
    return $d
}

Write-Host '=== watcher fixture tests ==='

# 1. empty inbox -> no backlog
T ((Get-Backlog).Count -eq 0) 'empty inbox: backlog 0'
T (-not (Test-NewCapture)) 'empty inbox: Test-NewCapture false'

# 2. received capture -> backlog detected
$null = New-Capture 'T0001-received' 'received' $null $null
T ((Get-Backlog).Count -eq 1) 'received capture detected in backlog'
T (Test-NewCapture) 'Test-NewCapture true'

# 3. processed capture -> not in backlog (idempotency: no reprocessing trigger)
$null = New-Capture 'T0002-processed' 'processed' '2026-07-24T00:00:00Z' '2026-07-24T00:05:00Z'
T ((Get-Backlog).Count -eq 1) 'processed capture not counted'

# 4. resend (receivedAt > processedAt) -> counted
$null = New-Capture 'T0003-resend' 'processed' '2026-07-24T01:00:00Z' '2026-07-24T00:05:00Z'
T ((Get-Backlog).Count -eq 2) 'resend capture counted'

# 5. duplicate capture (1).json variants -> newest wins
$d = New-Capture 'T0004-dup' 'received' $null $null
Start-Sleep -Milliseconds 600
'{"captureId":"T0004-dup","status":"processed","receivedAt":"2026-07-24T00:00:00Z","processedAt":"2026-07-24T00:10:00Z"}' |
    Out-File -Encoding utf8 (Join-Path $d 'capture (1).json')
T ((Get-Backlog | Where-Object { $_.id -eq 'T0004-dup' }).Count -eq 0) 'duplicate json: newest (processed) wins'

# 6. health file writing
Write-Health
$h = Get-Content $HealthFile -Raw -Encoding UTF8 | ConvertFrom-Json
T ($h.pid -eq $PID) 'health: pid recorded'
T ($h.backlogCount -eq 2) 'health: backlog count 2'
T ($null -ne $h.backlogOldestAgeMin) 'health: oldest age present'
T ($h.lockExists -eq $false) 'health: lock false'

# 7. fresh lock -> processing skipped
'x' | Out-File -Encoding ascii $Lock
Invoke-Processing
T (-not (Test-Path (Join-Path $sandbox 'stub-marker.txt'))) 'fresh lock: processing skipped'
T ((Get-Content $LogFile -Raw) -match 'lock exists') 'fresh lock: logged'

# 8. stale lock -> removed and processing proceeds
(Get-Item $Lock).LastWriteTime = (Get-Date).AddMinutes(-45)
Invoke-Processing
T (Test-Path (Join-Path $sandbox 'stub-marker.txt')) 'stale lock: removed, processing ran'
T (-not (Test-Path $Lock)) 'lock cleaned up after run'
T ($script:ConsecutiveFailures -eq 0) 'success run: failures reset'

# 9. failure run -> captures stay received, consecutiveFailures increments
'1' | Out-File -Encoding ascii $stubExit
Invoke-Processing
T ($script:ConsecutiveFailures -eq 1) 'failure: consecutiveFailures=1'
$meta = Get-Content (Join-Path (Join-Path $sbInbox 'T0001-received') 'capture.json') -Raw | ConvertFrom-Json
T ($meta.status -eq 'received') 'failure: capture stays received (no loss)'
Invoke-Processing; Invoke-Processing
T ($script:ConsecutiveFailures -eq 3) 'failure: consecutive count reaches 3'
T ((Get-Content $LogFile -Raw) -match 'WARNING: 3\+') '3+ failures: warning logged'
$h2 = Get-Content $HealthFile -Raw -Encoding UTF8 | ConvertFrom-Json
T ($h2.consecutiveFailures -eq 3) 'health: failures surfaced'
T ($h2.lastExitCode -eq 1) 'health: lastExitCode surfaced'

# 10. recovery -> success resets and notify skipped gracefully without conf
'0' | Out-File -Encoding ascii $stubExit
Invoke-Processing
T ($script:ConsecutiveFailures -eq 0) 'recovery: failures reset after success'
T (-not (Test-Path $NotifyConf)) 'notify.conf absent'
Send-Notify @('T0001-received')   # must not throw
T $true 'notify without conf: silent no-op'

# 11. per-card loop (v3): smart stub가 한 번에 가장 이른 received 1건만 processed로 바꿈 →
#     루프가 대기 3건을 한 건씩 소진하고 카드별로 codex를 호출한다.
Get-ChildItem $sbInbox -Directory | Remove-Item -Recurse -Force
$callLog = Join-Path $sandbox 'smart-calls.txt'
Remove-Item $callLog -ErrorAction SilentlyContinue
$smartPs = Join-Path $sandbox 'smart-process.ps1'
@"
`$inbox = '$sbInbox'
`$d = Get-ChildItem `$inbox -Directory | Where-Object { (Get-Content (Join-Path `$_.FullName 'capture.json') -Raw) -match '"status"\s*:\s*"received"' } | Sort-Object Name | Select-Object -First 1
if (`$d) {
  `$p = Join-Path `$d.FullName 'capture.json'
  `$m = Get-Content `$p -Raw | ConvertFrom-Json
  `$m.status = 'processed'
  `$m | Add-Member -NotePropertyName person -NotePropertyValue ('PER-' + `$d.Name) -Force
  `$m | ConvertTo-Json | Out-File -Encoding utf8 `$p
  Add-Content -Path '$callLog' -Value `$d.Name
}
"@ | Out-File -Encoding utf8 $smartPs
$smartStub = Join-Path $sandbox 'codex-smart.cmd'
"@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"$smartPs`"`r`nexit /b 0" | Out-File -Encoding ascii $smartStub
$Codex = $smartStub
$null = New-Capture 'B0002' 'received' $null $null
$null = New-Capture 'A0001' 'received' $null $null
$null = New-Capture 'C0003' 'received' $null $null
T ((Get-Backlog).Count -eq 3) 'per-card: 3 received queued'
$script:ConsecutiveFailures = 0
Invoke-Processing
T ((Get-Backlog).Count -eq 0) 'per-card: loop drained all 3'
$calls = @(Get-Content $callLog -ErrorAction SilentlyContinue)
T ($calls.Count -eq 3) 'per-card: one codex call per card (3 calls)'
T ($calls[0] -eq 'A0001' -and $calls[2] -eq 'C0003') 'per-card: oldest-first order'
T (@(Get-Content $LogFile | Where-Object { $_ -match 'processing loop done' }).Count -ge 1) 'per-card: loop-done summary logged'
$h3 = Get-Content $HealthFile -Raw -Encoding UTF8 | ConvertFrom-Json
T ($h3.backlogCount -eq 0) 'per-card: health backlog 0 after drain'

# ---- summary + cleanup ----
Write-Host ''
Write-Host ("summary: pass=" + $pass + " fail=" + $fail)
Remove-Item $sandbox -Recurse -Force -ErrorAction SilentlyContinue
if ($fail -gt 0) { Write-Host 'RESULT: FAIL'; exit 1 } else { Write-Host 'RESULT: PASS'; exit 0 }
