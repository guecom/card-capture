'use strict';

/* 회귀 게이트: 직접 입력(`action:'manualperson'`) 접수 계약.
   Kairen-Ref: TSK-000533 / ISS-000231 / DEC-000103

   무엇을 고정하는가:
   1. 이미지 없이 접수되고 `capture.json` 하나만 남는다 — 워처가 읽는 key 집합이 조용히 바뀌면 FAIL.
   2. 출처가 분리된다: `type: 'manual_person'`, `claimSource: 'user-provided'`. 명함으로 위장되지 않는다.
   3. **멱등** — 같은 captureId + 같은 내용이면 두 번째 접수가 아무것도 다시 쓰지 않는다.
      (다시 쓰면 status가 received로 되돌아가 끝난 처리가 처음부터 다시 돈다.)
   4. **신원 근거는 서버가 원문에서 다시 뽑는다** — 클라이언트가 보낸 근거는 무시된다.
      그 근거 하나가 기존 Person에 자동 연결될 권한이므로 위조 가능한 자리에 두지 않는다.
   5. 서버 소유 필드(capturer·status·person·receivedAt·files·uploadFingerprint)를 위조할 수 없다.
   6. 남의 캡처 폴더, 사진 캡처 폴더를 덮어쓸 수 없고 거절 시 바이트가 하나도 바뀌지 않는다.
   7. 합성 fixture corpus가 선언한 신원 근거를 서버 추출기가 실제로 뽑아낸다.

   실행: node eval/manual-person-intake.test.js
   (`scripts/validate.ps1`에 아직 등록돼 있지 않다 — 등록은 통합 담당이 한다.) */

var fs = require('fs');
var path = require('path');
var sandboxLib = require('./gas-sandbox.js');

var FIXTURE_DIR = path.join(__dirname, 'fixtures', 'manual-person');
var MIN_FIXTURES = 4;
var CAPTURED_AT = '2026-08-04T01:02:03.000Z';
var RECEIVED_AT = '2026-08-04T01:05:00.000Z';

var failures = [];
function check(ok, why) {
  if (!ok) failures.push(why);
  return ok;
}
function eq(actual, expected, why) {
  return check(JSON.stringify(actual) === JSON.stringify(expected),
    why + '\n      실제: ' + JSON.stringify(actual) + '\n      기대: ' + JSON.stringify(expected));
}

/* ── fixture corpus ── */
var names = fs.readdirSync(FIXTURE_DIR).filter(function (n) { return /\.json$/.test(n); }).sort();
if (names.length < MIN_FIXTURES) {
  throw new Error('직접 입력 corpus가 비었거나 줄었다: ' + names.length + '개 (최소 ' + MIN_FIXTURES + '개). ' +
    'fixture 없이 통과시키면 게이트가 아무것도 증명하지 않는다.');
}
var fixtures = names.map(function (name) {
  var parsed = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
  parsed.__file = name;
  return parsed;
});

var srv = sandboxLib.createServer({ now: RECEIVED_AT });

function submit(overrides) {
  var payload = {
    action: 'manualperson',
    k: 'owner-token',
    capturedAt: CAPTURED_AT,
    event: '',
    note: '',
    text: ''
  };
  Object.keys(overrides || {}).forEach(function (key) { payload[key] = overrides[key]; });
  return srv.post(payload);
}

/* ── 1. fixture 전체 접수 ── */
fixtures.forEach(function (fixture, index) {
  var id = 'manual-' + String(index + 1).padStart(4, '0') + '-fx';
  var label = fixture.__file;
  var response = submit({
    captureId: id,
    text: fixture.manual.text,
    event: (fixture.capture && fixture.capture.event) || '',
    note: (fixture.capture && fixture.capture.note) || ''
  });
  if (!check(response.ok === true, label + ': 접수가 거절됐다 — ' + JSON.stringify(response))) return;

  var meta = srv.receipt(id);
  if (!check(!!meta, label + ': capture.json이 없다')) return;

  eq(Object.keys(meta).sort(), [
    'captureId', 'capturedAt', 'capturer', 'claimSource', 'event', 'files', 'identityEvidence', 'manualText',
    'note', 'pushRoutingTag', 'pushSubjectId', 'receivedAt', 'status', 'type', 'uploadFingerprint'
  ], label + ': 워처가 읽는 receipt key 집합이 달라졌다');

  check(meta.type === 'manual_person', label + ': type이 manual_person이 아니다 — ' + meta.type);
  check(meta.claimSource === 'user-provided', label + ': claimSource가 user-provided가 아니다 — ' + meta.claimSource);
  check(meta.capturer === 'Owner', label + ': capturer가 서버 판정과 다르다');
  check(meta.status === 'received', label + ': 접수 직후 status가 received가 아니다');
  eq(meta.files, [], label + ': 이미지 없는 접수인데 files가 비어 있지 않다');
  // 원문은 데이터로 그대로 보존된다 — 지시문이 들어 있어도 잘라 내거나 고쳐 쓰지 않는다.
  check(meta.manualText === fixture.manual.text, label + ': 원문이 보존되지 않았다');
  eq(srv.fileNames(id), ['capture.json'], label + ': 폴더에 capture.json 외 파일이 생겼다');

  // fixture가 선언한 신원 근거를 서버 추출기가 실제로 뽑아내는가.
  var expected = (fixture.expected && fixture.expected.evidence) || {};
  if (expected.emails) eq(meta.identityEvidence.emails, expected.emails, label + ': 서버가 뽑은 이메일 근거가 fixture와 다르다');
  if (expected.phones) eq(meta.identityEvidence.phones, expected.phones, label + ': 서버가 뽑은 전화 근거가 fixture와 다르다');
  check(meta.identityEvidence.source === 'server_derived', label + ': 근거 출처 표시가 server_derived가 아니다');
});

