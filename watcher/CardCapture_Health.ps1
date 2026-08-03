# CardCapture_Health.ps1 — 워처·처리 상태 진단 표면 (PII 없이)
# Kairen-Ref: TSK-000142 (최초), TSK-000280 (FI-029 처리 health dashboard + redacted 진단)
# 사용: powershell -NoProfile -ExecutionPolicy Bypass -File watcher\CardCapture_Health.ps1
#       powershell -NoProfile -ExecutionPolicy Bypass -File watcher\CardCapture_Health.ps1 -Json
# 종료코드: 0=정상, 1=경고, 2=위험 (기존 계약 유지)
#
# 이 스크립트는 아무것도 쓰지 않는다 (읽기 전용 진단).
#
# redaction 계약: capturer·person 이름, quickName, 메모, brief 내용, 토큰, Drive folder ID,
#   워처가 기록한 자유 문자열(lastError, quarantineReason, claim owner, inbox 경로),
#   그리고 watcher.log의 처리기(codex) raw 출력은 사람용·기계용 어느 출력에도 넣지 않는다.
#   워처 자신이 쓴 타임스탬프 줄만 allowlist 이벤트 라벨로 환원해 보여준다.
#   출력이 허용하는 식별자는 captureId(서버 발급 형식)와 pid·카운트·시각뿐이다.
#   TSK-000300부터 처리기 raw 출력은 watcher.log가 아니라 <Root>\processor\ 로 간다.
#   그 파일들은 **열지 않는다** — 건수와 나이만 세고 경로를 알려준다(내용은 명함 원문이다).
#   과거 watcher.log에는 처리기 출력이 그대로 섞여 있으므로 skippedLines 집계는 그대로 둔다.
#
# 주의: UTF-8 BOM 유지 (한글 경로).

param(
    # 진단 대상 루트. 기본값은 워처가 쓰는 %LOCALAPPDATA%\CardCapture.
    [string]$Root = '',
    # 기계 판독용 JSON 한 덩어리만 출력한다 (사람용 텍스트는 내지 않는다).
    [switch]$Json,
    # 기록된 pid가 '정말 워처인지' 판정할 때 쓰는 command line 정규식.
    # 배포 이름이 다르거나 결정적 테스트가 필요할 때만 바꾼다.
    [string]$WatcherProcessPattern = 'CardCapture_Watcher\.ps1'
)

$ErrorActionPreference = 'Continue'

if (-not $Root) { $Root = Join-Path $env:LOCALAPPDATA 'CardCapture' }
$HealthFile = Join-Path $Root 'watcher-health.json'
$LogFile = Join-Path $Root 'watcher.log'
$StateDir = Join-Path $Root 'state'
# 처리기 raw 출력이 격리돼 있는 곳. 내용은 절대 읽지 않는다 — 건수와 나이만 센다.
$ProcessorDir = Join-Path $Root 'processor'

# 임계값은 기존 계약값만 재사용한다 — 새 정책 수치를 발명하지 않는다.
#   15분: 기존 health heartbeat 임계값.  30분: 기존 stale lock / lease 임계값.  3회: 항목별 시도 상한.
$HeartbeatStaleMin = 15
$BacklogStaleMin = 30
$MaxAttempts = 3
# 반복 실패 잠금 임계값. 워처와 같은 유도를 쓴다(첫 예산 + 격리가 주는 requeue 1회분).
# health 파일이 값을 실어 오면 그 값을 쓰고, 없으면 이 유도값으로 말한다 — 임계값을 모른 채
# '6회 실패'만 보여 주면 운영자가 몇 번 남았는지 읽을 수 없다.
$RecoveryRequiredFailures = ($MaxAttempts * 2)
# 워처가 쓰는 닫힌 원인 enum. 이 목록 밖의 값은 출력하지 않는다 — 상태 파일의 임의 문자열이
# 대시보드로 새는 경로를 만들지 않기 위해서다(자유 문자열 redaction 계약과 같은 이유).
$FailureCauseClasses = @('processor_failed','processor_timeout','result_incomplete','internal_state_failed','interrupted_attempt','unknown_failure')

$script:exit = 0
$script:reasons = New-Object System.Collections.ArrayList

function Sev($level, $reason) {
    if ($reason -and (-not $script:reasons.Contains($reason))) { [void]$script:reasons.Add($reason) }
    if ($level -gt $script:exit) { $script:exit = $level }
}

function Read-JsonFile($path) {
    if (-not (Test-Path $path)) { return $null }
    $raw = $null
    try { $raw = Get-Content $path -Raw -Encoding UTF8 } catch { return $null }
    if (-not $raw) { return $null }
    try { return ($raw | ConvertFrom-Json) } catch { return $null }
}

function Get-Prop($obj, $name) {
    if ($null -eq $obj) { return $null }
    $p = $obj.PSObject.Properties[$name]
    if ($null -eq $p) { return $null }
    return $p.Value
}

function ConvertTo-Stamp($v) {
    if ($null -eq $v) { return $null }
    $s = [string]$v
    if (-not $s) { return $null }
    try { return [datetime]$s } catch { return $null }
}

function Get-AgeMin($dt) {
    if ($null -eq $dt) { return $null }
    return [math]::Round(((Get-Date) - $dt).TotalMinutes, 1)
}

