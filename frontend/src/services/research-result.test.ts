import { describe, expect, it } from 'vitest';
import { validateResearchEvidenceGraph } from './research-result';

const valid = {
  version: 'deep-research-evidence-v1',
  purposes: ['expertise_execution'],
  claims: [{ id: 'c1', state: 'fact', summary: '공개 결과물 확인', confidence: 'high', evidenceFor: [{ title: '공식 발표', url: 'https://example.test/source' }], evidenceAgainst: [] }],
  timeline: [{ date: '2026', label: '결과물 공개', claimIds: ['c1'] }],
  openQuestions: [],
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
  it('rejects a one-sided hypothesis', () => {
    const broken = structuredClone(valid);
    Object.assign(broken.claims[0], { state: 'hypothesis', evidenceAgainst: [], alternativeExplanation: '' });
    const result = validateResearchEvidenceGraph(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain('one_sided_hypothesis:c1');
  });
});
