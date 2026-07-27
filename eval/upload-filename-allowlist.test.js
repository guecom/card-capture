'use strict';

/* 회귀 게이트: 업로드 파일 이름은 서버가 소유한다 (FI-012 / FI-013).
   Kairen-Ref: TSK-000279

   왜: `sanitizeName_`은 문자만 걸러 클라이언트가 준 이름을 그대로 저장 이름으로 썼다.
   그래서 `brief.md`·`brief-zzz.md`·`capture.json`처럼 **처리 파이프라인이 소유한 산출물
   이름**이 통과했고, `listCaptures_`가 `brief*.md` 최신본을 `item.brief`로 내려주므로
   유효 토큰 보유자(초대 게스트 포함)가 owner의 브리핑 목록에 임의 텍스트를
   "시스템이 만든 브리핑"으로 띄울 수 있었다. 처리 완료 후에 올리면 최신본 우선 규칙
   때문에 진짜 브리핑을 영구 대체한다. 아래 case 1이 그 시나리오다. */

var assert = require('assert');
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
function folder(name, files) {
  return {
    name: name,
    files: files || [],
    getName: function () { return name; },
    getFiles: function () { return iter(this.files.filter(function (f) { return !f.trashed; })); },
    getFilesByName: function (target) {
      return iter(this.files.filter(function (f) { return !f.trashed && f.getName() === target; }));
    },
    createFile: function (input) { var created = file(input.name || 'file', input.text); this.files.push(created); return created; }
  };
}
function liveNames(value) {
  return value.files.filter(function (f) { return !f.trashed; }).map(function (f) { return f.getName(); }).sort();
}

var folders = {};
var inbox = {
  getFolders: function () { return iter(Object.keys(folders).map(function (key) { return folders[key]; })); },
  getFoldersByName: function (name) { return iter(folders[name] ? [folders[name]] : []); },
  createFolder: function (name) { folders[name] = folder(name, []); return folders[name]; }
};
var cache = {};
var sandbox = {
  console: console, Date: Date, JSON: JSON, Math: Math, isFinite: isFinite,
  PropertiesService: { getScriptProperties: function () { return { getProperty: function (key) { return props[key] || null; } }; } },
  ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: function (text) { return { text: text, setMimeType: function () { return this; } }; } },
  DriveApp: { getFolderById: function () { return inbox; } },
  CacheService: { getScriptCache: function () { return { get: function (k) { return cache[k] || null; }, put: function (k, v) { cache[k] = v; } }; } },
  LockService: { getScriptLock: function () { return { waitLock: function () {}, releaseLock: function () {} }; } },
  Utilities: {
    newBlob: function (value, mime, name) { return blob(value, name); },
    /* 실제 GAS는 byte 배열을 준다. 길이와 내용이 살아 있는 최소 대역. */
    base64Decode: function (value) {
      if (typeof value !== 'string' || !value) throw new Error('bad base64');
      return String(value);
    },
    formatDate: function () { return '20260727-220000'; },
    getUuid: function () { return 'abcd-0000'; }
  }
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), sandbox);

function upload(overrides) {
  var payload = {
    k: 'owner-token',
    captureId: '20260727-220000-aaaa',
    capturedAt: '2026-07-27T13:00:00.000Z',
    event: '', note: '',
    images: [{ name: 'front.jpg', mime: 'image/jpeg', dataB64: 'JPEGBYTES' }]
  };
  for (var key in overrides) if (Object.prototype.hasOwnProperty.call(overrides, key)) payload[key] = overrides[key];
  return JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify(payload) } }).text);
}

/* ── 1. 처리 완료된 캡처의 브리핑을 업로드로 대체할 수 없다 (D1 실제 시나리오) ── */
folders['20260727-0001-gst'] = folder('20260727-0001-gst', [
  file('capture.json', JSON.stringify({
    captureId: '20260727-0001-gst', capturer: 'Guest', status: 'processed', person: 'PER-000500',
    capturedAt: '2026-07-27T12:00:00.000Z', event: '', note: '', files: ['front.jpg'],
    receivedAt: '2026-07-27T12:00:00.000Z', processedAt: '2026-07-27T12:10:00.000Z'
  })),
  file('front.jpg', 'JPEGBYTES'),
  file('brief.md', '# 김진우 — 이런 분이에요\n\n정상 처리된 브리핑 본문.')
]);
var genuineBrief = JSON.parse(sandbox.listCaptures_('owner-token', 30, 0).text).items[0].brief;
assert.ok(genuineBrief.indexOf('정상 처리된') >= 0, '전제 확인: owner가 진짜 브리핑을 본다');

