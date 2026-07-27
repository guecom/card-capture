'use strict';

/* 회귀 게이트: owner 전용 Person 조회 경로의 **성공 경로** (search / doc / persondoc)
   Kairen-Ref: TSK-000293

   ── 이 게이트가 덮는 빈틈 ─────────────────────────────────────────────────
   `personDoc_`·`personDocById_`·`searchPersons_`의 owner 성공 경로는 두 세션 연속
   `UNPROVEN`이었다. 이유는 결함이 아니라 하네스였다: `gas-sandbox.js`에 Drive 계층이
   없어서(`Folder.searchFiles` 없음, `File.getId`·`getParents` 없음, `inbox.getParents()`가
   항상 빈 iterator) 세 경로가 전부 `vault_walk_failed` / `person_folder_not_found`로
   먼저 끝났다. 검증된 것은 거부 경로(`invalid_token`·`owner_only`·`bad_id`·
   `outside_person_folder`)뿐이었고, 성공 경로는 한 번도 실행된 적이 없다.

   확장 전 실측(이 파일 작성 시점의 main):
       persondoc -> {"ok":false,"error":"vault_walk_failed"}
       search    -> {"ok":false,"error":"person_folder_not_found"}
       doc       -> {"ok":false,"error":"person_folder_not_found"}
       folder.searchFiles typeof -> undefined

   ── 하네스가 진실과 다르면 이 게이트 전체가 거짓말이 된다 ──────────────────
   그래서 Drive 검색 의미(`contains`)를 하나로 고정하지 않는다. 실제 Drive의
   `title contains` / `fullText contains`는 부분 문자열 검색이 **아니고**, 정확한
   토큰화 규칙은 공개 문서만으로 확정할 수 없다. 이 파일은 그럴듯한 해석을 전부
   묶어(3 × 2 = 6 조합) **모든 조합에서 같은 결과가 나오는 성질만** 단언한다.

       titleMatch:    name-prefix ⊆ token-prefix ⊆ substring
       fullTextMatch: token       ⊆ substring

   한 조합에서만 성립하는 결과는 단언하지 않고 UNPROVEN으로 남긴다.
   `gas-sandbox.js`의 `── Drive 계층 충실도 계약 ──` 주석이 모사하는 것과 모사하지
   않는 것의 목록이며, 이 파일은 그 목록 위에서만 판정한다.

   ══════════════════════════════════════════════════════════════════════════
   ██  TRIPWIRE — PERSONDOC_QUERY_SANITIZED                                ██
   ══════════════════════════════════════════════════════════════════════════
   `searchPersons_`(Code.gs)는 쿼리에서 `['"\]`를 전부 걸러낸다:
       String(q || '').replace(/['"\\]/g, ' ').trim().slice(0, 80)
   `personDoc_`은 작은따옴표만 걸러내고 **백슬래시를 남긴다**:
       String(meta.person).replace(/'/g, '')

   `false` (지금 · main 기본값)
       비대칭이 **실재한다**는 관찰된 사실을 단언한다. `meta.person`이 백슬래시로
       끝나면 Drive 쿼리의 종료 따옴표가 이스케이프되어 리터럴이 닫히지 않고,
       `doGet`에 try/catch가 없으므로 JSON이 아니라 예외로 끝난다.
   `true`
       `personDoc_`이 `searchPersons_`와 같은 sanitizer를 쓰게 된 뒤의 모드.
       같은 입력이 예외 대신 정상 판정으로 끝나야 한다.

   ▶ 아래 `proposed-patch-rehearsal` 케이스가 그 패치의 정확한 텍스트를 들고 있고,
     매 실행마다 그 패치가 비대칭을 없애면서 정상 경로를 깨지 않는지 예행한다.
     패치를 Code.gs에 적용한 뒤 이 상수를 뒤집으면 스위트가 그대로 green이 된다.
   ══════════════════════════════════════════════════════════════════════════

   합성 데이터만 쓴다. Person 문서 corpus는 전부 이 파일 안에서 만들어지며 실명함·실인물·
   실토큰·실 Drive ID가 없다(`PER-9999xx` 대역은 실 vault에 존재하지 않는 합성 번호다).
   디스크의 `Code.gs`는 어느 경로에서도 수정되지 않는다 — 회귀 주입은 메모리 사본이다. */

var sandboxLib = require('./gas-sandbox.js');

var PERSONDOC_QUERY_SANITIZED = false;

var NOW = '2026-07-27T09:00:00.000Z';
var OWNER = 'owner-token';
var GUEST = 'guest-token';

/* ── 채점 도구 ─────────────────────────────────────────────────────────── */
var cases = [];
var failures = [];
var notes = [];
var current = null;