function Show($v) {
    if ($null -eq $v) { return 'unknown' }
    $s = [string]$v
    if ($s -eq '') { return 'unknown' }
    return $s
}

# 출력에 넣어도 되는 식별자는 서버가 발급한 captureId 형식뿐이다(워처 Get-SafeCaptureId와 동일 규칙).
# 그 밖의 이름은 임의 문자열이므로 라벨로 치환한다 — 상태 파일 이름으로 대시보드에 문자열을 주입할 수 없다.
function Get-SafeId($name) {
    $s = [string]$name
    if ($s -match '^[A-Za-z0-9][A-Za-z0-9_.\-]{0,79}$') { return $s }
    return '(unsafe-name)'
}

# ---------------------------------------------------------------------------
# 프로세스 신원 확인
#   pid가 살아 있다는 것만으로는 워처가 살아 있다는 뜻이 아니다 — Windows는 pid를 재사용한다.
#   (2026-07-27 실측: health가 가리키던 pid는 죽었고, 로그를 한 줄도 쓰지 않는 다른 워처가 떠 있었다.)
# ---------------------------------------------------------------------------
function Get-PowerShellProcessMap {
    $map = @{}
    $procs = $null
    try {
        $procs = Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction Stop
    } catch {
        return $null   # CIM 사용 불가 = 신원 확인 불가 (0으로 단정하지 않는다)
    }
    if ($null -eq $procs) { return $map }
    foreach ($p in $procs) {
        $isWatcher = $false
        try { $isWatcher = ([string]$p.CommandLine -match $WatcherProcessPattern) } catch { $isWatcher = $false }
        # 시작 시각까지 담는다. 고아가 둘 이상일 때 pid만으로는 운영자가 무엇을 이미 정리했는지,
        # 어느 쪽이 먼저 떠서 싱글턴 mutex를 쥐고 있는지 구분할 수 없다.
        $startedAt = $null
        try {
            if ($null -ne $p.CreationDate) { $startedAt = ([datetime]$p.CreationDate).ToString('yyyy-MM-dd HH:mm:ss') }
        } catch { $startedAt = $null }
        $map[[int]$p.ProcessId] = [PSCustomObject]@{ isWatcher = $isWatcher; startedAt = $startedAt }
    }
    return $map
}

