'use strict';

/* Code.gs를 결정적 합성 환경에서 실행하는 공용 하네스.
   Kairen-Ref: TSK-000277 (FI-022 골든 캡처 / FI-023 부정 corpus), TSK-000293 (Drive 계층)

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
     순서가 진실 판정에 쓰임, 삭제는 trash 표시. 이 부분을 편하게 만들면 게이트가 거짓이 된다.

   ══════════════════════════════════════════════════════════════════════════
   ██  Drive 계층 충실도 계약 (TSK-000293)                                  ██
   ══════════════════════════════════════════════════════════════════════════
   `personDoc_`·`personDocById_`·`searchPersons_`의 owner 성공 경로를 태우려면 vault
   상위 폴더·`searchFiles`·파일 ID·`getParents`가 필요하다. 그것을 여기서 모사한다.
   **모사가 실제 Drive와 다른 지점을 아래에 전부 적는다.** 이 목록이 없으면 그 위에서
   도는 게이트는 PASS를 만들어내는 장치일 뿐이다.

   ── 충실하게 모사하는 것 ──────────────────────────────────────────────────
   1. `Folder.searchFiles`는 **직속 자식만** 본다. 하위 폴더로 재귀하지 않는다
      (실제 Apps Script도 "files that are children of the current folder").
   2. `title contains`는 **부분 문자열 검색이 아니다.** Drive 문서는 name에 대해
      prefix 매칭이라고 못박는다("HelloWorld"는 `contains 'Hello'`에 걸리고
      `contains 'World'`에는 걸리지 않는다). 그래서 기본값은 접두사 매칭이다.
   3. Drive 쿼리 문자열 리터럴은 작은따옴표로 감싸고 백슬래시가 이스케이프 문자다.
      `\'`는 이스케이프된 따옴표이므로 **끝의 백슬래시는 종료 따옴표를 먹어치우고**
      리터럴이 닫히지 않는다. 그때 이 스텁은 PASS가 아니라 예외로 끝난다.
   4. `contains`는 대소문자를 구분하지 않는다.
   5. `fullText`의 검색 대상에는 본문뿐 아니라 **파일 이름도 포함된다.** 그래서 title로
      이미 걸린 문서가 fullText에도 걸리고, 서버의 dedup(`seen`)이 실제로 일한다.
   6. `getFiles`·`getFilesByName`·`searchFiles`는 trash된 파일을 돌려주지 않는다.
   7. `DriveApp.getFileById`는 없는 ID에서 예외를 던진다(Apps Script와 동일).
   8. 폴더 ID는 **전역 유일**하다. 이름이 같은 폴더 둘은 서로 다른 ID를 가진다 —
      `personDocById_`의 "Person 폴더 직속인가" 판정이 ID 비교이므로 여기서 이름을
      ID로 쓰면 그 판정이 통째로 거짓이 된다.
   9. 파일 ID는 `personDocById_`의 `/^[A-Za-z0-9_-]{10,80}$/`를 만족하는 형태다.

   ── 모사하지 않는 것 / 실제와 다른 것 (여기가 UNPROVEN의 경계다) ───────────
   A. **전문 색인의 비동기성.** 실제 Drive는 파일을 쓴 뒤 fullText 색인이 반영되기까지
      지연이 있고, 색인되지 않는 형식도 있다. 이 스텁은 항상 즉시·정확히 찾는다.
      → "via=content 결과가 운영에서도 나온다"는 이 하네스로 증명되지 않는다.
   B. **Drive가 .md(text/markdown) 본문을 색인하는지 자체가 미확인이다.** 색인하지
      않으면 `searchPersons_`의 두 번째 질의는 운영에서 영원히 빈 결과다.
   C. **토큰화 규칙.** `title contains`가 파일명 전체 접두사인지, 공백 토큰 단위
      접두사인지 문서만으로는 확정할 수 없다. 그래서 세 모델을 선택 가능하게 두었다
      (`titleMatch`: name-prefix ⊆ token-prefix ⊆ substring). 어느 것이 진실인지는
      live Drive 관찰이 있어야 정해진다. 게이트는 세 모델 전부에서 같은 결과가 나오는
      성질만 단언해야 한다.
      같은 이유로 `fullTextMatch`는 token ⊆ substring 두 모델을 둔다.
   D. **빈 리터럴(`title contains ''`) 동작 미확인.** 여기서는 "아무것도 매칭하지
      않음"으로 두었지만 실제 Drive가 오류인지 전체 매칭인지 확인하지 않았다.
   E. **닫히지 않은 리터럴의 정확한 예외 형태**와, 그때 GAS 웹앱이 클라이언트에
      무엇을 돌려주는지(HTML 오류 페이지로 추정)는 모사하지 않는다. 여기서는 그냥
      `Error('Invalid query ...')`로 끝난다 — 판정할 수 있는 것은 "JSON 응답이 아니라
      예외로 끝난다"까지다.
   F. **결과 순서.** Drive는 정렬을 보장하지 않는다. 이 스텁은 생성 순서로 돌려준다.
      → "10건 중 어느 10건인가", "동명 매칭 중 어느 것이 먼저인가"는 단언 금지다.
   G. **권한·공유·shortcut·복수 부모.** 모사하지 않는다. `getParents()`는 부모 0 또는 1개다.
   H. **trash된 파일의 `getFileById`.** 이 스텁은 trash 여부와 무관하게 ID로 돌려준다.
      실제 Drive 동작과 일치하는지 확인하지 않았다.
   I. **inbox 폴더 직속 파일.** 캡처 폴더만 담는 것으로 두었다. inbox에 직접 놓인
      파일은 모사하지 않는다.
   J. 폴더·파일 ID 문자열이 실제 Drive ID처럼 불투명하지 않고 사람이 읽을 수 있다.
   ══════════════════════════════════════════════════════════════════════════ */

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var crypto = require('crypto');

