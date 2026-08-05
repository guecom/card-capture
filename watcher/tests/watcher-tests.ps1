# watcher-tests.ps1 — 워처 recovery·idempotency·health fixture 테스트
# Kairen-Ref: TSK-000142, TSK-000276 (commit 판정 도입에 맞춘 stub·fixture 갱신)
# claim·lease·staging·격리 프로토콜 테스트는 watcher\tests\watcher-protocol-tests.ps1 에 있다.
# 실제 vault·codex를 건드리지 않는다: 임시 inbox + 합성 stub 처리기로 검증.
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

# stub codex: marker 기록 + 지정된 exit code 반환. exit 0이면 워처가 지정한 TARGET-CAPTURE-ID
# 캡처를 계약대로 완결한다(status=processed + person + brief.md) — 워처의 commit 판정이 요구하는 산출물이다.
$stubExit = Join-Path $sandbox 'stub-exit.txt'
'0' | Out-File -Encoding ascii $stubExit
$stub = Join-Path $sandbox 'codex-stub.ps1'
@"
Add-Content -Path '$sandbox\stub-marker.txt' -Value 'stub-ran'
`$code = [int]((Get-Content '$stubExit' -Raw).Trim())
if (`$code -ne 0) { exit `$code }
`$prompt = ''
if (`$args.Count -gt 0) { `$prompt = [string]`$args[`$args.Count - 1] }
if (`$prompt -notmatch 'TARGET-CAPTURE-ID:\s*([A-Za-z0-9_.\-]+)') { exit 0 }   # quick-pass: 대상 지정 없음
`$target = `$Matches[1]
`$dir = Join-Path '$sbInbox' `$target
`$p = Join-Path `$dir 'capture.json'
`$m = Get-Content `$p -Raw -Encoding UTF8 | ConvertFrom-Json
`$m.status = 'processed'
`$m | Add-Member -NotePropertyName person -NotePropertyValue ('PER-' + `$target) -Force
`$m | Add-Member -NotePropertyName processedAt -NotePropertyValue ((Get-Date).ToString('yyyy-MM-ddTHH:mm:ssZ')) -Force
(`$m | ConvertTo-Json) | Out-File -Encoding utf8 `$p
'stub brief' | Out-File -Encoding utf8 (Join-Path `$dir 'brief.md')
exit 0
"@ | Out-File -Encoding utf8 $stub

# ---- load watcher functions in test mode with overridden globals ----
$CardCaptureWatcherTestMode = $true
. $watcherScript
# override paths after dot-source (script top-level vars)
$Inbox = $sbInbox
$Codex = $stub
$Vault = $sandbox
$LogFile = Join-Path $sbLog 'watcher.log'
$HealthFile = Join-Path $sbLog 'watcher-health.json'
$PushConf = Join-Path $sbLog 'push.conf'
$Lock = Join-Path $sbInbox 'processing.lock'
# 실행 중인 실제 워처의 %LOCALAPPDATA%\CardCapture\state 를 절대 건드리지 않도록 반드시 override한다.
$StateDir = Join-Path $sandbox 'state'
$WorkerId = 'test-worker'

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

# 8. stale lock -> removed and processing proceeds (대기 캡처를 계약대로 완결하며 소진)
(Get-Item $Lock).LastWriteTime = (Get-Date).AddMinutes(-45)
Invoke-Processing
T (Test-Path (Join-Path $sandbox 'stub-marker.txt')) 'stale lock: removed, processing ran'
T (-not (Test-Path $Lock)) 'lock cleaned up after run'
T ($script:ConsecutiveFailures -eq 0) 'success run: failures reset'
T ((Get-Backlog).Count -eq 0) 'stale lock run: backlog drained'

# 9. failure run -> captures stay received, consecutiveFailures increments
# (테스트 8이 큐를 비웠으므로 실패 관찰용 캡처를 새로 만든다)
'1' | Out-File -Encoding ascii $stubExit
$null = New-Capture 'T0010-failing' 'received' $null $null
Invoke-Processing
T ($script:ConsecutiveFailures -eq 1) 'failure: consecutiveFailures=1'
$meta = Get-Content (Join-Path (Join-Path $sbInbox 'T0010-failing') 'capture.json') -Raw | ConvertFrom-Json
T ($meta.status -eq 'received') 'failure: capture stays received (no loss)'
Invoke-Processing; Invoke-Processing
T ($script:ConsecutiveFailures -eq 3) 'failure: consecutive count reaches 3'
T ((Get-Content $LogFile -Raw) -match 'WARNING: 3\+') '3+ failures: warning logged'
$h2 = Get-Content $HealthFile -Raw -Encoding UTF8 | ConvertFrom-Json
T ($h2.consecutiveFailures -eq 3) 'health: failures surfaced'
T ($h2.lastExitCode -eq 1) 'health: lastExitCode surfaced'