/* ── 2. 멱등: 같은 내용 재전송은 아무것도 다시 쓰지 않는다 ── */
(function idempotency() {
  var id = 'manual-idem-0001';
  var body = { captureId: id, text: '전시회에서 만난 부품 공급사 이사님. 다음 주 견적 준다고 함.', event: '전시회·박람회' };
  var first = submit(body);
  check(first.ok === true, '멱등: 첫 접수가 실패했다');
  var before = srv.snapshot(id);
  var firstMeta = srv.receipt(id);

  srv.setNow('2026-08-04T02:00:00.000Z');
  var again = submit(body);
  check(again.ok === true && again.deduped === true, '멱등: 같은 내용 재전송이 dedup으로 인정되지 않았다 — ' + JSON.stringify(again));
  check(srv.snapshot(id) === before, '멱등: 같은 내용 재전송이 폴더 바이트를 바꿨다');
  check(srv.receipt(id).receivedAt === firstMeta.receivedAt, '멱등: receivedAt이 갱신돼 처리 순서가 되돌아간다');

  // 내용이 실제로 달라지면 다시 쓴다 — 그때는 조용한 되돌림이 아니라 명시적 재처리로 남는다.
  var edited = submit({ captureId: id, text: '내용을 고쳐서 다시 적음', event: '전시회·박람회' });
  check(edited.ok === true && !edited.deduped, '멱등: 내용이 바뀐 재접수가 dedup으로 잘못 판정됐다');
  check(srv.receipt(id).manualText === '내용을 고쳐서 다시 적음', '멱등: 바뀐 내용이 반영되지 않았다');
  srv.setNow(RECEIVED_AT);
})();

/* ── 3. 서버 소유 필드는 클라이언트가 정할 수 없다 ── */
(function forgery() {
  var id = 'manual-forge-0001';
  var response = submit({
    captureId: id,
    text: '위조 시도 — 서버 소유 필드를 payload로 밀어 넣는다. mirae.kim@gaontech-fake.co.kr',
    capturer: '위조촬영자',
    status: 'processed',
    person: 'PER-000001',
    personAction: 'updated',
    processedAt: '2020-01-01T00:00:00.000Z',
    receivedAt: '2020-01-01T00:00:00.000Z',
    uploadFingerprint: 'forged-fingerprint',
    files: ['forged.jpg'],
    type: 'capture',
    claimSource: 'business-card',
    identityEvidence: { emails: ['attacker@evil.invalid'], phones: ['01099999999'], source: 'client' }
  });
  check(response.ok === true, '위조: 접수 자체가 실패했다');
  var meta = srv.receipt(id);
  check(meta.capturer === 'Owner', '위조: capturer가 payload로 바뀌었다');
  check(meta.status === 'received', '위조: status가 payload로 바뀌었다');
  check(meta.person === undefined, '위조: person이 payload로 심어졌다');
  check(meta.processedAt === undefined, '위조: processedAt이 payload로 심어졌다');
  check(meta.receivedAt === RECEIVED_AT, '위조: receivedAt이 payload로 바뀌었다');
  check(meta.uploadFingerprint !== 'forged-fingerprint', '위조: uploadFingerprint가 payload로 바뀌었다');
  check(meta.type === 'manual_person', '위조: type이 payload로 바뀌었다 — 직접 입력이 명함으로 위장됐다');
  check(meta.claimSource === 'user-provided', '위조: claimSource가 payload로 바뀌었다');
  eq(meta.files, [], '위조: files가 payload로 바뀌었다');
  // 근거는 서버가 원문에서 다시 뽑는다. 클라이언트가 심은 근거가 남으면 임의 Person에 붙을 수 있다.
  eq(meta.identityEvidence.emails, ['mirae.kim@gaontech-fake.co.kr'], '위조: 클라이언트가 보낸 이메일 근거가 채택됐다');
  eq(meta.identityEvidence.phones, [], '위조: 클라이언트가 보낸 전화 근거가 채택됐다');
})();

