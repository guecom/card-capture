export interface PixelFrame {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

export interface CaptureMotionFrame {
  width: number;
  height: number;
  luma: Uint8Array;
}

export interface CaptureMotionComparison {
  stable: boolean;
  reason: 'stable' | 'motion' | 'incompatible';
  meanResidual: number;
  changedRatio: number;
}

export interface CaptureMotionBurstResult {
  stable: boolean;
  reason: 'stable' | 'motion' | 'insufficient' | 'incompatible';
  pairs: number;
  maxMeanResidual: number;
  maxChangedRatio: number;
}

const defaults = {
  sampleWidth: 48,
  minimumBurstFrames: 3,
  maxMeanResidual: 0.025,
  maxChangedRatio: 0.1,
  changedLumaDelta: 0.06,
};

/**
 * Reduces an RGBA frame to a small luminance fingerprint. The fingerprint is
 * kept only in memory while an automatic shutter is pending; it is never
 * persisted or sent outside the device.
 */
export function captureMotionFrame(frame: PixelFrame, targetWidth = defaults.sampleWidth): CaptureMotionFrame {
  const sourceWidth = Math.max(0, Math.floor(frame.width));
  const sourceHeight = Math.max(0, Math.floor(frame.height));
  if (!sourceWidth || !sourceHeight || frame.data.length < sourceWidth * sourceHeight * 4) {
    return { width: 0, height: 0, luma: new Uint8Array() };
  }
  const width = Math.max(1, Math.min(sourceWidth, Math.floor(targetWidth)));
  const height = Math.max(1, Math.round(sourceHeight * width / sourceWidth));
  const luma = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(sourceHeight - 1, Math.floor((y + 0.5) * sourceHeight / height));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(sourceWidth - 1, Math.floor((x + 0.5) * sourceWidth / width));
      const sourceIndex = (sourceY * sourceWidth + sourceX) * 4;
      // Integer Rec. 709 approximation. Keeping this tiny makes the hot camera
      // path deterministic even on slower mobile devices.
      luma[y * width + x] = (
        54 * Number(frame.data[sourceIndex])
        + 183 * Number(frame.data[sourceIndex + 1])
        + 19 * Number(frame.data[sourceIndex + 2])
      ) >> 8;
    }
  }
  return { width, height, luma };
}

/**
 * Compares two fingerprints after removing a uniform exposure shift. Camera
 * auto-exposure may brighten the whole frame without physical movement, while
 * translation/shake leaves spatial residuals and a wider changed-pixel ratio.
 */
export function compareCaptureMotion(
  previous: CaptureMotionFrame,
  current: CaptureMotionFrame,
  overrides: Partial<typeof defaults> = {},
): CaptureMotionComparison {
  const config = { ...defaults, ...overrides };
  if (
    previous.width <= 0
    || previous.height <= 0
    || previous.width !== current.width
    || previous.height !== current.height
    || previous.luma.length !== current.luma.length
    || previous.luma.length === 0
  ) {
    return { stable: false, reason: 'incompatible', meanResidual: 1, changedRatio: 1 };
  }

  let exposureDelta = 0;
  for (let index = 0; index < previous.luma.length; index += 1) {
    exposureDelta += current.luma[index] - previous.luma[index];
  }
  exposureDelta /= previous.luma.length;

  let residualTotal = 0;
  let changed = 0;
  const changedThreshold = config.changedLumaDelta * 255;
  for (let index = 0; index < previous.luma.length; index += 1) {
    const residual = Math.abs((current.luma[index] - previous.luma[index]) - exposureDelta);
    residualTotal += residual;
    if (residual > changedThreshold) changed += 1;
  }
  const meanResidual = residualTotal / previous.luma.length / 255;
  const changedRatio = changed / previous.luma.length;
  const stable = meanResidual <= config.maxMeanResidual && changedRatio <= config.maxChangedRatio;
  return { stable, reason: stable ? 'stable' : 'motion', meanResidual, changedRatio };
}

export function assessCaptureMotionBurst(
  reference: CaptureMotionFrame,
  samples: CaptureMotionFrame[],
  overrides: Partial<typeof defaults> = {},
): CaptureMotionBurstResult {
  const config = { ...defaults, ...overrides };
  if (samples.length < config.minimumBurstFrames) {
    return { stable: false, reason: 'insufficient', pairs: samples.length, maxMeanResidual: 1, maxChangedRatio: 1 };
  }

  let previous = reference;
  let maxMeanResidual = 0;
  let maxChangedRatio = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const comparison = compareCaptureMotion(previous, sample, config);
    maxMeanResidual = Math.max(maxMeanResidual, comparison.meanResidual);
    maxChangedRatio = Math.max(maxChangedRatio, comparison.changedRatio);
    if (!comparison.stable) {
      return {
        stable: false,
        reason: comparison.reason,
        pairs: index + 1,
        maxMeanResidual,
        maxChangedRatio,
      };
    }
    previous = sample;
  }
  return { stable: true, reason: 'stable', pairs: samples.length, maxMeanResidual, maxChangedRatio };
}
