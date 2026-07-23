# validate.ps1 - repo repeatable validation for guecom/card-capture
# Kairen-Ref: TSK-000140 (release baseline), TSK-000141 (secret hygiene), TSK-000143 (eval fixtures)
# PowerShell 5.1 compatible. Run from repo root or scripts/. Exit 0 = PASS, 1 = FAIL.
# NOTE: keep this file saved as UTF-8 with BOM (repo AGENTS.md rule for .ps1).

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $root 'Code.gs'))) { $root = $PSScriptRoot }
Set-Location $root

$failures = New-Object System.Collections.ArrayList
$warnings = New-Object System.Collections.ArrayList
function Fail($m) { [void]$failures.Add($m); Write-Host "FAIL  $m" }
function Warn($m) { [void]$warnings.Add($m); Write-Host "WARN  $m" }
function Pass($m) { Write-Host "PASS  $m" }

# ---------- 1. required files ----------
$required = @(
  'AGENTS.md','SECURITY.md','CHANGELOG.md','RELEASE.md','README.md','Code.gs',
  'docs/index.html','docs/sw.js','docs/manifest.json',
  'watcher/CardCapture_Watcher.ps1','watcher/CardCapture_Health.ps1',
  'eval/README.md','eval/run-eval.ps1','scripts/validate.ps1'
)
$missing = @($required | Where-Object { -not (Test-Path (Join-Path $root $_)) })
if ($missing.Count -gt 0) { Fail ("required files missing: " + ($missing -join ', ')) } else { Pass 'required files present' }

# ---------- 2. secret scan ----------
$textExt = @('.md','.gs','.js','.json','.html','.ps1','.yml','.yaml','.txt','.cmd','.bat')
$scanFiles = Get-ChildItem $root -Recurse -File | Where-Object {
  $_.FullName -notmatch '\\\.git\\' -and
  $_.FullName -notmatch '\\docs\\vendor\\' -and
  $_.FullName -notmatch '\\eval\\\.work\\' -and
  $textExt -contains $_.Extension.ToLower()
}
$secretHits = New-Object System.Collections.ArrayList
foreach ($f in $scanFiles) {
  $rel = $f.FullName.Substring($root.Length + 1)
  $lineNo = 0
  foreach ($line in [System.IO.File]::ReadAllLines($f.FullName)) {
    $lineNo++
    # GAS deployment id: allowed only in docs/index.html (DEFAULT_API is a sanctioned public value)
    if ($line -match 'AKfycb[A-Za-z0-9_-]{10,}' -and $rel -ne 'docs\index.html') {
      [void]$secretHits.Add("$rel(:$lineNo) GAS exec id outside docs/index.html")
    }
    # TOKENS-style mapping with literal long key
    if ($line -match '"[A-Za-z0-9_-]{32,}"\s*:\s*"') {
      [void]$secretHits.Add("$rel(:$lineNo) token-like JSON mapping literal")
    }
    # INBOX_FOLDER_ID with literal value
    if ($line -match 'INBOX_FOLDER_ID\s*[:=]\s*[''"][A-Za-z0-9_-]{16,}') {
      [void]$secretHits.Add("$rel(:$lineNo) Drive folder id literal")
    }
    # generic long mixed random string (skip hex hashes, data URIs, known safe markers)
    if ($line -notmatch 'sha256|dataB64|AKfycb|integrity|opencv' ) {
      foreach ($m in [regex]::Matches($line, '[A-Za-z0-9_-]{44,}')) {
        $v = $m.Value
        $isHex = $v -match '^[0-9a-fA-F]+$'
        $hasUpper = $v -cmatch '[A-Z]'; $hasLower = $v -cmatch '[a-z]'; $hasDigit = $v -match '[0-9]'
        if (-not $isHex -and $hasUpper -and $hasLower -and $hasDigit) {
          [void]$secretHits.Add("$rel(:$lineNo) long random-looking string (check if secret)")
        }
      }
    }
  }
}
if ($secretHits.Count -gt 0) { $secretHits | Select-Object -First 20 | ForEach-Object { Fail "secret-scan: $_" } } else { Pass 'secret scan clean' }

