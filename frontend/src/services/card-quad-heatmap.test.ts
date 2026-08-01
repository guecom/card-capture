import { describe, expect, it } from 'vitest';
import { quadFromCornerHeatmaps, rgbaToBgrChw } from './card-quad-heatmap';

describe('quadFromCornerHeatmaps', () => {
  it('uses the centroid of the largest component in each corner channel', () => {
    const width = 8;
    const height = 8;
    const channelSize = width * height;
    const data = new Float32Array(channelSize * 4);
    const blobs = [
      [[1, 1], [2, 1], [1, 2], [2, 2]],
      [[5, 1], [6, 1], [5, 2], [6, 2]],
      [[5, 5], [6, 5], [5, 6], [6, 6]],
      [[1, 5], [2, 5], [1, 6], [2, 6]],
    ];
    const decoys = [[7, 7], [0, 7], [0, 0], [7, 0]];
    blobs.forEach((blob, channel) => {
      blob.forEach(([x, y]) => { data[channel * channelSize + y * width + x] = 0.8 + channel * 0.02; });
      const [decoyX, decoyY] = decoys[channel];
      data[channel * channelSize + decoyY * width + decoyX] = 0.99;
    });

    const result = quadFromCornerHeatmaps(data, width, height, 80, 40);
    expect(result).not.toBeNull();
    expect(result!.quad[0]).toEqual({ x: 19.5, y: 9.5 });
    expect(result!.quad[2]).toEqual({ x: 59.5, y: 29.5 });
    expect(result!.confidence).toBeGreaterThan(0.79);
  });

  it('rejects a result when any corner channel has no confident component', () => {
    const data = new Float32Array(4 * 4 * 4);
    data.fill(0.2);
    expect(quadFromCornerHeatmaps(data, 4, 4, 40, 40)).toBeNull();
  });
});

describe('rgbaToBgrChw', () => {
  it('normalizes RGBA into BGR channel-first order', () => {
    const result = rgbaToBgrChw(new Uint8ClampedArray([
      255, 128, 0, 255,
      10, 20, 30, 255,
    ]));
    const values = Array.from(result);
    [0, 30 / 255, 128 / 255, 20 / 255, 1, 10 / 255].forEach((expected, index) => {
      expect(values[index]).toBeCloseTo(expected, 6);
    });
  });
});
