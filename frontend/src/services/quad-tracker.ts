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
  lockedConfidence: number;
  challengerConfidence: number;
  rejection: string | null;
}

export interface QuadTrackConfig {
  acquireFrames: number;
  switchFrames: number;
  acquireDrift: number;
  lockedDrift: number;
  smoothing: number;
  switchConfidenceMargin: number;
  resetAfterMisses: number;
}

export const DEFAULT_QUAD_TRACK_CONFIG: QuadTrackConfig = {
  acquireFrames: 3,
  switchFrames: 4,
  acquireDrift: 0.025,
  lockedDrift: 0.035,
  smoothing: 0.22,
  switchConfidenceMargin: 0.08,
  resetAfterMisses: 4,
};

export function blankQuadTrackState(): QuadTrackState {
  return {
    locked: null,
    challenger: null,
    streak: 0,
    misses: 0,
    status: 'searching',
    accepted: false,
    drift: 0,
    lockedConfidence: 0,
    challengerConfidence: 0,
    rejection: null,
  };
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
  confidence = 0,
  config: QuadTrackConfig = DEFAULT_QUAD_TRACK_CONFIG,
): QuadTrackState {
  const diagonal = Math.hypot(frameWidth, frameHeight);
  if (!rawQuad) {
    const misses = previous.misses + 1;
    return misses >= config.resetAfterMisses
      ? { ...blankQuadTrackState(), misses, rejection: 'missing' }
      : { ...previous, accepted: false, misses, status: 'searching', rejection: 'missing' };
  }
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
    const challengerConfidence = sameCandidate
      ? previous.challengerConfidence * 0.65 + confidence * 0.35
      : confidence;
    if (streak < config.acquireFrames) {
      return {
        locked: null,
        challenger,
        streak,
        misses: 0,
        status: 'acquiring',
        accepted: false,
        drift,
        lockedConfidence: 0,
        challengerConfidence,
        rejection: null,
      };
    }
    return {
      locked: challenger,
      challenger: null,
      streak: 0,
      misses: 0,
      status: 'locked',
      accepted: true,
      drift,
      lockedConfidence: challengerConfidence,
      challengerConfidence: 0,
      rejection: null,
    };
  }

  const lockedDrift = meanCornerDrift(previous.locked, quad, diagonal);
  if (lockedDrift <= config.lockedDrift) {
    const locked = blendQuad(previous.locked, quad, config.smoothing);
    return {
      locked,
      challenger: null,
      streak: 0,
      misses: 0,
      status: 'locked',
      accepted: true,
      drift: lockedDrift,
      lockedConfidence: previous.lockedConfidence * 0.78 + confidence * 0.22,
      challengerConfidence: 0,
      rejection: null,
    };
  }

  // Geometry consensus alone must never replace a locked card. The challenger
  // also needs a clear confidence advantage over the current lock. If the old
  // card has genuinely disappeared, consecutive misses expire that lock and a
  // new card starts a fresh acquisition instead of silently replacing it.
  if (confidence < previous.lockedConfidence + config.switchConfidenceMargin) {
    const misses = previous.misses + 1;
    if (misses >= config.resetAfterMisses) {
      return {
        ...blankQuadTrackState(),
        challenger: quad,
        streak: 1,
        misses,
        status: 'acquiring',
        drift: lockedDrift,
        challengerConfidence: confidence,
        rejection: 'lock-expired',
      };
    }
    return {
      ...previous,
      challenger: null,
      streak: 0,
      misses,
      status: 'rejected',
      accepted: false,
      drift: lockedDrift,
      challengerConfidence: 0,
      rejection: 'confidence-margin',
    };
  }

  const challengerDrift = previous.challenger ? meanCornerDrift(previous.challenger, quad, diagonal) : Number.POSITIVE_INFINITY;
  const sameChallenger = Boolean(previous.challenger && challengerDrift <= config.acquireDrift);
  const challenger = sameChallenger && previous.challenger ? blendQuad(previous.challenger, quad, 0.35) : quad;
  const streak = sameChallenger ? previous.streak + 1 : 1;
  const challengerConfidence = sameChallenger
    ? previous.challengerConfidence * 0.65 + confidence * 0.35
    : confidence;
  if (streak < config.switchFrames) {
    return {
      ...previous,
      challenger,
      streak,
      misses: 0,
      status: 'switching',
      accepted: false,
      drift: lockedDrift,
      challengerConfidence,
      rejection: null,
    };
  }
  return {
    locked: challenger,
    challenger: null,
    streak: 0,
    misses: 0,
    status: 'locked',
    accepted: true,
    drift: lockedDrift,
    lockedConfidence: challengerConfidence,
    challengerConfidence: 0,
    rejection: null,
  };
}
