# log-pii-tests.ps1 — 워처 로그 PII 분리 · 처리기 로그 보존기간 · 로깅 실패 가시성 테스트
# Kairen-Ref: TSK-000300
# 실제 vault·Drive·실행 중인 워처·%LOCALAPPDATA%\CardCapture 를 절대 건드리지 않는다:
#   임시 sandbox 안에 %LOCALAPPDATA%\CardCapture 와 같은 모양의 root를 만들어 그 안에서만 검증한다.
#   테스트 로그 내용은 전부 합성 문자열이다 (실명·실연락처 없음).
# 사용: powershell -NoProfile -ExecutionPolicy Bypass -File watcher\tests\log-pii-tests.ps1
# 주의: UTF-8 BOM 유지 (한글 경로 CP949 오독 방지).

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $PSScriptRoot   # watcher/
$watcherScript = Join-Path $here 'CardCapture_Watcher.ps1'
$healthScript = Join-Path $here 'CardCapture_Health.ps1'

$pass = 0; $fail = 0
function T($ok, $label) {
    if ($ok) { $script:pass++; Write-Host "pass  $label" } else { $script:fail++; Write-Host "FAIL  $label" }
}
# 미구현 함수/변수는 예외를 던진다 — 예외도 FAIL 한 줄로 기록해 red baseline이 읽히게 한다.
function TB($label, $block) {
    try {
        $r = & $block
        T ([bool]$r) $label
    } catch {
        $script:fail++
        Write-Host ("FAIL  " + $label + "  [error: " + $_.Exception.Message + "]")
    }
}

# ---- sandbox: 운영과 같은 모양 (root\watcher.log, root\watcher-health.json, root\state, root\processor) ----
$sandbox = Join-Path $env:TEMP ("ccw-logpii-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$sbInbox = Join-Path $sandbox 'inbox'
$sbRoot = Join-Path $sandbox 'CardCapture'
$sbState = Join-Path $sbRoot 'state'
New-Item -ItemType Directory -Force -Path $sbInbox, $sbRoot, $sbState | Out-Null

# 합성 PII 표지. watcher.log 에 나타나면 안 된다 (전부 지어낸 문자열 — 실데이터 아님).
$deepSentinels = @('SYNTHPERSONNAME', 'SYNTHORGNAME', 'SYNTHEMAILADDR', 'SYNTHPHONENUMBER', 'SYNTHSTDERRLINE')
$quickSentinel = 'SYNTHQUICKPASSLINE'

# 합성 stub 처리기: codex 처리기처럼 stdout/stderr 로 '명함 내용'을 쏟아내고,
# 워처가 지정한 TARGET-CAPTURE-ID 캡처를 계약대로 완결한다(status=processed + person + brief.md).
$stubPs = Join-Path $sandbox 'proc-stub.ps1'
@"
`$ErrorActionPreference = 'Continue'
`$inbox = '$sbInbox'
`$prompt = ''
if (`$args.Count -gt 0) { `$prompt = [string]`$args[`$args.Count - 1] }
if (`$prompt -notmatch 'TARGET-CAPTURE-ID:\s*([A-Za-z0-9_.\-]+)') {
  Write-Output '$quickSentinel contact extracted'
  exit 0
}
`$target = `$Matches[1]
Write-Output 'SYNTHPERSONNAME / SYNTHORGNAME'
Write-Output 'SYNTHEMAILADDR SYNTHPHONENUMBER'
# stderr도 2>&1 로 처리기 로그에 합쳐져야 한다. [Console]::Error 는 PowerShell 오류 스트림을
# 거치지 않고 콘솔 핸들로 직접 나가 2>&1 이 잡지 못한다 — 실제 codex.exe(네이티브)의 stderr와
# 같은 경로를 시험하려면 오류 스트림으로 내보내야 한다.
Write-Error 'SYNTHSTDERRLINE'
`$dir = Join-Path `$inbox `$target
`$p = Join-Path `$dir 'capture.json'
`$m = Get-Content `$p -Raw -Encoding UTF8 | ConvertFrom-Json
`$m.status = 'processed'
`$m | Add-Member -NotePropertyName person -NotePropertyValue ('PER-' + `$target) -Force
`$m | Add-Member -NotePropertyName processedAt -NotePropertyValue ((Get-Date).ToString('yyyy-MM-ddTHH:mm:ssZ')) -Force
(`$m | ConvertTo-Json) | Out-File -Encoding utf8 `$p
'stub brief' | Out-File -Encoding utf8 (Join-Path `$dir 'brief.md')
exit 0
"@ | Out-File -Encoding utf8 $stubPs

