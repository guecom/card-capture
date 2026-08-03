import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_STAGE_KEYS,
  captureAttentionOf,
  captureProgress,
  captureStageSightings,
  lastUpdatedText,
  recordCaptureStageObservations,
  serverProvenStageSamples,
  stageIndexOf,
  syncCaptureStageTelemetry,
  waitingDetailText,
} from './capture-progress';
import { emptyStageTelemetry, stageStats, withStageSamples } from './stage-telemetry';
import { setActiveSubject, subjectIdOf } from './storage';
import { FakeStorage } from './test-storage';
import type { BriefItem, CaptureQueueItem } from '../contracts/capture';

const queue = (state: CaptureQueueItem['state'], tries = 0) => ({ captureId: 'c1', state, tries, images: [] } as unknown as CaptureQueueItem);
const brief = (over: Partial<BriefItem>) => ({ captureId: 'c1', status: 'received', ...over } as BriefItem);

/** `보통 5~10분`을 말할 만큼 관측이 쌓인 `서버 처리` 단계. */
const processStats = () => stageStats(
  withStageSamples(emptyStageTelemetry(), [
    { stage: 'process', ms: 300_000 },
    { stage: 'process', ms: 420_000 },
    { stage: 'process', ms: 600_000 },
  ]),
  CAPTURE_STAGE_KEYS,
);

describe('server-proven capture progress', () => {
  it('does not infer a later stage from contact or quick-name hints', () => {
    expect(stageIndexOf({ brief: brief({ status: 'received', contact: { name: '김지우' } }) })).toBe(1);
    expect(stageIndexOf({ brief: brief({ status: 'received', quickName: { name: '김지우' } as never }) })).toBe(1);
    expect(stageIndexOf({ brief: brief({ status: 'processing' }) })).toBe(2);
  });

  /**
   * DEC-000092 §2: 승인된 대기 문구는 `현재 단계 + 경과 + 보통 범위 + 마지막 갱신`이다.
   *
   * 이전 판의 단정은 `not.toMatch(/약|남음|보통|%/)`이었고 `보통 범위`를 **금지**했다 —
   * 승인안과 반대였다. 지켜야 하는 것은 두 가지뿐이다: **점 ETA 금지**와 **지어낸 퍼센트 금지**.
   * 관측된 범위는 추정이 아니라 이 기기가 실제로 본 값이라 허용된다.
   */
  it('shows elapsed observation without a point ETA or fabricated percentage', () => {
    const progress = captureProgress({ brief: brief({ status: 'processing' }), elapsedMinutes: 11 });
    expect(progress.percent).toBe(0);
    expect(progress.headline).toBe('서버에서 처리 중이에요');
    expect(progress.detail).toContain('11분 경과');
    expect(progress.detail).not.toMatch(/%/);
    expect(progress.detail).not.toMatch(/남음|남았|약\s*\d/);
  });

  it('관측이 없으면 범위를 지어내지 않고 모른다고 말한다', () => {
    const progress = captureProgress({ brief: brief({ status: 'processing' }), elapsedMinutes: 11 });
    expect(progress.detail).toBe('11분 경과 · 남은 시간은 아직 알 수 없어요');
    expect(progress.weighting.confident).toBe(false);
  });

  it('관측이 쌓이면 현재 단계의 보통 범위와 마지막 갱신을 함께 말한다', () => {
    const progress = captureProgress({
      brief: brief({ status: 'processing' }),
      elapsedMinutes: 11,
      stageStats: processStats(),
      refreshedAgoMs: 3_000,
    });
    expect(progress.detail).toBe('11분 경과 · 보통 6~9분 · 마지막 갱신 방금');
    expect(progress.detail).not.toMatch(/%/);
    expect(progress.detail).not.toMatch(/남음|남았|약\s*\d/);
  });

  it('보통 범위는 지금 서 있는 단계의 것이다 — 다른 단계의 관측을 빌려 오지 않는다', () => {
    const stats = processStats();
    const atReceive = captureProgress({ brief: brief({ status: 'received' }), elapsedMinutes: 2, stageStats: stats });
    expect(atReceive.headline).toBe('서버가 접수했어요');
    expect(atReceive.detail).toContain('남은 시간은 아직 알 수 없어요');
  });

  it('uses terminal status as the only 100% signal', () => {
    expect(captureProgress({ brief: brief({ status: 'processed' }) }).percent).toBe(1);
    expect(captureProgress({ brief: brief({ status: 'skipped' }) }).done).toBe(true);
  });

  it('keeps skipped terminal truth while presenting bounded human-input recovery', () => {
    const progress = captureProgress({ brief: brief({
      status: 'skipped',
      attention: { kind: 'input_required', reasonCode: 'identity_ambiguous', requestedAt: '2026-08-02T09:00:00.000Z' },
    }) });
    expect(progress.done).toBe(true);
    expect(progress.percent).toBe(1);
    expect(progress.headline).toBe('확인이 필요해요');
    expect(progress.detail).toContain('이름이나 회사');
    expect(progress.detail).not.toContain('identity_ambiguous');
  });

  it('does not render an unrecognized server attention reason', () => {
    const unsafe = brief({
      status: 'skipped',
      attention: { kind: 'input_required', reasonCode: 'server_raw_reason', requestedAt: 'now' } as never,
    });
    expect(captureAttentionOf(unsafe)).toBeNull();
    expect(captureProgress({ brief: unsafe }).headline).toBe('명함이 아니어서 처리하지 않았어요');
  });

  it('keeps failed upload recovery actionable', () => {
    const progress = captureProgress({ queue: queue('failed', 2) });
    expect(progress.failed).toBe(true);
    expect(progress.detail).toContain('2회 시도');
    expect(progress.stages[0].state).toBe('failed');
  });
});

