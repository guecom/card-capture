import type { Point } from './opencv';

export type CardQuadModelGateStatus = 'waiting' | 'positive' | 'negative' | 'unavailable';

export interface CardQuadModelGateState {
  status: CardQuadModelGateStatus;
  quad: Point[] | null;
  confidence: number;
  at: number;
  negativeStreak: number;
}

// A slow device can return one noisy negative between two useful model frames.
// Hold the last positive briefly, but require repeated negatives to close it so a
// removed card does not leave the OpenCV path enabled indefinitely.
export const MODEL_POSITIVE_TTL_MS = 5_000;
export const MODEL_NEGATIVES_TO_CLOSE = 2;

export function blankCardQuadModelGate(): CardQuadModelGateState {
  return { status: 'waiting', quad: null, confidence: 0, at: 0, negativeStreak: 0 };
}

export function unavailableCardQuadModelGate(now: number): CardQuadModelGateState {
  return { status: 'unavailable', quad: null, confidence: 0, at: now, negativeStreak: 0 };
}

export function positiveCardQuadModelGate(
  quad: Point[],
  confidence: number,
  now: number,
): CardQuadModelGateState {
  return { status: 'positive', quad, confidence, at: now, negativeStreak: 0 };
}

export function negativeCardQuadModelGate(previous: CardQuadModelGateState, now: number): CardQuadModelGateState {
  const negativeStreak = previous.negativeStreak + 1;
  if (
    previous.status === 'positive'
    && previous.quad
    && now - previous.at <= MODEL_POSITIVE_TTL_MS
    && negativeStreak < MODEL_NEGATIVES_TO_CLOSE
  ) {
    return { ...previous, negativeStreak };
  }
  return { status: 'negative', quad: null, confidence: 0, at: now, negativeStreak };
}

export function activeCardQuadModelQuad(state: CardQuadModelGateState, now: number): Point[] | null {
  return state.status === 'positive' && state.quad && now - state.at <= MODEL_POSITIVE_TTL_MS
    ? state.quad
    : null;
}
