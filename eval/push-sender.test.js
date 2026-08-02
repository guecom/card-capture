'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const sender = path.join(root, 'watcher', 'push', 'push-sender.mjs');
const initializer = path.join(root, 'watcher', 'push', 'Initialize-CardCapturePush.ps1');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'watcher', 'push', 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'watcher', 'push', 'package-lock.json'), 'utf8'));

function run(args, input) {
  return spawnSync(process.execPath, [sender].concat(args || []), {
    input: input === undefined ? undefined : JSON.stringify(input),
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true
  });
}

assert.strictEqual(manifest.dependencies['web-push'], '3.6.7', 'sender dependency must be exactly pinned');
assert.strictEqual(lock.packages['node_modules/web-push'].version, '3.6.7', 'lockfile must resolve the pinned sender');

const generatedRun = run(['--generate']);
assert.strictEqual(generatedRun.status, 0, generatedRun.stderr);
const generated = JSON.parse(generatedRun.stdout);
assert.strictEqual(generated.ok, true);
assert.match(generated.publicKey, /^[A-Za-z0-9_-]{80,120}$/);
assert.match(generated.privateKey, /^[A-Za-z0-9_-]{40,60}$/);

const secretEndpoint = `https://attacker.invalid/${'SECRETENDPOINT'.repeat(4)}`;
const invalidEndpointRun = run([], {
  operation: 'send',
  vapid: { subject: 'mailto:test@example.invalid', publicKey: generated.publicKey, privateKey: generated.privateKey },
  subscription: { endpoint: secretEndpoint, keys: { p256dh: 'a'.repeat(87), auth: 'b'.repeat(22) } },
  payload: { v: 1, eventId: `pne-${'c'.repeat(64)}`, kind: 'final_result', target: 'CAPTURE01' }
});
const invalidEndpoint = JSON.parse(invalidEndpointRun.stdout);
assert.strictEqual(invalidEndpoint.errorCode, 'bad_subscription');
assert.ok(!invalidEndpointRun.stdout.includes('SECRETENDPOINT'), 'sender output must not reflect capability URLs');

const invalidKindRun = run([], {
  operation: 'send',
  vapid: { subject: 'mailto:test@example.invalid', publicKey: generated.publicKey, privateKey: generated.privateKey },
  subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/${'x'.repeat(30)}`, keys: { p256dh: 'a'.repeat(87), auth: 'b'.repeat(22) } },
  payload: { v: 1, eventId: `pne-${'c'.repeat(64)}`, kind: 'quick_name', target: 'CAPTURE01', title: 'PII' }
});
assert.strictEqual(JSON.parse(invalidKindRun.stdout).errorCode, 'bad_payload');
assert.ok(!invalidKindRun.stdout.includes('PII'), 'sender output must not reflect payload content');

const source = fs.readFileSync(sender, 'utf8');
assert.ok(!/console\.(?:log|error)|JSON\.stringify\(request\)/.test(source), 'sender must not log the request or credentials');
const initializerSource = fs.readFileSync(initializer, 'utf8');
assert.ok(!/PUSH_SENDER_TOKEN_ONCE=.*\$senderToken/.test(initializerSource), 'initializer must not print sender credentials');
assert.match(initializerSource, /\[switch\]\$CopySenderTokenToClipboard/, 'secret handoff must require an explicit interactive switch');
assert.match(initializerSource, /Set-Clipboard -Value \$senderToken/, 'explicit handoff must avoid stdout and transcript capture');

console.log('push sender tests: PASS');
