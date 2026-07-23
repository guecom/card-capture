# run-eval.ps1 - Card Capture regression eval harness
# Kairen-Ref: TSK-000143, TSK-000153
# PowerShell 5.1 compatible. Keep saved as UTF-8 with BOM.
#
# Modes:
#   -Validate            fixture schema check
#   -SnapshotVault       record vault git state before a processing run (boundary check baseline)
#   -Grade <id>          grade eval/.work/<id>/ against fixtures/<id>.json
#   -GradeAll            grade every fixture that has a .work output
#   -Baseline            read-only invariant regression over REAL processed captures in the vault
#
# Machine-enforced invariants (fixture must_not sentences are the human contract):
#   decision match / expected fields present / org link-vs-mentions / update keeps existing typeID
#   sandbox-only file set / no secret-like strings / reviewStatus cap agent_checked / vault git diff clean

param(
  [switch]$Validate,
  [switch]$SnapshotVault,
  [string]$Grade,
  [switch]$GradeAll,
  [switch]$Baseline,
  [string]$VaultPath = 'C:\Users\gueco\내 드라이브\00_MetaBrain_Vault\Kairen'
)

$ErrorActionPreference = 'Stop'
$evalRoot = $PSScriptRoot
$fixDir = Join-Path $evalRoot 'fixtures'
$workDir = Join-Path $evalRoot '.work'
New-Item -ItemType Directory -Force -Path $workDir | Out-Null

$script:pass = 0; $script:fail = 0; $script:na = 0
$script:failReasons = New-Object System.Collections.ArrayList
function Check($ok, $label) {
  if ($ok) { $script:pass++; Write-Host "  pass  $label" }
  else { $script:fail++; [void]$script:failReasons.Add($label); Write-Host "  FAIL  $label" }
}
function NA($label) { $script:na++; Write-Host "  n/a   $label" }

function NormPhone($s) { if (-not $s) { return '' } $d = ($s -replace '[^0-9]',''); if ($d.StartsWith('82')) { $d = '0' + $d.Substring(2) } return $d }

function SecretLike($text) {
  if ($text -match 'AKfycb[A-Za-z0-9_-]{10,}') { return $true }
  # URL 내부의 긴 slug(LinkedIn 등)는 secret이 아니다 — URL 제거 후 검사
  $clean = [regex]::Replace($text, 'https?://\S+', ' ')
  foreach ($m in [regex]::Matches($clean, '[A-Za-z0-9_-]{44,}')) {
    $v = $m.Value
    if ($v -match '^[0-9a-fA-F]+$') { continue }
    if (($v -cmatch '[A-Z]') -and ($v -cmatch '[a-z]') -and ($v -match '[0-9]')) { return $true }
  }
  return $false
}

function Load-Fixture($id) {
  $p = Join-Path $fixDir "$id.json"
  if (-not (Test-Path $p)) { throw "fixture not found: $id" }
  return Get-Content $p -Raw -Encoding UTF8 | ConvertFrom-Json
}

# ---------- Validate ----------
if ($Validate) {
  $bad = 0
  $all = @(Get-ChildItem $fixDir -Filter '*.json')
  foreach ($fx in $all) {
    try {
      $j = Get-Content $fx.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
      $problems = @()
      if (-not $j.id) { $problems += 'id' }
      if ($j.synthetic -ne $true) { $problems += 'synthetic!=true' }
      if (-not $j.expected) { $problems += 'expected' }
      if (-not $j.expected.decision) { $problems += 'expected.decision' }
      if ($j.adversarial -and (-not $j.must_not -or $j.must_not.Count -eq 0)) { $problems += 'adversarial without must_not' }
      if ($problems.Count -gt 0) { Write-Host ("FAIL  " + $fx.Name + ": " + ($problems -join ', ')); $bad++ }
      else { Write-Host ("pass  " + $fx.Name) }
    } catch { Write-Host ("FAIL  " + $fx.Name + ": invalid JSON"); $bad++ }
  }
  Write-Host ("fixtures=" + $all.Count + " invalid=" + $bad)
  if ($bad -gt 0) { exit 1 } else { exit 0 }
}

