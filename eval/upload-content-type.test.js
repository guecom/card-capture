'use strict';

/* 회귀 게이트: 업로드된 **바이트**가 실제로 이미지인가 (FI-012 나머지).
   Kairen-Ref: TSK-000283

   ── 이 게이트가 덮는 빈틈 ─────────────────────────────────────────────────
   TSK-000279(v2.5.0)에서 서버가 파일 **이름**을 소유하게 됐다: `captureSlotName_`이
   `front.jpg`/`back.jpg`만 허용하고, 같은 슬롯 중복·8MB 초과·base64 디코드 실패를 거절한다.
   하지만 서버는 아직 **내용을 한 바이트도 보지 않는다.** `doPost`의 검증 루프는

       slot 이름 → 중복 → base64 디코드 → 길이 0 → 길이 8MB

   까지만 보고 `planned.push({slot, bytes, mime: img.mime || 'image/jpeg'})`로 넘어간다.
   그래서 다음 두 가지가 그대로 통과한다:

   C1. **바이트 미검증** — `mime: 'image/jpeg'`라고 주장하면서 본문이 PNG·GIF·PDF·ZIP·
       순수 텍스트·SVG·HTML이어도 `front.jpg`로 저장된다. 처리 파이프라인(워처·LLM 세션)은
       `files: ['front.jpg']` receipt를 보고 그것을 명함 사진으로 취급한다.
   C2. **MIME 미검증** — 클라이언트가 준 `img.mime`이 Drive 파일의 MIME으로 그대로 박힌다.
       `front.jpg`라는 이름에 `text/html` MIME을 붙일 수 있다. 이름은 서버가 소유하는데
       content type은 아직 클라이언트가 소유한다.

   실제 클라이언트는 두 경로(`frontend/src/services/camera.ts`, `docs/legacy.html`) 모두
   canvas `toDataURL('image/jpeg', …)`로 인코딩한다 — 기본 카메라 파일 선택도
   `fileToCameraFrame`이 canvas로 재인코딩한다. 즉 **정상 업로드는 예외 없이 canvas JPEG**이고,
   SOI(FF D8 FF)로 시작해 EOI(FF D9)로 끝난다. 그러므로 JPEG만 받는 것은 계약을 좁히는 것이
   아니라 이미 성립하는 계약을 서버가 확인하는 것이다.

   ── 앞 세션의 교훈을 여기에 다시 적용한다 ──────────────────────────────────
   ISS-000108은 "이름은 정규화 대상이지 거절 대상이 아니다"라는 전제에서 나왔다. 정규화가
   곧 구멍이었다. 그래서 여기서도 **바이트는 정규화하지 않고 거절한다**(`bad_image_content`).
   MIME만 예외로 서버가 값을 강제하는데, 그것은 바이트가 JPEG임을 이미 확인한 뒤이므로
   `image/jpeg`가 참인 진술이 되기 때문이다 — 신뢰할 수 없는 입력을 눈감아 주는 정규화가 아니다.

   ══════════════════════════════════════════════════════════════════════════
   ██  TRIPWIRE — MAGIC_BYTE_ENFORCED                                      ██
   ══════════════════════════════════════════════════════════════════════════
   `false` (지금 · main 기본값)
       서버가 바이트를 안 본다는 **관찰된 현재 사실**을 단언한다. 아래 corpus의
       "서버가 이 바이트를 받아들인다"가 통과 조건이다. CI는 green으로 유지되고,
       이 파일은 결함 대장(defect ledger) 역할을 한다.

   `true`
       전면 강제 스위트가 돈다 — corpus의 비-JPEG 페이로드가 전부 `bad_image_content`로
       거절되고, MIME은 서버가 소유해야 한다. **지금 Code.gs에서는 FAIL한다.**
       그 FAIL이 결함이 실재한다는 증명이다.

   ▶ 언제 뒤집는가: Code.gs가 magic-byte/MIME 실검증을 얻는 순간 `false` 쪽 단언들이
     깨진다("받아들여야 하는데 거절됐다"). 그때 이 상수를 `true`로 뒤집어라. 단언을
     지우거나 완화해서 green을 만들지 마라 — 그러면 이 파일은 아무것도 지키지 않는다.
   ▶ 아래 `proposed-patch-rehearsal` 케이스가 그 패치의 정확한 텍스트를 들고 있고,
     매 실행마다 그 패치가 corpus를 실제로 막는지 예행한다. 배포 사이클에서 그 패치를
     Code.gs에 적용한 뒤 이 상수를 뒤집으면 스위트가 그대로 green이 된다.
   ══════════════════════════════════════════════════════════════════════════

   합성 데이터만 쓴다. 바이트 corpus는 전부 이 파일 안에서 리터럴로 만들어지며 실명함·실토큰·
   개인정보가 없다. Drive·GAS·메일은 `gas-sandbox.js`의 합성 스텁이고, 스텁이 없으면 PASS가
   아니라 예외로 끝난다. */

