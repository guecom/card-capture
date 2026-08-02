import { describe, expect, it } from 'vitest';
import { agreeCardQuad } from './card-quad-agreement';
import type { Point } from './opencv';

const MODEL: Point[] = [
  { x: 45, y: 80 }, { x: 275, y: 72 }, { x: 282, y: 212 }, { x: 40, y: 220 },
];

const moved = (dx: number, dy: number): Point[] => MODEL.map((point) => ({ x: point.x + dx, y: point.y + dy }));

describe('learned/OpenCV card quad agreement', () => {
  it('accepts two detectors describing the same card even when corner order differs', () => {
    const openCv = moved(3, -2);
    const reordered = [openCv[2], openCv[3], openCv[0], openCv[1]];
    const result = agreeCardQuad(MODEL, reordered, 320, 300);

    expect(result.accepted).toBe(true);
    expect(result.reason).toBe('ok');
    expect(result.confidence).toBeGreaterThan(0.7);
  });

  it('rejects an unrelated desk rectangle despite a learned-model positive elsewhere', () => {
    const deskRectangle: Point[] = [
      { x: 4, y: 8 }, { x: 151, y: 8 }, { x: 151, y: 92 }, { x: 4, y: 92 },
    ];
    const result = agreeCardQuad(MODEL, deskRectangle, 320, 300);

    expect(result.accepted).toBe(false);
    expect(result.confidence).toBe(0);
  });

  it('fails closed when either detector has no valid quadrilateral', () => {
    expect(agreeCardQuad(null, MODEL, 320, 300).accepted).toBe(false);
    expect(agreeCardQuad(MODEL, null, 320, 300).accepted).toBe(false);
    expect(agreeCardQuad(MODEL, MODEL.slice(0, 3), 320, 300).reason).toBe('invalid');
  });

  it('rejects a rectangle with the same centre but materially different scale', () => {
    const oversized = MODEL.map((point) => ({
      x: 160 + (point.x - 160) * 1.55,
      y: 146 + (point.y - 146) * 1.55,
    }));
    const result = agreeCardQuad(MODEL, oversized, 320, 300);

    expect(result.accepted).toBe(false);
  });
});