function check(ok, why) {
  if (!ok) failures.push(current + ': ' + why);
  return ok;
}
function eq(actual, expected, why) {
  var a = JSON.stringify(actual);
  var b = JSON.stringify(expected);
  if (a !== b) failures.push(current + ': ' + why + '\n      실제: ' + a + '\n      기대: ' + b);
  return a === b;
}
function runCase(name, claim, fn) {
  current = name;
  var before = failures.length;
  try {
    fn();
  } catch (err) {
    failures.push(name + ': 케이스가 예외로 중단됐다 — ' + (err && err.stack ? err.stack : err));
  }
  cases.push({ name: name, claim: claim, ok: failures.length === before });
  current = null;
}
function pad(text, width) {
  var out = String(text);
  while (out.length < width) out += ' ';
  return out;
}
function throwsWith(fn) {
  try {
    fn();
  } catch (err) {
    return String((err && err.message) || err);
  }
  return null;
}

/* ── Drive 검색 의미의 불확실성 괄호 ────────────────────────────────────────
   실제 Drive가 어느 쪽인지 확정할 수 없으므로 전부 돌린다. 모든 조합에서 같은
   결과가 나오는 성질만 계약으로 인정한다. */
var MODEL_COMBOS = [];
['name-prefix', 'token-prefix', 'substring'].forEach(function (t) {
  ['token', 'substring'].forEach(function (ft) {
    MODEL_COMBOS.push({ titleMatch: t, fullTextMatch: ft });
  });
});

/* ── 합성 Person corpus ───────────────────────────────────────────────────
   질의어는 실 vault의 파일명 규칙(`PER-XXXXXX <이름>.md`)을 따라 **파일명 접두사**다.
   그래서 세 titleMatch 모델이 전부 같은 답을 낸다 — 그것이 이 corpus의 설계 목적이다. */
var Q_TITLE = 'PER-999001';
var Q_CAP = 'CAP-9990';

var DOC_HIT = 'PER-999001 강하늘 - ORG-999001 합성상사 - 대표.md';
var DOC_HIT_BODY = '---\ntypeID: PER-999001\n---\n\n# 강하늘 (합성)\n\n합성 인물 문서. 연락처 010-0000-0001.\n';

var DOC_OTHER = 'PER-999002 노을빛.md';
var DOC_OTHER_BODY = '---\ntypeID: PER-999002\n---\n\n# 노을빛 (합성)\n\n두 번째 합성 인물 문서.\n';

var DOC_CONTENT_ONLY = 'PER-999900 심연우.md';
var DOC_CONTENT_ONLY_BODY = '---\ntypeID: PER-999900\n---\n\n# 심연우 (합성)\n\n관련 인물: PER-999001 (합성 참조)\n';

var DOC_NOT_MD = 'PER-999001 참고.txt';
var DOC_NOT_MD_BODY = 'Person 폴더 직속이지만 .md가 아닌 합성 파일.\n';

var DOC_LONG = 'PER-999500 장문.md';
function longBody(size) {
  var unit = '합성 장문 채움 문단. ';
  var out = '';
  while (out.length < size) out += unit;
  return out.slice(0, size);
}
var DOC_LONG_BODY = longBody(70000);

var PERSON_PATH = ['02_Kairen_OS', '30_Instance', 'Person'];
var ORG_PATH = ['02_Kairen_OS', '30_Instance', 'Organization'];
var ARCHIVE_PATH = PERSON_PATH.concat(['_Archive']);

/* corpus를 심고 직접 참조가 필요한 파일 handle을 돌려준다. */
function seedPersonCorpus(srv) {
  var handles = {};
  handles.hit = srv.vault.addFile(PERSON_PATH, DOC_HIT, DOC_HIT_BODY);
  handles.other = srv.vault.addFile(PERSON_PATH, DOC_OTHER, DOC_OTHER_BODY);
  handles.contentOnly = srv.vault.addFile(PERSON_PATH, DOC_CONTENT_ONLY, DOC_CONTENT_ONLY_BODY);
  handles.notMd = srv.vault.addFile(PERSON_PATH, DOC_NOT_MD, DOC_NOT_MD_BODY);
  handles.long = srv.vault.addFile(PERSON_PATH, DOC_LONG, DOC_LONG_BODY);
  /* 10건 상한 corpus — 질의어가 다르므로 위 문서와 섞이지 않는다. */
  handles.cap = [];
  for (var i = 1; i <= 12; i++) {
    var n = 'CAP-9990' + (i < 10 ? '0' + i : String(i));
    handles.cap.push(srv.vault.addFile(PERSON_PATH, n + ' 상한시험.md', '# ' + n + ' 합성\n'));
  }
  /* Person 폴더 **직속이 아닌** 파일들 — 검색에도 doc 조회에도 잡히면 안 된다. */
  handles.archive = srv.vault.addFile(ARCHIVE_PATH, 'PER-999001 옛문서.md', '# 하위 폴더 합성 문서\n');
  handles.org = srv.vault.addFile(ORG_PATH, 'PER-999001 오분류.md', '# 형제 폴더 합성 문서\n');
  return handles;
}

