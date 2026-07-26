import { describe, expect, it } from 'vitest';
import { coverMap, coverMapInBox, guideRectDisplay, guideRectInVideo, lerpQuad, rectToQuad, videoPointToDisplay } from './stage-geometry';

describe('coverMap', () => {
  it('scales like object-fit cover and centers the overflow', () => {
    const map = coverMap(1600, 900, 400, 400);
    expect(map.scale).toBeCloseTo(400 / 900);
    expect(map.offsetY).toBe(0);
    expect(map.offsetX).toBeLessThan(0);
  });

  it('maps video points into display space', () => {
    const map = coverMap(1000, 1000, 500, 500);
    expect(videoPointToDisplay(map, { x: 100, y: 200 })).toEqual({ x: 50, y: 100 });
  });
});

describe('coverMapInBox', () => {
  // 실제로 회귀가 났던 형상: 341x455 오버레이 위에 341x606 비디오(720x1280 프레임)가 얹혀
  // 스테이지 아래로 넘쳐 있었다. 화면에는 프레임의 위쪽이 보이므로 offsetY는 0이어야 한다.
  // 상자가 같다고 가정하던 예전 계산은 -75.6을 내놨고, 그만큼 감지 박스가 명함 위로 떴다.
  it('keeps the overlay on the card when the video box overflows the overlay box', () => {
    const overlayBox = { left: 17, top: 84, width: 341, height: 455 };
    const videoBox = { left: 17, top: 84, width: 341, height: 606 };
    const map = coverMapInBox(720, 1280, videoBox, overlayBox);
    expect(map.scale).toBeCloseTo(341 / 720, 4);
    expect(map.offsetX).toBeCloseTo(0, 1);
    expect(map.offsetY).toBeCloseTo(0, 0); // 606은 반올림된 rect 값이라 -0.11이 남는다
    // 프레임 세로 중앙(640)은 화면에서도 비디오 상자의 중앙(303)에 보여야 한다.
    expect(videoPointToDisplay(map, { x: 360, y: 640 }).y).toBeCloseTo(303, 0);
    expect(coverMap(720, 1280, 341, 455).offsetY).toBeCloseTo(-75.6, 1); // 예전 가정이 만들던 오차
  });

  it('shifts by the gap between the video box and the overlay box', () => {
    const map = coverMapInBox(100, 100, { left: 30, top: 50, width: 100, height: 100 }, { left: 10, top: 10, width: 200, height: 200 });
    expect(videoPointToDisplay(map, { x: 0, y: 0 })).toEqual({ x: 20, y: 40 });
  });

  it('center-crops like object-fit cover when both boxes match', () => {
    const box = { left: 0, top: 0, width: 341, height: 455 };
    const map = coverMapInBox(720, 1280, box, box);
    expect(map.offsetY).toBeCloseTo(-75.6, 1);
    expect(videoPointToDisplay(map, { x: 360, y: 640 }).y).toBeCloseTo(227.5, 1);
  });
});

describe('guideRectDisplay', () => {
  it('uses 88% width capped at 520 with card aspect', () => {
    const rect = guideRectDisplay(375, 812);
    expect(rect.w).toBeCloseTo(330);
    expect(rect.h).toBeCloseTo(330 / 1.75);
    expect(rect.x).toBeCloseTo((375 - 330) / 2);
    const wide = guideRectDisplay(1000, 800);
    expect(wide.w).toBe(520);
  });

  it('converts to a quad clockwise from top-left', () => {
    const quad = rectToQuad({ x: 1, y: 2, w: 10, h: 20 });
    expect(quad).toEqual([
      { x: 1, y: 2 },
      { x: 11, y: 2 },
      { x: 11, y: 22 },
      { x: 1, y: 22 },
    ]);
  });
});

describe('guideRectInVideo', () => {
  it('returns an expanded, clamped crop region in video coordinates', () => {
    const map = coverMap(2560, 1440, 375, 500);
    const rect = guideRectInVideo(map);
    expect(rect).not.toBeNull();
    if (!rect) return;
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.y).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.w).toBeLessThanOrEqual(2560);
    expect(rect.y + rect.h).toBeLessThanOrEqual(1440);
    expect(rect.w).toBeGreaterThan(40);
    expect(rect.h).toBeGreaterThan(40);
  });

  it('returns null when the video has no dimensions', () => {
    expect(guideRectInVideo(coverMap(0, 0, 375, 500))).toBeNull();
  });
});

describe('lerpQuad', () => {
  const target = rectToQuad({ x: 10, y: 10, w: 100, h: 60 });

  it('snaps to target when there is no previous quad', () => {
    expect(lerpQuad(null, target, 0.3)).toEqual(target);
  });

  it('moves a fraction toward the target', () => {
    const start = rectToQuad({ x: 0, y: 0, w: 100, h: 60 });
    const next = lerpQuad(start, target, 0.5);
    expect(next[0]).toEqual({ x: 5, y: 5 });
  });
});
