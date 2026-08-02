import { describe, expect, it } from 'vitest';
import {
  assessCaptureMotionBurst,
  captureMotionFrame,
  compareCaptureMotion,
  type PixelFrame,
} from './capture-stability';

function scene(offsetX = 0, exposure = 0): PixelFrame {
  const width = 80;
  const height = 48;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const shiftedX = x - offsetX;
      const card = shiftedX >= 14 && shiftedX < 68 && y >= 10 && y < 39;
      const text = card && y >= 19 && y < 23 && shiftedX >= 23 && shiftedX < 56;
      const texture = ((shiftedX * 17 + y * 29) % 11) - 5;
      const base = text ? 35 : card ? 232 : 96 + texture * 2;
      const value = Math.max(0, Math.min(255, base + exposure));
      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
      data[index + 3] = 255;
    }
  }
  return { width, height, data };
}

describe('post-trigger capture stability', () => {
  it('accepts a static scene and compensates a uniform exposure change', () => {
    const reference = captureMotionFrame(scene());
    const brighter = captureMotionFrame(scene(0, 18));

    expect(compareCaptureMotion(reference, brighter)).toMatchObject({ stable: true });
    expect(assessCaptureMotionBurst(reference, [brighter, brighter, brighter])).toMatchObject({
      stable: true,
      reason: 'stable',
      pairs: 3,
    });
  });

  it.each([2, 5])('rejects a %ipx translation that begins only after the auto gate is ready', (offset) => {
    const reference = captureMotionFrame(scene());
    const stable = captureMotionFrame(scene());
    const moved = captureMotionFrame(scene(offset));

    expect(compareCaptureMotion(stable, moved)).toMatchObject({ stable: false });
    expect(assessCaptureMotionBurst(reference, [stable, moved, moved])).toMatchObject({
      stable: false,
      reason: 'motion',
    });
  });

  it('fails closed when the burst has too few or incompatible frames', () => {
    const reference = captureMotionFrame(scene());
    const wrongShape = captureMotionFrame({ width: 40, height: 80, data: new Uint8ClampedArray(40 * 80 * 4) });

    expect(assessCaptureMotionBurst(reference, [reference, reference])).toMatchObject({ stable: false, reason: 'insufficient' });
    expect(compareCaptureMotion(reference, wrongShape)).toMatchObject({ stable: false, reason: 'incompatible' });
  });
});
