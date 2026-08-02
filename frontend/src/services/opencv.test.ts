import { describe, expect, it } from 'vitest';
import { inspectCardQuad, orderQuad, plausibleCard } from './opencv';

describe('OpenCV geometry boundary', () => {
  it('orders an unordered quadrilateral as TL, TR, BR, BL', () => {
    expect(orderQuad([
      { x: 300, y: 200 },
      { x: 20, y: 20 },
      { x: 20, y: 200 },
      { x: 300, y: 20 },
    ])).toEqual([
      { x: 20, y: 20 },
      { x: 300, y: 20 },
      { x: 300, y: 200 },
      { x: 20, y: 200 },
    ]);
  });

  it('accepts landscape and portrait business-card ratios', () => {
    expect(plausibleCard([{ x: 0, y: 0 }, { x: 180, y: 0 }, { x: 180, y: 100 }, { x: 0, y: 100 }])).toBe(true);
    expect(plausibleCard([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 180 }, { x: 0, y: 180 }])).toBe(true);
  });

  it('rejects tiny and implausibly square contours', () => {
    expect(plausibleCard([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }])).toBe(false);
    expect(plausibleCard([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }])).toBe(false);
  });

  it('rejects duplicate, non-finite, concave, and collapsed quads', () => {
    expect(inspectCardQuad([{ x: 0, y: 0 }, { x: 180, y: 0 }, { x: 180, y: 0 }, { x: 0, y: 100 }]).reason).toBe('duplicate-corner');
    expect(inspectCardQuad([{ x: 0, y: 0 }, { x: Number.NaN, y: 0 }, { x: 180, y: 100 }, { x: 0, y: 100 }]).reason).toBe('non-finite');
    expect(plausibleCard([{ x: 0, y: 0 }, { x: 180, y: 0 }, { x: 40, y: 45 }, { x: 0, y: 100 }])).toBe(false);
    expect(plausibleCard([{ x: 0, y: 0 }, { x: 180, y: 0 }, { x: 25, y: 15 }, { x: 0, y: 100 }])).toBe(false);
  });

  it('keeps a perspective business card valid and orders its corner identity consistently', () => {
    const perspective = [{ x: 32, y: 28 }, { x: 210, y: 18 }, { x: 190, y: 126 }, { x: 18, y: 112 }];
    expect(plausibleCard([perspective[2], perspective[0], perspective[3], perspective[1]])).toBe(true);
    expect(orderQuad([perspective[2], perspective[0], perspective[3], perspective[1]])).toEqual(perspective);
  });
});
