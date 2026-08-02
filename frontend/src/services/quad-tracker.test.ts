import { describe, expect, it } from 'vitest';
import { blankQuadTrackState, nextQuadTrackState } from './quad-tracker';
import type { Point } from './opencv';

const CARD: Point[] = [{ x: 20, y: 20 }, { x: 200, y: 20 }, { x: 200, y: 120 }, { x: 20, y: 120 }];
const shifted = (dx: number, dy = 0): Point[] => CARD.map((point) => ({ x: point.x + dx, y: point.y + dy }));

describe('quad temporal consensus', () => {
  it('does not expose a box until three consistent frames agree', () => {
    let state = blankQuadTrackState();
    state = nextQuadTrackState(state, CARD, 320, 180, 0.7);
    expect(state.locked).toBeNull();
    expect(state.status).toBe('acquiring');
    state = nextQuadTrackState(state, shifted(1), 320, 180, 0.71);
    expect(state.locked).toBeNull();
    state = nextQuadTrackState(state, shifted(-1), 320, 180, 0.72);
    expect(state.accepted).toBe(true);
    expect(state.status).toBe('locked');
  });

  it('rejects malformed frames without replacing the locked card', () => {
    let state = blankQuadTrackState();
    for (let index = 0; index < 3; index += 1) state = nextQuadTrackState(state, CARD, 320, 180, 0.7);
    const locked = state.locked;
    state = nextQuadTrackState(state, [{ x: 20, y: 20 }, { x: 210, y: 30 }, { x: 45, y: 70 }, { x: 20, y: 120 }], 320, 180);
    expect(state.status).toBe('rejected');
    expect(state.accepted).toBe(false);
    expect(state.locked).toEqual(locked);
  });

  it('rejects corners that sit excessively outside the camera frame', () => {
    const state = nextQuadTrackState(blankQuadTrackState(), [
      { x: -30, y: 30 }, { x: 250, y: 30 }, { x: 250, y: 180 }, { x: -30, y: 180 },
    ], 320, 240, 0.8);
    expect(state.accepted).toBe(false);
    expect(state.status).toBe('rejected');
    expect(state.rejection).toBe('out-of-frame');
  });

  it('does not chase one-frame challengers and switches only after consensus', () => {
    let state = blankQuadTrackState();
    for (let index = 0; index < 3; index += 1) state = nextQuadTrackState(state, CARD, 320, 180, 0.55);
    const original = state.locked;
    state = nextQuadTrackState(state, shifted(24), 320, 180, 0.75);
    expect(state.status).toBe('switching');
    expect(state.accepted).toBe(false);
    expect(state.locked).toEqual(original);
    for (let index = 0; index < 3; index += 1) state = nextQuadTrackState(state, shifted(24 + (index % 2)), 320, 180, 0.75);
    expect(state.status).toBe('locked');
    expect(state.accepted).toBe(true);
    expect(state.locked?.[0].x).toBeGreaterThan(35);
  });

  it('does not replace a locked card without the required confidence margin', () => {
    let state = blankQuadTrackState();
    for (let index = 0; index < 3; index += 1) state = nextQuadTrackState(state, CARD, 320, 180, 0.76);
    const original = state.locked;

    for (let index = 0; index < 12; index += 1) {
      state = nextQuadTrackState(state, shifted(24), 320, 180, 0.8);
      expect(state.accepted).toBe(false);
      expect(state.locked).toEqual(original);
      expect(state.rejection).toBe('confidence-margin');
    }
  });

  it('expires a lock only after genuinely missing frames, then reacquires from scratch', () => {
    let state = blankQuadTrackState();
    for (let index = 0; index < 3; index += 1) state = nextQuadTrackState(state, CARD, 320, 180, 0.76);

    for (let index = 0; index < 4; index += 1) state = nextQuadTrackState(state, null, 320, 180, 0);
    expect(state.locked).toBeNull();
    expect(state.rejection).toBe('missing');

    for (let index = 0; index < 2; index += 1) state = nextQuadTrackState(state, shifted(24), 320, 180, 0.8);
    expect(state.locked).toBeNull();
    state = nextQuadTrackState(state, shifted(24), 320, 180, 0.8);
    expect(state.accepted).toBe(true);
    expect(state.locked?.[0].x).toBeGreaterThan(35);
  });
});
