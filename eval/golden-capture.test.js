'use strict';

/* 회귀 게이트: 합성 fixture corpus 전체가 업로드 → capture.json receipt → 처리 마감 형태 →
   앱이 다시 읽는 목록까지 **결정적으로 같은 모양**을 유지한다.
   Kairen-Ref: TSK-000277 (FI-022)

   왜 필요한가: eval/fixtures/*.json은 지금까지 LLM 세션이 손으로 처리한 뒤 run-eval.ps1이
   채점하는 경로밖에 없었다. 그 경로는 세션마다 결과가 달라 CI 게이트가 될 수 없고, 무엇보다
   **업로드 계약**(서버가 워처에게 넘기는 capture.json)과 **읽기 계약**(웹앱이 보는 list item)은
   전혀 검증되지 않았다. 이 게이트는 사람·LLM 없이 그 두 계약을 fixture 16종에 대해 고정한다.

   고정하는 것:
   1. 업로드 receipt의 **정확한 key 집합과 값** — 워처가 읽는 필드가 조용히 늘거나 사라지면 FAIL.
   2. 서버 소유 필드는 클라이언트가 위조할 수 없다 — capturer·status·person·personAction·
      processedAt·contact·type·files·receivedAt·uploadFingerprint를 payload로 보내도 무시된다.
   3. 명함 인쇄면·메모의 원문(개행, `---`, 파이프, 대괄호 링크, 지시문)이 **데이터로 그대로** 남는다.
   4. 처리 세션이 계약(CardCapture_Processing 규칙 10·10-1)대로 쓴 마감 receipt를 서버가
      terminal로 인정한다 — 인정하지 않으면 다음 업로드·requeue가 끝난 처리를 되돌린다.
   5. list API가 마감 결과(status·person·personAction·contact·brief)를 변형 없이 통과시킨다.
      웹앱의 전화·메일·연락처 저장 버튼이 `contact`를 그대로 쓰기 때문이다.
   6. corpus 자체의 정합성 — 기대값이 합성 출처에 실제로 존재하고(추측 금지), allowed_unknown과
      모순되지 않으며, secret 유사 문자열이 없다.

   실행 불가는 PASS가 아니다: fixture가 없거나 10개 미만이면 예외로 끝난다. */

var assert = require('assert');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var sandboxLib = require('./gas-sandbox.js');

var FIXTURE_DIR = path.join(__dirname, 'fixtures');
var MIN_FIXTURES = 10;
var CAPTURED_AT = '2026-07-27T08:30:00.000Z';
var RECEIVED_AT = '2026-07-27T09:00:00.000Z';
var PROCESSED_AT = '2026-07-27T09:12:00.000Z';
var RECOGNIZED_AT = '2026-07-27T08:30:05.000Z';
var GUEST_CAPTURE = 'guest-scope-capture';
var OWNER_PUSH_SUBJECT = 'psh-' + crypto.createHash('sha256').update('card-capture-push-v1\0owner-token', 'utf8').digest('hex');

/* 클라이언트가 서버 소유 필드를 정하려는 시도. 모든 fixture 업로드에 함께 보낸다 —
   하나라도 receipt에 반영되면 워처가 처리하지 않은 캡처를 '처리 완료'로 믿게 된다. */
var FORGED = {
  capturer: '위조촬영자',
  pushSubjectId: 'psh-' + '0'.repeat(64),
  pushRoutingTag: 'prt-' + '0'.repeat(64),
  status: 'processed',
  person: 'PER-000001',
  personAction: 'updated',
  processedAt: '2020-01-01T00:00:00.000Z',
  processedBy: 'forged-session',
  receivedAt: '2020-01-01T00:00:00.000Z',
  uploadFingerprint: 'forged-fingerprint',
  files: ['forged.jpg'],
  contact: { name: '위조', emails: ['forged@example.invalid'] },
  type: 'note',
  requeueRequested: true,
  skipReason: '위조 사유'
};

