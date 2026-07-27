'use strict';

/*
 * legacy(이전 앱) credential 경계 정적 검사 — Kairen-Ref: TSK-000286
 *
 * docs/legacy.html 은 GitHub Pages 루트에 React 앱과 **함께** 서빙되고 같은 저장 키
 * (cc_api·cc_token)를 쓴다. 그래서 legacy 화면 한 번이 React 앱의 origin pinning(FI-004)을
 * 무력화할 수 있다. 브라우저 없이도 무너진 순간 잡히도록 소스 수준 불변식을 고정한다.
 *
 * 행위 검증은 frontend/e2e/legacy-credential-boundary.spec.ts 가 담당한다.
 */

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var html = fs.readFileSync(path.join(__dirname, '..', 'docs', 'legacy.html'), 'utf8');
var head = html.slice(0, html.indexOf('</head>'));
var inline = Array.from(html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))
  .map(function (match) { return match[1]; }).join('\n');

/* 1. 신뢰 origin의 유일한 출처. scripts/validate.ps1 의 PWA sanity 검사도 이 줄에 걸려 있다. */
assert.ok(
  /var DEFAULT_API = 'https:\/\/script\.google\.com\/macros\/s\/[^']+\/exec';/.test(inline),
  'DEFAULT_API(빌드에 박힌 신뢰 origin) 줄이 사라졌거나 형태가 바뀌었다'
);

/* 2. 링크·저장소가 서버 주소를 넓히지 못한다. `?api=`를 저장하는 순간 경계가 무너진다. */
assert.ok(
  !/store\.set\(\s*'api'/.test(inline) && !/setItem\(\s*'cc_api'/.test(inline),
  'legacy가 API 주소를 저장하고 있다 — 링크로 받은 주소가 다음 실행에서 되살아난다'
);
assert.ok(
  !/store\.get\(\s*'api'\s*\)\s*\|\|/.test(inline),
  '저장된 API 주소를 DEFAULT_API보다 우선해 쓰고 있다'
);
var apiAssign = inline.match(/^\s*var API = .*$/m);
assert.ok(apiAssign, 'API 변수 초기화 줄을 찾지 못했다');
assert.ok(
  apiAssign[0].indexOf('DEFAULT_API') >= 0 && apiAssign[0].indexOf("store.get('api')") < 0,
  'API는 DEFAULT_API에서만 나와야 한다: ' + apiAssign[0].trim()
);

/* 3. 신뢰 밖 주소가 이미 저장돼 있으면 폐기한다 (React storage.ts 와 같은 정신). */
assert.ok(
  /store\.del\(\s*'api'\s*\)|removeItem\(\s*'cc_api'\s*\)/.test(inline),
  '예전 빌드가 저장해 둔 cc_api를 제거하지 않는다'
);

/* 4. 개인 링크 코드를 주소창에서 지운다 — push가 아니라 replace여야 한다. */
assert.ok(/history\.replaceState\(/.test(inline), '주소창에서 링크 코드를 제거하지 않는다 (history.replaceState 없음)');
assert.ok(!/history\.pushState\(/.test(inline), 'pushState는 뒤로 가기로 코드가 실린 주소를 되살린다');
assert.ok(/delete\(\s*'k'\s*\)/.test(inline), "주소창 정리에서 'k'를 제거하지 않는다");
assert.ok(/delete\(\s*'api'\s*\)/.test(inline), "주소창 정리에서 'api'를 제거하지 않는다");

/* 5. referrer 정책은 <head>에 있어야 문서 파싱 중 나가는 자산 요청에도 적용된다. */
assert.ok(
  /<meta\s+name="referrer"\s+content="no-referrer"\s*\/?>/.test(head),
  '<head>에 <meta name="referrer" content="no-referrer">가 없다 — 링크 코드가 Referer로 나간다'
);

/* 6. legacy는 ES5 수준 인라인 스크립트다. page-syntax.test.js 는 파싱만 보므로 여기서 문법 수준을 고정한다. */
var es5Violations = [];
if (/=>/.test(inline)) es5Violations.push('arrow function');
if (/(^|[^.\w$])let\s+[A-Za-z_$]/.test(inline)) es5Violations.push('let');
if (/(^|[^.\w$])const\s+[A-Za-z_$]/.test(inline)) es5Violations.push('const');
assert.strictEqual(es5Violations.join(', '), '', 'legacy 인라인 스크립트에 ES5 밖 문법이 들어왔다');

/* 7. 화면 범위: 촬영·업로드·전송 상태뿐이다 (founder 결정, Kairen-Ref: TSK-000301).
 *
 * 행위 검증은 frontend/e2e/legacy-scope.spec.ts 가 담당한다. 여기서 소스 불변식을 함께 고정하는 이유는
 * 브라우저 없이 도는 scripts/validate.ps1 이 이 파일을 실행하기 때문이다 — 축소가 무너지면 CI 이전에 잡힌다.
 *
 * "버튼을 숨겼다"로는 통과할 수 없는 형태로 쓴다: 진입점 함수 선언과 action 문자열 자체를 금지한다.
 * 함수가 남아 있으면 전역이라 콘솔 한 줄로 그대로 호출되고, action 문자열이 남아 있으면
 * 인라인 핸들러로 우회할 수 있다.
 */
var removedActions = ['researchinstruction', 'persondoc', 'doc', 'search', 'addnote', 'correction'];
var presentActions = removedActions.filter(function (action) {
  return inline.indexOf("'" + action + "'") >= 0 || inline.indexOf('"' + action + '"') >= 0;
});
assert.strictEqual(presentActions.join(', '), '', '제거된 owner action 문자열이 legacy 소스에 남아 있다');

var removedEntryPoints = [
  'addNoteFlow', 'requestCorrection', 'openPersonDoc', 'openPersonDocById', 'runSearch',
  'researchInstructionFlow', 'canUseResearchInstruction', 'renderBriefs', 'renderPersonMd',
  'prepCardOf', 'contactRow', 'vcardDownload', 'briefNameMap', 'toggleSearchUI'
];
var presentEntryPoints = removedEntryPoints.filter(function (name) {
  return new RegExp('function\\s+' + name + '\\s*\\(').test(inline);
});
assert.strictEqual(presentEntryPoints.join(', '), '', 'owner 기능 진입점이 legacy에 함수로 남아 있다 — 전역이라 그대로 호출된다');

/* 조사 지시 정책 모듈을 싣지 않는다 — 실려 있으면 제출 경로를 다시 세울 수 있다. */
assert.ok(!/<script[^>]*src="research-policy\.js"/.test(html), 'legacy가 아직 research-policy.js를 싣는다');

/* 남겨야 하는 것: 전송·처리 상태 확인과 다시 처리 요청. 축소가 여기까지 먹으면 화면이 쓸모를 잃는다. */
assert.ok(/action=list/.test(inline), '전송·처리 상태 조회(list)가 사라졌다');
assert.ok(/action:\s*'requeue'/.test(inline), '다시 처리 요청(requeue)이 사라졌다');

/* 브리핑 전문·owner 게이트·검색 기록을 namespace 없는 전역 자리에 쓰지 않는다 (SECURITY.md 사적 상태 격리). */
['briefs', 'briefSeeAll', 'researchInstructionEnabled', 'recentSearches'].forEach(function (key) {
  assert.ok(
    !new RegExp("store\\.set\\(\\s*'" + key + "'").test(inline),
    'legacy가 제거된 기능의 사적 상태(' + key + ')를 아직 저장한다'
  );
});

console.log('PASS legacy credential boundary: pinned API, no stored api, scrubbed link code, no-referrer, ES5 inline, capture-only scope');
