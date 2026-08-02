// 촬영 흐름 회귀 게이트 (TSK-000243).
//
// founder 판정 2026-07-26: "뒷면 촬영한 결과물이 보이지 않는다."
// 원인은 자동 촬영이 '뒷면도 찍기' 직후 **1.5초 만에** 다시 발사돼, 명함을 뒤집기도 전에
// 앞면이 뒷면으로 저장된 것이었다. 이 게이트는 같은 장이 화면에 남아 있는 동안 자동 촬영이
// 발사되지 않는지, 그리고 장을 바꾸면 정상 발사되는지를 실제 앱 경로로 잰다.
//
// 두 번째 판정: 촬영 결과 썸네일이 cover로 잘려 "잘못 찍힌 것처럼" 보였다 — 잘림 금지도 함께 고정한다.
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const buildRoot = resolve(fileURLToPath(new URL('../../docs/', import.meta.url)));
const FRAME = { width: 720, height: 1280 };
const CARD = { x: 90, y: 470, width: 540, height: 324 };

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function startStaticServer(): Promise<Server> {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      let relativePath = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
      if (relativePath.endsWith('/')) relativePath += 'index.html';
      const filePath = resolve(buildRoot, relativePath);
      if (filePath !== buildRoot && !filePath.startsWith(`${buildRoot}${sep}`)) { response.writeHead(403).end('Forbidden'); return; }
      const body = await readFile(filePath);
      response.writeHead(200, { 'cache-control': 'no-store', 'content-type': contentTypes[extname(filePath)] ?? 'application/octet-stream' });
      response.end(body);
    } catch { response.writeHead(404).end('Not found'); }
  });
  server.keepAliveTimeout = 1;
  return new Promise((resolveServer, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolveServer(server)); });
}

// 장면을 앱 밖에서 바꿀 수 있게 window.__scene을 노출한다: 'front' | 'empty' | 'back'.
// __shakeOnReady는 auto gate가 ready가 된 직후에만 카메라 translation을 주입한다.
function sceneScript({ frame, card }: { frame: typeof FRAME; card: typeof CARD }) {
  localStorage.setItem('cc_name', 'Debug');
  localStorage.setItem('cc_autoCapture', 'on'); // 폰 기본값
  const runtime = window as typeof window & {
    __scene?: string;
    __shakeOnReady?: boolean;
    __shakeInjected?: boolean;
    __shakeFramesRemaining?: number;
    __shakeStep?: number;
    __shakeEndedAt?: number;
    __sawMotionHold?: boolean;
  };
  runtime.__scene = 'front';
  const videoPrototype = HTMLVideoElement.prototype as HTMLVideoElement & {
    requestVideoFrameCallback?: (callback: (now: number, metadata: VideoFrameCallbackMetadata) => void) => number;
  };
  const requestVideoFrame = videoPrototype.requestVideoFrameCallback;
  if (requestVideoFrame) {
    videoPrototype.requestVideoFrameCallback = function (callback) {
      // 이 앱에서 requestVideoFrameCallback은 auto gate가 fired된 뒤 post-trigger burst가
      // 시작할 때만 호출된다. 첫 요청 직전에 shake를 켜면 UI render timing과 무관하게
      // 분석 완료 이후·실제 저장 이전의 TOCTOU를 정확히 재현한다.
      if (runtime.__shakeOnReady && !runtime.__shakeInjected) {
        runtime.__shakeInjected = true;
        runtime.__shakeFramesRemaining = 12;
        runtime.__shakeStep = 0;
      }
      return requestVideoFrame.call(this, callback);
    };
  }
  const canvas = document.createElement('canvas');
  canvas.width = frame.width;
  canvas.height = frame.height;
  const context = canvas.getContext('2d')!;
  const draw = () => {
    const shaking = (runtime.__shakeFramesRemaining ?? 0) > 0;
    // 64px/720px는 사용자가 shutter 순간 폰을 휙 움직인 상황을 재현한다. 주입은
    // ready 이후에만 시작하므로 기존 pre-trigger quad gate가 대신 잡을 수 없다.
    const shiftX = shaking ? ((runtime.__shakeStep ?? 0) % 2 ? 64 : -64) : 0;
    context.fillStyle = '#b9a892';
    context.fillRect(0, 0, frame.width, frame.height);
    for (let index = 0; index < 900; index += 1) {
      const px = ((index * 977) % frame.width + shiftX + frame.width) % frame.width;
      const py = (index * 1597) % frame.height;
      context.fillStyle = index % 2 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
      context.fillRect(px, py, 3, 3);
    }
    if (runtime.__scene === 'empty') return; // 명함을 치운 상태(뒤집는 중)
    context.fillStyle = 'rgba(0,0,0,0.22)';
    context.fillRect(card.x + shiftX + 6, card.y + 9, card.width, card.height);
    context.fillStyle = '#f3f1ec';
    context.fillRect(card.x + shiftX, card.y, card.width, card.height);
    context.fillStyle = '#1d2a3a';
    if (runtime.__scene === 'back') {
      context.font = '600 30px "Malgun Gothic", sans-serif';
      context.fillText('KAIREN ROBOTICS', card.x + shiftX + 36, card.y + 170);
    } else {
      context.font = '700 58px "Malgun Gothic", sans-serif';
      context.fillText('김진우', card.x + shiftX + 36, card.y + 104);
      context.font = '400 27px "Malgun Gothic", sans-serif';
      context.fillText('대표이사', card.x + shiftX + 36, card.y + 148);
    }
    if (shaking) {
      runtime.__shakeStep = (runtime.__shakeStep ?? 0) + 1;
      runtime.__shakeFramesRemaining = Math.max(0, (runtime.__shakeFramesRemaining ?? 0) - 1);
      if (runtime.__shakeFramesRemaining === 0) runtime.__shakeEndedAt = performance.now();
    }
  };
  draw();
  window.setInterval(draw, 40);
  window.addEventListener('DOMContentLoaded', () => {
    const observer = new MutationObserver(() => {
      const hint = document.querySelector('.camera-hint-pill span')?.textContent ?? '';
      if (hint.includes('카메라가 움직였어요')) runtime.__sawMotionHold = true;
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }, { once: true });
  const stream = (canvas as HTMLCanvasElement & { captureStream: (fps: number) => MediaStream }).captureStream(30);
  const mediaDevices = navigator.mediaDevices ?? ({} as MediaDevices);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: Object.assign(Object.create(Object.getPrototypeOf(mediaDevices) ?? Object.prototype), mediaDevices, {
      getUserMedia: async () => stream,
      enumerateDevices: async () => [{ kind: 'videoinput', deviceId: 'debug-card', label: 'debug card', groupId: 'debug' }],
    }),
  });
}

