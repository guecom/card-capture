# watcher-protocol-tests.ps1 — claim·lease·staging·quarantine 프로토콜 테스트 (FI-017/018/019)
# Kairen-Ref: TSK-000276
# 실제 vault·Drive·실행 중인 워처를 건드리지 않는다: 임시 inbox + 합성 stub 프로세서로만 검증.
# 사용: powershell -NoProfile -ExecutionPolicy Bypass -File watcher\tests\watcher-protocol-tests.ps1
# 주의: UTF-8 BOM 유지 (한글 경로 CP949 오독 방지).

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $PSScriptRoot   # watcher/
$watcherScript = Join-Path $here 'CardCapture_Watcher.ps1'

$pass = 0; $fail = 0
function T($ok, $label) {
    if ($ok) { $script:pass++; Write-Host "pass  $label" } else { $script:fail++; Write-Host "FAIL  $label" }
}
# 미구현 함수/속성은 예외를 던진다 — 예외도 FAIL 한 줄로 기록해 red baseline이 읽히게 한다.
function TB($label, $block) {
    try {
        $r = & $block
        T ([bool]$r) $label
    } catch {
        $script:fail++
        Write-Host ("FAIL  " + $label + "  [error: " + $_.Exception.Message + "]")
    }
}

# ---- sandbox ----
$sandbox = Join-Path $env:TEMP ("ccw-proto-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$sbInbox = Join-Path $sandbox 'inbox'
$sbLog = Join-Path $sandbox 'log'
$sbState = Join-Path $sandbox 'state'
$sbClaims = Join-Path $sbState 'claims'
New-Item -ItemType Directory -Force -Path $sbInbox, $sbLog, $sbState | Out-Null

$stubConf = Join-Path $sandbox 'stub-conf.json'
$stubCalls = Join-Path $sandbox 'stub-calls.txt'
'' | Out-File -Encoding ascii $stubCalls

# 합성 stub 프로세서: 워처가 프롬프트에 넣은 TARGET-CAPTURE-ID를 읽어 그 캡처 한 건만 다룬다.
# mode: commit(정상 완결) / exit1(실패) / nobrief(exit 0인데 brief 없음) / stealLease(claim 소유자 탈취)
$stubPs = Join-Path $sandbox 'proc-stub.ps1'
@"
`$ErrorActionPreference = 'Continue'
`$inbox = '$sbInbox'
`$confPath = '$stubConf'
`$callLog = '$stubCalls'
`$claimDir = '$sbClaims'
`$prompt = ''
if (`$args.Count -gt 0) { `$prompt = [string]`$args[`$args.Count - 1] }
`$target = ''
if (`$prompt -match 'TARGET-CAPTURE-ID:\s*([A-Za-z0-9_.\-]+)') { `$target = `$Matches[1] }
Add-Content -Path `$callLog -Value `$target
if (-not `$target) { exit 9 }
`$conf = Get-Content `$confPath -Raw -Encoding UTF8 | ConvertFrom-Json
`$mode = 'commit'
foreach (`$p in @(`$conf.poison)) { if (`$p -eq `$target) { `$mode = [string]`$conf.poisonMode } }
if (`$mode -eq 'exit1') { exit 1 }
if (`$mode -eq 'stealLease') {
  `$cf = Join-Path `$claimDir (`$target + '.claim.json')
  if (Test-Path `$cf) {
    `$c = Get-Content `$cf -Raw -Encoding UTF8 | ConvertFrom-Json
    `$c.owner = 'thief-worker'
    (`$c | ConvertTo-Json) | Out-File -Encoding utf8 `$cf
  }
}
`$dir = Join-Path `$inbox `$target
`$jsonPath = Join-Path `$dir 'capture.json'
`$m = Get-Content `$jsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
`$m.status = 'processed'
`$m | Add-Member -NotePropertyName person -NotePropertyValue ('PER-' + `$target) -Force
`$m | Add-Member -NotePropertyName processedAt -NotePropertyValue ((Get-Date).ToString('yyyy-MM-ddTHH:mm:ssZ')) -Force
(`$m | ConvertTo-Json) | Out-File -Encoding utf8 `$jsonPath
if (`$mode -ne 'nobrief') { 'stub brief' | Out-File -Encoding utf8 (Join-Path `$dir 'brief.md') }
exit 0
"@ | Out-File -Encoding utf8 $stubPs

function Set-StubConf($poison, $mode) {
    $o = [PSCustomObject]@{ poison = @($poison); poisonMode = $mode }
    ($o | ConvertTo-Json) | Out-File -Encoding utf8 $stubConf
}
function Get-StubCalls {
    return @(Get-Content $stubCalls -ErrorAction SilentlyContinue | Where-Object { $_ -and $_.Trim() })
}
function Count-Calls($id) { return @(Get-StubCalls | Where-Object { $_ -eq $id }).Count }
Set-StubConf @() 'commit'

# ---- load watcher in test mode, then override every path ----
$CardCaptureWatcherTestMode = $true
. $watcherScript
$Inbox = $sbInbox
$Codex = $stubPs
$Vault = $sandbox
$LogFile = Join-Path $sbLog 'watcher.log'
$HealthFile = Join-Path $sbLog 'watcher-health.json'
$NotifyConf = Join-Path $sbLog 'notify.conf'
$Lock = Join-Path $sbInbox 'processing.lock'
$StateDir = $sbState
$WorkerId = 'worker-1'

function New-Capture($id, $status, $receivedAt) {
    $d = Join-Path $sbInbox $id
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    $meta = @{ captureId = $id; status = $status; capturer = 'test'; files = @('front.jpg') }
    if ($receivedAt) { $meta.receivedAt = $receivedAt }
    ($meta | ConvertTo-Json) | Out-File -Encoding utf8 (Join-Path $d 'capture.json')
    return $d
}
function Fp($id) { return (Get-CaptureFingerprint (Join-Path $sbInbox $id)) }
function ClaimFile($id) { return (Join-Path $sbClaims ($id + '.claim.json')) }
function ReadClaim($id) { return (Get-Content (ClaimFile $id) -Raw -Encoding UTF8 | ConvertFrom-Json) }
function StagingDir($id) { return (Join-Path (Join-Path $sbState 'staging') $id) }
function LogText { return (Get-Content $LogFile -Raw -ErrorAction SilentlyContinue) }

Write-Host '=== watcher protocol tests (FI-017 claim/lease, FI-018 staging/commit, FI-019 quarantine) ==='

# =====================================================================
# FI-017 — claim / lease / heartbeat / expiry
# =====================================================================
$null = New-Capture 'A0001' 'received' '2026-07-25T01:00:00Z'
$null = New-Capture 'A0002' 'received' '2026-07-25T02:00:00Z'

$claim1 = $null
TB 'FI-017 claim: 첫 워처가 claim을 얻는다' {
    $script:claim1 = New-CaptureClaim 'A0001' (Fp 'A0001')
    return ($null -ne $script:claim1)
}
TB 'FI-017 claim: claim 파일이 생성되고 owner가 기록된다' {
    return ((Test-Path (ClaimFile 'A0001')) -and (ReadClaim 'A0001').owner -eq 'worker-1')
}
TB 'FI-017 lease: 만료 시각이 미래다' {
    return ([datetime](ReadClaim 'A0001').leaseExpiresAt -gt (Get-Date))
}
TB 'FI-017 claim: 두 번째 워처는 거절된다 (한 항목 한 소유자)' {
    $WorkerId = 'worker-2'
    $c2 = New-CaptureClaim 'A0001' (Fp 'A0001')
    $WorkerId = 'worker-1'
    return ($null -eq $c2)
}
TB 'FI-017 claim: 거절된 워처는 기존 claim을 변형하지 않는다' {
    return ((ReadClaim 'A0001').owner -eq 'worker-1')
}
TB 'FI-017 heartbeat: 소유자는 lease를 갱신한다' {
    $before = [datetime](ReadClaim 'A0001').leaseExpiresAt
    Start-Sleep -Milliseconds 1100
    $ok = Update-CaptureLease $script:claim1
    $after = [datetime](ReadClaim 'A0001').leaseExpiresAt
    return ($ok -and ($after -gt $before))
}
TB 'FI-017 heartbeat: 비소유자 갱신은 실패하고 파일을 바꾸지 않는다' {
    $before = (Get-Content (ClaimFile 'A0001') -Raw -Encoding UTF8)
    $WorkerId = 'worker-2'
    $fake = [PSCustomObject]@{ captureId = 'A0001'; owner = 'worker-2' }
    $ok = Update-CaptureLease $fake
    $WorkerId = 'worker-1'
    $after = (Get-Content (ClaimFile 'A0001') -Raw -Encoding UTF8)
    return ((-not $ok) -and ($before -eq $after))
}
TB 'FI-017 expiry: 만료된 lease는 다른 워처가 회수한다' {
    $c = ReadClaim 'A0001'
    $c.leaseExpiresAt = (Get-Date).AddMinutes(-5).ToString('yyyy-MM-dd HH:mm:ss')
    ($c | ConvertTo-Json) | Out-File -Encoding utf8 (ClaimFile 'A0001')
    $WorkerId = 'worker-3'
    $script:claim3 = New-CaptureClaim 'A0001' (Fp 'A0001')
    $WorkerId = 'worker-1'
    return (($null -ne $script:claim3) -and ((ReadClaim 'A0001').owner -eq 'worker-3'))
}
TB 'FI-017 expiry: 회수 후에도 attempt 카운트가 보존된다' {
    return (([int]$script:claim3.attempt -eq 1) -and ([int]$script:claim3.attempt -eq [int]$script:claim1.attempt))
}
TB 'FI-017 fencing: 회수당한 옛 소유자의 갱신은 실패한다' {
    return (-not (Update-CaptureLease $script:claim1))
}
TB 'FI-017 fencing: 옛 소유자의 해제가 새 소유자 claim을 지우지 않는다' {
    Remove-CaptureClaim $script:claim1
    return ((Test-Path (ClaimFile 'A0001')) -and (ReadClaim 'A0001').owner -eq 'worker-3')
}
TB 'FI-017 정리: 소유자는 자기 claim을 해제한다' {
    Remove-CaptureClaim $script:claim3
    return (-not (Test-Path (ClaimFile 'A0001')))
}

# 실제 두 프로세스 경쟁 (원자성 증명)
$raceChild = Join-Path $sandbox 'race-child.ps1'
@"
param(`$worker)
`$CardCaptureWatcherTestMode = `$true
. '$watcherScript'
`$Inbox = '$sbInbox'
`$StateDir = '$sbState'
`$LogFile = '$sbLog\race.log'
`$WorkerId = `$worker
while (-not (Test-Path '$sandbox\race-gate.txt')) { Start-Sleep -Milliseconds 20 }
try {
  `$c = New-CaptureClaim 'A0002' 'race-fp'
  if (`$c) { Add-Content -Path '$sandbox\race-result.txt' -Value (`$worker + ' WON') }
  else { Add-Content -Path '$sandbox\race-result.txt' -Value (`$worker + ' LOST') }
} catch { Add-Content -Path '$sandbox\race-result.txt' -Value (`$worker + ' ERROR ' + `$_.Exception.Message) }
"@ | Out-File -Encoding utf8 $raceChild

$raceResult = Join-Path $sandbox 'race-result.txt'
$raceGate = Join-Path $sandbox 'race-gate.txt'
Remove-Item $raceResult, $raceGate -ErrorAction SilentlyContinue
$p1 = Start-Process powershell -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$raceChild`"", 'race-a' -PassThru -WindowStyle Hidden
$p2 = Start-Process powershell -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$raceChild`"", 'race-b' -PassThru -WindowStyle Hidden
Start-Sleep -Milliseconds 1500
'go' | Out-File -Encoding ascii $raceGate
Wait-Process -Id $p1.Id, $p2.Id -Timeout 90 -ErrorAction SilentlyContinue
$raceLines = @(Get-Content $raceResult -ErrorAction SilentlyContinue)
$won = @($raceLines | Where-Object { $_ -match 'WON' })
$lost = @($raceLines | Where-Object { $_ -match 'LOST' })
T ($won.Count -eq 1) ('FI-017 race: 실제 두 프로세스 중 정확히 하나만 claim (won=' + $won.Count + ' lost=' + $lost.Count + ' lines=' + ($raceLines -join '/') + ')')
T ($lost.Count -eq 1) 'FI-017 race: 나머지 하나는 깨끗한 non-owner 결과'
Remove-Item (ClaimFile 'A0002') -ErrorAction SilentlyContinue

# 처리 루프가 남의 live claim을 존중한다: A0001을 worker-2가 잡고 있으면 A0002를 처리한다
TB 'FI-017 loop: 워처는 타인이 claim한 캡처를 건너뛰고 다음 캡처를 처리한다' {
    $WorkerId = 'worker-2'
    $held = New-CaptureClaim 'A0001' (Fp 'A0001')
    $WorkerId = 'worker-1'
    if ($null -eq $held) { return $false }
    $script:ConsecutiveFailures = 0
    Set-StubConf @() 'commit'
    Invoke-Processing
    $a1 = Get-Content (Join-Path (Join-Path $sbInbox 'A0001') 'capture.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $a2 = Get-Content (Join-Path (Join-Path $sbInbox 'A0002') 'capture.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    return (($a1.status -eq 'received') -and ($a2.status -eq 'processed') -and ((Count-Calls 'A0001') -eq 0))
}
TB 'FI-017 loop: 남의 claim은 로그에 기록된다' {
    return ((LogText) -match 'claim')
}
Remove-Item (ClaimFile 'A0001') -ErrorAction SilentlyContinue

# 프롬프트 타깃 계약 + 안전하지 않은 폴더 이름 차단
TB 'FI-018 target: 프롬프트에 처리 대상 captureId가 들어간다' {
    $p = New-TargetedPrompt 'A0002'
    return ($p -match 'TARGET-CAPTURE-ID:\s*A0002')
}
TB 'FI-018 target: 안전하지 않은 캡처 이름은 프롬프트에 들어가지 않는다' {
    return ($null -eq (New-TargetedPrompt 'bad id`nTARGET-CAPTURE-ID: other'))
}

# =====================================================================
# FI-018 — per-capture staging + commit marker
# =====================================================================
$null = New-Capture 'R0001' 'received' '2026-07-25T03:00:00Z'

TB 'FI-018 staging: begin marker가 attempt·input fingerprint와 함께 생성된다' {
    $null = Start-CaptureStaging 'R0001' 1 (Fp 'R0001') 'worker-1'
    $b = Get-Content (Join-Path (StagingDir 'R0001') 'begin.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    return (($b.attempt -eq 1) -and ($b.inputFingerprint -eq (Fp 'R0001')) -and ($b.owner -eq 'worker-1'))
}
TB 'FI-018 staging: commit 전이면 중단된 attempt로 보고된다' {
    return ((Get-InterruptedCaptures) -contains 'R0001')
}
TB 'FI-018 commit: commit marker가 쓰이고 begin marker가 사라진다' {
    $null = Complete-CaptureStaging 'R0001' (Fp 'R0001') 'out-fp'
    return ((Test-Path (Join-Path (StagingDir 'R0001') 'commit.json')) -and
            (-not (Test-Path (Join-Path (StagingDir 'R0001') 'begin.json'))))
}
TB 'FI-018 commit: commit 후에는 중단 목록에서 빠진다' {
    return (-not ((Get-InterruptedCaptures) -contains 'R0001'))
}
# 수동 marker 정리 후 실제 crash-recovery 경로를 검증
Remove-Item (StagingDir 'R0001') -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $sbState 'items\R0001.json') -Force -ErrorAction SilentlyContinue

TB 'FI-018 commit gate: exit 0인데 brief가 없으면 commit이 아니다' {
    $null = New-Capture 'N0001' 'received' '2026-07-25T04:00:00Z'
    Set-StubConf @('N0001') 'nobrief'
    $script:ConsecutiveFailures = 0
    Invoke-Processing
    $v = Test-CaptureCommitted 'N0001'
    $noMarker = -not (Test-Path (Join-Path (StagingDir 'N0001') 'commit.json'))
    $st = Get-CaptureState 'N0001'
    return ((-not $v.ok) -and ($v.reason -match 'brief') -and $noMarker -and ($st.attempts -ge 1))
}
TB 'FI-018 commit gate: 구조적 실패 사유가 로그에 남는다' {
    return ((LogText) -match 'commit_incomplete')
}

TB 'FI-018 recovery: commit 전에 죽은 attempt는 회수 후 정확히 한 번 재처리된다' {
    # 이전 생의 워처: claim + begin marker만 남기고 죽음 (lease 만료)
    $null = New-Capture 'C0001' 'received' '2026-07-25T05:00:00Z'
    $WorkerId = 'dead-worker'
    $dead = New-CaptureClaim 'C0001' (Fp 'C0001')
    $null = Start-CaptureStaging 'C0001' 1 (Fp 'C0001') 'dead-worker'
    $c = ReadClaim 'C0001'
    $c.leaseExpiresAt = (Get-Date).AddMinutes(-10).ToString('yyyy-MM-dd HH:mm:ss')
    ($c | ConvertTo-Json) | Out-File -Encoding utf8 (ClaimFile 'C0001')
    $WorkerId = 'worker-1'
    if (-not ((Get-InterruptedCaptures) -contains 'C0001')) { return $false }
    Set-StubConf @() 'commit'
    $script:ConsecutiveFailures = 0
    Invoke-Processing
    $m = Get-Content (Join-Path (Join-Path $sbInbox 'C0001') 'capture.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $briefs = @(Get-ChildItem (Join-Path $sbInbox 'C0001') -Filter 'brief*.md')
    return (($m.status -eq 'processed') -and
            ($briefs.Count -eq 1) -and
            ((Count-Calls 'C0001') -eq 1) -and
            (Test-Path (Join-Path (StagingDir 'C0001') 'commit.json')) -and
            (-not (Test-Path (Join-Path (StagingDir 'C0001') 'begin.json'))))
}
TB 'FI-018 recovery: 중단된 attempt 회수가 로그에 남는다' {
    return ((LogText) -match 'interrupted')
}

TB 'FI-018 replay: commit 후 같은 입력은 다시 처리하지 않는다' {
    # 출력측 status만 되돌려도 입력 fingerprint가 같으면 재처리 대상이 아니다
    $p = Join-Path (Join-Path $sbInbox 'C0001') 'capture.json'
    $m = Get-Content $p -Raw -Encoding UTF8 | ConvertFrom-Json
    $m.status = 'received'
    ($m | ConvertTo-Json) | Out-File -Encoding utf8 $p
    $script:ConsecutiveFailures = 0
    Invoke-Processing
    return ((Count-Calls 'C0001') -eq 1)
}

TB 'FI-018 fencing: 실행 중 lease를 잃으면 commit marker를 쓰지 않는다' {
    $null = New-Capture 'S0001' 'received' '2026-07-25T06:00:00Z'
    Set-StubConf @('S0001') 'stealLease'
    $script:ConsecutiveFailures = 0
    Invoke-Processing
    $noMarker = -not (Test-Path (Join-Path (StagingDir 'S0001') 'commit.json'))
    $thiefKept = (Test-Path (ClaimFile 'S0001')) -and ((ReadClaim 'S0001').owner -eq 'thief-worker')
    return ($noMarker -and $thiefKept -and ((LogText) -match 'lease'))
}
Remove-Item (ClaimFile 'S0001') -ErrorAction SilentlyContinue

# =====================================================================
# FI-019 — poison quarantine + bounded retry
# =====================================================================
$maxA = 3
if ($MaxAttempts) { $maxA = [int]$MaxAttempts }

$null = New-Capture 'P0001' 'received' '2026-07-25T07:00:00Z'
$null = New-Capture 'Q0002' 'received' '2026-07-25T08:00:00Z'
Set-StubConf @('P0001') 'exit1'

TB 'FI-019 bounded retry: 나쁜 항목 하나가 큐 전체를 막지 않는다' {
    $script:ConsecutiveFailures = 0
    for ($i = 0; $i -lt 6; $i++) {
        $q = Get-Content (Join-Path (Join-Path $sbInbox 'Q0002') 'capture.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($q.status -eq 'processed') { break }
        Invoke-Processing
    }
    $q = Get-Content (Join-Path (Join-Path $sbInbox 'Q0002') 'capture.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    return ($q.status -eq 'processed')
}
TB 'FI-019 bounded retry: poison 항목은 정확히 MaxAttempts번만 시도된다' {
    return ((Count-Calls 'P0001') -eq $maxA)
}
TB 'FI-019 quarantine: 소진된 항목은 감사 가능한 격리 상태가 된다' {
    $st = Get-CaptureState 'P0001'
    return (($st.quarantined -eq $true) -and ($st.attempts -eq $maxA) -and ($st.quarantineReason))
}
TB 'FI-019 quarantine: 격리 항목은 backlog에서 빠진다' {
    $bl = Get-Backlog
    return (@($bl | Where-Object { $_.id -eq 'P0001' }).Count -eq 0)
}
TB 'FI-019 quarantine: 캡처는 유실되지 않고 received로 남는다' {
    $m = Get-Content (Join-Path (Join-Path $sbInbox 'P0001') 'capture.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    return ($m.status -eq 'received')
}
TB 'FI-019 quarantine: 격리 후 추가 트리거는 재시도하지 않는다' {
    $script:ConsecutiveFailures = 0
    Invoke-Processing
    Invoke-Processing
    return ((Count-Calls 'P0001') -eq $maxA)
}
TB 'FI-019 health: 격리 건수가 health에 노출된다' {
    Write-Health
    $h = Get-Content $HealthFile -Raw -Encoding UTF8 | ConvertFrom-Json
    return ($h.quarantinedCount -eq 1)
}
TB 'FI-019 requeue: 기존 requeue 표식(receivedAt 갱신)이 격리를 해제한다' {
    $p = Join-Path (Join-Path $sbInbox 'P0001') 'capture.json'
    $m = Get-Content $p -Raw -Encoding UTF8 | ConvertFrom-Json
    $m.receivedAt = '2026-07-26T09:00:00Z'
    $m | Add-Member -NotePropertyName requeueRequested -NotePropertyValue $true -Force
    ($m | ConvertTo-Json) | Out-File -Encoding utf8 $p
    $released = -not (Test-CaptureQuarantined 'P0001' (Fp 'P0001'))
    $idempotent = -not (Test-CaptureQuarantined 'P0001' (Fp 'P0001'))
    $st = Get-CaptureState 'P0001'
    return ($released -and $idempotent -and ($st.attempts -eq 0) -and ($st.quarantined -ne $true))
}
TB 'FI-019 requeue: 해제 후 정상 처리된다' {
    Set-StubConf @() 'commit'
    $script:ConsecutiveFailures = 0
    Invoke-Processing
    $m = Get-Content (Join-Path (Join-Path $sbInbox 'P0001') 'capture.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    return ($m.status -eq 'processed')
}
TB 'FI-019 안전: 이름이 안전하지 않은 캡처 폴더는 처리 대상에서 제외된다' {
    $bad = Join-Path $sbInbox 'evil; rm -rf'
    New-Item -ItemType Directory -Force -Path $bad | Out-Null
    '{"captureId":"evil","status":"received","receivedAt":"2026-07-26T10:00:00Z"}' |
        Out-File -Encoding utf8 (Join-Path $bad 'capture.json')
    $bl = Get-Backlog
    return (@($bl | Where-Object { $_.id -match 'evil' }).Count -eq 0)
}

# =====================================================================
# FI-019 재충전 경계 (TSK-000291)
#   판정: 사람이 입력을 실제로 고쳐 다시 보낸 것에 새 시도 예산을 주는 것은 설계다 — 결함이 아니다.
#         (워처 주석 계약: '웹앱에서 다시 보내면(receivedAt 갱신) 자동 해제된다')
#         서버(Code.gs sameAsStoredUpload_)가 똑같은 내용 재전송을 dedup해 capture.json을 다시
#         쓰지 않으므로 receivedAt이 갱신되지 않는다 = blind 재전송은 재충전 경로가 아니다.
#   결함은 '사람 개입 없이' 예산이 재충전되는 경로다. 아래가 그 경계를 고정한다.
# =====================================================================
$null = New-Capture 'Z0001' 'received' '2026-07-25T09:00:00Z'
$null = New-Capture 'Z0009' 'received' '2026-07-25T09:30:00Z'
Set-StubConf @('Z0001') 'exit1'

function ZPath { return (Join-Path (Join-Path $sbInbox 'Z0001') 'capture.json') }
function ZMeta { return (Get-Content (ZPath) -Raw -Encoding UTF8 | ConvertFrom-Json) }
function ZWrite($m) { ($m | ConvertTo-Json) | Out-File -Encoding utf8 (ZPath) }
# 격리될 때까지 트리거를 반복한다 (실패마다 루프가 break하므로 트리거가 여러 번 필요하다).
function Invoke-UntilQuarantined {
    for ($i = 0; $i -lt 8; $i++) {
        $st = Get-CaptureState 'Z0001'
        if ($st.quarantined -eq $true) { break }
        $script:ConsecutiveFailures = 0
        Invoke-Processing
    }
}

TB 'FI-019 recharge: 출발점 — poison 항목이 MaxAttempts 소진 후 격리된다' {
    Invoke-UntilQuarantined
    $st = Get-CaptureState 'Z0001'
    return (($st.quarantined -eq $true) -and ([int]$st.attempts -eq $maxA) -and ((Count-Calls 'Z0001') -eq $maxA))
}

TB 'FI-019 recharge: 처리기가 쓰는 출력 필드는 입력 fingerprint를 바꾸지 않는다 (자동 재충전 없음)' {
    # codex 처리기와 quick-pass(contact)가 capture.json에 쓰는 필드는 전부 출력측이다.
    # 하나라도 입력 fingerprint에 들어가면 '처리를 시도했다'는 사실만으로 지문이 달라져
    # 사람 개입 없이 예산이 재충전된다 = 무한 재시도. 지문이 그대로인지 직접 비교한다
    # (격리 유지만 보면 값이 우연히 같을 때 게이트가 통과해 버린다).
    $fpBefore = Fp 'Z0001'
    $m = ZMeta
    foreach ($kv in @(@('processedAt', '2026-07-25T10:00:00Z'), @('person', 'PER-000999'),
                      @('personAction', 'updated'), @('processedBy', 'stub'), @('reviewStatus', 'agent_checked'))) {
        $m | Add-Member -NotePropertyName $kv[0] -NotePropertyValue $kv[1] -Force
    }
    $m | Add-Member -NotePropertyName contact -NotePropertyValue ([PSCustomObject]@{ name = 'quick-extract' }) -Force
    ZWrite $m
    $fpAfter = Fp 'Z0001'
    $held = Test-CaptureQuarantined 'Z0001' $fpAfter
    $st = Get-CaptureState 'Z0001'
    return (($fpBefore -ne '') -and ($fpAfter -eq $fpBefore) -and $held -and
            ([int]$st.attempts -eq $maxA) -and ((Count-Calls 'Z0001') -eq $maxA))
}

TB 'FI-019 recharge: 입력 fingerprint를 읽지 못하면 격리를 해제하지 않는다 (fail-closed)' {
    # Drive 동기화 중 부분 기록·파싱 실패면 Get-CaptureFingerprint가 ''를 낸다.
    # ''는 '입력이 달라졌다'가 아니라 '지금은 알 수 없다'다. 이걸 새 입력으로 취급하면
    # capture.json을 한 번 못 읽을 때마다 사람 개입 없이 MaxAttempts가 재충전된다.
    $good = Get-Content (ZPath) -Raw -Encoding UTF8
    # raw에는 status=received가 그대로 보이지만 JSON 파싱은 실패하는 부분 기록 상태
    '{"captureId":"Z0001","status":"received","receivedAt":"2026-07-25T09:00:00Z","files":["front.jpg"' |
        Out-File -Encoding utf8 (ZPath)
    $unknownFp = (Fp 'Z0001')
    $held = Test-CaptureQuarantined 'Z0001' $unknownFp
    $st = Get-CaptureState 'Z0001'
    $queued = @((Get-Backlog) | Where-Object { $_.id -eq 'Z0001' }).Count
    $good | Out-File -Encoding utf8 (ZPath)
    return (($unknownFp -eq '') -and $held -and ([int]$st.attempts -eq $maxA) -and ($queued -eq 0))
}

TB 'FI-019 recharge: 읽기 실패 뒤 파일이 정상으로 돌아와도 격리가 그대로다' {
    $st = Get-CaptureState 'Z0001'
    return ((Test-CaptureQuarantined 'Z0001' (Fp 'Z0001')) -and ([int]$st.attempts -eq $maxA))
}

TB 'FI-019 recharge: 진짜 입력 변경은 예산을 정확히 MaxAttempts만큼만 재충전한다' {
    # 사람이 note를 고쳐 다시 보낸 경우 = 새 입력. 새 예산을 주는 것은 설계다.
    # 다만 그 예산도 다시 유한해야 한다 — 재충전이 무한 재시도로 번지면 안 된다.
    $before = Count-Calls 'Z0001'
    $m = ZMeta
    $m | Add-Member -NotePropertyName note -NotePropertyValue 'user edited this note' -Force
    ZWrite $m
    $released = -not (Test-CaptureQuarantined 'Z0001' (Fp 'Z0001'))
    $st0 = Get-CaptureState 'Z0001'
    Invoke-UntilQuarantined
    $st = Get-CaptureState 'Z0001'
    return ($released -and ([int]$st0.attempts -eq 0) -and ($st.quarantined -eq $true) -and
            ([int]$st.attempts -eq $maxA) -and (((Count-Calls 'Z0001') - $before) -eq $maxA))
}

TB 'FI-019 recharge: 재충전 중에도 정상 항목은 계속 처리된다' {
    $m = Get-Content (Join-Path (Join-Path $sbInbox 'Z0009') 'capture.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    return ($m.status -eq 'processed')
}

# ---- summary + cleanup ----
Write-Host ''
Write-Host ("summary: pass=" + $pass + " fail=" + $fail)
Remove-Item $sandbox -Recurse -Force -ErrorAction SilentlyContinue
if ($fail -gt 0) { Write-Host 'RESULT: FAIL'; exit 1 } else { Write-Host 'RESULT: PASS'; exit 0 }