# ---------------------------------------------------------------------------
# state 디렉터리 직접 관측 (health 파일이 낡았거나 필드가 없어도 지금의 사실을 말한다)
# ---------------------------------------------------------------------------
function Get-ObservedState {
    $now = Get-Date
    $claims = New-Object System.Collections.ArrayList
    $expiredLeases = 0
    $unknownLeases = 0
    $claimsDir = Join-Path $StateDir 'claims'
    if (Test-Path $claimsDir) {
        foreach ($f in (Get-ChildItem $claimsDir -Filter '*.claim.json' -ErrorAction SilentlyContinue | Sort-Object Name)) {
            $c = Read-JsonFile $f.FullName
            $id = Get-SafeId ($f.Name -replace '\.claim\.json$', '')
            $exp = ConvertTo-Stamp (Get-Prop $c 'leaseExpiresAt')
            $expired = $null
            $leftMin = $null
            if ($null -ne $exp) {
                $leftMin = [math]::Round(($exp - $now).TotalMinutes, 1)
                $expired = ($exp -le $now)
            }
            if ($expired -eq $true) { $expiredLeases++ }
            if ($null -eq $expired) { $unknownLeases++ }
            $attempt = $null
            $a = Get-Prop $c 'attempt'
            if ($null -ne $a) { try { $attempt = [int]$a } catch { $attempt = $null } }
            [void]$claims.Add([PSCustomObject]@{
                captureId = $id
                attempt = $attempt
                expired = $expired
                leaseMinutesLeft = $leftMin
            })
        }
    }

    $quarantined = New-Object System.Collections.ArrayList
    $attemptCapped = New-Object System.Collections.ArrayList
    # 건수만으로는 다음 행동을 고를 수 없다. '어느 receipt가 / 왜 / 언제부터'까지 낸다 (TSK-000531).
    # 원인은 닫힌 enum만, 자유 문자열(lastError·quarantineReason)은 그대로 둔다.
    $blocked = New-Object System.Collections.ArrayList
    $recoveryRequired = New-Object System.Collections.ArrayList
    $unreadableItems = 0
    $itemsDir = Join-Path $StateDir 'items'
    if (Test-Path $itemsDir) {
        foreach ($f in (Get-ChildItem $itemsDir -Filter '*.json' -ErrorAction SilentlyContinue | Sort-Object Name)) {
            $s = Read-JsonFile $f.FullName
            if ($null -eq $s) { $unreadableItems++; continue }
            $id = Get-SafeId ($f.Name -replace '\.json$', '')
            $isQuarantined = ((Get-Prop $s 'quarantined') -eq $true)
            $isRecovery = ((Get-Prop $s 'recoveryRequired') -eq $true)
            if ($isQuarantined) { [void]$quarantined.Add($id) }
            if ($isRecovery) { [void]$recoveryRequired.Add($id) }
            $attempts = 0
            try { $attempts = [int](Get-Prop $s 'attempts') } catch { $attempts = 0 }
            if ($attempts -ge $MaxAttempts) { [void]$attemptCapped.Add($id) }
            if ($isQuarantined -or $isRecovery) {
                $cause = [string](Get-Prop $s 'quarantineCause')
                if ($isRecovery -and (Get-Prop $s 'recoveryCause')) { $cause = [string](Get-Prop $s 'recoveryCause') }
                if ($FailureCauseClasses -notcontains $cause) { $cause = 'unknown_failure' }
                $repeat = 0
                try { $repeat = [int](Get-Prop $s 'repeatFailures') } catch { $repeat = 0 }
                $sinceRaw = Get-Prop $s 'quarantinedAt'
                if ($isRecovery -and (Get-Prop $s 'recoveryRequiredAt')) { $sinceRaw = Get-Prop $s 'recoveryRequiredAt' }
                [void]$blocked.Add([PSCustomObject]@{
                    captureId = $id
                    cause = $cause
                    attempts = $attempts
                    repeatFailures = $repeat
                    recoveryRequired = $isRecovery
                    sinceAgeMin = (Get-AgeMin (ConvertTo-Stamp $sinceRaw))
                })
            }
        }
    }

    $interrupted = New-Object System.Collections.ArrayList
    # 정상 실패 영수증. begin marker가 남은 '중단'과 다른 상태다 — 이 둘이 구분돼야
    # 운영자가 '죽은 것'과 '실패해서 끝난 것'을 섞지 않는다.
    $failureJournals = New-Object System.Collections.ArrayList
    $stagingDir = Join-Path $StateDir 'staging'
    if (Test-Path $stagingDir) {
        foreach ($d in (Get-ChildItem $stagingDir -Directory -ErrorAction SilentlyContinue | Sort-Object Name)) {
            if (Test-Path (Join-Path $d.FullName 'begin.json')) { [void]$interrupted.Add((Get-SafeId $d.Name)) }
            $jPath = Join-Path $d.FullName 'failure.json'
            if (-not (Test-Path $jPath)) { continue }
            $j = Read-JsonFile $jPath
            $cause = [string](Get-Prop $j 'causeClass')
            if ($FailureCauseClasses -notcontains $cause) { $cause = 'unknown_failure' }
            $failures = 0
            try { $failures = [int](Get-Prop $j 'failures') } catch { $failures = 0 }
            [void]$failureJournals.Add([PSCustomObject]@{
                captureId = (Get-SafeId $d.Name)
                cause = $cause
                failures = $failures
                lastFailedAgeMin = (Get-AgeMin (ConvertTo-Stamp (Get-Prop $j 'lastFailedAt')))
            })
        }
    }

    # 로그 쓰기 실패 흔적. watcher.log·watcher-health.json을 못 쓰는 동안에도 워처는 state\에
    # 이것을 남긴다 (2026-07-27 실측 장애에서 state\ 쓰기는 정상이었다). 그래서 이 값은
    # health 파일이 낡았거나 아예 갱신되지 않는 상황에서도 지금의 사실을 말한다.
    # 자유 문자열(lastError·logFile)은 읽지 않는다 — 파생값만 낸다.
    $logFailure = $null
    $lfPath = Join-Path (Join-Path $StateDir 'logging') 'log-write-failure.json'
    if (Test-Path $lfPath) {
        $lf = Read-JsonFile $lfPath
        $pending = 0
        $total = 0
        if ($null -ne $lf) {
            try { $pending = [int](Get-Prop $lf 'pendingDroppedLines') } catch { $pending = 0 }
            try { $total = [int](Get-Prop $lf 'droppedTotal') } catch { $total = 0 }
        }
        $logFailure = [PSCustomObject]@{
            readable = ($null -ne $lf)
            pendingDroppedLines = $pending
            droppedTotal = $total
            firstFailureAgeMin = (Get-AgeMin (ConvertTo-Stamp (Get-Prop $lf 'firstFailureAt')))
            lastFailureAgeMin = (Get-AgeMin (ConvertTo-Stamp (Get-Prop $lf 'lastFailureAt')))
            recovered = ($null -ne (ConvertTo-Stamp (Get-Prop $lf 'recoveredAt')))
        }
    }

    # 처리기 raw 출력 보관 현황. 파일 내용은 절대 읽지 않는다 (명함 내용이 담긴다).
    $procCount = 0
    $procOldest = $null
    $procPresent = (Test-Path $ProcessorDir)
    if ($procPresent) {
        $pf = @(Get-ChildItem $ProcessorDir -Filter '*.log' -File -ErrorAction SilentlyContinue)
        $procCount = $pf.Count
        if ($procCount -gt 0) {
            $procOldest = Get-AgeMin (($pf | Sort-Object LastWriteTime | Select-Object -First 1).LastWriteTime)
        }
    }

    return [PSCustomObject]@{
        stateDir = (Test-Path $StateDir)
        logWriteFailure = $logFailure
        processorLogs = [PSCustomObject]@{
            present = $procPresent
            count = $procCount
            oldestAgeMin = $procOldest
        }
        claims = @($claims.ToArray())
        activeClaims = $claims.Count
        expiredLeases = $expiredLeases
        unknownLeases = $unknownLeases
        quarantined = @($quarantined.ToArray())
        quarantinedCount = $quarantined.Count
        recoveryRequired = @($recoveryRequired.ToArray())
        recoveryRequiredCount = $recoveryRequired.Count
        recoveryRequiredThreshold = $RecoveryRequiredFailures
        blocked = @($blocked.ToArray())
        failureJournals = @($failureJournals.ToArray())
        failureJournalCount = $failureJournals.Count
        attemptCapped = @($attemptCapped.ToArray())
        attemptCappedCount = $attemptCapped.Count
        interrupted = @($interrupted.ToArray())
        interruptedCount = $interrupted.Count
        unreadableItemFiles = $unreadableItems
    }
}