function newServer(extra) {
  var o = { now: NOW, vault: true };
  Object.keys(extra || {}).forEach(function (k) { o[k] = extra[k]; });
  var srv = sandboxLib.createServer(o);
  srv.handles = seedPersonCorpus(srv);
  return srv;
}

function forEachModel(fn) {
  MODEL_COMBOS.forEach(function (m) {
    var srv = newServer(m);
    fn(srv, '[' + m.titleMatch + '/' + m.fullTextMatch + '] ');
  });
}

function shape(res) {
  return (res.items || []).map(function (it) { return it.title + ' | ' + it.via; });
}

function seedProcessed(srv, cid, person) {
  var meta = {
    captureId: cid,
    capturer: 'Owner',
    capturedAt: '2026-07-27T08:30:00.000Z',
    receivedAt: '2026-07-27T08:31:00.000Z',
    processedAt: '2026-07-27T08:45:00.000Z',
    status: 'processed',
    personAction: 'created',
    files: ['front.jpg']
  };
  if (person !== null && person !== undefined) meta.person = person;
  srv.seedCapture(cid, meta);
  return cid;
}

/* ══════════════════════════════════════════════════════════════════════════
   1. search — owner 성공 경로
   ══════════════════════════════════════════════════════════════════════════ */

runCase('search-owner-success', 'owner 토큰 검색이 title 매칭을 먼저 채우고 content 매칭을 뒤에 붙인다 (6개 모델 전부 동일)',
  function () {
    forEachModel(function (srv, tag) {
      var res = srv.get({ action: 'search', k: OWNER, q: Q_TITLE });
      check(res.ok === true, tag + 'owner 검색이 실패했다: ' + JSON.stringify(res));
      check(res.q === Q_TITLE, tag + '서버가 되돌려준 q가 다르다: ' + JSON.stringify(res.q));
      eq(shape(res), [
        'PER-999001 강하늘 - ORG-999001 합성상사 - 대표 | title',
        'PER-999900 심연우 | content'
      ], tag + 'title 우선 → content 보충 순서가 무너졌다');
    });
  });

runCase('search-dedup-title-wins', 'title과 fullText 양쪽에 걸리는 문서는 한 번만, via=title로 나온다',
  function () {
    forEachModel(function (srv, tag) {
      var res = srv.get({ action: 'search', k: OWNER, q: Q_TITLE });
      var ids = (res.items || []).map(function (it) { return it.id; });
      check(ids.length === new Set(ids).size, tag + '같은 파일이 두 번 나왔다: ' + JSON.stringify(ids));
      var hit = (res.items || []).filter(function (it) { return it.title.indexOf('강하늘') >= 0; });
      check(hit.length === 1 && hit[0].via === 'title',
        tag + 'title로 이미 잡힌 문서가 content로 중복되거나 via가 뒤집혔다: ' + JSON.stringify(hit));
    });
  });

runCase('search-md-only', 'Person 폴더 직속이어도 .md가 아니면 검색 결과에 넣지 않는다',
  function () {
    forEachModel(function (srv, tag) {
      var res = srv.get({ action: 'search', k: OWNER, q: Q_TITLE });
      var leaked = (res.items || []).filter(function (it) { return it.title.indexOf('참고') >= 0; });
      eq(leaked, [], tag + '.md가 아닌 파일이 검색 결과로 새어 나왔다');
    });
  });

runCase('search-direct-children-only', '하위 폴더·형제 폴더의 문서는 Person 검색에 잡히지 않는다',
  function () {
    forEachModel(function (srv, tag) {
      var res = srv.get({ action: 'search', k: OWNER, q: Q_TITLE });
      var stray = (res.items || []).filter(function (it) {
        return it.title.indexOf('옛문서') >= 0 || it.title.indexOf('오분류') >= 0;
      });
      eq(stray, [], tag + 'Person 폴더 밖(하위/형제)의 문서가 검색 결과에 들어왔다');
    });
  });

runCase('search-cap-10', 'title 매칭만으로 10건이 차면 거기서 끊고 fullText 검색을 아예 하지 않는다',
  function () {
    forEachModel(function (srv, tag) {
      srv.resetSearchLog();
      var res = srv.get({ action: 'search', k: OWNER, q: Q_CAP });
      check(res.ok === true, tag + '상한 검색이 실패했다: ' + JSON.stringify(res));
      check((res.items || []).length === 10,
        tag + '결과가 10건으로 제한되지 않았다: ' + (res.items || []).length + '건');
      var vias = (res.items || []).map(function (it) { return it.via; });
      check(vias.every(function (v) { return v === 'title'; }),
        tag + '상한이 찬 검색에 content 매칭이 섞였다: ' + JSON.stringify(vias));
      /* Drive 결과 순서는 계약이 아니므로 '어느 10건인가'는 단언하지 않는다. */
      check((res.items || []).every(function (it) { return it.title.indexOf('CAP-9990') === 0; }),
        tag + '상한 corpus 밖의 문서가 섞였다: ' + JSON.stringify(shape(res)));
      eq(srv.searchLog.length, 1,
        tag + 'title만으로 10건이 찼는데 fullText 검색까지 나갔다 (Drive 호출 낭비): ' +
        JSON.stringify(srv.searchLog));
    });
  });

