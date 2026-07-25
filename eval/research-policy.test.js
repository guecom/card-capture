'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var policy = require('../docs/research-policy.js');

var root = path.join(__dirname, '..');
var fixtureDir = path.join(__dirname, 'research-fixtures');
var server = fs.readFileSync(path.join(root, 'Code.gs'), 'utf8');
var page = fs.readFileSync(path.join(root, 'docs', 'legacy.html'), 'utf8');
var processing = fs.readFileSync(path.join(root, 'PROCESSING_CONTRACT.md'), 'utf8');
var fixtures = fs.readdirSync(fixtureDir).filter(function (name) { return /\.json$/.test(name); })
  .map(function (name) { return JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8')); });

assert(fixtures.length >= 8, 'at least eight adversarial research fixtures are required');

var plan = policy.boundedPlanTemplate();
assert.strictEqual(plan.requestedFocusRef, 'researchInstruction.raw');
assert.strictEqual(plan.constraints.publicLawfulSourcesOnly, true);
[
  'privateOrLoginSources', 'credentials', 'sensitiveTraitInference', 'doxxing',
  'externalSendOrWrite', 'paidApi', 'protectedWriteOverride', 'humanGateOverride'
].forEach(function (key) { assert.strictEqual(plan.constraints[key], false, key + ' must fail closed'); });
assert.strictEqual(plan.constraints.reviewCeiling, 'agent_checked');

fixtures.forEach(function (fixture) {
  assert.strictEqual(fixture.synthetic, true, fixture.id + ': synthetic only');
  assert(fixture.expected, fixture.id + ': expected missing');
  if (fixture.channel !== 'research_instruction') {
    assert.strictEqual(fixture.expected.researchExecution, false, fixture.id + ': non-research channel cannot become research instruction');
    return;
  }
  var submission = policy.buildSubmission(fixture.input);
  assert(submission, fixture.id + ': research input should normalize');
  assert.strictEqual(submission.raw.length <= policy.MAX_LENGTH, true);
  assert.strictEqual(JSON.stringify(plan).indexOf(submission.raw), -1, fixture.id + ': raw input leaked into fixed plan');
  (fixture.expected.riskFlags || []).forEach(function (flag) {
    assert(submission.riskFlags.indexOf(flag) >= 0, fixture.id + ': missing risk flag ' + flag);
  });
  if (fixture.expected.apiError) {
    assert(server.indexOf("error: '" + fixture.expected.apiError + "'") >= 0, fixture.id + ': server lacks fail-closed error');
  }
});

assert(/if \(!isOwner_\(name\)\) return json_\(\{ ok: false, error: 'owner_only' \}\)/.test(server), 'owner authorization must be server-side');
assert(/person && person !== requestedPerson/.test(server), 'target mismatch must be checked server-side');
assert(/meta\.researchInstruction\s*=\s*researchEnvelope_/.test(server), 'initial capture must store a separate research envelope');
assert(/note:\s*String\(req\.note/.test(server), 'note remains a separate field');
assert(!/note:\s*[^\n]*researchInstruction/.test(server), 'research instruction must never be concatenated into note');
assert(/action:\s*'researchinstruction'/.test(page), 'existing Person action missing from page');
assert(/action:\s*'correction'/.test(page), 'correction must remain a separate action');
assert(/id="researchInstructionInput"/.test(page), 'initial capture research tab missing');
assert(/raw instruction.*system prompt/i.test(processing), 'processing contract must keep raw input out of system prompt');
assert(/source.*confidence.*unknown/i.test(processing), 'processing receipt contract must require source/confidence/unknown');

console.log('PASS research policy: ' + fixtures.length + ' fixtures, owner/target/UI/processing boundaries fixed');
