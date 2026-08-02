import { describe, expect, it } from 'vitest';
import {
  activeCardQuadModelQuad,
  blankCardQuadModelGate,
  MODEL_POSITIVE_TTL_MS,
  negativeCardQuadModelGate,
  positiveCardQuadModelGate,
  unavailableCardQuadModelGate,
} from './card-quad-gate';

const quad = [
  { x: 20, y: 30 },
  { x: 220, y: 30 },
  { x: 220, y: 150 },
  { x: 20, y: 150 },
];

describe('card quad model gate', () => {
  it('keeps one slow or noisy negative from flickering a recent positive', () => {
    const positive = positiveCardQuadModelGate(quad, 0.8, 1_000);
    const noisyNegative = negativeCardQuadModelGate(positive, 1_700);

    expect(noisyNegative.status).toBe('positive');
    expect(activeCardQuadModelQuad(noisyNegative, 2_000)).toEqual(quad);
  });

  it('closes after repeated negatives so a removed card cannot keep the gate open', () => {
    const positive = positiveCardQuadModelGate(quad, 0.8, 1_000);
    const first = negativeCardQuadModelGate(positive, 1_700);
    const second = negativeCardQuadModelGate(first, 2_300);

    expect(second.status).toBe('negative');
    expect(activeCardQuadModelQuad(second, 2_300)).toBeNull();
  });

  it('expires a stale positive and represents an unavailable worker explicitly', () => {
    const positive = positiveCardQuadModelGate(quad, 0.8, 1_000);

    expect(activeCardQuadModelQuad(positive, 1_000 + MODEL_POSITIVE_TTL_MS + 1)).toBeNull();
    expect(unavailableCardQuadModelGate(4_000).status).toBe('unavailable');
  });
});