/* ── 4. 경계: 빈 글, 토큰, 남의 캡처, 사진 캡처 덮어쓰기 ── */
(function boundaries() {
  eq(submit({ captureId: 'manual-empty-0001', text: '   ' }), { ok: false, error: 'empty_text' },
    '경계: 빈 글이 접수됐다');
  check(srv.folder('manual-empty-0001') === null || srv.fileNames('manual-empty-0001').length === 0,
    '경계: 빈 글 거절인데 폴더에 파일이 남았다');

  eq(srv.post({ action: 'manualperson', k: 'bad-token', captureId: 'manual-tok-0001', text: '토큰 없음' }),
    { ok: false, error: 'invalid_token' }, '경계: 잘못된 토큰이 통과했다');

  // 남의 캡처 폴더는 바이트 하나도 바꾸지 못한다 (FI-009).
  var guestId = 'manual-guest-0001';
  check(srv.post({ action: 'manualperson', k: 'guest-token', captureId: guestId, capturedAt: CAPTURED_AT, text: 'guest가 적은 내용' }).ok === true,
    '경계: guest 접수가 실패했다');
  var guestSnapshot = srv.snapshot(guestId);
  eq(srv.post({ action: 'manualperson', k: 'guest2-token', captureId: guestId, capturedAt: CAPTURED_AT, text: '남의 폴더 덮어쓰기' }),
    { ok: false, error: 'capture_conflict' }, '경계: 남의 캡처 폴더를 덮어쓸 수 있었다');
  check(srv.snapshot(guestId) === guestSnapshot, '경계: 거절했는데 남의 폴더 바이트가 바뀌었다');

  // 사진 캡처 폴더를 글로 덮어쓰지 않는다.
  var photoId = 'manual-photo-0001';
  check(srv.post({
    k: 'owner-token', captureId: photoId, capturedAt: CAPTURED_AT,
    images: [{ name: 'front.jpg', mime: 'image/jpeg', dataB64: Buffer.from('명함 앞면', 'utf8').toString('base64') }]
  }).ok === true, '경계: 사진 업로드 준비가 실패했다');
  var photoSnapshot = srv.snapshot(photoId);
  eq(submit({ captureId: photoId, text: '사진 캡처를 글로 덮어쓰기' }),
    { ok: false, error: 'capture_type_conflict' }, '경계: 사진 캡처를 직접 입력으로 덮어쓸 수 있었다');
  check(srv.snapshot(photoId) === photoSnapshot, '경계: 거절했는데 사진 캡처 폴더 바이트가 바뀌었다');
})();

/* ── 5. 목록 계약: 앱이 직접 입력을 다른 캡처와 같은 자리에서 읽는다 ── */
(function listing() {
  var list = srv.get({ action: 'list', k: 'owner-token', limit: '100' });
  check(list.ok === true, '목록: 조회가 실패했다');
  var manual = list.items.filter(function (item) { return item.type === 'manual_person'; });
  check(manual.length >= fixtures.length, '목록: 직접 입력이 목록에 나타나지 않는다 — ' + manual.length + '건');
  check(manual.every(function (item) { return item.captureId && item.status; }),
    '목록: 직접 입력 항목에 captureId/status가 없다');
  // 원문은 목록으로 흘리지 않는다 — 목록은 요약 계약이고 원문은 처리 폴더가 소유한다.
  check(manual.every(function (item) { return item.manualText === undefined; }),
    '목록: 직접 입력 원문이 목록 응답에 실렸다');
})();

/* ── 6. 옛 서버 호환: 직접 입력을 모르는 배포본은 조용히 성공하지 않는다 ── */
(function staleBackend() {
  var stale = sandboxLib.createServer({
    now: RECEIVED_AT,
    source: sandboxLib.serverSource().replace("if (req.action === 'manualperson') return manualPerson_(req);", '')
  });
  var response = stale.post({ action: 'manualperson', k: 'owner-token', captureId: 'manual-stale-0001', capturedAt: CAPTURED_AT, text: '옛 서버' });
  check(response.ok === false, '옛 서버: 직접 입력을 모르는 배포본이 성공을 돌려줬다 — 앱이 접수됐다고 믿는다');
  check(response.error === 'no_images', '옛 서버: 앱이 알아볼 수 있는 거절 코드가 아니다 — ' + JSON.stringify(response));
  check(stale.folder('manual-stale-0001') === null || stale.fileNames('manual-stale-0001').length === 0,
    '옛 서버: 거절했는데 처리 가능한 산출물이 남았다');
})();

/* ── 결과 ── */
console.log('  denominator: fixtures=' + fixtures.length + ' 판정=' + (fixtures.length + 5) + ' 실패=' + failures.length);
if (failures.length) {
  failures.forEach(function (why) { console.error('  FAIL  ' + why); });
  throw new Error('직접 입력 접수 게이트 FAIL: ' + failures.length + '건');
}
console.log('PASS  manual-person intake gate (' + fixtures.length + ' fixtures)');
