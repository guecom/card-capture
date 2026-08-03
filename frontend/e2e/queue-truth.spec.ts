// 회귀 게이트: "폰을 넣어도 된다"는 말이 실제로 기기에 저장된 뒤에만 나오고,
// 저장에 실패했을 때는 안전하다고 말하지 않으며, 손상 항목이 큐를 막지도 지워지지도 않고,
// 두 탭이 같은 명함을 두 번 보내지 않는다.
// Kairen-Ref: TSK-000270 (FI-025 / FI-031 / FI-032 / FI-052 / FI-053)
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const buildRoot = resolve(fileURLToPath(new URL('../../docs/', import.meta.url)));
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

function stopServer(server: Server): Promise<void> {
  return new Promise((stop) => { server.close(() => stop()); server.closeAllConnections(); });
}

async function serverOrigin(): Promise<{ server: Server; origin: string }> {
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');
  return { server, origin: `http://127.0.0.1:${address.port}/` };
}

// 1x1 JPEG. 앱의 기본 카메라 경로(파일 입력)로 앞면 한 장을 넣는다 — 실제 `completeCapture`
// 경로를 그대로 타면서 감지·인식 엔진(50MB)은 건드리지 않는다. 여기서 재는 것은 저장 진실이다.
const JPEG_1X1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

/** 명함 앞면 한 장을 앱의 실제 촬영 완료 경로로 밀어 넣는다. */
async function captureFrontSide(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: '명함 앞면 촬영' }).click();
  await page.locator('input.native-camera-input').setInputFiles({ name: 'front.jpg', mimeType: 'image/jpeg', buffer: JPEG_1X1 });
  await expect(page.locator('.shot-main img')).toBeVisible({ timeout: 30_000 });
}

function storedQueue(page: import('@playwright/test').Page) {
  return page.evaluate(() => new Promise<Array<{ captureId?: string; state?: string }>>((done) => {
    const open = indexedDB.open('cardcapture', 1);
    open.onsuccess = () => {
      const all = open.result.transaction('q', 'readonly').objectStore('q').getAll();
      all.onsuccess = () => done(all.result as Array<{ captureId?: string; state?: string }>);
      all.onerror = () => done([]);
    };
    open.onerror = () => done([]);
  }));
}

test.use({ viewport: { width: 375, height: 812 } });

test.beforeEach(async ({ page }) => {
  // 감지·인식 엔진은 이 게이트의 대상이 아니다 — 저장 진실만 잰다.
  await page.context().route('**/vendor/**', (route) => route.abort());
  await page.addInitScript(() => {
    localStorage.setItem('cc_name', 'E2E Owner');
    // 기본 카메라 경로(파일 입력)를 쓸 수 있게 둔다.
    localStorage.setItem('cc_galleryFree', 'off');
  });
});

test('only says the phone can be put away after the capture is read back from storage', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  try {
    await page.goto(`${origin}next/`, { waitUntil: 'networkidle' });

    await captureFrontSide(page);
    await page.getByRole('button', { name: '완료', exact: true }).click();

    // 서버 접수가 아니라 **이 기기 저장**이 끝났다는 사실만 말한다.
    await expect(page.getByText('이 폰에 저장했어요', { exact: false })).toBeVisible({ timeout: 20_000 });
    const stored = await storedQueue(page);
    expect(stored).toHaveLength(1);
    expect(stored[0].state).toBe('queued');
  } finally {
    await stopServer(server);
  }
});

test('never claims a capture is safe when the device storage is full', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  try {
    // 촬영을 대기열에 넣는 순간에만 저장 공간 부족을 재현한다.
    await page.addInitScript(() => {
      const originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function patched(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
        const record = value as { images?: Array<{ dataB64?: string }> } | null;
        if (this.name === 'q' && record?.images?.some((image) => image?.dataB64)) {
          throw Object.assign(new Error('simulated full device'), { name: 'QuotaExceededError' });
        }
        return originalPut.call(this, value as never, key as never);
      } as typeof IDBObjectStore.prototype.put;
    });
    await page.goto(`${origin}next/`, { waitUntil: 'networkidle' });

    await captureFrontSide(page);
    await page.getByRole('button', { name: '완료', exact: true }).click();

    await expect(page.getByText('휴대폰 저장 공간이 부족해', { exact: false })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('이 폰에 저장했어요', { exact: false })).toHaveCount(0);
    // 사진은 화면에 그대로 남아 있어야 한다 — 화면을 비우면 사진이 사라진다.
    await expect(page.locator('.shot-main img')).toBeVisible();
    expect(await storedQueue(page)).toHaveLength(0);
  } finally {
    await stopServer(server);
  }
});

