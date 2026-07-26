// 감지 회귀 게이트 (TSK-000237): 카메라를 연 직후부터 명함 박스가 얼마나 빨리 카드에 붙는지 잰다.
// 실폰(갤럭시 폴드 7) 증상 "명함 위 사각형 인식이 완전 안 됨"의 원인은 감지 엔진을 카메라 진입
// 시점에 비로소 로드·컴파일한 것이었다. legacy(v1.0)는 페이지 로드 직후 미리 컴파일해 뒀다.
// 이 게이트는 "엔진 준비를 기다리지 않고" 측정하므로 그 회귀가 재발하면 실패한다.
//
// getUserMedia를 canvas.captureStream()으로 대체한다 — Chrome fake-capture 플래그는
// 이 환경에서 videoinput 자체를 만들지 못했고(NotReadableError), 캔버스 스트림은
// 실제 MediaStream이라 앱 코드 경로(video.play·videoWidth·프레임 그리기)가 그대로 돈다.
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const buildRoot = resolve(fileURLToPath(new URL('../../docs/', import.meta.url)));

// 카드가 카메라 프레임 안 어디에 있는지 — 이 값이 계측의 기준 진실이다.
const FRAME = { width: 720, height: 1280 };          // 폰 카메라(세로)
const CARD = { x: 90, y: 470, width: 540, height: 324 }; // 화면 중앙 부근의 명함

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function startStaticServer(): Promise<Server> {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      let relativePath = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
      if (relativePath.endsWith('/')) relativePath += 'index.html';
      const filePath = resolve(buildRoot, relativePath);
      if (filePath !== buildRoot && !filePath.startsWith(`${buildRoot}${sep}`)) {
        response.writeHead(403).end('Forbidden');
        return;
      }
      const body = await readFile(filePath);
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': contentTypes[extname(filePath)] ?? 'application/octet-stream',
      });
      response.end(body);
    } catch {
      response.writeHead(404).end('Not found');
    }
  });
  server.keepAliveTimeout = 1;
  return new Promise((resolveServer, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveServer(server));
  });
}

test.use({ viewport: { width: 375, height: 812 } }); // 폰 세로 화면

