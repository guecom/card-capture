# CardCapture_Health.ps1 — 워처·처리 상태 한눈에 보기
# Kairen-Ref: TSK-000142
# 사용: powershell -NoProfile -ExecutionPolicy Bypass -File watcher\CardCapture_Health.ps1
# 종료코드: 0=정상, 1=경고(워처 없음/백로그 대기), 2=위험(하트비트 정지·연속 실패·오래된 백로그)
# 주의: UTF-8 BOM 유지 (한글 경로).

$LogDir = Join-Path $env:LOCALAPPDATA 'CardCapture'
$HealthFile = Join-Path $LogDir 'watcher-health.json'
$LogFile = Join-Path $LogDir 'watcher.log'
$exit = 0
function Sev($level) { if ($level -gt $script:exit) { $script:exit = $level } }

Write-Host '=== Card Capture Health ==='

if (-not (Test-Path $HealthFile)) {
    Write-Host 'health file: MISSING (watcher v2 not started yet?)'
    Sev 1
} else {
    $h = Get-Content $HealthFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $beatAge = ((Get-Date) - [datetime]$h.lastHeartbeat).TotalMinutes
    Write-Host ("version           : " + $h.version)
    Write-Host ("pid               : " + $h.pid)
    Write-Host ("startedAt         : " + $h.startedAt)
    Write-Host ("lastHeartbeat     : " + $h.lastHeartbeat + ("  ({0:N1} min ago)" -f $beatAge))
    Write-Host ("lastRun           : " + $h.lastRunStart + " -> " + $h.lastRunEnd + " (exit=" + $h.lastExitCode + ")")
    Write-Host ("consecutiveFailures: " + $h.consecutiveFailures)
    Write-Host ("backlog           : " + $h.backlogCount + " (oldest " + $h.backlogOldestAgeMin + " min)")
    Write-Host ("lock              : " + $h.lockExists)

    $proc = Get-Process -Id $h.pid -ErrorAction SilentlyContinue
    if ($null -eq $proc) { Write-Host 'process           : NOT RUNNING'; Sev 2 } else { Write-Host ('process           : alive (' + $proc.ProcessName + ')') }
    if ($beatAge -gt 15) { Write-Host 'ALERT: heartbeat older than 15 min'; Sev 2 }
    if ($h.consecutiveFailures -ge 3) { Write-Host 'ALERT: 3+ consecutive processing failures'; Sev 2 }
    if ($h.backlogCount -gt 0 -and $h.backlogOldestAgeMin -gt 30) { Write-Host 'ALERT: backlog waiting over 30 min'; Sev 2 }
    elseif ($h.backlogCount -gt 0) { Write-Host 'note: backlog pending'; Sev 1 }
}

if (Test-Path $LogFile) {
    Write-Host ''
    Write-Host '--- watcher.log tail ---'
    Get-Content $LogFile -Tail 6
} else {
    Write-Host 'log: MISSING'
    Sev 1
}

Write-Host ''
Write-Host ("health exit code: " + $exit + "  (0 ok / 1 warn / 2 critical)")
exit $exit
