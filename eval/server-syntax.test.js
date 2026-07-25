'use strict';

var fs = require('fs');
var path = require('path');
var source = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
new Function(source);
console.log('PASS server syntax: Code.gs');