describe('단계 칸 폭 (DEC-000092 §2)', () => {
  it('관측이 없으면 네 칸이 균등하고 그 사실을 밝힌다', () => {
    const progress = captureProgress({ brief: brief({ status: 'processing' }) });
    expect(progress.stages.map((stage) => stage.share)).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(progress.weighting.confident).toBe(false);
  });

  it('관측이 충분하면 오래 걸리는 칸이 넓어진다', () => {
    const telemetry = withStageSamples(emptyStageTelemetry(), [
      ...[3_000, 4_000, 5_000].map((ms) => ({ stage: 'upload', ms })),
      ...[8_000, 9_000, 10_000].map((ms) => ({ stage: 'receive', ms })),
      ...[300_000, 330_000, 360_000].map((ms) => ({ stage: 'process', ms })),
      ...[0, 0, 0].map((ms) => ({ stage: 'complete', ms })),
    ]);
    const progress = captureProgress({
      brief: brief({ status: 'processing' }),
      stageStats: stageStats(telemetry, CAPTURE_STAGE_KEYS),
    });
    expect(progress.weighting.confident).toBe(true);
    const shares = Object.fromEntries(progress.stages.map((stage) => [stage.key, stage.share]));
    expect(shares.process).toBeGreaterThan(0.6);
    expect(shares.upload).toBeLessThan(shares.process);
    expect(progress.stages.reduce((sum, stage) => sum + stage.share, 0)).toBeCloseTo(1, 10);
  });
});

describe('마지막 갱신 문구', () => {
  it('모르면 아무 말도 하지 않는다', () => {
    expect(lastUpdatedText(null)).toBeNull();
    expect(lastUpdatedText(undefined)).toBeNull();
    expect(lastUpdatedText(Number.NaN)).toBeNull();
  });

  it('경과에 따라 방금·초·분·시간으로 말한다', () => {
    expect(lastUpdatedText(0)).toBe('마지막 갱신 방금');
    expect(lastUpdatedText(4_999)).toBe('마지막 갱신 방금');
    expect(lastUpdatedText(42_000)).toBe('마지막 갱신 42초 전');
    expect(lastUpdatedText(5 * 60_000)).toBe('마지막 갱신 5분 전');
    expect(lastUpdatedText(3 * 3_600_000)).toBe('마지막 갱신 3시간 전');
  });

  it('경과를 모르면 마지막 확인 상태만 말한다', () => {
    expect(waitingDetailText({ elapsedMinutes: null })).toBe('마지막으로 확인된 상태를 표시합니다');
    expect(waitingDetailText({ elapsedMinutes: null, refreshedAgoMs: 0 }))
      .toBe('마지막으로 확인된 상태를 표시합니다 · 마지막 갱신 방금');
  });
});

