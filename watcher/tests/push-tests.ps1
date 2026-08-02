# push-tests.ps1 — ISS-000045 Web Push truth/outbox/privacy contract
# Kairen-Ref: TSK-000155, TSK-000496
# 실제 네트워크·GAS·브라우저를 호출하지 않는다.
$ErrorActionPreference = 'Stop'
$watcherScript = Join-Path (Split-Path -Parent $PSScriptRoot) 'CardCapture_Watcher.ps1'
$pass = 0; $fail = 0
function T($ok, $label) { if ($ok) { $script:pass++; Write-Host "pass  $label" } else { $script:fail++; Write-Host "FAIL  $label" } }

$sandbox = Join-Path $env:TEMP ('ccw-push-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$sbInbox = Join-Path $sandbox 'inbox'
$sbState = Join-Path $sandbox 'state'
$sbLog = Join-Path $sandbox 'log'
New-Item -ItemType Directory -Force -Path $sbInbox, $sbState, $sbLog | Out-Null

try {
    $CardCaptureWatcherTestMode = $true
    . $watcherScript
    $Inbox = $sbInbox
    $StateDir = $sbState
    $LogFile = Join-Path $sbLog 'watcher.log'
    $HealthFile = Join-Path $sbLog 'watcher-health.json'
    $PushConf = Join-Path $sbLog 'push.conf'
    $Lock = Join-Path $sbInbox 'processing.lock'
    $script:SyntheticSenderToken = 'SYNTHETICSENDERTOKEN_DO_NOT_LOG_123456'

    function Get-PushRuntimeConfig { return [PSCustomObject]@{ api = 'https://script.google.com/macros/s/synthetic/exec'; senderToken = $script:SyntheticSenderToken; vapidSubject = 'mailto:test@example.invalid'; vapidPublicKey = ('e' * 87); vapidPrivateKey = ('f' * 43); nodePath = 'node'; senderPath = 'sender' } }

    function New-PushCapture($id, $status, $attention) {
        $dir = Join-Path $sbInbox $id
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        $subjectId = 'psh-' + ('a' * 64)
        $routingTag = 'prt-' + (Get-TextHmacSha256 $script:SyntheticSenderToken ('card-capture-push-route-v1' + [char]0 + $id + [char]0 + $subjectId))
        $meta = [ordered]@{ captureId = $id; capturer = 'SYNTHETICPERSON'; pushSubjectId = $subjectId; pushRoutingTag = $routingTag; status = $status; quickName = @{ name = 'SYNTHETICQUICKNAME' } }
        if ($attention) { $meta.attention = $attention }
        [IO.File]::WriteAllText((Join-Path $dir 'capture.json'), ($meta | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
        if ($status -eq 'processed') { 'synthetic brief' | Out-File -Encoding utf8 (Join-Path $dir 'brief.md') }
        return $dir
    }

    Write-Host '=== push outbox tests ==='
    $null = New-PushCapture 'PUSH0001' 'processed' $null
    T (-not (Queue-PushEvent 'PUSH0001' 'final_result' 'truth-a' (Get-PushRoutingSnapshot 'PUSH0001'))) 'config absent: no event is queued'

    '{}' | Out-File -Encoding utf8 $PushConf
    T ((Get-CommittedPushKind 'PUSH0001' 'processed') -eq 'final_result') 'processed maps to final_result'
    T ((Get-CommittedPushKind 'PUSH0001' 'received') -eq '') 'ordinary stage produces no push kind'

    $null = New-PushCapture 'PUSH0002' 'skipped' ([PSCustomObject]@{ kind = 'input_required'; reasonCode = 'unreadable_capture'; requestedAt = '2026-08-02T00:00:00Z' })
    T ((Get-CommittedPushKind 'PUSH0002' 'skipped') -eq 'human_input_required') 'allowlisted attention maps to human input'
    $null = New-PushCapture 'PUSH0003' 'skipped' $null
    T ((Get-CommittedPushKind 'PUSH0003' 'skipped') -eq '') 'ordinary skipped/non-card produces no push'

    $routing1 = Get-PushRoutingSnapshot 'PUSH0001'
    T (Queue-PushEvent 'PUSH0001' 'final_result' 'truth-a' $routing1) 'final event queued after terminal truth'
    T (Queue-PushEvent 'PUSH0001' 'final_result' 'truth-a' $routing1) 'same event idempotently queues'
    $eventFiles = @(Get-ChildItem (Join-Path $sbState 'notifications\events') -Filter '*.json')
    T ($eventFiles.Count -eq 1) 'durable event dedupe leaves one record'

    $script:ApiMode = 'active'
    $script:SendMode = 'accepted'
    $script:SendCalls = 0
    $script:RetireCalls = 0
    $script:ObservedPayload = $null
    $subscriptionId = 'psub-' + ('b' * 64)
    $subscription = [PSCustomObject]@{ subscriptionId = $subscriptionId; revisionId = ('prv-' + ('1' * 32)); endpoint = 'https://fcm.googleapis.com/fcm/send/' + ('x' * 30); expirationTime = $null; keys = @{ p256dh = ('c' * 87); auth = ('d' * 22) } }

    function Invoke-PushApi($config, $body) {
        if ($body.action -eq 'pushretire') { $script:RetireCalls++; return [PSCustomObject]@{ ok = $true } }
        if ($script:ApiMode -eq 'disabled') { return [PSCustomObject]@{ ok = $false; error = 'feature_disabled' } }
        if ($script:ApiMode -eq 'unavailable') { return $null }
        if ($script:ApiMode -eq 'none') { return [PSCustomObject]@{ ok = $true; subscriptions = @() } }
        $keyId = 'vpk-' + (Get-TextSha256 $config.vapidPublicKey).Substring(0, 20)
        if ($script:ApiMode -eq 'rotated') { $keyId = 'vpk-' + ('9' * 20) }
        return [PSCustomObject]@{ ok = $true; keyId = $keyId; subscriptions = @($subscription) }
    }
    function Invoke-PushSender($config, $sub, $payload) {
        $script:SendCalls++
        $script:ObservedPayload = $payload
        if ($script:SendMode -eq 'gone') { return [PSCustomObject]@{ ok = $false; permanent = $true; statusCode = 410 } }
        if ($script:SendMode -eq 'failed') { return [PSCustomObject]@{ ok = $false; permanent = $false; retryable = $true; statusCode = 503 } }
        return [PSCustomObject]@{ ok = $true; statusCode = 201 }
    }

    Flush-PushOutbox
    T ($script:SendCalls -eq 1) 'one active subscription receives one send attempt'
    T ($script:ObservedPayload.v -eq 1 -and $script:ObservedPayload.kind -eq 'final_result' -and $script:ObservedPayload.target -eq 'PUSH0001') 'payload uses fixed enum and opaque target'
    $payloadText = $script:ObservedPayload | ConvertTo-Json -Compress
    T ($payloadText -notmatch 'SYNTHETICPERSON|SYNTHETICQUICKNAME|endpoint|auth|token') 'payload excludes capture PII and credentials'
    $finishedEvent = Get-Content $eventFiles[0].FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    T ($finishedEvent.status -eq 'completed') 'accepted delivery completes event'
    Flush-PushOutbox
    T ($script:SendCalls -eq 1) 'restart/reflush does not duplicate accepted delivery'

    T (Queue-PushEvent 'PUSH0002' 'human_input_required' 'truth-b' (Get-PushRoutingSnapshot 'PUSH0002')) 'human input event queued'
    $script:SendMode = 'gone'
    Flush-PushOutbox
    T ($script:RetireCalls -eq 1) '410 retires stale subscription'

    T (Queue-PushEvent 'PUSH0001' 'recovery_required' 'truth-c' $routing1) 'recovery event queued independently'
    $script:SendMode = 'failed'
    Flush-PushOutbox; Flush-PushOutbox; Flush-PushOutbox
    $failedDelivery = @(Get-ChildItem (Join-Path $sbState 'notifications\deliveries') -Filter '*.json' | ForEach-Object { Get-Content $_.FullName -Raw | ConvertFrom-Json } | Where-Object { $_.status -eq 'failed' })
    T ($failedDelivery.Count -eq 1 -and $failedDelivery[0].attempts -eq $MaxAttempts) 'retry is bounded by existing MaxAttempts'
    $truthAfterFailure = Get-Content (Join-Path (Join-Path $sbInbox 'PUSH0001') 'capture.json') -Raw | ConvertFrom-Json
    T ($truthAfterFailure.status -eq 'processed') 'push failure never changes capture terminal truth'

    $null = New-PushCapture 'PUSH0004' 'processed' $null
    $routing4 = Get-PushRoutingSnapshot 'PUSH0004'
    $meta4Path = Join-Path (Join-Path $sbInbox 'PUSH0004') 'capture.json'
    $meta4 = Get-Content $meta4Path -Raw -Encoding UTF8 | ConvertFrom-Json
    $meta4.pushSubjectId = 'psh-' + ('f' * 64)
    [IO.File]::WriteAllText($meta4Path, ($meta4 | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
    T (-not (Test-PushRoutingUnchanged $routing4)) 'processor mutation of server-owned routing is detected'
    T (-not (Queue-PushEvent 'PUSH0004' 'final_result' 'truth-mutated' $routing4)) 'mutated subject cannot route an event'
    T ((Restore-PushRoutingSnapshot $routing4) -and (Test-PushRoutingUnchanged $routing4)) 'quick-pass routing snapshot is restorable'

    $null = New-PushCapture 'PUSH0005' 'processed' $null
    T (Queue-PushEvent 'PUSH0005' 'final_result' 'truth-unavailable' (Get-PushRoutingSnapshot 'PUSH0005')) 'lookup-failure fixture event queued'
    $beforeUnavailable = $script:SendCalls
    $script:ApiMode = 'unavailable'
    Flush-PushOutbox
    $script:ApiMode = 'active'
    Flush-PushOutbox
    T ($script:SendCalls -eq ($beforeUnavailable + 1)) 'transient lookup failure retries once and delivers in the same key epoch'

    $null = New-PushCapture 'PUSH0006' 'processed' $null
    T (Queue-PushEvent 'PUSH0006' 'final_result' 'truth-rotated' (Get-PushRoutingSnapshot 'PUSH0006')) 'key-epoch fixture event queued'
    $beforeRotation = $script:SendCalls
    $script:ApiMode = 'unavailable'
    Flush-PushOutbox
    $script:ApiMode = 'rotated'
    Flush-PushOutbox
    $script:ApiMode = 'active'
    Flush-PushOutbox
    T ($script:SendCalls -eq $beforeRotation) 'event from an older VAPID key epoch is permanently suppressed'

    $null = New-PushCapture 'PUSH0007' 'processed' $null
    T (Queue-PushEvent 'PUSH0007' 'final_result' 'truth-disabled' (Get-PushRoutingSnapshot 'PUSH0007')) 'feature-disabled fixture event queued'
    $beforeDisabled = $script:SendCalls
    $script:ApiMode = 'disabled'
    Flush-PushOutbox
    $script:ApiMode = 'active'
    Flush-PushOutbox
    T ($script:SendCalls -eq $beforeDisabled) 'server-confirmed feature disable permanently suppresses the event'

    $allState = (Get-ChildItem (Join-Path $sbState 'notifications') -Recurse -File | ForEach-Object { Get-Content $_.FullName -Raw }) -join "`n"
    T ($allState -notmatch 'fcm\.googleapis\.com|SYNTHETICPERSON|SYNTHETICQUICKNAME|SYNTHETICSENDERTOKEN') 'durable outbox stores no endpoint, token, or capture PII'
    Write-Health
    $health = Get-Content $HealthFile -Raw -Encoding UTF8 | ConvertFrom-Json
    T ($health.pushConfigured -eq $true -and $null -ne $health.pushPendingCount) 'health exposes only safe push readiness/counts'
} finally {
    Remove-Item -LiteralPath $sandbox -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "push outbox tests: pass=$pass fail=$fail"
if ($fail -gt 0) { exit 1 }