var failures = [];
function check(ok, why) {
  if (!ok) failures.push(why);
  return ok;
}
function deepEq(actual, expected, why) {
  try {
    assert.deepStrictEqual(actual, expected);
    return true;
  } catch (err) {
    failures.push(why + '\n      실제: ' + JSON.stringify(actual) + '\n      기대: ' + JSON.stringify(expected));
    return false;
  }
}

function b64(text) {
  return Buffer.from(String(text || '(빈 면)'), 'utf8').toString('base64');
}
function imagesFor(fixture) {
  var list = [{ name: 'front.jpg', mime: 'image/jpeg', dataB64: b64(fixture.card.front_text) }];
  if (String(fixture.card.back_text || '').trim()) {
    list.push({ name: 'back.jpg', mime: 'image/jpeg', dataB64: b64(fixture.card.back_text) });
  }
  return list;
}

/* 계약이 문서화한 지문 형식(이름·길이·맥락)을 테스트가 독립적으로 계산한다.
   구현을 그대로 호출하면 지문이 이미지 바이트를 품게 되는 변경도 통과해 버린다. */
function expectedFingerprint(payload, images) {
  var parts = images.map(function (img) { return img.name + ':' + img.dataB64.length; }).sort();
  return [
    parts.join('|'),
    String(payload.capturedAt || ''),
    String(payload.event || '').slice(0, 200),
    String(payload.note || '').slice(0, 2000)
  ].join('#');
}

function digitsOf(value) { return String(value || '').replace(/[^0-9]/g, ''); }
function squashed(value) { return String(value || '').toLowerCase().replace(/\s+/g, ''); }

/* 기대 필드가 합성 출처(명함 앞뒤면·메모·행사명·사용자 정정·기존 Person)에 실제로 존재하는가.
   존재하지 않으면 fixture가 처리 세션에 '추측해서 맞춰라'를 요구하는 것이므로 corpus 결함이다. */
function groundedIn(fixture, key, value) {
  var vc = fixture.vault_context || {};
  var sources = [
    fixture.card.front_text, fixture.card.back_text,
    fixture.capture.event, fixture.capture.note,
    vc.correction && vc.correction.text
  ];
  if (vc.existing_person) {
    Object.keys(vc.existing_person).forEach(function (k) { sources.push(vc.existing_person[k]); });
  }
  if (vc.existing_organization) sources.push(vc.existing_organization.name);
  var haystack = sources.filter(Boolean).join('\n');
  if (key === 'phone') {
    var hay = digitsOf(haystack);
    var raw = digitsOf(value);
    if (!raw) return false;
    if (hay.indexOf(raw) >= 0) return true;
    if (raw.charAt(0) === '0' && hay.indexOf('82' + raw.slice(1)) >= 0) return true;
    return raw.indexOf('82') === 0 && hay.indexOf('0' + raw.slice(2)) >= 0;
  }
  return squashed(haystack).indexOf(squashed(value)) >= 0;
}

function secretLike(text) {
  if (/AKfycb[A-Za-z0-9_-]{10,}/.test(text)) return true;
  var matches = String(text).replace(/https?:\/\/\S+/g, ' ').match(/[A-Za-z0-9_-]{44,}/g) || [];
  return matches.some(function (v) {
    if (/^[0-9a-fA-F]+$/.test(v)) return false;
    return /[A-Z]/.test(v) && /[a-z]/.test(v) && /[0-9]/.test(v);
  });
}

/* ── fixture corpus 적재 ── */
var names = fs.readdirSync(FIXTURE_DIR).filter(function (n) { return /\.json$/.test(n); }).sort();
if (names.length < MIN_FIXTURES) {
  throw new Error('골든 corpus가 비었거나 줄었다: fixture ' + names.length + '개 (최소 ' + MIN_FIXTURES + '개). ' +
    'fixture 없이 통과시키면 게이트가 아무것도 증명하지 않는다.');
}
var fixtures = names.map(function (name) {
  var raw = fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error('fixture JSON 파싱 실패: ' + name + ' — ' + err.message);
  }
  parsed.__file = name;
  parsed.__raw = raw;
  return parsed;
});