var SERVER_SOURCE = path.join(__dirname, '..', 'Code.gs');
var BINARY_TEXT = '<synthetic-image-bytes>';
var FILE_EPOCH = Date.parse('2026-01-01T00:00:00.000Z');

var TITLE_MATCH_MODES = ['name-prefix', 'token-prefix', 'substring'];
var FULLTEXT_MATCH_MODES = ['token', 'substring'];

/* vault Person 경로. Code.gs의 `personFolder_`가 걷는 그 경로다. */
var VAULT_ROOT_NAME = 'Kairen';
var VAULT_INBOX_PARENT = '00_Inbox';
var PERSON_PATH = ['02_Kairen_OS', '30_Instance', 'Person'];

function iter(values) {
  var index = 0;
  return {
    hasNext: function () { return index < values.length; },
    next: function () { return values[index++]; }
  };
}

/* Drive 쿼리 파서 — Code.gs가 실제로 만들어 내는 두 형태만 받는다.

   왜 정규식 한 방이 아니라 파서인가: 이 lane이 판정해야 하는 것이 **백슬래시가
   리터럴을 닫히지 않게 만드는가**이기 때문이다. 이스케이프를 해석하지 않는 스텁은
   그 질문에 답할 수 없고, "문자열을 그대로 넘겼더니 잘 돌더라"는 가짜 PASS만 만든다.

   해석하지 못하는 형태는 조용히 통과시키지 않고 예외로 끝낸다 — Code.gs가 나중에
   다른 질의를 만들기 시작하면 하네스가 먼저 터져야 한다. */
function parseDriveQuery(query) {
  var text = String(query);
  var head = /^\s*(title|fullText)\s+contains\s+/.exec(text);
  if (!head) throw new Error('Invalid query (이 스텁이 모사하지 않는 형태): ' + text);
  var i = head[0].length;
  if (text.charAt(i) !== "'") {
    throw new Error("Invalid query (문자열 리터럴이 ' 로 시작하지 않는다): " + text);
  }
  i++;
  var value = '';
  var closed = false;
  var undocumentedEscapes = [];
  while (i < text.length) {
    var ch = text.charAt(i);
    if (ch === '\\') {
      if (i + 1 >= text.length) { i += 1; break; } /* 끝의 홀수 백슬래시 — 닫는 따옴표가 없다 */
      var next = text.charAt(i + 1);
      /* Drive가 문서화한 이스케이프는 \' 와 \\ 뿐이다. 그 밖은 동작 미확인이므로
         기록해 두고 여기서는 문자 그대로 취급한다(모사 한계 C·D와 같은 성격). */
      if (next !== "'" && next !== '\\') undocumentedEscapes.push(next);
      value += next;
      i += 2;
      continue;
    }
    if (ch === "'") { closed = true; i++; break; }
    value += ch;
    i++;
  }
  if (!closed) {
    throw new Error('Invalid query (닫히지 않은 문자열 리터럴 — 끝의 백슬래시가 종료 ' +
      "따옴표를 이스케이프했다): " + text);
  }
  if (text.slice(i).trim() !== '') {
    throw new Error('Invalid query (리터럴 뒤에 이 스텁이 모사하지 않는 토큰): ' + text);
  }
  return { field: head[1], value: value, undocumentedEscapes: undocumentedEscapes };
}

function tokensOf(text) {
  return String(text).split(/\s+/).filter(function (t) { return t.length > 0; });
}

