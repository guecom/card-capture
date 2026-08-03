import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STAGE_SAMPLE_MAX_MS,
  STAGE_SAMPLE_WINDOW,
  STAGE_WATCH_MAX,
  emptyStageTelemetry,
  loadStageTelemetry,
  observeStages,
  parseStageTelemetry,
  saveStageTelemetry,
  stageStat,
  stageStats,
  typicalRangeText,
  withStageSamples,
} from './stage-telemetry';
import { setActiveSubject, subjectIdOf } from './storage';
import { FakeStorage } from './test-storage';

const ORDER = ['upload', 'receive', 'process', 'complete'] as const;

let store: FakeStorage;

beforeEach(() => {
  store = new FakeStorage();
  vi.stubGlobal('localStorage', store);
});

afterEach(() => vi.unstubAllGlobals());

describe('stage duration observation', () => {
  it('처음 본 캡처는 기록만 하고 표본을 만들지 않는다', () => {
    const result = observeStages({
      telemetry: emptyStageTelemetry(),
      sightings: [{ id: 'c1', stage: 'receive', rank: 1 }],
      now: 1_000,
      order: ORDER,
    });
    // 언제 그 단계에 들어왔는지 모르는 채로 소요시간을 주장할 수 없다.
    expect(result.samples).toEqual([]);
    expect(result.telemetry.watch.c1).toEqual({ stage: 'receive', rank: 1, since: 1_000 });
    expect(result.changed).toBe(true);
  });

  it('단계가 앞으로 갔을 때만 방금 떠난 단계의 소요시간을 남긴다', () => {
    const first = observeStages({ telemetry: emptyStageTelemetry(), sightings: [{ id: 'c1', stage: 'receive', rank: 1 }], now: 0, order: ORDER });
    const second = observeStages({ telemetry: first.telemetry, sightings: [{ id: 'c1', stage: 'process', rank: 2 }], now: 12_000, order: ORDER });

    expect(second.samples).toEqual([{ stage: 'receive', ms: 12_000 }]);
    expect(second.telemetry.stages.receive).toEqual([12_000]);
    expect(second.telemetry.watch.c1).toEqual({ stage: 'process', rank: 2, since: 12_000 });
  });

  it('같은 단계를 다시 보면 아무것도 바뀌지 않는다 — 폴링마다 저장하지 않기 위해', () => {
    const first = observeStages({ telemetry: emptyStageTelemetry(), sightings: [{ id: 'c1', stage: 'receive', rank: 1 }], now: 0, order: ORDER });
    const again = observeStages({ telemetry: first.telemetry, sightings: [{ id: 'c1', stage: 'receive', rank: 1 }], now: 4_000, order: ORDER });

    expect(again.samples).toEqual([]);
    expect(again.changed).toBe(false);
    expect(again.telemetry.watch.c1.since).toBe(0);
  });

  it('한 번에 여러 단계를 건너뛰면 지나온 중간 단계는 0ms로 관측된다', () => {
    const first = observeStages({ telemetry: emptyStageTelemetry(), sightings: [{ id: 'c1', stage: 'process', rank: 2 }], now: 0, order: ORDER });
    const done = observeStages({ telemetry: first.telemetry, sightings: [{ id: 'c1', stage: 'done', rank: 4 }], now: 90_000, order: ORDER });

    // `결과 준비`에 머문 것을 한 번도 보지 못했다 = 0ms. 지어낸 값이 아니라 관측된 사실이다.
    expect(done.samples).toEqual([{ stage: 'process', ms: 90_000 }, { stage: 'complete', ms: 0 }]);
  });

  it('서버가 뒤로 돌아가면 그 구간을 소요시간으로 주장하지 않는다', () => {
    const first = observeStages({ telemetry: emptyStageTelemetry(), sightings: [{ id: 'c1', stage: 'process', rank: 2 }], now: 0, order: ORDER });
    const back = observeStages({ telemetry: first.telemetry, sightings: [{ id: 'c1', stage: 'receive', rank: 1 }], now: 30_000, order: ORDER });

    expect(back.samples).toEqual([]);
    expect(back.telemetry.watch.c1).toEqual({ stage: 'receive', rank: 1, since: 30_000 });
  });

  it('앱을 오래 닫아 둔 벽시계는 표본으로 쓰지 않는다', () => {
    const first = observeStages({ telemetry: emptyStageTelemetry(), sightings: [{ id: 'c1', stage: 'process', rank: 2 }], now: 0, order: ORDER });
    const late = observeStages({
      telemetry: first.telemetry,
      sightings: [{ id: 'c1', stage: 'done', rank: 4 }],
      now: STAGE_SAMPLE_MAX_MS + 1,
      order: ORDER,
    });

    expect(late.samples).toEqual([]);
    expect(late.telemetry.stages.process).toBeUndefined();
  });

  it('단계당 최근 관측만 남기고 지켜보는 캡처 수에도 상한이 있다', () => {
    let telemetry = emptyStageTelemetry();
    for (let index = 0; index < STAGE_SAMPLE_WINDOW + 5; index += 1) {
      telemetry = withStageSamples(telemetry, [{ stage: 'process', ms: index * 1_000 }]);
    }
    expect(telemetry.stages.process).toHaveLength(STAGE_SAMPLE_WINDOW);
    expect(telemetry.stages.process[0]).toBe(5_000);

    const many = Array.from({ length: STAGE_WATCH_MAX + 10 }, (_, index) => ({ id: `c${index}`, stage: 'receive', rank: 1 }));
    const watched = observeStages({ telemetry, sightings: many, now: 1_000, order: ORDER });
    expect(Object.keys(watched.telemetry.watch)).toHaveLength(STAGE_WATCH_MAX);
  });
});

