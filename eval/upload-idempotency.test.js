'use strict';

/* 회귀 게이트: 업로드가 서버에서도 멱등이고, 이미 끝난 처리를 조용히 되돌리지 않는다.
   Kairen-Ref: TSK-000275 (FI-009 / FI-010 / FI-015)

   FI-016(클라이언트가 재전송하지 않게)은 v2.3.0에서 닫혔지만, 그것은 클라이언트 한 종류의
   방어다. 서버 자체는 여전히 같은 captureId 폴더의 capture.json을 status:'received'로
   덮어썼다 — 구버전 앱, 다른 클라이언트, 수동 재요청 어느 경로로든 이미 processed인
   캡처가 처음부터 다시 처리될 수 있었다. 이 게이트는 서버 쪽 계약을 고정한다. */

var assert = require('assert');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var props = {
  TOKENS: JSON.stringify({ 'owner-token': 'Owner', 'guest-token': 'Guest' }),
  OWNER_NAMES: 'Owner',
  INBOX_FOLDER_ID: 'synthetic-inbox',
  DAILY_LIMIT: '100'
};
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
  return {
    name: name,
    files: meta ? [file('capture.json', JSON.stringify(meta))] : [],
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
}
function activeMeta(value) {
  var files = value.files.filter(function (f) { return !f.trashed && f.getName() === 'capture.json'; });
  if (!files.length) return null;
  return JSON.parse(files[files.length - 1].getBlob().getDataAsString());
}
function liveNames(value) {
  return value.files.filter(function (f) { return !f.trashed; }).map(function (f) { return f.getName(); }).sort();
}

var folders = {};
var inbox = {
  getFolders: function () { return iter(Object.keys(folders).map(function (key) { return folders[key]; })); },
  getFoldersByName: function (name) { return iter(folders[name] ? [folders[name]] : []); },
  createFolder: function (name) { folders[name] = folder(name, null); return folders[name]; }
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
  CacheService: { getScriptCache: function () {
    return { get: function (key) { return cache[key] || null; }, put: function (key, value) { cache[key] = value; } };
  } },
  LockService: { getScriptLock: function () { return { waitLock: function () {}, releaseLock: function () {} }; } },
  Utilities: {
    newBlob: function (value, mime, name) { return blob(value, name); },
    DigestAlgorithm: { SHA_256: 'sha256' },
    Charset: { UTF_8: 'utf8' },
    computeDigest: function (_algorithm, value) {
      return Array.prototype.slice.call(crypto.createHash('sha256').update(String(value), 'utf8').digest())
        .map(function (byte) { return byte > 127 ? byte - 256 : byte; });
    },
    base64Decode: function (value) {
      if (typeof value !== 'string' || !value) throw new Error('bad base64');
      return { length: value.length };
    },
    formatDate: function () { return '20260727-210000'; },
    getUuid: function () { return 'abcd-0000'; }
  }
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), sandbox);

function upload(overrides) {
  var payload = {
    k: 'owner-token',
    captureId: '20260727-210000-aaaa',
    capturedAt: '2026-07-27T12:00:00.000Z',
    event: '전시회 부스',
    note: '메모: 구매팀장',
    images: [{ name: 'front.jpg', mime: 'image/jpeg', dataB64: 'AAAABBBBCCCC' }]
  };
  for (var key in overrides) if (Object.prototype.hasOwnProperty.call(overrides, key)) payload[key] = overrides[key];
  return JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify(payload) } }).text);
}

/* ── 1. 첫 업로드는 정상 접수된다 ── */
var first = upload({});
assert.strictEqual(first.ok, true, '첫 업로드가 접수되지 않았다');
assert.deepStrictEqual(first.files, ['front.jpg']);
var stored = activeMeta(folders['20260727-210000-aaaa']);
assert.strictEqual(stored.status, 'received');
assert.ok(stored.uploadFingerprint, '내용 지문이 저장되지 않으면 멱등 판정이 불가능하다');

/* ── 2. 같은 내용 재전송은 멱등이다 — 파일도 메타도 다시 쓰지 않는다 ── */
var target = folders['20260727-210000-aaaa'];
var beforeCount = target.files.length;
var repeat = upload({});
assert.strictEqual(repeat.ok, true);
assert.strictEqual(repeat.deduped, true, '같은 내용 재전송이 멱등으로 처리되지 않았다');
assert.strictEqual(target.files.length, beforeCount, '멱등 재전송이 파일을 다시 썼다');

