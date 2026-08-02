'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
const props = {
  TOKENS: JSON.stringify({ 'token-a': 'Same Name', 'token-b': 'Same Name' }),
  INBOX_FOLDER_ID: 'synthetic-inbox',
  PUSH_NOTIFICATIONS_ENABLED: 'false'
};
const files = [];
const mails = [];
let uuidCounter = 0;

function iter(values) {
  let index = 0;
  return { hasNext: () => index < values.length, next: () => values[index++] };
}

function blob(value, mime, name) {
  return { getDataAsString: () => String(value), getName: () => name, name, mime };
}

function fileFromBlob(value) {
  let trashed = false;
  return {
    getName: () => value.name,
    getBlob: () => value,
    setTrashed: (next) => { trashed = Boolean(next); },
    isTrashed: () => trashed
  };
}

const vaultRoot = { getId: () => 'synthetic-vault', getParents: () => iter([]) };
const inboxParent = { getId: () => 'synthetic-00-inbox', getParents: () => iter([vaultRoot]) };
const inbox = { getId: () => props.INBOX_FOLDER_ID, getParents: () => iter([inboxParent]) };
const registry = {
  parent: null,
  parents: null,
  sharingAccess: 'PRIVATE',
  getId: () => 'private-registry',
  getParents() { return iter(this.parents ?? (this.parent ? [this.parent] : [])); },
  getSharingAccess() { return this.sharingAccess; },
  getFilesByName(name) { return iter(files.filter((file) => !file.isTrashed() && file.getName() === name)); },
  getFiles() { return iter(files.filter((file) => !file.isTrashed())); },
  createFile(value) { const file = fileFromBlob(value); files.push(file); return file; }
};

const sandbox = {
  console,
  Date,
  JSON,
  Math,
  isFinite,
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: (key) => Object.prototype.hasOwnProperty.call(props, key) ? props[key] : null,
      setProperty: (key, value) => { props[key] = String(value); },
      deleteProperty: (key) => { delete props[key]; }
    })
  },
  ContentService: {
    MimeType: { JSON: 'application/json' },
    createTextOutput: (text) => ({ text, setMimeType() { return this; } })
  },
  DriveApp: {
    Access: { PRIVATE: 'PRIVATE', ANYONE: 'ANYONE' },
    getFolderById: (id) => {
      if (id === props.PUSH_REGISTRY_FOLDER_ID) return registry;
      if (id === props.INBOX_FOLDER_ID) return inbox;
      throw new Error('unexpected folder');
    }
  },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  Utilities: {
    DigestAlgorithm: { SHA_256: 'sha256' },
    Charset: { UTF_8: 'utf8' },
    computeDigest: (_algorithm, value) => Array.from(crypto.createHash('sha256').update(String(value), 'utf8').digest()).map((byte) => byte > 127 ? byte - 256 : byte),
    computeHmacSha256Signature: (value, key) => Array.from(crypto.createHmac('sha256', String(key)).update(String(value), 'utf8').digest()).map((byte) => byte > 127 ? byte - 256 : byte),
    getUuid: () => (++uuidCounter).toString(16).padStart(32, '0').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5'),
    newBlob: blob
  },
  CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) },
  MailApp: { sendEmail: (message) => mails.push(message) },
  Session: { getEffectiveUser: () => ({ getEmail: () => 'synthetic@example.invalid' }) }
};

vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'Code.gs' });

function body(output) { return JSON.parse(output.text); }
function post(value) { return body(sandbox.doPost({ postData: { contents: JSON.stringify(value) } })); }
function endpoint(suffix) { return `https://fcm.googleapis.com/fcm/send/${suffix.repeat(30)}`; }
function subscription(value) { return { endpoint: endpoint(value), expirationTime: null, keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) } }; }

assert.deepStrictEqual(body(sandbox.pushConfig_('missing')), { ok: false, error: 'invalid_token' });
assert.deepStrictEqual(body(sandbox.pushConfig_('token-a')), { ok: true, enabled: false, transport: 'direct_web_push_v1', maxDevices: 4 });
assert.deepStrictEqual(body(sandbox.notifyProcessed_()), { ok: false, error: 'notification_channel_retired' });
assert.strictEqual(mails.length, 0, 'retired MailApp path must have no external effect');