# ---------------------------------------------------------------------------
# watcher.log 이벤트 환원
#   워처가 쓴 '타임스탬프 + 알려진 이벤트' 줄만 라벨로 바꿔 보여준다.
#   나머지(= codex 처리기 raw 출력, 명함 내용이 그대로 담긴다)는 세지도 출력하지도 않는다.
# ---------------------------------------------------------------------------
$LogEventPatterns = @(
    @{ label = 'watcher_started';     re = '^=== watcher started' },
    @{ label = 'watcher_exiting';     re = '^watcher exiting' },
    @{ label = 'heartbeat';           re = '^heartbeat \(PID=' },
    @{ label = 'singleton_blocked';   re = '^another instance running' },
    @{ label = 'quick_pass';          re = '^quick-pass (start|done|error)' },
    @{ label = 'card_start';          re = '^processing card \(deep\)' },
    # 처리기 실행 표시. 이 줄이 있어야 운영자가 raw 출력이 어느 파일에 있는지 찾아간다.
    # 파일 이름은 captureId + attempt 뿐이라 출력 allowlist(captureId·숫자·시각) 안에 있다.
    @{ label = 'processor_run';       re = '^processor (start|end) ' },
    @{ label = 'processor_retention'; re = '^processor logs expired' },
    # 별도 라벨이어야 한다. '^WARNING: ' 는 이미 unsafe_capture_name 이 잡고 있어서
    # WARNING 접두사를 쓰면 운영자가 '캡처 이름이 이상하다'로 잘못 읽는다.
    @{ label = 'processor_log_unavailable'; re = '^processor log unavailable' },
    # 로그 쓰기가 실패했다가 복구된 구간. 이 라벨이 없으면 공백의 존재 자체가 진단에서 사라진다.
    @{ label = 'log_write_recovered'; re = '^LOG WRITE RECOVERED' },
    @{ label = 'card_done';           re = '^card done' },
    @{ label = 'card_failed';         re = '^card FAILED' },
    @{ label = 'quarantine';          re = '^QUARANTINE ' },
    @{ label = 'quarantine_released'; re = '^quarantine released' },
    @{ label = 'quarantine_hold';     re = '^quarantine hold ' },
    # 반복 실패 잠금 (TSK-000531). 격리와 별도 라벨이어야 한다 — 격리는 '한 번 더 해 보자'이고
    # 이것은 '같은 방법으로는 안 된다'라서 운영자가 취할 행동이 다르다.
    @{ label = 'recovery_required';   re = '^RECOVERY REQUIRED ' },
    @{ label = 'recovery_hold';       re = '^recovery hold ' },
    @{ label = 'staging_reconciled';  re = '^stale staging marker reconciled ' },
    @{ label = 'loop_done';           re = '^processing loop done' },
    @{ label = 'lock';                re = '^(lock exists|stale lock)' },
    @{ label = 'lease';               re = '^(claim held by|stale lease reclaimed|claim race lost|claim write failed|lease lost during processing)' },
    # 'interrupted attempt(s)…' 뿐 아니라 복구·건너뜀 줄까지 같은 라벨로 잡는다. 예전에는
    # 'interrupted deep output restored'가 어느 패턴에도 걸리지 않아 처리기 출력으로 오인돼 버려졌다.
    @{ label = 'interrupted';         re = '^interrupted ' },
    @{ label = 'failure_warning';     re = '^WARNING: 3\+' },
    @{ label = 'unsafe_capture_name'; re = '^WARNING: ' },
    @{ label = 'codex_missing';       re = '^codex.exe not found' },
    @{ label = 'notify';              re = '^notify ' },
    @{ label = 'startup_sweep';       re = '^(startup sweep|event trigger|poll trigger)' },
    @{ label = 'error';               re = '^(processing error:|loop error:|processor error for|state write failed|staging )' },
    @{ label = 'fatal';               re = '^FATAL:' }
)

