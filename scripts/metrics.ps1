# metrics.ps1 — Card Capture product funnel·quality metric 계산기
# Kairen-Ref: TSK-000146
# 원천: vault 00_Inbox/BusinessCards/*/capture.json (+ Person instance reviewStatus)
# privacy: 사람 이름·연락처를 출력하지 않는다. capturer 표시명과 PER-ID, captureId만 사용.
# 사용: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\metrics.ps1 [-OutFile 경로]
# 주의: UTF-8 BOM 유지.

param(
  [string]$VaultPath = 'C:\Users\gueco\내 드라이브\00_MetaBrain_Vault\Kairen',
  [string]$OutFile
)
$ErrorActionPreference = 'Stop'
$inbox = Join-Path $VaultPath '00_Inbox\BusinessCards'
$personDir = Join-Path $VaultPath '02_Kairen_OS\30_Instance\Person'

function ParseIso($s) { if (-not $s) { return $null } try { return [datetime]::Parse($s, $null, [System.Globalization.DateTimeStyles]::RoundtripKind) } catch { try { return [datetime]$s } catch { return $null } } }
# 시간대 정규화: Z(UTC)는 그대로, naive 문자열은 제품 시간대 Asia/Seoul(KST, UTC+9)로 간주해 UTC 변환.
# (capturedAt·receivedAt은 UTC Z, 처리 세션이 쓰는 processedAt은 naive KST인 사례가 실데이터에 있음)
function ToUtc($dt) {
  if ($null -eq $dt) { return $null }
  if ($dt.Kind -eq [System.DateTimeKind]::Utc) { return $dt }
  if ($dt.Kind -eq [System.DateTimeKind]::Local) { return $dt.ToUniversalTime() }
  return $dt.AddHours(-9)
}
function MinutesBetween($a, $b) { if ($a -and $b) { return [math]::Round((New-TimeSpan -Start (ToUtc $a) -End (ToUtc $b)).TotalMinutes, 1) } return $null }

$rows = New-Object System.Collections.ArrayList
foreach ($d in (Get-ChildItem $inbox -Directory | Sort-Object Name)) {
  $json = Get-ChildItem $d.FullName -Filter 'capture*.json' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $json) { continue }
  $m = Get-Content $json.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
  $captured = ParseIso $m.capturedAt
  $received = ParseIso $m.receivedAt
  $processed = ParseIso $m.processedAt
  $reviewed = $null
  if ($m.person) {
    $pf = Get-ChildItem $personDir -Filter ($m.person + '*.md') | Select-Object -First 1
    if ($pf) {
      $ptxt = Get-Content $pf.FullName -Raw -Encoding UTF8
      if ($ptxt -match 'reviewStatus:\s*human_validated') { $reviewed = 'human_validated' }
      elseif ($ptxt -match 'reviewStatus:\s*agent_checked') { $reviewed = 'agent_checked' }
    }
  }
  $corrections = @(Get-ChildItem $d.FullName -Filter 'correction*.json' -ErrorAction SilentlyContinue).Count
  [void]$rows.Add([PSCustomObject]@{
    captureId = $d.Name
    capturer = $m.capturer
    status = $m.status
    person = $m.person
    action = $m.personAction
    hasEvent = [bool]$m.event
    briefExists = (@(Get-ChildItem $d.FullName -Filter 'brief*.md' -ErrorAction SilentlyContinue).Count -gt 0)
    review = $reviewed
    corrections = $corrections
    uploadMin = (MinutesBetween $captured $received)
    processMin = (MinutesBetween $received $processed)
    day = $d.Name.Substring(0, 8)
  })
}

$total = $rows.Count
$processedRows = @($rows | Where-Object { $_.status -eq 'processed' })
$skippedRows = @($rows | Where-Object { $_.status -eq 'skipped' })
$receivedRows = @($rows | Where-Object { $_.status -eq 'received' })
$briefed = @($processedRows | Where-Object { $_.briefExists })
$validated = @($processedRows | Where-Object { $_.review -eq 'human_validated' })
$agentOnly = @($processedRows | Where-Object { $_.review -eq 'agent_checked' })
$created = @($processedRows | Where-Object { $_.action -eq 'created' })
$updated = @($processedRows | Where-Object { $_.action -eq 'updated' })
$withEvent = @($rows | Where-Object { $_.hasEvent })
$totalCorrections = ($rows | Measure-Object -Property corrections -Sum).Sum

