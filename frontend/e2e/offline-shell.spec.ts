import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const buildRoot = resolve(fileURLToPath(new URL('../../docs/next/', import.meta.url)));

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function startStaticServer(): Promise<Server> {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      const relativePath = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
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

function stopStaticServer(server: Server): Promise<void> {
  return new Promise((resolveStop, reject) => {
    server.close((error) => error ? reject(error) : resolveStop());
    server.closeAllConnections();
  });
}

test('serves the cached candidate shell after the origin server stops', async ({ page }) => {
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');
  const origin = `http://127.0.0.1:${address.port}/`;
  let stopped = false;

  try {
    await page.goto(origin, { waitUntil: 'networkidle' });
    await expect(page.locator('html')).toHaveAttribute('data-offline-ready', 'true');
    await expect(page.getByRole('heading', {
      name: '명함은 지금처럼 찍고, 새 셸은 옆에서 검증합니다.',
    })).toBeVisible();

    const serviceWorkerState = await page.evaluate(async () => ({
      cacheKeys: await caches.keys(),
      controlled: navigator.serviceWorker.controller !== null,
    }));
    expect(serviceWorkerState.controlled).toBe(true);
    expect(serviceWorkerState.cacheKeys.some((key) => key.startsWith('cardcapture-next-'))).toBe(true);

    await stopStaticServer(server);
    stopped = true;
    await page.reload({ waitUntil: 'domcontentloaded' });

    await expect(page.getByRole('heading', {
      name: '명함은 지금처럼 찍고, 새 셸은 옆에서 검증합니다.',
    })).toBeVisible();
    await expect(page.getByRole('navigation', { name: '주요 화면' })).toBeVisible();
  } finally {
    if (!stopped) await stopStaticServer(server);
  }
});

test('queues a candidate camera frame locally without uploading it', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, '__candidatePostCount', { configurable: true, value: 0, writable: true });
    const originalFetch = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method?.toUpperCase() === 'POST') {
        (window as typeof window & { __candidatePostCount: number }).__candidatePostCount += 1;
      }
      return originalFetch(input, init);
    }) as typeof window.fetch;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => new MediaStream(),
      },
    });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 1600 });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 900 });
    HTMLMediaElement.prototype.play = async () => undefined;
    HTMLCanvasElement.prototype.getContext = (() => ({ drawImage: () => undefined })) as typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,fixture';
  });

  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');

  try {
    await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '후보 카메라 시험' }).click();

    await expect(page.getByText('후보 카메라 계약', { exact: true })).toBeVisible();
    await expect(page.getByLabel('후면 카메라 미리보기')).toBeVisible();
    await expect(page.getByText('미리보기 계약 연결됨', { exact: true })).toBeVisible();
    await expect(page.getByText('이 화면은 아직 이미지를 저장하거나 전송하지 않습니다.', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: '메모리 프레임 시험' }).click();
    await expect(page.getByAltText('메모리 안의 후보 카메라 프레임')).toBeVisible();
    await expect(page.getByText('메모리 프레임 계약 통과', { exact: true })).toBeVisible();
    await expect(page.getByText('아직 저장·OCR·queue·upload는 하지 않았습니다.', { exact: false })).toBeVisible();
    await expect(page.getByRole('link', { name: '검증된 카메라로 촬영' })).toBeVisible();
    await page.getByRole('button', { name: '로컬 대기열에 보관' }).click();
    await expect(page.getByText('사진을 기존 로컬 대기열에 보관했습니다.', { exact: false })).toBeVisible();
    await expect(page.locator('.signal-grid article').first().locator('strong')).toHaveText('1');
    const queueReceipt = await page.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolveDatabase, reject) => {
        const request = indexedDB.open('cardcapture', 1);
        request.onsuccess = () => resolveDatabase(request.result);
        request.onerror = () => reject(request.error);
      });
      const items = await new Promise<unknown[]>((resolveItems, reject) => {
        const request = database.transaction('q', 'readonly').objectStore('q').getAll();
        request.onsuccess = () => resolveItems(request.result);
        request.onerror = () => reject(request.error);
      });
      database.close();
      return {
        items,
        postCount: (window as typeof window & { __candidatePostCount: number }).__candidatePostCount,
      };
    });
    expect(queueReceipt).toMatchObject({
      items: [{ images: [{ name: 'front.jpg', mime: 'image/jpeg', dataB64: 'fixture' }], state: 'queued', tries: 0 }],
      postCount: 0,
    });
  } finally {
    await stopStaticServer(server);
  }
});