function Get-LogEvents {
    $res = [PSCustomObject]@{ present = $false; events = @(); counts = @{}; lastEventAt = $null; skippedLines = 0 }
    if (-not (Test-Path $LogFile)) { return $res }
    $res.present = $true
    $lines = $null
    try { $lines = [System.IO.File]::ReadAllLines($LogFile, [System.Text.Encoding]::UTF8) } catch { return $res }
    $events = New-Object System.Collections.ArrayList
    $counts = @{}
    $skipped = 0
    foreach ($line in $lines) {
        if ($line -notmatch '^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (.*)$') { $skipped++; continue }
        $stamp = $Matches[1]
        $rest = $Matches[2]
        $label = $null
        foreach ($pat in $LogEventPatterns) {
            # -cmatch(대소문자 구분)이어야 한다. -match였을 때 'quarantine released'가 '^QUARANTINE '에
            # 걸려 격리 해제가 격리 발생으로 집계됐다 — 운영자가 정반대 사실을 읽는다.
            # 모든 패턴은 워처가 실제로 쓰는 대소문자 그대로 적혀 있다.
            if ($rest -cmatch $pat.re) { $label = $pat.label; break }
        }
        if (-not $label) { $skipped++; continue }   # 워처가 쓰지 않은 줄 = 처리기 출력. 버린다.
        if ($counts.ContainsKey($label)) { $counts[$label] = $counts[$label] + 1 } else { $counts[$label] = 1 }
        [void]$events.Add([PSCustomObject]@{ at = $stamp; event = $label })
    }
    $res.skippedLines = $skipped
    $res.counts = $counts
    $all = $events.ToArray()
    if ($all.Count -gt 0) {
        $res.lastEventAt = $all[$all.Count - 1].at
        $take = 6   # 기존 tail 개수와 동일
        if ($all.Count -lt $take) { $take = $all.Count }
        $res.events = @($all[($all.Count - $take)..($all.Count - 1)])
    }
    return $res
}

# ---------------------------------------------------------------------------
# 사실 수집
# ---------------------------------------------------------------------------
$observed = Get-ObservedState
$log = Get-LogEvents
$procMap = Get-PowerShellProcessMap

$watcher = [PSCustomObject]@{
    version = $null
    pid = $null
    startedAt = $null
    lastHeartbeat = $null
    heartbeatAgeMin = $null
    process = [PSCustomObject]@{ running = $null; identity = 'unknown' }
    orphanWatcherPids = @()
    orphanWatchers = @()
}
$reported = [PSCustomObject]@{
    stale = $null
    backlogCount = $null
    backlogOldestAgeMin = $null
    consecutiveFailures = $null
    lastRunStart = $null
    lastRunEnd = $null
    lastExitCode = $null
    lockExists = $null
    activeClaims = $null
    quarantinedCount = $null
    recoveryRequiredCount = $null
    recoveryRequiredThreshold = $null
    interruptedCount = $null
    pushConfigured = $null
    pushPendingCount = $null
    pushLastFlushAt = $null
    pushLastOutcome = $null
}

$healthPresent = Test-Path $HealthFile
$h = $null
if (-not $healthPresent) {
    Sev 1 'health_file_missing'
} else {
    $h = Read-JsonFile $HealthFile
    if ($null -eq $h) { Sev 2 'health_file_unreadable' }
}

if ($null -ne $h) {
    $watcher.version = Get-Prop $h 'version'
    $watcher.startedAt = Get-Prop $h 'startedAt'
    $watcher.lastHeartbeat = Get-Prop $h 'lastHeartbeat'

    $reported.backlogCount = Get-Prop $h 'backlogCount'
    $reported.backlogOldestAgeMin = Get-Prop $h 'backlogOldestAgeMin'
    $reported.consecutiveFailures = Get-Prop $h 'consecutiveFailures'
    $reported.lastRunStart = Get-Prop $h 'lastRunStart'
    $reported.lastRunEnd = Get-Prop $h 'lastRunEnd'
    $reported.lastExitCode = Get-Prop $h 'lastExitCode'
    $reported.lockExists = Get-Prop $h 'lockExists'
    $reported.activeClaims = Get-Prop $h 'activeClaims'
    $reported.quarantinedCount = Get-Prop $h 'quarantinedCount'
    $reported.recoveryRequiredCount = Get-Prop $h 'recoveryRequiredCount'
    $reported.recoveryRequiredThreshold = Get-Prop $h 'recoveryRequiredThreshold'
    $reported.interruptedCount = Get-Prop $h 'interruptedCount'
    $reported.pushConfigured = Get-Prop $h 'pushConfigured'
    $reported.pushPendingCount = Get-Prop $h 'pushPendingCount'
    $reported.pushLastFlushAt = Get-Prop $h 'pushLastFlushAt'
    $reported.pushLastOutcome = Get-Prop $h 'pushLastOutcome'

    # heartbeat
    $beat = ConvertTo-Stamp $watcher.lastHeartbeat
    if ($null -eq $beat) {
        Sev 2 'heartbeat_unknown'
    } else {
        $watcher.heartbeatAgeMin = Get-AgeMin $beat
        $reported.stale = ($watcher.heartbeatAgeMin -gt $HeartbeatStaleMin)
        if ($watcher.heartbeatAgeMin -gt $HeartbeatStaleMin) { Sev 2 'heartbeat_stale' }
    }

    # pid + 신원
    $pidVal = Get-Prop $h 'pid'
    $pidInt = 0
    try { if ($null -ne $pidVal) { $pidInt = [int]$pidVal } } catch { $pidInt = 0 }
    if ($pidInt -le 0) {
        $watcher.process.identity = 'unknown'
        Sev 2 'watcher_pid_unknown'
    } else {
        $watcher.pid = $pidInt
        $running = ($null -ne (Get-Process -Id $pidInt -ErrorAction SilentlyContinue))
        $watcher.process.running = $running
        if (-not $running) {
            $watcher.process.identity = 'not_running'
            Sev 2 'watcher_process_not_running'
        } elseif ($null -eq $procMap) {
            $watcher.process.identity = 'unknown'
            Sev 1 'watcher_identity_unverified'
        } elseif ($procMap.ContainsKey($pidInt) -and $procMap[$pidInt].isWatcher) {
            $watcher.process.identity = 'watcher'
        } else {
            # pid는 살아 있지만 워처가 아니다 = pid 재사용. 워처는 죽은 것이다.
            $watcher.process.identity = 'foreign'
            Sev 2 'watcher_pid_reused_by_other_process'
        }
    }

    # 워처가 기록한 backlog 값 (heartbeat가 낡았으면 이 값도 낡았다)
    $bc = $null
    try { if ($null -ne $reported.backlogCount) { $bc = [int]$reported.backlogCount } } catch { $bc = $null }
    if ($null -ne $bc -and $bc -gt 0) {
        $oldest = $null
        try { if ($null -ne $reported.backlogOldestAgeMin) { $oldest = [double]$reported.backlogOldestAgeMin } } catch { $oldest = $null }
        if ($null -ne $oldest -and $oldest -gt $BacklogStaleMin) { Sev 2 'backlog_stalled' } else { Sev 1 'backlog_pending' }
    }

    $cf = $null
    try { if ($null -ne $reported.consecutiveFailures) { $cf = [int]$reported.consecutiveFailures } } catch { $cf = $null }
    if ($null -ne $cf -and $cf -ge 3) { Sev 2 'consecutive_failures' }
    $pushPending = 0
    try { if ($null -ne $reported.pushPendingCount) { $pushPending = [int]$reported.pushPendingCount } } catch { $pushPending = 0 }
    if ($pushPending -gt 0) { Sev 1 'push_delivery_pending' }
    if ([string]$reported.pushLastOutcome -match 'failed=[1-9][0-9]*') { Sev 1 'push_delivery_failed' }
}