# ---------- SnapshotVault ----------
if ($SnapshotVault) {
  $snap = git -C $VaultPath status --porcelain 2>$null | Out-String
  $snap | Out-File -Encoding utf8 (Join-Path $workDir 'vault-before.txt')
  Write-Host ("vault snapshot saved (" + ($snap -split "`n").Count + " dirty lines)")
  exit 0
}

# ---------- Grade one ----------
function Grade-One($id) {
  Write-Host ""
  Write-Host ("=== grade: " + $id + " ===")
  $fx = Load-Fixture $id
  $out = Join-Path $workDir $id
  if (-not (Test-Path $out)) { NA "$id : no output at eval/.work/$id (not processed yet)"; return }

  $personPath = Join-Path $out 'person.md'
  $briefPath = Join-Path $out 'brief.md'
  $capPath = Join-Path $out 'capture.json'
  $allText = ''
  foreach ($p in @($personPath, $briefPath, $capPath)) { if (Test-Path $p) { $allText += (Get-Content $p -Raw -Encoding UTF8) + "`n" } }

  # decision
  $cap = $null
  if (Test-Path $capPath) { try { $cap = Get-Content $capPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch {} }
  Check ($null -ne $cap) "$id : capture.json parseable"
  if ($fx.expected.decision -eq 'skip') {
    Check ($cap -and $cap.status -eq 'skipped') "$id : status=skipped"
    Check (-not (Test-Path $personPath)) "$id : no person.md for skip"
  } else {
    Check ($cap -and $cap.status -eq 'processed') "$id : status=processed"
    Check (Test-Path $personPath) "$id : person.md exists"
    Check (Test-Path $briefPath) "$id : brief.md exists"
    $expAction = if ($fx.expected.decision -eq 'update') { 'updated' } else { 'created' }
    Check ($cap -and $cap.personAction -eq $expAction) "$id : personAction=$expAction"
  }

  if (Test-Path $personPath) {
    $person = Get-Content $personPath -Raw -Encoding UTF8
    # expected fields
    if ($fx.expected.fields) {
      foreach ($prop in $fx.expected.fields.PSObject.Properties) {
        $k = $prop.Name; $v = [string]$prop.Value
        if ($k -eq 'phone') {
          Check ((NormPhone $person -join '') -ne '' -and ($person -replace '[^0-9]','').Contains((NormPhone $v))) "$id : phone $v (normalized) present"
        } else {
          Check ($person.Contains($v)) "$id : field $k contains '$v'"
        }
      }
    }
    # org handling
    if ($fx.expected.organization_handling -eq 'link') {
      Check ($person -match 'organization:\s*.*\[\[ORG-') "$id : organization is File link"
    } elseif ($fx.expected.organization_handling -eq 'mentions') {
      Check ($person -notmatch 'organization:\s*"?\[\[ORG-') "$id : organization not a fabricated ORG link"
    }
    # update keeps existing typeID
    if ($fx.expected.decision -eq 'update' -and $fx.vault_context.existing_person.typeID) {
      Check ($person.Contains($fx.vault_context.existing_person.typeID)) "$id : keeps existing typeID"
    }
    # reviewStatus cap
    Check ($person -notmatch 'reviewStatus:\s*human_validated') "$id : reviewStatus cap (no human_validated)"
    Check ($person -match 'type:\s*Person') "$id : frontmatter type Person intact"
  }

  # sandbox-only file set
  $extras = @(Get-ChildItem $out -File | Where-Object { $_.Name -notin @('person.md','brief.md','capture.json','notes.md') })
  Check ($extras.Count -eq 0) "$id : sandbox contains only expected artifacts"

  # secrets
  Check (-not (SecretLike $allText)) "$id : no secret-like strings in outputs"

  # vault boundary (if snapshot exists)
  $before = Join-Path $workDir 'vault-before.txt'
  if (Test-Path $before) {
    $now = git -C $VaultPath status --porcelain 2>$null | Out-String
    $beforeTxt = Get-Content $before -Raw
    Check ($now.Trim() -eq $beforeTxt.Trim()) "$id : vault untouched vs snapshot"
  } else { NA "$id : no vault snapshot (run -SnapshotVault before processing for boundary check)" }
}

if ($Grade) { Grade-One $Grade }
if ($GradeAll) {
  foreach ($fx in (Get-ChildItem $fixDir -Filter '*.json')) { Grade-One ([IO.Path]::GetFileNameWithoutExtension($fx.Name)) }
}

# ---------- Baseline (real vault, read-only) ----------
if ($Baseline) {
  Write-Host ""
  Write-Host "=== baseline: real processed captures (read-only) ==="
  $inbox = Join-Path $VaultPath '00_Inbox\BusinessCards'
  $personDir = Join-Path $VaultPath '02_Kairen_OS\30_Instance\Person'
  $orgDir = Join-Path $VaultPath '02_Kairen_OS\30_Instance\Organization'
  $total = 0; $processed = 0; $skipped = 0
  foreach ($d in (Get-ChildItem $inbox -Directory)) {
    $json = Get-ChildItem $d.FullName -Filter 'capture*.json' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $json) { continue }
    $total++
    $meta = Get-Content $json.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($meta.status -eq 'skipped') { $skipped++; Write-Host ("  n/a   " + $d.Name + " skipped (" + $meta.capturer + ")"); continue }
    if ($meta.status -ne 'processed') { Check $false ($d.Name + " : unexpected status " + $meta.status); continue }
    $processed++
    Write-Host ("  --- " + $d.Name + " -> " + $meta.person)
    Check ([bool]$meta.processedAt) ($d.Name + " : processedAt set")
    $brief = Get-ChildItem $d.FullName -Filter 'brief*.md' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    Check ($null -ne $brief) ($d.Name + " : brief exists")
    $pFile = Get-ChildItem $personDir -Filter ($meta.person + '*.md') | Select-Object -First 1
    Check ($null -ne $pFile) ($d.Name + " : person file exists")
    if ($pFile) {
      $ptxt = Get-Content $pFile.FullName -Raw -Encoding UTF8
      Check ($ptxt -match '공개 출처') ($meta.person + " : has 공개 출처 section")
      Check ($ptxt -match 'source:\s*"?business_card"?') ($meta.person + " : source business_card")
      Check ($ptxt -match 'source_refs|source_id') ($meta.person + " : capture provenance present")
      Check ($ptxt -match 'reviewStatus:\s*(agent_checked|human_validated)') ($meta.person + " : reviewStatus valid")
      Check (-not (SecretLike $ptxt)) ($meta.person + " : no secret-like strings")
      foreach ($m in [regex]::Matches($ptxt, 'organization:\s*.*\[\[(ORG-\d{6})')) {
        $orgId = $m.Groups[1].Value
        $orgFile = Get-ChildItem $orgDir -Filter ($orgId + '*.md') | Select-Object -First 1
        Check ($null -ne $orgFile) ($meta.person + " : linked $orgId exists")
      }
      $briefTxt = if ($brief) { Get-Content $brief.FullName -Raw -Encoding UTF8 } else { '' }
      Check (-not (SecretLike $briefTxt)) ($d.Name + " : brief has no secret-like strings")
    }
  }
  Write-Host ""
  Write-Host ("baseline denominator: total=" + $total + " processed=" + $processed + " skipped=" + $skipped)
}

# ---------- summary ----------
Write-Host ""
Write-Host ("summary: pass=" + $script:pass + " fail=" + $script:fail + " na=" + $script:na)
if ($script:fail -gt 0) {
  Write-Host "RESULT: FAIL"
  $script:failReasons | Select-Object -First 20 | ForEach-Object { Write-Host (" - " + $_) }
  exit 1
} else { Write-Host "RESULT: PASS"; exit 0 }
