import { describe, expect, it } from 'vitest';
import type { StageStat } from './stage-telemetry';
import {
  MAX_CONFIDENT_SPREAD,
  MIN_CONFIDENT_SAMPLES,
  MIN_STAGE_SHARE,
  stageWidthPercents,
  weightStages,
} from './stage-weights';

const KEYS = ['upload', 'receive', 'process', 'complete'];

const stat = (stage: string, medianMs: number, over: Partial<StageStat> = {}): StageStat => ({
  stage,
  samples: MIN_CONFIDENT_SAMPLES,
  medianMs,
  lowMs: medianMs * 0.9,
  highMs: medianMs * 1.1,
  spread: 0.2,
  ...over,
});

const confidentStats = () => ({
  upload: stat('upload', 4_000),
  receive: stat('receive', 6_000),
  process: stat('process', 180_000),
  complete: stat('complete', 2_000),
});

describe('관측이 부족하면 균등 폭 + confident:false', () => {
  it('관측이 하나도 없으면 균등이다', () => {
    const weighting = weightStages(KEYS, {});
    expect(weighting.confident).toBe(false);
    expect(weighting.reason).toBe('insufficient_samples');
    expect(weighting.weights.map((weight) => weight.share)).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(weighting.weights.every((weight) => weight.medianMs === null)).toBe(true);
    expect(weighting.unproven).toEqual(KEYS);
  });

  it('한 단계라도 표본이 3개 미만이면 전체가 균등이다', () => {
    const stats = { ...confidentStats(), receive: stat('receive', 6_000, { samples: MIN_CONFIDENT_SAMPLES - 1 }) };
    const weighting = weightStages(KEYS, stats);
    // 일부만 비례하는 막대는 폭이 시간인지 아닌지 알 수 없어 지금보다 나쁘다.
    expect(weighting.confident).toBe(false);
    expect(weighting.reason).toBe('insufficient_samples');
    expect(weighting.unproven).toEqual(['receive']);
    expect(new Set(weighting.weights.map((weight) => weight.share))).toEqual(new Set([0.25]));
  });

  it('산포가 크면 대표값이 있어도 폭으로 시간을 말하지 않는다', () => {
    const stats = { ...confidentStats(), process: stat('process', 180_000, { spread: MAX_CONFIDENT_SPREAD + 0.01 }) };
    const weighting = weightStages(KEYS, stats);
    expect(weighting.confident).toBe(false);
    expect(weighting.reason).toBe('high_dispersion');
    expect(weighting.unproven).toEqual(['process']);
  });

  it('모든 대표값이 0이면 비례할 신호가 없다', () => {
    const flat = Object.fromEntries(KEYS.map((key) => [key, stat(key, 0, { lowMs: 0, highMs: 0, spread: 0 })]));
    const weighting = weightStages(KEYS, flat);
    expect(weighting.confident).toBe(false);
    expect(weighting.reason).toBe('no_duration_signal');
  });

  it('단계가 없으면 폭도 없다', () => {
    expect(weightStages([], {})).toMatchObject({ confident: false, reason: 'no_stages', weights: [] });
  });

  it('표본 수는 균등 폭일 때도 그대로 보고한다 — 얼마나 모였는지 화면이 알 수 있게', () => {
    const weighting = weightStages(KEYS, { process: stat('process', 1_000, { samples: 2 }) });
    expect(weighting.weights.find((weight) => weight.key === 'process')?.samples).toBe(2);
  });
});

describe('근거가 충분하면 중앙값에 비례한 폭', () => {
  it('오래 걸리는 단계가 넓다 — 읽지 않아도 남은 기다림의 크기를 알 수 있게', () => {
    const weighting = weightStages(KEYS, confidentStats());
    expect(weighting.confident).toBe(true);
    expect(weighting.reason).toBe('weighted');

    const shares = Object.fromEntries(weighting.weights.map((weight) => [weight.key, weight.share]));
    expect(shares.process).toBeGreaterThan(shares.upload);
    expect(shares.process).toBeGreaterThan(shares.receive);
    expect(shares.process).toBeGreaterThan(shares.complete);
    // 서버 처리가 전체 관측 시간의 대부분이므로 막대의 대부분을 차지해야 한다.
    expect(shares.process).toBeGreaterThan(0.5);
  });

  it('폭의 합은 항상 1이고, 두 배 걸리는 단계는 두 배 넓다', () => {
    const weighting = weightStages(['a', 'b'], { a: stat('a', 60_000), b: stat('b', 120_000) });
    const total = weighting.weights.reduce((sum, weight) => sum + weight.share, 0);
    expect(total).toBeCloseTo(1, 10);
    expect(weighting.weights[1].share / weighting.weights[0].share).toBeCloseTo(2, 6);
  });

  it('관측이 거의 0인 단계도 최소 폭은 지킨다 — 사라진 칸은 만질 수도 볼 수도 없다', () => {
    const stats = {
      ...confidentStats(),
      complete: stat('complete', 0, { lowMs: 0, highMs: 0, spread: 0 }),
    };
    const weighting = weightStages(KEYS, stats);
    expect(weighting.confident).toBe(true);
    const complete = weighting.weights.find((weight) => weight.key === 'complete');
    expect(complete?.share).toBeCloseTo(MIN_STAGE_SHARE, 6);
    // 최소 폭을 먹었어도 근거의 유무는 그대로 보고한다.
    expect(complete?.medianMs).toBe(0);
    expect(weighting.weights.reduce((sum, weight) => sum + weight.share, 0)).toBeCloseTo(1, 10);
  });

  it('최소 폭 하한은 조절할 수 있고, 0이면 순수 비례가 된다', () => {
    const stats = { a: stat('a', 1), b: stat('b', 999) };
    const weighting = weightStages(['a', 'b'], stats, { minShare: 0 });
    expect(weighting.weights[0].share).toBeCloseTo(1 / 1000, 6);
  });
});

