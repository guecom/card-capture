# health-tests.ps1 — CardCapture_Health.ps1 진단 정확도·redaction 테스트
# Kairen-Ref: TSK-000280 (FI-029 처리 health dashboard)
# 실제 %LOCALAPPDATA%\CardCapture 와 실제 워처 프로세스를 절대 건드리지 않는다:
#   임시 합성 root만 만들어 읽히고, 프로세스는 시작·종료하지 않는다.
#   살아 있는 프로세스가 필요한 판정은 '이 테스트 러너 자신의 PID'로 검증한다.
# 사용: powershell -NoProfile -ExecutionPolicy Bypass -File watcher\tests\health-tests.ps1
# 주의: UTF-8 BOM 유지 (한글 경로).

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $PSScriptRoot   # watcher/
$healthScript = Join-Path $here 'CardCapture_Health.ps1'

$pass = 0; $fail = 0
function T($ok, $label) { if ($ok) { $script:pass++; Write-Host "pass  $label" } else { $script:fail++; Write-Host "FAIL  $label" } }

# ---- sandbox ----
$sandbox = Join-Path $env:TEMP ("cch-health-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$fakeLocal = Join-Path $sandbox 'Local'
$root = Join-Path $fakeLocal 'CardCapture'
$origLocal = $env:LOCALAPPDATA

# 합성 PII 표지. 어떤 출력에도 나타나면 안 된다 (실데이터 아님 — 전부 지어낸 문자열).
$sentinels = @(
    'SENTINELCAPTURERNAME', 'SENTINELPERSONNAME', 'SENTINELQUICKNAME',
    'SENTINELNOTETEXT', 'SENTINELTOKENVALUE', 'SENTINELDRIVEFOLDERID'
)

function Reset-Fixture {
    if (Test-Path $root) { Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue }
    New-Item -ItemType Directory -Force -Path $root | Out-Null
}

function Set-Health($map) {
    ([PSCustomObject]$map | ConvertTo-Json) | Out-File -Encoding utf8 (Join-Path $root 'watcher-health.json')
}

function Set-RawHealth($text) {
    $text | Out-File -Encoding utf8 (Join-Path $root 'watcher-health.json')
}

function Set-Claim($id, $expiresInMin, $attempt) {
    $d = Join-Path (Join-Path $root 'state') 'claims'
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    $now = Get-Date
    $claim = [PSCustomObject]@{
        captureId = $id
        owner = 'SENTINELTOKENVALUE-worker'
        workerPid = 4242
        attempt = $attempt
        inputFingerprint = 'deadbeef'
        claimedAt = $now.ToString('yyyy-MM-dd HH:mm:ss')
        lastHeartbeat = $now.ToString('yyyy-MM-dd HH:mm:ss')
        leaseExpiresAt = $now.AddMinutes($expiresInMin).ToString('yyyy-MM-dd HH:mm:ss')
    }
    ($claim | ConvertTo-Json) | Out-File -Encoding utf8 (Join-Path $d ($id + '.claim.json'))
}

function Set-Item($id, $attempts, $quarantined) {
    $d = Join-Path (Join-Path $root 'state') 'items'
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    $s = [PSCustomObject]@{
        captureId = $id
        attempts = $attempts
        lastError = 'SENTINELNOTETEXT'
        lastAttemptAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
        quarantined = $quarantined
        quarantineReason = 'SENTINELPERSONNAME'
        quarantineFingerprint = 'cafe'
        quarantinedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    }
    ($s | ConvertTo-Json) | Out-File -Encoding utf8 (Join-Path $d ($id + '.json'))
}

function Set-Staging($id, $committed) {
    $d = Join-Path (Join-Path (Join-Path $root 'state') 'staging') $id
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    if ($committed) {
        '{"captureId":"' + $id + '","committedAt":"2026-01-01 00:00:00"}' | Out-File -Encoding utf8 (Join-Path $d 'commit.json')
    } else {
        '{"captureId":"' + $id + '","startedAt":"2026-01-01 00:00:00"}' | Out-File -Encoding utf8 (Join-Path $d 'begin.json')
    }
}

# 실제 watcher.log 구조를 재현한다: 워처가 쓴 타임스탬프 줄 + codex 처리기 raw 출력(명함 내용).
# 실측(2026-07-27): 실제 로그 48,252줄 중 48,169줄이 처리기 raw 출력이다.
function Set-Log {
    $lines = @(
        '2026-07-27 10:00:00 === watcher started (watcher-v3.0, codex engine) PID=4242 ===',
        '2026-07-27 10:01:00 processing card (deep) CAP0001 attempt=1/3 — 남은 대기 2',
        '이름: SENTINELPERSONNAME / 회사: SENTINELDRIVEFOLDERID',
        'quickName=SENTINELQUICKNAME capturer=SENTINELCAPTURERNAME note=SENTINELNOTETEXT',
        'token=SENTINELTOKENVALUE',
        '2026-07-27 10:02:00 card done — 처리됨: CAP0001 (status=processed)',
        '2026-07-27 10:03:00 heartbeat (PID=4242, loop alive)',
        '2026-07-27 10:04:00 heartbeat (PID=4242, loop alive)'
    )
    $lines -join "`r`n" | Out-File -Encoding utf8 (Join-Path $root 'watcher.log')
}

# 존재하지 않는 PID 하나를 실제로 확인해서 고른다 (상수를 믿지 않는다).
function Find-DeadPid {
    foreach ($n in 99999..99000) {
        if ($null -eq (Get-Process -Id $n -ErrorAction SilentlyContinue)) { return $n }
    }
    throw 'no free pid found'
}

# health 스크립트를 자식 프로세스로 실행한다.
# LOCALAPPDATA를 합성 sandbox로 돌려서 -Root 를 모르는 (수정 전) 버전도 fixture를 읽게 만든다
# — 그래야 red baseline이 진짜 fixture 기준으로 관측된다.
function Invoke-Health($extra) {
    $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $healthScript, '-Root', $root)
    if ($extra) { $argv += $extra }
    # 자식이 stderr에 뭘 쓰든 테스트를 죽이지 않는다 (PS5.1은 native stderr를 ErrorRecord로 감싼다).
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $out = ''
    $code = -1
    try {
        $out = & powershell.exe @argv 2>&1 | Out-String
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }
    return [PSCustomObject]@{ out = $out; code = $code }
}