test('quarantines a damaged entry without deleting it or blocking the rest', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  const posted: string[] = [];
  await page.route('https://api.example.test/**', async (route) => {
    if (route.request().method() === 'POST') {
      // 알림 구독 조회(`push*`)는 캡처 업로드가 아니다 — 섞이면 `undefined`가 중복 판정을 오염시킨다.
      const pushProbe = JSON.parse(route.request().postData() ?? '{}') as { action?: string };
      if (pushProbe.action?.startsWith('push')) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, enabled: false }) });
        return;
      }
      posted.push(String((JSON.parse(route.request().postData() ?? '{}') as { captureId?: string }).captureId));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [], seeAll: true }) });
  });
  // 정상 한 건 + 사진 내용이 사라진 손상 한 건을 미리 넣는다.
  await page.addInitScript(() => {
    const seed = [
      { captureId: '20260727-150000-ok', capturedAt: '2026-07-27T06:00:00.000Z', event: '', note: '', images: [{ name: 'front.jpg', mime: 'image/jpeg', dataB64: '/9j/4AAQ' }], quickName: null, researchInstruction: null, state: 'queued', tries: 0 },
      { captureId: '20260727-150001-bad', capturedAt: '2026-07-27T06:00:01.000Z', event: '', note: '', images: [{ name: 'front.jpg', mime: 'image/jpeg' }], quickName: null, researchInstruction: null, state: 'queued', tries: 0 },
    ];
    const open = indexedDB.open('cardcapture', 1);
    open.onupgradeneeded = () => { open.result.createObjectStore('q', { keyPath: 'captureId' }); };
    open.onsuccess = () => {
      const store = open.result.transaction('q', 'readwrite').objectStore('q');
      seed.forEach((row) => store.put(row));
    };
  });

  try {
    const api = encodeURIComponent('https://api.example.test/exec');
    await page.goto(`${origin}next/?api=${api}&k=owner-token&view=briefs`, { waitUntil: 'networkidle' });

    await expect(page.getByText('보낼 수 없는 촬영 1건')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('20260727-150001-bad')).toBeVisible();

    // 정상 항목은 정상적으로 전송되고, 손상 항목은 전송되지도 지워지지도 않는다.
    await expect.poll(() => posted, { timeout: 20_000 }).toEqual(['20260727-150000-ok']);
    const stored = await storedQueue(page);
    expect(stored.map((row) => row.captureId).sort()).toEqual(['20260727-150000-ok', '20260727-150001-bad']);
  } finally {
    await stopServer(server);
  }
});

test('sends each pending capture once even when two tabs are open', async ({ context }) => {
  const { server, origin } = await serverOrigin();
  const posted: string[] = [];
  await context.route('https://api.example.test/**', async (route) => {
    if (route.request().method() === 'POST') {
      // 알림 구독 조회(`push*`)는 캡처 업로드가 아니다 — 섞이면 `undefined`가 중복 판정을 오염시킨다.
      const pushProbe = JSON.parse(route.request().postData() ?? '{}') as { action?: string };
      if (pushProbe.action?.startsWith('push')) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, enabled: false }) });
        return;
      }
      posted.push(String((JSON.parse(route.request().postData() ?? '{}') as { captureId?: string }).captureId));
      // 두 탭이 겹칠 시간을 만든다 — 잠금이 없으면 여기서 두 번째 전송이 끼어든다.
      await new Promise((wait) => setTimeout(wait, 900));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [], seeAll: true }) });
  });
  await context.addInitScript(() => localStorage.setItem('cc_name', 'E2E Owner'));
  await context.addInitScript(() => {
    const seed = ['20260727-160000-a', '20260727-160001-b'].map((captureId, index) => ({
      captureId, capturedAt: `2026-07-27T07:00:0${index}.000Z`, event: '', note: '',
      images: [{ name: 'front.jpg', mime: 'image/jpeg', dataB64: '/9j/4AAQ' }],
      quickName: null, researchInstruction: null, state: 'queued', tries: 0,
    }));
    const open = indexedDB.open('cardcapture', 1);
    open.onupgradeneeded = () => { open.result.createObjectStore('q', { keyPath: 'captureId' }); };
    open.onsuccess = () => {
      const store = open.result.transaction('q', 'readwrite').objectStore('q');
      seed.forEach((row) => store.put(row));
    };
  });

  try {
    const api = encodeURIComponent('https://api.example.test/exec');
    const url = `${origin}next/?api=${api}&k=owner-token`;
    const first = await context.newPage();
    const second = await context.newPage();
    await Promise.all([
      first.goto(url, { waitUntil: 'domcontentloaded' }),
      second.goto(url, { waitUntil: 'domcontentloaded' }),
    ]);

    await expect.poll(() => [...posted].sort(), { timeout: 30_000 })
      .toEqual(['20260727-160000-a', '20260727-160001-b']);
    // 잠금이 없으면 같은 captureId가 두 번 이상 접수된다.
    await first.waitForTimeout(2_000);
    expect(posted.sort()).toEqual(['20260727-160000-a', '20260727-160001-b']);
  } finally {
    await stopServer(server);
  }
});