describe('기다림이 아닌 칸 (marker)', () => {
  const rail = ['draft', 'received', 'searching', 'sourcing', 'done'];
  const markers = ['draft', 'done'];
  const measured = () => ({
    received: stat('received', 30_000),
    searching: stat('searching', 240_000),
    sourcing: stat('sourcing', 90_000),
  });

  it('marker 때문에 confident가 막히지 않는다 — 이것이 없으면 조사 rail은 영구히 균등 폭이다', () => {
    // marker를 표시하지 않으면 `draft`·`done`이 표본 0이라 영원히 `insufficient_samples`다.
    expect(weightStages(rail, measured()).confident).toBe(false);
    const weighting = weightStages(rail, measured(), { markers });
    expect(weighting.confident).toBe(true);
    expect(weighting.reason).toBe('weighted');
  });

  it('marker 칸은 가독 하한만 차지하고 나머지가 중앙값에 비례해 나눈다', () => {
    const weighting = weightStages(rail, measured(), { markers });
    const shares = Object.fromEntries(weighting.weights.map((weight) => [weight.key, weight.share]));
    expect(shares.draft).toBeCloseTo(MIN_STAGE_SHARE, 6);
    expect(shares.done).toBeCloseTo(MIN_STAGE_SHARE, 6);
    expect(shares.searching).toBeGreaterThan(shares.sourcing);
    expect(shares.sourcing).toBeGreaterThan(shares.received);
    expect(weighting.weights.reduce((sum, weight) => sum + weight.share, 0)).toBeCloseTo(1, 10);
  });

  it('marker 칸은 폭의 근거를 주장하지 않는다', () => {
    const weighting = weightStages(rail, { ...measured(), draft: stat('draft', 999_000) }, { markers });
    expect(weighting.weights.find((weight) => weight.key === 'draft')?.medianMs).toBeNull();
  });

  it('잴 수 있는 칸이 부족하거나 시끄러우면 여전히 균등으로 떨어진다', () => {
    const thin = { ...measured(), searching: stat('searching', 240_000, { samples: 1 }) };
    expect(weightStages(rail, thin, { markers })).toMatchObject({ confident: false, reason: 'insufficient_samples', unproven: ['searching'] });

    const noisy = { ...measured(), sourcing: stat('sourcing', 90_000, { spread: 4 }) };
    expect(weightStages(rail, noisy, { markers })).toMatchObject({ confident: false, reason: 'high_dispersion', unproven: ['sourcing'] });
  });

  it('전부 marker면 폭으로 시간을 말할 방법이 없다', () => {
    expect(weightStages(markers, {}, { markers })).toMatchObject({ confident: false, reason: 'no_stages' });
  });
});

describe('CSS 백분율', () => {
  it('반올림해도 합이 정확히 100이다', () => {
    const percents = stageWidthPercents(weightStages(KEYS, confidentStats()));
    expect(percents.reduce((sum, value) => sum + value, 0)).toBe(100);
    expect(percents).toHaveLength(4);
  });

  it('균등 4칸도 100으로 맞춘다 (25×4는 딱 맞고 3칸이면 34+33+33이다)', () => {
    expect(stageWidthPercents(weightStages(KEYS, {})).reduce((sum, value) => sum + value, 0)).toBe(100);
    expect(stageWidthPercents(weightStages(['a', 'b', 'c'], {})).reduce((sum, value) => sum + value, 0)).toBe(100);
  });

  it('칸이 없으면 빈 배열이다', () => {
    expect(stageWidthPercents(weightStages([], {}))).toEqual([]);
  });
});
