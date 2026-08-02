# validate.ps1 - repo repeatable validation for guecom/card-capture
# Kairen-Ref: TSK-000140 (release baseline), TSK-000141 (secret hygiene), TSK-000143 (eval fixtures), TSK-000221 (Node frontend)
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
  'config/public-runtime.json','docs/index.html','docs/sw.js','docs/manifest.json','docs/camera-quality.js',
  'docs/vendor/tesseract/tesseract.min.js','docs/vendor/tesseract/worker.min.js',
  'docs/vendor/tesseract/tesseract-core-simd-lstm.wasm.js',
  'docs/vendor/tesseract/kor.traineddata.gz','docs/vendor/tesseract/eng.traineddata.gz','docs/vendor/tesseract/README.md',
  'docs/vendor/paddleocr/PP-OCRv5_mobile_det_infer.onnx','docs/vendor/paddleocr/korean_PP-OCRv5_mobile_rec_infer.onnx',
  'docs/vendor/paddleocr/ppocrv5_korean_dict.txt','docs/vendor/ort/ort-wasm-simd-threaded.wasm','docs/vendor/ort/ort-wasm-simd-threaded.mjs',
  'docs/vendor/cardquad/lcnet100_h_e_bifpn_256_fp32.onnx','docs/vendor/cardquad/LICENSE','docs/vendor/cardquad/README.md',
  'watcher/CardCapture_Watcher.ps1','watcher/CardCapture_Health.ps1','watcher/tests/watcher-tests.ps1','watcher/tests/watcher-protocol-tests.ps1','watcher/tests/health-tests.ps1','watcher/tests/log-pii-tests.ps1',
  'eval/README.md','eval/run-eval.ps1','eval/upload-idempotency.test.js','eval/upload-filename-allowlist.test.js','eval/upload-content-type.test.js','eval/public-runtime-credential.test.js','eval/build-reproducibility.test.js','eval/version-sync.test.js','eval/persondoc-owner.test.js','eval/prompt-injection.test.js','eval/gas-sandbox.js','eval/golden-capture.test.js','eval/adversarial-capture.test.js','eval/camera-quality.test.js','eval/page-syntax.test.js','eval/server-syntax.test.js','eval/ocr-browser-smoke.html','scripts/validate.ps1'
)
$missing = @($required | Where-Object { -not (Test-Path (Join-Path $root $_)) })
if ($missing.Count -gt 0) { Fail ("required files missing: " + ($missing -join ', ')) } else { Pass 'required files present' }

