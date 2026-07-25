'use strict';

var fs = require('fs');
var path = require('path');
var html = fs.readFileSync(path.join(__dirname, '..', 'docs', 'index.html'), 'utf8');
var scripts = Array.from(html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g));
if (!scripts.length) throw new Error('no inline script found');
scripts.forEach(function (match) { new Function(match[1]); });
console.log('PASS page syntax: ' + scripts.length + ' inline script block(s)');