# ---- 테스트 모드로 워처를 적재하고 모든 경로를 sandbox로 돌린다 ----
$CardCaptureWatcherTestMode = $true
. $watcherScript
$Inbox = $sbInbox
$Codex = $stubPs
$Vault = $sandbox
$LogFile = Join-Path $sbRoot 'watcher.log'
$HealthFile = Join-Path $sbRoot 'watcher-health.json'
$NotifyConf = Join-Path $sbRoot 'notify.conf'
$Lock = Join-Path $sbInbox 'processing.lock'
$StateDir = $sbState
$WorkerId = 'logpii-worker'

# 처리기 로그 디렉터리는 watcher.log 옆이어야 한다 (운영: %LOCALAPPDATA%\CardCapture\processor).
$procDir = Join-Path $sbRoot 'processor'

function New-Capture($id, $status, $receivedAt) {
    $d = Join-Path $sbInbox $id
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    $meta = @{ captureId = $id; status = $status; capturer = 'test'; files = @('front.jpg') }
    if ($receivedAt) { $meta.receivedAt = $receivedAt }
    ($meta | ConvertTo-Json) | Out-File -Encoding utf8 (Join-Path $d 'capture.json')
    return $d
}
function LogText { return ([string](Get-Content $LogFile -Raw -ErrorAction SilentlyContinue)) }
function ProcFiles { return @(Get-ChildItem $procDir -Filter '*.log' -File -ErrorAction SilentlyContinue) }
function ProcText {
    $t = ''
    foreach ($f in (ProcFiles)) { $t = $t + [string](Get-Content $f.FullName -Raw -ErrorAction SilentlyContinue) }
    return $t
}
function Test-NoSentinel($text, $list) {
    foreach ($s in $list) { if ($text -match [regex]::Escape($s)) { return $false } }
    return $true
}

Write-Host '=== watcher log PII separation / retention / logging-failure tests ==='

# =====================================================================
# D1-1 — 처리기 raw 출력을 watcher.log 에서 분리한다
# =====================================================================
$null = New-Capture 'L0001' 'received' '2026-07-27T01:00:00Z'
$script:ConsecutiveFailures = 0
Invoke-Processing

TB 'D1-1 watcher.log 에 처리기(deep) raw 출력이 없다' {
    return (Test-NoSentinel (LogText) $deepSentinels)
}
TB 'D1-1 watcher.log 에 quick-pass raw 출력이 없다' {
    return (Test-NoSentinel (LogText) @($quickSentinel))
}
TB 'D1-1 처리기 출력은 유실되지 않고 처리기 로그 파일에 보존된다' {
    $t = ProcText
    foreach ($s in $deepSentinels) { if ($t -notmatch [regex]::Escape($s)) { return $false } }
    return ($t -match [regex]::Escape($quickSentinel))
}
TB 'D1-1 deep 처리기 로그 파일 이름은 <captureId>-<attempt>.log 다' {
    return ((@(ProcFiles) | Where-Object { $_.Name -eq 'L0001-1.log' }).Count -eq 1)
}
TB 'D1-1 watcher.log 가 처리기 로그 파일 위치를 가리킨다 (운영자 추적 가능)' {
    return ((LogText) -match 'L0001-1\.log')
}
TB 'D1-1 watcher.log 가 quick-pass 로그 파일 위치를 가리킨다' {
    $names = @(ProcFiles | Where-Object { $_.Name -match '^quickpass-' })
    if ($names.Count -lt 1) { return $false }
    return ((LogText) -match [regex]::Escape($names[0].Name))
}
TB 'D1-1 watcher.log 에 구조화 이벤트(captureId·attempt·exit code)는 그대로 남는다' {
    $t = LogText
    return (($t -match 'processing card \(deep\) L0001 attempt=1/3') -and
            ($t -match 'exit=0') -and
            ($t -match 'card done') -and
            ($t -match 'processing loop done'))
}

