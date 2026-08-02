import { describe, expect, it } from 'vitest';
import { captureProgress, stageIndexOf } from './capture-progress';
import type { BriefItem, CaptureQueueItem } from '../contracts/capture';

const queue = (state: CaptureQueueItem['state'], tries = 0) => ({ captureId: 'c1', state, tries, images: [] } as unknown as CaptureQueueItem);
const brief = (over: Partial<BriefItem>) => ({ captureId: 'c1', status: 'received', ...over } as BriefItem);

describe('server-proven capture progress', () => {
  it('does not infer a later stage from contact or quick-name hints', () => {
    expect(stageIndexOf({ brief: brief({ status: 'received', contact: { name: '김지우' } }) })).toBe(1);
    expect(stageIndexOf({ brief: brief({ status: 'received', quickName: { name: '김지우' } as never }) })).toBe(1);
    expect(stageIndexOf({ brief: brief({ status: 'processing' }) })).toBe(2);
  });

  it('shows elapsed observation without percentage, ETA, or typical range', () => {
    const progress = captureProgress({ brief: brief({ status: 'processing' }), elapsedMinutes: 11 });
    expect(progress.percent).toBe(0);
    expect(progress.headline).toBe('서버에서 처리 중이에요');
    expect(progress.detail).toContain('11분 경과');
    expect(progress.detail).toContain('아직 알 수 없어요');
    expect(progress.detail).not.toMatch(/약|남음|보통|%/);
  });

  it('uses terminal status as the only 100% signal', () => {
    expect(captureProgress({ brief: brief({ status: 'processed' }) }).percent).toBe(1);
    expect(captureProgress({ brief: brief({ status: 'skipped' }) }).done).toBe(true);
  });

  it('keeps failed upload recovery actionable', () => {
    const progress = captureProgress({ queue: queue('failed', 2) });
    expect(progress.failed).toBe(true);
    expect(progress.detail).toContain('2회 시도');
    expect(progress.stages[0].state).toBe('failed');
  });
});