runCase('search-two-queries-when-short', '10건을 못 채우면 fullText 검색을 정확히 한 번 더 낸다',
  function () {
    forEachModel(function (srv, tag) {
      srv.resetSearchLog();
      srv.get({ action: 'search', k: OWNER, q: Q_TITLE });
      eq(srv.searchLog.length, 2, tag + 'Drive 검색 호출 수가 2가 아니다: ' + JSON.stringify(srv.searchLog));
      check(srv.searchLog[0].indexOf('title contains') === 0,
        tag + '첫 질의가 title 질의가 아니다: ' + srv.searchLog[0]);
      check(srv.searchLog[1].indexOf('fullText contains') === 0,
        tag + '두 번째 질의가 fullText 질의가 아니다: ' + srv.searchLog[1]);
    });
  });

runCase('search-sanitizer', "쿼리의 ' \" \\ 는 공백으로 치환되고, trim 뒤 80자로 잘리며, 비면 empty_query다",
  function () {
    var srv = newServer();
    var withBackslash = srv.get({ action: 'search', k: OWNER, q: Q_TITLE + '\\' });
    check(withBackslash.ok === true && withBackslash.q === Q_TITLE,
      '백슬래시가 붙은 쿼리가 정상 처리되지 않았다: ' + JSON.stringify(withBackslash));
    eq(shape(withBackslash), [
      'PER-999001 강하늘 - ORG-999001 합성상사 - 대표 | title',
      'PER-999900 심연우 | content'
    ], '백슬래시를 걸러낸 뒤 결과가 달라졌다');

    eq(srv.get({ action: 'search', k: OWNER, q: '\'"\\' }), { ok: false, error: 'empty_query' },
      '따옴표·백슬래시만 있는 쿼리가 empty_query로 끝나지 않았다');
    eq(srv.get({ action: 'search', k: OWNER, q: '   ' }), { ok: false, error: 'empty_query' },
      '공백만 있는 쿼리가 empty_query로 끝나지 않았다');

    var long = srv.get({ action: 'search', k: OWNER, q: new Array(101).join('A') });
    check(long.ok === true && long.q.length === 80,
      '80자 상한이 적용되지 않았다: ' + JSON.stringify(long.q && long.q.length));
  });

runCase('search-scope-still-closed', 'vault가 실재해도 guest·무효 토큰은 여전히 막힌다',
  function () {
    var srv = newServer();
    eq(srv.get({ action: 'search', k: GUEST, q: Q_TITLE }), { ok: false, error: 'owner_only' },
      'guest 검색이 열렸다');
    eq(srv.get({ action: 'search', k: 'nope', q: Q_TITLE }), { ok: false, error: 'invalid_token' },
      '무효 토큰 검색이 열렸다');
    eq(srv.get({ action: 'doc', k: GUEST, id: srv.handles.hit.getId() }), { ok: false, error: 'owner_only' },
      'guest doc 조회가 열렸다');
    eq(srv.get({ action: 'persondoc', k: GUEST, captureId: 'x' }), { ok: false, error: 'owner_only' },
      'guest persondoc 조회가 열렸다');
  });

/* ══════════════════════════════════════════════════════════════════════════
   2. doc (personDocById_) — owner 성공 경로 + 직속 판정
   ══════════════════════════════════════════════════════════════════════════ */

runCase('doc-owner-success', '검색 결과 id로 Person 전문을 그대로 받는다',
  function () {
    forEachModel(function (srv, tag) {
      var res = srv.get({ action: 'search', k: OWNER, q: Q_TITLE });
      var id = res.items[0].id;
      var doc = srv.get({ action: 'doc', k: OWNER, id: id });
      eq(doc, {
        ok: true,
        person: 'PER-999001 강하늘 - ORG-999001 합성상사 - 대표',
        markdown: DOC_HIT_BODY
      }, tag + '검색 → doc 왕복이 원문을 그대로 돌려주지 않았다');
    });
  });

runCase('doc-rejects-non-direct-child', 'Person 폴더 하위/형제 폴더 파일은 outside_person_folder로 거절한다',
  function () {
    var srv = newServer();
    eq(srv.get({ action: 'doc', k: OWNER, id: srv.handles.archive.getId() }),
      { ok: false, error: 'outside_person_folder' },
      'Person 하위 폴더(_Archive) 파일이 통과했다 — 직속 판정이 깨졌다');
    eq(srv.get({ action: 'doc', k: OWNER, id: srv.handles.org.getId() }),
      { ok: false, error: 'outside_person_folder' },
      '형제 폴더(Organization) 파일이 통과했다');
  });