var sandboxLib = require('./gas-sandbox.js');

var MAGIC_BYTE_ENFORCED = false;

var NOW = '2026-07-27T09:00:00.000Z';
var CAPTURED_AT = '2026-07-27T08:30:00.000Z';
var OWNER = 'owner-token';

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

/* ── 합성 바이트 corpus ────────────────────────────────────────────────────
   전부 코드에서 만든다. 실제 이미지 파일을 fixture로 들여오지 않는다. */
function bytesOf(list) { return Buffer.from(list); }
function ascii(text) { return Buffer.from(text, 'ascii'); }
function cat() { return Buffer.concat(Array.prototype.slice.call(arguments)); }

/* 최소 JPEG 골격: SOI + APP0/JFIF + 본문 + EOI. 실제 카메라 파일이 아니라 시그니처만 맞춘
   합성 바이트다 — 이 게이트가 보는 것도 시그니처뿐이다. */
function syntheticJpeg(body) {
  return cat(
    bytesOf([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]),
    ascii('JFIF'),
    bytesOf([0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
    ascii(String(body)),
    bytesOf([0xFF, 0xD9])
  );
}

var CORPUS = [
  {
    id: 'jpeg-real', legit: true, marker: 'synthetic-front-side',
    buf: syntheticJpeg('synthetic-front-side'),
    why: '진짜 JPEG magic(FF D8 FF) + EOI(FF D9) — 유일한 정상 대조군. 두 모드 모두 통과해야 한다'
  },
  {
    id: 'png-as-jpg', defeats: 'header', marker: 'IHDR',
    buf: cat(bytesOf([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), ascii('IHDR-synthetic-IEND')),
    why: 'PNG magic(89 50 4E 47)인데 슬롯은 front.jpg이고 image/jpeg라고 주장한다'
  },
  {
    id: 'gif89a', defeats: 'header', marker: 'synthetic-gif',
    buf: cat(ascii('GIF89a'), bytesOf([0x01, 0x00, 0x01, 0x00]), ascii('synthetic-gif'), bytesOf([0x3B])),
    why: 'GIF89a 헤더'
  },
  {
    id: 'pdf', defeats: 'header', marker: '%PDF-1.7',
    buf: ascii('%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\ntrailer<<>>\n%%EOF\n'),
    why: 'PDF(%PDF-) — 문서가 명함 사진 슬롯에 들어간다'
  },
  {
    id: 'zip', defeats: 'header', marker: 'synthetic-zip-entry',
    buf: cat(bytesOf([0x50, 0x4B, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]), ascii('synthetic-zip-entry.txt')),
    why: 'ZIP(PK\\x03\\x04) — 컨테이너 파일이 이미지 슬롯에 들어간다'
  },
  {
    id: 'plain-text', defeats: 'header', marker: 'hello world',
    buf: ascii('hello world'),
    why: '순수 텍스트를 base64로 감싸고 mime만 image/jpeg라고 주장한다'
  },
  {
    id: 'svg-onload', defeats: 'header', marker: 'onload=',
    buf: ascii('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><text>x</text></svg>'),
    why: 'SVG 스크립트 주입 시도 — 이미지 취급 표면에서 실행 가능한 마크업'
  },
  {
    id: 'html-script', defeats: 'header', marker: '<script>',
    buf: ascii('<!DOCTYPE html><script>document.title="synthetic"</script>'),
    why: 'HTML 문서 + script — front.jpg 이름 뒤에 실행 가능한 마크업'
  },
  {
    id: 'webp', defeats: 'header', marker: 'WEBP',
    buf: cat(ascii('RIFF'), bytesOf([0x24, 0x00, 0x00, 0x00]), ascii('WEBPVP8 synthetic')),
    why: '진짜 이미지지만 JPEG이 아니다 — 검사가 "이미지인가"가 아니라 "계약된 형식인가"를 봐야 한다'
  },
  {
    id: 'polyglot-jpeg-html', defeats: 'trailer', marker: '<script>',
    buf: cat(syntheticJpeg('cover'), ascii('<script>fetch("//synthetic.invalid")</script>')),
    why: '앞은 정상 JPEG, 뒤에 HTML을 덧붙인 폴리글롯 — 헤더만 보는 검사는 이것을 못 막는다'
  }
];

/* ── 업로드 도구 ─────────────────────────────────────────────────────────── */
function newServer(source) {
  return sandboxLib.createServer(typeof source === 'string' ? { now: NOW, source: source } : { now: NOW });
}
function imageOf(slot, buf, mime) {
  return { name: slot, mime: mime || 'image/jpeg', dataB64: buf.toString('base64') };
}
function post(srv, captureId, images) {
  return srv.post({ k: OWNER, captureId: captureId, capturedAt: CAPTURED_AT, event: '', note: '', images: images });
}
/* 저장된 파일의 blob을 서버가 만든 그대로 읽는다 — 하네스가 별도 규칙으로 읽으면 서버 버그를 가린다. */
function storedBlob(srv, captureId, fileName) {
  var folder = srv.folder(captureId);
  if (!folder) return null;
  var hit = folder.live().filter(function (f) { return f.getName() === fileName; });
  return hit.length ? hit[hit.length - 1].getBlob() : null;
}
/* 처리 파이프라인이 집어갈 수 있는 것이 하나도 남지 않았음을 확인한다. */
function nothingProcessable(srv, captureId, why) {
  check(srv.folder(captureId) === null, why + ' — 캡처 폴더가 만들어졌다');
  check(srv.receipt(captureId) === null, why + ' — capture.json receipt가 남아 워처가 집어갈 수 있다');
  var list = srv.get({ action: 'list', k: OWNER, limit: '100' });
  check(list.items.filter(function (it) { return it.captureId === captureId; }).length === 0,
    why + ' — 목록에 접수된 것으로 나타났다');
}

/* ══════════════════════════════════════════════════════════════════════════
   1. corpus — 모드에 따라 "현재 사실 기록" 또는 "전면 강제"
   ══════════════════════════════════════════════════════════════════════════ */
CORPUS.forEach(function (entry) {
  var claim = entry.legit
    ? '진짜 JPEG은 두 모드 모두에서 접수된다'
    : (MAGIC_BYTE_ENFORCED
      ? '이미지가 아닌 바이트는 bad_image_content로 거절되고 아무것도 쓰이지 않는다'
      : '[현재 결함 기록] 서버가 바이트를 보지 않으므로 이 페이로드가 접수된다');

  runCase('content/' + entry.id, claim, function () {
    var srv = newServer();
    var id = 'cap-' + entry.id;
    var res = post(srv, id, [imageOf('front.jpg', entry.buf)]);

    if (entry.legit) {
      check(res.ok === true, '정상 JPEG이 거절됐다 — 대조군이 깨지면 나머지 판정이 무의미하다: ' + JSON.stringify(res));
      eq(res.files, ['front.jpg'], '정상 JPEG의 files가 계약과 다르다');
      var blob = storedBlob(srv, id, 'front.jpg');
      check(blob !== null, '정상 JPEG이 front.jpg로 저장되지 않았다');
      if (blob) check(blob.length === entry.buf.length, '저장된 바이트 수가 업로드와 다르다: ' + blob.length + ' vs ' + entry.buf.length);
      return;
    }

    if (MAGIC_BYTE_ENFORCED) {
      check(res.ok === false,
        entry.why + '\n      → 이미지가 아닌 바이트가 접수됐다: ' + JSON.stringify(res));
      check(res.error === 'bad_image_content',
        '거절 이유가 bad_image_content가 아니다(' + (entry.defeats === 'trailer' ? 'EOI 검사' : 'magic 검사') +
        ' 몫): ' + JSON.stringify(res));
      nothingProcessable(srv, id, entry.id + ' 거절');
      return;
    }

    /* MAGIC_BYTE_ENFORCED = false — 관찰된 현재 사실을 명시적으로 기록한다.
       이 단언이 깨지면 서버가 검증을 얻은 것이다. 완화하지 말고 상수를 뒤집어라. */
    check(res.ok === true,
      '이 단언이 깨졌다면 서버가 바이트 검증을 얻은 것이다 → 파일 상단 MAGIC_BYTE_ENFORCED를 true로 뒤집어라. ' +
      '응답: ' + JSON.stringify(res));
    eq(res.files, ['front.jpg'], '접수됐는데 files가 front.jpg가 아니다');
    var stored = storedBlob(srv, id, 'front.jpg');
    check(stored !== null, entry.id + ': 접수됐는데 front.jpg가 저장되지 않았다');
    if (stored) {
      check(stored.getDataAsString().indexOf(entry.marker) >= 0,
        entry.id + ': 이미지가 아닌 내용이 그대로 저장됐음을 확인할 수 없다(marker=' + entry.marker + ')');
      notes.push('  [통과함] ' + pad(entry.id, 20) + ' ' + pad(String(entry.buf.length) + 'B', 7) +
        ' 저장 MIME=' + stored.mime + '  ' + entry.why);
    }
    var receipt = srv.receipt(id);
    check(receipt !== null && receipt.status === 'received',
      entry.id + ': 처리 대기 receipt가 남는다는 사실을 확인할 수 없다');
    check(receipt !== null && JSON.stringify(receipt.files) === JSON.stringify(['front.jpg']),
      entry.id + ': receipt.files가 front.jpg가 아니다 — 워처는 이것을 명함 사진으로 집어간다');
  });
});

function pad(text, width) {
  var out = String(text);
  while (out.length < width) out += ' ';
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
   2. MIME 소유권 (C2) — 이름은 서버가 소유하는데 content type은 아직 아니다
   ══════════════════════════════════════════════════════════════════════════ */
runCase('mime-ownership', MAGIC_BYTE_ENFORCED
  ? 'Drive 파일의 MIME은 서버가 소유한다 — 클라이언트 주장과 무관하게 image/jpeg다'
  : '[현재 결함 기록] 클라이언트가 준 mime이 Drive 파일 MIME으로 그대로 박힌다', function () {
  var srv = newServer();
  var res = post(srv, 'cap-mime-claim', [imageOf('front.jpg', syntheticJpeg('mime-claim'), 'text/html')]);
  check(res.ok === true, '진짜 JPEG인데 거절됐다 — mime 주장만 다르다: ' + JSON.stringify(res));
  var blob = storedBlob(srv, 'cap-mime-claim', 'front.jpg');
  check(blob !== null, 'front.jpg가 저장되지 않았다');
  if (!blob) return;

  if (MAGIC_BYTE_ENFORCED) {
    check(blob.mime === 'image/jpeg',
      'front.jpg의 Drive MIME을 클라이언트가 정했다: ' + blob.mime);
  } else {
    check(blob.mime === 'text/html',
      '이 단언이 깨졌다면 서버가 MIME을 소유하게 된 것이다 → MAGIC_BYTE_ENFORCED를 true로 뒤집어라. 저장 MIME: ' + blob.mime);
    notes.push('  [통과함] ' + pad('mime-claim', 20) + pad('', 8) +
      ' 저장 MIME=' + blob.mime + '  front.jpg 이름에 클라이언트가 고른 content type이 붙는다');
  }

  /* 두 모드 공통: mime 주장은 슬롯 판정을 흔들지 못한다. */
  var weird = newServer();
  var res2 = post(weird, 'cap-mime-weird', [imageOf('front.jpg', syntheticJpeg('x'), 'application/x-msdownload')]);
  check(res2.ok === true && JSON.stringify(res2.files) === JSON.stringify(['front.jpg']),
    'mime 주장이 슬롯 이름 판정을 바꿨다: ' + JSON.stringify(res2));
});

/* ══════════════════════════════════════════════════════════════════════════
   3. 이미 성립하는 방어 — 고치지 않고 게이트로 고정한다
      (아래 4번이 이 게이트들을 회귀 주입으로 다시 검증한다)
   ══════════════════════════════════════════════════════════════════════════ */
/* 빈 바이트 — 관찰된 사실 하나를 여기 적어 둔다.
   `dataB64: ''`는 Code.gs의 `empty_image` 분기까지 가지 못한다. 그 앞의
   `Utilities.base64Decode('')`가 먼저 예외를 던져 `bad_image_data`로 끝나기 때문이다
   (하네스의 디코더가 실제 GAS처럼 빈 문자열을 거절한다). 그래서:
   - 요구("빈 바이트는 처리 가능한 산출물을 남기지 않는다")는 성립한다 — 두 코드 모두 참된 거절이다.
   - 다만 `empty_image` 줄 자체는 이 경로에서 **도달 불가**라, 그 줄을 지우는 회귀 주입으로는
     게이트가 형식적이지 않음을 증명할 수 없다(지워도 결과가 같다). 그래서 아래 주입 목록에
     넣지 않았다. 이것은 게이트를 느슨하게 둔 것이 아니라 관찰된 사실이다.
   - live GAS의 `Utilities.base64Decode('')`가 예외 대신 빈 배열을 준다면 그쪽에서는
     `empty_image`가 실제로 도는 분기다. 배포 검증 때 확인할 항목. */
function gateEmptyRejected(source) {
  var srv = newServer(source);
  var res = post(srv, 'cap-empty-bytes', [{ name: 'front.jpg', mime: 'image/jpeg', dataB64: '' }]);
  return res.ok === false && (res.error === 'empty_image' || res.error === 'bad_image_data') && srv.folderCount() === 0;
}
function gateOversizeRejected(source) {
  var srv = newServer(source);
  var huge = 'QUFB'.repeat(2900000); /* 디코딩 8.7MB — 서버 상한 8MB 초과 */
  var res = post(srv, 'cap-oversize', [{ name: 'front.jpg', mime: 'image/jpeg', dataB64: huge }]);
  return res.ok === false && res.error === 'image_too_large' && srv.folderCount() === 0;
}
function gateBadNameRejected(source) {
  var srv = newServer(source);
  var res = post(srv, 'cap-svg-name', [imageOf('evil.svg', ascii('<svg onload="alert(1)"/>'))]);
  return res.ok === false && res.error === 'bad_image_name' && srv.folderCount() === 0;
}
function gateDuplicateSlotRejected(source) {
  var srv = newServer(source);
  var res = post(srv, 'cap-dupe-slot', [
    imageOf('front.jpg', syntheticJpeg('a')),
    imageOf('front.jpg', syntheticJpeg('b'))
  ]);
  return res.ok === false && res.error === 'duplicate_image_slot' && srv.folderCount() === 0;
}
function gateBadBase64Rejected(source) {
  var srv = newServer(source);
  var res = post(srv, 'cap-badb64-ct', [{ name: 'front.jpg', mime: 'image/jpeg', dataB64: '!!! not base64 !!!' }]);
  return res.ok === false && res.error === 'bad_image_data' && srv.folderCount() === 0;
}

var STANDING_GATES = [
  { id: 'empty-image', fn: gateEmptyRejected, why: '빈 바이트는 거절된다' },
  { id: 'oversize-image', fn: gateOversizeRejected, why: '8MB 초과는 거절된다' },
  { id: 'bad-image-name', fn: gateBadNameRejected, why: '.svg 파일 이름은 슬롯 allowlist에서 거절된다' },
  { id: 'duplicate-slot', fn: gateDuplicateSlotRejected, why: '같은 슬롯 두 장은 거절된다' },
  { id: 'bad-base64', fn: gateBadBase64Rejected, why: '깨진 base64는 거절된다' }
];

STANDING_GATES.forEach(function (gate) {
  runCase('standing/' + gate.id, gate.why + ' (이미 성립 — 고정만 한다)', function () {
    check(gate.fn() === true, gate.why + ' — 이 방어가 사라졌다');
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   4. 회귀 주입 — 위 게이트가 형식적이지 않음을 증명한다

   디스크의 Code.gs는 건드리지 않는다. 원본 문자열을 메모리에서 변형해 sandbox에 넣고,
   "일부러 깨면 게이트가 정말 FAIL하는가"를 매 실행마다 확인한다. 앵커가 사라지면
   조용히 통과하지 않고 **여기서 터진다** — 검증 경로가 바뀌었다는 신호다.
   ══════════════════════════════════════════════════════════════════════════ */
function injected(replacements) {
  var src = sandboxLib.serverSource();
  replacements.forEach(function (pair) {
    var occurrences = src.split(pair[0]).length - 1;
    if (occurrences !== 1) {
      throw new Error('회귀 주입 앵커가 Code.gs에 정확히 1번 나오지 않는다(' + occurrences + '번). ' +
        '업로드 검증 경로가 바뀌었다 — 이 게이트가 여전히 그 경로를 덮는지 확인하고 앵커를 고쳐라.\n앵커: ' + pair[0]);
    }
    src = src.replace(pair[0], pair[1]);
  });
  return src;
}

var A_SIZE_CAP = "      if (bytes.length > 8 * 1024 * 1024) return json_({ ok: false, error: 'image_too_large', file: slot });";
var A_BAD_B64 = "        return json_({ ok: false, error: 'bad_image_data', file: slot });";
var A_DUP_SLOT = "      if (usedSlots[slot]) return json_({ ok: false, error: 'duplicate_image_slot', file: slot });";
var A_SLOT_NAME = '      var slot = captureSlotName_(img.name);';
var A_PLAN_PUSH = "      planned.push({ slot: slot, bytes: bytes, mime: img.mime || 'image/jpeg' });";
var A_SLOT_CONST = "var CAPTURE_IMAGE_SLOTS = ['front.jpg', 'back.jpg'];";

var INJECTIONS = [
  {
    id: 'size-cap-removed', gate: gateOversizeRejected,
    patch: [[A_SIZE_CAP, '']],
    why: '크기 상한 줄을 지우면 oversize 게이트가 FAIL해야 한다'
  },
  {
    /* base64 디코드 실패를 명시적 오류 코드 대신 밖으로 던지게 만든다 — 바깥 catch가
       `server_error`로 감싸므로 거절은 유지되지만 "클라이언트 페이로드가 잘못됐다"는
       사실이 사라지고 `detail`에 내부 예외 문자열이 실린다. */
    id: 'bad-b64-code-removed', gate: gateBadBase64Rejected,
    patch: [[A_BAD_B64, '        throw decodeErr;']],
    why: 'base64 실패의 명시적 코드를 없애면 bad-base64 게이트가 FAIL해야 한다'
  },
  {
    id: 'dup-slot-check-removed', gate: gateDuplicateSlotRejected,
    patch: [[A_DUP_SLOT, '']],
    why: '중복 슬롯 검사를 지우면 dup 게이트가 FAIL해야 한다'
  },
  {
    /* ISS-000108을 그대로 재현한다: 이름을 거절하지 않고 문자만 걸러 통과시키던 예전 방식. */
    id: 'slot-allowlist-reverted', gate: gateBadNameRejected,
    patch: [[A_SLOT_NAME, "      var slot = String(img.name || 'image.jpg').replace(/[^A-Za-z0-9._-]/g, '');"]],
    why: '슬롯 allowlist를 예전 sanitize 방식으로 되돌리면 이름 게이트가 FAIL해야 한다'
  }
];

INJECTIONS.forEach(function (injection) {
  runCase('injection/' + injection.id, injection.why, function () {
    var brokenSource = injected(injection.patch);
    check(injection.gate() === true, '전제 확인 실패 — 주입 전 원본에서 게이트가 이미 성립하지 않는다');
    check(injection.gate(brokenSource) === false,
      '서버를 일부러 깼는데 게이트가 그대로 통과했다 — 이 게이트는 형식적이며 아무것도 지키지 않는다');
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   5. 제안 패치 예행 — 다음 배포 사이클에 Code.gs로 갈 정확한 텍스트

   여기 있는 문자열이 최종 보고서의 패치 제안과 같은 텍스트다. 이 케이스는
   그 패치를 메모리 사본에 적용해 corpus를 실제로 막는지 매 실행마다 확인한다.
   즉 MAGIC_BYTE_ENFORCED를 뒤집기 전에 이미 "뒤집으면 green이 된다"가 증명돼 있다.

   ⚠ 이것은 배포된 서버가 아니다. 디스크의 Code.gs에는 이 패치가 없다.
   ══════════════════════════════════════════════════════════════════════════ */
var PROPOSED_ISJPEG = [
  '',
  '/* 업로드 바이트가 실제로 JPEG인가 (FI-012).',
  '',
  '   이름(captureSlotName_)과 크기는 이미 서버가 소유하는데 **내용은 아직 아니었다.**',
  "   `mime: 'image/jpeg'`라고 주장하며 PNG·PDF·ZIP·HTML·SVG·순수 텍스트를 front.jpg로",
  '   저장할 수 있었고, 처리 파이프라인은 receipt의 files를 보고 그것을 명함 사진으로 다뤘다.',
  '',
  '   두 클라이언트(frontend camera.ts / docs legacy.html)는 기본 카메라로 고른 파일까지',
  "   canvas `toDataURL('image/jpeg', ...)`로 재인코딩한다 — 정상 업로드는 예외 없이",
  '   SOI(FF D8 FF)로 시작해 EOI(FF D9)로 끝나는 canvas JPEG이다. 그래서 두 끝을 다 본다:',
  '   헤더만 보면 "앞은 JPEG, 뒤는 HTML"인 폴리글롯을 못 막는다.',
  '',
  '   GAS `Utilities.base64Decode`는 부호 있는 Byte[]를 준다(0xFF는 -1). 반드시 `& 0xFF`로',
  '   비교한다. 인덱스와 length 외의 Array 메서드는 런타임에 따라 없을 수 있으므로 쓰지 않는다.',
  '',
  '   한계(의도적): 이것은 content-type 검사이지 완전한 JPEG 파서가 아니다. SOI/EOI를 갖춘',
  '   채로 COM·EXIF 세그먼트 안에 스크립트를 숨긴 폴리글롯은 여전히 통과한다. 그 표면은',
  '   이미지 바이트를 브라우저에 이미지가 아닌 것으로 해석시키지 않는 것(서버 소유 MIME)과',
  '   처리 파이프라인의 write allowlist가 함께 막는다. */',
  "var CAPTURE_IMAGE_MIME = 'image/jpeg';",
  '',
  'function isJpegBytes_(bytes) {',
  '  if (!bytes || bytes.length < 4) return false;',
  '  if ((bytes[0] & 0xFF) !== 0xFF || (bytes[1] & 0xFF) !== 0xD8 || (bytes[2] & 0xFF) !== 0xFF) return false;',
  '  if ((bytes[bytes.length - 2] & 0xFF) !== 0xFF || (bytes[bytes.length - 1] & 0xFF) !== 0xD9) return false;',
  '  return true;',
  '}'
].join('\n');

var PROPOSED_PATCH = [
  [A_SLOT_CONST, A_SLOT_CONST + '\n' + PROPOSED_ISJPEG],
  [A_PLAN_PUSH,
    "      if (!isJpegBytes_(bytes)) return json_({ ok: false, error: 'bad_image_content', file: slot });\n" +
    '      planned.push({ slot: slot, bytes: bytes, mime: CAPTURE_IMAGE_MIME });']
];

runCase('proposed-patch-rehearsal',
  '보고서의 패치 텍스트를 메모리 사본에 적용하면 corpus가 실제로 막히고 정상 JPEG은 통과한다', function () {
    var patched = injected(PROPOSED_PATCH);

    CORPUS.forEach(function (entry) {
      var srv = newServer(patched);
      var id = 'cap-fix-' + entry.id;
      var res = post(srv, id, [imageOf('front.jpg', entry.buf)]);
      if (entry.legit) {
        check(res.ok === true, '패치가 정상 JPEG을 거절한다 — 배포하면 모든 캡처가 죽는다: ' + JSON.stringify(res));
        return;
      }
      check(res.ok === false && res.error === 'bad_image_content',
        '패치를 적용해도 ' + entry.id + '이 막히지 않는다(' + entry.defeats + ' 몫): ' + JSON.stringify(res));
      check(srv.folderCount() === 0, '패치 적용 후에도 거절된 업로드가 폴더를 남긴다: ' + entry.id);
    });

    /* MIME 소유권도 같은 패치에 들어간다. */
    var srvMime = newServer(patched);
    var mimeRes = post(srvMime, 'cap-fix-mime', [imageOf('front.jpg', syntheticJpeg('m'), 'text/html')]);
    check(mimeRes.ok === true, '패치 후 진짜 JPEG이 거절됐다: ' + JSON.stringify(mimeRes));
    var blob = storedBlob(srvMime, 'cap-fix-mime', 'front.jpg');
    check(blob !== null && blob.mime === 'image/jpeg',
      '패치 후에도 Drive MIME을 클라이언트가 정한다: ' + (blob && blob.mime));

    /* 이미 성립하던 방어가 패치로 무너지지 않는다. */
    STANDING_GATES.forEach(function (gate) {
      check(gate.fn(patched) === true, '패치가 기존 방어를 깼다: ' + gate.id);
    });

    /* 패치 없는 현재 서버에서는 같은 corpus가 통과한다 — 결함이 실재한다는 대조군. */
    var leaked = CORPUS.filter(function (entry) {
      if (entry.legit) return false;
      var srv = newServer();
      return post(srv, 'cap-now-' + entry.id, [imageOf('front.jpg', entry.buf)]).ok === true;
    });
    check(leaked.length === CORPUS.length - 1,
      '패치 없는 현재 서버에서 통과하는 페이로드 수가 예상과 다르다: ' + leaked.length +
      '/' + (CORPUS.length - 1) + ' — 서버가 이미 일부를 막고 있다면 이 게이트의 전제를 다시 써야 한다');
  });

/* ══════════════════════════════════════════════════════════════════════════
   6. 패치를 잘못 쓰는 두 가지 방법을 하네스가 실제로 잡는가

   제안 패치의 `& 0xFF`와 "Array 메서드 금지"는 주석에 적힌 권고가 아니라 기계가
   잡아 주는 규칙이어야 한다. 그렇지 않으면 다음 구현자가 무심코 어기고 운영에서
   처음 발견한다 — GAS Byte[]는 부호 있는 값이라 0xFF가 -1로 오므로, 부호를 무시한
   검사는 **정상 명함 사진을 전부 거절한다**(장애 등급).
   ══════════════════════════════════════════════════════════════════════════ */
runCase('patch-fidelity-guard',
  '부호를 무시한 magic 검사와 Array 메서드에 기댄 검사는 하네스에서 즉시 드러난다', function () {
    function withCheck(fnBody) {
      return injected([
        [A_SLOT_CONST, A_SLOT_CONST + '\n' + fnBody],
        [A_PLAN_PUSH,
          "      if (!isJpegBytes_(bytes)) return json_({ ok: false, error: 'bad_image_content', file: slot });\n" +
          "      planned.push({ slot: slot, bytes: bytes, mime: 'image/jpeg' });"]
      ]);
    }
    function uploadGoodJpeg(source) {
      var srv = newServer(source);
      return post(srv, 'cap-fidelity', [imageOf('front.jpg', syntheticJpeg('fidelity'))]);
    }

    /* 부호를 무시한 검사: GAS Byte[]에서 0xFF는 -1이라 정상 JPEG조차 통과하지 못한다. */
    var naive = uploadGoodJpeg(withCheck(
      'function isJpegBytes_(b) { if (!b || b.length < 4) return false; ' +
      'return b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF && ' +
      'b[b.length - 2] === 0xFF && b[b.length - 1] === 0xD9; }'));
    check(naive.ok === false && naive.error === 'bad_image_content',
      '부호를 무시한 magic 검사가 하네스에서 그대로 통과했다 — 하네스가 GAS Byte[]의 부호를 흉내내지 ' +
      '못하고 있다. 이 상태라면 잘못된 패치가 green으로 배포되어 정상 캡처를 전부 거절한다. 응답: ' + JSON.stringify(naive));

    /* Array 메서드는 GAS 런타임 보장이 없다 — 조용히 통과시키지 말고 여기서 터져야 한다. */
    var sliced = uploadGoodJpeg(withCheck(
      'function isJpegBytes_(b) { if (!b || b.length < 4) return false; ' +
      'var head = b.slice(0, 3); return (head[0] & 0xFF) === 0xFF; }'));
    check(sliced.ok === false && sliced.error === 'server_error',
      'Array 메서드에 기댄 검사가 하네스에서 통과했다 — 런타임 보장이 없는 API를 쓴 패치가 그대로 ' +
      '배포될 수 있다. 응답: ' + JSON.stringify(sliced));

    /* 대조군: 제안 패치의 방식(`& 0xFF` + 인덱스만)은 정상 JPEG을 통과시킨다. */
    var correct = uploadGoodJpeg(injected(PROPOSED_PATCH));
    check(correct.ok === true,
      '제안 패치 방식이 정상 JPEG을 거절한다 — 대조군이 깨지면 위 두 판정이 무의미하다: ' + JSON.stringify(correct));
  });

/* ══════════════════════════════════════════════════════════════════════════
   판정
   ══════════════════════════════════════════════════════════════════════════ */
cases.forEach(function (c) {
  console.log('  ' + (c.ok ? 'pass' : 'FAIL') + '  ' + pad(c.name, 34) + ' — ' + c.claim);
});

if (!MAGIC_BYTE_ENFORCED && notes.length) {
  console.log('');
  console.log('  ── 현재 서버가 받아들이는 비-이미지 페이로드 (결함 대장) ──');
  notes.forEach(function (line) { console.log(line); });
}

console.log('');
console.log('  denominator: cases=' + cases.length +
  ' pass=' + cases.filter(function (c) { return c.ok; }).length +
  ' fail=' + cases.filter(function (c) { return !c.ok; }).length +
  ' corpus=' + CORPUS.length + ' 주입=' + INJECTIONS.length +
  ' MAGIC_BYTE_ENFORCED=' + MAGIC_BYTE_ENFORCED);

if (failures.length) {
  console.error('');
  console.error('FAIL upload content type (' + failures.length + '건)');
  failures.forEach(function (line) { console.error('  - ' + line); });
  if (MAGIC_BYTE_ENFORCED) {
    console.error('');
    console.error('  MAGIC_BYTE_ENFORCED = true 로 돌렸다. 위 FAIL이 곧 결함의 증명이다:');
    console.error('  현재 Code.gs의 doPost는 업로드 바이트를 한 번도 보지 않는다.');
    console.error('  proposed-patch-rehearsal 케이스가 이 결함을 막는 정확한 패치를 들고 있다.');
  }
  process.exit(1);
}

console.log('');
if (MAGIC_BYTE_ENFORCED) {
  console.log('PASS upload content type: magic-byte/MIME 실검증 전면 강제 · 폴리글롯 거절 · 기존 방어 유지');
} else {
  console.log('  ──────────────────────────────────────────────────────────────────────');
  console.log('  TRIPWIRE  MAGIC_BYTE_ENFORCED = false');
  console.log('  서버는 아직 업로드 바이트를 보지 않는다. 위 ' + (CORPUS.length - 1) + '건은 "막힌다"가 아니라');
  console.log('  "지금 통과한다"를 기록한 것이다. Code.gs가 magic-byte/MIME 실검증을 얻으면');
  console.log('  이 단언들이 깨진다 — 그때 이 파일 상단의 상수를 true로 뒤집어라.');
  console.log('  (단언을 지워서 green을 만들면 이 파일은 아무것도 지키지 않는다.)');
  console.log('  ──────────────────────────────────────────────────────────────────────');
  console.log('');
  console.log('PASS upload content type: 현재 결함 기록 · 기존 방어 고정 · 회귀 주입 · 제안 패치 예행');
}
