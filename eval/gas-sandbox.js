'use strict';

/* Code.gs를 결정적 합성 환경에서 실행하는 공용 하네스.
   Kairen-Ref: TSK-000277 (FI-022 골든 캡처 / FI-023 부정 corpus)

   왜 별도 파일인가: golden-capture.test.js와 adversarial-capture.test.js는 같은
   Drive·Cache·Mail 스텁을 쓰고, **케이스마다 완전히 새 서버 상태**를 만들어야 한다.
   기존 테스트(status-consistency, upload-idempotency)는 파일 하나 안에서 전역 상태를
   공유하는데, 부정 corpus는 "이 케이스에서 폴더가 하나도 안 생겼는가"처럼 상태 격리가
   판정 자체인 assertion이 많아 그 방식으로는 채점이 불가능하다.

   원칙:
   - 합성 데이터만. 토큰·폴더 ID·메일 주소는 모두 명백한 가상값이다.
   - 실제 Drive·GAS·메일을 호출하지 않는다. 스텁이 없으면 PASS가 아니라 예외로 끝난다.
   - 시계는 고정이다. receivedAt/processedAt이 실행 시각에 따라 흔들리면 golden이 성립하지 않는다.
   - 스텁은 Drive의 불편한 사실을 흉내낸다: 같은 이름 파일·폴더 중복 허용, getLastUpdated
     순서가 진실 판정에 쓰임, 삭제는 trash 표시. 이 부분을 편하게 만들면 게이트가 거짓이 된다. */

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var SERVER_SOURCE = path.join(__dirname, '..', 'Code.gs');
var BINARY_TEXT = '<synthetic-image-bytes>';
var FILE_EPOCH = Date.parse('2026-01-01T00:00:00.000Z');

function iter(values) {
  var index = 0;
  return {
    hasNext: function () { return index < values.length; },
    next: function () { return values[index++]; }
  };
}

/* Utilities.base64Decode 대용. 실제 GAS는 잘못된 base64에서 예외를 던진다 —
   그 예외가 서버의 fail-closed 경로(bad_image_data)를 여는 유일한 트리거라 흉내내야 한다.

   반환값은 GAS `Byte[]` 대역이다. 지켜야 하는 성질 세 가지:

   1. **부호 있는 바이트.** Java byte는 -128..127이라 0xFF는 -1로 온다. 부호 없는 값을 주면
      `bytes[0] === 0xFF` 같은 잘못된 검사가 하네스에서만 통과하고 실제 GAS에서 조용히
      깨진다. magic-byte 검사는 반드시 `bytes[0] & 0xFF` 꼴로 써야 하며, 그 규율을 이
      대역이 강제한다.
   2. **인덱스와 length만 있다.** `slice`·`map` 같은 Array.prototype 메서드는 GAS 런타임에
      따라 있을 수도 없을 수도 있으므로 여기서 주지 않는다. 그 위에 기대는 서버 패치는
      하네스에서 먼저 터진다(운영에서 터지는 것보다 낫다).
   3. **b64를 들고 다닌다.** Drive는 올라온 바이트를 그대로 보관하고 getDataAsString으로
      다시 읽을 수 있다. 바이트를 불투명하게 두면 "업로드된 내용이 어떤 파일 슬롯으로
      읽히는가"를 검사할 수 없다.

   바이트 실체화는 지연시킨다 — 8MB 초과 케이스는 길이만 보고 거절되므로 그 경로에서
   버퍼를 만들면 게이트가 느려진다. */
function decodeBase64(value) {
  if (typeof value !== 'string' || !value) throw new Error('Invalid argument: empty base64');
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('Invalid argument: not base64');
  }
  var pad = 0;
  if (value.charAt(value.length - 1) === '=') pad = value.charAt(value.length - 2) === '=' ? 2 : 1;
  var byteLength = (value.length / 4) * 3 - pad;
  var buf = null;
  function signedByteAt(index) {
    if (index < 0 || index >= byteLength) return undefined;
    if (buf === null) buf = Buffer.from(value, 'base64');
    return (buf[index] << 24) >> 24;
  }
  return new Proxy({ length: byteLength, b64: value }, {
    get: function (target, prop) {
      if (typeof prop === 'string' && /^(?:0|[1-9][0-9]*)$/.test(prop)) return signedByteAt(Number(prop));
      return target[prop];
    },
    has: function (target, prop) {
      if (typeof prop === 'string' && /^(?:0|[1-9][0-9]*)$/.test(prop)) return Number(prop) < byteLength;
      return prop in target;
    }
  });
}