runCase('doc-id-shape', '형식이 틀린 id는 bad_id, 형식은 맞지만 없는 id는 not_found다',
  function () {
    var srv = newServer();
    eq(srv.get({ action: 'doc', k: OWNER, id: 'short' }), { ok: false, error: 'bad_id' },
      '너무 짧은 id가 bad_id로 걸리지 않았다');
    eq(srv.get({ action: 'doc', k: OWNER, id: 'has space here' }), { ok: false, error: 'bad_id' },
      '공백이 들어간 id가 bad_id로 걸리지 않았다');
    eq(srv.get({ action: 'doc', k: OWNER, id: 'aaaaaaaaaaaaaaaa' }), { ok: false, error: 'not_found' },
      '형식만 맞는 없는 id가 not_found로 끝나지 않았다');
  });

runCase('doc-truncates-60000', 'doc 응답 markdown은 60000자로 잘린다',
  function () {
    var srv = newServer();
    var res = srv.get({ action: 'doc', k: OWNER, id: srv.handles.long.getId() });
    check(res.ok === true, '장문 Person 문서 조회가 실패했다: ' + JSON.stringify(res));
    check(DOC_LONG_BODY.length === 70000, '테스트 corpus가 70000자가 아니다: ' + DOC_LONG_BODY.length);
    check(res.markdown.length === 60000, 'markdown이 60000자로 잘리지 않았다: ' + res.markdown.length);
    check(res.markdown === DOC_LONG_BODY.slice(0, 60000), '잘린 앞부분이 원문 앞부분과 다르다');
  });

/* ══════════════════════════════════════════════════════════════════════════
   3. persondoc (personDoc_) — owner 성공 경로
   ══════════════════════════════════════════════════════════════════════════ */

runCase('persondoc-owner-success', '처리 완료 캡처의 person으로 Person 전문을 찾아 돌려준다',
  function () {
    forEachModel(function (srv, tag) {
      var cid = seedProcessed(srv, '20260727-090000-p001', 'PER-999002');
      eq(srv.get({ action: 'persondoc', k: OWNER, captureId: cid }),
        { ok: true, person: 'PER-999002', markdown: DOC_OTHER_BODY },
        tag + 'persondoc 성공 경로가 계약과 다르다');
    });
  });

runCase('persondoc-truncates-60000', 'persondoc 응답 markdown도 60000자로 잘린다',
  function () {
    var srv = newServer();
    var cid = seedProcessed(srv, '20260727-090000-p500', 'PER-999500');
    var res = srv.get({ action: 'persondoc', k: OWNER, captureId: cid });
    check(res.ok === true, '장문 persondoc 조회가 실패했다: ' + JSON.stringify(res));
    check(res.markdown.length === 60000, 'markdown이 60000자로 잘리지 않았다: ' + res.markdown.length);
    check(res.markdown === DOC_LONG_BODY.slice(0, 60000), '잘린 앞부분이 원문 앞부분과 다르다');
  });

runCase('persondoc-negative-paths', '문서 없음·미처리·없는 캡처는 각각의 이유로 끝난다',
  function () {
    var srv = newServer();
    eq(srv.get({ action: 'persondoc', k: OWNER, captureId: seedProcessed(srv, '20260727-090000-p404', 'PER-999404') }),
      { ok: false, error: 'doc_not_found' }, 'Person 문서가 없는데 doc_not_found가 아니다');
    eq(srv.get({ action: 'persondoc', k: OWNER, captureId: seedProcessed(srv, '20260727-090000-p000', null) }),
      { ok: false, error: 'not_processed' }, 'person이 비었는데 not_processed가 아니다');
    eq(srv.get({ action: 'persondoc', k: OWNER, captureId: '20260727-090000-zzzz' }),
      { ok: false, error: 'not_found' }, '없는 캡처가 not_found로 끝나지 않았다');
    eq(srv.get({ action: 'persondoc', k: OWNER, captureId: 'bad id' }),
      { ok: false, error: 'bad_capture_id' }, '형식이 틀린 captureId가 bad_capture_id로 끝나지 않았다');
  });

