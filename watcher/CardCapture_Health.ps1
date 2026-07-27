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
#   watcher.log는 99% 이상이 처리기 raw 출력이므로 원문 tail을 절대 되풀이하지 않고,
#   워처 자신이 쓴 타임스탬프 줄만 allowlist 이벤트 라벨로 환원해 보여준다.
#   출력이 허용하는 식별자는 captureId(서버 발급 형식)와 pid·카운트·시각뿐이다.
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

# 임계값은 기존 계약값만 재사용한다 — 새 정책 수치를 발명하지 않는다.
#   15분: 기존 health heartbeat 임계값.  30분: 기존 stale lock / lease 임계값.  3회: 항목별 시도 상한.
$HeartbeatStaleMin = 15
$BacklogStaleMin = 30
$MaxAttempts = 3

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
        $map[[int]$p.ProcessId] = $isWatcher
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
    $unreadableItems = 0
    $itemsDir = Join-Path $StateDir 'items'
    if (Test-Path $itemsDir) {
        foreach ($f in (Get-ChildItem $itemsDir -Filter '*.json' -ErrorAction SilentlyContinue | Sort-Object Name)) {
            $s = Read-JsonFile $f.FullName
            if ($null -eq $s) { $unreadableItems++; continue }
            $id = Get-SafeId ($f.Name -replace '\.json$', '')
            if ((Get-Prop $s 'quarantined') -eq $true) { [void]$quarantined.Add($id) }
            $attempts = 0
            try { $attempts = [int](Get-Prop $s 'attempts') } catch { $attempts = 0 }
            if ($attempts -ge $MaxAttempts) { [void]$attemptCapped.Add($id) }
        }
    }

    $interrupted = New-Object System.Collections.ArrayList
    $stagingDir = Join-Path $StateDir 'staging'
    if (Test-Path $stagingDir) {
        foreach ($d in (Get-ChildItem $stagingDir -Directory -ErrorAction SilentlyContinue | Sort-Object Name)) {
            if (Test-Path (Join-Path $d.FullName 'begin.json')) { [void]$interrupted.Add((Get-SafeId $d.Name)) }
        }
    }

    return [PSCustomObject]@{
        stateDir = (Test-Path $StateDir)
        claims = @($claims.ToArray())
        activeClaims = $claims.Count
        expiredLeases = $expiredLeases
        unknownLeases = $unknownLeases
        quarantined = @($quarantined.ToArray())
        quarantinedCount = $quarantined.Count
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
    @{ label = 'card_done';           re = '^card done' },
    @{ label = 'card_failed';         re = '^card FAILED' },
    @{ label = 'quarantine';          re = '^QUARANTINE ' },
    @{ label = 'quarantine_released'; re = '^quarantine released' },
    @{ label = 'loop_done';           re = '^processing loop done' },
    @{ label = 'lock';                re = '^(lock exists|stale lock)' },
    @{ label = 'lease';               re = '^(claim held by|stale lease reclaimed|claim race lost|claim write failed|lease lost during processing)' },
    @{ label = 'interrupted';         re = '^interrupted attempt' },
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
            if ($rest -match $pat.re) { $label = $pat.label; break }
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
    interruptedCount = $null
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
    $reported.interruptedCount = Get-Prop $h 'interruptedCount'

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
        } elseif ($procMap.ContainsKey($pidInt) -and $procMap[$pidInt]) {
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
}

# 고아 워처: health가 가리키지 않는데 워처로 떠 있는 프로세스.
if ($null -ne $procMap) {
    $orphans = New-Object System.Collections.ArrayList
    foreach ($k in ($procMap.Keys | Sort-Object)) {
        if (-not $procMap[$k]) { continue }
        if ($k -eq $PID) { continue }                                  # 이 진단 프로세스 자신
        if ($null -ne $watcher.pid -and $k -eq $watcher.pid) { continue }
        [void]$orphans.Add([int]$k)
    }
    $watcher.orphanWatcherPids = @($orphans.ToArray())
    # 기록된 pid가 실제 워처인 동안의 중복 프로세스는 싱글턴 mutex가 정리한다 — 그때는 경보하지 않는다.
    if ($orphans.Count -gt 0 -and $watcher.process.identity -ne 'watcher') { Sev 1 'orphan_watcher_process' }
}

# state 디렉터리 관측값은 health 파일이 없거나 낡아도 지금의 사실이다.
if ($observed.quarantinedCount -gt 0) { Sev 2 'quarantined_captures' }
if ($observed.expiredLeases -gt 0) { Sev 1 'expired_lease' }
if ($observed.interruptedCount -gt 0) { Sev 1 'interrupted_attempt' }
if ($observed.unreadableItemFiles -gt 0) { Sev 1 'unreadable_state_file' }
if (-not $log.present) { Sev 1 'log_missing' }

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
if (@($watcher.orphanWatcherPids).Count -gt 0) {
    Write-Host ("orphan watcher pid : " + (@($watcher.orphanWatcherPids) -join ', ') + "   (health가 가리키지 않는 워처 프로세스)")
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
    Write-Host ("interrupted        : " + $iLine + "  (commit marker 없는 attempt)")
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

Write-Host ''
Write-Host ("health exit code   : " + $script:exit + "  (0 ok / 1 warn / 2 critical)")
exit $script:exit