props.PUSH_VAPID_PUBLIC_KEY = 'v'.repeat(87);
props.PUSH_REGISTRY_FOLDER_ID = 'private-registry';
props.PUSH_SENDER_TOKEN = 'sender_'.repeat(8);
props.PUSH_MAX_SUBSCRIPTIONS_PER_SUBJECT = '1';
props.PUSH_NOTIFICATIONS_ENABLED = 'true';

const config = body(sandbox.pushConfig_('token-a'));
assert.strictEqual(config.ok, true);
assert.strictEqual(config.enabled, true);
assert.strictEqual(config.publicKey, props.PUSH_VAPID_PUBLIC_KEY);
assert.ok(!JSON.stringify(config).includes('subjectId'), 'browser config must not expose routing subject');
assert.ok(!JSON.stringify(config).includes(props.PUSH_SENDER_TOKEN), 'browser config must not expose sender token');
assert.match(config.keyId, /^vpk-[a-f0-9]{20}$/);

assert.deepStrictEqual(post({ action: 'pushconfig', k: 'token-a' }), config, 'push config is POST-only and routed through doPost');
assert.strictEqual(body(sandbox.doGet({ parameter: { action: 'pushconfig', k: 'token-a' } })).error, 'unknown_action', 'GET push config must stay rejected');
assert.strictEqual(body(sandbox.doGet({ parameter: { action: 'pushstatus', k: 'token-a' } })).error, 'unknown_action', 'GET push status must stay rejected');

registry.parent = vaultRoot;
assert.strictEqual(body(sandbox.pushConfig_('token-a')).enabled, false, 'registry inside synced vault must fail closed');
registry.parent = null;
let deepParent = vaultRoot;
for (let depth = 0; depth < 17; depth += 1) {
  const parent = deepParent;
  const child = { getId: () => `deep-${depth}`, getParents: () => iter([parent]) };
  deepParent = child;
}
registry.parent = deepParent;
assert.strictEqual(body(sandbox.pushConfig_('token-a')).enabled, false, 'ancestor depth beyond the proof bound must fail closed');
registry.parent = null;
registry.parents = Array.from({ length: 16 }, (_value, index) => ({ getId: () => `decoy-${index}`, getParents: () => iter([]) })).concat(vaultRoot);
assert.strictEqual(body(sandbox.pushConfig_('token-a')).enabled, false, 'multi-parent graph beyond the proof bound must fail closed');
registry.parents = null;
registry.sharingAccess = 'ANYONE';
assert.strictEqual(body(sandbox.pushConfig_('token-a')).enabled, false, 'shared registry must fail closed');
registry.sharingAccess = 'PRIVATE';

assert.strictEqual(post({ action: 'pushsubscribe', k: 'token-a', keyId: 'vpk-' + '0'.repeat(20), subscription: subscription('x') }).error, 'key_changed');
assert.strictEqual(post({ action: 'pushsubscribe', k: 'token-a', keyId: config.keyId, subscription: subscription('x') }).ok, true);
assert.strictEqual(files.filter((file) => !file.isTrashed()).length, 1);
assert.strictEqual(post({ action: 'pushsubscribe', k: 'token-a', keyId: config.keyId, subscription: subscription('x') }).ok, true, 'same subscription must be idempotent');
assert.strictEqual(files.filter((file) => !file.isTrashed()).length, 1, 'upsert must keep one active record');

const stored = JSON.parse(files.find((file) => !file.isTrashed()).getBlob().getDataAsString());
assert.match(stored.subjectId, /^psh-[a-f0-9]{64}$/);
assert.ok(!JSON.stringify(stored).includes('token-a') && !JSON.stringify(stored).includes('Same Name'), 'registry must not store bearer token or display name');
assert.strictEqual(post({ action: 'pushstatus', k: 'token-a', endpoint: subscription('x').endpoint }).active, true);
assert.strictEqual(post({ action: 'pushstatus', k: 'token-b', endpoint: subscription('x').endpoint }).active, false, 'other token cannot claim registry status');

const crossSubject = post({ action: 'pushsubscribe', k: 'token-b', keyId: config.keyId, subscription: subscription('x') });
assert.strictEqual(crossSubject.error, 'subscription_subject_conflict', 'endpoint cannot silently transfer between tokens sharing a name');
assert.strictEqual(post({ action: 'pushsubscribe', k: 'token-a', keyId: config.keyId, subscription: subscription('y') }).error, 'subscription_limit');
assert.strictEqual(post({ action: 'pushsubscribe', k: 'token-a', keyId: config.keyId, subscription: { endpoint: 'https://attacker.invalid/capability', keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) } } }).error, 'bad_subscription');
assert.strictEqual(post({ action: 'pushsubscribe', k: 'token-a', keyId: config.keyId, subscription: { endpoint: endpoint('z'), keys: { p256dh: 'short', auth: 'short' } } }).error, 'bad_subscription');

