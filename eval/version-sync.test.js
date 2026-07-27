/*
 * 배포된 앱이 자기 릴리즈 버전을 정확히 말하는가.
 *
 * 왜 이 게이트가 있나 — 실측된 결함:
 *   v2.13.0(`c763892`)을 배포하고 실제 앱을 열어 보니 설정 화면이 `버전 2.12.0`이라고 말했다.
 *   `frontend/package.json`의 version이 릴리즈 tag보다 한 칸 뒤처져 있었기 때문이다.
 *   원인은 절차였다: CHANGELOG의 `[Unreleased]`를 `## vX.Y.Z`로 바꾸고 package.json을 올리는 일이
 *   **tag 생성 뒤** 다음 통합에서 일어나서, 정작 tag가 붙는 커밋에는 옛 버전이 담겼다.
 *   사용자가 "버전 2.12.0"이라고 알려 주면 우리는 틀린 커밋을 들여다보게 된다.
 *
 * 계약: 릴리즈 커밋에서 다음 셋이 같은 값이어야 한다.
 *   frontend/package.json 의 version
 *   CHANGELOG.md 의 가장 위 릴리즈 heading (`## vX.Y.Z`)
 *   그 커밋에 붙일 git tag (`vX.Y.Z`)
 *
 * **셋째(tag)를 빼면 이 게이트에는 구멍이 남는다.** 처음에 이 파일은 앞의 둘만 비교하고
 * "둘이 맞으면 tag도 맞는다"고 적었다. 그런데 실제 결함은 그렇게 일어나지 않았다 —
 * v2.13.0을 tag했을 때 `package.json`도 CHANGELOG heading도 **둘 다** 2.12.0에 멈춰 있었다.
 * 서로 일치하므로 앞의 두 검사만으로는 조용히 통과한다. 실측:
 *
 *   main(def1a0d): package.json=2.12.0, 최신 heading=v2.12.0, **git tag=v2.13.0**
 *
 * 그래서 tag를 세 번째 축으로 직접 읽는다. **CHANGELOG에 기록되지 않은 릴리즈 tag가
 * 존재하면 FAIL이다** — 그것이 "배포했는데 아무도 적지 않았다"의 정확한 신호다.
 *
 * tag를 읽을 수 없는 환경(shallow clone 등)에서는 pass로 세지 않고 **분모에 미검증으로
 * 남긴다.** 조용한 통과가 이 게이트가 막으려는 바로 그 실패 양식이기 때문이다.
 * (`.github/workflows/validate.yml`의 checkout이 `fetch-depth: 0`이어야 CI에서 tag가 보인다.)
 *
 * `[Unreleased]`는 그대로 둔다. 아직 이름 없는 변화가 쌓이는 자리이고
 * `scripts/validate.ps1`도 그 존재를 확인한다. 이 게이트는 그 아래 첫 릴리즈 heading만 본다.
 */
'use strict';
var fs = require('fs');
var path = require('path');
var cp = require('child_process');
var assert = require('assert');

var root = path.join(__dirname, '..');
var pkg = JSON.parse(fs.readFileSync(path.join(root, 'frontend', 'package.json'), 'utf8'));
var changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');

var pass = 0;
var fails = [];
var unverified = [];
function check(ok, label, actual, expected) {
  if (ok) { pass++; return; }
  fails.push(label + (actual === undefined ? '' : '\n      실제: ' + JSON.stringify(actual) + '\n      기대: ' + JSON.stringify(expected)));
}

/* CHANGELOG의 릴리즈 heading을 위에서부터 전부 뽑는다. `## [Unreleased]`는 버전이 아니라 건너뛴다. */
var headings = [];
changelog.split(/\r?\n/).forEach(function (line) {
  var m = /^##\s+v(\d+\.\d+\.\d+)\b/.exec(line);
  if (m) headings.push(m[1]);
});

check(headings.length > 0, 'CHANGELOG에 `## vX.Y.Z` 릴리즈 heading이 하나도 없다');
if (!headings.length) { report(); }

var newest = headings[0];

check(/^\d+\.\d+\.\d+$/.test(pkg.version),
  'frontend/package.json 의 version이 X.Y.Z 형식이 아니다', pkg.version, 'X.Y.Z');

check(pkg.version === newest,
  'frontend/package.json 의 version이 CHANGELOG 최신 릴리즈 heading과 다르다 — ' +
  '이 커밋에 tag를 붙이면 앱이 자기 버전을 틀리게 말한다. ' +
  'RELEASE.md의 릴리즈 절차대로 heading 작성과 package.json 올림을 **tag 전에, 같은 커밋에서** 해라',
  pkg.version, newest);

/* heading이 내림차순인지 — 과거 릴리즈를 위에 잘못 끼워 넣으면 최신 판정이 깨진다. */
function cmp(a, b) {
  var x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (var i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] - y[i]; }
  return 0;
}
var ordered = headings.every(function (v, i) { return i === 0 || cmp(headings[i - 1], v) > 0; });
check(ordered, 'CHANGELOG 릴리즈 heading이 최신순이 아니다 — 최신 판정이 깨진다', headings.slice(0, 5), '내림차순');

/* 중복 heading 금지 — 같은 버전을 두 번 적으면 어느 것이 진실인지 알 수 없다. */
var dupes = headings.filter(function (v, i) { return headings.indexOf(v) !== i; });
check(dupes.length === 0, 'CHANGELOG에 같은 버전 heading이 두 번 이상 있다', dupes, []);

/* 세 번째 축 — 실제로 붙어 있는 릴리즈 tag. 여기서만 "배포했는데 적지 않았다"가 잡힌다. */
var tags = null;
try {
  tags = cp.execFileSync('git', ['tag', '--list', 'v*'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split(/\r?\n/)
    .map(function (t) { var m = /^v(\d+\.\d+\.\d+)$/.exec(t.trim()); return m ? m[1] : null; })
    .filter(Boolean);
} catch (e) { tags = null; }

if (!tags || !tags.length) {
  /* pass로 세지 않는다. 조용한 통과가 이 게이트가 막으려는 실패 양식이다. */
  unverified.push('릴리즈 tag를 읽지 못해 "기록되지 않은 릴리즈" 검사를 못 했다' +
    (tags ? ' (tag 0건 — shallow clone이면 checkout에 fetch-depth: 0을 줘라)' : ' (git 실행 실패)'));
} else {
  var newestTag = tags.slice().sort(cmp).pop();
  check(cmp(newestTag, newest) <= 0,
    'CHANGELOG에 기록되지 않은 릴리즈 tag가 있다 — 배포는 됐는데 아무도 적지 않았다. ' +
    'tag가 붙는 커밋에서 heading과 package.json을 함께 확정해라 (RELEASE.md 1단계)',
    'tag v' + newestTag, 'CHANGELOG 최신 heading v' + newest + ' 이하');
}

report();

function report() {
  console.log('  denominator: checks=' + (pass + fails.length + unverified.length) +
    ' pass=' + pass + ' fail=' + fails.length + ' unverified=' + unverified.length +
    ' | package.json=' + pkg.version + ' newestHeading=' + (headings[0] || '(없음)') +
    ' headings=' + headings.length);
  unverified.forEach(function (u) { console.log('  UNVERIFIED ' + u); });
  if (fails.length) {
    console.error('\nFAIL version sync (' + fails.length + '건)');
    fails.forEach(function (f) { console.error('  - ' + f); });
    process.exit(1);
  }
  console.log('PASS version sync: 배포될 앱이 말할 버전과 CHANGELOG 최신 릴리즈가 일치한다');
  process.exit(0);
}
