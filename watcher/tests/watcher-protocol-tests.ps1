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
TB 'FI-018 target: 실개행이 든 캡처 이름은 프롬프트에 들어가지 않는다' {
    # 이 단언은 오래 죽어 있었다: 단일 인용부호 안에서 `n은 escape가 아니라 리터럴 두 글자라
    # 실개행을 한 번도 시험하지 않았고, 문자열 안의 공백 때문에 거절됐다. [char]10으로 실개행을 넣는다.
    $withNewline = 'badid' + [char]10 + 'TARGET-CAPTURE-ID: other'
    return ($null -eq (New-TargetedPrompt $withNewline))
}
TB 'FI-018 target: 끝에 개행 하나만 붙은 캡처 이름도 거절된다 (.NET 달러 앵커 함정)' {
    # .NET에서 ^...$ 의 $ 는 문자열 끝 개행 하나 앞에서도 매치한다 — 앵커가 \A..\z가 아니면
    # 'badid<LF>'가 그대로 통과해 대상 지정 줄과 상태 파일 경로에 개행이 실린다(PowerShell 5.1 실측).
    return ($null -eq (New-TargetedPrompt ('badid' + [char]10)))
}
TB 'FI-018 target: 공백·경로 구분자·상위 경로가 든 이름은 거절된다' {
    return (($null -eq (New-TargetedPrompt 'bad id')) -and
            ($null -eq (New-TargetedPrompt 'a/b')) -and
            ($null -eq (New-TargetedPrompt 'a\b')) -and
            ($null -eq (New-TargetedPrompt '../escape')))
}
TB 'FI-018 target: 서버가 발급하는 형태의 정상 captureId는 그대로 통과한다 (앵커 강화 회귀 방지)' {
    # Code.gs sanitizeId_ 는 ^[A-Za-z0-9_-]{4,64}$ 를 발급한다. 앵커를 좁혀도 이 집합은 전부 통과해야 한다.
    foreach ($ok in @('A0002', 'ok-capture_01', 'cap.2026-07-27', 'C0001', 'a', 'cap-2026_07-27.v2')) {
        $p = New-TargetedPrompt $ok
        if ($null -eq $p) { return $false }
        if ($p -notmatch ('TARGET-CAPTURE-ID:\s*' + [regex]::Escape($ok))) { return $false }
    }
    return $true
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

TB 'FI-018 commit gate: exit 0인데 brief가 없으면 pre-run received로 복구된다' {
    $null = New-Capture 'N0001' 'received' '2026-07-25T04:00:00Z'
    Set-StubConf @('N0001') 'nobrief'
    $script:ConsecutiveFailures = 0
    Invoke-Processing
    $v = Test-CaptureCommitted 'N0001'
    $m = Get-Content (Join-Path (Join-Path $sbInbox 'N0001') 'capture.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $eligibility = Get-CaptureEligibility (Get-Item (Join-Path $sbInbox 'N0001'))
    $noMarker = -not (Test-Path (Join-Path (StagingDir 'N0001') 'commit.json'))
    $st = Get-CaptureState 'N0001'
    return ((-not $v.ok) -and $m.status -eq 'received' -and $eligibility.eligible -and $noMarker -and ($st.attempts -ge 1))
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

# ---- APP-AC-239 Deep Research: lane / checkpoint / evidence graph ----
$deepInbox = Join-Path $sandbox 'deep-inbox'
New-Item -ItemType Directory -Force -Path $deepInbox | Out-Null
$Inbox = $deepInbox

function New-DeepFixture($id, $mode, $status) {
    $d = Join-Path $deepInbox $id
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    $m = [PSCustomObject]@{
        captureId = $id
        status = $status
        receivedAt = '2026-07-25T09:00:00Z'
        files = @('front.jpg')
    }
    if ($mode) {
        $m | Add-Member -NotePropertyName type -NotePropertyValue 'research_instruction' -Force
        $m | Add-Member -NotePropertyName researchInstruction -NotePropertyValue ([PSCustomObject]@{ mode = $mode }) -Force
    }
    ($m | ConvertTo-Json -Depth 8) | Out-File -Encoding utf8 (Join-Path $d 'capture.json')
    return $d
}

$null = New-DeepFixture 'A9001' 'deep_evidence_graph' 'received'
$null = New-DeepFixture 'B9001' 'standard' 'received'
$null = New-DeepFixture 'Z9001' $null 'received'

TB 'APP-AC-239 lane: 일반 캡처가 더 오래된 Deep Research보다 먼저다' {
    return ((Get-NextEligibleCapture @{}).id -eq 'Z9001')
}
TB 'APP-AC-239 lane: 일반 캡처 다음은 표준 조사다' {
    return ((Get-NextEligibleCapture @{ Z9001 = $true }).id -eq 'B9001')
}
TB 'APP-AC-239 lane: Deep Research는 마지막 lane이다' {
    return ((Get-NextEligibleCapture @{ Z9001 = $true; B9001 = $true }).id -eq 'A9001')
}

TB 'APP-AC-239 checkpoint: partial processing은 terminal commit 없이 다음 slice 권한을 만든다' {
    $p = Join-Path (Join-Path $deepInbox 'A9001') 'capture.json'
    $m = Get-Content $p -Raw -Encoding UTF8 | ConvertFrom-Json
    $m.status = 'processing'
    $m | Add-Member -NotePropertyName researchProgress -NotePropertyValue ([PSCustomObject]@{
        phase = 'planning'; partial = $true; updatedAt = '2026-07-25T09:01:00Z'
        verifiedFacts = 0; conflicts = 0; openQuestions = 1
        branchCount = 1; sourceCount = 2; elapsedMinutes = 8
    }) -Force
    ($m | ConvertTo-Json -Depth 8) | Out-File -Encoding utf8 $p
    if (-not (Save-ResearchBudgetCharge 'A9001' $null 8)) { return $false }
    $v = Test-CaptureCommitted 'A9001' 8
    if ($v.ok) { $null = Save-ResearchBudgetSnapshot 'A9001' $m.researchProgress $v.watcherElapsedMinutes }
    return ($v.ok -and $v.partial -and $v.reason -eq 'research_checkpoint' -and $v.watcherElapsedMinutes -eq 8)
}

TB 'APP-AC-239 checkpoint: 같은 phase 반복은 진행량을 늘려도 fail-closed다' {
    $p = Join-Path (Join-Path $deepInbox 'A9001') 'capture.json'
    $m = Get-Content $p -Raw -Encoding UTF8 | ConvertFrom-Json
    $m.researchProgress.elapsedMinutes = 9
    $m.researchProgress.sourceCount = 3
    ($m | ConvertTo-Json -Depth 8) | Out-File -Encoding utf8 $p
    $v = Test-CaptureCommitted 'A9001' 1
    return ((-not $v.ok) -and $v.reason -eq 'research_phase_not_next')
}

TB 'APP-AC-239 checkpoint: counter 없는 partial은 fail-closed다' {
    $p = Join-Path (Join-Path $deepInbox 'A9001') 'capture.json'
    $m = Get-Content $p -Raw -Encoding UTF8 | ConvertFrom-Json
    $m.researchProgress.PSObject.Properties.Remove('sourceCount')
    ($m | ConvertTo-Json -Depth 8) | Out-File -Encoding utf8 $p
    $v = Test-CaptureCommitted 'A9001' 1
    return ((-not $v.ok) -and $v.reason -eq 'bad_research_counter_sourceCount')
}

$finalDir = New-DeepFixture 'D9001' 'deep_evidence_graph' 'processed'
$finalMetaPath = Join-Path $finalDir 'capture.json'
$finalMeta = Get-Content $finalMetaPath -Raw -Encoding UTF8 | ConvertFrom-Json
$finalMeta | Add-Member -NotePropertyName person -NotePropertyValue 'PER-000001' -Force
($finalMeta | ConvertTo-Json -Depth 8) | Out-File -Encoding utf8 $finalMetaPath
'synthetic brief' | Out-File -Encoding utf8 (Join-Path $finalDir 'brief.md')
$validGraph = [PSCustomObject]@{
    version = 'deep-research-evidence-v1'
    purposes = @('meeting_preparation')
    nodes = @(
        [PSCustomObject]@{ id = 'person-1'; type = 'person'; label = '합성 대상 인물' },
        [PSCustomObject]@{ id = 'org-1'; type = 'organization'; label = '합성 조직' },
        [PSCustomObject]@{ id = 'project-1'; type = 'project'; label = '합성 프로젝트' },
        [PSCustomObject]@{ id = 'event-1'; type = 'event'; label = '합성 사건' },
        [PSCustomObject]@{ id = 'claim-1'; type = 'claim'; label = '합성 검증 사실' },
        [PSCustomObject]@{ id = 'source-1'; type = 'source'; label = '합성 출처 A'; url = 'https://example.test/source-a' }
    )
    edges = @(
        [PSCustomObject]@{ id = 'edge-support-1'; sourceId = 'source-1'; targetId = 'claim-1'; relation = 'supports'; label = '주장을 뒷받침' },
        [PSCustomObject]@{ id = 'edge-affiliation-1'; sourceId = 'person-1'; targetId = 'org-1'; relation = 'affiliated_with'; label = '소속' },
        [PSCustomObject]@{ id = 'edge-project-1'; sourceId = 'person-1'; targetId = 'project-1'; relation = 'worked_on'; label = '프로젝트 참여' },
        [PSCustomObject]@{ id = 'edge-event-1'; sourceId = 'person-1'; targetId = 'event-1'; relation = 'participated_in'; label = '사건 참여' }
    )
    claims = @([PSCustomObject]@{
        id = 'claim-1'; state = 'fact'; summary = '합성 검증 사실'; confidence = 'high'
        evidenceFor = @([PSCustomObject]@{ sourceId = 'source-1'; title = '합성 출처 A'; url = 'https://example.test/source-a'; publishedAt = '2026-01-01' }); evidenceAgainst = @()
    })
    timeline = @([PSCustomObject]@{ date = '2026-01'; label = '합성 사건'; claimIds = @('claim-1') })
    openQuestions = @('추가 확인 질문')
    metrics = [PSCustomObject]@{ branchCount = 4; sourceCount = 6; elapsedMinutes = 24 }
    stop = [PSCustomObject]@{ reason = 'purpose_satisfied'; summary = '합성 목적을 충족했다' }
}
($validGraph | ConvertTo-Json -Depth 10) | Out-File -Encoding utf8 (Join-Path $finalDir 'research-result.json')
$finalPriorProgress = [PSCustomObject]@{
    phase = 'synthesizing'; branchCount = 3; sourceCount = 4; elapsedMinutes = 18; updatedAt = '2026-07-25T09:18:00Z'
}
$null = Save-ResearchBudgetSnapshot 'D9001' $finalPriorProgress 18

TB 'APP-AC-239 final: 선행 synthesizing checkpoint 없는 final은 fail-closed다' {
    $budgetPath = Resolve-ResearchBudgetPath 'D9001'
    Remove-Item $budgetPath -Force -ErrorAction SilentlyContinue
    $v = Test-CaptureCommitted 'D9001' 6
    $null = Save-ResearchBudgetSnapshot 'D9001' $finalPriorProgress 18
    return ((-not $v.ok) -and $v.reason -eq 'research_final_without_synthesizing_checkpoint')
}

TB 'APP-AC-239 final: 근거가 있는 evidence graph만 terminal commit이다' {
    $prior = Get-ResearchBudgetSnapshot 'D9001'
    if (-not (Save-ResearchBudgetCharge 'D9001' $prior 24)) { return $false }
    $v = Test-CaptureCommitted 'D9001' 6
    return ($v.ok -and -not $v.partial -and $v.reason -eq 'ok')
}
TB 'APP-AC-239 final: 근거 없는 fact는 fail-closed다' {
    $bad = Get-Content (Join-Path $finalDir 'research-result.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $bad.claims[0].evidenceFor = @()
    ($bad | ConvertTo-Json -Depth 10) | Out-File -Encoding utf8 (Join-Path $finalDir 'research-result.json')
    $v = Test-CaptureCommitted 'D9001' 6
    return ((-not $v.ok) -and $v.reason -eq 'unsupported_fact')
}
TB 'APP-AC-239 final: 문자열 evidence는 UI 계약과 달라 fail-closed다' {
    $bad = $validGraph | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $bad.claims[0].evidenceFor = @('https://example.test/not-an-evidence-object')
    ($bad | ConvertTo-Json -Depth 10) | Out-File -Encoding utf8 (Join-Path $finalDir 'research-result.json')
    $v = Test-CaptureCommitted 'D9001' 6
    return ((-not $v.ok) -and $v.reason -eq 'bad_research_evidence_link')
}
TB 'APP-AC-239 final: dangling relationship edge는 fail-closed다' {
    $bad = $validGraph | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $bad.edges[1].targetId = 'missing-node'
    ($bad | ConvertTo-Json -Depth 10) | Out-File -Encoding utf8 (Join-Path $finalDir 'research-result.json')
    $v = Test-CaptureCommitted 'D9001' 6
    return ((-not $v.ok) -and $v.reason -eq 'bad_research_edge')
}
TB 'APP-AC-239 final: 누적 90분이면 time_cap stop reason이 필수다' {
    $nearCap = [PSCustomObject]@{ phase = 'synthesizing'; branchCount = 3; sourceCount = 4; elapsedMinutes = 84; updatedAt = '2026-07-25T09:18:00Z' }
    $null = Save-ResearchBudgetSnapshot 'D9001' $nearCap 84
    $null = Save-ResearchBudgetCharge 'D9001' (Get-ResearchBudgetSnapshot 'D9001') 90
    $bad = $validGraph | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $bad.metrics.elapsedMinutes = 90
    ($bad | ConvertTo-Json -Depth 10) | Out-File -Encoding utf8 (Join-Path $finalDir 'research-result.json')
    $v = Test-CaptureCommitted 'D9001' 6
    return ((-not $v.ok) -and $v.reason -eq 'research_time_cap_reason_required')
}
TB 'APP-AC-239 final: time_cap은 실제 누적 상한과 함께면 통과한다' {
    $nearCap = [PSCustomObject]@{ phase = 'synthesizing'; branchCount = 3; sourceCount = 4; elapsedMinutes = 84; updatedAt = '2026-07-25T09:18:00Z' }
    $null = Save-ResearchBudgetSnapshot 'D9001' $nearCap 84
    $null = Save-ResearchBudgetCharge 'D9001' (Get-ResearchBudgetSnapshot 'D9001') 90
    $capped = $validGraph | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $capped.metrics.elapsedMinutes = 90
    $capped.stop.reason = 'time_cap'
    $capped.stop.summary = '합성 시간 상한 도달'
    ($capped | ConvertTo-Json -Depth 10) | Out-File -Encoding utf8 (Join-Path $finalDir 'research-result.json')
    $v = Test-CaptureCommitted 'D9001' 6
    return ($v.ok -and $v.reason -eq 'ok')
}
TB 'APP-AC-239 final: 시간·분기 상한이 동시에 닿아도 정직한 cap 사유 하나로 종료한다' {
    $nearCap = [PSCustomObject]@{ phase = 'synthesizing'; branchCount = 23; sourceCount = 4; elapsedMinutes = 84; updatedAt = '2026-07-25T09:18:00Z' }
    $null = Save-ResearchBudgetSnapshot 'D9001' $nearCap 84
    $null = Save-ResearchBudgetCharge 'D9001' (Get-ResearchBudgetSnapshot 'D9001') 90
    $capped = $validGraph | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $capped.metrics.elapsedMinutes = 90
    $capped.metrics.branchCount = 24
    $capped.stop.reason = 'branch_cap'
    $capped.stop.summary = '합성 분기·시간 상한 동시 도달'
    ($capped | ConvertTo-Json -Depth 10) | Out-File -Encoding utf8 (Join-Path $finalDir 'research-result.json')
    $v = Test-CaptureCommitted 'D9001' 6
    return ($v.ok -and $v.reason -eq 'ok')
}
TB 'APP-AC-239 budget: 실패·timeout 시간도 누적되고 90분이면 다음 spawn 예산이 0이다' {
    $budgetId = 'E9001'
    $progress = [PSCustomObject]@{ phase = 'synthesizing'; branchCount = 3; sourceCount = 4; elapsedMinutes = 84; updatedAt = '2026-07-25T09:18:00Z' }
    if (-not (Save-ResearchBudgetSnapshot $budgetId $progress 84)) { return $false }
    $prior = Get-ResearchBudgetSnapshot $budgetId
    if (-not (Save-ResearchBudgetCharge $budgetId $prior 90)) { return $false }
    $after = Get-ResearchBudgetSnapshot $budgetId
    return ([double]$after.watcherElapsedMinutes -eq 90 -and (Get-ResearchRemainingSeconds $budgetId) -eq 0)
}
TB 'APP-AC-239 budget: 첫 launch failure도 checkpoint 없는 durable 시간으로 남는다' {
    $budgetId = 'F9001'
    if (-not (Save-ResearchBudgetCharge $budgetId $null 1.5)) { return $false }
    $after = Get-ResearchBudgetSnapshot $budgetId
    return ($after.hasCheckpoint -eq $false -and [double]$after.watcherElapsedMinutes -eq 1.5 -and
            (Get-ResearchRemainingSeconds $budgetId) -eq (($DeepTotalTimeCapMinutes - 1.5) * 60))
}
TB 'APP-AC-239 rollback: 이미지·correction·unexpected 파일까지 pre-run truth로 정확히 복구된다' {
    [System.IO.File]::WriteAllBytes((Join-Path $finalDir 'front.jpg'), [byte[]](1,2,3,4))
    '{"correction":"keep"}' | Out-File -Encoding utf8 (Join-Path $finalDir 'correction.json')
    $snapshot = Get-DeepWorkspaceSnapshot $finalDir
    if (-not (Save-DeepRollbackBackup 'D9001' $snapshot)) { return $false }
    '{"status":"processed","person":"POISON"}' | Out-File -Encoding utf8 $finalMetaPath
    'poison brief' | Out-File -Encoding utf8 (Join-Path $finalDir 'brief.md')
    '{"version":"poison"}' | Out-File -Encoding utf8 (Join-Path $finalDir 'research-result.json')
    [System.IO.File]::WriteAllBytes((Join-Path $finalDir 'front.jpg'), [byte[]](9,9,9))
    Remove-Item (Join-Path $finalDir 'correction.json') -Force
    'unexpected' | Out-File -Encoding utf8 (Join-Path $finalDir 'junk.md')
    if (Test-DeepWorkspaceMutationAllowed $finalDir $snapshot) { return $false }
    if (-not (Restore-DeepRollbackBackup 'D9001' $finalDir)) { return $false }
    $after = Get-DeepWorkspaceSnapshot $finalDir
    if (@($after).Count -ne @($snapshot).Count) { return $false }
    $expected = @{}
    foreach ($entry in @($snapshot)) {
        $expected[$entry.name] = if ($entry.kind -eq 'file') { [Convert]::ToBase64String([byte[]]$entry.bytes) } else { 'directory' }
    }
    foreach ($entry in @($after)) {
        $actual = if ($entry.kind -eq 'file') { [Convert]::ToBase64String([byte[]]$entry.bytes) } else { 'directory' }
        if ($expected[$entry.name] -ne $actual) { return $false }
    }
    return (-not (Test-Path (Join-Path $finalDir 'junk.md')))
}
TB 'APP-AC-239 runtime: Deep slice process tree와 stream drain을 wall-clock 상한에서 실제 종료한다' {
    $oldMode = $CardCaptureWatcherTestMode
    $oldCodex = $Codex
    $oldTimeout = $DeepSliceTimeoutSeconds
    $oldVault = $Vault
    $oldArguments = $BoundedProcessorTestArguments
    try {
        $CardCaptureWatcherTestMode = $false
        $Codex = 'powershell.exe'
        $BoundedProcessorTestArguments = '-NoProfile -Command "$child=Start-Process powershell.exe -ArgumentList ''-NoProfile'',''-Command'',''Start-Sleep -Seconds 8'' -PassThru -WindowStyle Hidden; Start-Sleep -Seconds 8"'
        $DeepSliceTimeoutSeconds = 1
        $Vault = $sandbox
        $timer = [System.Diagnostics.Stopwatch]::StartNew()
        $bounded = Invoke-BoundedDeepProcessor '합성 timeout prompt' (Join-Path $sbLog 'timeout.log')
        $timer.Stop()
        Write-Host ('  bounded timeout probe: exit=' + $bounded.exit + ' timedOut=' + $bounded.timedOut + ' elapsed=' + [math]::Round($timer.Elapsed.TotalSeconds, 2) + 's')
        Get-Content $LogFile -Tail 2 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host ('  log: ' + $_) }
        return ($bounded.timedOut -and [int]$bounded.exit -eq 124 -and $timer.Elapsed.TotalSeconds -lt 5)
    } finally {
        $CardCaptureWatcherTestMode = $oldMode
        $Codex = $oldCodex
        $DeepSliceTimeoutSeconds = $oldTimeout
        $Vault = $oldVault
        $BoundedProcessorTestArguments = $oldArguments
    }
}

# 2026-08-05 CI에서 위 게이트가 한 판만 이렇게 실패했다 (같은 commit 재실행은 통과):
#   bounded processor launch error: Exception calling "Assign" with "1" argument(s): "Access is denied"
#   exit=-1 timedOut=False elapsed=14.44s
# `AssignProcessToJobObject`는 **이미 죽은 프로세스**에 대해 ERROR_ACCESS_DENIED를 준다. 원인은
# `New-DeepProcessTreeJob`이 첫 호출에서 `Add-Type`으로 C#을 컴파일하는데 그 호출이 `Start()`
# **뒤에** 있었던 것 — 느린 기계에서 그 수 초 동안 8초짜리 자식이 먼저 죽었다.
#
# 컴파일은 창 밖으로 뺐지만 창 자체는 남는다. 그래서 남은 창에서 프로세스가 죽는 경우를
# 여기서 못 박는다: **담을 프로세스가 없는 것은 봉쇄 실패가 아니다.** 이 게이트가 없으면 그
# 구분은 다음에 또 launch error로 둔갑하고, 사람이 재실행으로 판정하게 된다.
TB 'APP-AC-239 containment: 처리기가 담기기도 전에 끝나면 봉쇄 실패가 아니라 정상 종료다' {
    $oldMode = $CardCaptureWatcherTestMode
    $oldCodex = $Codex
    $oldTimeout = $DeepSliceTimeoutSeconds
    $oldVault = $Vault
    $oldArguments = $BoundedProcessorTestArguments
    $oldDelay = $BoundedProcessorContainmentDelayMs
    try {
        $CardCaptureWatcherTestMode = $false
        $Codex = 'powershell.exe'
        # 즉시 끝나는 처리기 + 벌어진 창. 둘을 합치면 `Assign` 시점에 프로세스는 **반드시** 죽어 있다.
        # 우연을 기다리지 않고 그 조건을 직접 만든다 — 환경이 친절할 때만 초록인 게이트는 게이트가 아니다.
        $BoundedProcessorTestArguments = '-NoProfile -Command "exit 7"'
        $BoundedProcessorContainmentDelayMs = 1500
        $DeepSliceTimeoutSeconds = 30
        $Vault = $sandbox
        $bounded = Invoke-BoundedDeepProcessor '합성 즉시 종료 prompt' (Join-Path $sbLog 'instant.log')
        Write-Host ('  instant-exit probe: exit=' + $bounded.exit + ' timedOut=' + $bounded.timedOut)
        # 처리기가 스스로 준 종료 코드가 그대로 올라와야 한다. `-1`(launch error)이면 봉쇄 계층이
        # 정상 경로를 삼킨 것이다 — catch를 지우면 정확히 그렇게 실패한다(확인함).
        return ((-not $bounded.timedOut) -and [int]$bounded.exit -eq 7)
    } finally {
        $CardCaptureWatcherTestMode = $oldMode
        $Codex = $oldCodex
        $DeepSliceTimeoutSeconds = $oldTimeout
        $Vault = $oldVault
        $BoundedProcessorTestArguments = $oldArguments
        $BoundedProcessorContainmentDelayMs = $oldDelay
    }
}

# ISS-000232의 실제 원인. 2026-08-04에 처리기 raw 로그가 아직 살아 있는 상태로 재현돼 확정됐다:
# 세 번의 시도가 전부 `Failed to read prompt from stdin: input is not valid UTF-8
# (invalid byte at offset 0)`이었다. 프롬프트를 stdin으로 넘길 때 인코딩이 UTF-8이 아니었고,
# 조사 프롬프트 첫 글자가 한글이라 offset 0에서 바로 깨졌다. 원인은 `StandardInputEncoding`이
# .NET Framework(=Windows PowerShell 5.1)에 없는 속성이라는 것 — 대입이 던지고 `catch {}`가
# 삼켜서 아무도 몰랐다. 이 게이트는 "무엇을 설정했는가"가 아니라 **처리기가 실제로 받은 바이트**를
# 본다. 설정 방식을 바꿔도 계약이 지켜지는지 그것만이 판정 기준이다.
#
# 게이트는 **주변 환경을 믿지 않고 스스로 적대적인 조건을 만든다.** 첫 판은 개발 PC에서 통과하고
# CI에서만 실패했다 — runner의 `Console.InputEncoding`이 BOM 있는 UTF-8이라 .NET이 StandardInput을
# 만들며 켜는 `AutoFlush`가 우리가 쓰기도 전에 `EF BB BF`를 파이프로 흘렸기 때문이다(72→75바이트).
# 그래서 여기서 그 상태를 직접 만들어 놓고 잰다. 환경이 우연히 친절할 때 초록으로 보이는 게이트는
# 게이트가 아니다.
TB 'ISS-000232 stdin: 처리기가 받는 프롬프트 바이트가 한글에서도 정확히 UTF-8이다' {
    $oldMode = $CardCaptureWatcherTestMode
    $oldCodex = $Codex
    $oldTimeout = $DeepSliceTimeoutSeconds
    $oldVault = $Vault
    $oldArguments = $BoundedProcessorTestArguments
    $probeOut = Join-Path $sandbox 'stdin-prompt-bytes.bin'
    if (Test-Path $probeOut) { Remove-Item $probeOut -Force }
    $savedInputEncoding = $null
    # 실제로 관측된 두 가지 적대 조건을 모두 건다.
    #   949            — 한글 Windows 기본 ANSI. 운영 워처가 이 상태였고 `invalid byte at offset 0`이 났다.
    #   UTF-8 with BOM — GitHub Actions windows runner. 프롬프트 앞에 `EF BB BF`가 붙어 나갔다.
    $hostiles = @(
        @{ name = 'cp949'; enc = { [System.Text.Encoding]::GetEncoding(949) } },
        @{ name = 'utf8-bom'; enc = { New-Object System.Text.UTF8Encoding($true) } }
    )
    $prompt = "한글 조사 프롬프트 · PER 실력·전문성 추정 · ASCII tail"
    $expected = [System.Text.Encoding]::UTF8.GetBytes($prompt)
    $hasProp = ((New-Object System.Diagnostics.ProcessStartInfo).PSObject.Properties.Name -contains 'StandardInputEncoding')
    Write-Host ('  stdin probe: hasStdinEncodingProp=' + $hasProp + ' promptChars=' + ([string]$prompt).Length + ' psv=' + $PSVersionTable.PSVersion)
    $allOk = $true
    $anyHostileApplied = $false
    try {
        $CardCaptureWatcherTestMode = $false
        $Codex = 'powershell.exe'
        # 자식은 stdin을 **바이트 그대로** 받아 적는다. 문자열로 읽으면 자식 쪽 디코딩이 끼어들어
        # 정작 재려는 것이 가려진다.
        $BoundedProcessorTestArguments = '-NoProfile -Command "$in=[Console]::OpenStandardInput(); $mem=New-Object System.IO.MemoryStream; $in.CopyTo($mem); [System.IO.File]::WriteAllBytes(''' + $probeOut + ''', $mem.ToArray())"'
        $DeepSliceTimeoutSeconds = 20
        $Vault = $sandbox
        foreach ($hostile in $hostiles) {
            if (Test-Path $probeOut) { Remove-Item $probeOut -Force }
            $applied = $false
            try {
                if ($null -eq $savedInputEncoding) { $savedInputEncoding = [Console]::InputEncoding }
                [Console]::InputEncoding = (& $hostile.enc)
                $applied = ([Console]::InputEncoding.CodePage -eq (& $hostile.enc).CodePage)
            } catch { $applied = $false }
            if ($applied) { $anyHostileApplied = $true }
            # 첫 글자가 한글이어야 한다 — 운영 실패가 정확히 offset 0에서 났다.
            $null = Invoke-BoundedDeepProcessor $prompt (Join-Path $sbLog ('stdin-' + $hostile.name + '.log'))
            if (-not (Test-Path $probeOut)) {
                Write-Host ('  stdin probe[' + $hostile.name + ']: 자식이 아무것도 받지 못했다')
                $allOk = $false
                continue
            }
            $actual = [System.IO.File]::ReadAllBytes($probeOut)
            $same = ($actual.Length -eq $expected.Length)
            if ($same) {
                for ($i = 0; $i -lt $expected.Length; $i++) {
                    if ($actual[$i] -ne $expected[$i]) { $same = $false; break }
                }
            }
            # 실패했을 때 "왜"를 로그만 보고 가릴 수 있도록 실측값을 남긴다.
            Write-Host ('  stdin probe[' + $hostile.name + ']: applied=' + $applied + ' bytes=' + $actual.Length + '/' + $expected.Length +
                ' head=[' + (@($actual | Select-Object -First 8) -join ',') + '] want=[' + (@($expected | Select-Object -First 8) -join ',') + ']')
            if (-not ($same -and $applied)) { $allOk = $false }
        }
        # 적대 조건을 하나도 걸지 못했으면 통과로 세지 않는다 — 아무것도 검사하지 않은 초록이 이
        # 게이트가 막으려는 바로 그 실패 양식이다.
        return ($allOk -and $anyHostileApplied)
    } finally {
        $CardCaptureWatcherTestMode = $oldMode
        $Codex = $oldCodex
        $DeepSliceTimeoutSeconds = $oldTimeout
        $Vault = $oldVault
        $BoundedProcessorTestArguments = $oldArguments
        if ($null -ne $savedInputEncoding) { try { [Console]::InputEncoding = $savedInputEncoding } catch {} }
    }
}

# =====================================================================
# TSK-000531 — 정직한 실패 저널 / stale marker 조정 / 결정적 requeue 차단
#   실측 출발점(2026-08-04): PER-000418 조사 receipt가 requeue 2회 x processor exit 1 3회 =
#   연속 실패 6회에서 멈춰 있었고, 그 상태에서도 앱은 아무 반응 없는 '다시 처리'만 보여 줬다.
#   처리기 raw 로그는 보존 기간이 지나 사라졌다 — 운영 원인은 로그로 되살릴 수 없다.
#   그래서 여기서 고정하는 것은 '무엇이 원인이었나'가 아니라 **그 상황에서 시스템이 남기는 흔적과
#   사용자에게 주는 선택지**다. 아래 세 가지는 전부 합성 캡처로만 재현한다.
# =====================================================================
function New-DeepCapture($id, $receivedAt) {
    $d = Join-Path $sbInbox $id
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    $meta = [ordered]@{
        captureId = $id; status = 'received'; capturer = 'test'; files = @('front.jpg')
        receivedAt = $receivedAt; type = 'research_instruction'
        researchInstruction = [ordered]@{ mode = 'deep_evidence_graph'; raw = '합성 조사 지시' }
    }
    ($meta | ConvertTo-Json -Depth 6) | Out-File -Encoding utf8 (Join-Path $d 'capture.json')
    return $d
}
function CaptureMeta($id) { return (Get-Content (Join-Path (Join-Path $sbInbox $id) 'capture.json') -Raw -Encoding UTF8 | ConvertFrom-Json) }
function FailureJournal($id) {
    $p = Join-Path (StagingDir $id) 'failure.json'
    if (-not (Test-Path $p)) { return $null }
    return (Get-Content $p -Raw -Encoding UTF8 | ConvertFrom-Json)
}
function HasBegin($id) { return (Test-Path (Join-Path (StagingDir $id) 'begin.json')) }
function HasBackup($id) { return (Test-Path (Join-Path (StagingDir $id) 'deep-output-backup.json')) }
# 서버 requeue와 같은 표식: receivedAt 갱신 + requeueRequested. 이것이 입력 fingerprint를 바꾼다.
function Invoke-SyntheticRequeue($id, $stamp) {
    $p = Join-Path (Join-Path $sbInbox $id) 'capture.json'
    $m = Get-Content $p -Raw -Encoding UTF8 | ConvertFrom-Json
    $m.receivedAt = $stamp
    $m | Add-Member -NotePropertyName requeueRequested -NotePropertyValue $true -Force
    ($m | ConvertTo-Json -Depth 12) | Out-File -Encoding utf8 $p
}
function Invoke-WhileEligible($id, $limit) {
    for ($i = 0; $i -lt $limit; $i++) {
        $dir = Join-Path $sbInbox $id
        if (-not (Test-Path $dir)) { break }
        $e = Get-CaptureEligibility (Get-Item $dir)
        if (-not $e.eligible) { break }
        $script:ConsecutiveFailures = 0
        Invoke-Processing
    }
}

# 이 구획은 원래 sandbox inbox로 돌아간다 — 앞의 Deep 구획이 $Inbox를 deep-inbox로 바꿔 두고
# 되돌리지 않는다. 그대로 두면 여기서 만든 캡처를 워처가 아예 보지 못해 모든 단언이
# '처리된 적이 없어서 파일도 없다'로 조용히 통과한다(실측으로 실제 그랬다 — 그래서 아래
# 단언들에 처리기 호출 수 같은 양성 증거를 함께 요구한다).
$Inbox = $sbInbox
$Lock = Join-Path $sbInbox 'processing.lock'
# 앞 구획이 남긴 대기 항목이 있으면 처리 루프가 실패 한 번에 멈춰(기존 계약: 실패하면 break)
# 이 구획의 캡처에 닿지도 못한다. 먼저 큐를 비우고, 비워졌다는 사실 자체를 게이트로 고정한다.
Set-StubConf @() 'commit'
for ($drain = 0; $drain -lt 12; $drain++) {
    if ((Get-Backlog).Count -eq 0) { break }
    $script:ConsecutiveFailures = 0
    Invoke-Processing
}
T ((Get-Backlog).Count -eq 0) ('TSK-000531 전제: 이 구획 시작 시 대기 큐가 비어 있다 (남은=' + (Get-Backlog).Count + ')')

# ---- 1. 정상 실패는 crash와 다른 흔적을 남긴다 ----
$null = New-DeepCapture 'F5001' '2026-07-25T11:00:00Z'
Set-StubConf @('F5001') 'exit1'

TB 'TSK-000531 journal: 정상 실패는 begin marker와 rollback backup을 함께 닫는다' {
    $script:ConsecutiveFailures = 0
    Invoke-Processing
    # 양성 증거 먼저: 이 캡처가 실제로 처리기까지 갔고 실패했는가. 이것이 없으면 아래 부정 단언은
    # '처리된 적이 없어서 파일도 없다'로 통과한다.
    if ((Count-Calls 'F5001') -ne 1) { return $false }
    if ([int](Get-CaptureState 'F5001').attempts -ne 1) { return $false }
    # deep lane이라 이번 실행에서 backup이 실제로 만들어졌다 — 둘 다 사라져 있어야 한다.
    return ((-not (HasBegin 'F5001')) -and (-not (HasBackup 'F5001')))
}
TB 'TSK-000531 journal: 실패 영수증이 원인 분류·시도 수·시각과 함께 남는다' {
    $j = FailureJournal 'F5001'
    if (-not $j) { return $false }
    return (([string]$j.version -eq 'card-capture-failure-v1') -and ([string]$j.causeClass -eq 'processor_failed') -and
            ([int]$j.failures -ge 1) -and ([int]$j.attempt -ge 1) -and
            ([int]$j.recoveryThreshold -eq [int]$RecoveryRequiredFailures) -and
            [string]$j.firstFailedAt -and [string]$j.lastFailedAt)
}
TB 'TSK-000531 journal: 영수증에 캡처 내용·자유 텍스트가 들어가지 않는다' {
    $raw = Get-Content (Join-Path (StagingDir 'F5001') 'failure.json') -Raw -Encoding UTF8
    # reason은 워처 소스의 닫힌 리터럴로만 만들어진다. 명함·조사 지시 본문은 어떤 형태로도 들어갈 수 없다.
    return (($raw -notmatch '합성 조사 지시') -and ($raw -notmatch 'front\.jpg') -and
            ((FailureJournal 'F5001').reason -match '\Aprocessor_exit_-?\d+\z'))
}
TB 'TSK-000531 journal: 정상 실패는 중단된 attempt로 보고되지 않는다 (crash와 다른 상태)' {
    return (-not ((Get-InterruptedCaptures) -contains 'F5001'))
}
TB 'TSK-000531 journal: 반대로 commit 전에 죽은 attempt는 여전히 중단으로 보고된다' {
    $null = New-Capture 'F5002' 'received' '2026-07-25T11:10:00Z'
    $null = Start-CaptureStaging 'F5002' 1 (Fp 'F5002') 'dead-worker'
    return (((Get-InterruptedCaptures) -contains 'F5002') -and (HasBegin 'F5002') -and
            ($null -eq (FailureJournal 'F5002')))
}
TB 'TSK-000531 journal: 닫기는 begin·backup·영수증을 한 번에 처리한다 (직접 호출)' {
    $null = New-Capture 'F5003' 'received' '2026-07-25T11:20:00Z'
    $null = Start-CaptureStaging 'F5003' 2 (Fp 'F5003') 'worker-1'
    $null = Save-DeepRollbackBackup 'F5003' (Get-DeepWorkspaceSnapshot (Join-Path $sbInbox 'F5003'))
    if (-not ((HasBegin 'F5003') -and (HasBackup 'F5003'))) { return $false }
    $null = Close-CaptureStagingFailure 'F5003' 2 'result_incomplete' 'commit_incomplete_missing_brief' $false $false
    $j = FailureJournal 'F5003'
    return ((-not (HasBegin 'F5003')) -and (-not (HasBackup 'F5003')) -and
            ($j -and [string]$j.causeClass -eq 'result_incomplete' -and [int]$j.attempt -eq 2))
}
# F5001·F5002의 단언은 여기서 끝난다. F5001은 deep이라 stub이 evidence graph를 만들 수 없어
# 절대 commit되지 않는다 — 큐에 남겨 두면 뒤 게이트가 그 항목에서 멈춘다.
Remove-Item (Join-Path $sbInbox 'F5001') -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $sbInbox 'F5002') -Recurse -Force -ErrorAction SilentlyContinue
TB 'TSK-000531 journal: 진전(commit)은 실패 영수증을 지운다' {
    $null = New-Capture 'F5004' 'received' '2026-07-25T11:30:00Z'
    Set-StubConf @('F5004') 'exit1'
    $script:ConsecutiveFailures = 0
    Invoke-Processing
    # 양성 증거: 지우기 전에 영수증이 실제로 있었다.
    if ($null -eq (FailureJournal 'F5004')) { return $false }
    Set-StubConf @() 'commit'
    $script:ConsecutiveFailures = 0
    Invoke-Processing
    return (($null -eq (FailureJournal 'F5004')) -and ((CaptureMeta 'F5004').status -eq 'processed'))
}

# ---- 2. 옛 버전이 남긴 stale marker 조정 ----
TB 'TSK-000531 reconcile: backup 없는 고아 begin marker는 불가능한 복구 대신 조정된다' {
    $null = New-Capture 'L5001' 'received' '2026-07-25T12:00:00Z'
    $null = Start-CaptureStaging 'L5001' 1 (Fp 'L5001') 'ancient-worker'
    if (-not ((Get-InterruptedCaptures) -contains 'L5001')) { return $false }
    $reconciled = @(Repair-InterruptedCaptures)
    $j = FailureJournal 'L5001'
    return (($reconciled -contains 'L5001') -and (-not (HasBegin 'L5001')) -and
            (-not ((Get-InterruptedCaptures) -contains 'L5001')) -and
            ($j -and [string]$j.reason -eq 'interrupted_no_backup' -and [string]$j.causeClass -eq 'interrupted_attempt'))
}
TB 'TSK-000531 reconcile: 여러 번 돌려도 같은 결과다 (멱등)' {
    $before = (Get-Content (Join-Path (StagingDir 'L5001') 'failure.json') -Raw -Encoding UTF8)
    $null = Repair-InterruptedCaptures
    $null = Repair-InterruptedCaptures
    $after = (Get-Content (Join-Path (StagingDir 'L5001') 'failure.json') -Raw -Encoding UTF8)
    return ($before -eq $after)
}
TB 'TSK-000531 reconcile: 조정은 진행 중인 attempt의 marker를 건드리지 않는다' {
    $null = New-Capture 'L5002' 'received' '2026-07-25T12:10:00Z'
    $live = New-CaptureClaim 'L5002' (Fp 'L5002')
    if ($null -eq $live) { return $false }
    $null = Start-CaptureStaging 'L5002' 1 (Fp 'L5002') $live.owner
    $null = Repair-InterruptedCaptures
    $kept = ((HasBegin 'L5002') -and ($null -eq (FailureJournal 'L5002')))
    Remove-CaptureClaim $live
    return $kept
}
TB 'TSK-000531 reconcile: claim이 사라지면 같은 marker가 조정된다' {
    $null = Repair-InterruptedCaptures
    return ((-not (HasBegin 'L5002')) -and ($null -ne (FailureJournal 'L5002')))
}
TB 'TSK-000531 reconcile: 복구할 backup이 있으면 복구부터 하고 marker를 닫는다' {
    $null = New-Capture 'L5003' 'received' '2026-07-25T12:20:00Z'
    $dir = Join-Path $sbInbox 'L5003'
    'pre-run truth' | Out-File -Encoding utf8 (Join-Path $dir 'brief.md')
    $null = Save-DeepRollbackBackup 'L5003' (Get-DeepWorkspaceSnapshot $dir)
    $null = Start-CaptureStaging 'L5003' 1 (Fp 'L5003') 'dead-worker'
    'poisoned output' | Out-File -Encoding utf8 (Join-Path $dir 'brief.md')
    $null = Repair-InterruptedCaptures
    $restored = ((Get-Content (Join-Path $dir 'brief.md') -Raw -Encoding UTF8).Trim() -eq 'pre-run truth')
    return ($restored -and (-not (HasBegin 'L5003')) -and (-not (HasBackup 'L5003')) -and
            ([string](FailureJournal 'L5003').reason -eq 'interrupted_restored'))
}

# ---- 3. 결정적 requeue 차단 + 복구 필요 영수증 ----
$null = New-Capture 'G5001' 'received' '2026-07-25T13:00:00Z'
Set-StubConf @('G5001') 'exit1'

TB 'TSK-000531 guard: 첫 예산은 기존 정책 그대로 MaxAttempts에서 격리된다' {
    Invoke-WhileEligible 'G5001' 8
    $st = Get-CaptureState 'G5001'
    return (($st.quarantined -eq $true) -and ([int]$st.attempts -eq $maxA) -and
            ((Count-Calls 'G5001') -eq $maxA) -and ($st.recoveryRequired -ne $true))
}
TB 'TSK-000531 guard: 첫 격리에서는 아직 requeue가 받아들여진다 (한 번은 준다)' {
    Invoke-SyntheticRequeue 'G5001' '2026-07-26T13:00:00Z'
    return (-not (Test-CaptureQuarantined 'G5001' (Fp 'G5001')))
}
TB 'TSK-000531 guard: 같은 원인으로 예산을 두 번 소진하면 복구 필요로 확정된다' {
    Invoke-WhileEligible 'G5001' 8
    $st = Get-CaptureState 'G5001'
    return (($st.recoveryRequired -eq $true) -and ([string]$st.recoveryCause -eq 'processor_failed') -and
            ([int]$st.repeatFailures -ge [int]$RecoveryRequiredFailures) -and [string]$st.recoveryRequiredAt)
}
TB 'TSK-000531 guard: 그 뒤의 requeue는 조용히 받아들여지지 않는다 (결정적 차단)' {
    Invoke-SyntheticRequeue 'G5001' '2026-07-27T13:00:00Z'
    $held = Test-CaptureQuarantined 'G5001' (Fp 'G5001')
    $stillHeld = Test-CaptureQuarantined 'G5001' (Fp 'G5001')
    $callsBefore = Count-Calls 'G5001'
    $script:ConsecutiveFailures = 0
    Invoke-Processing
    Invoke-Processing
    return ($held -and $stillHeld -and ((Count-Calls 'G5001') -eq $callsBefore))
}
TB 'TSK-000531 guard: 임계값은 발명한 상수가 아니라 격리 정책에서 유도된다' {
    return ([int]$RecoveryRequiredFailures -eq ([int]$MaxAttempts * 2))
}
TB 'TSK-000531 guard: 반복 실패 횟수는 requeue로 초기화되지 않는다' {
    # 예산(attempts)은 requeue로 재충전되지만 '같은 원인으로 몇 번 실패했는가'는 진전에서만 지워진다.
    $st = Get-CaptureState 'G5001'
    return ([int]$st.repeatFailures -ge ([int]$MaxAttempts * 2))
}
TB 'TSK-000531 receipt: since는 ISO(UTC)다 — 폰 브라우저가 읽을 수 없는 형식을 보내지 않는다' {
    # iOS Safari의 Date.parse는 워처 상태 파일 형식('yyyy-MM-dd HH:mm:ss')을 NaN으로 돌려준다.
    # 그러면 '멈춘 지 얼마나 됐나'가 폰에서만 조용히 사라진다 — 이 lane이 고치는 결함 그 자체다.
    $r = (CaptureMeta 'G5001').recovery
    return ([string]$r.since -match '\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\z')
}
TB 'TSK-000531 receipt: capture.json에 복구 필요 영수증이 닫힌 enum으로 남는다' {
    $r = (CaptureMeta 'G5001').recovery
    return (($r) -and ([string]$r.kind -eq 'recovery_required') -and ([string]$r.reasonCode -eq 'processor_failed') -and
            ([int]$r.threshold -eq [int]$RecoveryRequiredFailures) -and ([int]$r.failures -ge [int]$RecoveryRequiredFailures) -and
            [string]$r.since)
}
TB 'TSK-000531 receipt: 영수증은 입력 fingerprint를 바꾸지 않는다 (예산 자동 재충전 없음)' {
    $before = Fp 'G5001'
    $null = Set-CaptureRecoveryReceipt 'G5001' (Join-Path $sbInbox 'G5001') (New-CaptureRecoveryReceipt 'retry_scheduled' 'processor_failed' 1 1 '2026-07-27 13:00:00')
    $after = Fp 'G5001'
    $null = Set-CaptureRecoveryReceipt 'G5001' (Join-Path $sbInbox 'G5001') (New-CaptureRecoveryReceipt 'recovery_required' 'processor_failed' 3 6 '2026-07-27 13:00:00')
    return ($before -eq $after)
}
TB 'TSK-000531 receipt: 일시 실패는 재시도 예정으로 남는다 (복구 필요와 다른 상태)' {
    $null = New-Capture 'G5002' 'received' '2026-07-25T14:00:00Z'
    Set-StubConf @('G5002') 'exit1'
    $script:ConsecutiveFailures = 0
    Invoke-Processing
    $r = (CaptureMeta 'G5002').recovery
    $st = Get-CaptureState 'G5002'
    return (($r) -and ([string]$r.kind -eq 'retry_scheduled') -and ([int]$r.attempts -eq 1) -and
            ($st.recoveryRequired -ne $true))
}
TB 'TSK-000531 receipt: 성공하면 영수증이 사라진다' {
    Set-StubConf @() 'commit'
    $script:ConsecutiveFailures = 0
    Invoke-Processing
    $m = CaptureMeta 'G5002'
    return (($m.status -eq 'processed') -and ($null -eq $m.PSObject.Properties['recovery']))
}
TB 'TSK-000531 health: 격리·복구 필요 항목이 원인과 시각과 함께 노출된다' {
    Write-Health
    $h = Get-Content $HealthFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $row = @($h.quarantineDetail | Where-Object { [string]$_.captureId -eq 'G5001' })
    return (([int]$h.recoveryRequiredCount -ge 1) -and
            ([int]$h.recoveryRequiredThreshold -eq [int]$RecoveryRequiredFailures) -and
            ($row.Count -eq 1) -and ([string]$row[0].cause -eq 'processor_failed') -and
            ($row[0].recoveryRequired -eq $true) -and [string]$row[0].since)
}
TB 'TSK-000531 health: 진단 출력에는 자유 문자열이 아니라 닫힌 원인 enum만 나간다' {
    $h = Get-Content $HealthFile -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($row in @($h.quarantineDetail)) {
        if ($FailureCauseClasses -notcontains [string]$row.cause) { return $false }
        if ($row.PSObject.Properties['quarantineReason']) { return $false }
    }
    return $true
}
TB 'TSK-000531 복구: 사람이 항목 상태를 지우면 잠금이 풀린다 (문서화된 유일한 해제 경로)' {
    Remove-Item (Join-Path $sbState 'items\G5001.json') -Force -ErrorAction SilentlyContinue
    $script:QuarantineHoldLogged.Remove('G5001')
    return (-not (Test-CaptureQuarantined 'G5001' (Fp 'G5001')))
}

# ---- summary + cleanup ----
Write-Host ''
Write-Host ("summary: pass=" + $pass + " fail=" + $fail)
Remove-Item $sandbox -Recurse -Force -ErrorAction SilentlyContinue
if ($fail -gt 0) { Write-Host 'RESULT: FAIL'; exit 1 } else { Write-Host 'RESULT: PASS'; exit 0 }