# 고아 워처: health가 가리키지 않는데 워처로 떠 있는 프로세스.
# 하나만 보고하면 안 된다 — 운영자가 그 하나만 정리하고 재기동하면 남은 프로세스가 싱글턴 mutex를
# 쥐고 있어 새 워처가 'another instance running, exit'로 즉시 죽는다(로그 라벨 singleton_blocked).
# 전부 나열하고, 각각의 시작 시각을 함께 낸다.
if ($null -ne $procMap) {
    $orphans = New-Object System.Collections.ArrayList
    foreach ($k in ($procMap.Keys | Sort-Object)) {
        if (-not $procMap[$k].isWatcher) { continue }
        if ($k -eq $PID) { continue }                                  # 이 진단 프로세스 자신
        if ($null -ne $watcher.pid -and $k -eq $watcher.pid) { continue }
        [void]$orphans.Add([PSCustomObject]@{ pid = [int]$k; startedAt = $procMap[$k].startedAt })
    }
    # 먼저 뜬 것부터. 시작 시각을 모르는 항목은 뒤로 보내고 pid로 순서를 확정한다(출력은 결정적이어야 한다).
    $sortedOrphans = @($orphans.ToArray() |
        Sort-Object @{ Expression = { if ($_.startedAt) { [string]$_.startedAt } else { '9999-99-99 99:99:99' } } },
                    @{ Expression = { [int]$_.pid } })
    $watcher.orphanWatchers = $sortedOrphans
    $watcher.orphanWatcherPids = @($sortedOrphans | ForEach-Object { [int]$_.pid })
    # 기록된 pid가 실제 워처인 동안의 중복 프로세스는 싱글턴 mutex가 정리한다 — 그때는 경보하지 않는다.
    if ($sortedOrphans.Count -gt 0 -and $watcher.process.identity -ne 'watcher') { Sev 1 'orphan_watcher_process' }
}

# state 디렉터리 관측값은 health 파일이 없거나 낡아도 지금의 사실이다.
if ($observed.quarantinedCount -gt 0) { Sev 2 'quarantined_captures' }
# 반복 실패 잠금은 별도 사유다. 격리는 사람이 다시 보내면 풀리지만 이것은 풀리지 않는다 —
# 두 상태를 한 사유로 묶으면 운영자가 '앱에서 다시 보내면 되겠지'로 잘못 읽는다.
if ($observed.recoveryRequiredCount -gt 0) { Sev 2 'recovery_required_captures' }
if ($observed.expiredLeases -gt 0) { Sev 1 'expired_lease' }
if ($observed.interruptedCount -gt 0) { Sev 1 'interrupted_attempt' }
if ($observed.unreadableItemFiles -gt 0) { Sev 1 'unreadable_state_file' }
if (-not $log.present) { Sev 1 'log_missing' }

# 로그 쓰기 실패는 '진단 표면 자체가 눈이 먼 상태'다 — 지금 밀려 있으면 critical,
# 지나간 구간이면 warn. 흔적 파일이 있는데 읽히지 않는 것도 그 자체로 신호다.
if ($null -ne $observed.logWriteFailure) {
    if (-not $observed.logWriteFailure.readable) {
        Sev 1 'log_write_failure_record_unreadable'
    } elseif ($observed.logWriteFailure.pendingDroppedLines -gt 0) {
        Sev 2 'log_write_failing'
    } elseif ($observed.logWriteFailure.droppedTotal -gt 0) {
        Sev 1 'log_write_failed_earlier'
    }
}