/* ── 3. 이미 처리가 끝난 캡처에 같은 내용이 다시 와도 상태가 되돌아가지 않는다 (FI-015 핵심) ── */
folders.done = folder('done', {
  captureId: 'done', capturer: 'Owner', status: 'processed', person: 'PER-000123',
  receivedAt: '2026-07-27T12:00:00.000Z', processedAt: '2026-07-27T12:20:00.000Z',
  files: ['front.jpg'],
  uploadFingerprint: sandbox.uploadFingerprint_(
    { capturedAt: '2026-07-27T12:00:00.000Z', event: '전시회 부스', note: '메모: 구매팀장' },
    [{ name: 'front.jpg', dataB64: 'AAAABBBBCCCC' }]
  )
});
var doneBefore = target.files.length;
var replay = upload({ captureId: 'done' });
assert.strictEqual(replay.ok, true);
assert.strictEqual(replay.deduped, true);
assert.strictEqual(replay.status, 'processed', '재전송 응답이 이미 끝난 상태를 그대로 알려야 한다');
assert.strictEqual(replay.processedAt, '2026-07-27T12:20:00.000Z');
var doneMeta = activeMeta(folders.done);
assert.strictEqual(doneMeta.status, 'processed', 'processed → received 되돌림이 일어났다');
assert.strictEqual(doneMeta.person, 'PER-000123', '재전송이 처리 결과를 지웠다');
assert.strictEqual(doneBefore, target.files.length);

/* ── 4. 내용이 실제로 달라진 재업로드는 받아들이되, 조용한 되돌림으로 남기지 않는다 ── */
var edited = upload({ captureId: 'done', note: '메모: 직함이 CPO였다' });
assert.strictEqual(edited.ok, true);
assert.notStrictEqual(edited.deduped, true, '내용이 달라졌는데 멱등으로 무시했다');
var editedMeta = activeMeta(folders.done);
assert.strictEqual(editedMeta.status, 'received', '수정된 내용은 다시 처리돼야 한다');
assert.strictEqual(editedMeta.requeueRequested, true, '되돌림에 명시적 표식이 없다');
assert.strictEqual(editedMeta.previousStatus, 'processed', '이전 상태를 잃어버렸다');
assert.strictEqual(editedMeta.previousProcessedAt, '2026-07-27T12:20:00.000Z');
assert.strictEqual(editedMeta.previousPerson, 'PER-000123', '이전 처리 결과의 연결을 잃어버렸다');

/* ── 5. 남의 captureId에는 덮어쓸 수 없고, 아무것도 바뀌지 않는다 (FI-009) ── */
folders.someone = folder('someone', {
  captureId: 'someone', capturer: 'Owner', status: 'processed', person: 'PER-000999',
  receivedAt: '2026-07-27T12:00:00.000Z', processedAt: '2026-07-27T12:05:00.000Z', files: ['front.jpg']
});
var foreignBefore = JSON.stringify(activeMeta(folders.someone));
var foreignFiles = liveNames(folders.someone);
var foreign = upload({ k: 'guest-token', captureId: 'someone', note: '메모: 가로채기' });
assert.strictEqual(foreign.ok, false, 'guest가 남의 캡처에 덮어썼다');
assert.strictEqual(foreign.error, 'capture_conflict');
assert.strictEqual(JSON.stringify(activeMeta(folders.someone)), foreignBefore, '거절했는데 메타가 바뀌었다');
assert.deepStrictEqual(liveNames(folders.someone), foreignFiles, '거절했는데 파일이 바뀌었다');

/* ── 6. owner는 초대 촬영자의 캡처를 갱신할 수 있다 (기존 scope 유지) ── */
folders.guestcap = folder('guestcap', {
  captureId: 'guestcap', capturer: 'Guest', status: 'received',
  receivedAt: '2026-07-27T12:00:00.000Z', files: ['front.jpg']
});
var byOwner = upload({ captureId: 'guestcap', note: '메모: owner 보정' });
assert.strictEqual(byOwner.ok, true, 'owner가 초대 촬영자 캡처를 갱신할 수 없게 됐다');

