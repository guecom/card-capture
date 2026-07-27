'use strict';
/*
 * 빌드 재현성 게이트 — Kairen-Ref: TSK-000290
 *
 * 계약: `docs/next/**`는 커밋되는 빌드 산출물이다. 같은 소스에서 빌드하면 언제/어디서
 * 돌리든 **바이트 단위로 같은 산출물**이 나와야 한다. 그래야 "이 번들이 이 커밋에서
 * 나왔다"를 검증할 수 있고, 무의미한 diff가 쌓이지 않는다.
 *
 * 왜 그냥 두 번 빌드해서 비교하면 안 되는가 (게이트 전제 주의):
 *   벽시계가 산출물에 새더라도 그 값의 **granularity**가 빌드 시간보다 크면 연속 두 빌드는
 *   같은 값을 보고 통과해 버린다. 실측(2026-07-27, Node 24, TSK-000290):
 *     - `vite build` 1회 ≈ 0.6s (wall ≈ 2.3s)
 *     - 회귀 당시 새던 값의 granularity = 1분
 *     - 08:08:04 빌드와 08:08:17 빌드 = 26/26 파일 바이트 동일 → **결함이 있는데도 PASS**
 *     - 08:08 빌드와 08:10 빌드 = entry/index.html/sw.js 4개 파일 불일치 → FAIL
 *   즉 순진한 연속 2회 비교는 분 경계를 넘을 때만 터지는 ~8% 확률 flaky 게이트가 된다.
 *
 * 그래서 이 게이트는 **"달라도 산출물에 영향을 주면 안 되는 입력"을 일부러 다르게 준다**:
 * 두 빌드에 서로 다른 가짜 벽시계(연·월·일·시·분·초 전부 다름)와 서로 다른 타임존을
 * 주입하고, 산출물이 바이트 단위로 같기를 요구한다. 벽시계나 로캘이 번들에 새는 순간
 * 확률이 아니라 **항상** FAIL한다.
 *
 * 가짜 시계는 NODE_OPTIONS=--import 로 vite 프로세스에 주입한다(의존성 추가 없음).
 *
 * 산출물은 `eval/.work/`(gitignored) 아래로만 빌드한다. 이 게이트는 `docs/next`를
 * 건드리지 않으므로 validate.ps1 안에서 돌려도 작업 트리가 더러워지지 않는다.
 */

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var url = require('url');
var child_process = require('child_process');

var repoRoot = path.join(__dirname, '..');
var frontendDir = path.join(repoRoot, 'frontend');
var viteBin = path.join(frontendDir, 'node_modules', 'vite', 'bin', 'vite.js');
var workDir = path.join(__dirname, '.work', 'build-reproducibility');

// 두 빌드에 주입할 서로 다른 벽시계/타임존. 이 둘의 차이는 산출물에 나타나면 안 된다.
var RUNS = [
  { name: 'A', now: Date.UTC(2020, 0, 2, 3, 4, 5), tz: 'UTC' },
  { name: 'B', now: Date.UTC(2021, 5, 7, 8, 9, 10), tz: 'Asia/Seoul' }
];

var CLOCK_STUB = [
  '// 재현성 게이트용 고정 시계. NODE_OPTIONS=--import 로 주입된다.',
  'const FIXED = Number(process.env.CC_REPRO_FAKE_NOW);',
  'const RealDate = Date;',
  'class FakeDate extends RealDate {',
  '  constructor(...args) { if (args.length === 0) { super(FIXED); } else { super(...args); } }',
  '  static now() { return FIXED; }',
  '}',
  'globalThis.Date = FakeDate;',
  ''
].join('\n');

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function walk(dir, base, out) {
  base = base || dir;
  out = out || [];
  var entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.forEach(function (entry) {
    var full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full, base, out); }
    else { out.push(path.relative(base, full).split(path.sep).join('/')); }
  });
  return out.sort();
}

function digestTree(dir) {
  var map = new Map();
  walk(dir).forEach(function (rel) {
    var bytes = fs.readFileSync(path.join(dir, rel));
    map.set(rel, crypto.createHash('sha256').update(bytes).digest('hex'));
  });
  return map;
}

