'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var root = path.join(__dirname, '..');
var runtimePath = path.join(root, 'config', 'public-runtime.json');
var runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
var vite = fs.readFileSync(path.join(root, 'frontend', 'vite.config.ts'), 'utf8');
var index = fs.readFileSync(path.join(root, 'docs', 'index.html'), 'utf8');
var sw = fs.readFileSync(path.join(root, 'docs', 'sw.js'), 'utf8');

assert.deepStrictEqual(Object.keys(runtime), ['apiUrl'], 'public runtime config must expose only the sanctioned public endpoint');
assert(/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(runtime.apiUrl), 'pinned GAS endpoint malformed');
assert(vite.indexOf('../config/public-runtime.json') >= 0, 'Vite must build from the canonical public runtime config');
assert(vite.indexOf('public_runtime_api_missing') >= 0, 'build must fail closed when the runtime endpoint is absent');
assert.strictEqual(fs.existsSync(path.join(root, 'docs', 'legacy.html')), false, 'retired legacy app must not ship');
assert.strictEqual(/legacy\.html/.test(index + sw), false, 'root entry and service worker must not link or cache the retired app');
assert(/cardcapture-v21/.test(sw), 'root cache must be bumped so installed v20 caches are deleted on activation');

console.log('PASS public runtime credential boundary and legacy retirement');
