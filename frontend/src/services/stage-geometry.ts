// 카메라 스테이지 좌표 변환: object-fit cover 매핑, 가이드 프레임, 사각형 보간.
// legacy videoMap/guideRectDisp/camLoop 보간 규칙 포팅. 순수 계산만 담당한다.
import type { Point } from './opencv';

export interface CoverMap {
  videoWidth: number;
  videoHeight: number;
  displayWidth: number;
  displayHeight: number;
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

// 비디오가 "실제로 그려진 상자"를 기준으로 cover 매핑을 만들고, 결과를 오버레이 좌표계로 옮긴다.
//
// 왜 상자를 따로 받는가 (ISS-000098): 비디오 상자와 오버레이 상자가 같다고 가정하면,
// 레이아웃이 조금만 달라져도 감지 박스가 명함에서 통째로 떨어진다. 실제로 React 이식 과정에서
// video가 grid 아이템이 되며 height:100%가 순환 참조로 auto가 됐고(341x455 오버레이 위에
// 341x606 비디오), 화면은 프레임 위쪽을 보여 주는데 앱은 가운데를 보여 준다고 계산해
// 박스가 명함보다 76px 위에 그려졌다. 렌더된 상자를 재서 쓰면 이 계열의 오차가 원천 차단된다.
export function coverMapInBox(videoWidth: number, videoHeight: number, videoBox: Box, overlayBox: Box): CoverMap {
  const scale = videoWidth > 0 && videoHeight > 0 ? Math.max(videoBox.width / videoWidth, videoBox.height / videoHeight) : 1;
  return {
    videoWidth,
    videoHeight,
    displayWidth: overlayBox.width,
    displayHeight: overlayBox.height,
    scale,
    offsetX: (videoBox.left - overlayBox.left) + (videoBox.width - videoWidth * scale) / 2,
    offsetY: (videoBox.top - overlayBox.top) + (videoBox.height - videoHeight * scale) / 2,
  };
}

export function coverMap(videoWidth: number, videoHeight: number, displayWidth: number, displayHeight: number): CoverMap {
  const box: Box = { left: 0, top: 0, width: displayWidth, height: displayHeight };
  return coverMapInBox(videoWidth, videoHeight, box, box);
}

export function videoPointToDisplay(map: CoverMap, point: Point): Point {
  return { x: point.x * map.scale + map.offsetX, y: point.y * map.scale + map.offsetY };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// legacy guideRectDisp: 화면 너비 88%(최대 520px), 명함 비율 1.75, 세로 42% 위치.
export function guideRectDisplay(displayWidth: number, displayHeight: number): Rect {
  const w = Math.min(displayWidth * 0.88, 520);
  const h = w / 1.75;
  return { x: (displayWidth - w) / 2, y: displayHeight * 0.42 - h / 2, w, h };
}

export function rectToQuad(rect: Rect): Point[] {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.w, y: rect.y },
    { x: rect.x + rect.w, y: rect.y + rect.h },
    { x: rect.x, y: rect.y + rect.h },
  ];
}

// 촬영 폴백: 가이드 프레임 표시 영역을 비디오 좌표로 되돌리고 5% 여유를 두른다 (legacy camCapture).
export function guideRectInVideo(map: CoverMap): Rect | null {
  if (!map.videoWidth || !map.videoHeight || map.scale <= 0) return null;
  const display = guideRectDisplay(map.displayWidth, map.displayHeight);
  let x = (display.x - map.offsetX) / map.scale;
  let y = (display.y - map.offsetY) / map.scale;
  let w = display.w / map.scale;
  let h = display.h / map.scale;
  x -= w * 0.05;
  y -= h * 0.05;
  w *= 1.1;
  h *= 1.1;
  x = Math.max(0, x);
  y = Math.max(0, y);
  w = Math.min(map.videoWidth - x, w);
  h = Math.min(map.videoHeight - y, h);
  if (w <= 40 || h <= 40) return null;
  return { x, y, w, h };
}

// 프레임 간 보간으로 오버레이 떨림을 없앤다 (legacy k=0.3 감지 / 0.18 가이드 복귀).
export function lerpQuad(current: Point[] | null, target: Point[], factor: number): Point[] {
  if (!current || current.length !== 4) return target.map((point) => ({ ...point }));
  return current.map((point, index) => ({
    x: point.x + (target[index].x - point.x) * factor,
    y: point.y + (target[index].y - point.y) * factor,
  }));
}
