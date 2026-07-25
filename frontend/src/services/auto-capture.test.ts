import { describe, expect, it } from 'vitest';
// @ts-expect-error The legacy UMD fixture intentionally has no TypeScript declaration.
import legacyVision from '../../../docs/camera-quality.js';
import { blankAutoCaptureState, nextAutoCaptureState } from './auto-capture';

describe('stable auto-capture parity', () => {
  const quad = [{ x: 20, y: 20 }, { x: 180, y: 20 }, { x: 180, y: 110 }, { x: 20, y: 110 }];

  it('matches the legacy stable-frame gate before firing', () => {
    let candidate = blankAutoCaptureState();
    let legacy = legacyVision.blankGate();
    for (const now of [0, 170, 340, 510, 680]) {
      const sample = { detected: true, plausible: true, quad, frameWidth: 200, frameHeight: 130, blur: 90, clippedRatio: 0.1 };
      candidate = nextAutoCaptureState(candidate, sample, now);
      legacy = legacyVision.nextAutoGate(legacy, sample, now);
    }
    expect(candidate).toMatchObject({ fired: true, progress: 1, reason: 'ready' });
    expect(candidate).toEqual(legacy);
  });

  it.each([
    [{ ...blankAutoCaptureState() }, { detected: false }, 'searching'],
    [blankAutoCaptureState(), { detected: true, plausible: true, quad, frameWidth: 200, frameHeight: 130, blur: 10, clippedRatio: 0.1 }, 'blur'],
    [blankAutoCaptureState(), { detected: true, plausible: true, quad, frameWidth: 200, frameHeight: 130, blur: 90, clippedRatio: 0.95 }, 'glare'],
  ])('preserves the %s rejection reason', (previous, sample, reason) => {
    expect(nextAutoCaptureState(previous, sample, 100).reason).toBe(reason);
  });
});