# ---------- 3. .ps1 BOM check ----------
$ps1NoBom = New-Object System.Collections.ArrayList
foreach ($f in ($scanFiles | Where-Object { $_.Extension -eq '.ps1' })) {
  $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
  if ($bytes.Length -lt 3 -or $bytes[0] -ne 0xEF -or $bytes[1] -ne 0xBB -or $bytes[2] -ne 0xBF) {
    [void]$ps1NoBom.Add($f.FullName.Substring($root.Length + 1))
  }
}
if ($ps1NoBom.Count -gt 0) { Fail (".ps1 without UTF-8 BOM (Korean-path hazard): " + ($ps1NoBom -join ', ')) } else { Pass 'all .ps1 have UTF-8 BOM' }

# ---------- 4. Code.gs route inventory documented ----------
$gs = Get-Content (Join-Path $root 'Code.gs') -Raw
$routes = @([regex]::Matches($gs, "action\s*===\s*'([a-zA-Z_]+)'") | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
$docText = (Get-Content (Join-Path $root 'RELEASE.md') -Raw) + (Get-Content (Join-Path $root 'CHANGELOG.md') -Raw) + (Get-Content (Join-Path $root 'SECURITY.md') -Raw)
$undocumented = @($routes | Where-Object { $docText -notmatch $_ })
if ($undocumented.Count -gt 0) { Warn ("Code.gs routes not mentioned in docs: " + ($undocumented -join ', ')) } else { Pass ("Code.gs routes documented (" + ($routes -join ', ') + ")") }

# ---------- 5. eval fixtures ----------
$fixDir = Join-Path $root 'eval\fixtures'
if (Test-Path $fixDir) {
  $bad = New-Object System.Collections.ArrayList
  $fixtures = @(Get-ChildItem $fixDir -Filter '*.json')
  foreach ($fx in $fixtures) {
    try {
      $j = Get-Content $fx.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
      if (-not $j.id) { [void]$bad.Add("$($fx.Name): missing id") }
      if (-not $j.expected) { [void]$bad.Add("$($fx.Name): missing expected") }
      if ($j.adversarial -and -not $j.must_not) { [void]$bad.Add("$($fx.Name): adversarial without must_not") }
      if ($j.synthetic -ne $true) { [void]$bad.Add("$($fx.Name): synthetic flag must be true (real-card fixtures need human anonymization approval)") }
    } catch { [void]$bad.Add("$($fx.Name): invalid JSON - $($_.Exception.Message)") }
  }
  if ($fixtures.Count -eq 0) { Warn 'eval/fixtures empty' }
  if ($bad.Count -gt 0) { $bad | ForEach-Object { Fail "fixture: $_" } } else { Pass ("eval fixtures valid (" + $fixtures.Count + ")") }
} else { Warn 'eval/fixtures directory missing' }

# ---------- 6. PWA sanity ----------
$idx = Get-Content (Join-Path $root 'docs\index.html') -Raw
if ($idx -notmatch "DEFAULT_API\s*=\s*'https://script\.google\.com/") { Fail 'docs/index.html DEFAULT_API missing or malformed' } else { Pass 'DEFAULT_API present' }
if ((Get-Content (Join-Path $root 'CHANGELOG.md') -Raw) -notmatch '\[Unreleased\]') { Warn 'CHANGELOG has no [Unreleased] section' } else { Pass 'CHANGELOG has [Unreleased]' }

# ---------- summary ----------
Write-Host ''
Write-Host ("summary: fail=" + $failures.Count + " warn=" + $warnings.Count)
if ($failures.Count -gt 0) { Write-Host 'RESULT: FAIL'; exit 1 } else { Write-Host 'RESULT: PASS'; exit 0 }