var srv = sandboxLib.createServer({ now: RECEIVED_AT });
var rows = [];

fixtures.forEach(function (fixture, index) {
  var id = fixture.id;
  var label = fixture.__file;

  /* ── corpus 정합성 (여기서 걸리면 아래 골든 판정은 의미가 없다) ── */
  check(/^[A-Za-z0-9_-]{4,64}$/.test(String(id)), label + ': id "' + id + '"가 captureId 규칙(sanitizeId_)에 맞지 않아 업로드 경로로 재현할 수 없다');
  check(fixture.synthetic === true, label + ': synthetic:true가 아니다 — 실명함 유래 fixture는 익명화 사람 승인 없이 들어올 수 없다');
  check(!!(fixture.card && typeof fixture.card.front_text === 'string'), label + ': card.front_text가 없어 업로드할 이미지 내용을 만들 수 없다');
  check(!!(fixture.capture && typeof fixture.capture.event === 'string' && typeof fixture.capture.note === 'string'), label + ': capture.event/note가 문자열이 아니다');
  check(!secretLike(fixture.__raw), label + ': secret 유사 문자열이 fixture에 들어 있다 (토큰·배포 ID·긴 랜덤 문자열 금지)');
  if (fixture.adversarial === true) {
    check(Array.isArray(fixture.must_not) && fixture.must_not.length > 0,
      label + ': adversarial fixture인데 must_not(금지 결과)이 없다 — 채점 불가는 pass가 아니다');
  }

  var decision = fixture.expected && fixture.expected.decision;
  check(['create', 'update', 'skip'].indexOf(decision) >= 0, label + ': expected.decision이 create/update/skip이 아니다 (' + decision + ')');
  var fields = (fixture.expected && fixture.expected.fields) || {};
  var unknown = ((fixture.expected && fixture.expected.allowed_unknown) || []).join(' ');
  if (decision === 'skip') {
    check(Object.keys(fields).length === 0, label + ': skip fixture인데 expected.fields가 있다 — 건너뛴 캡처에서 사람 정보를 만들면 안 된다');
  }
  if (decision === 'update') {
    check(!!(fixture.vault_context && fixture.vault_context.existing_person && fixture.vault_context.existing_person.typeID),
      label + ': update fixture인데 vault_context.existing_person.typeID가 없어 갱신 대상을 특정할 수 없다');
  }
  Object.keys(fields).forEach(function (key) {
    check(groundedIn(fixture, key, fields[key]),
      label + ': expected.fields.' + key + '="' + fields[key] + '"가 합성 출처(명함·메모·정정·기존 Person) 어디에도 없다 — 처리 세션에 추측을 요구하는 기대값이다');
  });
  ['name', 'email', 'phone'].forEach(function (key) {
    if (unknown.indexOf(key) >= 0) {
      check(!fields[key], label + ': allowed_unknown에 ' + key + '가 있는데 expected.fields.' + key + '도 있다 — 판독 불가와 기대값이 모순이다');
    }
  });

  /* ── 1. 업로드 → receipt 골든 ── */
  var images = imagesFor(fixture);
  var quickName = fields.name ? {
    name: fields.name, source: 'device_text_detector', confidence: 87,
    confirmed: false, recognizedAt: RECOGNIZED_AT
  } : null;
  var payload = Object.assign({}, FORGED, {
    k: 'owner-token',
    captureId: id,
    capturedAt: CAPTURED_AT,
    event: fixture.capture.event,
    note: fixture.capture.note,
    quickName: quickName,
    images: images
  });
  var response = srv.post(payload);
  if (!check(response.ok === true, label + ': 업로드가 접수되지 않았다 — ' + JSON.stringify(response))) return;
  deepEq(response.files, images.map(function (i) { return i.name; }), label + ': 응답 files가 실제 저장 이름과 다르다');

  var receipt = srv.receipt(id);
  var goldenReceipt = {
    captureId: id,
    capturer: 'Owner',
    pushSubjectId: OWNER_PUSH_SUBJECT,
    pushRoutingTag: '',
    capturedAt: CAPTURED_AT,
    receivedAt: RECEIVED_AT,
    event: String(fixture.capture.event).slice(0, 200),
    note: String(fixture.capture.note).slice(0, 2000),
    quickName: quickName,
    files: images.map(function (i) { return i.name; }),
    uploadFingerprint: expectedFingerprint(payload, images),
    status: 'received'
  };
  deepEq(receipt, goldenReceipt,
    label + ': capture.json receipt가 골든과 다르다. 필드가 늘거나 사라졌거나(워처 계약 변경), ' +
    '클라이언트가 보낸 서버 소유 필드(capturer/status/person/processedAt/contact/type/files/fingerprint)가 반영됐거나, ' +
    '명함·메모 원문이 변형됐다');
  deepEq(srv.fileNames(id), images.map(function (i) { return i.name; }).concat(['capture.json']).sort(),
    label + ': 캡처 폴더 파일 집합이 계약과 다르다');

  /* ── 2. 접수 직후 list 계약 (앱이 처음 보는 모양) ── */
  var listed = srv.get({ action: 'list', k: 'owner-token', limit: '100' });
  if (!check(listed.ok === true, label + ': owner list 호출이 실패했다')) return;
  var item = listed.items.filter(function (it) { return it.captureId === id; })[0];
  deepEq(item, {
    captureId: id, capturer: 'Owner', capturedAt: CAPTURED_AT, receivedAt: RECEIVED_AT,
    processedAt: '', event: goldenReceipt.event, status: 'received',
    person: '', personAction: '', type: 'capture', contact: null, quickName: quickName
  }, label + ': 접수 직후 list item이 계약과 다르다 — 처리 전인데 person/contact/processedAt/type이 채워졌거나 필드가 바뀌었다');

  /* ── 3. 처리 마감 형태 (CardCapture_Processing 규칙 10·10-1) ── */
  var skip = decision === 'skip';
  var personId = skip ? '' :
    (decision === 'update' ? fixture.vault_context.existing_person.typeID : 'PER-9990' + (50 + index));
  var contact = skip ? null : {
    name: fields.name || '',
    organization: fields.organization_mentions ||
      ((fixture.vault_context && fixture.vault_context.existing_organization && fixture.vault_context.existing_organization.name) || ''),
    title: fields.title || '',
    emails: fields.email ? [fields.email] : [],
    phones: fields.phone ? [fields.phone] : []
  };
  var brief = '# 합성 브리핑 — ' + id + '\n\n' +
    (skip ? '명함이 아니라 건너뜀: 합성 fixture 계약상 Person을 만들지 않는다.\n' : '대상: ' + personId + '\n');
  var terminal = Object.assign({}, receipt, {
    status: skip ? 'skipped' : 'processed',
    processedAt: PROCESSED_AT,
    processedBy: 'eval-golden-session'
  });
  if (skip) terminal.skipReason = '명함이 아님 (합성 fixture 계약)';
  else {
    terminal.person = personId;
    terminal.personAction = decision === 'update' ? 'updated' : 'created';
    terminal.contact = contact;
  }
  check(srv.sandbox.isTerminalMeta_(terminal) === true,
    label + ': 계약대로 쓴 마감 receipt를 서버가 terminal로 인정하지 않는다 — 다음 업로드나 requeue가 끝난 처리를 received로 되돌린다');
  if (decision === 'update') {
    check(terminal.person === fixture.vault_context.existing_person.typeID,
      label + ': update 마감이 기존 typeID를 유지하지 않았다 (새 PER 발급은 must_not)');
  }
  srv.writeReceipt(id, terminal);
  srv.writeBrief(id, brief);

  /* ── 4. 마감 후 list 계약 (앱의 버튼·제목이 이 값을 그대로 쓴다) ── */
  var after = srv.get({ action: 'list', k: 'owner-token', limit: '100' });
  var doneItem = after.items.filter(function (it) { return it.captureId === id; })[0];
  deepEq(doneItem, {
    captureId: id, capturer: 'Owner', capturedAt: CAPTURED_AT, receivedAt: RECEIVED_AT,
    processedAt: PROCESSED_AT, event: goldenReceipt.event, status: skip ? 'skipped' : 'processed',
    person: personId, personAction: skip ? '' : (decision === 'update' ? 'updated' : 'created'),
    type: 'capture', contact: contact, quickName: quickName, brief: brief
  }, label + ': 마감 후 list item이 계약과 다르다 — status·person·personAction·contact·brief 중 하나가 변형·유실됐다');
  check(String(doneItem && doneItem.brief || '').length > 0,
    label + ': 마감했는데 brief가 목록에 없다 — 건너뛴 캡처도 사유를 사람이 읽을 경로가 필요하다(list는 skipReason을 노출하지 않는다)');

  rows.push('  pass  ' + (label + '                        ').slice(0, 28) + decision +
    ' → ' + (skip ? 'skipped' : 'processed ' + personId));
});