# 10. recovery -> success resets and push outbox skips gracefully without config
'0' | Out-File -Encoding ascii $stubExit
$null = New-Capture 'T0011-recovery' 'received' $null $null
Invoke-Processing
T ($script:ConsecutiveFailures -eq 0) 'recovery: failures reset after success'
T (-not (Test-Path $PushConf)) 'push.conf absent'
T (-not (Queue-PushEvent 'T0001-received' 'final_result' 'fixture' $null)) 'push without config: silent no-op'

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
  'stub brief' | Out-File -Encoding utf8 (Join-Path `$d.FullName 'brief.md')
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

# ---- 조사 깊이 → 처리 모델 (DEC-000110 / TSK-000565) ----
#
# founder: "빠른 조사, 일반 조사, 깊은 조사는 … 오직 모델만 차이가 있는 거야."
# 그 말이 코드에서 참이 되는 마지막 한 칸이 여기다. 지금까지는 세 선택이 처리기에 도착할 때
# 완전히 같은 값이었다 — 깊이가 무엇을 바꾸는 자리가 아예 없었다.
#
# 이 묶음이 잠그는 것 넷:
#   1. 값이 비어 있으면 **아무것도 달라지지 않는다** (저장소에 커밋되는 상태가 정확히 그것이다).
#   2. 값이 차 있으면 깊이마다 다른 자리로 간다. 모르는 깊이는 기본 자리를 쓴다.
#   3. 설정 파일 한 줄이 처리기 명령줄에 임의의 플래그를 끼워 넣지 못한다.
#   4. 깊이를 capture.json에서 실제로 읽는다 — 못 읽으면 위의 셋이 전부 헛돈다.
Write-Host ''
Write-Host '=== depth -> processing model ==='

$modelConfig = Join-Path $sandbox 'research-models.json'
$ResearchModelConfig = $modelConfig
$script:ResearchModelWarned = @{}

function Set-ModelConfig($quick, $standard, $deep, $version) {
    if (-not $version) { $version = 'card-capture-research-models-v1' }
    $json = @{ version = $version; models = @{ quick = $quick; standard = $standard; deep = $deep } } | ConvertTo-Json -Depth 4
    [IO.File]::WriteAllText($modelConfig, $json, (New-Object Text.UTF8Encoding($false)))
    $script:ResearchModelWarned = @{}
}

Remove-Item $modelConfig -ErrorAction SilentlyContinue
T ((Resolve-ResearchModel 'deep') -eq '') 'model: 설정 파일이 없으면 아무 값도 고르지 않는다'

Set-ModelConfig '' '' ''
$resolvedEmpty = @('quick', 'standard', 'deep') | ForEach-Object { Resolve-ResearchModel $_ }
T ((@($resolvedEmpty | Where-Object { $_ -ne '' })).Count -eq 0) 'model: 빈 값이면 세 깊이 모두 플래그가 없다'

Set-ModelConfig 'model-q' 'model-s' 'model-d'
T ((Resolve-ResearchModel 'quick') -eq 'model-q') 'model: 빠른 조사는 자기 자리로 간다'
T ((Resolve-ResearchModel 'standard') -eq 'model-s') 'model: 일반 조사는 자기 자리로 간다'
T ((Resolve-ResearchModel 'deep') -eq 'model-d') 'model: 깊은 조사는 자기 자리로 간다'
T ((Resolve-ResearchModel 'turbo') -eq 'model-s') 'model: 모르는 깊이는 기본 자리를 쓴다'
T ((Resolve-ResearchModel '') -eq 'model-s') 'model: 깊이가 없는 캡처는 기본 자리를 쓴다'
T ((Resolve-ResearchModel $null) -eq 'model-s') 'model: 깊이가 null이어도 기본 자리를 쓴다'

# 값 하나가 곧 자식 프로세스의 argv가 된다. 모양이 어긋나면 쓰지 않고, 나머지 자리는 그대로 산다.
Set-ModelConfig '-rf --dangerous' 'ok-model' 'has space'
T ((Resolve-ResearchModel 'quick') -eq '') 'model: 플래그처럼 생긴 값은 쓰지 않는다'
T ((Resolve-ResearchModel 'deep') -eq '') 'model: 공백이 든 값은 쓰지 않는다'
T ((Resolve-ResearchModel 'standard') -eq 'ok-model') 'model: 모양이 어긋난 값 하나가 나머지를 죽이지 않는다'

Set-ModelConfig 'model-q' 'model-s' 'model-d' 'card-capture-research-models-v0'
T ((Resolve-ResearchModel 'deep') -eq '') 'model: 모르는 설정 판은 쓰지 않는다'

# 저장소에 커밋된 설정은 비어 있어야 한다 — 모델 id를 이 저장소에 넣지 않는다.
$repoModelConfig = Join-Path (Split-Path -Parent $here) 'config\research-models.json'
T (Test-Path $repoModelConfig) 'model: 저장소에 설정 파일이 있다'
$repoModels = Get-Content $repoModelConfig -Raw -Encoding UTF8 | ConvertFrom-Json
T ((@(@('quick', 'standard', 'deep') | Where-Object { ([string]$repoModels.models.$_).Trim() -ne '' })).Count -eq 0) `
    'model: 커밋된 설정은 세 자리 모두 비어 있다 (모델 id를 커밋하지 않는다)'

# 그리고 그 값이 실제로 처리기 명령줄에 붙는지 — 해석이 아니라 argv를 직접 본다.
$argLog = Join-Path $sandbox 'model-args.txt'
$argStub = Join-Path $sandbox 'codex-args.ps1'
@"
Add-Content -Path '$argLog' -Value ((`$args) -join '|')
exit 0
"@ | Out-File -Encoding utf8 $argStub
$savedCodex = $Codex
$Codex = $argStub
Remove-Item $argLog -ErrorAction SilentlyContinue
$null = Invoke-StandardProcessor 'TARGET-CAPTURE-ID: A0001' (Join-Path $sbLog 'model-none.log') ''
$null = Invoke-StandardProcessor 'TARGET-CAPTURE-ID: A0001' (Join-Path $sbLog 'model-set.log') 'model-d'
$argLines = @(Get-Content $argLog -ErrorAction SilentlyContinue)
T ($argLines.Count -eq 2) 'model: 처리기 호출 두 번이 기록됐다'
T ($argLines.Count -eq 2 -and $argLines[0] -notmatch '(^|\|)-m(\||$)') 'model: 값이 없으면 -m 이 아예 붙지 않는다'
T ($argLines.Count -eq 2 -and $argLines[1] -match '(^|\|)-m\|model-d(\||$)') 'model: 값이 있으면 -m 과 값이 함께 붙는다'
$Codex = $savedCodex

# 깊이는 capture.json에서 읽힌다.
$depthDir = New-Capture 'D0001-depth' 'received' $null $null
$depthMeta = @{
    captureId = 'D0001-depth'; status = 'received'; capturer = 'test'; type = 'research_instruction'
    researchInstruction = @{ depth = 'deep'; mode = 'deep_evidence_graph'; raw = '합성 요청' }
}
($depthMeta | ConvertTo-Json -Depth 5) | Out-File -Encoding utf8 (Join-Path $depthDir 'capture.json')
T ((Get-CaptureEligibility (Get-Item $depthDir)).depth -eq 'deep') 'model: capture.json의 깊이를 읽는다'
$plainDir = New-Capture 'D0002-plain' 'received' $null $null
T ((Get-CaptureEligibility (Get-Item $plainDir)).depth -eq '') 'model: 조사 요청이 아닌 캡처에는 깊이가 없다'
Remove-Item $depthDir, $plainDir -Recurse -Force -ErrorAction SilentlyContinue

# ---- summary + cleanup ----
Write-Host ''
Write-Host ("summary: pass=" + $pass + " fail=" + $fail)
Remove-Item $sandbox -Recurse -Force -ErrorAction SilentlyContinue
if ($fail -gt 0) { Write-Host 'RESULT: FAIL'; exit 1 } else { Write-Host 'RESULT: PASS'; exit 0 }
