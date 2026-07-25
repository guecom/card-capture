'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var props = {
  TOKENS: JSON.stringify({ 'owner-token': 'Owner' }),
  OWNER_NAMES: 'Owner',
  INBOX_FOLDER_ID: 'synthetic-inbox',
  DAILY_LIMIT: '100'
};
var folders = {};
var cache = {};
var clock = 0;

function iter(values) {
  var index = 0;
  return { hasNext: function () { return index < values.length; }, next: function () { return values[index++]; } };
}
function blob(text, name) {
  return { text: String(text), name: name, getDataAsString: function () { return this.text; } };
}
function file(name, text) {
  var modified = new Date(++clock);
  return {
    trashed: false,
    getName: function () { return name; },
    getLastUpdated: function () { return modified; },
    getBlob: function () { return blob(text, name); },
    setTrashed: function () { this.trashed = true; }
  };
}
function folder(name, meta) {
  var value = {
    name: name,
    files: [file('capture.json', JSON.stringify(meta))],
    getName: function () { return name; },
    getFiles: function () { return iter(this.files.filter(function (f) { return !f.trashed; })); },
    getFilesByName: function (target) {
      return iter(this.files.filter(function (f) { return !f.trashed && f.getName() === target; }));
    },
    createFile: function (input) {
      var created = file(input.name || 'file', input.text);
      this.files.push(created);
      return created;
    }
  };
  return value;
}
function activeMeta(value) {
  var files = value.files.filter(function (f) { return !f.trashed && f.getName() === 'capture.json'; });
  return JSON.parse(files[files.length - 1].getBlob().getDataAsString());
}

folders.processed = folder('processed', {
  captureId: 'processed', capturer: 'Owner', status: 'processed',
  receivedAt: '2026-07-25T07:00:00.000Z', processedAt: '2026-07-25T07:10:00.000Z'
});
folders.stale = folder('stale', {
  captureId: 'stale', capturer: 'Owner', status: 'received', person: 'PER-999901',
  receivedAt: '2026-07-25T07:00:00.000Z', processedAt: '2026-07-25T07:10:00.000Z'
});
folders.pending = folder('pending', {
  captureId: 'pending', capturer: 'Owner', status: 'received', receivedAt: '2026-07-25T07:00:00.000Z'
});
folders.skipped = folder('skipped', {
  captureId: 'skipped', capturer: 'Owner', status: 'skipped',
  receivedAt: '2026-07-25T07:00:00.000Z', processedAt: '2026-07-25T07:01:00.000Z'
});
folders.resend = folder('resend', {
  captureId: 'resend', capturer: 'Owner', status: 'processed',
  receivedAt: '2026-07-25T07:20:00.000Z', processedAt: '2026-07-25T07:10:00.000Z'
});

var inbox = {
  getFolders: function () { return iter(Object.keys(folders).map(function (key) { return folders[key]; })); },
  getFoldersByName: function (name) { return iter(folders[name] ? [folders[name]] : []); }
};
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
  CacheService: { getScriptCache: function () {
    return { get: function (key) { return cache[key] || null; }, put: function (key, value) { cache[key] = value; } };
  } },
  Utilities: {
    newBlob: function (value, mime, name) { return blob(value, name); },
    formatDate: function () { return '20260725-190000'; },
    getUuid: function () { return 'abcd-0000'; }
  }
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), sandbox);

function body(output) { return JSON.parse(output.text); }

var processedCount = folders.processed.files.length;
var processed = body(sandbox.requeue_('owner-token', 'processed'));
assert.strictEqual(processed.alreadyTerminal, true);
assert.strictEqual(processed.status, 'processed');
assert.strictEqual(folders.processed.files.length, processedCount, 'processed receipt must not be rewritten');

var staleCount = folders.stale.files.length;
var stale = body(sandbox.requeue_('owner-token', 'stale'));
assert.strictEqual(stale.alreadyTerminal, true);
assert.strictEqual(stale.status, 'processed');
assert.strictEqual(folders.stale.files.length, staleCount, 'newer processedAt must win over stale received status');

var skipped = body(sandbox.requeue_('owner-token', 'skipped'));
assert.strictEqual(skipped.alreadyTerminal, true);
assert.strictEqual(skipped.status, 'skipped');

var resend = body(sandbox.requeue_('owner-token', 'resend'));
assert.strictEqual(resend.alreadyTerminal, undefined, 'newer receivedAt must remain eligible for processing');
assert.strictEqual(resend.status, 'received');
assert.strictEqual(activeMeta(folders.resend).requeueRequested, true);

var pending = body(sandbox.doPost({ postData: { contents: JSON.stringify({
  action: 'requeue', k: 'owner-token', captureId: 'pending'
}) } }));
assert.strictEqual(pending.ok, true);
assert.strictEqual(pending.status, 'received');
assert.strictEqual(activeMeta(folders.pending).requeueRequested, true);
assert.notStrictEqual(activeMeta(folders.pending).receivedAt, '2026-07-25T07:00:00.000Z');

var listed = body(sandbox.listCaptures_('owner-token', 30, 0));
var listedProcessed = listed.items.filter(function (item) { return item.captureId === 'processed'; })[0];
assert.strictEqual(listedProcessed.receivedAt, '2026-07-25T07:00:00.000Z');
assert.strictEqual(listedProcessed.processedAt, '2026-07-25T07:10:00.000Z');

var html = fs.readFileSync(path.join(__dirname, '..', 'docs', 'legacy.html'), 'utf8');
assert.ok(/&_ts=' \+ Date\.now\(\)/.test(html), 'list request needs a cache-busting nonce');
assert.ok(/fetch\(listUrl, \{ cache: 'no-store' \}\)/.test(html), 'list request needs no-store');
assert.ok(/method: 'POST'.*action: 'requeue'/s.test(html), 'requeue must use POST');
assert.ok(/elapsedMinOf\(it\)/.test(html), 'elapsed time must receive the current item');

var elapsedSource = html.match(/function elapsedMinOf\(item\) \{[\s\S]*?\n\}/);
assert.ok(elapsedSource, 'elapsedMinOf helper must exist');
var FixedDate = class extends Date { static now() { return Date.parse('2026-07-25T10:20:00.000Z'); } };
var uiSandbox = { Date: FixedDate, elapsedMinOf: null };
vm.runInNewContext(elapsedSource[0], uiSandbox);
assert.strictEqual(uiSandbox.elapsedMinOf({
  captureId: '20260725-070000-test',
  capturedAt: '2026-07-25T07:00:00.000Z',
  receivedAt: '2026-07-25T10:10:00.000Z'
}), 10, 'latest receivedAt must reset the displayed queue age');

console.log('PASS status consistency: fresh list, terminal non-regression, receivedAt queue age');