# ---------- 2. secret scan ----------
$textExt = @('.md','.gs','.js','.json','.html','.ps1','.yml','.yaml','.txt','.cmd','.bat')
$scanFiles = Get-ChildItem $root -Recurse -File | Where-Object {
  $_.FullName -notmatch '\\\.git\\' -and
  $_.FullName -notmatch '\\node_modules\\' -and
  $_.FullName -notmatch '\\docs\\vendor\\' -and
  $_.FullName -notmatch '\\docs\\next\\' -and
  $_.FullName -notmatch '\\eval\\\.work\\' -and
  $_.Name -ne 'package-lock.json' -and
  $textExt -contains $_.Extension.ToLower()
}
$secretHits = New-Object System.Collections.ArrayList
foreach ($f in $scanFiles) {
  $rel = $f.FullName.Substring($root.Length + 1)
  $lineNo = 0
  foreach ($line in [System.IO.File]::ReadAllLines($f.FullName)) {
    $lineNo++
    # GAS deployment id: allowed only in the explicit public runtime config.
    if ($line -match 'AKfycb[A-Za-z0-9_-]{10,}' -and $rel -ne 'config\public-runtime.json') {
      [void]$secretHits.Add("$rel(:$lineNo) GAS exec id outside config/public-runtime.json")
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

# ---------- 5b. eval harness 자체 검증 ----------
# run-eval.ps1은 지금까지 표준 검증 경로에서 한 번도 실행되지 않았다.
# -Validate가 reviewStatus 상한 판정의 self-test를 품고 있다 (TSK-000297).
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'eval\run-eval.ps1') -Validate | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'eval harness self-test / fixture schema check failed (eval\run-eval.ps1 -Validate)' } else { Pass 'eval harness self-test + fixture schema check passed' }

# ---------- 6. PWA sanity ----------
$idx = Get-Content (Join-Path $root 'docs\index.html') -Raw
$runtime = Get-Content (Join-Path $root 'config\public-runtime.json') -Raw | ConvertFrom-Json
$rootSw = Get-Content (Join-Path $root 'docs\sw.js') -Raw
if ($idx -notmatch "new URL\('next/'" -or $idx -notmatch 'destination\.search = location\.search') { Fail 'docs/index.html live redirect missing or query not preserved' } else { Pass 'live redirect preserves query parameters' }
if (-not $runtime.apiUrl -or $runtime.apiUrl -notmatch '^https://script\.google\.com/macros/s/[A-Za-z0-9_-]+/exec$') { Fail 'public runtime API missing or malformed' } else { Pass 'public runtime API present' }
if (Test-Path (Join-Path $root 'docs\legacy.html')) { Fail 'retired docs/legacy.html still exists' } else { Pass 'legacy user surface retired' }
if ($idx -match 'legacy\.html' -or $rootSw -match 'legacy\.html') { Fail 'current root entry or service worker still references legacy.html' } else { Pass 'current root has no legacy entry or precache' }
if (-not $rootSw.Contains("if (url.pathname.indexOf(scopePath + 'next/') === 0) return;") -or -not $rootSw.Contains('/^cardcapture-v/.test(k)')) { Fail 'root service worker must ignore next scope and preserve candidate caches' } else { Pass 'root and React service-worker caches are isolated' }
if ((Get-Content (Join-Path $root 'CHANGELOG.md') -Raw) -notmatch '\[Unreleased\]') { Warn 'CHANGELOG has no [Unreleased] section' } else { Pass 'CHANGELOG has [Unreleased]' }

# ---------- 7. camera auto-capture acceptance ----------
$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) {
  Warn 'node not found; camera-quality deterministic tests skipped'
} else {
  & $node.Source (Join-Path $root 'eval\camera-quality.test.js')
  if ($LASTEXITCODE -ne 0) { Fail 'camera-quality deterministic tests failed' } else { Pass 'camera-quality deterministic tests passed' }
  & $node.Source (Join-Path $root 'eval\page-syntax.test.js')
  if ($LASTEXITCODE -ne 0) { Fail 'page JavaScript syntax test failed' } else { Pass 'page JavaScript syntax test passed' }
  & $node.Source (Join-Path $root 'eval\public-runtime-credential.test.js')
  if ($LASTEXITCODE -ne 0) { Fail 'public runtime credential boundary test failed' } else { Pass 'public runtime credential boundary static test passed' }
  & $node.Source (Join-Path $root 'eval\server-syntax.test.js')
  if ($LASTEXITCODE -ne 0) { Fail 'Code.gs JavaScript syntax test failed' } else { Pass 'Code.gs JavaScript syntax test passed' }
  & $node.Source (Join-Path $root 'eval\upload-idempotency.test.js')
  if ($LASTEXITCODE -ne 0) { Fail 'upload idempotency / lifecycle non-regression test failed' } else { Pass 'upload idempotency deterministic tests passed' }
  & $node.Source (Join-Path $root 'eval\upload-filename-allowlist.test.js')
  if ($LASTEXITCODE -ne 0) { Fail 'upload filename allowlist test failed' } else { Pass 'upload filename allowlist deterministic tests passed' }
  & $node.Source (Join-Path $root 'eval\status-consistency.test.js')
  if ($LASTEXITCODE -ne 0) { Fail 'status consistency test failed' } else { Pass 'status consistency deterministic tests passed' }
  & $node.Source (Join-Path $root 'eval\golden-capture.test.js')
  if ($LASTEXITCODE -ne 0) { Fail 'golden capture suite failed' } else { Pass 'golden capture deterministic tests passed' }
  & $node.Source (Join-Path $root 'eval\adversarial-capture.test.js')
  if ($LASTEXITCODE -ne 0) { Fail 'adversarial capture corpus failed' } else { Pass 'adversarial capture negative corpus passed' }
  & $node.Source (Join-Path $root 'eval\upload-content-type.test.js')
  if ($LASTEXITCODE -ne 0) { Fail 'upload content-type / magic-byte gate failed' } else { Pass 'upload content-type deterministic tests passed' }
  & $node.Source (Join-Path $root 'eval\version-sync.test.js')
  if ($LASTEXITCODE -ne 0) { Fail 'release version sync (package.json / CHANGELOG / tag) failed' } else { Pass 'release version sync deterministic gate passed' }
  & $node.Source (Join-Path $root 'eval\persondoc-owner.test.js')
  if ($LASTEXITCODE -ne 0) { Fail 'persondoc owner path gate failed' } else { Pass 'persondoc owner deterministic tests passed' }
  & $node.Source (Join-Path $root 'eval\prompt-injection.test.js')
  if ($LASTEXITCODE -ne 0) { Fail 'prompt-injection containment gate failed' } else { Pass 'prompt-injection containment gate passed' }
  # 두 번 빌드해 바이트 비교한다. frontend 의존성이 있어야만 의미가 있다.
  if (Test-Path (Join-Path $root 'frontend\node_modules\vite\bin\vite.js')) {
    & $node.Source (Join-Path $root 'eval\build-reproducibility.test.js')
    if ($LASTEXITCODE -ne 0) { Fail 'build reproducibility gate failed' } else { Pass 'build reproducibility deterministic gate passed' }
  } else {
    Warn 'frontend deps not installed; build reproducibility gate skipped (npm ci --prefix frontend)'
  }
}

