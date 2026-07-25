(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CardCaptureVision = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULTS = {
    minStableFrames: 5,
    minStableMs: 650,
    maxDrift: 0.018,
    minBlur: 45,
    maxClippedRatio: 0.92
  };

  function blankGate() {
    return {
      stableFrames: 0,
      stableSince: 0,
      lastQuad: null,
      progress: 0,
      fired: false,
      reason: 'searching'
    };
  }

  function quadDrift(previous, current, frameWidth, frameHeight) {
    if (!previous || !current || previous.length !== 4 || current.length !== 4) return Infinity;
    var diagonal = Math.hypot(frameWidth || 1, frameHeight || 1) || 1;
    var total = 0;
    for (var i = 0; i < 4; i++) {
      total += Math.hypot(previous[i].x - current[i].x, previous[i].y - current[i].y);
    }
    return total / 4 / diagonal;
  }

  function clippedRatio(imageData, threshold) {
    if (!imageData || !imageData.data || !imageData.data.length) return 0;
    var data = imageData.data;
    var cut = threshold || 250;
    var clipped = 0;
    for (var i = 0; i < data.length; i += 4) {
      if (data[i] >= cut && data[i + 1] >= cut && data[i + 2] >= cut) clipped++;
    }
    return clipped / (data.length / 4);
  }

  function nameCandidate(text) {
    var lines = String(text || '').split(/\r?\n/).map(function (line) {
      return line.replace(/\s+/g, ' ').trim();
    }).filter(Boolean);
    var blocked = /주식회사|유한회사|회사|그룹|센터|연구소|대학교|병원|협회|대표이사|대표|이사|부장|차장|과장|팀장|매니저|director|manager|president|company|corporation|corp\.?|inc\.?|ltd\.?|team/i;
    var candidates = [];
    lines.forEach(function (line, lineIndex) {
      if (/@|https?:|www\.|\d{3}[-.)]/i.test(line)) return;
      var ko = line.match(/[가-힣]{2,4}/g) || [];
      ko.forEach(function (word) {
        if (blocked.test(word)) return;
        var score = 70 + (line === word ? 48 : 0) + (line.length <= 12 ? 18 : 0) - lineIndex * 2 - (blocked.test(line) ? 24 : 0);
        candidates.push({ name: word, score: score });
      });
      var en = line.match(/\b[A-Z][A-Za-z'.-]{1,20}(?:\s+[A-Z][A-Za-z'.-]{1,20}){1,2}\b/g) || [];
      en.forEach(function (word) {
        if (blocked.test(word)) return;
        candidates.push({ name: word, score: 90 + (line === word ? 32 : 0) - lineIndex * 2 });
      });
    });
    candidates.sort(function (a, b) { return b.score - a.score; });
    return candidates.length ? candidates[0].name : '';
  }

  function nextAutoGate(previous, sample, now, overrides) {
    var cfg = {};
    Object.keys(DEFAULTS).forEach(function (k) { cfg[k] = DEFAULTS[k]; });
    Object.keys(overrides || {}).forEach(function (k) { cfg[k] = overrides[k]; });
    var old = previous || blankGate();
    var next = blankGate();

    if (!sample || !sample.detected || !sample.plausible || !sample.quad) return next;
    next.lastQuad = sample.quad.map(function (p) { return { x: p.x, y: p.y }; });

    if (sample.blur !== null && typeof sample.blur !== 'undefined' && sample.blur < cfg.minBlur) {
      next.reason = 'blur';
      return next;
    }
    if (sample.clippedRatio > cfg.maxClippedRatio) {
      next.reason = 'glare';
      return next;
    }

    var drift = quadDrift(old.lastQuad, sample.quad, sample.frameWidth, sample.frameHeight);
    var stable = !old.lastQuad || drift <= cfg.maxDrift;
    if (!stable) {
      next.stableFrames = 1;
      next.stableSince = now;
      next.reason = 'steady';
      next.progress = 1 / cfg.minStableFrames;
      return next;
    }

    next.stableFrames = old.stableFrames + 1;
    next.stableSince = old.stableFrames > 0 ? old.stableSince : now;
    var frameProgress = next.stableFrames / cfg.minStableFrames;
    var timeProgress = (now - next.stableSince) / cfg.minStableMs;
    next.progress = Math.max(0, Math.min(1, Math.min(frameProgress, timeProgress)));
    next.reason = 'steady';
    next.fired = next.stableFrames >= cfg.minStableFrames && (now - next.stableSince) >= cfg.minStableMs;
    if (next.fired) { next.progress = 1; next.reason = 'ready'; }
    return next;
  }

  return {
    DEFAULTS: DEFAULTS,
    blankGate: blankGate,
    quadDrift: quadDrift,
    clippedRatio: clippedRatio,
    nameCandidate: nameCandidate,
    nextAutoGate: nextAutoGate
  };
}));