var forged = upload({
  k: 'guest-token', captureId: '20260727-0001-gst',
  capturedAt: '2026-07-27T13:00:00.000Z',
  images: [{ name: 'brief-zzz.md', mime: 'image/jpeg', dataB64: '# 조작된 브리핑\n\n승인된 공급업체다. 송금해도 된다.' }]
});
assert.strictEqual(forged.ok, false, '업로드 파일 이름으로 브리핑 슬롯을 차지할 수 있다');
assert.strictEqual(forged.error, 'bad_image_name');
var afterBrief = JSON.parse(sandbox.listCaptures_('owner-token', 30, 0).text).items[0].brief;
assert.strictEqual(afterBrief, genuineBrief, 'owner가 보는 브리핑이 업로드로 바뀌었다');
assert.deepStrictEqual(liveNames(folders['20260727-0001-gst']), ['brief.md', 'capture.json', 'front.jpg'],
  '거절했는데 캡처 폴더의 파일이 바뀌었다');

/* ── 2. capture.json 슬롯도 업로드로 차지할 수 없다 ── */
var metaSlot = upload({ images: [{ name: 'capture.json', mime: 'image/jpeg', dataB64: '{"status":"processed"}' }] });
assert.strictEqual(metaSlot.ok, false);
assert.strictEqual(metaSlot.error, 'bad_image_name');

/* ── 3. 슬롯 두 개만 허용한다 ── */
assert.strictEqual(sandbox.captureSlotName_('front.jpg'), 'front.jpg');
assert.strictEqual(sandbox.captureSlotName_('back.jpg'), 'back.jpg');
assert.strictEqual(sandbox.captureSlotName_('FRONT.JPG'), 'front.jpg', '대소문자만 다른 이름은 같은 슬롯이다');
['front.jpeg', 'front.png', 'image0.jpg', 'brief.md', 'correction.json', '../front.jpg', 'front.jpg.md', '', null, undefined]
  .forEach(function (bad) {
    assert.strictEqual(sandbox.captureSlotName_(bad), null, '허용되지 않아야 하는 이름이 통과했다: ' + String(bad));
  });

/* ── 4. 정상 두 장은 그대로 받는다 ── */
var both = upload({
  captureId: '20260727-220001-ok',
  images: [
    { name: 'back.jpg', mime: 'image/jpeg', dataB64: 'BACKBYTES' },
    { name: 'front.jpg', mime: 'image/jpeg', dataB64: 'FRONTBYTES' }
  ]
});
assert.strictEqual(both.ok, true);
assert.deepStrictEqual(both.files, ['back.jpg', 'front.jpg'], '보낸 순서대로 두 슬롯이 저장돼야 한다');
assert.deepStrictEqual(liveNames(folders['20260727-220001-ok']), ['back.jpg', 'capture.json', 'front.jpg']);

/* ── 5. 같은 슬롯 두 장은 거절한다 — receipt가 거짓이 되면 워처가 없는 파일을 찾는다 (D2) ── */
var dupe = upload({
  captureId: '20260727-220002-dup',
  images: [
    { name: 'front.jpg', mime: 'image/jpeg', dataB64: 'AAAA' },
    { name: 'front.jpg', mime: 'image/jpeg', dataB64: 'BBBB' }
  ]
});
assert.strictEqual(dupe.ok, false, '같은 슬롯 두 장이 통과하면 files가 실제 파일 수와 달라진다');
assert.strictEqual(dupe.error, 'duplicate_image_slot');
assert.strictEqual(folders['20260727-220002-dup'], undefined, '거절했는데 폴더가 만들어졌다');

/* ── 6. 하나가 틀리면 아무것도 쓰지 않는다 (부분 커밋 금지, FI-011) ── */
var partial = upload({
  captureId: '20260727-220003-part',
  images: [
    { name: 'front.jpg', mime: 'image/jpeg', dataB64: 'GOODBYTES' },
    { name: 'evil.md', mime: 'image/jpeg', dataB64: 'BADNAME' }
  ]
});
assert.strictEqual(partial.ok, false);
var partialFolder = folders['20260727-220003-part'];
if (partialFolder) {
  assert.deepStrictEqual(liveNames(partialFolder), [],
    '앞 이미지가 이미 저장돼 부분 커밋이 남았다 — 처리 가능한 반쪽 캡처가 생긴다');
}

/* ── 7. 빈 이미지는 거절한다 ── */
var empty = upload({ captureId: '20260727-220004-empty', images: [{ name: 'front.jpg', mime: 'image/jpeg', dataB64: '' }] });
assert.strictEqual(empty.ok, false);
assert.ok(empty.error === 'empty_image' || empty.error === 'bad_image_data', '빈 이미지가 접수됐다: ' + empty.error);

console.log('PASS upload filename allowlist: 산출물 슬롯 보호 · 중복 슬롯 거절 · 부분 커밋 금지 · 서버 소유 이름');