runCase('persondoc-vault-shape-errors', 'vault 상위가 없으면 vault_walk_failed, Person 폴더가 없으면 person_folder_not_found다',
  function () {
    var noVault = sandboxLib.createServer({ now: NOW });
    seedProcessed(noVault, '20260727-090000-p001', 'PER-999002');
    eq(noVault.get({ action: 'persondoc', k: OWNER, captureId: '20260727-090000-p001' }),
      { ok: false, error: 'vault_walk_failed' }, 'vault 상위가 없는데 vault_walk_failed가 아니다');
    eq(noVault.get({ action: 'search', k: OWNER, q: Q_TITLE }),
      { ok: false, error: 'person_folder_not_found' }, 'vault 상위가 없는데 person_folder_not_found가 아니다');

    var noPerson = sandboxLib.createServer({ now: NOW, vault: 'without-person' });
    seedProcessed(noPerson, '20260727-090000-p001', 'PER-999002');
    eq(noPerson.get({ action: 'persondoc', k: OWNER, captureId: '20260727-090000-p001' }),
      { ok: false, error: 'person_folder_not_found' }, 'Person 폴더가 없는데 person_folder_not_found가 아니다');
    eq(noPerson.get({ action: 'search', k: OWNER, q: Q_TITLE }),
      { ok: false, error: 'person_folder_not_found' }, 'Person 폴더가 없는데 search가 다른 이유로 끝났다');
  });

/* ══════════════════════════════════════════════════════════════════════════
   4. 백슬래시 비대칭 — searchPersons_는 걸러내고 personDoc_은 걸러내지 않는다
   ══════════════════════════════════════════════════════════════════════════ */

runCase('backslash-asymmetry-observed', 'personDoc_이 백슬래시를 남겨 Drive 쿼리 리터럴이 닫히지 않는다 (TRIPWIRE)',
  function () {
    var srv = newServer();
    /* 대조군: 백슬래시만 뺀 같은 입력은 정상 성공한다 — 예외 원인이 백슬래시임을 고정한다. */
    var control = seedProcessed(srv, '20260727-090000-ctl0', 'PER-999002');
    check(srv.get({ action: 'persondoc', k: OWNER, captureId: control }).ok === true,
      '대조군(백슬래시 없음)이 실패했다 — 아래 판정이 무의미해진다');

    var cid = seedProcessed(srv, '20260727-090000-bs01', 'PER-999002\\');
    var message = throwsWith(function () { srv.get({ action: 'persondoc', k: OWNER, captureId: cid }); });
    if (PERSONDOC_QUERY_SANITIZED) {
      check(message === null,
        'sanitizer가 들어갔다고 선언했는데 여전히 예외로 끝난다: ' + message);
      var after = srv.get({ action: 'persondoc', k: OWNER, captureId: cid });
      check(after.ok === true, 'sanitizer 적용 후에도 정상 판정이 아니다: ' + JSON.stringify(after));
    } else {
      check(message !== null,
        'personDoc_이 백슬래시를 그대로 넘기는데 Drive 쿼리가 예외 없이 끝났다 — ' +
        '하네스의 쿼리 파서가 실제 Drive보다 관대하거나 Code.gs가 이미 고쳐졌다');
      check(String(message).indexOf('Invalid query') >= 0,
        '예외가 쿼리 구문 오류가 아니다: ' + message);
      notes.push('  personDoc_ + 백슬래시 → ' + message);
    }

    /* 같은 입력을 searchPersons_에 주면 sanitizer가 있어 예외가 없다 — 이것이 비대칭이다. */
    var searched = srv.get({ action: 'search', k: OWNER, q: 'PER-999002\\' });
    check(searched.ok === true, 'searchPersons_ 쪽도 백슬래시에서 깨졌다: ' + JSON.stringify(searched));
  });

runCase('backslash-not-injectable', "작은따옴표가 제거되므로 백슬래시로 Drive 쿼리 연산자를 주입할 수 없다",
  function () {
    forEachModel(function (srv, tag) {
      /* 연산자 주입 시도: 리터럴을 닫고 or 절을 붙이려 한다. `'`가 제거되어 전부 리터럴 안에 남는다. */
      var inject = seedProcessed(srv, '20260727-090000-inj1', "PER-999002' or title contains 'PER-999001");
      eq(srv.get({ action: 'persondoc', k: OWNER, captureId: inject }),
        { ok: false, error: 'doc_not_found' },
        tag + '주입 시도가 리터럴 밖으로 나가 다른 문서를 찾아냈다');
      var lastQuery = srv.searchLog[srv.searchLog.length - 1];
      check(lastQuery === "title contains 'PER-999002 or title contains PER-999001'",
        tag + '서버가 만든 쿼리가 예상과 다르다: ' + lastQuery);

      /* 큰따옴표는 Drive 쿼리에서 리터럴 구분자가 아니므로 평범한 문자로 남는다. */
      var dq = seedProcessed(srv, '20260727-090000-inj2', 'PER-999002"');
      eq(srv.get({ action: 'persondoc', k: OWNER, captureId: dq }),
        { ok: false, error: 'doc_not_found' },
        tag + '큰따옴표가 든 person에서 예상 밖 결과가 나왔다');
    });
  });

/* ══════════════════════════════════════════════════════════════════════════
   5. 회귀 주입 — 위 게이트가 형식적이지 않음을 매 실행마다 확인한다
      메모리 사본만 깨뜨린다. 디스크의 Code.gs는 건드리지 않는다.
   ══════════════════════════════════════════════════════════════════════════ */

