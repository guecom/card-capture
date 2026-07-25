'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var props = {
  TOKENS: JSON.stringify({ 'owner-token': 'Owner', 'guest-token': 'Guest' }),
  OWNER_NAMES: 'Owner',
  INBOX_FOLDER_ID: 'synthetic-inbox',
  DAILY_LIMIT: '100',
  RESEARCH_INSTRUCTION_ENABLED: 'true'
};
var folders = {};
var created = [];

function iter(values) {
  var index = 0;
  return { hasNext: function () { return index < values.length; }, next: function () { return values[index++]; } };
}
function blob(text, name) {
  return {
    text: String(text),
    name: name,
    getDataAsString: function () { return this.text; }
  };
}
function file(name, text) {
  return {
    getName: function () { return name; },
    getLastUpdated: function () { return new Date(1); },
    getBlob: function () { return blob(text, name); },
    setTrashed: function () {}
  };
}
function folder(name, initialMeta) {
  var files = initialMeta ? [file('capture.json', JSON.stringify(initialMeta))] : [];
  return {
    name: name,
    files: files,
    getName: function () { return name; },
    getFiles: function () { return iter(files); },
    getFilesByName: function (target) { return iter(files.filter(function (f) { return f.getName() === target; })); },
    createFile: function (value) { files.push(file(value.name || 'file', value.text)); return files[files.length - 1]; }
  };
}
var inbox = {
  getFoldersByName: function (name) { return iter(folders[name] ? [folders[name]] : []); },
  createFolder: function (name) { var value = folder(name); folders[name] = value; created.push(value); return value; }
};
var cache = {};
var sandbox = {
  console: console,
  Date: Date,
  JSON: JSON,
  Math: Math,
  isFinite: isFinite,
  PropertiesService: { getScriptProperties: function () { return { getProperty: function (key) { return props[key] || null; } }; } },
  ContentService: {
    MimeType: { JSON: 'application/json' },
    createTextOutput: function (text) { return { text: text, setMimeType: function () { return this; } }; }
  },
  DriveApp: { getFolderById: function () { return inbox; } },
  CacheService: { getScriptCache: function () { return { get: function (key) { return cache[key] || null; }, put: function (key, value) { cache[key] = value; } }; } },
  LockService: { getScriptLock: function () { return { waitLock: function () {}, releaseLock: function () {} }; } },
  Utilities: {
    formatDate: function () { return '20260725-171500'; },
    getUuid: function () { return 'abcd-0000'; },
    base64Decode: function () { return [1, 2, 3]; },
    newBlob: function (value, mime, name) { return blob(typeof value === 'string' ? value : 'synthetic-image', name); }
  }
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), sandbox);

function body(output) { return JSON.parse(output.text); }

var guestInitial = body(sandbox.doPost({ postData: { contents: JSON.stringify({
  k: 'guest-token', captureId: 'cap-guest', researchInstruction: { raw: '공개 경력 조사' }, images: []
}) } }));
assert.deepStrictEqual(guestInitial, { ok: false, error: 'owner_only' });

props.RESEARCH_INSTRUCTION_ENABLED = 'false';
var disabled = body(sandbox.researchInstruction_({ k: 'owner-token', person: 'PER-999901', text: '공개 경력 조사' }));
assert.deepStrictEqual(disabled, { ok: false, error: 'feature_disabled' });
props.RESEARCH_INSTRUCTION_ENABLED = 'true';

folders['cap-match'] = folder('cap-match', { captureId: 'cap-match', person: 'PER-999901', status: 'processed' });
var mismatch = body(sandbox.researchInstruction_({
  k: 'owner-token', captureId: 'cap-match', person: 'PER-999902', text: '공개 경력 조사'
}));
assert.deepStrictEqual(mismatch, { ok: false, error: 'target_mismatch' });

var existing = body(sandbox.researchInstruction_({
  k: 'owner-token', person: 'PER-999903', text: '공개 경력과 창업 이력을 깊게 조사'
}));
assert.strictEqual(existing.ok, true);
var existingMeta = JSON.parse(created[created.length - 1].files[0].getBlob().getDataAsString());
assert.strictEqual(existingMeta.type, 'research_instruction');
assert.strictEqual(existingMeta.researchInstruction.requestedBy, 'Owner');
assert.strictEqual(existingMeta.researchInstruction.target.person, 'PER-999903');
assert.strictEqual(existingMeta.researchInstruction.policy.publicLawfulSourcesOnly, true);
assert.strictEqual(existingMeta.researchInstruction.policy.externalSendOrWrite, false);
assert.strictEqual(existingMeta.researchInstruction.policy.reviewCeiling, 'agent_checked');

var initial = body(sandbox.doPost({ postData: { contents: JSON.stringify({
  k: 'owner-token', captureId: 'cap-owner', capturedAt: '2026-07-25T08:15:00.000Z',
  note: '메모 원문', researchInstruction: { raw: '공개 특허와 인터뷰 조사', requestedBy: 'forged-user' },
  images: [{ name: 'front.jpg', mime: 'image/jpeg', dataB64: 'AQID' }]
}) } }));
assert.strictEqual(initial.ok, true);
var initialMetaFile = folders['cap-owner'].files.filter(function (f) { return f.getName() === 'capture.json'; }).slice(-1)[0];
var initialMeta = JSON.parse(initialMetaFile.getBlob().getDataAsString());
assert.strictEqual(initialMeta.note, '메모 원문');
assert.strictEqual(initialMeta.researchInstruction.raw, '공개 특허와 인터뷰 조사');
assert.strictEqual(initialMeta.researchInstruction.requestedBy, 'Owner');
assert.strictEqual(initialMeta.researchInstruction.target.captureId, 'cap-owner');
assert.strictEqual(initialMeta.researchInstruction.policy.humanGateOverride, false);

console.log('PASS GAS research policy: guest/flag/target/initial/existing paths');
