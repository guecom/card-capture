# CardCapture_Watcher.ps1 — 명함 캡처 즉시 처리 워처 (Codex 엔진)
# 역할: Drive 동기화로 00_Inbox/BusinessCards에 새 캡처(status=received)가 도착하면
#       즉시 Codex(codex exec, gpt-5.6-sol/xhigh)로 명함 처리 절차를 실행한다.
#       시작 시 1회 스윕(놓친 캡처 처리) + 파일 이벤트 + 60초 폴백 폴링.
# 자동시작: 시작프로그램 폴더의 CardCaptureWatcher.bat (로그온 시)
# 로그: %LOCALAPPDATA%\CardCapture\watcher.log

$Vault  = 'C:\Users\gueco\내 드라이브\00_MetaBrain_Vault\Kairen'
$Inbox  = Join-Path $Vault '00_Inbox\BusinessCards'
$Codex  = 'C:\Users\gueco\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe'
$LogDir = Join-Path $env:LOCALAPPDATA 'CardCapture'
$LogFile = Join-Path $LogDir 'watcher.log'
$Lock   = Join-Path $Inbox 'processing.lock'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Log($m) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" | Out-File -Append -Encoding utf8 $LogFile
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

$Prompt = @'
명함 캡처를 처리해라. 이 vault의 표준 절차 문서 `01_Company/00_Company_Operations/05_Tools_and_Systems/CardCapture_Processing.md`를 먼저 읽고 그 절차를 그대로 따른다.

핵심 요약:
1. `00_Inbox/BusinessCards/` 하위 폴더의 capture.json(변형 `capture (1).json`이면 가장 최신 파일이 진실)을 확인해 status가 "received"인 캡처, 또는 status가 "processed"여도 receivedAt이 processedAt보다 최신인 재전송 캡처만 처리한다.
2. 처리 대상이 없으면 아무 것도 바꾸지 말고 "새 캡처 없음"으로 즉시 종료한다.
3. 명함 이미지를 직접 읽어 OCR하고, 기존 Person과 이메일·전화(정규화)·이름으로 중복검사한다. 중복이면 신규 생성 금지, 기존 인스턴스를 프런트매터+본문 전면 재구성으로 갱신한다(과거 소속은 Career 이력으로 내리고 provenance는 보존). 신규면 PER typeID를 쓰기 직전 재스캔(max+1)으로 발급해 Template_Person 스키마로 생성한다.
4. 이미지를 `90_Vault/Attachment/BusinessCards/PER-ID_YYYYMMDD_front|back.jpg`로 옮기고 source_refs에 기록한다.
5. 심층 웹 보강: 사람과 회사를 각각 웹 검색(각 4회 이상). LinkedIn 공개 프로필을 이메일 prefix·중간이름·소속으로 교차검증해 동일인 확정 근거를 남기고, 경력·학력·투자·제품·수상까지. 항목별 신뢰도(high/medium)와 출처 URL을 본문 "공개 출처"에 남긴다. 미특정은 미특정이라 쓴다.
6. 조직은 기존 Organization Instance가 있으면 File 링크, 없으면 organization_mentions로 보존한다.
7. 캡처 폴더에 brief.md(사용자용 "이런 분이에요" 브리핑)를 쓰고, capture.json을 status="processed"(명함이 아니면 "skipped"+사유), person, personAction, processedAt, processedBy로 갱신한다.
8. reviewStatus는 agent_checked까지만. human_validated는 절대 설정하지 않는다.
9. 완료 전 반드시 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "02_Kairen_OS/90_Setting/Validation/Validate-KairenOntology.ps1"`를 실행해 PASS를 확인한다. FAIL이면 고치고 재실행한다.

AGENTS.md와 CLAUDE.md의 vault 규칙(change_policy, 링크 온톨로지, 마크다운 표 파이프 이스케이프)을 준수해라. 개인적 인상·민감 메모는 Person 본문 Private 섹션에만 보존해라. 유료 API를 새로 호출하지 마라.
'@

function Invoke-Processing {
    if (Test-Path $Lock) {
        $age = (Get-Date) - (Get-Item $Lock).LastWriteTime
        if ($age.TotalMinutes -lt 30) { Write-Log 'lock exists (<30min), skip'; return }
        Remove-Item $Lock -Force -ErrorAction SilentlyContinue
    }
    if (-not (Test-Path $Codex)) { Write-Log "codex.exe not found: $Codex"; return }
    'watcher' | Out-File -Encoding ascii $Lock
    Write-Log 'processing start (codex)'
    try {
        Set-Location $Vault
        # 프롬프트는 stdin으로 전달('-')하고 codex가 vault를 workspace로 쓰며 파일을 편집
        $Prompt | & $Codex exec -C $Vault -s workspace-write -c 'tools.web_search=true' - 2>&1 |
            Out-File -Append -Encoding utf8 $LogFile
        Write-Log "processing done, exit=$LASTEXITCODE"
    } catch {
        Write-Log ("processing error: " + $_.Exception.Message)
    } finally {
        Remove-Item $Lock -Force -ErrorAction SilentlyContinue
    }
}

# 싱글턴: 이미 다른 인스턴스가 돌고 있으면 종료
$mtx = New-Object System.Threading.Mutex($false, 'Local\CardCaptureWatcher')
if (-not $mtx.WaitOne(0)) { Write-Log "another instance running, exit (PID=$PID)"; exit }

Write-Log "=== watcher started (codex engine) PID=$PID ==="

try {
    # 시작 스윕: 꺼져 있는 동안 도착한 캡처 처리
    if (Test-NewCapture) {
        Write-Log 'startup sweep: new capture found'
        Start-Sleep -Seconds 30
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

    $lastBeat = Get-Date
    while ($true) {
        try {
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
            if (((Get-Date) - $lastBeat).TotalMinutes -ge 10) {
                Write-Log "heartbeat (PID=$PID, loop alive)"
                $lastBeat = Get-Date
            }
        } catch {
            Write-Log ("loop error: " + $_.Exception.Message)
            Start-Sleep -Seconds 10
        }
    }
} catch {
    Write-Log ("FATAL: " + $_.Exception.Message)
} finally {
    Write-Log "watcher exiting (PID=$PID)"
    $mtx.ReleaseMutex() 2>$null
}
