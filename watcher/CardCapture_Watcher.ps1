# CardCapture_Watcher.ps1 — 명함 캡처 즉시 처리 워처
# 역할: Drive 동기화로 00_Inbox/BusinessCards에 새 캡처(status=received)가 도착하면
#       즉시 headless Claude(process-cards 스킬)를 실행한다.
#       시작 시 1회 스윕(놓친 캡처 처리) + 파일 이벤트 + 60초 폴백 폴링.
# 등록: 로그온 시 자동 시작 (schtasks: CardCaptureWatcher)
# 로그: %LOCALAPPDATA%\CardCapture\watcher.log

$Vault = 'C:\Users\gueco\내 드라이브\00_MetaBrain_Vault\Kairen'
$Inbox = Join-Path $Vault '00_Inbox\BusinessCards'
$Claude = 'C:\Users\gueco\.local\bin\claude.exe'
$LogDir = Join-Path $env:LOCALAPPDATA 'CardCapture'
$LogFile = Join-Path $LogDir 'watcher.log'
$Lock = Join-Path $Inbox 'processing.lock'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Log($m) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" | Out-File -Append -Encoding utf8 $LogFile
    # 로그 5MB 초과 시 절반 보존
    try {
        if ((Get-Item $LogFile).Length -gt 5MB) {
            $lines = Get-Content $LogFile
            $lines[[int]($lines.Count / 2)..($lines.Count - 1)] | Out-File -Encoding utf8 $LogFile
        }
    } catch {}
}

function Test-NewCapture {
    if (-not (Test-Path $Inbox)) { return $false }
    foreach ($d in (Get-ChildItem $Inbox -Directory -ErrorAction SilentlyContinue)) {
        $json = Get-ChildItem $d.FullName -Filter 'capture*.json' -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($json) {
            try {
                if ((Get-Content $json.FullName -Raw -ErrorAction Stop) -match '"status"\s*:\s*"received"') { return $true }
            } catch {}
        }
    }
    return $false
}

function Invoke-Processing {
    if (Test-Path $Lock) {
        $age = (Get-Date) - (Get-Item $Lock).LastWriteTime
        if ($age.TotalMinutes -lt 30) { Write-Log 'lock exists (<30min), skip'; return }
        Remove-Item $Lock -Force -ErrorAction SilentlyContinue
    }
    if (-not (Test-Path $Claude)) { Write-Log "claude.exe not found: $Claude"; return }
    'watcher' | Out-File -Encoding ascii $Lock
    Write-Log 'processing start'
    try {
        Set-Location $Vault
        $prompt = '명함 처리해줘. process-cards 스킬 절차(01_Company/00_Company_Operations/05_Tools_and_Systems/CardCapture_Processing.md)대로 00_Inbox/BusinessCards의 status=received 캡처를 전부 처리해라. 처리 대상이 없으면 아무 것도 변경하지 말고 종료해라. reviewStatus는 agent_checked까지만 설정하고, 완료 전 Validate-KairenOntology PASS를 확인해라.'
        & $Claude -p $prompt 2>&1 | Out-File -Append -Encoding utf8 $LogFile
        Write-Log "processing done, exit=$LASTEXITCODE"
    } catch {
        Write-Log ("processing error: " + $_.Exception.Message)
    } finally {
        Remove-Item $Lock -Force -ErrorAction SilentlyContinue
    }
}

Write-Log '=== watcher started ==='

# 시작 스윕: 꺼져 있는 동안 도착한 캡처 처리
if (Test-NewCapture) {
    Write-Log 'startup sweep: new capture found'
    Start-Sleep -Seconds 30   # Drive 동기화 안정화 대기
    Invoke-Processing
}

# 파일 이벤트 감시 + 60초 폴백 폴링
$fsw = New-Object System.IO.FileSystemWatcher
$fsw.Path = $Inbox
$fsw.Filter = '*.json'
$fsw.IncludeSubdirectories = $true
$fsw.EnableRaisingEvents = $true
Register-ObjectEvent -InputObject $fsw -EventName Created -SourceIdentifier CCWCreated | Out-Null
Register-ObjectEvent -InputObject $fsw -EventName Changed -SourceIdentifier CCWChanged | Out-Null

while ($true) {
    $ev = Wait-Event -Timeout 60
    if ($ev) {
        Remove-Event -EventIdentifier $ev.EventIdentifier -ErrorAction SilentlyContinue
        Get-Event -ErrorAction SilentlyContinue | Remove-Event -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 45   # 이미지·capture.json 동기화 완료 대기 (디바운스)
    }
    if (Test-NewCapture) {
        Write-Log ($(if ($ev) { 'event trigger' } else { 'poll trigger' }) + ': new capture found')
        Invoke-Processing
    }
}
