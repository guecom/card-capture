import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BriefItem } from '../contracts/capture';
import {
  RESEARCH_MARKER_STAGE_KEYS,
  RESEARCH_MEASURED_STAGE_KEYS,
  RESEARCH_PHASE_TO_STAGE,
  RESEARCH_STAGE_KEYS,
  elapsedLabel,
  recallStages,
  recordResearchStageObservations,
  researchRailForPhase,
  researchRailFromBrief,
  researchStageSightings,
  researchStageStats,
  researchStageWeighting,
  researchStages,
  syncResearchStageTelemetry,
} from './ai-stages';
import { emptyStageTelemetry } from './stage-telemetry';
import { setActiveSubject, subjectIdOf } from './storage';
import { FakeStorage } from './test-storage';

describe('researchStages', () => {
  it('작성 중 → 접수됨 → 조사 → 출처 정리 → 완료 순서를 유지한다', () => {
    expect(researchStages('draft').map((stage) => stage.label))
      .toEqual(['작성 중', '접수됨', '공개 자료 조사 중', '출처 정리 중', '완료']);
  });

  it('지난 단계는 done, 현재 단계만 active로 표시한다', () => {
    const stages = researchStages('searching');
    expect(stages.map((stage) => stage.state)).toEqual(['done', 'done', 'active', 'todo', 'todo']);
  });

  it('현재 단계의 한 문장을 함께 준다', () => {
    expect(researchStages('received').find((stage) => stage.state === 'active')?.headline).toBe('요청을 접수했어요');
  });
});

describe('서버 phase → rail 매핑 (INT-000025)', () => {
  const receipt = (over: Partial<BriefItem> = {}) => ({ captureId: 'r1', status: 'received', type: 'research_instruction', ...over } as BriefItem);

  it('다섯 단계가 모두 서버 phase로 도달 가능하다 — 도달 불가능한 칸을 남기지 않는다', () => {
    const reachable = new Set(Object.values(RESEARCH_PHASE_TO_STAGE));
    // `draft`는 아직 서버로 가기 전이라 기기 상태이고, 나머지 넷은 서버가 증명한다.
    expect(reachable).toEqual(new Set(['received', 'searching', 'sourcing', 'done']));
  });

  it('`공개 자료 조사 중`은 branching이, `출처 정리 중`은 triangulating·synthesizing이 켠다', () => {
    expect(researchRailForPhase('branching').stage).toBe('searching');
    expect(researchRailForPhase('triangulating').stage).toBe('sourcing');
    expect(researchRailForPhase('synthesizing').stage).toBe('sourcing');
    expect(researchRailForPhase('branching').stages.find((stage) => stage.state === 'active')?.label).toBe('공개 자료 조사 중');
    expect(researchRailForPhase('synthesizing').stages.find((stage) => stage.state === 'active')?.label).toBe('출처 정리 중');
  });

  it('서버 단계 이름을 한국어로 함께 준다', () => {
    expect(researchRailForPhase('planning')).toMatchObject({ stage: 'received', phase: 'planning', phaseLabel: '조사 계획 세우는 중', proof: 'phase', note: null });
  });

  it('phase가 없으면 접수까지만 켜고, 얼어붙은 것이 아니라 모르는 것이라고 말한다', () => {
    const rail = researchRailFromBrief(receipt());
    expect(rail).toMatchObject({ stage: 'received', phase: null, phaseLabel: null, proof: 'receipt_only' });
    expect(rail.note).toContain('세부 단계를 알려주지 않아');
    expect(rail.stages.map((stage) => stage.state)).toEqual(['done', 'active', 'todo', 'todo', 'todo']);
  });

  it('phase가 없어도 종료 상태는 서버가 증명한 완료다', () => {
    expect(researchRailFromBrief(receipt({ status: 'processed' }))).toMatchObject({ stage: 'done', proof: 'terminal_status', note: null });
    expect(researchRailFromBrief(receipt({ status: 'skipped' })).stage).toBe('done');
  });

  it('모르는 phase 값을 단계로 인정하지 않는다', () => {
    const rail = researchRailFromBrief(receipt({ researchProgress: { phase: 'turbo' as never } }));
    expect(rail).toMatchObject({ stage: 'received', phase: null, proof: 'receipt_only' });
  });

  it('서버가 말한 마지막 갱신 시각을 그대로 넘긴다', () => {
    const rail = researchRailFromBrief(receipt({ researchProgress: { phase: 'branching', updatedAt: '2026-08-02T09:00:00.000Z' } }));
    expect(rail.updatedAt).toBe('2026-08-02T09:00:00.000Z');
  });

  it('아직 보내지 않은 요청은 기기 상태인 `작성 중`이다', () => {
    expect(researchRailFromBrief(null)).toMatchObject({ stage: 'draft', proof: 'local_draft', note: null });
  });
});