# 처리기 로그를 못 쓰는 상황에서도 처리 자체는 계속돼야 한다.
# 이 lane 이전에는 처리기 출력이 watcher.log 로 갔다 — 이제 새 파일/새 디렉터리에 의존하므로
# 그 쓰기가 막히면 파이프라인이 statement-terminating 으로 끊겨 exit 이 -1 로 남고,
# '로그를 못 썼다'는 이유만으로 캡처가 실패·격리될 수 있다. 그 퇴행을 여기서 막는다.
# (2026-07-27 실측 장애가 정확히 %LOCALAPPDATA%\CardCapture 쓰기 실패였다.)
TB 'D1-1 처리기 로그를 못 써도 캡처 처리는 성공한다 (로깅이 처리를 막지 않는다)' {
    $null = New-Capture 'L0002' 'received' '2026-07-27T02:00:00Z'
    $locked = Join-Path $procDir 'L0002-1.log'
    '' | Out-File -Encoding utf8 $locked
    $h = $null
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $h = [System.IO.File]::Open($locked, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        $script:ConsecutiveFailures = 0
        Invoke-Processing
    } finally {
        if ($h) { $h.Close(); $h.Dispose() }
        $ErrorActionPreference = $prev
    }
    $m = Get-Content (Join-Path (Join-Path $sbInbox 'L0002') 'capture.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $st = Get-CaptureState 'L0002'
    $t = LogText
    return (($m.status -eq 'processed') -and ([int]$st.attempts -eq 0) -and
            ($st.quarantined -ne $true) -and ($t -match 'processor log unavailable') -and
            (Test-NoSentinel $t $deepSentinels))
}

# =====================================================================
# D1-2 — 처리기 로그 보존 기간
# =====================================================================
TB 'D1-2 보존 기간은 새 수치가 아니라 기존 임계값에서 유도된다 (MaxAttempts x LeaseMinutes)' {
    return ([int]$ProcessorLogRetentionMinutes -eq ([int]$MaxAttempts * [int]$LeaseMinutes))
}
TB 'D1-2 보존 기간이 지난 처리기 로그는 삭제되고, 아직 안 지난 것은 남는다' {
    $old = Join-Path $procDir 'OLD0001-1.log'
    $fresh = Join-Path $procDir 'NEW0001-1.log'
    'synthetic old processor output' | Out-File -Encoding utf8 $old
    'synthetic fresh processor output' | Out-File -Encoding utf8 $fresh
    (Get-Item $old).LastWriteTime = (Get-Date).AddMinutes(-1 * ([int]$ProcessorLogRetentionMinutes + 10))
    $null = Remove-ExpiredProcessorLogs
    return ((-not (Test-Path $old)) -and (Test-Path $fresh))
}
TB 'D1-2 삭제는 처리기 로그(*.log)에만 적용된다 — 다른 파일은 남는다' {
    $keep = Join-Path $procDir 'keep-me.txt'
    'synthetic note' | Out-File -Encoding utf8 $keep
    (Get-Item $keep).LastWriteTime = (Get-Date).AddMinutes(-1 * ([int]$ProcessorLogRetentionMinutes + 60))
    $null = Remove-ExpiredProcessorLogs
    return (Test-Path $keep)
}
TB 'D1-2 삭제는 watcher.log·state\ 를 절대 건드리지 않는다' {
    $logBefore = LogText
    $stateFiles = @(Get-ChildItem $sbState -Recurse -File -ErrorAction SilentlyContinue).Count
    # watcher.log 와 state 파일을 전부 보존기간보다 훨씬 오래된 것으로 만들어도 살아남아야 한다.
    (Get-Item $LogFile).LastWriteTime = (Get-Date).AddMinutes(-1 * ([int]$ProcessorLogRetentionMinutes + 600))
    foreach ($f in (Get-ChildItem $sbState -Recurse -File -ErrorAction SilentlyContinue)) {
        $f.LastWriteTime = (Get-Date).AddMinutes(-1 * ([int]$ProcessorLogRetentionMinutes + 600))
    }
    $null = Remove-ExpiredProcessorLogs
    $stateAfter = @(Get-ChildItem $sbState -Recurse -File -ErrorAction SilentlyContinue).Count
    return ((Test-Path $LogFile) -and ((LogText) -match [regex]::Escape($logBefore.Trim())) -and ($stateAfter -eq $stateFiles))
}
TB 'D1-2 삭제 사실과 근거가 watcher.log 에 남는다' {
    $stale = Join-Path $procDir 'OLD0002-1.log'
    'synthetic old processor output' | Out-File -Encoding utf8 $stale
    (Get-Item $stale).LastWriteTime = (Get-Date).AddMinutes(-1 * ([int]$ProcessorLogRetentionMinutes + 10))
    $null = Remove-ExpiredProcessorLogs
    return ((LogText) -match 'processor logs expired')
}

# =====================================================================
# D1-3 — 로깅 실패가 조용히 삼켜지지 않는다
# =====================================================================
$breadcrumb = Join-Path (Join-Path $sbState 'logging') 'log-write-failure.json'

TB 'D1-3 로그를 못 쓰는 동안 state\logging 에 흔적이 남는다 (watcher.log 자체가 막혀도 관측 가능)' {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $h = $null
    try {
        # watcher.log 를 배타적으로 잠가 쓰기를 실패시킨다 (합성 장애).
        $h = [System.IO.File]::Open($LogFile, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        Write-Log 'synthetic lost line 1'
        Write-Log 'synthetic lost line 2'
        Write-Log 'synthetic lost line 3'
    } finally {
        if ($h) { $h.Close(); $h.Dispose() }
        $ErrorActionPreference = $prev
    }
    if (-not (Test-Path $breadcrumb)) { return $false }
    $o = Get-Content $breadcrumb -Raw -Encoding UTF8 | ConvertFrom-Json
    return ([int]$o.pendingDroppedLines -eq 3)
}
TB 'D1-3 다음 성공한 쓰기에서 그동안 몇 줄을 잃었는지 알 수 있다' {
    Write-Log 'synthetic line after recovery'
    $t = LogText
    return (($t -match 'LOG WRITE RECOVERED') -and ($t -match '3'))
}
TB 'D1-3 복구 후 흔적이 갱신된다 (pending 0, 누적은 보존)' {
    $o = Get-Content $breadcrumb -Raw -Encoding UTF8 | ConvertFrom-Json
    return (([int]$o.pendingDroppedLines -eq 0) -and ([int]$o.droppedTotal -ge 3) -and ([string]$o.recoveredAt -ne ''))
}
TB 'D1-3 health 파일이 로그 유실 건수를 노출한다' {
    Write-Health
    $h = Get-Content $HealthFile -Raw -Encoding UTF8 | ConvertFrom-Json
    return (([int]$h.logDroppedTotal -ge 3) -and ($null -ne $h.PSObject.Properties['logDroppedPending']))
}

# ---- health 진단 표면 (자식 프로세스로 실행 — 실제 root 는 건드리지 않는다) ----
function Invoke-Health($extra) {
    $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $healthScript, '-Root', $sbRoot)
    if ($extra) { $argv += $extra }
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $out = ''
    try { $out = & powershell.exe @argv 2>&1 | Out-String } finally { $ErrorActionPreference = $prev }
    return $out
}

TB 'D1-3 health 진단이 로그 쓰기 실패를 보고한다' {
    $out = Invoke-Health @('-Json')
    $j = $null
    try { $j = $out | ConvertFrom-Json } catch { $j = $null }
    if ($null -eq $j) { return $false }
    return ((@($j.reasons) -contains 'log_write_failed_earlier') -and
            ([int]$j.observed.logWriteFailure.droppedTotal -ge 3))
}
TB 'D1-3 밀린 유실이 있으면 health 가 critical 로 올라간다' {
    $o = Get-Content $breadcrumb -Raw -Encoding UTF8 | ConvertFrom-Json
    $o.pendingDroppedLines = 7
    ($o | ConvertTo-Json) | Out-File -Encoding utf8 $breadcrumb
    $out = Invoke-Health @('-Json')
    $j = $null
    try { $j = $out | ConvertFrom-Json } catch { $j = $null }
    if ($null -eq $j) { return $false }
    $o.pendingDroppedLines = 0
    ($o | ConvertTo-Json) | Out-File -Encoding utf8 $breadcrumb
    return ((@($j.reasons) -contains 'log_write_failing') -and ($j.status -eq 'critical'))
}

# =====================================================================
# 진단 표면 회귀 — 새 워처 줄이 '처리기 출력'으로 묻히면 안 된다
# =====================================================================
TB '진단: 새 워처 이벤트 줄이 전부 allowlist 라벨로 환원된다 (묻히는 줄 0)' {
    $fixture = Join-Path $sandbox 'evt'
    New-Item -ItemType Directory -Force -Path $fixture | Out-Null
    $lines = @(
        '2026-07-27 10:00:00 === watcher started (watcher-v3.0, codex engine) PID=4242 ===',
        '2026-07-27 10:01:00 processor start CAP0001 attempt=1 phase=deep log=CAP0001-1.log',
        '2026-07-27 10:02:00 processor end CAP0001 attempt=1 phase=deep exit=0 log=CAP0001-1.log',
        '2026-07-27 10:03:00 processor logs expired — 2개 삭제 (보존 90분)',
        '2026-07-27 10:04:00 LOG WRITE RECOVERED — 로그 쓰기 실패로 3줄을 잃었다',
        '2026-07-27 10:05:00 heartbeat (PID=4242, loop alive)'
    )
    $lines -join "`r`n" | Out-File -Encoding utf8 (Join-Path $fixture 'watcher.log')
    ([PSCustomObject]@{ version = 'watcher-v3.0'; pid = $PID
        startedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
        lastHeartbeat = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'); backlogCount = 0 } | ConvertTo-Json) |
        Out-File -Encoding utf8 (Join-Path $fixture 'watcher-health.json')
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $out = ''
    try {
        $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $healthScript -Root $fixture -Json 2>&1 | Out-String
    } finally { $ErrorActionPreference = $prev }
    $j = $null
    try { $j = $out | ConvertFrom-Json } catch { $j = $null }
    if ($null -eq $j) { return $false }
    return (([int]$j.log.suppressedLines -eq 0) -and
            ($null -ne $j.log.eventCounts.processor_run) -and
            ($null -ne $j.log.eventCounts.log_write_recovered))
}
TB '진단: 처리기 로그 파일 내용은 어떤 출력에도 나오지 않는다' {
    $outJ = Invoke-Health @('-Json')
    $outH = Invoke-Health @()
    return ((Test-NoSentinel $outJ ($deepSentinels + @($quickSentinel))) -and
            (Test-NoSentinel $outH ($deepSentinels + @($quickSentinel))))
}
TB '진단: 처리기 로그 보관 건수를 운영자에게 알려준다' {
    $out = Invoke-Health @('-Json')
    $j = $null
    try { $j = $out | ConvertFrom-Json } catch { $j = $null }
    if ($null -eq $j) { return $false }
    return ([int]$j.observed.processorLogs.count -ge 1)
}

# ---- summary + cleanup ----
Write-Host ''
Write-Host ("summary: pass=" + $pass + " fail=" + $fail)
# Invoke-Processing 이 Set-Location $Vault(=sandbox) 를 하므로 현재 위치를 먼저 빼야 지워진다.
Set-Location $env:TEMP
Remove-Item $sandbox -Recurse -Force -ErrorAction SilentlyContinue
if ($fail -gt 0) { Write-Host 'RESULT: FAIL'; exit 1 } else { Write-Host 'RESULT: PASS'; exit 0 }