/* `contains` 판정. 모드는 실제 Drive 의미의 **불확실성 괄호**다 — 충실도 계약 C 참고. */
function driveContains(parsed, file, modes) {
  var needle = String(parsed.value).toLowerCase();
  if (!needle) return false; /* 충실도 계약 D: 빈 리터럴은 동작 미확인 → 매칭 없음으로 둔다 */
  var name = String(file.getName());
  if (parsed.field === 'title') {
    var lowerName = name.toLowerCase();
    if (modes.title === 'substring') return lowerName.indexOf(needle) >= 0;
    if (modes.title === 'token-prefix') {
      if (lowerName.indexOf(needle) === 0) return true;
      return tokensOf(lowerName).some(function (t) { return t.indexOf(needle) === 0; });
    }
    return lowerName.indexOf(needle) === 0; /* name-prefix */
  }
  /* fullText: 본문 + 파일 이름 (충실도 계약 5) */
  var hay = (name + '\n' + file.getBlob().getDataAsString()).toLowerCase();
  if (modes.fullText === 'substring') return hay.indexOf(needle) >= 0;
  return tokensOf(hay).indexOf(needle) >= 0; /* token */
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
    folderSeq: 0,
    fileIdSeq: 0,
    uuidSeq: 0
  };
  var matchModes = {
    title: opts.titleMatch || 'name-prefix',
    fullText: opts.fullTextMatch || 'token'
  };
  if (TITLE_MATCH_MODES.indexOf(matchModes.title) < 0) {
    throw new Error('알 수 없는 titleMatch: ' + matchModes.title + ' (가능: ' + TITLE_MATCH_MODES.join(', ') + ')');
  }
  if (FULLTEXT_MATCH_MODES.indexOf(matchModes.fullText) < 0) {
    throw new Error('알 수 없는 fullTextMatch: ' + matchModes.fullText + ' (가능: ' + FULLTEXT_MATCH_MODES.join(', ') + ')');
  }
  if (opts.vault !== undefined && opts.vault !== false && opts.vault !== true && opts.vault !== 'without-person') {
    throw new Error("알 수 없는 vault 값: " + opts.vault + " (가능: true, 'without-person')");
  }
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
  /* Drive는 ID로 파일을 찾는다 — `personDocById_`가 그 경로를 쓴다. */
  var filesById = {};
  /* 서버가 Drive에 실제로 던진 질의. "title로 10건이 찼으면 fullText 질의를 아예 내지
     않는가"처럼 호출 자체가 계약인 판정에 쓴다. */
  var searchLog = [];

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

  /* 파일 ID는 personDocById_의 /^[A-Za-z0-9_-]{10,80}$/를 만족해야 한다. */
  function nextFileId() {
    var n = String(++state.fileIdSeq);
    while (n.length < 4) n = '0' + n;
    return 'sfile-' + n + '-synthetic';
  }

  function makeFile(name, blobValue, parent) {
    var mtime = ++state.fileSeq;
    var id = nextFileId();
    var file = {
      trashed: false,
      parent: parent || null,
      getId: function () { return id; },
      getName: function () { return name; },
      getLastUpdated: function () { return new Date(FILE_EPOCH + mtime * 1000); },
      getBlob: function () { return blobValue; },
      setTrashed: function (value) { this.trashed = value !== false; },
      /* Drive는 부모를 iterator로 준다. 충실도 계약 G: 부모는 0 또는 1개만 모사한다. */
      getParents: function () { return iter(this.parent ? [this.parent] : []); },
      /* 테스트가 Drive 동기화 중복본의 '더 오래된 쪽'을 만들 때만 쓴다. */
      setMtime: function (value) { mtime = value; }
    };
    filesById[id] = file;
    return file;
  }

  function makeFolder(name, parent) {
    var id = 'synthetic-folder-' + (++state.folderSeq) + '-' + name;
    return {
      getName: function () { return name; },
      /* 충실도 계약 8: 이름이 같아도 ID는 다르다. personDocById_의 직속 판정이 ID 비교다. */
      getId: function () { return id; },
      parent: parent || null,
      files: [],
      subfolders: [],
      live: function () { return this.files.filter(function (f) { return !f.trashed; }); },
      getFiles: function () { return iter(this.live()); },
      getFilesByName: function (target) {
        return iter(this.live().filter(function (f) { return f.getName() === target; }));
      },
      createFile: function (blobValue) {
        var created = makeFile(blobValue && blobValue.getName ? blobValue.getName() : 'file', blobValue, this);
        this.files.push(created);
        return created;
      },
      /* Drive는 동명 하위 폴더를 허용한다 — 배열로 보관하고 이름 조회는 전부 돌려준다. */
      createFolder: function (childName) {
        var created = makeFolder(childName, this);
        this.subfolders.push(created);
        return created;
      },
      getFolders: function () { return iter(this.subfolders.slice()); },
      getFoldersByName: function (target) {
        return iter(this.subfolders.filter(function (f) { return f.getName() === target; }));
      },
      getParents: function () { return iter(this.parent ? [this.parent] : []); },
      /* 충실도 계약 1·2·3·4·5·6: 직속 자식만, prefix/token 매칭, 이스케이프 해석,
         대소문자 무시, fullText는 이름 포함, trash 제외. */
      searchFiles: function (query) {
        searchLog.push(String(query));
        var parsed = parseDriveQuery(query);
        return iter(this.live().filter(function (f) { return driveContains(parsed, f, matchModes); }));
      }
    };
  }

  /* ── vault 상위 트리 (opts.vault) ─────────────────────────────────────────
     기본값은 **없음**이다. 그래야 기존 게이트가 보던 `vault_walk_failed` /
     `person_folder_not_found` 경로가 한 글자도 바뀌지 않는다. */
  var vaultRoot = null;
  var inboxParent = null;
  if (opts.vault) {
    vaultRoot = makeFolder(VAULT_ROOT_NAME, null);
    inboxParent = vaultRoot.createFolder(VAULT_INBOX_PARENT);
    var walk = vaultRoot;
    var depth = opts.vault === 'without-person' ? PERSON_PATH.length - 1 : PERSON_PATH.length;
    for (var s = 0; s < depth; s++) walk = walk.createFolder(PERSON_PATH[s]);
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
      var created = makeFolder(name, inbox);
      folders.push(created);
      return created;
    },
    /* vault 상위 폴더가 없으면 personDoc_ 계열은 'vault_walk_failed'로 끝나야 하며,
       가짜 트리를 만들어 PASS를 내지 않는다. opts.vault를 켠 경우에만 걷을 수 있다. */
    getParents: function () { return iter(inboxParent ? [inboxParent] : []); }
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
        return {
          getProperty: function (key) { return Object.prototype.hasOwnProperty.call(props, key) ? props[key] : null; },
          setProperty: function (key, value) { props[key] = String(value); },
          deleteProperty: function (key) { delete props[key]; }
        };
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
      /* 충실도 계약 7·H: 없는 ID는 예외, trash 여부는 보지 않는다. */
      getFileById: function (id) {
        var hit = Object.prototype.hasOwnProperty.call(filesById, String(id)) ? filesById[String(id)] : null;
        if (!hit) throw new Error('no such file: ' + id);
        return hit;
      }
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
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: function (_algorithm, value) {
        return Array.prototype.slice.call(crypto.createHash('sha256').update(String(value), 'utf8').digest())
          .map(function (byte) { return byte > 127 ? byte - 256 : byte; });
      },
      computeHmacSha256Signature: function (value, key) {
        return Array.prototype.slice.call(crypto.createHmac('sha256', String(key)).update(String(value), 'utf8').digest())
          .map(function (byte) { return byte > 127 ? byte - 256 : byte; });
      },
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

  function requireVault() {
    if (!vaultRoot) throw new Error('vault 트리가 꺼져 있다 — createServer({ vault: true })로 켜라');
    return vaultRoot;
  }

  /* segments를 vault 루트부터 따라가며 없으면 만든다. Person 폴더는 opts.vault가
     만들어 두었으므로 여기서 새로 생기는 것은 테스트가 의도한 추가 폴더뿐이다. */
  function ensureVaultFolder(segments) {
    var node = requireVault();
    (segments || []).forEach(function (seg) {
      var it = node.getFoldersByName(seg);
      node = it.hasNext() ? it.next() : node.createFolder(seg);
    });
    return node;
  }

  var api = {
    sandbox: sandbox,
    props: props,
    cache: cache,
    mails: mails,
    inbox: inbox,
    searchLog: searchLog,
    resetSearchLog: function () { searchLog.length = 0; },

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
    },

    /* ── vault(inbox 바깥) 조작 ────────────────────────────────────────────
       Person 문서 corpus를 심고 그 파일 handle(getId/getName)을 돌려준다. */
    vault: {
      enabled: !!vaultRoot,
      personPath: PERSON_PATH.slice(),
      root: function () { return requireVault(); },
      folder: function (segments) { return ensureVaultFolder(segments); },
      addFile: function (segments, fileName, text) {
        return ensureVaultFolder(segments).createFile(makeBlob(text, 'text/markdown', fileName));
      },
      personFolder: function () { return ensureVaultFolder(PERSON_PATH); },
      addPerson: function (fileName, text) {
        return api.vault.addFile(PERSON_PATH, fileName, text);
      }
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
  BINARY_TEXT: BINARY_TEXT,
  TITLE_MATCH_MODES: TITLE_MATCH_MODES,
  FULLTEXT_MATCH_MODES: FULLTEXT_MATCH_MODES
};
