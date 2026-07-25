import type { Point } from './opencv';

export interface AutoCaptureState {
  stableFrames: number;
  stableSince: number;
  lastQuad: Point[] | null;
  progress: number;
  fired: boolean;
  reason: 'searching' | 'blur' | 'glare' | 'steady' | 'ready';
}

export interface AutoCaptureSample {
  detected?: boolean;
  plausible?: boolean;
  quad?: Point[] | null;
  frameWidth?: number;
  frameHeight?: number;
  blur?: number | null;
  clippedRatio?: number;
}

const defaults = {
  minStableFrames: 5,
  minStableMs: 650,
  maxDrift: 0.018,
  minBlur: 45,
  maxClippedRatio: 0.92,
};

export function blankAutoCaptureState(): AutoCaptureState {
  return { stableFrames: 0, stableSince: 0, lastQuad: null, progress: 0, fired: false, reason: 'searching' };
}

export function clippedRatio(imageData: ImageData, threshold = 250): number {
  const data = imageData?.data;
  if (!data?.length) return 0;
  let clipped = 0;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index] >= threshold && data[index + 1] >= threshold && data[index + 2] >= threshold) clipped += 1;
  }
  return clipped / (data.length / 4);
}

function quadDrift(previous: Point[] | null, current: Point[], frameWidth = 1, frameHeight = 1): number {
  if (!previous || previous.length !== 4 || current.length !== 4) return Number.POSITIVE_INFINITY;
  const diagonal = Math.hypot(frameWidth, frameHeight) || 1;
  return current.reduce((total, point, index) => total + Math.hypot(previous[index].x - point.x, previous[index].y - point.y), 0) / 4 / diagonal;
}

export function nextAutoCaptureState(
  previous: AutoCaptureState,
  sample: AutoCaptureSample,
  now: number,
  overrides: Partial<typeof defaults> = {},
): AutoCaptureState {
  const config = { ...defaults, ...overrides };
  const next = blankAutoCaptureState();
  if (!sample.detected || !sample.plausible || !sample.quad) return next;
  next.lastQuad = sample.quad.map((point) => ({ ...point }));
  if (sample.blur !== null && sample.blur !== undefined && sample.blur < config.minBlur) {
    next.reason = 'blur';
    return next;
  }
  if ((sample.clippedRatio ?? 0) > config.maxClippedRatio) {
    next.reason = 'glare';
    return next;
  }

  const drift = quadDrift(previous.lastQuad, sample.quad, sample.frameWidth, sample.frameHeight);
  if (previous.lastQuad && drift > config.maxDrift) {
    next.stableFrames = 1;
    next.stableSince = now;
    next.reason = 'steady';
    next.progress = 1 / config.minStableFrames;
    return next;
  }

  next.stableFrames = previous.stableFrames + 1;
  next.stableSince = previous.stableFrames > 0 ? previous.stableSince : now;
  next.progress = Math.max(0, Math.min(1, Math.min(
    next.stableFrames / config.minStableFrames,
    (now - next.stableSince) / config.minStableMs,
  )));
  next.reason = 'steady';
  next.fired = next.stableFrames >= config.minStableFrames && now - next.stableSince >= config.minStableMs;
  if (next.fired) {
    next.progress = 1;
    next.reason = 'ready';
  }
  return next;
}