$statusText = 'healthy'
if ($script:exit -eq 1) { $statusText = 'warn' }
if ($script:exit -eq 2) { $statusText = 'critical' }

# ---------------------------------------------------------------------------
# 출력
# ---------------------------------------------------------------------------
if ($Json) {
    $payload = [PSCustomObject]@{
        schema = 'cardcapture-health/1'
        generatedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
        status = $statusText
        exitCode = $script:exit
        reasons = @($script:reasons.ToArray())
        healthFile = $(if ($healthPresent) { 'present' } else { 'missing' })
        watcher = $watcher
        reported = $reported
        observed = $observed
        log = [PSCustomObject]@{
            present = $log.present
            lastEventAt = $log.lastEventAt
            eventCounts = $log.counts
            recentEvents = @($log.events)
            suppressedLines = $log.skippedLines
        }
    }
    Write-Output ($payload | ConvertTo-Json -Depth 8)
    exit $script:exit
}

$reasonText = 'none'
if ($script:reasons.Count -gt 0) { $reasonText = (($script:reasons.ToArray()) -join ', ') }

Write-Host '=== Card Capture Health ==='
Write-Host ("verdict            : " + $statusText.ToUpper() + "  (exit " + $script:exit + ")")
Write-Host ("reasons            : " + $reasonText)
Write-Host ("checked at         : " + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))

Write-Host ''
Write-Host '--- 워처 프로세스 ---'
if (-not $healthPresent) {
    Write-Host 'health file        : MISSING (워처가 아직 한 번도 기록하지 않았다)'
} elseif ($null -eq $h) {
    Write-Host 'health file        : UNREADABLE (JSON 파싱 실패)'
} else {
    Write-Host ("version            : " + (Show $watcher.version))
    Write-Host ("pid                : " + (Show $watcher.pid))
    Write-Host ("startedAt          : " + (Show $watcher.startedAt))
    $beatLine = Show $watcher.lastHeartbeat
    if ($null -ne $watcher.heartbeatAgeMin) { $beatLine = $beatLine + ("  ({0:N1} min ago)" -f $watcher.heartbeatAgeMin) }
    Write-Host ("lastHeartbeat      : " + $beatLine)
    $procLine = 'unknown'
    if ($watcher.process.running -eq $true) { $procLine = 'alive' }
    if ($watcher.process.running -eq $false) { $procLine = 'NOT RUNNING' }
    Write-Host ("process            : " + $procLine)
    Write-Host ("identity           : " + $watcher.process.identity + "   (기록된 pid가 정말 워처인가)")
}
$orphanRows = @($watcher.orphanWatchers)
if ($orphanRows.Count -gt 0) {
    Write-Host ("orphan watchers    : " + $orphanRows.Count + "   (health가 가리키지 않는 워처 프로세스 — 전부 정리해야 재기동이 싱글턴에 막히지 않는다)")
    foreach ($o in $orphanRows) {
        $startText = 'unknown'
        if ($o.startedAt) { $startText = [string]$o.startedAt }
        Write-Host ("  - pid " + $o.pid + "  started " + $startText)
    }
}

Write-Host ''
$staleTag = ''
if ($reported.stale -eq $true) { $staleTag = '  [STALE — heartbeat가 낡았으니 아래 값도 낡았다]' }
Write-Host ('--- 워처가 마지막으로 기록한 값' + $staleTag + ' ---')
$oldestText = Show $reported.backlogOldestAgeMin
Write-Host ("backlog            : " + (Show $reported.backlogCount) + "  (oldest " + $oldestText + " min)")
Write-Host ("consecutiveFailures: " + (Show $reported.consecutiveFailures))
Write-Host ("lastRun            : " + (Show $reported.lastRunStart) + " -> " + (Show $reported.lastRunEnd) + "  (exit=" + (Show $reported.lastExitCode) + ")")
Write-Host ("lock               : " + (Show $reported.lockExists))
Write-Host ("push               : configured=" + (Show $reported.pushConfigured) + "  pending=" + (Show $reported.pushPendingCount) +
    "  last=" + (Show $reported.pushLastFlushAt) + "  outcome=" + (Show $reported.pushLastOutcome))