/* ── 7. 지문은 내용이 같으면 같고, 한 글자라도 다르면 달라야 한다 ── */
var base = { capturedAt: 'T', event: 'E', note: 'N' };
var one = [{ name: 'front.jpg', dataB64: 'abcd' }];
assert.strictEqual(sandbox.uploadFingerprint_(base, one), sandbox.uploadFingerprint_(base, one));
assert.notStrictEqual(
  sandbox.uploadFingerprint_(base, one),
  sandbox.uploadFingerprint_({ capturedAt: 'T', event: 'E', note: 'N2' }, one)
);
assert.notStrictEqual(
  sandbox.uploadFingerprint_(base, one),
  sandbox.uploadFingerprint_(base, [{ name: 'front.jpg', dataB64: 'abcde' }])
);
/* 앞·뒷면 순서가 바뀌어도 같은 촬영이다. */
assert.strictEqual(
  sandbox.uploadFingerprint_(base, [{ name: 'front.jpg', dataB64: 'ab' }, { name: 'back.jpg', dataB64: 'cd' }]),
  sandbox.uploadFingerprint_(base, [{ name: 'back.jpg', dataB64: 'cd' }, { name: 'front.jpg', dataB64: 'ab' }])
);

/* ── 8. 지문 도입 이전에 접수된 캡처도 blind 재전송에서 보호된다 ──
   배포 시점의 운영 캡처는 전부 지문이 없다. 이 경로가 없으면 첫날부터 보호가 없다. */
folders.legacy = folder('legacy', {
  captureId: 'legacy', capturer: 'Owner', status: 'processed', person: 'PER-000777',
  capturedAt: '2026-07-27T12:00:00.000Z', event: '전시회 부스', note: '메모: 구매팀장',
  receivedAt: '2026-07-27T12:00:00.000Z', processedAt: '2026-07-27T12:30:00.000Z', files: ['front.jpg']
});
var legacyReplay = upload({ captureId: 'legacy' });
assert.strictEqual(legacyReplay.ok, true);
assert.strictEqual(legacyReplay.deduped, true, '지문 없는 예전 캡처의 blind 재전송이 멱등 처리되지 않았다');
var legacyMeta = activeMeta(folders.legacy);
assert.strictEqual(legacyMeta.status, 'processed', '예전 캡처에서 processed → received 되돌림이 일어났다');
assert.strictEqual(legacyMeta.person, 'PER-000777', '예전 캡처의 처리 결과가 지워졌다');
assert.strictEqual(legacyMeta.processedAt, '2026-07-27T12:30:00.000Z');

/* ── 9. 예전 캡처라도 내용이 달라지면 받아들이고 되돌림 표식을 남긴다 ── */
var legacyEdit = upload({ captureId: 'legacy', note: '메모: 부서가 달랐다' });
assert.strictEqual(legacyEdit.ok, true);
assert.notStrictEqual(legacyEdit.deduped, true);
var legacyEditMeta = activeMeta(folders.legacy);
assert.strictEqual(legacyEditMeta.status, 'received');
assert.strictEqual(legacyEditMeta.requeueRequested, true, '되돌림에 명시적 표식이 없다');
assert.strictEqual(legacyEditMeta.previousPerson, 'PER-000777');
assert.ok(legacyEditMeta.uploadFingerprint, '이후 재전송을 지문으로 판정할 수 있어야 한다');

/* ── 10. 파일 목록이 다르면(뒷면 추가) 같은 업로드가 아니다 ── */
folders.oneside = folder('oneside', {
  captureId: 'oneside', capturer: 'Owner', status: 'processed',
  capturedAt: '2026-07-27T12:00:00.000Z', event: '', note: '',
  receivedAt: '2026-07-27T12:00:00.000Z', processedAt: '2026-07-27T12:10:00.000Z', files: ['front.jpg']
});
var addedBack = upload({
  captureId: 'oneside', event: '', note: '',
  images: [{ name: 'front.jpg', mime: 'image/jpeg', dataB64: 'AAAA' }, { name: 'back.jpg', mime: 'image/jpeg', dataB64: 'BBBB' }]
});
assert.notStrictEqual(addedBack.deduped, true, '뒷면을 추가했는데 멱등으로 무시했다');
assert.deepStrictEqual(addedBack.files, ['front.jpg', 'back.jpg']);

console.log('PASS upload idempotency: dedup(신규·예전 캡처), terminal non-regression, cross-owner denial, fingerprint');
