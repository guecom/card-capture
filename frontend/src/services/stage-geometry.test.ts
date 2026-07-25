import { describe, expect, it } from 'vitest';
import { coverMap, guideRectDisplay, guideRectInVideo, lerpQuad, rectToQuad, videoPointToDisplay } from './stage-geometry';

describe('coverMap', () => {
  it('scales like object-fit cover and centers the overflow', () => {
    const map = coverMap(1600, 900, 400, 400);
    expect(map.scale).toBeCloseTo(400 / 900);
    expect(map.offsetY).toBe(0);
    expect(map.offsetX).toBeLessThan(0);
  });

  it('maps video points into display space', () => {
    const map = coverMap(1000, 1000, 500, 500);
    expect(videoPointToDisplay(map, { x: 100, y: 200 })).toEqual({ x: 50, y: 100 });
  });
});

describe('guideRectDisplay', () => {
  it('uses 88% width capped at 520 with card aspect', () => {
    const rect = guideRectDisplay(375, 812);
    expect(rect.w).toBeCloseTo(330);
    expect(rect.h).toBeCloseTo(330 / 1.75);
    expect(rect.x).toBeCloseTo((375 - 330) / 2);
    const wide = guideRectDisplay(1000, 800);
    expect(wide.w).toBe(520);
  });

  it('converts to a quad clockwise from top-left', () => {
    const quad = rectToQuad({ x: 1, y: 2, w: 10, h: 20 });
    expect(quad).toEqual([
      { x: 1, y: 2 },
      { x: 11, y: 2 },
      { x: 11, y: 22 },
      { x: 1, y: 22 },
    ]);
  });
});

describe('guideRectInVideo', () => {
  it('returns an expanded, clamped crop region in video coordinates', () => {
    const map = coverMap(2560, 1440, 375, 500);
    const rect = guideRectInVideo(map);
    expect(rect).not.toBeNull();
    if (!rect) return;
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.w).toBeLessThanOrEqual(2560);
    expect(rect.y + rect.h).toBeLessThanOrEqual(1440);
    expect(rect.w).toBeGreaterThan(40);
    expect(rect.h).toBeGreaterThan(40);
  });

  it('returns null when the video has no dimensions', () => {
    expect(guideRectInVideo(coverMap(0, 0, 375, 500))).toBeNull();
  });
});

describe('lerpQuad', () => {
  const target = rectToQuad({ x: 10, y: 10, w: 100, h: 60 });

  it('snaps to target when there is no previous quad', () => {
    expect(lerpQuad(null, target, 0.3)).toEqual(target);
  });

  it('moves a fraction toward the target', () => {
    const start = rectToQuad({ x: 0, y: 0, w: 100, h: 60 });
    const next = lerpQuad(start, target, 0.5);
    expect(next[0]).toEqual({ x: 5, y: 5 });
  });
});
