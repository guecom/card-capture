import { describe, expect, it } from 'vitest';
import {
  buildResearchInstruction,
  RESEARCH_FOCUS_OPTIONS,
  researchBulkState,
  sanitizeResearchInstruction,
  toggleAllResearchFocus,
} from './research';

describe('APP-AC-238 research recommendation selection', () => {
  it('tracks none, partial, and all without touching free text', () => {
    const freeText = '  내 문장, 쉼표와\n줄바꿈을 그대로 둬.  ';
    const partial = toggleAllResearchFocus(['expertise'], RESEARCH_FOCUS_OPTIONS.slice(0, 3));
    expect(researchBulkState(['expertise'], RESEARCH_FOCUS_OPTIONS.slice(0, 3)).state).toBe('partial');
    expect(researchBulkState(partial, RESEARCH_FOCUS_OPTIONS.slice(0, 3)).state).toBe('all');
    expect(toggleAllResearchFocus(partial, RESEARCH_FOCUS_OPTIONS.slice(0, 3))).toEqual([]);
    expect(freeText).toBe('  내 문장, 쉼표와\n줄바꿈을 그대로 둬.  ');
  });

  it('submits allowlisted focus IDs separately from raw text', () => {
    expect(buildResearchInstruction('', { focusIds: ['expertise', 'authority'] }))?.toMatchObject({
      raw: '',
      mode: 'standard',
      focusIds: ['expertise', 'authority'],
      sourceAuthority: 'public_lawful_only',
    });
  });
});

describe('APP-AC-239 Deep Research request contract', () => {
  it('builds a purpose-limited public-lawful evidence graph request', () => {
    expect(buildResearchInstruction('공개 결과물을 교차 검증해줘', {
      mode: 'deep_evidence_graph',
      purposes: ['expertise_execution', 'reputation_risk'],
      focusIds: ['outcomes'],
      requestId: 'request-12345678',
    })).toMatchObject({
      mode: 'deep_evidence_graph',
      purposes: ['expertise_execution', 'reputation_risk'],
      focusIds: ['outcomes'],
      policyVersion: 'lawful-authority-deep-research-v2',
      sourceAuthority: 'public_lawful_only',
      budget: { branchCap: 24, timeCapMinutes: 90 },
    });
  });

  it('does not create a Deep request until an explicit purpose is selected', () => {
    expect(buildResearchInstruction('이 사람을 깊게 조사해줘', {
      mode: 'deep_evidence_graph',
      purposes: [],
      focusIds: ['expertise'],
    })).toBeNull();
  });

  it('keeps risk flags and the 2,000-character boundary', () => {
    const instruction = buildResearchInstruction(`로그인 자료와 비밀번호를 찾아줘 ${'x'.repeat(2200)}`);
    expect(instruction?.raw).toHaveLength(2000);
    expect(instruction?.riskFlags).toEqual(expect.arrayContaining(['private_source', 'credential']));
    expect(sanitizeResearchInstruction(' a\u0000b ')).toBe('a b');
  });
});