test('live camera overlay tracks the real card and quick-name reads it end to end', async ({ page }) => {
  test.setTimeout(300_000);
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');

  try {
    page.on('console', (message) => { if (message.type() === 'error') console.log('CAM_CONSOLE', message.text().slice(0, 220)); });
    page.on('pageerror', (error) => console.log('CAM_PAGEERROR', error.message.slice(0, 220)));

    await page.addInitScript(({ frame, card }) => {
      localStorage.setItem('cc_name', 'Debug');
      // 라이브 오버레이를 관측하려면 자동 촬영을 꺼야 한다(안 그러면 즉시 촬영 단계로 넘어감).
      localStorage.setItem('cc_autoCapture', 'off');
      const canvas = document.createElement('canvas');
      canvas.width = frame.width;
      canvas.height = frame.height;
      const context = canvas.getContext('2d')!;
      const draw = () => {
        // 실사에 가까운 책상: 밝은 나무색 + 미세 질감 (흰 카드와 대비가 크지 않다)
        context.fillStyle = '#b9a892';
        context.fillRect(0, 0, frame.width, frame.height);
        for (let index = 0; index < 900; index += 1) {
          const px = (index * 977) % frame.width;
          const py = (index * 1597) % frame.height;
          context.fillStyle = index % 2 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
          context.fillRect(px, py, 3, 3);
        }
        context.save();
        // 손으로 놓은 카드처럼 살짝 기울인다
        context.translate(card.x + card.width / 2, card.y + card.height / 2);
        context.rotate(-3.2 * Math.PI / 180);
        context.translate(-(card.x + card.width / 2), -(card.y + card.height / 2));
        context.fillStyle = 'rgba(0,0,0,0.22)';
        context.fillRect(card.x + 6, card.y + 9, card.width, card.height);
        context.fillStyle = '#f3f1ec';
        context.fillRect(card.x, card.y, card.width, card.height);
        context.fillStyle = '#1d2a3a';
        context.font = '700 58px "Malgun Gothic", sans-serif';
        context.fillText('김진우', card.x + 36, card.y + 104);
        context.font = '400 27px "Malgun Gothic", sans-serif';
        context.fillText('대표이사', card.x + 36, card.y + 148);
        context.font = '600 26px "Malgun Gothic", sans-serif';
        context.fillText('카이렌 로보틱스', card.x + 36, card.y + 212);
        context.font = '400 22px "Malgun Gothic", sans-serif';
        context.fillText('010-1234-5678', card.x + 36, card.y + 264);
        context.fillText('jinwoo@kairen.kr', card.x + 36, card.y + 300);
        context.restore();
      };
      draw();
      window.setInterval(draw, 100);
      const stream = (canvas as HTMLCanvasElement & { captureStream: (fps: number) => MediaStream }).captureStream(30);
      const mediaDevices = navigator.mediaDevices ?? ({} as MediaDevices);
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: Object.assign(Object.create(Object.getPrototypeOf(mediaDevices) ?? Object.prototype), mediaDevices, {
          getUserMedia: async () => stream,
          enumerateDevices: async () => [{ kind: 'videoinput', deviceId: 'debug-card', label: 'debug card', groupId: 'debug' }],
        }),
      });
    }, { frame: FRAME, card: CARD });

    await page.goto(`http://127.0.0.1:${address.port}/next/`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '명함 앞면 촬영' }).click();
    await expect(page.getByLabel('후면 카메라 미리보기')).toBeVisible();
    await expect(page.locator('.camera-preview-stage')).toHaveAttribute('data-state', 'streaming', { timeout: 20_000 });

    // 엔진 준비를 기다리지 않는다 — 카메라를 연 사용자가 실제로 겪는 시간을 잰다.
    const lockDeadline = Date.now() + 12_000;
    let lockMs = -1;
    while (Date.now() < lockDeadline) {
      const locked = await page.evaluate(() => {
        const overlay = document.querySelector('canvas.camera-overlay') as HTMLCanvasElement | null;
        if (!overlay) return false;
        const context = overlay.getContext('2d');
        if (!context) return false;
        const image = context.getImageData(0, 0, overlay.width, overlay.height);
        let maxAlpha = 0;
        for (let index = 3; index < image.data.length; index += 4 * 53) maxAlpha = Math.max(maxAlpha, image.data[index]);
        // 감지 상태의 스크림은 0.5(≈128), 미감지 대기 프레임은 0.34(≈87)다.
        return maxAlpha > 110;
      });
      if (locked) { lockMs = 12_000 - (lockDeadline - Date.now()); break; }
      await page.waitForTimeout(250);
    }
    console.log('LOCK_MS', lockMs);
    expect(lockMs, '카메라를 연 뒤 명함 박스가 붙기까지 걸린 시간').toBeGreaterThan(-1);
    expect(lockMs, '감지 엔진이 미리 기동돼 있어야 한다 (legacy v1.0 파리티)').toBeLessThan(8_000);

    // 1) 라이브 오버레이 계측: 컷아웃(구멍) 위치 vs 카드의 기대 표시 위치.
    const live = await page.evaluate(() => {
      const overlay = document.querySelector('canvas.camera-overlay') as HTMLCanvasElement | null;
      const video = document.querySelector('.camera-preview-stage video') as HTMLVideoElement | null;
      if (!overlay || !video) return null;
      const context = overlay.getContext('2d');
      if (!context) return null;
      const width = overlay.width;
      const height = overlay.height;
      const image = context.getImageData(0, 0, width, height);
      let maxAlpha = 0;
      for (let index = 3; index < image.data.length; index += 4 * 53) maxAlpha = Math.max(maxAlpha, image.data[index]);
      const holeThreshold = maxAlpha * 0.75;
      let minX = width; let minY = height; let maxX = 0; let maxY = 0; let holePixels = 0;
      for (let y = 0; y < height; y += 2) {
        for (let x = 0; x < width; x += 2) {
          if (image.data[(y * width + x) * 4 + 3] < holeThreshold) {
            holePixels += 1;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      return {
        stage: { width, height },
        video: { width: video.videoWidth, height: video.videoHeight },
        hole: holePixels > 20 ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null,
        hint: document.querySelector('.camera-hint-pill span')?.textContent ?? null,
        engine: document.querySelector('.camera-engine-note')?.textContent ?? null,
      };
    });
    console.log('LIVE_PROBE', JSON.stringify(live));
    console.log('ALPHA_PROBE', JSON.stringify(await page.evaluate(() => {
      const overlay = document.querySelector('canvas.camera-overlay') as HTMLCanvasElement | null;
      if (!overlay) return { error: 'no overlay' };
      const rect = overlay.getBoundingClientRect();
      const context = overlay.getContext('2d');
      if (!context) return { error: 'no ctx' };
      const image = context.getImageData(0, 0, overlay.width, overlay.height);
      const histogram: Record<number, number> = {};
      for (let index = 3; index < image.data.length; index += 4 * 37) {
        const bucket = Math.round(image.data[index] / 16) * 16;
        histogram[bucket] = (histogram[bucket] ?? 0) + 1;
      }
      return {
        attr: { width: overlay.width, height: overlay.height },
        client: { width: overlay.clientWidth, height: overlay.clientHeight },
        rect: { w: Math.round(rect.width), h: Math.round(rect.height) },
        display: getComputedStyle(overlay).display,
        alphaHistogram: histogram,
      };
    })));
    // 오버레이를 그대로 덤프해 눈으로 확인한다 (알파를 흰색 위에 합성).
    const overlayPng = await page.evaluate(() => {
      const overlay = document.querySelector('canvas.camera-overlay') as HTMLCanvasElement | null;
      if (!overlay) return null;
      const flat = document.createElement('canvas');
      flat.width = overlay.width;
      flat.height = overlay.height;
      const context = flat.getContext('2d')!;
      context.fillStyle = '#ff00ff';
      context.fillRect(0, 0, flat.width, flat.height);
      context.drawImage(overlay, 0, 0);
      return flat.toDataURL('image/png');
    });
    if (overlayPng) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(resolve(fileURLToPath(new URL('../test-results/', import.meta.url)), 'overlay-dump.png'), Buffer.from(overlayPng.split(',')[1], 'base64'));
    }
    await page.locator('.camera-preview-stage').screenshot({ path: resolve(fileURLToPath(new URL('../test-results/', import.meta.url)), 'stage-dump.png') });
    expect(live?.hole).not.toBeNull();

    const scale = Math.max(live!.stage.width / live!.video.width, live!.stage.height / live!.video.height);
    const offsetX = (live!.stage.width - live!.video.width * scale) / 2;
    const offsetY = (live!.stage.height - live!.video.height * scale) / 2;
    const expected = {
      x: CARD.x * scale + offsetX,
      y: CARD.y * scale + offsetY,
      width: CARD.width * scale,
      height: CARD.height * scale,
    };
    const hole = live!.hole!;
    const centerDx = Math.round(Math.abs((hole.x + hole.width / 2) - (expected.x + expected.width / 2)));
    const centerDy = Math.round(Math.abs((hole.y + hole.height / 2) - (expected.y + expected.height / 2)));
    console.log('LIVE_MATCH', JSON.stringify({
      expected: { x: Math.round(expected.x), y: Math.round(expected.y), width: Math.round(expected.width), height: Math.round(expected.height) },
      hole, centerDx, centerDy,
    }));

    // 2) 촬영 → 완료 → 크롭 산출물·빠른 이름 계측.
    await page.getByRole('button', { name: '앞면 촬영', exact: true }).click();
    await expect(page.getByText('앞면 저장됨 — 뒷면도 찍을까요? (선택)')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: '뒷면 없이 완료' }).click();
    await expect(page.locator('.shot-main img[alt="앞면 미리보기"]')).toBeVisible();
    await expect(page.locator('.quick-name-panel [role="status"]')).toContainText(/인식 완료|직접 확인/, { timeout: 120_000 });

    const capture = await page.evaluate(async () => {
      const host = document.querySelector('#quick-name-input') as HTMLElement | null;
      const inner = host?.querySelector('input') as HTMLInputElement | null;
      const name = inner?.value ?? (host as HTMLInputElement | null)?.value ?? '';
      const preview = document.querySelector('.shot-main img[alt="앞면 미리보기"]') as HTMLImageElement | null;
      if (!preview) return { name, crop: null };
      const bitmap = await createImageBitmap(await (await fetch(preview.src)).blob());
      const probe = document.createElement('canvas');
      probe.width = bitmap.width;
      probe.height = bitmap.height;
      const context = probe.getContext('2d');
      if (!context) return { name, crop: null };
      context.drawImage(bitmap, 0, 0);
      const sample = context.getImageData(0, 0, probe.width, probe.height);
      let dark = 0; let total = 0; let luminanceSum = 0;
      for (let index = 0; index < sample.data.length; index += 40) {
        const luminance = 0.299 * sample.data[index] + 0.587 * sample.data[index + 1] + 0.114 * sample.data[index + 2];
        luminanceSum += luminance;
        if (luminance < 90) dark += 1;
        total += 1;
      }
      return {
        name,
        crop: {
          width: bitmap.width,
          height: bitmap.height,
          ratio: +(bitmap.width / bitmap.height).toFixed(2),
          meanLuma: Math.round(luminanceSum / total),
          darkShare: +(dark / total).toFixed(3),
        },
      };
    });
    console.log('CAPTURE_PROBE', JSON.stringify(capture));
    const shot = await page.evaluate(() => (document.querySelector('.shot-main img[alt="앞면 미리보기"]') as HTMLImageElement | null)?.src ?? null);
    if (shot?.startsWith('data:image/jpeg;base64,')) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(resolve(fileURLToPath(new URL('../test-results/', import.meta.url)), 'capture-dump.jpg'), Buffer.from(shot.split(',')[1], 'base64'));
    }

    // 판정: 오버레이가 실제 카드에 앉고, 크롭이 카드 위주이며, 이름이 정확해야 한다.
    expect(centerDx).toBeLessThan(expected.width * 0.15);
    expect(centerDy).toBeLessThan(expected.height * 0.15);
    expect(capture.crop).not.toBeNull();
    expect(capture.crop!.ratio).toBeGreaterThan(1.3);
    expect(capture.crop!.ratio).toBeLessThan(2.1);
    expect(capture.crop!.darkShare).toBeLessThan(0.3);
    expect(capture.name).toBe('김진우');
  } finally {
    await new Promise<void>((stop) => { server.close(() => stop()); server.closeAllConnections(); });
  }
});
