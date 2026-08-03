import { describe, expect, it } from 'vitest';
import type { BriefItem } from '../contracts/capture';
import { researchProgressView, timelineCoverage } from './research-progress-view';

/** `research-result.ts`의 교차 검증을 실제로 통과하는 최소 graph. */
const graph = {
  version: 'deep-research-evidence-v1',
  purposes: ['expertise_execution'],
  nodes: [
    { id: 'person-1', type: 'person', label: '홍길동' },
    { id: 'c1', type: 'claim', label: '공개 결과물 확인' },
    { id: 'c2', type: 'claim', label: '경력 서술이 엇갈린다' },
    { id: 'source-1', type: 'source', label: '공식 발표', url: 'https://example.test/a' },
    { id: 'source-2', type: 'source', label: '다른 기사', url: 'https://example.test/b' },
  ],
  edges: [
    { id: 'edge-1', sourceId: 'source-1', targetId: 'c1', relation: 'supports', label: '주장을 뒷받침' },
    { id: 'edge-2', sourceId: 'source-1', targetId: 'c2', relation: 'supports', label: '주장을 뒷받침' },
    { id: 'edge-3', sourceId: 'source-2', targetId: 'c2', relation: 'counterevidence', label: '반대 근거' },
  ],
  claims: [
    { id: 'c1', state: 'fact', summary: '공개 결과물 확인', confidence: 'high', evidenceFor: [{ sourceId: 'source-1', title: '공식 발표', url: 'https://example.test/a' }], evidenceAgainst: [] },
    {
      id: 'c2',
      state: 'conflict',
      summary: '경력 서술이 엇갈린다',
      confidence: 'medium',
      evidenceFor: [{ sourceId: 'source-1', title: '공식 발표', url: 'https://example.test/a' }],
      evidenceAgainst: [{ sourceId: 'source-2', title: '다른 기사', url: 'https://example.test/b' }],
    },
  ],
  timeline: [
    { date: '2019-04', label: '입사', claimIds: ['c1'] },
    { date: '2023', label: '제품 공개', claimIds: ['c1', 'c2'] },
    { date: '미상', label: '수상', claimIds: [] },
  ],
  openQuestions: ['지금도 같은 조직인가?', '수상 시점은 언제인가?'],
  metrics: { branchCount: 4, sourceCount: 12, elapsedMinutes: 37 },
  stop: { reason: 'purpose_satisfied', summary: '목적을 충족했다' },
};

const receipt = (over: Partial<BriefItem> = {}) => ({
  captureId: 'r1',
  status: 'processing',
  type: 'research_instruction',
  ...over,
} as BriefItem);

describe('기간 커버리지 (검토한 source 수 대신)', () => {
  it('timeline에서 훑은 기간과 근거가 붙은 사건 수를 파생한다', () => {
    const coverage = timelineCoverage(graph.timeline as never);
    expect(coverage).toMatchObject({
      events: 3,
      citedEvents: 2,
      earliestYear: 2019,
      latestYear: 2023,
      spanYears: 4,
      label: '2019~2023년 · 사건 3건',
    });
  });

  it('한 해만 있으면 범위 대신 한 해로 말한다', () => {
    expect(timelineCoverage([{ date: '2026-01-02', label: 'x', claimIds: [] }])?.label).toBe('2026년 · 사건 1건');
  });

  it('연도를 읽어내지 못하면 지어내지 않는다', () => {
    const coverage = timelineCoverage([{ date: '작년 봄', label: 'x', claimIds: [] }]);
    expect(coverage).toMatchObject({ earliestYear: null, latestYear: null, spanYears: null, label: '연도 미상 · 사건 1건' });
  });

  it('timeline이 없으면 커버리지도 없다', () => {
    expect(timelineCoverage([])).toBeNull();
    expect(timelineCoverage(null)).toBeNull();
  });
});

describe('중간 결과 view model', () => {
  it('검증된 graph가 있으면 사실·질문·충돌·커버리지를 graph에서 직접 센다', () => {
    const view = researchProgressView(receipt({
      researchProgress: { phase: 'synthesizing', verifiedFacts: 99, conflicts: 99, openQuestions: 99, updatedAt: '2026-08-02T09:00:00.000Z' },
      researchEvidence: graph as never,
    }));

    expect(view).toMatchObject({
      phase: 'synthesizing',
      phaseLabel: '결과 정리하는 중',
      verifiedFacts: 1,
      conflicts: 1,
      openQuestions: 2,
      countsFrom: 'graph',
      updatedAt: '2026-08-02T09:00:00.000Z',
      evidenceInvalid: false,
    });
    expect(view?.coverage?.label).toBe('2019~2023년 · 사건 3건');
  });

  it('graph가 없으면 서버 요약을 쓰고 어느 쪽인지 밝힌다', () => {
    const view = researchProgressView(receipt({
      researchProgress: { phase: 'branching', verifiedFacts: 3, conflicts: 1, openQuestions: 5, sourceCount: 12 },
    }));
    expect(view).toMatchObject({
      verifiedFacts: 3,
      conflicts: 1,
      openQuestions: 5,
      countsFrom: 'progress',
      coverage: null,
      sourceCount: 12,
    });
  });

  it('`검토한 source 수`는 지우지 않되 중간 결과의 지표로 두지 않는다', () => {
    const view = researchProgressView(receipt({ researchEvidence: graph as never }));
    // 서버가 보내는 값이라 계약에는 남는다 (eval/gas-research-policy.test.js가 서버 동작을 검사한다).
    expect(view?.sourceCount).toBe(12);
    // 대신 화면이 고를 수 있는 더 나은 자료가 실제로 존재한다.
    expect(view?.coverage?.citedEvents).toBe(2);
    expect(view?.openQuestions).toBe(2);
  });

  it('graph가 검증을 통과하지 못하면 잘못된 숫자 대신 그 사실을 남긴다', () => {
    const broken = structuredClone(graph);
    broken.claims[0].evidenceFor = [];
    const view = researchProgressView(receipt({
      researchProgress: { phase: 'triangulating', verifiedFacts: 2 },
      researchEvidence: broken as never,
    }));
    expect(view).toMatchObject({ evidenceInvalid: true, countsFrom: 'progress', verifiedFacts: 2, coverage: null });
  });

  it('조사와 무관한 캡처에는 view가 없다', () => {
    expect(researchProgressView(null)).toBeNull();
    expect(researchProgressView({ captureId: 'c1', status: 'received' } as BriefItem)).toBeNull();
  });

  it('모르는 단계 값은 영어로 흘리지 않는다', () => {
    const view = researchProgressView(receipt({ researchProgress: { phase: 'turbo' as never, verifiedFacts: 1 } }));
    expect(view).toMatchObject({ phase: null, phaseLabel: null });
  });
});