test.use({ viewport: { width: 375, height: 812 } });

test('auto capture cancels a shake that starts after ready and retries on a stable frame', async ({ page }) => {
  test.setTimeout(180_000);
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  try {
    await page.addInitScript(sceneScript, { frame: FRAME, card: CARD });
    await page.goto(`http://127.0.0.1:${address.port}/next/`, { waitUntil: 'networkidle' });
    await page.evaluate(() => {
      (window as typeof window & { __shakeOnReady?: boolean }).__shakeOnReady = true;
    });

    await page.getByRole('button', { name: '명함 앞면 촬영' }).click();
    await expect(page.locator('.camera-preview-stage')).toHaveAttribute('data-state', 'streaming', { timeout: 20_000 });
    await page.waitForFunction(() => (window as typeof window & { __sawMotionHold?: boolean }).__sawMotionHold === true, null, { timeout: 40_000 });
    await expect(page.locator('.camera-preview-stage')).toHaveAttribute('data-state', 'streaming');
    await expect(page.getByText('앞면 저장됨 — 뒷면도 찍을까요? (선택)')).toHaveCount(0);

    // 주입한 shake가 끝나면 gate가 처음부터 다시 안정성을 모으고 한 번만 촬영한다.
    await expect(page.getByText('앞면 저장됨 — 뒷면도 찍을까요? (선택)')).toBeVisible({ timeout: 40_000 });
    const retry = await page.evaluate(() => {
      const runtime = window as typeof window & { __shakeInjected?: boolean; __shakeEndedAt?: number };
      return { injected: runtime.__shakeInjected, stableRetryMs: performance.now() - (runtime.__shakeEndedAt ?? performance.now()) };
    });
    expect(retry.injected).toBe(true);
    expect(retry.stableRetryMs, 'shake가 끝난 뒤 안정 촬영이 2초 안에 끝나야 한다').toBeLessThan(2_000);
  } finally {
    await new Promise<void>((stop) => { server.close(() => stop()); server.closeAllConnections(); });
  }
});