describe('stage statistics', () => {
  const telemetry = withStageSamples(emptyStageTelemetry(), [
    { stage: 'process', ms: 60_000 },
    { stage: 'process', ms: 120_000 },
    { stage: 'process', ms: 180_000 },
    { stage: 'process', ms: 240_000 },
    { stage: 'process', ms: 300_000 },
  ]);

  it('중앙값·사분위·표본 수·산포를 함께 준다', () => {
    const stat = stageStat(telemetry, 'process');
    expect(stat).toMatchObject({ stage: 'process', samples: 5, medianMs: 180_000, lowMs: 120_000, highMs: 240_000 });
    expect(stat?.spread).toBeCloseTo((240_000 - 120_000) / 180_000, 6);
  });

  it('표본이 없는 단계는 0이 아니라 null이다', () => {
    expect(stageStat(telemetry, 'upload')).toBeNull();
    expect(stageStats(telemetry, ['upload', 'process']).upload).toBeNull();
  });

  it('모든 관측이 0이면 산포는 0이다 — 무한대가 아니다', () => {
    const flat = withStageSamples(emptyStageTelemetry(), [
      { stage: 'complete', ms: 0 },
      { stage: 'complete', ms: 0 },
      { stage: 'complete', ms: 0 },
    ]);
    expect(stageStat(flat, 'complete')).toMatchObject({ medianMs: 0, spread: 0, samples: 3 });
  });
});

describe('보통 범위 문구', () => {
  it('관측이 2건 미만이면 "보통"이라고 부르지 않는다', () => {
    const one = withStageSamples(emptyStageTelemetry(), [{ stage: 'process', ms: 120_000 }]);
    expect(typicalRangeText(stageStat(one, 'process'))).toBeNull();
  });

  it('관측된 범위를 점 추정이 아닌 범위로 말한다', () => {
    const many = withStageSamples(emptyStageTelemetry(), [
      { stage: 'process', ms: 120_000 },
      { stage: 'process', ms: 180_000 },
      { stage: 'process', ms: 300_000 },
      { stage: 'process', ms: 600_000 },
    ]);
    expect(typicalRangeText(stageStat(many, 'process'))).toBe('보통 3~6분');
  });

  it('위끝과 아래끝이 같은 눈금이면 한 값만 쓴다', () => {
    const tight = withStageSamples(emptyStageTelemetry(), [
      { stage: 'receive', ms: 5_000 },
      { stage: 'receive', ms: 5_000 },
      { stage: 'receive', ms: 5_000 },
    ]);
    expect(typicalRangeText(stageStat(tight, 'receive'))).toBe('보통 5초');
  });
});

describe('저장 자리', () => {
  it('subject namespace 안에만 쓰고, 익명 subject에서는 읽지도 쓰지도 않는다 (ISS-000112)', () => {
    const owner = subjectIdOf('https://api.example.test/exec', 'owner-token');
    setActiveSubject(owner);
    saveStageTelemetry(withStageSamples(emptyStageTelemetry(), [{ stage: 'process', ms: 60_000 }]));

    expect(store.getItem(`cc_${owner}_stageDurations`)).toContain('60000');
    expect(store.getItem('cc_stageDurations')).toBeNull();

    const guest = subjectIdOf('https://api.example.test/exec', 'guest-token');
    setActiveSubject(guest);
    // 다른 사람의 관측이 이 사람의 막대 폭이 되지 않는다.
    expect(loadStageTelemetry().stages.process).toBeUndefined();

    setActiveSubject('anon');
    saveStageTelemetry(withStageSamples(emptyStageTelemetry(), [{ stage: 'process', ms: 999 }]));
    expect(store.getItem('cc_anon_stageDurations')).toBeNull();

    setActiveSubject(owner);
    expect(loadStageTelemetry().stages.process).toEqual([60_000]);
  });

  it('손상되거나 다른 버전인 저장 값은 폭을 결정하지 못한다', () => {
    expect(parseStageTelemetry('not json')).toEqual(emptyStageTelemetry());
    expect(parseStageTelemetry(JSON.stringify({ version: 99, stages: { process: [1] } }))).toEqual(emptyStageTelemetry());
    const dirty = parseStageTelemetry(JSON.stringify({
      version: 1,
      stages: { process: [1_000, -5, 'x', STAGE_SAMPLE_MAX_MS + 1] },
      watch: { c1: { stage: 'process', rank: 2, since: 10 }, c2: { stage: 7 } },
    }));
    expect(dirty.stages.process).toEqual([1_000]);
    expect(Object.keys(dirty.watch)).toEqual(['c1']);
  });
});
