// 회귀 게이트: 업로드 응답을 못 받았을 때(전시장 와이파이가 끊기는 상황) 같은 명함을
// 무작정 다시 올리지 않는다. 서버는 같은 captureId 폴더의 capture.json을 덮어쓰며
// status를 'received'로 되돌리므로, 이미 처리가 끝난 캡처가 처음부터 다시 처리된다.
// Kairen-Ref: TSK-000273 (FI-016 / FI-021)
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const buildRoot = resolve(fileURLToPath(new URL('../../docs/', import.meta.url)));

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json; charset=utf-8',
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

const CAPTURE_ID = '20260727-200000-lost';

function seedPendingCapture() {
  const row = {
    captureId: '20260727-200000-lost',
    capturedAt: '2026-07-27T11:00:00.000Z',
    event: '', note: '',
    images: [{ name: 'front.jpg', mime: 'image/jpeg', dataB64: '/9j/4AAQ' }],
    quickName: null, researchInstruction: null, state: 'queued', tries: 0,
  };
  const open = indexedDB.open('cardcapture', 1);
  open.onupgradeneeded = () => { open.result.createObjectStore('q', { keyPath: 'captureId' }); };
  open.onsuccess = () => { open.result.transaction('q', 'readwrite').objectStore('q').put(row); };
}

test.beforeEach(async ({ page }) => {
  await page.context().route('**/vendor/**', (route) => route.abort());
  await page.addInitScript(() => localStorage.setItem('cc_name', 'E2E Owner'));
  await page.addInitScript(seedPendingCapture);
});

test('does not upload the same capture again after the answer was lost', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  const posts: string[] = [];
  // 서버는 캡처를 받아 처리까지 끝냈지만, 첫 응답이 사용자에게 도달하지 못한 상황.
  let serverHasCapture = false;

  await page.route('https://api.example.test/**', async (route) => {
    if (route.request().method() === 'POST') {
      // 알림 구독 조회(`push*`)는 캡처 업로드가 아니다. 걸러 내지 않으면 captureId 없는 POST가
      // `undefined`로 목록에 섞이고, 아래 접수 플래그까지 켜서 중복 판정 자체를 무너뜨린다.
      const pushProbe = JSON.parse(route.request().postData() ?? '{}') as { action?: string };
      if (pushProbe.action?.startsWith('push')) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, enabled: false }) });
        return;
      }
      posts.push(String((JSON.parse(route.request().postData() ?? '{}') as { captureId?: string }).captureId));
      serverHasCapture = true;
      // 응답을 돌려주지 않고 연결을 끊는다 — 앱은 접수 여부를 알 수 없다.
      await route.abort('connectionfailed');
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        seeAll: true,
        // 서버는 이미 이 캡처를 갖고 있고, 처리까지 끝냈다.
        items: serverHasCapture
          ? [{ captureId: CAPTURE_ID, status: 'processed', person: '처리 완료된 사람', brief: '# 처리 완료된 사람\n요약 한 줄.' }]
          : [],
      }),
    });
  });

  try {
    const api = encodeURIComponent('https://api.example.test/exec');
    await page.goto(`${origin}next/?api=${api}&k=owner-token`, { waitUntil: 'domcontentloaded' });

    // 첫 전송이 응답 없이 끊긴다.
    await expect.poll(() => posts, { timeout: 20_000 }).toEqual([CAPTURE_ID]);

    // 이후 자동 전송 주기가 여러 번 돌아도 같은 명함을 다시 올리지 않는다.
    await page.getByRole('navigation', { name: '주요 화면' }).getByRole('button', { name: '진행' }).click();
    await page.waitForTimeout(3_000);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(2_000);

    expect(posts, '응답을 못 받았다고 같은 명함을 다시 올리면 서버의 처리 상태가 처음으로 되돌아간다').toEqual([CAPTURE_ID]);

    // 로컬 항목은 "이미 접수됨"으로 정리되고, 재전송 대상에서 빠진다.
    const stored = await page.evaluate(() => new Promise<Array<Record<string, unknown>>>((done) => {
      const open = indexedDB.open('cardcapture', 1);
      open.onsuccess = () => {
        const all = open.result.transaction('q', 'readonly').objectStore('q').getAll();
        all.onsuccess = () => done(all.result as Array<Record<string, unknown>>);
        all.onerror = () => done([]);
      };
      open.onerror = () => done([]);
    }));
    expect(stored).toHaveLength(1);
    expect(stored[0].state).toBe('sent');
    expect(typeof stored[0].reconciledAt).toBe('string');
  } finally {
    await stopServer(server);
  }
});

test('still retries when the server truly never received it', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  const posts: string[] = [];
  let acceptNext = false;

  await page.route('https://api.example.test/**', async (route) => {
    if (route.request().method() === 'POST') {
      // 알림 구독 조회(`push*`)는 캡처 업로드가 아니다. 걸러 내지 않으면 captureId 없는 POST가
      // `undefined`로 목록에 섞이고, 아래 접수 플래그까지 켜서 중복 판정 자체를 무너뜨린다.
      const pushProbe = JSON.parse(route.request().postData() ?? '{}') as { action?: string };
      if (pushProbe.action?.startsWith('push')) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, enabled: false }) });
        return;
      }
      posts.push(String((JSON.parse(route.request().postData() ?? '{}') as { captureId?: string }).captureId));
      if (!acceptNext) {
        acceptNext = true;
        await route.abort('connectionfailed');
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, captureId: CAPTURE_ID }) });
      return;
    }
    // 서버 목록은 계속 비어 있다 — 첫 전송은 정말로 도달하지 않았다.
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [], seeAll: true }) });
  });

  try {
    const api = encodeURIComponent('https://api.example.test/exec');
    await page.goto(`${origin}next/?api=${api}&k=owner-token`, { waitUntil: 'domcontentloaded' });
    await expect.poll(() => posts.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);

    // 서버가 갖고 있지 않으므로 다시 보내야 한다.
    // `online` 이벤트가 flush를 **즉시** 부른다. `visibilitychange`는 `document.hidden`이
    // false여야 진행하고 그 뒤 20초 자동 주기에 의존하게 되어 느린 CI에서 흔들렸다.
    await expect.poll(async () => {
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      return posts.length;
    }, { timeout: 30_000, intervals: [500, 1_000, 2_000, 2_000, 2_000] }).toBeGreaterThanOrEqual(2);
    expect(new Set(posts)).toEqual(new Set([CAPTURE_ID]));
  } finally {
    await stopServer(server);
  }
});
