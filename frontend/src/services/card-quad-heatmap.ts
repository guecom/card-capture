import type { Point } from './opencv';

export interface HeatmapQuad {
  quad: Point[];
  confidence: number;
}

interface Component {
  size: number;
  sumX: number;
  sumY: number;
  peak: number;
}

function largestComponent(
  heatmap: Float32Array,
  channelOffset: number,
  width: number,
  height: number,
  threshold: number,
): Component | null {
  const pixels = width * height;
  const visited = new Uint8Array(pixels);
  const queue = new Int32Array(pixels);
  let best: Component | null = null;

  for (let seed = 0; seed < pixels; seed += 1) {
    if (visited[seed] || heatmap[channelOffset + seed] < threshold) continue;
    let head = 0;
    let tail = 0;
    queue[tail] = seed;
    tail += 1;
    visited[seed] = 1;
    const component: Component = { size: 0, sumX: 0, sumY: 0, peak: 0 };

    while (head < tail) {
      const pixel = queue[head];
      head += 1;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      const value = heatmap[channelOffset + pixel];
      component.size += 1;
      component.sumX += x;
      component.sumY += y;
      component.peak = Math.max(component.peak, value);

      for (let dy = -1; dy <= 1; dy += 1) {
        const nextY = y + dy;
        if (nextY < 0 || nextY >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dx && !dy) continue;
          const nextX = x + dx;
          if (nextX < 0 || nextX >= width) continue;
          const next = nextY * width + nextX;
          if (visited[next] || heatmap[channelOffset + next] < threshold) continue;
          visited[next] = 1;
          queue[tail] = next;
          tail += 1;
        }
      }
    }

    if (!best || component.size > best.size || (component.size === best.size && component.peak > best.peak)) {
      best = component;
    }
  }
  return best;
}

/**
 * DocAligner heatmap 후처리.
 * 각 corner channel에서 threshold 이상인 가장 큰 연결 성분의 중심을 찾는다.
 */
export function quadFromCornerHeatmaps(
  heatmap: Float32Array,
  heatmapWidth: number,
  heatmapHeight: number,
  imageWidth: number,
  imageHeight: number,
  threshold = 0.3,
): HeatmapQuad | null {
  const channelSize = heatmapWidth * heatmapHeight;
  if (heatmap.length < channelSize * 4 || !channelSize || !imageWidth || !imageHeight) return null;
  const quad: Point[] = [];
  let confidence = 0;

  for (let channel = 0; channel < 4; channel += 1) {
    const component = largestComponent(heatmap, channel * channelSize, heatmapWidth, heatmapHeight, threshold);
    if (!component?.size) return null;
    const centerX = component.sumX / component.size;
    const centerY = component.sumY / component.size;
    quad.push({
      x: (centerX + 0.5) * imageWidth / heatmapWidth - 0.5,
      y: (centerY + 0.5) * imageHeight / heatmapHeight - 0.5,
    });
    confidence += component.peak;
  }
  return { quad, confidence: confidence / 4 };
}

/** Browser RGBA pixels to the BGR CHW float tensor used by DocAligner. */
export function rgbaToBgrChw(rgba: Uint8ClampedArray): Float32Array {
  if (rgba.length % 4 !== 0) throw new Error('rgba_length');
  const pixels = rgba.length / 4;
  const tensor = new Float32Array(pixels * 3);
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const source = pixel * 4;
    tensor[pixel] = rgba[source + 2] / 255;
    tensor[pixels + pixel] = rgba[source + 1] / 255;
    tensor[pixels * 2 + pixel] = rgba[source] / 255;
  }
  return tensor;
}