test('auto capture waits for the card to change before shooting the other side', async ({ page }) => {
  test.setTimeout(300_000);
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  try {
    page.on('pageerror', (error) => console.log('PAGEERROR', error.message.slice(0, 200)));
    await page.addInitScript(sceneScript, { frame: FRAME, card: CARD });
    await page.goto(`http://127.0.0.1:${address.port}/next/`, { waitUntil: 'networkidle' });

    // 앞면: 자동 촬영이 정상 동작해야 한다.
    await page.getByRole('button', { name: '명함 앞면 촬영' }).click();
    await expect(page.locator('.camera-preview-stage')).toHaveAttribute('data-state', 'streaming', { timeout: 20_000 });
    await expect(page.getByText('앞면 저장됨 — 뒷면도 찍을까요? (선택)')).toBeVisible({ timeout: 30_000 });

    // 선택 화면 썸네일은 잘리지 않아야 한다 (가로로 긴 명함이 세로에 맞춰 확대되면 안 된다).
    const thumb = await page.evaluate(() => {
      const img = document.querySelector('.camera-preview-stage img') as HTMLImageElement | null;
      if (!img) return null;
      const rect = img.getBoundingClientRect();
      return { fit: getComputedStyle(img).objectFit, natural: img.naturalWidth / img.naturalHeight, box: rect.width / rect.height };
    });
    console.log('CHOICE_THUMB', JSON.stringify(thumb));
    expect(thumb?.fit, '촬영 결과 썸네일이 잘리면 안 된다').toBe('contain');
    // 화면에서 명함을 잡아 놓고 결과물은 프레임 전체를 주면 안 된다 — 본 대로 잘려 나와야 한다.
    // (프레임은 720x1280 = 0.56, 명함은 1.3~2.2 사이)
    expect(thumb!.natural, '촬영 결과가 명함으로 크롭되지 않았다').toBeGreaterThan(1.3);
    expect(thumb!.natural).toBeLessThan(2.2);

    // 뒷면으로 전환: 같은 장이 그대로 보이는 동안에는 자동으로 찍히면 안 된다.
    await page.getByRole('button', { name: '뒷면도 찍기' }).click();
    await expect(page.locator('.camera-preview-stage')).toHaveAttribute('data-state', 'streaming', { timeout: 20_000 });
    await page.waitForTimeout(6_000); // 회귀 당시에는 1.5초 만에 발사됐다
    const stillStreaming = await page.locator('.camera-preview-stage').count();
    const hint = await page.locator('.camera-hint-pill span').textContent().catch(() => null);
    console.log('AFTER_6S', JSON.stringify({ stillStreaming, hint }));
    expect(stillStreaming, '명함을 뒤집기도 전에 자동 촬영이 발사됐다').toBe(1);

    // 명함을 치웠다가 뒷면을 대면 자동 촬영이 다시 동작해야 한다.
    await page.evaluate(() => { (window as typeof window & { __scene?: string }).__scene = 'empty'; });
    await page.waitForTimeout(1_200);
    await page.evaluate(() => { (window as typeof window & { __scene?: string }).__scene = 'back'; });

    // 뒷면도 "이대로 괜찮나요?" 확인 단계를 거쳐야 한다 (예전에는 바로 닫혔다).
    await expect(page.getByText('뒷면 저장됨 — 이대로 괜찮나요?')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: '뒷면 다시 찍기' })).toBeVisible();
    await page.locator('.camera-choice').getByRole('button', { name: '완료', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.camera-preview-stage'), null, { timeout: 30_000 });

    // 앞면·뒷면이 모두 화면에 남아 있어야 한다.
    await expect(page.locator('.shot-main img')).toBeVisible();
    await expect(page.locator('img[alt="뒷면 미리보기"]')).toBeVisible();

    // 대기열에도 두 장이 저장되고 목록에서 앞·뒷면임을 알 수 있어야 한다.
    await page.getByRole('button', { name: '완료', exact: true }).click();
    await expect(page.locator('.queue-row').first()).toContainText('앞·뒷면', { timeout: 20_000 });
    const stored = await page.evaluate(() => new Promise<string[]>((done) => {
      const open = indexedDB.open('cardcapture', 1);
      open.onsuccess = () => {
        const all = open.result.transaction('q', 'readonly').objectStore('q').getAll();
        all.onsuccess = () => done((all.result as Array<{ images?: Array<{ name?: string }> }>)
          .flatMap((row) => (row.images ?? []).map((image) => image.name ?? '')));
        all.onerror = () => done([]);
      };
      open.onerror = () => done([]);
    }));
    console.log('STORED_IMAGES', JSON.stringify(stored));
    expect(stored).toContain('front.jpg');
    expect(stored).toContain('back.jpg');
  } finally {
    await new Promise<void>((stop) => { server.close(() => stop()); server.closeAllConnections(); });
  }
});
