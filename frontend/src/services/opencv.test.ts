import { describe, expect, it } from 'vitest';
import { orderQuad, plausibleCard } from './opencv';

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
});
