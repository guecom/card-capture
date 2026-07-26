import { describe, expect, it } from 'vitest';
import { captureProgress, refreshHint, stageIndexOf, TYPICAL_TOTAL_RANGE } from './capture-progress';
import type { BriefItem, CaptureQueueItem } from '../contracts/capture';

const queue = (state: CaptureQueueItem['state'], tries = 0) => ({ captureId: 'c1', state, tries, images: [] } as unknown as CaptureQueueItem);
const brief = (over: Partial<BriefItem>) => ({ captureId: 'c1', status: 'received', ...over } as BriefItem);

describe('stageIndexOf', () => {
  it('maps local queue and server states onto one ladder', () => {
    expect(stageIndexOf({ queue: queue('queued') })).toBe(0);
    expect(stageIndexOf({ queue: queue('sent') })).toBe(1);
    expect(stageIndexOf({ brief: brief({ status: 'received' }) })).toBe(2);
    // quickName은 기기에서 미리 채운 값이라 서버 진행 근거가 아니다 — contact가 있어야 인식 완료다.
    expect(stageIndexOf({ brief: brief({ status: 'received', quickName: { name: '김진우' } as never }) })).toBe(2);
    expect(stageIndexOf({ brief: brief({ status: 'received', contact: { name: '김진우' } as never }) })).toBe(3);
    expect(stageIndexOf({ brief: brief({ status: 'processing' }) })).toBe(3);
    expect(stageIndexOf({ brief: brief({ status: 'processed' }) })).toBe(4);
  });

  it('prefers the server view when both exist', () => {
    expect(stageIndexOf({ brief: brief({ status: 'processing' }), queue: queue('queued') })).toBe(3);
  });
});

describe('captureProgress', () => {
  it('says which step of how many, and what is left', () => {
    const progress = captureProgress({ brief: brief({ status: 'received' }), elapsedMinutes: 2 });
    expect(progress.step).toBe(3);
    expect(progress.total).toBe(4);
    expect(progress.headline).toBe('4단계 중 3단계 · 이름·정보 인식 중');
    expect(progress.detail).toContain('2분 경과');
    expect(progress.detail).toContain('남음');
    expect(progress.detail).toContain(`보통 ${TYPICAL_TOTAL_RANGE.min}~${TYPICAL_TOTAL_RANGE.max}분`);
    expect(progress.stages.map((stage) => stage.state)).toEqual(['done', 'done', 'active', 'todo']);
  });

  it('shrinks the estimate as time passes inside a stage', () => {
    const early = captureProgress({ brief: brief({ status: 'processing' }), elapsedMinutes: 5 });
    const later = captureProgress({ brief: brief({ status: 'processing' }), elapsedMinutes: 11 });
    const minutes = (text: string) => Number(/약 (\d+)분/.exec(text)?.[1] ?? '0');
    expect(minutes(later.detail)).toBeLessThan(minutes(early.detail));
    expect(minutes(later.detail)).toBeGreaterThan(0);
  });

  it('flags a late capture instead of promising a time', () => {
    const progress = captureProgress({ brief: brief({ status: 'processing' }), elapsedMinutes: 45 });
    expect(progress.late).toBe(true);
    expect(progress.detail).toContain('오래 걸리고 있어요');
    expect(progress.detail).not.toContain('남음');
  });

  it('reports completion with how long it took', () => {
    const progress = captureProgress({ brief: brief({ status: 'processed' }), elapsedMinutes: 12 });
    expect(progress.done).toBe(true);
    expect(progress.percent).toBe(1);
    expect(progress.headline).toBe('완료');
    expect(progress.detail).toContain('12분');
  });

  it('explains a skipped capture as a terminal state', () => {
    expect(captureProgress({ brief: brief({ status: 'skipped' }) }).headline).toBe('명함이 아니어서 건너뜀');
  });

  it('treats a failed upload as step 1 with a recovery message', () => {
    const progress = captureProgress({ queue: queue('failed', 2) });
    expect(progress.failed).toBe(true);
    expect(progress.stages[0].state).toBe('failed');
    expect(progress.headline).toContain('전송 실패');
    expect(progress.detail).toContain('2회');
  });

  it('starts at step 1 for a capture still waiting to upload', () => {
    const progress = captureProgress({ queue: queue('queued'), elapsedMinutes: 0 });
    expect(progress.step).toBe(1);
    expect(progress.headline).toBe('4단계 중 1단계 · 사진 전송 중');
  });
});

describe('refreshHint', () => {
  it('tells the user when the screen refreshes itself', () => {
    expect(refreshHint(12, 0)).toBe('방금 업데이트 · 12초 뒤 자동 새로고침');
    expect(refreshHint(1, 3)).toBe('3분 전 업데이트 · 곧 자동 새로고침');
    expect(refreshHint(20, null)).toBe('20초 뒤 자동 새로고침');
  });
});
