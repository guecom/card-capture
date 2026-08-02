'use strict';
/*
 * Committed Pages freshness gate — Kairen-Ref: TSK-000496
 *
 * Vite/Rolldown may emit byte-different minified chunks on different pinned
 * Node majors. Comparing a locally committed bundle with a CI rebuild therefore
 * produces a false failure even when both came from identical source. The app's
 * source build id is intentionally toolchain-independent, so verify the
 * committed bundle against that identity before CI rebuilds docs/next.
 */

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..');
var frontend = path.join(root, 'frontend');
var docsNext = path.join(root, 'docs', 'next');

function walk(dir, out) {
  out = out || [];
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
    if (['desktop.ini', 'Thumbs.db', '.DS_Store'].indexOf(entry.name) >= 0) return;
    var full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  });
  return out;
}

function sourceBuildId() {
  var runtime = JSON.parse(fs.readFileSync(path.join(root, 'config', 'public-runtime.json'), 'utf8'));
  if (typeof runtime.apiUrl !== 'string' ||
      !/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(runtime.apiUrl)) {
    throw new Error('public_runtime_api_missing');
  }
  var files = walk(path.join(frontend, 'src'));
  ['index.html', 'package.json', 'package-lock.json', 'vite.config.ts'].forEach(function (name) {
    files.push(path.join(frontend, name));
  });
  var keyed = files.map(function (full) {
    return { rel: path.relative(frontend, full).split(path.sep).join('/'), full: full };
  }).sort(function (a, b) { return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0; });
  var hash = crypto.createHash('sha256');
  keyed.forEach(function (item) {
    hash.update(item.rel);
    hash.update('\0');
    // Binary inputs must remain bytes; UTF-8 replacement behavior is not a
    // cross-Node-version source identity.
    var bytes = fs.readFileSync(item.full);
    hash.update(path.extname(item.full).toLowerCase() === '.woff2'
      ? bytes
      : bytes.toString('utf8').replace(/\r\n?/g, '\n'));
    hash.update('\0');
  });
  hash.update(runtime.apiUrl);
  return 'src-' + hash.digest('hex').slice(0, 12);
}

var expected = sourceBuildId();
var indexPath = path.join(docsNext, 'index.html');
var swPath = path.join(docsNext, 'sw.js');
var index = fs.readFileSync(indexPath, 'utf8');
var sw = fs.readFileSync(swPath, 'utf8');
var entryMatch = index.match(/<script[^>]+src="\.\/(assets\/index-[A-Za-z0-9_-]+\.js)"/);
if (!entryMatch) throw new Error('committed Pages index has no hashed entry script');
var entryRel = entryMatch[1];
var entryPath = path.join(docsNext, entryRel);
if (!fs.existsSync(entryPath)) throw new Error('committed Pages entry is missing: ' + entryRel);
var entry = fs.readFileSync(entryPath, 'utf8');
var ids = Array.from(new Set(entry.match(/src-[0-9a-f]{12}/g) || []));
if (ids.length !== 1 || ids[0] !== expected) {
  throw new Error('committed Pages source id mismatch: expected=' + expected + ' found=' + JSON.stringify(ids));
}
if (sw.indexOf('./' + entryRel) < 0) {
  throw new Error('committed Pages service worker does not precache entry: ' + entryRel);
}
var shellMatch = sw.match(/const SHELL = (\[[^;]+\]);/);
if (!shellMatch) throw new Error('committed Pages service worker has no SHELL manifest');
var shell = JSON.parse(shellMatch[1]);
var missing = shell.filter(function (item) {
  if (item === './') return false;
  return !fs.existsSync(path.join(docsNext, item.replace(/^\.\//, '')));
});
if (missing.length) throw new Error('committed Pages SHELL has missing files: ' + missing.join(', '));

console.log('PASS committed Pages bundle matches source identity ' + expected +
  ' and every service-worker shell artifact exists');