# 고아 워처가 '여럿'인 상황을 프로세스를 새로 띄우거나 죽이지 않고 재현한다.
# health를 중간 셸을 한 단계 거쳐 손자로 실행하면, 워처 패턴에 걸리는 살아 있는 프로세스가
# 러너와 중간 셸 둘이 된다. health는 자기 자신(PID)만 고아 목록에서 제외하므로 둘 다 고아로 보여야 한다.
# (실제 사고와 같은 모양: health가 가리키는 pid는 죽었고, 그것과 다른 워처 프로세스가 여러 개 떠 있다.)
$orphanMarker = 'CCWA4ORPHANMARK'
$multiOrphanPattern = '(health-tests\.ps1|' + $orphanMarker + ')'

function Invoke-HealthNested($extra) {
    # 인자는 반드시 작은따옴표로 감싼다. 큰따옴표는 native 인자 전달에서 벗겨져
    # 패턴의 괄호·파이프가 안쪽 셸에서 명령으로 해석된다(실측: 'module could not be loaded').
    $q = [string][char]39
    $innerArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ($q + $healthScript + $q),
        '-Root', ($q + $root + $q), '-WatcherProcessPattern', ($q + $multiOrphanPattern + $q))
    if ($extra) { $innerArgs += $extra }
    # marker 문자열을 중간 셸의 command line에 남기는 것이 목적이다 (동작은 no-op).
    $outer = $q + $orphanMarker + $q + ' | Out-Null; & powershell.exe ' + ($innerArgs -join ' ')
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $out = ''
    try {
        $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -Command $outer 2>&1 | Out-String
    } finally {
        $ErrorActionPreference = $prev
    }
    return [PSCustomObject]@{ out = $out; code = -1 }
}