function runBuild(run, stubPath) {
  var outDir = path.join(workDir, 'out-' + run.name);
  rmrf(outDir);
  var env = Object.assign({}, process.env);
  env.CC_REPRO_FAKE_NOW = String(run.now);
  env.TZ = run.tz;
  env.NODE_OPTIONS = ((process.env.NODE_OPTIONS || '') +
    ' --import "' + url.pathToFileURL(stubPath).href + '"').trim();

  var started = Date.now();
  var result = child_process.spawnSync(
    process.execPath,
    [viteBin, 'build', '--outDir', outDir, '--emptyOutDir'],
    { cwd: frontendDir, env: env, encoding: 'utf8' }
  );
  var elapsed = Date.now() - started;

  if (result.error) { throw result.error; }
  if (result.status !== 0) {
    process.stderr.write(String(result.stdout || ''));
    process.stderr.write(String(result.stderr || ''));
    throw new Error('build ' + run.name + ' failed with exit code ' + result.status);
  }
  console.log('  build ' + run.name + ': clock=' + new Date(run.now).toISOString() +
    ' TZ=' + run.tz + ' -> ' + elapsed + 'ms');
  return { outDir: outDir, elapsed: elapsed };
}

function firstDivergence(fileA, fileB) {
  var a, b;
  try {
    a = fs.readFileSync(fileA, 'utf8');
    b = fs.readFileSync(fileB, 'utf8');
  } catch (err) { return null; }
  if (a === b) { return null; }
  var i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) { i++; }
  var j = 0;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) { j++; }
  return {
    offset: i,
    context: a.slice(Math.max(0, i - 80), i),
    onlyA: a.slice(i, a.length - j).slice(0, 200),
    onlyB: b.slice(i, b.length - j).slice(0, 200)
  };
}

if (!fs.existsSync(viteBin)) {
  throw new Error('vite not installed; run `npm ci --prefix frontend` first (' + viteBin + ')');
}

rmrf(workDir);
fs.mkdirSync(workDir, { recursive: true });
var stubPath = path.join(workDir, 'fixed-clock.mjs');
fs.writeFileSync(stubPath, CLOCK_STUB, 'utf8');

console.log('build reproducibility: 서로 다른 벽시계/타임존으로 2회 빌드 후 바이트 비교');
var totalStarted = Date.now();
var builds = RUNS.map(function (run) { return runBuild(run, stubPath); });
var digestA = digestTree(builds[0].outDir);
var digestB = digestTree(builds[1].outDir);
var totalElapsed = Date.now() - totalStarted;

var names = Array.from(new Set(Array.from(digestA.keys()).concat(Array.from(digestB.keys())))).sort();
var differing = names.filter(function (name) { return digestA.get(name) !== digestB.get(name); });

if (differing.length > 0) {
  console.log('');
  console.log('FAIL build is not reproducible: ' + differing.length + '/' + names.length +
    ' artifact(s) differ between two builds of identical source');
  differing.forEach(function (name) {
    console.log('  ' + name);
    console.log('    A=' + (digestA.get(name) || '(absent)'));
    console.log('    B=' + (digestB.get(name) || '(absent)'));
    if (digestA.has(name) && digestB.has(name)) {
      var d = firstDivergence(path.join(builds[0].outDir, name), path.join(builds[1].outDir, name));
      if (d) {
        console.log('    first divergence at byte ' + d.offset);
        console.log('    context ...' + JSON.stringify(d.context));
        console.log('    only in A ' + JSON.stringify(d.onlyA));
        console.log('    only in B ' + JSON.stringify(d.onlyB));
      }
    }
  });
  console.log('');
  console.log('  산출물이 소스가 아닌 무언가(벽시계·타임존·환경)에 의존한다.');
  console.log('  빌드 산출물이 ' + workDir + ' 에 남아 있으니 직접 비교해 보라.');
  console.log('  total ' + totalElapsed + 'ms');
  process.exit(1);
}

rmrf(workDir);
console.log('PASS build reproducibility: ' + names.length +
  ' artifact(s) byte-identical across builds with different wall clock and timezone' +
  ' (total ' + totalElapsed + 'ms)');