# ---------- 8. pinned on-device OCR assets + self-hosted font ----------
$ocrHashes = @{
  'docs/vendor/tesseract/tesseract.min.js' = 'a8e29918d098b2b06e1012bdaeffb4aec0445c5d5654709023e0bd1f442a80e8'
  'docs/vendor/tesseract/worker.min.js' = 'aca1229639fc9907d86f96e825955a2b7c5716d17f3bc3acd71f9c7ab66181fc'
  'docs/vendor/tesseract/tesseract-core-simd-lstm.wasm.js' = 'ce20eda9533cbed1e6c2b4276fbae1e0adc61b6754b5513084be601787b457cf'
  'docs/vendor/tesseract/kor.traineddata.gz' = '78c21276ab14c9bb734d83be1055d9fe5469a4e7e977c51ad385be5737e61126'
  'docs/vendor/tesseract/eng.traineddata.gz' = '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91'
  # PP-OCRv5 quick-name engine (TSK-000236) - self-hosted, on-device only
  'docs/vendor/paddleocr/PP-OCRv5_mobile_det_infer.onnx' = 'd7fe3ea74652890722c0f4d02458b7261d9f5ae6c92904d05707c9eb155c7924'
  'docs/vendor/paddleocr/korean_PP-OCRv5_mobile_rec_infer.onnx' = 'ee0dfde503d787c91fd0455daae2eb85311b4b5bdcddf85a54d8c1e0adc157de'
  'docs/vendor/paddleocr/ppocrv5_korean_dict.txt' = 'a3792cbb41215a43e555e16ff4a7f7b18db5dd80cd058637098f0d872f2dd9d6'
  'docs/vendor/ort/ort-wasm-simd-threaded.wasm' = 'd1ab1b94b16a65b29d710d0b587b29e7bed336827577623913479b8afe8113e6'
  'docs/vendor/ort/ort-wasm-simd-threaded.mjs' = '0a1e718d99c41b22c21f2520ff4f9e883a6b5533856e398d21816ee8eb8185d3'
  # DocAligner LCNet100 corner heatmaps (TSK-000244) - self-hosted, on-device only
  'docs/vendor/cardquad/lcnet100_h_e_bifpn_256_fp32.onnx' = 'f4117b786e3a18470f3865c93f3c2bd69d9b998edd60f385574a5c665e79594e'
  # Pretendard Variable subset (founder 2026-07-28) - self-hosted, SIL OFL 1.1.
  # Sub-setting recipe and the reason for every choice live in frontend/src/fonts/README.md.
  'frontend/src/fonts/pretendard-variable-korean.woff2' = '58f28b65661548386dc69f78d65ebad51baca1ce133d6b7647444f4579babb2b'
}
$badOcrHash = @()
foreach ($rel in $ocrHashes.Keys) {
  $path = Join-Path $root $rel
  if (-not (Test-Path $path)) { $badOcrHash += "$rel missing"; continue }
  $actual = (Get-FileHash -Algorithm SHA256 $path).Hash.ToLowerInvariant()
  if ($actual -ne $ocrHashes[$rel]) { $badOcrHash += "$rel hash mismatch" }
}
if ($badOcrHash.Count -gt 0) { $badOcrHash | ForEach-Object { Fail "on-device-asset: $_" } } else { Pass 'pinned OCR/card-quad/font asset hashes match' }

# ---------- 9. watcher 스위트 ----------
# 반드시 -File 로 호출한다 — identity·다중 orphan 게이트가 실행 프로세스 자신의 command line을 읽는다.
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'watcher\tests\health-tests.ps1') | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'watcher health dashboard tests failed' } else { Pass 'watcher health dashboard deterministic tests passed' }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'watcher\tests\watcher-tests.ps1') | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'watcher recovery/idempotency tests failed' } else { Pass 'watcher recovery/idempotency deterministic tests passed' }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'watcher\tests\watcher-protocol-tests.ps1') | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'watcher claim/lease/quarantine protocol tests failed' } else { Pass 'watcher claim/lease/quarantine protocol deterministic tests passed' }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'watcher\tests\log-pii-tests.ps1') | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'watcher log PII separation/retention tests failed' } else { Pass 'watcher log PII separation/retention deterministic tests passed' }

# ---------- summary ----------
Write-Host ''
Write-Host ("summary: fail=" + $failures.Count + " warn=" + $warnings.Count)
if ($failures.Count -gt 0) { Write-Host 'RESULT: FAIL'; exit 1 } else { Write-Host 'RESULT: PASS'; exit 0 }