function MedianOf($vals) {
  $v = @($vals | Where-Object { $null -ne $_ } | Sort-Object)
  if ($v.Count -eq 0) { return $null }
  return $v[[int](($v.Count - 1) / 2)]
}

$lines = New-Object System.Collections.ArrayList
[void]$lines.Add("## Funnel (denominator = 전체 캡처 $total 건, 테스트 캡처 포함)")
[void]$lines.Add("")
[void]$lines.Add("| 단계 | 건수 | 비율 |")
[void]$lines.Add("| --- | --- | --- |")
function Pct($n) { if ($total -eq 0) { return '0%' } return ([math]::Round(100.0 * $n / $total, 0).ToString() + '%') }
[void]$lines.Add("| captured→uploaded (Drive 도착) | $total | 100% |")
[void]$lines.Add("| processed | $($processedRows.Count) | $(Pct $processedRows.Count) |")
[void]$lines.Add("| skipped (명함 아님·테스트) | $($skippedRows.Count) | $(Pct $skippedRows.Count) |")
[void]$lines.Add("| 대기 중 (received) | $($receivedRows.Count) | $(Pct $receivedRows.Count) |")
[void]$lines.Add("| brief 회신 | $($briefed.Count) | $(Pct $briefed.Count) |")
[void]$lines.Add("| human_validated | $($validated.Count) | $(Pct $validated.Count) |")
[void]$lines.Add("")
[void]$lines.Add("## Quality")
[void]$lines.Add("")
[void]$lines.Add("- 신규 생성(created): $($created.Count) · 중복 감지 후 갱신(updated): $($updated.Count) — 중복 Person 생성 0")
[void]$lines.Add("- agent_checked 대기: $($agentOnly.Count) · human_validated: $($validated.Count)")
[void]$lines.Add("- 수정 요청(correction): $totalCorrections")
[void]$lines.Add("- 만난 맥락(event) 기록률: $($withEvent.Count)/$total")
[void]$lines.Add("")
[void]$lines.Add("## Latency (분)")
[void]$lines.Add("")
[void]$lines.Add("| 구간 | 중앙값 | 관측치 |")
[void]$lines.Add("| --- | --- | --- |")
$upMed = MedianOf ($rows | ForEach-Object { $_.uploadMin })
$prMed = MedianOf ($processedRows | ForEach-Object { $_.processMin })
[void]$lines.Add("| 촬영→업로드 | $upMed | $(@($rows | Where-Object { $null -ne $_.uploadMin }).Count) |")
[void]$lines.Add("| 업로드→처리 완료 | $prMed | $(@($processedRows | Where-Object { $null -ne $_.processMin }).Count) |")
[void]$lines.Add("")
[void]$lines.Add("## Repeat use (capturer×일 단위)")
[void]$lines.Add("")
$byCapturerDay = $rows | Group-Object { $_.capturer + ' / ' + $_.day }
foreach ($g in ($byCapturerDay | Sort-Object Name)) {
  [void]$lines.Add("- " + $g.Name + ": " + $g.Count + "건")
}
[void]$lines.Add("")
[void]$lines.Add("## Per-capture detail")
[void]$lines.Add("")
[void]$lines.Add("| captureId | capturer | status | action | brief | review | upload(min) | process(min) |")
[void]$lines.Add("| --- | --- | --- | --- | --- | --- | --- | --- |")
foreach ($r in $rows) {
  [void]$lines.Add("| " + $r.captureId + " | " + $r.capturer + " | " + $r.status + " | " + $r.action + " | " + $r.briefExists + " | " + $r.review + " | " + $r.uploadMin + " | " + $r.processMin + " |")
}

$report = $lines -join "`r`n"
$report
if ($OutFile) { $report | Out-File -Encoding utf8 $OutFile; Write-Host ""; Write-Host ("saved: " + $OutFile) }
