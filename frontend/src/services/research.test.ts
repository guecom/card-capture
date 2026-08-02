import { describe, expect, it } from 'vitest';
import {
  buildResearchInstruction,
  createResearchRequestIdLifecycle,
  matchingPendingResearchRequestId,
  RESEARCH_FOCUS_OPTIONS,
  researchBulkState,
  researchRequestFingerprint,
  researchTargetFingerprint,
  sanitizeResearchInstruction,
  toggleAllResearchFocus,
} from './research';

describe('INT-000025 research request idempotency', () => {
  it('reuses one request ID across ambiguous retries and rotates only after success or a new draft', () => {
    const generated = ['request-00000001', 'request-00000002', 'request-00000003'];
    const lifecycle = createResearchRequestIdLifecycle(() => generated.shift()!);

    expect(lifecycle.peek()).toBeNull();
    expect(lifecycle.current()).toBe('request-00000001');
    expect(lifecycle.retry()).toBe('request-00000001');
    expect(lifecycle.retry()).toBe('request-00000001');

    lifecycle.markAccepted();
    expect(lifecycle.current()).toBe('request-00000002');

    lifecycle.beginNewDraft();
    expect(lifecycle.current()).toBe('request-00000003');
    expect(generated).toEqual([]);
  });

  it('resumes a queued capture ID and rejects malformed legacy IDs instead of weakening the server contract', () => {
    const lifecycle = createResearchRequestIdLifecycle(() => 'request-00000009');
    lifecycle.resume('request-00000007');
    expect(lifecycle.retry()).toBe('request-00000007');

    lifecycle.resume('bad id with spaces');
    expect(lifecycle.peek()).toBeNull();
    expect(lifecycle.current()).toBe('request-00000009');
  });

  it('normalizes equivalent target/request drafts but separates target or content changes', () => {
    const first = buildResearchInstruction('  공개 결과물 확인\r\n최근 발표  ', {
      mode: 'deep_evidence_graph',
      purposes: ['reputation_risk', 'expertise_execution'],
      focusIds: ['outcomes', 'expertise'],
    })!;
    const equivalent = buildResearchInstruction('공개 결과물 확인\n최근 발표', {
      mode: 'deep_evidence_graph',
      purposes: ['expertise_execution', 'reputation_risk'],
      focusIds: ['expertise', 'outcomes'],
    })!;
    const changed = buildResearchInstruction('공개 결과물 확인\n최근 인터뷰', {
      mode: 'deep_evidence_graph',
      purposes: ['expertise_execution', 'reputation_risk'],
      focusIds: ['expertise', 'outcomes'],
    })!;

    expect(researchTargetFingerprint({ person: 'PER-000001' }))
      .toBe(researchTargetFingerprint({ person: ' PER-000001 ' }));
    expect(researchTargetFingerprint({ person: 'PER-000002' }))
      .not.toBe(researchTargetFingerprint({ person: 'PER-000001' }));
    expect(researchTargetFingerprint({ captureId: 'CAP-1' }))
      .not.toBe(researchTargetFingerprint({ person: 'CAP-1' }));
    expect(researchRequestFingerprint(first)).toBe(researchRequestFingerprint(equivalent));
    expect(researchRequestFingerprint(changed)).not.toBe(researchRequestFingerprint(first));

    const pending = {
      requestId: 'request-00000031',
      targetFingerprint: researchTargetFingerprint({ person: 'PER-000001' }),
      requestFingerprint: researchRequestFingerprint(first),
    };
    expect(matchingPendingResearchRequestId(pending, pending.targetFingerprint, researchRequestFingerprint(equivalent)))
      .toBe('request-00000031');
    expect(matchingPendingResearchRequestId(pending, researchTargetFingerprint({ person: 'PER-000002' }), pending.requestFingerprint))
      .toBeNull();
    expect(matchingPendingResearchRequestId(pending, pending.targetFingerprint, researchRequestFingerprint(changed)))
      .toBeNull();
  });
});

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