describe('관측 수집', () => {
  let store: FakeStorage;

  beforeEach(() => {
    store = new FakeStorage();
    vi.stubGlobal('localStorage', store);
    setActiveSubject(subjectIdOf('https://api.example.test/exec', 'owner-token'));
  });

  afterEach(() => {
    setActiveSubject('anon');
    vi.unstubAllGlobals();
  });

  it('서버 응답이 대기열 추정을 이긴다', () => {
    const sightings = captureStageSightings({
      queue: [{ captureId: 'c1', state: 'sent' } as CaptureQueueItem],
      briefs: [brief({ captureId: 'c1', status: 'processing' })],
    });
    expect(sightings).toEqual([{ id: 'c1', stage: 'process', rank: 2 }]);
  });

  it('전송 실패 항목은 관측하지 않는다 — 단계에 머문 시간이 아니다', () => {
    expect(captureStageSightings({ queue: [queue('failed')] })).toEqual([]);
  });

  it('조사 receipt는 캡처 단계 관측에 섞이지 않는다 — 몇 분짜리가 몇 초짜리 중앙값을 끈다', () => {
    const research = brief({
      captureId: 'r1',
      type: 'research_instruction',
      status: 'processing',
      capturedAt: '2026-08-02T09:00:00.000Z',
      receivedAt: '2026-08-02T09:20:00.000Z',
      researchProgress: { phase: 'branching' },
    });
    expect(captureStageSightings({ briefs: [research] })).toEqual([]);
    expect(serverProvenStageSamples([research])).toEqual([]);

    const result = recordCaptureStageObservations({ telemetry: emptyStageTelemetry(), briefs: [research], now: 1_000 });
    expect(result.telemetry.stages.upload).toBeUndefined();
    expect(result.changed).toBe(false);
  });

  it('촬영 시각과 서버 접수 시각의 차이는 관측을 기다리지 않고 바로 표본이 된다', () => {
    const samples = serverProvenStageSamples([brief({
      capturedAt: '2026-08-02T09:00:00.000Z',
      receivedAt: '2026-08-02T09:00:07.000Z',
    })]);
    expect(samples).toEqual([{ stage: 'upload', ms: 7_000 }]);
  });

  it('기기 시계가 서버보다 앞서 음수가 나오면 버린다', () => {
    expect(serverProvenStageSamples([brief({
      capturedAt: '2026-08-02T09:00:10.000Z',
      receivedAt: '2026-08-02T09:00:00.000Z',
    })])).toEqual([]);
  });

  it('이미 지켜보던 캡처는 같은 표본을 다시 넣지 않는다', () => {
    const item = brief({ capturedAt: '2026-08-02T09:00:00.000Z', receivedAt: '2026-08-02T09:00:07.000Z' });
    const first = recordCaptureStageObservations({ telemetry: emptyStageTelemetry(), briefs: [item], now: 1_000 });
    expect(first.telemetry.stages.upload).toEqual([7_000]);

    const second = recordCaptureStageObservations({ telemetry: first.telemetry, briefs: [item], now: 5_000 });
    expect(second.telemetry.stages.upload).toEqual([7_000]);
    expect(second.changed).toBe(false);
  });

  it('목록 동기화는 관측을 저장하고 지금 쓸 단계 요약을 돌려준다', () => {
    const item = brief({ capturedAt: '2026-08-02T09:00:00.000Z', receivedAt: '2026-08-02T09:00:06.000Z' });
    const stats = syncCaptureStageTelemetry({ briefs: [item], now: 1_000 });
    expect(stats.upload).toMatchObject({ samples: 1, medianMs: 6_000 });
    expect(Object.keys(stats)).toEqual([...CAPTURE_STAGE_KEYS]);
    expect(store.snapshot()[`cc_${subjectIdOf('https://api.example.test/exec', 'owner-token')}_stageDurations`]).toContain('6000');
  });
});
