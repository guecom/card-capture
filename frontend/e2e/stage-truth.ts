// 오버레이 판정의 진실값: "지금 화면에 카드가 실제로 어디 보이는가"를 스테이지 픽셀에서 직접 찾는다.
//
// 왜 필요한가 (TSK-000241): 이전 게이트는 기대 위치를 앱과 똑같은 cover 공식으로 다시 계산했다.
// 그래서 앱의 좌표 매핑이 통째로 틀려도(비디오 렌더 상자 ≠ 오버레이 상자) 테스트는 늘 통과했고,
// 실폰에서 박스가 명함 위로 뜨는 증상이 여러 번 보고돼도 게이트가 잡지 못했다.
// 여기서는 렌더된 픽셀만 본다 — 앱이 어떤 공식을 쓰든 화면이 틀리면 실패한다.
import type { Page } from '@playwright/test';

export interface StageBox { x: number; y: number; width: number; height: number }

export function centerDistance(a: StageBox, b: StageBox): { dx: number; dy: number } {
  return {
    dx: Math.round(Math.abs((a.x + a.width / 2) - (b.x + b.width / 2))),
    dy: Math.round(Math.abs((a.y + a.height / 2) - (b.y + b.height / 2))),
  };
}

// 오버레이 스크림에 뚫린 구멍 = 앱이 "명함이 여기 있다"고 화면에 표시한 사각형.
// 기준선은 스크림 알파(화면에서 가장 흔한 알파)다. destination-out 컷아웃이 반투명이라
// 구멍은 0이 아니라 스크림의 절반쯤(감지 128 → 64, 대기 87 → 57)이고, 테두리 선은 242다.
// (예전 구현은 max*0.75를 기준으로 삼았는데, 테두리 선이 max를 242로 끌어올려 스크림까지 구멍으로
//  세는 바람에 "스테이지 전체"가 구멍으로 잡혔고, 그 값으로 판정이 통과했다 — TSK-000241.)
export async function overlayHole(page: Page): Promise<StageBox | null> {
  return page.evaluate(() => {
    const overlay = document.querySelector('canvas.camera-overlay') as HTMLCanvasElement | null;
    const context = overlay?.getContext('2d');
    if (!overlay || !context) return null;
    const image = context.getImageData(0, 0, overlay.width, overlay.height);
    const histogram = new Array<number>(256).fill(0);
    for (let index = 3; index < image.data.length; index += 4) histogram[image.data[index]] += 1;
    let scrim = 0;
    for (let alpha = 1; alpha < 256; alpha += 1) if (histogram[alpha] > histogram[scrim]) scrim = alpha;
    if (scrim < 16) return null; // 스크림이 없다 = 오버레이가 비어 있다
    const threshold = scrim * 0.85;

    let minX = overlay.width; let minY = overlay.height; let maxX = -1; let maxY = -1; let hits = 0;
    for (let y = 0; y < overlay.height; y += 1) {
      for (let x = 0; x < overlay.width; x += 1) {
        if (image.data[(y * overlay.width + x) * 4 + 3] >= threshold) continue;
        hits += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    return hits > 200 ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null;
  });
}

// 반환 좌표계 = 오버레이 캔버스 좌표(= 오버레이 CSS 픽셀). 감지 구멍(hole)과 바로 비교할 수 있다.
export async function cardBoxOnScreen(page: Page): Promise<StageBox | null> {
  const hide = () => document.querySelectorAll<HTMLElement>('canvas.camera-overlay, .camera-hint-pill')
    .forEach((element) => { element.dataset.truthHidden = '1'; element.style.visibility = 'hidden'; });
  const show = () => document.querySelectorAll<HTMLElement>('[data-truth-hidden]')
    .forEach((element) => { element.style.visibility = ''; delete element.dataset.truthHidden; });

  let shot: string;
  await page.evaluate(hide);
  try {
    shot = (await page.locator('.camera-preview-stage').screenshot()).toString('base64');
  } finally {
    await page.evaluate(show);
  }

  return page.evaluate(async (source: string) => {
    const stage = document.querySelector('.camera-preview-stage') as HTMLElement | null;
    const overlay = document.querySelector('canvas.camera-overlay') as HTMLCanvasElement | null;
    if (!stage || !overlay) return null;
    const bitmap = await createImageBitmap(await (await fetch(source)).blob());
    const probe = document.createElement('canvas');
    probe.width = bitmap.width;
    probe.height = bitmap.height;
    const context = probe.getContext('2d');
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, probe.width, probe.height);

    // 임계값은 Otsu로 장면마다 자동으로 잡는다 (저대비 책상도 카드 면이 분리된다).
    const histogram = new Array<number>(256).fill(0);
    const pixels = probe.width * probe.height;
    for (let index = 0; index < image.data.length; index += 4) {
      const luma = 0.299 * image.data[index] + 0.587 * image.data[index + 1] + 0.114 * image.data[index + 2];
      histogram[Math.round(luma)] += 1;
    }
    let sum = 0;
    for (let level = 0; level < 256; level += 1) sum += level * histogram[level];
    let sumBackground = 0; let weightBackground = 0; let best = 0; let threshold = 128;
    for (let level = 0; level < 256; level += 1) {
      weightBackground += histogram[level];
      if (!weightBackground) continue;
      const weightForeground = pixels - weightBackground;
      if (!weightForeground) break;
      sumBackground += level * histogram[level];
      const meanGap = sumBackground / weightBackground - (sum - sumBackground) / weightForeground;
      const variance = weightBackground * weightForeground * meanGap * meanGap;
      if (variance > best) { best = variance; threshold = level; }
    }

    // 밝은 픽셀 중 "가장 큰 덩어리"가 카드다. 전체 bbox를 쓰면 배경의 다른 밝은 물체까지 삼킨다.
    const bright = new Uint8Array(pixels);
    for (let index = 0; index < pixels; index += 1) {
      const base = index * 4;
      bright[index] = 0.299 * image.data[base] + 0.587 * image.data[base + 1] + 0.114 * image.data[base + 2] > threshold ? 1 : 0;
    }
    let minX = 0; let minY = 0; let maxX = -1; let maxY = -1; let hits = 0;
    const stack: number[] = [];
    for (let seed = 0; seed < pixels; seed += 1) {
      if (!bright[seed]) continue;
      let blobMinX = probe.width; let blobMinY = probe.height; let blobMaxX = 0; let blobMaxY = 0; let size = 0;
      bright[seed] = 0;
      stack.push(seed);
      while (stack.length) {
        const at = stack.pop()!;
        const x = at % probe.width;
        const y = (at - x) / probe.width;
        size += 1;
        if (x < blobMinX) blobMinX = x;
        if (x > blobMaxX) blobMaxX = x;
        if (y < blobMinY) blobMinY = y;
        if (y > blobMaxY) blobMaxY = y;
        if (x > 0 && bright[at - 1]) { bright[at - 1] = 0; stack.push(at - 1); }
        if (x + 1 < probe.width && bright[at + 1]) { bright[at + 1] = 0; stack.push(at + 1); }
        if (y > 0 && bright[at - probe.width]) { bright[at - probe.width] = 0; stack.push(at - probe.width); }
        if (y + 1 < probe.height && bright[at + probe.width]) { bright[at + probe.width] = 0; stack.push(at + probe.width); }
      }
      if (size > hits) { hits = size; minX = blobMinX; minY = blobMinY; maxX = blobMaxX; maxY = blobMaxY; }
    }
    // 너무 작으면 노이즈, 화면 대부분을 덮으면 카드가 배경과 붙어버린 것이다(저대비 장면).
    // 둘 다 진실값으로 쓸 수 없으므로 null을 돌려 "이 장면은 픽셀로 판정 불가"임을 드러낸다.
    if (maxX < 0 || hits < pixels * 0.01 || hits > pixels * 0.7) return null;

    const stageRect = stage.getBoundingClientRect();
    const overlayRect = overlay.getBoundingClientRect();
    const ratio = probe.width / stageRect.width; // 스크린샷 픽셀 → CSS 픽셀
    const originX = overlayRect.left - stageRect.left;
    const originY = overlayRect.top - stageRect.top;
    return {
      x: minX / ratio - originX,
      y: minY / ratio - originY,
      width: (maxX - minX) / ratio,
      height: (maxY - minY) / ratio,
    };
  }, `data:image/png;base64,${shot}`);
}