# QUARANTINE(격리 발생) 한 줄과 quarantine released(격리 해제) 한 줄을 함께 담은 로그.
function Set-LogWithRelease {
    $lines = @(
        '2026-07-27 10:00:00 === watcher started (watcher-v3.0, codex engine) PID=4242 ===',
        '2026-07-27 10:01:00 QUARANTINE CAP0001 attempts=3 reason=processor_exit_1 — 캡처는 그대로 둔다',
        '2026-07-27 10:02:00 quarantine released CAP0001 (new input fingerprint)',
        '2026-07-27 10:02:30 quarantine hold CAP0002 — 입력 fingerprint를 읽지 못했다(unknown), 격리를 유지한다',
        '2026-07-27 10:03:00 heartbeat (PID=4242, loop alive)'
    )
    $lines -join "`r`n" | Out-File -Encoding utf8 (Join-Path $root 'watcher.log')
}

function Get-Json($r) {
    try { return ($r.out | ConvertFrom-Json) } catch { return $null }
}

function Show-Or-Null($v) {
    if ($null -eq $v) { return '<null>' }
    return [string]$v
}

function Test-NoSentinel($text) {
    foreach ($s in $sentinels) { if ($text -match [regex]::Escape($s)) { return $false } }
    return $true
}

$deadPid = Find-DeadPid
# 이 테스트 러너 자신은 '살아 있지만 워처가 아닌 프로세스'다. 프로세스를 새로 띄우지 않는다.
$selfPid = $PID
$selfPattern = 'health-tests\.ps1'
$nowStamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
$staleStamp = (Get-Date).AddMinutes(-60).ToString('yyyy-MM-dd HH:mm:ss')

New-Item -ItemType Directory -Force -Path $root | Out-Null
$env:LOCALAPPDATA = $fakeLocal

