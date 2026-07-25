'use strict';

var assert = require('assert');
var vision = require('../docs/camera-quality.js');

function quad(dx) {
  dx = dx || 0;
  return [
    { x: 20 + dx, y: 20 }, { x: 180 + dx, y: 20 },
    { x: 180 + dx, y: 110 }, { x: 20 + dx, y: 110 }
  ];
}

function sample(overrides) {
  var value = {
    detected: true,
    plausible: true,
    quad: quad(),
    frameWidth: 200,
    frameHeight: 130,
    blur: 90,
    clippedRatio: 0.2
  };
  Object.keys(overrides || {}).forEach(function (key) { value[key] = overrides[key]; });
  return value;
}

var gate = vision.blankGate();
gate = vision.nextAutoGate(gate, { detected: false }, 0);
assert.strictEqual(gate.fired, false, 'card absence must never fire');
assert.strictEqual(gate.reason, 'searching');

gate = vision.blankGate();
[0, 180, 360, 540].forEach(function (now) {
  gate = vision.nextAutoGate(gate, sample(), now);
  assert.strictEqual(gate.fired, false, 'stable card must wait for the full gate');
});
gate = vision.nextAutoGate(gate, sample(), 720);
assert.strictEqual(gate.fired, true, 'stable, sharp card should auto-capture inside two seconds');

gate = vision.nextAutoGate(vision.blankGate(), sample(), 0);
gate = vision.nextAutoGate(gate, sample({ quad: quad(30) }), 180);
assert.strictEqual(gate.stableFrames, 1, 'large movement must reset the stability streak');
assert.strictEqual(gate.fired, false);

gate = vision.nextAutoGate(vision.blankGate(), sample({ blur: 20 }), 0);
assert.strictEqual(gate.reason, 'blur', 'blurred card must be rejected');
assert.strictEqual(gate.stableFrames, 0);

gate = vision.nextAutoGate(vision.blankGate(), sample({ clippedRatio: 0.98 }), 0);
assert.strictEqual(gate.reason, 'glare', 'severely clipped frame must be rejected');
assert.strictEqual(gate.stableFrames, 0);

var pixels = new Uint8ClampedArray([
  255, 255, 255, 255,
  249, 249, 249, 255,
  80, 90, 100, 255,
  0, 0, 0, 255
]);
assert.strictEqual(vision.clippedRatio({ data: pixels }, 250), 0.25, 'only clipped white pixels count');

assert.strictEqual(
  vision.nameCandidate('주식회사 카이렌\n김하늘\n대표이사\n010-1234-5678'),
  '김하늘',
  'Korean person name should beat organization and title text'
);
assert.strictEqual(
  vision.nameCandidate('Daniel Kim\nProduct Director\ndaniel@example.com'),
  'Daniel Kim',
  'English person name should be preserved'
);
assert.strictEqual(
  vision.nameCandidate('Kairen Inc.\nhello@example.com\n02-123-4567'),
  '',
  'organization and contact-only text must not invent a person name'
);

console.log('PASS camera-quality: 9 deterministic acceptance cases');
