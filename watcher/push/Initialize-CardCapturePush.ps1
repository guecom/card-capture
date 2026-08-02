# Kairen-Ref: TSK-000155 / TSK-000496
# VAPID private key와 sender token은 현재 Windows 사용자 DPAPI로 즉시 암호화한다.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Api,
    [Parameter(Mandatory = $true)][string]$VapidSubject,
    [string]$NodePath = 'C:\Program Files\nodejs\node.exe',
    [string]$ConfigPath = (Join-Path $env:LOCALAPPDATA 'CardCapture\push.conf'),
    [switch]$CopySenderTokenToClipboard,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
if ($Api -notmatch '^https://script\.google\.com/macros/s/[A-Za-z0-9_-]+/exec$') { throw 'Api는 배포된 GAS /exec HTTPS URL이어야 합니다.' }
if ($VapidSubject -notmatch '^(mailto:[^\s@]+@[^\s@]+|https://[^\s]+)$') { throw 'VapidSubject는 mailto:주소 또는 HTTPS URL이어야 합니다.' }
if (-not (Test-Path -LiteralPath $NodePath)) { throw 'Node.js 실행 파일을 찾을 수 없습니다.' }

$senderPath = Join-Path $PSScriptRoot 'push-sender.mjs'
if (-not (Test-Path -LiteralPath $senderPath)) { throw 'push-sender.mjs를 찾을 수 없습니다.' }
if ((Test-Path -LiteralPath $ConfigPath) -and -not $Force) { throw 'push.conf가 이미 있습니다. 바꾸려면 -Force를 명시하세요.' }

$generatedRaw = (& $NodePath $senderPath --generate 2>$null) -join "`n"
if ($LASTEXITCODE -ne 0) { throw 'VAPID key 생성에 실패했습니다.' }
$generated = $generatedRaw | ConvertFrom-Json
if (-not $generated.ok -or -not $generated.publicKey -or -not $generated.privateKey) { throw 'VAPID key 응답이 올바르지 않습니다.' }

$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$senderBytes = New-Object byte[] 48
try { $rng.GetBytes($senderBytes) } finally { $rng.Dispose() }
$senderToken = [Convert]::ToBase64String($senderBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')

function Protect-CurrentUser([string]$PlainText) {
    $secure = ConvertTo-SecureString -String $PlainText -AsPlainText -Force
    ConvertFrom-SecureString -SecureString $secure
}

$configDir = Split-Path -Parent $ConfigPath
if (-not (Test-Path -LiteralPath $configDir)) { New-Item -ItemType Directory -Path $configDir -Force | Out-Null }
$config = [ordered]@{
    version = 'card-capture-push-config-v1'
    api = $Api
    vapidSubject = $VapidSubject
    vapidPublicKey = [string]$generated.publicKey
    vapidPrivateKeyDpapi = Protect-CurrentUser ([string]$generated.privateKey)
    senderTokenDpapi = Protect-CurrentUser $senderToken
    nodePath = $NodePath
    senderPath = $senderPath
}
$tempPath = $ConfigPath + '.tmp'
[System.IO.File]::WriteAllText($tempPath, ($config | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
Move-Item -LiteralPath $tempPath -Destination $ConfigPath -Force

Write-Output 'LOCAL_CONFIG_READY'
Write-Output ('PUSH_VAPID_PUBLIC_KEY=' + [string]$generated.publicKey)
if ($CopySenderTokenToClipboard) {
    Set-Clipboard -Value $senderToken
    Write-Output 'PUSH_SENDER_TOKEN_COPIED_TO_CLIPBOARD'
} else {
    Write-Output 'PUSH_SENDER_TOKEN_NOT_REVEALED (대화·CI·transcript 노출 방지)'
}
Write-Output 'public key와 sender token을 GAS Script Properties에 넣은 뒤, PUSH_REGISTRY_FOLDER_ID를 설정하세요.'
Write-Output '외부 발송 승인이 끝날 때까지 PUSH_NOTIFICATIONS_ENABLED=false를 유지하세요.'
Write-Output 'disable 뒤 다시 enable할 때는 -Force로 VAPID key epoch를 회전하고 기기에서 다시 opt-in하세요.'