try {
    Write-Host '=== health dashboard tests ==='

    # ---- G1 -Json 은 기계 판독 가능한 JSON 하나를 낸다 ----
    Reset-Fixture
    Set-Health @{ version = 'watcher-v3.0'; pid = $selfPid; startedAt = $nowStamp; lastHeartbeat = $nowStamp; backlogCount = 0 }
    $r = Invoke-Health @('-Json', '-WatcherProcessPattern', $selfPattern)
    $j = Get-Json $r
    T ($null -ne $j) 'G1 -Json: output parses as JSON'
    T ($null -ne $j -and $j.schema -eq 'cardcapture-health/1') 'G1 -Json: schema tag present'

    # ---- G2 기록된 pid가 살아 있어도 워처가 아니면 critical (PID 재사용) ----
    Reset-Fixture
    Set-Health @{ version = 'watcher-v3.0'; pid = $selfPid; startedAt = $nowStamp; lastHeartbeat = $nowStamp; backlogCount = 0 }
    $r = Invoke-Health @('-Json')   # 기본 패턴 = CardCapture_Watcher.ps1 → 이 러너는 워처가 아니다
    $j = Get-Json $r
    T ($null -ne $j -and $j.status -eq 'critical') 'G2 pid alive but foreign process: status critical'
    T ($null -ne $j -and (@($j.reasons) -contains 'watcher_pid_reused_by_other_process')) 'G2 reason: watcher_pid_reused_by_other_process'
    T ($r.code -eq 2) 'G2 exit code 2'

    # ---- G3 기록된 pid가 실제 워처면 healthy (과잉 경보 금지) ----
    Reset-Fixture
    Set-Health @{ version = 'watcher-v3.0'; pid = $selfPid; startedAt = $nowStamp; lastHeartbeat = $nowStamp
        backlogCount = 0; consecutiveFailures = 0; lockExists = $false }
    Set-Log
    $r = Invoke-Health @('-Json', '-WatcherProcessPattern', $selfPattern)
    $j = Get-Json $r
    T ($null -ne $j -and $j.status -eq 'healthy') 'G3 pid alive and is the watcher: status healthy'
    T ($null -ne $j -and $j.watcher.process.identity -eq 'watcher') 'G3 identity: watcher'
    T ($r.code -eq 0) 'G3 exit code 0'

    # ---- G4 기록된 pid가 죽었으면 critical ----
    Reset-Fixture
    Set-Health @{ version = 'watcher-v3.0'; pid = $deadPid; startedAt = $nowStamp; lastHeartbeat = $nowStamp; backlogCount = 0 }
    $r = Invoke-Health @('-Json', '-WatcherProcessPattern', $selfPattern)
    $j = Get-Json $r
    T ($null -ne $j -and $j.status -eq 'critical') 'G4 recorded pid dead: status critical'
    T ($null -ne $j -and (@($j.reasons) -contains 'watcher_process_not_running')) 'G4 reason: watcher_process_not_running'
    T ($null -ne $j -and $j.watcher.process.running -eq $false) 'G4 process.running false'

    # ---- G5 health가 가리키지 않는 워처 프로세스(고아)를 보고한다 ----
    #      실측 사고 재현: health는 죽은 pid를 가리키는데 다른 pid로 워처가 떠 있다.
    Reset-Fixture
    Set-Health @{ version = 'watcher-v3.0'; pid = $deadPid; startedAt = $nowStamp; lastHeartbeat = $nowStamp; backlogCount = 0 }
    $r = Invoke-Health @('-Json', '-WatcherProcessPattern', $selfPattern)
    $j = Get-Json $r
    T ($null -ne $j -and (@($j.watcher.orphanWatcherPids) -contains $selfPid)) 'G5 orphan watcher pid reported'
    T ($null -ne $j -and (@($j.reasons) -contains 'orphan_watcher_process')) 'G5 reason: orphan_watcher_process'

    # ---- G6 heartbeat가 낡으면 critical ----
    Reset-Fixture
    Set-Health @{ version = 'watcher-v3.0'; pid = $selfPid; startedAt = $staleStamp; lastHeartbeat = $staleStamp; backlogCount = 0 }
    $r = Invoke-Health @('-Json', '-WatcherProcessPattern', $selfPattern)
    $j = Get-Json $r
    T ($null -ne $j -and $j.status -eq 'critical') 'G6 stale heartbeat: status critical'
    T ($null -ne $j -and (@($j.reasons) -contains 'heartbeat_stale')) 'G6 reason: heartbeat_stale'
    T ($null -ne $j -and $j.watcher.heartbeatAgeMin -ge 59) 'G6 heartbeat age reported'

    # ---- G7 health 파일에 없는 값은 unknown이다 — 0으로 단정하지 않는다 ----
    Reset-Fixture
    Set-Health @{ version = 'watcher-v3.0'; pid = $selfPid; startedAt = $nowStamp; lastHeartbeat = $nowStamp }
    $r = Invoke-Health @('-Json', '-WatcherProcessPattern', $selfPattern)
    $j = Get-Json $r
    T ($null -ne $j -and $null -eq $j.reported.backlogCount) 'G7 absent backlogCount stays null (not 0)'
    T ($null -ne $j -and $null -eq $j.reported.consecutiveFailures) 'G7 absent consecutiveFailures stays null'
    $rh = Invoke-Health @('-WatcherProcessPattern', $selfPattern)
    T ($rh.out -match 'unknown') 'G7 human output prints unknown for absent fields'
    T (-not ($rh.out -match '(?m):\s*$')) 'G7 human output has no blank-valued line'

    # ---- G8 claim/lease 가시성: state 디렉터리를 직접 관측한다 ----
    Reset-Fixture
    Set-Health @{ version = 'watcher-v3.0'; pid = $selfPid; startedAt = $nowStamp; lastHeartbeat = $nowStamp; backlogCount = 0 }
    Set-Claim 'CAPLIVE01' 12 1
    Set-Claim 'CAPDEAD01' -40 2
    $r = Invoke-Health @('-Json', '-WatcherProcessPattern', $selfPattern)
    $j = Get-Json $r
    T ($null -ne $j -and $j.observed.activeClaims -eq 2) 'G8 activeClaims counted from state dir'
    T ($null -ne $j -and $j.observed.expiredLeases -eq 1) 'G8 expired lease counted'
    T ($null -ne $j -and (@($j.observed.claims | Where-Object { $_.captureId -eq 'CAPDEAD01' -and $_.expired -eq $true }).Count -eq 1)) 'G8 expired claim identified by captureId'
    T ($null -ne $j -and (@($j.reasons) -contains 'expired_lease')) 'G8 reason: expired_lease'

    # ---- G9 격리·시도상한 가시성 ----
    Reset-Fixture
    Set-Health @{ version = 'watcher-v3.0'; pid = $selfPid; startedAt = $nowStamp; lastHeartbeat = $nowStamp; backlogCount = 0 }
    Set-Item 'CAPQ0001' 3 $true
    Set-Item 'CAPOK0001' 1 $false
    $r = Invoke-Health @('-Json', '-WatcherProcessPattern', $selfPattern)
    $j = Get-Json $r
    T ($null -ne $j -and $j.observed.quarantinedCount -eq 1) 'G9 quarantined counted from state dir'
    T ($null -ne $j -and (@($j.observed.quarantined) -contains 'CAPQ0001')) 'G9 quarantined captureId listed'
    T ($null -ne $j -and $j.observed.attemptCappedCount -eq 1) 'G9 attempt-capped counted'
    T ($null -ne $j -and $j.status -eq 'critical') 'G9 quarantine makes status critical'

    # ---- G10 commit marker 없는 attempt(중단된 시도) 가시성 ----
    Reset-Fixture
    Set-Health @{ version = 'watcher-v3.0'; pid = $selfPid; startedAt = $nowStamp; lastHeartbeat = $nowStamp; backlogCount = 0 }
    Set-Staging 'CAPINT001' $false
    Set-Staging 'CAPCOM001' $true
    $r = Invoke-Health @('-Json', '-WatcherProcessPattern', $selfPattern)
    $j = Get-Json $r
    T ($null -ne $j -and $j.observed.interruptedCount -eq 1) 'G10 interrupted attempt counted'
    T ($null -ne $j -and (@($j.observed.interrupted) -contains 'CAPINT001')) 'G10 interrupted captureId listed'
    T ($null -ne $j -and (@($j.reasons) -contains 'interrupted_attempt')) 'G10 reason: interrupted_attempt'

    # ---- G11 redaction: watcher.log의 처리기 raw 출력을 절대 되풀이하지 않는다 ----
    Reset-Fixture
    Set-Health @{ version = 'watcher-v3.0'; pid = $selfPid; startedAt = $nowStamp; lastHeartbeat = $nowStamp; backlogCount = 0 }
    Set-Log
    $rh = Invoke-Health @('-WatcherProcessPattern', $selfPattern)
    $rj = Invoke-Health @('-Json', '-WatcherProcessPattern', $selfPattern)
    $jl = Get-Json $rj
    T (Test-NoSentinel $rh.out) 'G11 human output leaks no processor log content'
    T (Test-NoSentinel $rj.out) 'G11 json output leaks no processor log content'
    # 'heartbeat 라는 단어가 어딘가 있다'로는 부족하다 — 실제 이벤트 줄이 나열돼야 한다.
    # (회귀 주입으로 확인: 이벤트 목록을 비워도 'event counts' 줄 때문에 단어 검사만으로는 통과한다.)
    T ($rh.out -cmatch '(?m)^  2026-07-27 10:03:00  heartbeat\s*$') 'G11 human output still lists watcher log events'
    T ($null -ne $jl -and @($jl.log.recentEvents).Count -eq 5) 'G11 json lists exactly the 5 watcher events'
    T ($null -ne $jl -and $jl.log.suppressedLines -ge 3) 'G11 processor lines are counted but never printed'

    # ---- G12 redaction: health·state 파일 안의 값도 출력하지 않는다 ----
    Reset-Fixture
    Set-Health @{ version = 'watcher-v3.0'; pid = $selfPid; startedAt = $nowStamp; lastHeartbeat = $nowStamp
        backlogCount = 0; capturer = 'SENTINELCAPTURERNAME'; inbox = 'D:\SENTINELDRIVEFOLDERID'
        workerId = 'SENTINELTOKENVALUE' }
    Set-Item 'CAPQ0002' 3 $true
    Set-Claim 'CAPLIVE02' 5 1
    $rh = Invoke-Health @('-WatcherProcessPattern', $selfPattern)
    $rj = Invoke-Health @('-Json', '-WatcherProcessPattern', $selfPattern)
    T (Test-NoSentinel $rh.out) 'G12 human output leaks no health/state field values'
    T (Test-NoSentinel $rj.out) 'G12 json output leaks no health/state field values'
    T ($rj.out -match 'CAPQ0002') 'G12 captureId is still reported (allowed)'

    # ---- G13 깨진 health 파일에도 죽지 않고 판정한다 ----
    Reset-Fixture
    Set-RawHealth '{ this is not json'
    $r = Invoke-Health @('-Json', '-WatcherProcessPattern', $selfPattern)
    $j = Get-Json $r
    T ($null -ne $j) 'G13 corrupt health file: still emits JSON'
    T ($null -ne $j -and (@($j.reasons) -contains 'health_file_unreadable')) 'G13 reason: health_file_unreadable'
    T ($r.code -eq 2) 'G13 corrupt health file: exit 2'

    # ---- G14 lastHeartbeat가 없어도 죽지 않는다 ----
    Reset-Fixture
    Set-Health @{ version = 'watcher-v3.0'; pid = $selfPid; startedAt = $nowStamp; lastHeartbeat = $null }
    $r = Invoke-Health @('-Json', '-WatcherProcessPattern', $selfPattern)
    $j = Get-Json $r
    T ($null -ne $j) 'G14 missing lastHeartbeat: still emits JSON'
    T ($null -ne $j -and (@($j.reasons) -contains 'heartbeat_unknown')) 'G14 reason: heartbeat_unknown'

    # ---- G15 health 파일 자체가 없을 때 ----
    Reset-Fixture
    $r = Invoke-Health @('-Json', '-WatcherProcessPattern', $selfPattern)
    $j = Get-Json $r
    T ($null -ne $j -and (@($j.reasons) -contains 'health_file_missing')) 'G15 reason: health_file_missing'
    T ($r.code -eq 1) 'G15 missing health file: exit 1 (warn)'

    # ---- G16 사람용/기계용 판정이 어긋나지 않는다 ----
    Reset-Fixture
    Set-Health @{ version = 'watcher-v3.0'; pid = $deadPid; startedAt = $nowStamp; lastHeartbeat = $nowStamp; backlogCount = 0 }
    $rh = Invoke-Health @('-WatcherProcessPattern', $selfPattern)
    $rj = Invoke-Health @('-Json', '-WatcherProcessPattern', $selfPattern)
    $j = Get-Json $rj
    T ($rh.code -eq $rj.code) 'G16 human and json exit codes agree'
    T ($null -ne $j -and $j.exitCode -eq $rj.code) 'G16 json exitCode matches process exit code'
    # -cmatch: 대소문자를 구분한다. 'exit code ... 2 critical' 같은 안내 문구에 우연히 걸리면 안 된다.
    T ($rh.out -cmatch 'verdict\s*:\s*CRITICAL') 'G16 human output states the verdict'

    # ---- G17 고아 워처가 여럿이면 전부 나열한다 ----
    #      운영 함정: 하나만 정리하고 재기동하면 남은 프로세스가 싱글턴 mutex를 쥐고 있어
    #      새 워처가 'another instance running, exit'로 즉시 죽는다. 하나만 보여주면 못 고친다.
    Reset-Fixture
    Set-Health @{ version = 'watcher-v3.0'; pid = $deadPid; startedAt = $nowStamp; lastHeartbeat = $nowStamp; backlogCount = 0 }
    $rn = Invoke-HealthNested @('-Json')
    $jn = Get-Json $rn
    $orphans = @()
    if ($null -ne $jn) { $orphans = @($jn.watcher.orphanWatchers) }
    T ($orphans.Count -ge 2) ('G17 multiple orphan watchers all listed (listed=' + $orphans.Count + ')')
    T (@($orphans | Where-Object { [int]$_.pid -eq $selfPid }).Count -eq 1) 'G17 the runner process is one of the listed orphans'
    $orphanPids = @()
    if ($null -ne $jn) { $orphanPids = @($jn.watcher.orphanWatcherPids) }
    T ($orphanPids.Count -eq $orphans.Count) ('G17 pid list and detail list agree in size (pids=' + $orphanPids.Count + ' detail=' + $orphans.Count + ')')

    # ---- G18 각 고아는 시작 시각과 함께 보고된다 (pid만으로는 무엇을 정리했는지 알 수 없다) ----
    $stamped = @($orphans | Where-Object { $_.startedAt -and ([string]$_.startedAt) -match '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$' })
    T ($orphans.Count -ge 2 -and $stamped.Count -eq $orphans.Count) ('G18 every orphan carries a start time (' + $stamped.Count + '/' + $orphans.Count + ')')
    $selfStart = ''
    try { $selfStart = (Get-Process -Id $selfPid).StartTime.ToString('yyyy-MM-dd HH:mm:ss') } catch { $selfStart = '' }
    $selfRow = @($orphans | Where-Object { [int]$_.pid -eq $selfPid })
    T ($selfStart -and $selfRow.Count -eq 1 -and ([string]$selfRow[0].startedAt) -eq $selfStart) 'G18 reported start time matches the real process start time'

    # ---- G19 사람용 출력도 고아를 하나씩 pid + 시작 시각으로 낸다 ----
    $rnh = Invoke-HealthNested @()
    $orphanLines = @([regex]::Matches($rnh.out, '(?m)^  - pid (\d+)  started (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*$'))
    T ($orphanLines.Count -ge 2) ('G19 human output lists each orphan on its own line (' + $orphanLines.Count + ')')
    T (@($orphanLines | Where-Object { [int]$_.Groups[1].Value -eq $selfPid }).Count -eq 1) 'G19 human output shows the runner orphan with its start time'

    # ---- G20 로그 이벤트 라벨은 대소문자를 구분한다 ----
    #      'quarantine released'가 '^QUARANTINE '에 대소문자 무시로 걸리면 격리 해제가
    #      격리 발생으로 집계돼, 운영자가 재충전된 항목을 새로 막힌 항목으로 읽는다.
    Reset-Fixture
    Set-Health @{ version = 'watcher-v3.0'; pid = $selfPid; startedAt = $nowStamp; lastHeartbeat = $nowStamp; backlogCount = 0 }
    Set-LogWithRelease
    $r = Invoke-Health @('-Json', '-WatcherProcessPattern', $selfPattern)
    $j = Get-Json $r
    $qc = $null; $qr = $null
    if ($null -ne $j) { $qc = $j.log.eventCounts.quarantine; $qr = $j.log.eventCounts.quarantine_released }
    T ($qr -eq 1) ('G20 quarantine release is labeled quarantine_released (got ' + (Show-Or-Null $qr) + ')')
    T ($qc -eq 1) ('G20 quarantine count is not inflated by release lines (got ' + (Show-Or-Null $qc) + ')')
    # 워처가 새로 쓰는 줄은 allowlist에 있어야 한다. 없으면 '처리기 raw 출력'으로 묻혀
    # 격리를 유지한 사실이 진단 표면에서 사라진다.
    $qh = $null
    if ($null -ne $j) { $qh = $j.log.eventCounts.quarantine_hold }
    T ($qh -eq 1) ('G20 quarantine hold is a recognized watcher event (got ' + (Show-Or-Null $qh) + ')')
    T ($null -ne $j -and $j.log.suppressedLines -eq 0) ('G20 no watcher-written line is dropped as processor output (suppressed=' + $(if ($null -ne $j) { $j.log.suppressedLines } else { '?' }) + ')')

    # ---- G21 반복 실패 잠금이 진단에서 읽힌다 (TSK-000531) ----
    #      건수만으로는 다음 행동을 고를 수 없다. 격리(다시 보내면 풀림)와 복구 필요(안 풀림)를
    #      구분하고, 원인·시각·임계값을 함께 내야 운영자가 무엇을 해야 하는지 알 수 있다.
    Reset-Fixture
    Set-Health @{
        version = 'watcher-v3.0'; pid = $selfPid; startedAt = $nowStamp; lastHeartbeat = $nowStamp
        backlogCount = 0; quarantinedCount = 1; recoveryRequiredCount = 1; recoveryRequiredThreshold = 6
    }
    $itemsDir = Join-Path (Join-Path $root 'state') 'items'
    New-Item -ItemType Directory -Force -Path $itemsDir | Out-Null
    $lockedAt = (Get-Date).AddMinutes(-42).ToString('yyyy-MM-dd HH:mm:ss')
    ([PSCustomObject]@{
        captureId = 'CAP0009'; attempts = 3; lastError = 'SENTINELNOTETEXT'
        lastAttemptAt = $lockedAt; quarantined = $true; quarantineReason = 'SENTINELPERSONNAME'
        quarantineCause = 'processor_failed'; quarantineFingerprint = 'cafe'; quarantinedAt = $lockedAt
        repeatCause = 'processor_failed'; repeatFailures = 6
        recoveryRequired = $true; recoveryCause = 'processor_failed'; recoveryRequiredAt = $lockedAt
    } | ConvertTo-Json) | Out-File -Encoding utf8 (Join-Path $itemsDir 'CAP0009.json')
    $stagingDir = Join-Path (Join-Path (Join-Path $root 'state') 'staging') 'CAP0009'
    New-Item -ItemType Directory -Force -Path $stagingDir | Out-Null
    ([PSCustomObject]@{
        version = 'card-capture-failure-v1'; captureId = 'CAP0009'; attempt = 3
        causeClass = 'processor_failed'; reason = 'processor_exit_1'; failures = 6; sameCauseFailures = 6
        recoveryThreshold = 6; quarantined = $true; recoveryRequired = $true
        attemptStartedAt = $lockedAt; firstFailedAt = $lockedAt; lastFailedAt = $lockedAt
    } | ConvertTo-Json) | Out-File -Encoding utf8 (Join-Path $stagingDir 'failure.json')
    $r = Invoke-Health @('-Json', '-WatcherProcessPattern', $selfPattern)
    $j = Get-Json $r
    $row = $null
    if ($null -ne $j) { $row = @($j.observed.blocked | Where-Object { $_.captureId -eq 'CAP0009' })[0] }
    T ($null -ne $row -and $row.recoveryRequired -eq $true -and $row.cause -eq 'processor_failed') 'G21 blocked receipt reports recovery-required state with a closed cause class'
    T ($null -ne $row -and $null -ne $row.sinceAgeMin -and [double]$row.sinceAgeMin -ge 40) ('G21 blocked receipt says since when (' + $(if ($row) { Show-Or-Null $row.sinceAgeMin } else { '?' }) + ' min)')
    T ($null -ne $j -and $j.observed.recoveryRequiredCount -eq 1 -and $j.observed.recoveryRequiredThreshold -eq 6) 'G21 recovery-required count and threshold are both visible'
    T ($null -ne $j -and @($j.reasons) -contains 'recovery_required_captures') 'G21 recovery-required is its own verdict reason (requeue does not clear it)'
    T ($r.code -eq 2) ('G21 recovery-required is critical (exit ' + $r.code + ')')
    T ($null -ne $j -and $j.observed.failureJournalCount -eq 1 -and @($j.observed.failureJournals)[0].cause -eq 'processor_failed') 'G21 closed failure receipts are counted apart from interrupted attempts'
    T ($null -ne $j -and $j.observed.interruptedCount -eq 0) 'G21 a closed failure is not reported as an interrupted attempt'
    # redaction: 상태 파일의 자유 문자열은 기계·사람 어느 출력에도 나가지 않는다.
    T (Test-NoSentinel $r.out) 'G21 free-form lastError/quarantineReason never reach the diagnostic output'
    $rh = Invoke-Health @('-WatcherProcessPattern', $selfPattern)
    T ($rh.out -match 'recoveryRequired\s*:' -and $rh.out -match '복구 필요' -and $rh.out -match 'cause=processor_failed') 'G21 human output names the blocked receipt, its cause and its state'
    T (Test-NoSentinel $rh.out) 'G21 human output stays redacted too'
} finally {
    $env:LOCALAPPDATA = $origLocal
    Remove-Item $sandbox -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host ("summary: pass=" + $pass + " fail=" + $fail)
if ($fail -gt 0) { Write-Host 'RESULT: FAIL'; exit 1 } else { Write-Host 'RESULT: PASS'; exit 0 }