var BASE_SOURCE = sandboxLib.serverSource();

function injected(from, to) {
  var count = BASE_SOURCE.split(from).length - 1;
  if (count !== 1) {
    throw new Error('주입 앵커가 Code.gs에 정확히 1번 나타나지 않는다 (' + count + '번): ' + from);
  }
  return BASE_SOURCE.split(from).join(to);
}

function brokenServer(source) {
  var srv = sandboxLib.createServer({ now: NOW, vault: true, source: source });
  srv.handles = seedPersonCorpus(srv);
  return srv;
}

var INJECTIONS = [
  {
    id: 'cap-10-removed',
    from: 'while (files.hasNext() && items.length < 10) {',
    to: 'while (files.hasNext() && items.length < 100) {',
    probe: function (srv) {
      var res = srv.get({ action: 'search', k: OWNER, q: Q_CAP });
      return (res.items || []).length === 10;
    },
    why: '10건 상한을 100으로 바꿨는데도 게이트가 10건을 봤다 — 상한 판정이 corpus 크기에 기대고 있다'
  },
  {
    id: 'md-filter-removed',
    from: "if (f.getName().slice(-3) !== '.md') continue;",
    to: 'if (false) continue;',
    probe: function (srv) {
      var res = srv.get({ action: 'search', k: OWNER, q: Q_TITLE });
      return !(res.items || []).some(function (it) { return it.title.indexOf('참고') >= 0; });
    },
    why: '.md 필터를 없앴는데도 .txt가 결과에 나타나지 않았다 — corpus에 비-.md 유인이 없다'
  },
  {
    id: 'title-first-swapped',
    from: 'collect(folder.searchFiles("title contains \'" + query + "\'"), \'title\');\r\n  if (items.length < 10) collect(folder.searchFiles("fullText contains \'" + query + "\'"), \'content\');',
    to: 'collect(folder.searchFiles("fullText contains \'" + query + "\'"), \'content\');\r\n  if (items.length < 10) collect(folder.searchFiles("title contains \'" + query + "\'"), \'title\');',
    probe: function (srv) {
      var res = srv.get({ action: 'search', k: OWNER, q: Q_TITLE });
      return JSON.stringify(shape(res)) === JSON.stringify([
        'PER-999001 강하늘 - ORG-999001 합성상사 - 대표 | title',
        'PER-999900 심연우 | content'
      ]);
    },
    why: 'title/fullText 순서를 뒤집었는데 결과가 같다 — 순서 게이트가 아무것도 보지 않는다'
  },
  {
    id: 'direct-child-check-removed',
    from: "if (!inPerson) return json_({ ok: false, error: 'outside_person_folder' });",
    to: "if (false) return json_({ ok: false, error: 'outside_person_folder' });",
    probe: function (srv) {
      return srv.get({ action: 'doc', k: OWNER, id: srv.handles.archive.getId() }).ok !== true;
    },
    why: '직속 판정을 없앴는데도 하위 폴더 파일이 거절됐다 — 판정 대상이 실제로 하위 폴더에 있지 않다'
  },
  {
    id: 'doc-truncation-widened',
    from: "getDataAsString('UTF-8').slice(0, 60000)",
    to: "getDataAsString('UTF-8').slice(0, 70000)",
    probe: function (srv) {
      return srv.get({ action: 'doc', k: OWNER, id: srv.handles.long.getId() }).markdown.length === 60000;
    },
    why: 'doc 절단 상한을 70000으로 늘렸는데도 60000자가 나왔다 — corpus가 상한보다 짧다'
  },
  {
    id: 'persondoc-truncation-widened',
    from: 'doc.slice(0, 60000)',
    to: 'doc.slice(0, 70000)',
    probe: function (srv) {
      var cid = seedProcessed(srv, '20260727-090000-p500', 'PER-999500');
      return srv.get({ action: 'persondoc', k: OWNER, captureId: cid }).markdown.length === 60000;
    },
    why: 'persondoc 절단 상한을 70000으로 늘렸는데도 60000자가 나왔다'
  }
];

runCase('regression-injection', '게이트가 형식적이지 않다 — 서버를 깨면 해당 판정이 실제로 무너진다',
  function () {
    INJECTIONS.forEach(function (inj) {
      var srv = brokenServer(injected(inj.from, inj.to));
      var stillPasses;
      try {
        stillPasses = inj.probe(srv);
      } catch (err) {
        stillPasses = false; /* 예외로 끝나면 '깨진 것을 봤다'로 인정한다 */
      }
      check(stillPasses === false, '주입 ' + inj.id + ' — ' + inj.why);
    });
  });

/* ══════════════════════════════════════════════════════════════════════════
   6. 제안 패치 예행 — 다음 배포 사이클에 들어갈 personDoc_ sanitizer
   ══════════════════════════════════════════════════════════════════════════ */