/* ── 5. 다른 촬영자의 캡처는 서로 보이지 않는다 (scope가 비어서 통과하는 것이 아님을 증명) ── */
srv.post({
  k: 'guest-token', captureId: GUEST_CAPTURE, capturedAt: CAPTURED_AT, event: '합성 게스트 행사', note: '',
  images: [{ name: 'front.jpg', mime: 'image/jpeg', dataB64: b64('게스트 합성 명함') }]
});
var ownerList = srv.get({ action: 'list', k: 'owner-token', limit: '100' });
var guestList = srv.get({ action: 'list', k: 'guest-token', limit: '100' });
check(ownerList.seeAll === true, 'owner 토큰이 seeAll=false로 나왔다');
check(guestList.seeAll === false, 'guest 토큰이 seeAll=true로 나왔다 — 초대 촬영자가 전체 캡처를 본다');
check(ownerList.items.length === fixtures.length + 1,
  'owner 목록 건수가 업로드 건수와 다르다: ' + ownerList.items.length + ' vs ' + (fixtures.length + 1));
check(ownerList.hasMore === false, 'limit 100인데 hasMore가 true다 — 목록 페이지네이션이 깨졌다');
deepEq(guestList.items.map(function (it) { return it.captureId; }), [GUEST_CAPTURE],
  'guest 목록이 자기 캡처 하나만 보여주지 않는다 — 남의 캡처가 보이거나 자기 것도 못 본다');
