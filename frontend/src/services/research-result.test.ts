import { describe, expect, it } from 'vitest';
import { researchEvidenceView, validateResearchEvidenceGraph } from './research-result';

const valid = {
  version: 'deep-research-evidence-v1',
  purposes: ['expertise_execution'],
  nodes: [
    { id: 'person-1', type: 'person', label: '홍길동' },
    { id: 'org-1', type: 'organization', label: '예시 조직', url: 'https://example.test/org' },
    { id: 'project-1', type: 'project', label: '예시 프로젝트' },
    { id: 'event-1', type: 'event', label: '결과물 공개' },
    { id: 'c1', type: 'claim', label: '공개 결과물 확인' },
    { id: 'source-1', type: 'source', label: '공식 발표', url: 'https://example.test/source' },
  ],
  edges: [
    { id: 'edge-support-1', sourceId: 'source-1', targetId: 'c1', relation: 'supports', label: '주장을 뒷받침' },
    { id: 'edge-affiliation-1', sourceId: 'person-1', targetId: 'org-1', relation: 'affiliated_with', label: '소속' },
    { id: 'edge-project-1', sourceId: 'person-1', targetId: 'project-1', relation: 'worked_on', label: '참여' },
    { id: 'edge-event-1', sourceId: 'person-1', targetId: 'event-1', relation: 'participated_in', label: '참석' },
  ],
  claims: [{ id: 'c1', state: 'fact', summary: '공개 결과물 확인', confidence: 'high', evidenceFor: [{ sourceId: 'source-1', title: '공식 발표', url: 'https://example.test/source' }], evidenceAgainst: [] }],
  timeline: [{ date: '2026', label: '결과물 공개', claimIds: ['c1'] }],
  openQuestions: [],
  metrics: { branchCount: 4, sourceCount: 12, elapsedMinutes: 37 },
  stop: { reason: 'purpose_satisfied', summary: '목적을 충족했다' },
};

describe('APP-AC-239 evidence graph gate', () => {
  it('accepts a linked, supported graph', () => expect(validateResearchEvidenceGraph(valid).ok).toBe(true));
  it('rejects unsupported facts and dangling timeline references', () => {
    const broken = structuredClone(valid);
    broken.claims[0].evidenceFor = [];
    broken.timeline[0].claimIds = ['missing'];
    const result = validateResearchEvidenceGraph(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual(expect.arrayContaining(['unsupported_fact:c1', 'timeline_unknown_claim:missing']));
  });

  it('rejects unsafe nodes and dangling relationship endpoints', () => {
    const broken = structuredClone(valid);
    broken.nodes[0].id = 'bad id';
    broken.nodes[1].url = 'https://user:secret@example.test/org';
    broken.edges[1].targetId = 'missing-org';
    const result = validateResearchEvidenceGraph(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual(expect.arrayContaining([
      'node_id_invalid:0',
      'node_url_invalid:1',
      'edge_endpoint_invalid:1',
    ]));
  });

  it('requires source-to-claim edges to exactly mirror claim evidence sourceId and polarity', () => {
    const missingEdge = structuredClone(valid);
    missingEdge.edges = missingEdge.edges.filter((edge) => edge.relation !== 'supports');
    const missingResult = validateResearchEvidenceGraph(missingEdge);
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) expect(missingResult.errors).toContain('evidence_edge_missing:source-1:c1:supports');

    const wrongPolarity = structuredClone(valid);
    (wrongPolarity.edges[0] as { relation: string }).relation = 'counterevidence';
    const polarityResult = validateResearchEvidenceGraph(wrongPolarity);
    expect(polarityResult.ok).toBe(false);
    if (!polarityResult.ok) expect(polarityResult.errors).toEqual(expect.arrayContaining([
      'evidence_edge_mismatch:0',
      'evidence_edge_missing:source-1:c1:supports',
    ]));

    const wrongSource = structuredClone(valid);
    wrongSource.claims[0].evidenceFor[0].sourceId = 'org-1';
    const sourceResult = validateResearchEvidenceGraph(wrongSource);
    expect(sourceResult.ok).toBe(false);
    if (!sourceResult.ok) expect(sourceResult.errors).toContain('evidence_for:c1_source_missing:0');
  });
  it('rejects a one-sided hypothesis', () => {
    const broken = structuredClone(valid);
    Object.assign(broken.claims[0], { state: 'hypothesis', evidenceAgainst: [], alternativeExplanation: '' });
    const result = validateResearchEvidenceGraph(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain('one_sided_hypothesis:c1');
  });

  it('rejects missing source URLs, one-sided conflicts, and dishonest stop budgets', () => {
    const broken = structuredClone(valid);
    Object.assign(broken.claims[0], { state: 'conflict', evidenceAgainst: [] });
    delete (broken.claims[0].evidenceFor[0] as { url?: string }).url;
    broken.metrics.elapsedMinutes = 12;
    broken.stop.reason = 'time_cap';
    const result = validateResearchEvidenceGraph(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual(expect.arrayContaining([
      'evidence_for:c1_url_invalid:0',
      'one_sided_conflict:c1',
      'stop_budget_mismatch',
    ]));
  });

  it('fails closed without throwing when nested server data is malformed', () => {
    const malformed = {
      ...structuredClone(valid),
      claims: [null, 'claim', { id: 'c2', state: 'fact', summary: 'unsafe source', evidenceFor: [null, { title: '', url: 'javascript:alert(1)' }], evidenceAgainst: [] }],
      timeline: [null, { date: '', label: '', claimIds: ['missing'] }],
      openQuestions: [null, ''],
      stop: 'done',
    };

    expect(() => validateResearchEvidenceGraph(malformed)).not.toThrow();
    const result = validateResearchEvidenceGraph(malformed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual(expect.arrayContaining([
      'claim_not_object:0',
      'claim_not_object:1',
      'evidence_for:c2_item_not_object:0',
      'evidence_for:c2_url_invalid:1',
      'timeline_item_not_object:0',
      'timeline_unknown_claim:missing',
      'open_question_invalid:0',
      'bad_stop',
    ]));
  });

  it('gives the renderer an explicit invalid state instead of a blank graph', () => {
    expect(researchEvidenceView(undefined)).toEqual({ kind: 'none' });
    expect(researchEvidenceView(valid)).toMatchObject({ kind: 'ready' });
    expect(researchEvidenceView({ version: 'wrong' })).toMatchObject({ kind: 'invalid' });
  });
});