describe('조사 rail의 단계 소요시간 관측', () => {
  const receipt = (phase: string | undefined, over: Partial<BriefItem> = {}) => ({
    captureId: 'r1',
    status: 'received',
    type: 'research_instruction',
    ...(phase ? { researchProgress: { phase: phase as never } } : {}),
    ...over,
  } as BriefItem);

  let store: FakeStorage;
  const OWNER = subjectIdOf('https://api.example.test/exec', 'owner-token');

  beforeEach(() => {
    store = new FakeStorage();
    vi.stubGlobal('localStorage', store);
    setActiveSubject(OWNER);
  });

  afterEach(() => {
    setActiveSubject('anon');
    vi.unstubAllGlobals();
  });

  it('rail 다섯 칸 중 셋은 관측 대상이고 둘은 경계 표시다', () => {
    expect(RESEARCH_STAGE_KEYS).toEqual(['draft', 'received', 'searching', 'sourcing', 'done']);
    expect(RESEARCH_MEASURED_STAGE_KEYS).toEqual(['received', 'searching', 'sourcing']);
    expect(RESEARCH_MARKER_STAGE_KEYS).toEqual(['draft', 'done']);
  });

  it('서버 phase가 앞으로 갈 때마다 방금 떠난 rail 칸의 소요시간을 남긴다', () => {
    let telemetry = emptyStageTelemetry();
    telemetry = recordResearchStageObservations({ telemetry, briefs: [receipt('planning')], now: 0 }).telemetry;
    telemetry = recordResearchStageObservations({ telemetry, briefs: [receipt('branching')], now: 30_000 }).telemetry;
    telemetry = recordResearchStageObservations({ telemetry, briefs: [receipt('triangulating')], now: 300_000 }).telemetry;
    telemetry = recordResearchStageObservations({ telemetry, briefs: [receipt('done')], now: 400_000 }).telemetry;

    const stats = researchStageStats(telemetry);
    expect(stats.received).toMatchObject({ stage: 'received', samples: 1, medianMs: 30_000 });
    expect(stats.searching).toMatchObject({ stage: 'searching', samples: 1, medianMs: 270_000 });
    expect(stats.sourcing).toMatchObject({ stage: 'sourcing', samples: 1, medianMs: 100_000 });
    // 경계 칸에는 표본이 생기지 않는다 — 그래서 marker로 다뤄야 한다.
    expect(stats.draft).toBeNull();
    expect(stats.done).toBeNull();
  });

  it('phase를 주지 않는 서버에서는 관측하지 않는다 — "순식간"이 아니라 "못 봤다"이기 때문', () => {
    let telemetry = emptyStageTelemetry();
    telemetry = recordResearchStageObservations({ telemetry, briefs: [receipt(undefined)], now: 0 }).telemetry;
    telemetry = recordResearchStageObservations({ telemetry, briefs: [receipt(undefined, { status: 'processed' })], now: 600_000 }).telemetry;

    const stats = researchStageStats(telemetry);
    // 0ms 표본이 생기면 `공개 자료 조사 중` 칸이 0폭으로 굳어 막대가 거짓말을 한다.
    expect(stats.searching).toBeNull();
    expect(stats.sourcing).toBeNull();
    expect(stats.received).toBeNull();
    expect(researchStageSightings([receipt(undefined)])).toEqual([]);
  });

  it('phase로 지켜보던 중에 온 종료 상태는 마지막 구간을 닫아 준다', () => {
    let telemetry = emptyStageTelemetry();
    telemetry = recordResearchStageObservations({ telemetry, briefs: [receipt('synthesizing')], now: 0 }).telemetry;
    telemetry = recordResearchStageObservations({ telemetry, briefs: [receipt(undefined, { status: 'processed' })], now: 120_000 }).telemetry;
    expect(researchStageStats(telemetry).sourcing).toMatchObject({ samples: 1, medianMs: 120_000 });
  });

  it('조사 관측은 캡처 관측과 같은 통을 쓰되 이름이 섞이지 않는다', () => {
    const telemetry = recordResearchStageObservations({
      telemetry: recordResearchStageObservations({ telemetry: emptyStageTelemetry(), briefs: [receipt('planning')], now: 0 }).telemetry,
      briefs: [receipt('branching')],
      now: 30_000,
    }).telemetry;
    // 몇 분짜리 조사 시간이 몇 초짜리 캡처 단계의 중앙값을 끌고 가면 안 된다.
    expect(telemetry.stages['research:received']).toEqual([30_000]);
    expect(telemetry.stages.receive).toBeUndefined();
    expect(telemetry.stages.received).toBeUndefined();
  });

  it('관측은 subject namespace 안에 저장된다 (ISS-000112)', () => {
    syncResearchStageTelemetry({ briefs: [receipt('planning')], now: 0 });
    syncResearchStageTelemetry({ briefs: [receipt('branching')], now: 45_000 });

    expect(store.getItem(`cc_${OWNER}_stageDurations`)).toContain('research:received');
    expect(store.getItem('cc_stageDurations')).toBeNull();

    setActiveSubject(subjectIdOf('https://api.example.test/exec', 'guest-token'));
    expect(researchStageStats().received).toBeNull();
  });

  it('관측이 세 번 쌓이면 조사 막대가 실제로 시간에 비례한다', () => {
    let telemetry = emptyStageTelemetry();
    let now = 0;
    for (let round = 0; round < 3; round += 1) {
      const id = `r${round}`;
      const at = (phase: string, over: Partial<BriefItem> = {}) => ({ ...receipt(phase, over), captureId: id } as BriefItem);
      telemetry = recordResearchStageObservations({ telemetry, briefs: [at('planning')], now }).telemetry;
      now += 20_000;
      telemetry = recordResearchStageObservations({ telemetry, briefs: [at('branching')], now }).telemetry;
      now += 240_000;
      telemetry = recordResearchStageObservations({ telemetry, briefs: [at('synthesizing')], now }).telemetry;
      now += 60_000;
      telemetry = recordResearchStageObservations({ telemetry, briefs: [at('done')], now }).telemetry;
      now += 10_000;
    }

    const weighting = researchStageWeighting(researchStageStats(telemetry));
    expect(weighting.confident).toBe(true);
    const shares = Object.fromEntries(weighting.weights.map((weight) => [weight.key, weight.share]));
    // `공개 자료 조사 중`이 실제로 가장 오래 걸리므로 가장 넓어야 한다.
    expect(shares.searching).toBeGreaterThan(shares.sourcing);
    expect(shares.sourcing).toBeGreaterThan(shares.received);
    expect(weighting.weights.reduce((sum, weight) => sum + weight.share, 0)).toBeCloseTo(1, 10);
  });

  it('관측이 없으면 조사 막대는 균등이고 그 사실을 밝힌다', () => {
    expect(researchStageWeighting(researchStageStats(emptyStageTelemetry()))).toMatchObject({
      confident: false,
      reason: 'insufficient_samples',
    });
  });
});

describe('recallStages', () => {
  it('대조 단계는 지어낸 숫자가 아니라 실제 기록 수를 말한다', () => {
    const stages = recallStages('match', 86);
    expect(stages.find((stage) => stage.state === 'active')?.headline).toBe('이 기기에 있는 기록 86건을 대조하고 있어요');
  });

  it('완료 단계에서는 앞 단계가 모두 done이다', () => {
    expect(recallStages('done', 3).map((stage) => stage.state)).toEqual(['done', 'done', 'done', 'active']);
  });
});

describe('elapsedLabel', () => {
  it('1초 미만은 소수 첫째 자리까지 보여 준다', () => {
    expect(elapsedLabel(180)).toBe('0.2초');
    expect(elapsedLabel(0)).toBe('0.0초');
  });

  it('10초를 넘으면 반올림한 초, 1분을 넘으면 분·초로 말한다', () => {
    expect(elapsedLabel(12_400)).toBe('12초');
    expect(elapsedLabel(83_000)).toBe('1분 23초');
  });

  it('음수는 0으로 다룬다', () => {
    expect(elapsedLabel(-500)).toBe('0.0초');
  });
});