Write-Host ''
Write-Host '--- 지금 관측한 상태 (state 디렉터리) ---'
if (-not $observed.stateDir) {
    Write-Host 'state dir          : absent (claim/lease/격리 프로토콜 상태 없음)'
} else {
    Write-Host ("activeClaims       : " + $observed.activeClaims + "  (lease 만료 " + $observed.expiredLeases + ", 판독불가 " + $observed.unknownLeases + ")")
    foreach ($c in @($observed.claims)) {
        $leaseText = 'lease unknown'
        if ($c.expired -eq $true) { $leaseText = ("lease EXPIRED {0:N1} min ago" -f [math]::Abs($c.leaseMinutesLeft)) }
        elseif ($c.expired -eq $false) { $leaseText = ("lease {0:N1} min left" -f $c.leaseMinutesLeft) }
        Write-Host ("  - " + $c.captureId + "  attempt " + (Show $c.attempt) + "  " + $leaseText)
    }
    $qLine = [string]$observed.quarantinedCount
    if ($observed.quarantinedCount -gt 0) { $qLine = $qLine + "  [" + ((@($observed.quarantined)) -join ', ') + "]" }
    Write-Host ("quarantined        : " + $qLine)
    $aLine = [string]$observed.attemptCappedCount
    if ($observed.attemptCappedCount -gt 0) { $aLine = $aLine + "  [" + ((@($observed.attemptCapped)) -join ', ') + "]" }
    Write-Host ("attemptCapped      : " + $aLine + "  (attempts >= " + $MaxAttempts + ")")
    $iLine = [string]$observed.interruptedCount
    if ($observed.interruptedCount -gt 0) { $iLine = $iLine + "  [" + ((@($observed.interrupted)) -join ', ') + "]" }
    Write-Host ("interrupted        : " + $iLine + "  (commit marker 없는 attempt = 죽은 실행)")
    # 반복 실패 잠금과 그 임계값. 임계값이 없으면 '실패 6회'가 몇 번 남았다는 뜻인지 알 수 없다.
    $threshold = $observed.recoveryRequiredThreshold
    if ($null -ne $reported.recoveryRequiredThreshold) { $threshold = $reported.recoveryRequiredThreshold }
    Write-Host ("recoveryRequired   : " + $observed.recoveryRequiredCount +
        "  (같은 원인 연속 실패 " + (Show $threshold) + "회에서 잠긴다 — requeue로는 풀리지 않는다)")
    foreach ($b in @($observed.blocked)) {
        $stateText = if ($b.recoveryRequired) { '복구 필요' } else { '격리' }
        $sinceText = 'unknown'
        if ($null -ne $b.sinceAgeMin) { $sinceText = ("{0:N1} min 전부터" -f $b.sinceAgeMin) }
        Write-Host ("  - " + $b.captureId + "  " + $stateText + "  cause=" + $b.cause +
            "  attempts=" + $b.attempts + "/" + $MaxAttempts +
            "  repeatFailures=" + $b.repeatFailures + "/" + (Show $threshold) + "  " + $sinceText)
    }
    # 정상 실패 영수증(끝난 attempt). 중단(begin marker)과 다른 상태다.
    Write-Host ("failure receipts   : " + $observed.failureJournalCount + "  (실패로 닫힌 attempt — 중단과 다르다)")
    foreach ($j in @($observed.failureJournals)) {
        $ageText = 'unknown'
        if ($null -ne $j.lastFailedAgeMin) { $ageText = ("{0:N1} min 전" -f $j.lastFailedAgeMin) }
        Write-Host ("  - " + $j.captureId + "  cause=" + $j.cause + "  누적 " + $j.failures + "회  마지막 " + $ageText)
    }
}
if ($null -eq $observed.logWriteFailure) {
    Write-Host ("log write          : ok  (쓰기 실패 흔적 없음)")
} elseif (-not $observed.logWriteFailure.readable) {
    Write-Host ("log write          : UNREADABLE RECORD  (실패 흔적 파일을 읽지 못했다)")
} else {
    $lwLine = ("유실 누적 " + $observed.logWriteFailure.droppedTotal + "줄, 밀린 유실 " +
        $observed.logWriteFailure.pendingDroppedLines + "줄")
    if ($observed.logWriteFailure.pendingDroppedLines -gt 0) {
        $lwLine = "FAILING NOW  " + $lwLine + "  [워처는 살아 있어도 로그가 남지 않는 상태다]"
    } else {
        $lwLine = "recovered  " + $lwLine
    }
    Write-Host ("log write          : " + $lwLine + "  (마지막 실패 " +
        (Show $observed.logWriteFailure.lastFailureAgeMin) + " min 전)")
}

Write-Host ''
Write-Host '--- watcher.log 이벤트 (처리기 출력은 redaction으로 제외) ---'
if (-not $log.present) {
    Write-Host 'log                : MISSING'
} else {
    $countText = 'none'
    if ($log.counts.Count -gt 0) {
        $parts = New-Object System.Collections.ArrayList
        foreach ($k in ($log.counts.Keys | Sort-Object)) { [void]$parts.Add($k + '=' + $log.counts[$k]) }
        $countText = (($parts.ToArray()) -join ', ')
    }
    Write-Host ("event counts       : " + $countText)
    Write-Host ("suppressed lines   : " + $log.skippedLines + "  (처리기 raw 출력 — 명함 내용이 담기므로 출력하지 않는다)")
    foreach ($e in @($log.events)) { Write-Host ("  " + $e.at + "  " + $e.event) }
}
# 처리기 raw 출력은 별도 파일에 격리돼 있다. 어디를 봐야 하는지만 알려주고 내용은 읽지 않는다.
if (-not $observed.processorLogs.present) {
    Write-Host ("processor logs     : none  (처리기 로그 디렉터리 없음)")
} else {
    Write-Host ("processor logs     : " + $observed.processorLogs.count + "개  (가장 오래된 것 " +
        (Show $observed.processorLogs.oldestAgeMin) + " min)  경로 " + $ProcessorDir +
        "  — 명함 내용이 담긴 파일이다, 공유 전에 마스킹한다")
}

Write-Host ''
Write-Host ("health exit code   : " + $script:exit + "  (0 ok / 1 warn / 2 critical)")
exit $script:exit
