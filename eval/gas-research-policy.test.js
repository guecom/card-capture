'use strict';

var assert = require('assert');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var props = {
  TOKENS: JSON.stringify({
    'owner-token': 'Owner', 'other-owner-token': 'Other Owner',
    'quota-owner-token': 'Owner', 'fault-owner-token': 'Owner', 'guest-token': 'Guest'
  }),
  OWNER_NAMES: 'Owner,Other Owner',
  INBOX_FOLDER_ID: 'synthetic-inbox',
  DAILY_LIMIT: '100',
  RESEARCH_INSTRUCTION_ENABLED: 'true'
};
var folders = {};
var created = [];
var failNextReceiptWrite = false;
var failNextReceiptRollback = false;

function iter(values) {
  var index = 0;
  return { hasNext: function () { return index < values.length; }, next: function () { return values[index++]; } };
}
function blob(text, name) {
  return {
    text: String(text),
    name: name,
    getDataAsString: function () { return this.text; }
  };
}
function file(name, text) {
  return {
    getName: function () { return name; },
    getLastUpdated: function () { return new Date(1); },
    getBlob: function () { return blob(text, name); },
    setTrashed: function () {}
  };
}
function folder(name, initialMeta) {
  var files = initialMeta ? [file('capture.json', JSON.stringify(initialMeta))] : [];
  return {
    name: name,
    files: files,
    trashed: false,
    getName: function () { return name; },
    getFiles: function () { return iter(files); },
    getFilesByName: function (target) { return iter(files.filter(function (f) { return f.getName() === target; })); },
    createFile: function (value) {
      if (failNextReceiptWrite && value.name === 'capture.json' && name.indexOf('research-') === 0) {
        failNextReceiptWrite = false;
        throw new Error('synthetic_receipt_write_failure');
      }
      files.push(file(value.name || 'file', value.text));
      return files[files.length - 1];
    },
    setTrashed: function (value) {
      if (failNextReceiptRollback) {
        failNextReceiptRollback = false;
        throw new Error('synthetic_receipt_rollback_failure');
      }
      this.trashed = Boolean(value);
    }
  };
}
var inbox = {
  getFolders: function () { return iter(Object.keys(folders).map(function (name) { return folders[name]; }).filter(function (value) { return !value.trashed; })); },
  getFoldersByName: function (name) { return iter(folders[name] && !folders[name].trashed ? [folders[name]] : []); },
  createFolder: function (name) { var value = folder(name); folders[name] = value; created.push(value); return value; }
};
var cache = {};
var sandbox = {
  console: console,
  Date: Date,
  JSON: JSON,
  Math: Math,
  isFinite: isFinite,
  PropertiesService: { getScriptProperties: function () { return {
    getProperty: function (key) { return props[key] || null; },
    setProperty: function (key, value) { props[key] = String(value); return this; },
    deleteProperty: function (key) { delete props[key]; return this; }
  }; } },
  ContentService: {
    MimeType: { JSON: 'application/json' },
    createTextOutput: function (text) { return { text: text, setMimeType: function () { return this; } }; }
  },
  DriveApp: { getFolderById: function () { return inbox; } },
  CacheService: { getScriptCache: function () { return {
    get: function (key) { return cache[key] || null; },
    put: function (key, value) { cache[key] = value; },
    remove: function (key) { delete cache[key]; }
  }; } },
  LockService: { getScriptLock: function () { return { waitLock: function () {}, releaseLock: function () {} }; } },
  Utilities: {
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' },
    computeDigest: function (_, value) {
      return Array.from(crypto.createHash('sha256').update(String(value), 'utf8').digest())
        .map(function (byte) { return byte > 127 ? byte - 256 : byte; });
    },
    formatDate: function () { return '20260725-171500'; },
    getUuid: function () { return 'abcd-0000'; },
    base64Decode: function () { return [1, 2, 3]; },
    newBlob: function (value, mime, name) { return blob(typeof value === 'string' ? value : 'synthetic-image', name); }
  }
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8'), sandbox);

function body(output) { return JSON.parse(output.text); }

/* 새 Deep switch는 누락·빈 값 모두 fail-closed이고 explicit true만 연다. */
assert.strictEqual(sandbox.deepResearchEnabled_(), false);
props.DEEP_RESEARCH_ENABLED = '';
assert.strictEqual(sandbox.deepResearchEnabled_(), false);
props.DEEP_RESEARCH_ENABLED = 'false';
assert.strictEqual(sandbox.deepResearchEnabled_(), false);
props.DEEP_RESEARCH_ENABLED = 'true';
assert.strictEqual(sandbox.deepResearchEnabled_(), true);

var guestInitial = body(sandbox.doPost({ postData: { contents: JSON.stringify({
  k: 'guest-token', captureId: 'cap-guest', researchInstruction: { raw: '공개 경력 조사' }, images: []
}) } }));
assert.deepStrictEqual(guestInitial, { ok: false, error: 'owner_only' });

props.RESEARCH_INSTRUCTION_ENABLED = 'false';
var disabled = body(sandbox.researchInstruction_({ k: 'owner-token', person: 'PER-999901', text: '공개 경력 조사' }));
assert.deepStrictEqual(disabled, { ok: false, error: 'feature_disabled' });
props.RESEARCH_INSTRUCTION_ENABLED = 'true';

folders['cap-match'] = folder('cap-match', { captureId: 'cap-match', person: 'PER-999901', status: 'processed' });
var mismatch = body(sandbox.researchInstruction_({
  k: 'owner-token', captureId: 'cap-match', person: 'PER-999902', text: '공개 경력 조사'
}));
assert.deepStrictEqual(mismatch, { ok: false, error: 'target_mismatch' });

var existing = body(sandbox.researchInstruction_({
  k: 'owner-token', person: 'PER-999903', text: '공개 경력과 창업 이력을 깊게 조사'
}));
assert.strictEqual(existing.ok, true);
var existingMeta = JSON.parse(created[created.length - 1].files[0].getBlob().getDataAsString());
assert.strictEqual(existingMeta.type, 'research_instruction');
assert.strictEqual(existingMeta.researchInstruction.requestedBy, 'Owner');
assert.strictEqual(existingMeta.researchInstruction.target.person, 'PER-999903');
assert.strictEqual(existingMeta.researchInstruction.policy.publicLawfulSourcesOnly, true);
assert.strictEqual(existingMeta.researchInstruction.policy.externalSendOrWrite, false);
assert.strictEqual(existingMeta.researchInstruction.policy.reviewCeiling, 'agent_checked');

var initial = body(sandbox.doPost({ postData: { contents: JSON.stringify({
  k: 'owner-token', captureId: 'cap-owner', capturedAt: '2026-07-25T08:15:00.000Z',
  note: '메모 원문', researchInstruction: { raw: '공개 특허와 인터뷰 조사', requestedBy: 'forged-user' },
  images: [{ name: 'front.jpg', mime: 'image/jpeg', dataB64: 'AQID' }]
}) } }));
assert.strictEqual(initial.ok, true);
var initialMetaFile = folders['cap-owner'].files.filter(function (f) { return f.getName() === 'capture.json'; }).slice(-1)[0];
var initialMeta = JSON.parse(initialMetaFile.getBlob().getDataAsString());
assert.strictEqual(initialMeta.note, '메모 원문');
assert.strictEqual(initialMeta.researchInstruction.raw, '공개 특허와 인터뷰 조사');
assert.strictEqual(initialMeta.researchInstruction.requestedBy, 'Owner');
assert.strictEqual(initialMeta.researchInstruction.target.captureId, 'cap-owner');
assert.strictEqual(initialMeta.researchInstruction.policy.humanGateOverride, false);
assert.match(initialMeta.researchRequestFingerprint, /^sha256:[a-f0-9]{64}$/);
assert.strictEqual(initialMeta.researchInstruction.requestFingerprint, initialMeta.researchRequestFingerprint);

var missingPurpose = body(sandbox.researchInstruction_({
  k: 'owner-token', person: 'PER-999904', instruction: { raw: '깊게 조사', mode: 'deep_evidence_graph' }
}));
assert.deepStrictEqual(missingPurpose, { ok: false, error: 'bad_research_request' });

var deep = body(sandbox.researchInstruction_({
  k: 'owner-token', person: 'PER-999904', instruction: {
    raw: '공개 결과물과 반증을 함께 확인', mode: 'deep_evidence_graph',
    purposes: ['expertise_execution', 'forged-purpose'], focusIds: ['outcomes', 'forged-focus'],
    requestId: 'request-00000001', policy: { privateOrLoginSources: true }, budget: { branchCap: 9999 }
  }
}));
assert.strictEqual(deep.ok, true);
var deepMeta = JSON.parse(created[created.length - 1].files[0].getBlob().getDataAsString());
assert.strictEqual(deepMeta.researchInstruction.policy.version, 'lawful-authority-deep-research-v2');
assert.strictEqual(deepMeta.researchInstruction.policy.privateOrLoginSources, false);
assert.strictEqual(deepMeta.researchInstruction.policy.branchCap, 24);
assert.deepStrictEqual(Array.from(deepMeta.researchInstruction.purposes), ['expertise_execution']);
assert.deepStrictEqual(Array.from(deepMeta.researchInstruction.focusIds), ['outcomes']);
assert.match(deepMeta.researchRequestFingerprint, /^sha256:[a-f0-9]{64}$/);
assert.strictEqual(deepMeta.researchInstruction.requestFingerprint, deepMeta.researchRequestFingerprint);
assert.strictEqual(deepMeta.researchInstruction.requestId, 'request-00000001');

var deduped = body(sandbox.researchInstruction_({
  k: 'owner-token', person: 'PER-999904', instruction: {
    raw: '공개 결과물과 반증을 함께 확인', mode: 'deep_evidence_graph',
    purposes: ['expertise_execution'], focusIds: ['outcomes'], requestId: 'request-00000001'
  }
}));
assert.strictEqual(deduped.ok, true);
assert.strictEqual(deduped.deduped, true);

/* requestId는 capability가 아니다. actor·target·정규화 request 중 하나라도 다르면 fail-closed다. */
[
  {
    label: 'request body collision', k: 'owner-token', person: 'PER-999904',
    instruction: { raw: '다른 요청', mode: 'deep_evidence_graph', purposes: ['expertise_execution'], focusIds: ['outcomes'], requestId: 'request-00000001' }
  },
  {
    label: 'target collision', k: 'owner-token', person: 'PER-999905',
    instruction: { raw: '공개 결과물과 반증을 함께 확인', mode: 'deep_evidence_graph', purposes: ['expertise_execution'], focusIds: ['outcomes'], requestId: 'request-00000001' }
  },
  {
    label: 'capturer collision', k: 'other-owner-token', person: 'PER-999904',
    instruction: { raw: '공개 결과물과 반증을 함께 확인', mode: 'deep_evidence_graph', purposes: ['expertise_execution'], focusIds: ['outcomes'], requestId: 'request-00000001' }
  }
].forEach(function (attempt) {
  var collision = body(sandbox.researchInstruction_(attempt));
  assert.deepStrictEqual(collision, { ok: false, error: 'request_id_conflict' }, attempt.label);
});

/* allowlist 순서가 canonical order다. 순서·중복·unknown 차이는 같은 정규화 요청으로 dedupe된다. */
var normalizedFirst = body(sandbox.researchInstruction_({
  k: 'owner-token', person: 'PER-999906', instruction: {
    raw: '정규화 확인', mode: 'deep_evidence_graph', purposes: ['reputation_risk', 'meeting_preparation'],
    focusIds: ['career', 'expertise', 'career'], requestId: 'request-normalize-1'
  }
}));
assert.strictEqual(normalizedFirst.ok, true);
var normalizedAgain = body(sandbox.researchInstruction_({
  k: 'owner-token', person: 'PER-999906', instruction: {
    raw: '정규화 확인', mode: 'deep_evidence_graph', purposes: ['meeting_preparation', 'unknown', 'reputation_risk'],
    focusIds: ['expertise', 'career', 'forged'], requestId: 'request-normalize-1'
  }
}));
assert.strictEqual(normalizedAgain.deduped, true);

/* 응답 유실 재시도는 quota를 다시 차감하지 않는다. */
props.DAILY_LIMIT = '1';
var quotaRequest = {
  k: 'quota-owner-token', person: 'PER-999907', instruction: {
    raw: 'quota 멱등 확인', mode: 'standard', focusIds: ['career'], requestId: 'request-quota-001'
  }
};
assert.strictEqual(body(sandbox.researchInstruction_(quotaRequest)).ok, true);
assert.strictEqual(cache['cnt_20260725-171500_quota-owner-token'], '1');
assert.strictEqual(body(sandbox.researchInstruction_(quotaRequest)).deduped, true);
assert.strictEqual(cache['cnt_20260725-171500_quota-owner-token'], '1', 'dedupe가 quota를 다시 차감했다');
var overQuota = body(sandbox.researchInstruction_({
  k: 'quota-owner-token', person: 'PER-999907', instruction: {
    raw: '새 요청', mode: 'standard', requestId: 'request-quota-002'
  }
}));
assert.deepStrictEqual(overQuota, { ok: false, error: 'daily_limit' });

/* capture.json 쓰기가 실패하면 새 폴더와 quota를 rollback하고 같은 requestId 재시도가 복구된다. */
var faultQuotaKey = 'cnt_20260725-171500_fault-owner-token';
var rollbackRequest = {
  k: 'fault-owner-token', person: 'PER-999908', instruction: {
    raw: 'receipt rollback 확인', mode: 'standard', requestId: 'request-write-rollback'
  }
};
failNextReceiptWrite = true;
assert.deepStrictEqual(body(sandbox.researchInstruction_(rollbackRequest)), { ok: false, error: 'receipt_write_failed' });
assert.strictEqual(folders['research-request-write-rollback'].trashed, true);
assert.strictEqual(cache[faultQuotaKey], '0');
assert.strictEqual(body(sandbox.researchInstruction_(rollbackRequest)).ok, true);
assert.strictEqual(cache[faultQuotaKey], '1');

/* Drive trash rollback까지 실패해 빈 폴더가 남아도 다음 동일 요청은 collision/quota 없이 복구한다. */
delete cache[faultQuotaKey];
var recoveryRequest = {
  k: 'fault-owner-token', person: 'PER-999908', instruction: {
    raw: 'empty folder recovery 확인', mode: 'standard', requestId: 'request-empty-recovery'
  }
};
failNextReceiptWrite = true;
failNextReceiptRollback = true;
assert.deepStrictEqual(body(sandbox.researchInstruction_(recoveryRequest)), { ok: false, error: 'receipt_write_failed' });
assert.strictEqual(folders['research-request-empty-recovery'].trashed, false);
assert.strictEqual(folders['research-request-empty-recovery'].files.length, 0);
assert.strictEqual(cache[faultQuotaKey], '0');
var durableRecoveryKey = 'RESEARCH_RECEIPT_RESERVATION_research-request-empty-recovery';
assert.ok(props[durableRecoveryKey], 'empty-folder recovery reservation must be durable');
Object.keys(cache).forEach(function (key) { if (key.indexOf('research_receipt_') === 0) delete cache[key]; });
assert.deepStrictEqual(body(sandbox.researchInstruction_({
  k: 'fault-owner-token', person: 'PER-999908', instruction: {
    raw: 'empty folder를 가로채는 다른 요청', mode: 'standard', requestId: 'request-empty-recovery'
  }
})), { ok: false, error: 'request_id_conflict' });
var recoveredReceipt = body(sandbox.researchInstruction_(recoveryRequest));
assert.strictEqual(recoveredReceipt.ok, true);
assert.strictEqual(folders['research-request-empty-recovery'].files.length, 1);
assert.strictEqual(cache[faultQuotaKey], '0', 'empty-folder recovery consumed quota twice');
assert.strictEqual(props[durableRecoveryKey], undefined, 'canonical receipt must clear durable reservation');
props.DAILY_LIMIT = '100';

function validGraph() {
  return {
    version: 'deep-research-evidence-v1',
    purposes: ['expertise_execution'],
    nodes: [
      { id: 'person-1', type: 'person', label: '홍길동' },
      { id: 'org-1', type: 'organization', label: '예시 조직', url: 'https://example.test/org' },
      { id: 'project-1', type: 'project', label: '예시 프로젝트' },
      { id: 'event-1', type: 'event', label: '결과물 공개' },
      { id: 'claim-1', type: 'claim', label: '공개 결과물 확인' },
      { id: 'claim-2', type: 'claim', label: '실행 역할 가설' },
      { id: 'source-1', type: 'source', label: '공식 발표', url: 'https://example.test/source' },
      { id: 'source-2', type: 'source', label: '공식 제품 페이지', url: 'https://example.test/product' },
      { id: 'source-3', type: 'source', label: '반대 정황 기사', url: 'http://news.example.test/counter' }
    ],
    edges: [
      { id: 'edge-support-1', sourceId: 'source-1', targetId: 'claim-1', relation: 'supports', label: '주장을 뒷받침' },
      { id: 'edge-support-2', sourceId: 'source-2', targetId: 'claim-2', relation: 'supports', label: '가설을 뒷받침' },
      { id: 'edge-counter-1', sourceId: 'source-3', targetId: 'claim-2', relation: 'counterevidence', label: '가설에 반대' },
      { id: 'edge-affiliation-1', sourceId: 'person-1', targetId: 'org-1', relation: 'affiliated_with', label: '소속' },
      { id: 'edge-project-1', sourceId: 'person-1', targetId: 'project-1', relation: 'worked_on', label: '프로젝트 참여' },
      { id: 'edge-event-1', sourceId: 'person-1', targetId: 'event-1', relation: 'participated_in', label: '사건 참여' }
    ],
    claims: [{
      id: 'claim-1', state: 'fact', summary: '공개 결과물 확인', confidence: 'high',
      evidenceFor: [{ sourceId: 'source-1', title: '공식 발표', url: 'https://example.test/source', publishedAt: '2026-07-01', ignored: 'drop-me' }],
      evidenceAgainst: []
    }, {
      id: 'claim-2', state: 'hypothesis', summary: '실행 역할 가설', confidence: 'medium',
      evidenceFor: [{ sourceId: 'source-2', title: '공식 제품 페이지', url: 'https://example.test/product' }],
      evidenceAgainst: [{ sourceId: 'source-3', title: '반대 정황 기사', url: 'http://news.example.test/counter' }],
      alternativeExplanation: '팀 전체 성과일 수 있음'
    }],
    timeline: [{ date: '2026', label: '결과물 공개', claimIds: ['claim-1', 'claim-2'] }],
    openQuestions: ['개인 기여 범위는 어디까지인가?'],
    metrics: { branchCount: 4, sourceCount: 12, elapsedMinutes: 37 },
    stop: { reason: 'purpose_satisfied', summary: '목적에 필요한 공개 근거를 확보했다' },
    ignored: 'drop-me'
  };
}

function seedResearchResult(id, graph, progress, status) {
  var meta = {
    captureId: id, type: 'research_instruction', capturer: 'Owner', person: 'PER-999904',
    receivedAt: '2026-07-25T08:00:00.000Z', processedAt: status === 'processed' ? '2026-07-25T08:10:00.000Z' : '',
    status: status || 'processed',
    researchInstruction: {
      mode: 'deep_evidence_graph', purposes: ['expertise_execution'], focusIds: [], sourceAuthority: 'public_lawful_only',
      policy: { version: 'lawful-authority-deep-research-v2' }
    },
    researchProgress: progress
  };
  folders[id] = folder(id, meta);
  if (graph) folders[id].createFile(blob(JSON.stringify(graph), 'research-result.json'));
}

var goodProgress = {
  phase: 'done', partial: false, updatedAt: '2026-07-25T08:10:00.000Z',
  verifiedFacts: 1, conflicts: 0, openQuestions: 1,
  branchCount: 4, sourceCount: 12, elapsedMinutes: 37, ignored: 'drop-me'
};
seedResearchResult('research-result-valid', validGraph(), goodProgress, 'processed');

var badUrl = validGraph();
badUrl.claims[0].evidenceFor[0].url = 'javascript:alert(1)';
seedResearchResult('research-result-bad-url', badUrl, goodProgress, 'processed');
var missingTitle = validGraph();
missingTitle.claims[0].evidenceFor[0].title = '';
seedResearchResult('research-result-missing-title', missingTitle, goodProgress, 'processed');
var oneSided = validGraph();
oneSided.claims[1].evidenceAgainst = [];
seedResearchResult('research-result-one-sided', oneSided, goodProgress, 'processed');
var unsafeNode = validGraph();
unsafeNode.nodes[0].id = 'bad id';
seedResearchResult('research-result-unsafe-node', unsafeNode, goodProgress, 'processed');
var danglingEdge = validGraph();
danglingEdge.edges[3].targetId = 'missing-node';
seedResearchResult('research-result-dangling-edge', danglingEdge, goodProgress, 'processed');
var missingEvidenceEdge = validGraph();
missingEvidenceEdge.edges = missingEvidenceEdge.edges.filter(function (edge) { return edge.id !== 'edge-support-1'; });
seedResearchResult('research-result-missing-evidence-edge', missingEvidenceEdge, goodProgress, 'processed');
var wrongEvidencePolarity = validGraph();
wrongEvidencePolarity.edges[0].relation = 'counterevidence';
seedResearchResult('research-result-wrong-evidence-polarity', wrongEvidencePolarity, goodProgress, 'processed');
var mismatchedSource = validGraph();
mismatchedSource.claims[0].evidenceFor[0].sourceId = 'org-1';
seedResearchResult('research-result-mismatched-source', mismatchedSource, goodProgress, 'processed');
var danglingTimeline = validGraph();
danglingTimeline.timeline[0].claimIds = ['missing'];
seedResearchResult('research-result-dangling', danglingTimeline, goodProgress, 'processed');
var badStop = validGraph();
badStop.stop = { reason: 'searched_everything', summary: '과장된 완료' };
seedResearchResult('research-result-bad-stop', badStop, goodProgress, 'processed');
var missingMetrics = validGraph();
delete missingMetrics.metrics;
seedResearchResult('research-result-missing-metrics', missingMetrics, goodProgress, 'processed');
var dishonestCap = validGraph();
dishonestCap.stop.reason = 'time_cap';
seedResearchResult('research-result-dishonest-cap', dishonestCap, goodProgress, 'processed');
var wrongPurpose = validGraph();
wrongPurpose.purposes = ['reputation_risk'];
seedResearchResult('research-result-wrong-purpose', wrongPurpose, goodProgress, 'processed');
seedResearchResult('research-result-not-final', validGraph(), {
  phase: 'branching', partial: true, updatedAt: '2026-07-25T08:05:00.000Z', verifiedFacts: 0, conflicts: 0, openQuestions: 2,
  branchCount: 1, sourceCount: 4, elapsedMinutes: 9
}, 'processing');
seedResearchResult('research-progress-invalid', null, {
  phase: 'branching', partial: false, updatedAt: 'not-a-time', verifiedFacts: -1, conflicts: '0', openQuestions: 1
}, 'processing');
seedResearchResult('research-progress-processing-done', null, goodProgress, 'processing');
seedResearchResult('research-progress-processed-partial', null, {
  phase: 'triangulating', partial: true, updatedAt: '2026-07-25T08:07:00.000Z', verifiedFacts: 1, conflicts: 1, openQuestions: 2,
  branchCount: 3, sourceCount: 10, elapsedMinutes: 24
}, 'processed');
seedResearchResult('research-progress-received-partial', null, {
  phase: 'planning', partial: true, updatedAt: '2026-07-25T08:01:00.000Z', verifiedFacts: 0, conflicts: 0, openQuestions: 1,
  branchCount: 0, sourceCount: 0, elapsedMinutes: 1
}, 'received');

var listed = body(sandbox.listCaptures_('owner-token', 100, 0));
assert.strictEqual(listed.ok, true);
var byId = {};
listed.items.forEach(function (item) { byId[item.captureId] = item; });
assert.deepStrictEqual(byId['research-result-valid'].researchEvidence, {
  version: 'deep-research-evidence-v1', purposes: ['expertise_execution'],
  nodes: [
    { id: 'person-1', type: 'person', label: '홍길동' },
    { id: 'org-1', type: 'organization', label: '예시 조직', url: 'https://example.test/org' },
    { id: 'project-1', type: 'project', label: '예시 프로젝트' },
    { id: 'event-1', type: 'event', label: '결과물 공개' },
    { id: 'claim-1', type: 'claim', label: '공개 결과물 확인' },
    { id: 'claim-2', type: 'claim', label: '실행 역할 가설' },
    { id: 'source-1', type: 'source', label: '공식 발표', url: 'https://example.test/source' },
    { id: 'source-2', type: 'source', label: '공식 제품 페이지', url: 'https://example.test/product' },
    { id: 'source-3', type: 'source', label: '반대 정황 기사', url: 'http://news.example.test/counter' }
  ],
  edges: [
    { id: 'edge-support-1', sourceId: 'source-1', targetId: 'claim-1', relation: 'supports', label: '주장을 뒷받침' },
    { id: 'edge-support-2', sourceId: 'source-2', targetId: 'claim-2', relation: 'supports', label: '가설을 뒷받침' },
    { id: 'edge-counter-1', sourceId: 'source-3', targetId: 'claim-2', relation: 'counterevidence', label: '가설에 반대' },
    { id: 'edge-affiliation-1', sourceId: 'person-1', targetId: 'org-1', relation: 'affiliated_with', label: '소속' },
    { id: 'edge-project-1', sourceId: 'person-1', targetId: 'project-1', relation: 'worked_on', label: '프로젝트 참여' },
    { id: 'edge-event-1', sourceId: 'person-1', targetId: 'event-1', relation: 'participated_in', label: '사건 참여' }
  ],
  claims: [{
    id: 'claim-1', state: 'fact', summary: '공개 결과물 확인', confidence: 'high',
    evidenceFor: [{ sourceId: 'source-1', title: '공식 발표', url: 'https://example.test/source', publishedAt: '2026-07-01' }], evidenceAgainst: []
  }, {
    id: 'claim-2', state: 'hypothesis', summary: '실행 역할 가설', confidence: 'medium',
    evidenceFor: [{ sourceId: 'source-2', title: '공식 제품 페이지', url: 'https://example.test/product' }],
    evidenceAgainst: [{ sourceId: 'source-3', title: '반대 정황 기사', url: 'http://news.example.test/counter' }],
    alternativeExplanation: '팀 전체 성과일 수 있음'
  }],
  timeline: [{ date: '2026', label: '결과물 공개', claimIds: ['claim-1', 'claim-2'] }],
  openQuestions: ['개인 기여 범위는 어디까지인가?'],
  metrics: { branchCount: 4, sourceCount: 12, elapsedMinutes: 37 },
  stop: { reason: 'purpose_satisfied', summary: '목적에 필요한 공개 근거를 확보했다' }
});
assert.deepStrictEqual(byId['research-result-valid'].researchProgress, {
  phase: 'done', partial: false, updatedAt: '2026-07-25T08:10:00.000Z', verifiedFacts: 1, conflicts: 0, openQuestions: 1,
  branchCount: 4, sourceCount: 12, elapsedMinutes: 37
});
['research-result-bad-url', 'research-result-missing-title', 'research-result-one-sided', 'research-result-unsafe-node',
  'research-result-dangling-edge', 'research-result-missing-evidence-edge', 'research-result-wrong-evidence-polarity',
  'research-result-mismatched-source', 'research-result-dangling',
  'research-result-bad-stop', 'research-result-missing-metrics', 'research-result-dishonest-cap',
  'research-result-wrong-purpose', 'research-result-not-final']
  .forEach(function (id) { assert.strictEqual(byId[id].researchEvidence, undefined, id + ' malformed/non-final result leaked'); });
assert.strictEqual(byId['research-progress-invalid'].researchProgress, undefined, 'malformed progress leaked');
['research-progress-processing-done', 'research-progress-processed-partial', 'research-progress-received-partial']
  .forEach(function (id) { assert.strictEqual(byId[id].researchProgress, undefined, id + ' status/progress contradiction leaked'); });
assert.deepStrictEqual(byId['research-result-not-final'].researchProgress, {
  phase: 'branching', partial: true, updatedAt: '2026-07-25T08:05:00.000Z', verifiedFacts: 0, conflicts: 0, openQuestions: 2,
  branchCount: 1, sourceCount: 4, elapsedMinutes: 9
});

console.log('PASS GAS research policy: fail-closed flag/durable idempotency recovery, status-bound progress, canonical relationship graph publication');