var ids = ownerList.items.map(function (it) { return it.captureId; });
check(new Set(ids).size === ids.length, 'owner 목록에 같은 captureId가 중복 등장한다');
deepEq(srv.get({ action: 'persondoc', k: 'guest-token', captureId: fixtures[0].id }), { ok: false, error: 'owner_only' },
  'guest가 Person 전문(persondoc)을 요청했는데 owner_only로 막히지 않았다');
deepEq(srv.get({ action: 'search', k: 'guest-token', q: '김' }), { ok: false, error: 'owner_only' },
  'guest가 인맥 검색을 요청했는데 owner_only로 막히지 않았다');

/* ── 판정 ── */
rows.forEach(function (row) { console.log(row); });
console.log('  denominator: fixtures=' + fixtures.length + ' 골든통과=' + rows.length +
  ' 실패=' + failures.length + ' (게스트 scope 케이스 1건 포함)');
if (failures.length > 0) {
  console.error('');
  failures.forEach(function (why) { console.error('  FAIL  ' + why); });
  throw new Error('골든 캡처 게이트 FAIL: ' + failures.length + '건');
}
if (rows.length !== fixtures.length) {
  throw new Error('골든 캡처 게이트 FAIL: fixture ' + fixtures.length + '개 중 ' + rows.length + '개만 판정됐다 — 채점 불가는 pass가 아니다');
}
console.log('PASS golden capture: receipt 골든 · 서버 소유 필드 위조 차단 · 마감 형태 terminal 인정 · list 계약 · 촬영자 scope (' +
  fixtures.length + ' fixtures)');