function createServer(options) {
  var opts = options || {};
  var state = {
    nowMs: Date.parse(opts.now || '2026-07-27T09:00:00.000Z'),
    fileSeq: 0,
    uuidSeq: 0
  };
  var props = {
    TOKENS: JSON.stringify(opts.tokens || {
      'owner-token': 'Owner', 'guest-token': 'Guest', 'guest2-token': 'Guest2'
    }),
    OWNER_NAMES: Object.prototype.hasOwnProperty.call(opts, 'ownerNames') ? opts.ownerNames : 'Owner',
    INBOX_FOLDER_ID: 'synthetic-inbox',
    DAILY_LIMIT: String(opts.dailyLimit || 100),
    RESEARCH_INSTRUCTION_ENABLED: opts.researchEnabled === false ? 'false' : 'true'
  };
  var cache = {};
  var mails = [];
  var folders = [];

  function makeBlob(value, mime, name) {
    var isText = typeof value === 'string';
    return {
      name: name || '',
      mime: mime || '',
      isText: isText,
      length: isText ? Buffer.byteLength(value, 'utf8') : ((value && value.length) || 0),
      getName: function () { return name || ''; },
      getDataAsString: function () {
        if (isText) return value;
        if (value && typeof value.b64 === 'string') return Buffer.from(value.b64, 'base64').toString('utf8');
        return BINARY_TEXT;
      }
    };
  }

  function makeFile(name, blobValue) {
    var mtime = ++state.fileSeq;
    return {
      trashed: false,
      getName: function () { return name; },
      getLastUpdated: function () { return new Date(FILE_EPOCH + mtime * 1000); },
      getBlob: function () { return blobValue; },
      setTrashed: function (value) { this.trashed = value !== false; },
      /* 테스트가 Drive 동기화 중복본의 '더 오래된 쪽'을 만들 때만 쓴다. */
      setMtime: function (value) { mtime = value; }
    };
  }

  function makeFolder(name) {
    return {
      getName: function () { return name; },
      getId: function () { return 'synthetic-folder-' + name; },
      files: [],
      live: function () { return this.files.filter(function (f) { return !f.trashed; }); },
      getFiles: function () { return iter(this.live()); },
      getFilesByName: function (target) {
        return iter(this.live().filter(function (f) { return f.getName() === target; }));
      },
      createFile: function (blobValue) {
        var created = makeFile(blobValue && blobValue.getName ? blobValue.getName() : 'file', blobValue);
        this.files.push(created);
        return created;
      },
      /* vault 상위 폴더는 이 하네스 범위 밖이다. personDoc_ 같은 경로는 여기서
         'vault_walk_failed'로 끝나야 하며, 가짜 트리를 만들어 PASS를 내지 않는다. */
      getParents: function () { return iter([]); }
    };
  }

  var inbox = {
    getName: function () { return 'BusinessCards'; },
    getId: function () { return 'synthetic-inbox'; },
    /* Drive는 동명 폴더를 허용한다 — 배열로 보관하고 이름 조회는 전부 돌려준다. */
    getFolders: function () { return iter(folders.slice()); },
    getFoldersByName: function (name) {
      return iter(folders.filter(function (f) { return f.getName() === name; }));
    },
    createFolder: function (name) {
      var created = makeFolder(name);
      folders.push(created);
      return created;
    },
    getParents: function () { return iter([]); }
  };

  function FixedDate() {
    if (arguments.length === 0) return new Date(state.nowMs);
    if (arguments.length === 1) return new Date(arguments[0]);
    return new Date(arguments[0], arguments[1], arguments[2] || 1,
      arguments[3] || 0, arguments[4] || 0, arguments[5] || 0, arguments[6] || 0);
  }
  FixedDate.now = function () { return state.nowMs; };
  FixedDate.parse = Date.parse;
  FixedDate.UTC = Date.UTC;
  FixedDate.prototype = Date.prototype;

  var sandbox = {
    console: console,
    Date: FixedDate,
    JSON: JSON,
    Math: Math,
    isFinite: isFinite,
    PropertiesService: {
      getScriptProperties: function () {
        return { getProperty: function (key) { return Object.prototype.hasOwnProperty.call(props, key) ? props[key] : null; } };
      }
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: function (text) { return { text: text, setMimeType: function () { return this; } }; }
    },
    DriveApp: {
      getFolderById: function (id) {
        if (id !== props.INBOX_FOLDER_ID) throw new Error('unexpected folder id: ' + id);
        return inbox;
      },
      getFileById: function () { throw new Error('no such file'); }
    },
    CacheService: {
      getScriptCache: function () {
        return {
          get: function (key) { return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : null; },
          put: function (key, value) { cache[key] = String(value); }
        };
      }
    },
    LockService: {
      getScriptLock: function () { return { waitLock: function () {}, releaseLock: function () {} }; }
    },
    Utilities: {
      newBlob: function (value, mime, name) { return makeBlob(value, mime, name); },
      base64Decode: decodeBase64,
      formatDate: function (date, tz, fmt) {
        var ms = (date && typeof date.getTime === 'function') ? date.getTime() : state.nowMs;
        var seoul = new Date(ms + 9 * 60 * 60 * 1000).toISOString();
        var ymd = seoul.slice(0, 10).replace(/-/g, '');
        if (fmt === 'yyyyMMdd') return ymd;
        return ymd + '-' + seoul.slice(11, 19).replace(/:/g, '');
      },
      getUuid: function () { return 'u' + (++state.uuidSeq) + 'ab-cdef-0000'; }
    },
    /* 실제 발송은 없다. 배열에 쌓인 것이 '외부 효과가 일어났다'는 증거다. */
    Session: {
      getEffectiveUser: function () { return { getEmail: function () { return opts.ownerEmail || 'synthetic-owner@example.invalid'; } }; }
    },
    MailApp: { sendEmail: function (message) { mails.push(message); } }
  };

  vm.createContext(sandbox);
  /* opts.source: Code.gs 대신 실행할 원본 문자열. 회귀 주입(게이트가 형식적이지 않음을
     증명하려고 서버를 일부러 깨는 것)과 아직 배포되지 않은 제안 패치의 예행에만 쓴다.
     디스크의 Code.gs는 절대 건드리지 않는다 — 기본값은 예전과 같다. */
  vm.runInContext(typeof opts.source === 'string' ? opts.source : fs.readFileSync(SERVER_SOURCE, 'utf8'),
    sandbox, { filename: 'Code.gs' });

  var api = {
    sandbox: sandbox,
    props: props,
    cache: cache,
    mails: mails,
    inbox: inbox,

    setNow: function (iso) {
      var ms = Date.parse(iso);
      if (!isFinite(ms)) throw new Error('잘못된 시각: ' + iso);
      state.nowMs = ms;
    },
    nowIso: function () { return new Date(state.nowMs).toISOString(); },

    post: function (payload) {
      return JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify(payload) } }).text);
    },
    postRaw: function (text) {
      return JSON.parse(sandbox.doPost({ postData: { contents: text } }).text);
    },
    get: function (params) {
      return JSON.parse(sandbox.doGet({ parameter: params }).text);
    },

    folderNames: function () { return folders.map(function (f) { return f.getName(); }); },
    folderCount: function () { return folders.length; },
    folder: function (name) {
      var hit = folders.filter(function (f) { return f.getName() === name; });
      return hit.length ? hit[0] : null;
    },
    /* 서버 자신의 판정으로 읽는다. 하네스가 별도 규칙으로 읽으면 서버 버그를 가린다. */
    receipt: function (name) {
      var folder = api.folder(name);
      return folder ? sandbox.readJsonFile_(folder) : null;
    },
    fileNames: function (name) {
      var folder = api.folder(name);
      if (!folder) return [];
      return folder.live().map(function (f) { return f.getName(); }).sort();
    },
    rawText: function (name, fileName) {
      var folder = api.folder(name);
      if (!folder) return null;
      var hit = folder.live().filter(function (f) { return f.getName() === fileName; });
      return hit.length ? hit[hit.length - 1].getBlob().getDataAsString() : null;
    },
    /* 폴더 전체의 바이트 스냅샷 — "거절했는데 아무것도 안 바뀌었나"를 판정한다. */
    snapshot: function (name) {
      var folder = api.folder(name);
      if (!folder) return null;
      return JSON.stringify(folder.live().map(function (f) {
        return [f.getName(), f.getBlob().getDataAsString()];
      }));
    },

    seedCapture: function (name, meta) {
      var folder = api.folder(name) || inbox.createFolder(name);
      folder.createFile(makeBlob(JSON.stringify(meta, null, 2), 'application/json', 'capture.json'));
      return folder;
    },
    addFile: function (folderName, fileName, text, mtime) {
      var folder = api.folder(folderName) || inbox.createFolder(folderName);
      var created = folder.createFile(makeBlob(text, 'text/plain', fileName));
      if (typeof mtime === 'number') created.setMtime(mtime);
      return created;
    },
    /* 처리 세션(워처/Codex)이 마감 receipt를 쓰는 것과 같은 경로를 쓴다. */
    writeReceipt: function (folderName, meta) {
      var folder = api.folder(folderName);
      if (!folder) throw new Error('폴더 없음: ' + folderName);
      sandbox.upsertFile_(folder, 'capture.json',
        makeBlob(JSON.stringify(meta, null, 2), 'application/json', 'capture.json'));
    },
    writeBrief: function (folderName, text) {
      var folder = api.folder(folderName);
      if (!folder) throw new Error('폴더 없음: ' + folderName);
      sandbox.upsertFile_(folder, 'brief.md', makeBlob(text, 'text/markdown', 'brief.md'));
    }
  };
  return api;
}

/* 디스크의 Code.gs 원본. 테스트가 이것을 변형해 createServer({source: ...})로 넣는다. */
function serverSource() {
  return fs.readFileSync(SERVER_SOURCE, 'utf8');
}

module.exports = {
  createServer: createServer,
  serverSource: serverSource,
  BINARY_TEXT: BINARY_TEXT
};
