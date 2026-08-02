'use strict';

var fs = require('fs');
var path = require('path');
var pages = ['index.html'];
var total = 0;
pages.forEach(function (name) {
  var html = fs.readFileSync(path.join(__dirname, '..', 'docs', name), 'utf8');
  var scripts = Array.from(html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g));
  if (!scripts.length) throw new Error(name + ': no inline script found');
  scripts.forEach(function (match) { new Function(match[1]); });
  total += scripts.length;
});
console.log('PASS page syntax: ' + total + ' inline script block(s) in the current root entry');