const subjectA = sandbox.pushSubjectId_('token-a');
const expectedRoutingTag = `prt-${crypto.createHmac('sha256', props.PUSH_SENDER_TOKEN).update(`card-capture-push-route-v1\0CAPTURE01\0${subjectA}`, 'utf8').digest('hex')}`;
assert.strictEqual(sandbox.pushRoutingTag_('CAPTURE01', subjectA), expectedRoutingTag, 'receipt routing tag must be capture-bound and server-authenticated');
assert.strictEqual(post({ action: 'pushsubscriptions', senderToken: 'wrong', subjectId: subjectA }).error, 'sender_unauthorized');
const lookup = post({ action: 'pushsubscriptions', senderToken: props.PUSH_SENDER_TOKEN, subjectId: subjectA });
assert.strictEqual(lookup.ok, true);
assert.strictEqual(lookup.subscriptions.length, 1);
assert.strictEqual(lookup.subscriptions[0].endpoint, subscription('x').endpoint);
assert.match(lookup.subscriptions[0].revisionId, /^prv-[a-f0-9]{32}$/);
assert.ok(!JSON.stringify(lookup).includes('Same Name') && !JSON.stringify(lookup).includes('token-a'));
props.TOKENS = JSON.stringify({ 'token-b': 'Same Name' });
const inactive = post({ action: 'pushsubscriptions', senderToken: props.PUSH_SENDER_TOKEN, subjectId: subjectA });
assert.strictEqual(inactive.subjectInactive, true, 'token rotation/removal must stop old subject delivery immediately');
assert.strictEqual(inactive.subscriptions.length, 0);
props.TOKENS = JSON.stringify({ 'token-a': 'Same Name', 'token-b': 'Same Name' });
props.TOKENS = JSON.stringify({ 'token-a': '', 'token-b': 'Same Name' });
assert.strictEqual(post({ action: 'pushsubscriptions', senderToken: props.PUSH_SENDER_TOKEN, subjectId: subjectA }).subjectInactive, true, 'falsy token values must revoke push like bearer access');
props.TOKENS = JSON.stringify({ 'token-a': 'Same Name', 'token-b': 'Same Name' });

assert.strictEqual(post({ action: 'pushunsubscribe', k: 'token-b', endpoint: subscription('x').endpoint }).error, 'subscription_subject_conflict');
assert.strictEqual(post({ action: 'pushunsubscribe', k: 'token-a', endpoint: subscription('x').endpoint }).ok, true);
assert.strictEqual(files.filter((file) => !file.isTrashed()).length, 0);
assert.strictEqual(post({ action: 'pushunsubscribe', k: 'token-a', endpoint: subscription('x').endpoint }).deduped, true);

post({ action: 'pushsubscribe', k: 'token-a', keyId: config.keyId, subscription: subscription('r') });
const activeRecord = JSON.parse(files.find((file) => !file.isTrashed()).getBlob().getDataAsString());
assert.strictEqual(post({ action: 'pushretire', senderToken: props.PUSH_SENDER_TOKEN, subscriptionId: activeRecord.subscriptionId, revisionId: 'prv-' + '0'.repeat(32) }).staleRevision, true, 'stale 410 cannot retire a renewed subscription');
assert.strictEqual(post({ action: 'pushretire', senderToken: props.PUSH_SENDER_TOKEN, subscriptionId: activeRecord.subscriptionId, revisionId: activeRecord.revisionId }).retired, true);
assert.strictEqual(files.filter((file) => !file.isTrashed()).length, 0);

props.PUSH_NOTIFICATIONS_ENABLED = 'false';
assert.strictEqual(post({ action: 'pushsubscriptions', senderToken: props.PUSH_SENDER_TOKEN, subjectId: subjectA }).error, 'feature_disabled');
assert.strictEqual(post({ action: 'pushsubscribe', k: 'token-a', subscription: subscription('q') }).error, 'feature_disabled');
assert.strictEqual(post({ action: 'pushunsubscribe', k: 'token-a', endpoint: subscription('q').endpoint }).ok, true, 'revoke remains fail-safe while feature is disabled');

console.log('gas push policy tests: PASS');