var PATCH_FROM = "var files = personFolder.searchFiles(\"title contains '\" + String(meta.person).replace(/'/g, '') + \"'\");";
var PATCH_TO = "var personQuery = String(meta.person).replace(/['\"\\\\]/g, ' ').trim().slice(0, 80);\r\n" +
  "  if (!personQuery) return json_({ ok: false, error: 'doc_not_found' });\r\n" +
  "  var files = personFolder.searchFiles(\"title contains '\" + personQuery + \"'\");";

runCase('proposed-patch-rehearsal', '제안 sanitizer가 비대칭을 없애면서 정상 경로·거부 경로를 깨지 않는다',
  function () {
    var patched = injected(PATCH_FROM, PATCH_TO);
    var srv = brokenServer(patched);

    var bs = seedProcessed(srv, '20260727-090000-bs01', 'PER-999002\\');
    var message = throwsWith(function () { srv.get({ action: 'persondoc', k: OWNER, captureId: bs }); });
    check(message === null, '패치를 넣었는데도 백슬래시에서 예외가 났다: ' + message);
    var res = srv.get({ action: 'persondoc', k: OWNER, captureId: bs });
    eq(res, { ok: true, person: 'PER-999002\\', markdown: DOC_OTHER_BODY },
      '패치 뒤 백슬래시 person이 정상 판정으로 끝나지 않았다');

    var normal = seedProcessed(srv, '20260727-090000-p001', 'PER-999002');
    eq(srv.get({ action: 'persondoc', k: OWNER, captureId: normal }),
      { ok: true, person: 'PER-999002', markdown: DOC_OTHER_BODY },
      '패치가 정상 성공 경로를 깼다');

    var missing = seedProcessed(srv, '20260727-090000-p404', 'PER-999404');
    eq(srv.get({ action: 'persondoc', k: OWNER, captureId: missing }),
      { ok: false, error: 'doc_not_found' }, '패치가 doc_not_found 경로를 깼다');

    var quotesOnly = seedProcessed(srv, '20260727-090000-pq00', '\\\'"');
    eq(srv.get({ action: 'persondoc', k: OWNER, captureId: quotesOnly }),
      { ok: false, error: 'doc_not_found' },
      '패치 뒤 전부 걸러진 빈 쿼리가 Drive로 나갔다 — 빈 리터럴 질의는 동작이 정의되지 않았다');
  });

/* ══════════════════════════════════════════════════════════════════════════
   판정
   ══════════════════════════════════════════════════════════════════════════ */
cases.forEach(function (c) {
  console.log('  ' + (c.ok ? 'pass' : 'FAIL') + '  ' + pad(c.name, 32) + ' — ' + c.claim);
});

if (notes.length) {
  console.log('');
  console.log('  ── 관찰 기록 ──');
  notes.forEach(function (line) { console.log(line); });
}

console.log('');
console.log('  denominator: cases=' + cases.length +
  ' pass=' + cases.filter(function (c) { return c.ok; }).length +
  ' fail=' + cases.filter(function (c) { return !c.ok; }).length +
  ' 모델조합=' + MODEL_COMBOS.length + ' 주입=' + INJECTIONS.length +
  ' PERSONDOC_QUERY_SANITIZED=' + PERSONDOC_QUERY_SANITIZED);

if (failures.length) {
  console.error('');
  console.error('FAIL persondoc owner (' + failures.length + '건)');
  failures.forEach(function (line) { console.error('  - ' + line); });
  process.exit(1);
}

console.log('');
console.log('  ──────────────────────────────────────────────────────────────────────');
console.log('  UNPROVEN으로 남는 것 (하네스로는 증명할 수 없다)');
console.log('  · Drive 전문 색인은 비동기다. 방금 쓴 Person 문서가 fullText 검색에 즉시');
console.log('    잡히는지는 실제 Drive에서만 확인된다 — 스텁은 항상 즉시 잡는다.');
console.log('  · Drive가 .md(text/markdown) 파일 본문을 색인하는지 자체가 미확인이다.');
console.log('    색인하지 않으면 via=content 결과는 운영에서 영원히 비어 있다.');
console.log('  · `title contains`의 실제 토큰화 규칙. 세 모델을 전부 돌려 괄호로 묶었을 뿐');
console.log('    실제 Drive가 어느 것인지는 live Drive 관찰이 있어야 확정된다.');
console.log('  · Drive가 닫히지 않은 리터럴을 정확히 어떤 예외로 거절하는지, 그리고 GAS');
console.log('    웹앱이 그때 클라이언트에 무엇을 돌려주는지(HTML 오류 페이지 추정).');
console.log('  ──────────────────────────────────────────────────────────────────────');
console.log('');
console.log('PASS persondoc owner: search·doc·persondoc owner 성공 경로 · 직속 판정 · 60000 절단 · ' +
  '백슬래시 비대칭 기록 · 회귀 주입 ' + INJECTIONS.length + '건 · 제안 패치 예행');
