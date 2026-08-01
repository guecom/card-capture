import { inspectCardQuad, orderQuad, type Point } from './opencv';

export type QuadTrackStatus = 'searching' | 'acquiring' | 'locked' | 'switching' | 'rejected';

export interface QuadTrackState {
  locked: Point[] | null;
  challenger: Point[] | null;
  streak: number;
  misses: number;
  status: QuadTrackStatus;
  accepted: boolean;
  drift: number;
  rejection: string | null;
}

export interface QuadTrackConfig {
  acquireFrames: number;
  switchFrames: number;
  acquireDrift: number;
  lockedDrift: number;
  hardResetDrift: number;
  smoothing: number;
}

export const DEFAULT_QUAD_TRACK_CONFIG: QuadTrackConfig = {
  acquireFrames: 3,
  switchFrames: 4,
  acquireDrift: 0.025,
  lockedDrift: 0.035,
  hardResetDrift: 0.14,
  smoothing: 0.22,
};

export function blankQuadTrackState(): QuadTrackState {
  return { locked: null, challenger: null, streak: 0, misses: 0, status: 'searching', accepted: false, drift: 0, rejection: null };
}

function meanCornerDrift(a: Point[], b: Point[], diagonal: number): number {
  if (!diagonal) return Number.POSITIVE_INFINITY;
  return a.reduce((total, point, corner) => total + Math.hypot(point.x - b[corner].x, point.y - b[corner].y), 0) / (4 * diagonal);
}

function blendQuad(from: Point[], to: Point[], factor: number): Point[] {
  return from.map((point, index) => ({
    x: point.x + (to[index].x - point.x) * factor,
    y: point.y + (to[index].y - point.y) * factor,
  }));
}

export function nextQuadTrackState(
  previous: QuadTrackState,
  rawQuad: Point[] | null,
  frameWidth: number,
  frameHeight: number,
  config: QuadTrackConfig = DEFAULT_QUAD_TRACK_CONFIG,
): QuadTrackState {
  const diagonal = Math.hypot(frameWidth, frameHeight);
  if (!rawQuad) return { ...previous, accepted: false, misses: previous.misses + 1, status: 'searching', rejection: 'missing' };
  const marginX = frameWidth * 0.04;
  const marginY = frameHeight * 0.04;
  if (rawQuad.some((point) => point.x < -marginX || point.x > frameWidth + marginX || point.y < -marginY || point.y > frameHeight + marginY)) {
    return { ...previous, accepted: false, misses: previous.misses + 1, status: 'rejected', rejection: 'out-of-frame' };
  }
  const inspection = inspectCardQuad(rawQuad);
  if (!inspection.valid) {
    return { ...previous, accepted: false, misses: previous.misses + 1, status: 'rejected', rejection: inspection.reason };
  }
  const quad = orderQuad(inspection.ordered);

  if (!previous.locked) {
    const drift = previous.challenger ? meanCornerDrift(previous.challenger, quad, diagonal) : 0;
    const sameCandidate = Boolean(previous.challenger && drift <= config.acquireDrift);
    const challenger = sameCandidate && previous.challenger ? blendQuad(previous.challenger, quad, 0.35) : quad;
    const streak = sameCandidate ? previous.streak + 1 : 1;
    if (streak < config.acquireFrames) {
      return { locked: null, challenger, streak, misses: 0, status: 'acquiring', accepted: false, drift, rejection: null };
    }
    return { locked: challenger, challenger: null, streak: 0, misses: 0, status: 'locked', accepted: true, drift, rejection: null };
  }

  const lockedDrift = meanCornerDrift(previous.locked, quad, diagonal);
  if (lockedDrift <= config.lockedDrift) {
    const locked = blendQuad(previous.locked, quad, config.smoothing);
    return { locked, challenger: null, streak: 0, misses: 0, status: 'locked', accepted: true, drift: lockedDrift, rejection: null };
  }
  if (lockedDrift >= config.hardResetDrift) {
    return { locked: null, challenger: quad, streak: 1, misses: 0, status: 'acquiring', accepted: false, drift: lockedDrift, rejection: null };
  }

  const challengerDrift = previous.challenger ? meanCornerDrift(previous.challenger, quad, diagonal) : Number.POSITIVE_INFINITY;
  const sameChallenger = Boolean(previous.challenger && challengerDrift <= config.acquireDrift);
  const challenger = sameChallenger && previous.challenger ? blendQuad(previous.challenger, quad, 0.35) : quad;
  const streak = sameChallenger ? previous.streak + 1 : 1;
  if (streak < config.switchFrames) {
    return { ...previous, challenger, streak, misses: 0, status: 'switching', accepted: false, drift: lockedDrift, rejection: null };
  }
  return { locked: challenger, challenger: null, streak: 0, misses: 0, status: 'locked', accepted: true, drift: lockedDrift, rejection: null };
}
