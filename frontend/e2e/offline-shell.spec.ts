import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const buildRoot = resolve(fileURLToPath(new URL('../../docs/', import.meta.url)));

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('cc_name', 'E2E Owner'));
});

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
    await page.goto(`${origin}next/`, { waitUntil: 'networkidle' });
    await expect(page.locator('html')).toHaveAttribute('data-offline-ready', 'true');
    await expect(page.getByRole('heading', {
      name: '명함을 찍으면, 바로 기억으로 이어집니다.',
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
      name: '명함을 찍으면, 바로 기억으로 이어집니다.',
    })).toBeVisible();
    await expect(page.getByRole('navigation', { name: '주요 화면' })).toBeVisible();
  } finally {
    if (!stopped) await stopStaticServer(server);
  }
});

test('promotes the root entrypoint while preserving token links and legacy rollback', async ({ page }) => {
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');
  const origin = `http://127.0.0.1:${address.port}/`;

  try {
    await page.goto(`${origin}?view=search&k=root-token`, { waitUntil: 'networkidle' });
    await expect(page).toHaveURL(`${origin}next/?view=search&k=root-token`);
    await expect(page.getByRole('heading', { name: '사람 찾기' })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('cc_token'))).toBe('root-token');
    await page.getByRole('navigation', { name: '주요 화면' }).getByRole('button', { name: '설정' }).click();
    await expect(page.getByRole('link', { name: /이전 앱 열기/ })).toHaveAttribute('href', '../legacy.html');

    const legacyResponse = await page.request.get(`${origin}legacy.html`);
    expect(legacyResponse.ok()).toBe(true);
    expect(await legacyResponse.text()).toContain('<title>명함 캡처 — 이전 앱</title>');
  } finally {
    await stopStaticServer(server);
  }
});

test('makes person search explicit from the capture home and bottom navigation', async ({ page }) => {
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');

  try {
    await page.goto(`http://127.0.0.1:${address.port}/next/`, { waitUntil: 'networkidle' });

    await expect(page.getByRole('navigation', { name: '주요 화면' }).getByRole('button', { name: '검색' })).toBeVisible();
    const shortcut = page.getByRole('button', { name: /사람 검색/ });
    await expect(shortcut).toBeVisible();
    await shortcut.click();
    await expect(page.getByRole('heading', { name: '사람 찾기' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: '이름 또는 회사 검색' })).toBeVisible();
  } finally {
    await stopStaticServer(server);
  }
});

test('boots from legacy link parameters and retries a failed local capture when online', async ({ page }) => {
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');
  let postCount = 0;
  const postBodies: Array<Record<string, unknown>> = [];

  await page.route('https://api.example.test/**', async (route) => {
    if (route.request().method() === 'POST') {
      postCount += 1;
      postBodies.push(JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [] }) });
  });

  try {
    const api = encodeURIComponent('https://api.example.test/exec');
    await page.goto(`http://127.0.0.1:${address.port}/next/?api=${api}&k=owner-token`, { waitUntil: 'networkidle' });
    expect(await page.evaluate(() => ({
      api: localStorage.getItem('cc_api'),
      token: localStorage.getItem('cc_token'),
    }))).toEqual({ api: 'https://api.example.test/exec', token: 'owner-token' });

    await page.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolveDatabase, reject) => {
        const request = indexedDB.open('cardcapture', 1);
        request.onsuccess = () => resolveDatabase(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolveWrite, reject) => {
        const transaction = database.transaction('q', 'readwrite');
        transaction.objectStore('q').put({
          captureId: '20260725-235900-e2e1',
          capturedAt: '2026-07-25T14:59:00.000Z',
          event: '',
          note: '',
          images: [{ name: 'front.jpg', mime: 'image/jpeg', dataB64: '/9j/4AAQ' }],
          quickName: { name: 'Queue Fixture', source: 'fixture', confidence: 90, confirmed: true, recognizedAt: '2026-07-25T14:59:00.000Z' },
          researchInstruction: null,
          state: 'failed',
          tries: 1,
          err: 'offline',
        });
        transaction.oncomplete = () => resolveWrite();
        transaction.onerror = () => reject(transaction.error);
      });
      database.close();
      window.dispatchEvent(new Event('online'));
    });

    await expect.poll(() => postCount).toBe(1);
    await page.getByRole('navigation', { name: '주요 화면' }).getByRole('button', { name: '진행' }).click();
    await expect(page.getByText('Queue Fixture', { exact: true })).toBeVisible();
    await expect(page.getByText(/전송됨/)).toBeVisible();
    await page.getByRole('button', { name: /Queue Fixture/ }).click();
    await page.getByLabel('어디서 만났는지', { exact: true }).fill('Edited Expo');
    await page.getByLabel('메모', { exact: true }).fill('Edited memo');
    await page.getByRole('button', { name: '저장하고 다시 보내기' }).click();
    await expect.poll(() => postCount).toBe(2);
    expect(postBodies[1]).toMatchObject({ captureId: '20260725-235900-e2e1', event: 'Edited Expo', note: '메모: Edited memo' });
  } finally {
    await stopStaticServer(server);
  }
});

test('restores brief, profile, contact, search, and post-processing actions', async ({ page }) => {
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');
  const actionBodies: Array<Record<string, unknown>> = [];
  const receivedAt = new Date(Date.now() - 31 * 60_000).toISOString();

  await page.route('https://api.example.test/**', async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      actionBodies.push(JSON.parse(request.postData() ?? '{}') as Record<string, unknown>);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, receiptId: 'receipt-e2e' }) });
      return;
    }
    const action = new URL(request.url()).searchParams.get('action');
    if (action === 'list') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        ok: true,
        seeAll: true,
        researchInstructionEnabled: true,
        hasMore: true,
        items: [
          { captureId: 'CAP-PROCESSED', capturedAt: receivedAt, receivedAt, status: 'processed', person: 'PER-000001', brief: '# Alice Kim — 이런 분이에요\n협력 논의를 진행한 담당자입니다.', contact: { name: 'Alice Kim', title: 'Director', company: 'Acme', phones: ['010-1234-5678'], emails: ['alice@example.com'] } },
          { captureId: 'CAP-LATE', capturedAt: receivedAt, receivedAt, status: 'processing', quickName: { name: 'Bob Lee' } },
        ],
      }) });
      return;
    }
    if (action === 'search') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [{ id: 'PER-000001', title: 'PER-000001 Alice Kim', via: 'content' }] }) });
      return;
    }
    if (action === 'doc' || action === 'persondoc') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, markdown: '---\nname: Alice Kim\n---\n# Alice Kim\nAcme Director' }) });
      return;
    }
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'unknown_action' }) });
  });

  try {
    const api = encodeURIComponent('https://api.example.test/exec');
    await page.goto(`http://127.0.0.1:${address.port}/next/?api=${api}&k=owner-token&view=briefs`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: '처리 진행' })).toBeVisible();
    await page.getByRole('button', { name: /Alice Kim/ }).click();
    await expect(page.getByText('협력 논의를 진행한 담당자입니다.')).toBeVisible();
    await expect(page.getByRole('link', { name: '전화' })).toHaveAttribute('href', 'tel:010-1234-5678');
    await expect(page.getByRole('link', { name: '메일' })).toHaveAttribute('href', 'mailto:alice@example.com');
    await page.getByRole('button', { name: '전체 프로필' }).click();
    await expect(page.getByText('Acme Director')).toBeVisible();
    await page.getByRole('button', { name: '닫기' }).click();

    page.once('dialog', (dialog) => void dialog.accept('후속 자료 보내기'));
    await page.getByRole('button', { name: '메모 추가' }).click();
    await expect.poll(() => actionBodies.some((body) => body.action === 'addnote')).toBe(true);
    page.once('dialog', (dialog) => void dialog.accept('공개 인터뷰 확인'));
    await page.getByRole('button', { name: '조사 지시' }).click();
    await expect.poll(() => actionBodies.some((body) => body.action === 'researchinstruction')).toBe(true);
    page.once('dialog', (dialog) => void dialog.accept('직함 수정'));
    await page.getByRole('button', { name: '수정 요청' }).click();
    await expect.poll(() => actionBodies.some((body) => body.action === 'correction')).toBe(true);
    await page.getByRole('button', { name: '다시 처리' }).click();
    await expect.poll(() => actionBodies.some((body) => body.action === 'requeue')).toBe(true);

    await page.getByRole('navigation', { name: '주요 화면' }).getByRole('button', { name: '검색' }).click();
    await page.getByRole('textbox', { name: '이름 또는 회사 검색' }).fill('Alice');
    await page.locator('form.search-shell').getByRole('button', { name: '검색', exact: true }).click();
    await page.getByRole('button', { name: /PER-000001/ }).click();
    await expect(page.getByText('Acme Director')).toBeVisible();
    expect(await page.request.get(`http://127.0.0.1:${address.port}/next/manifest.webmanifest`).then((response) => response.json())).toMatchObject({ shortcuts: [{ short_name: '검색' }, { short_name: '브리핑' }] });
  } finally {
    await stopStaticServer(server);
  }
});

test('captures front and back with context into the legacy queue without uploading when unconfigured', async ({ page }) => {
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
    Object.defineProperty(window, 'TextDetector', {
      configurable: true,
      value: class {
        async detect() { return [{ rawValue: '김카이렌\n대표이사\nKairen' }]; }
      },
    });
    Object.defineProperty(window, 'cv', { configurable: true, value: { Mat: class { delete() {} } } });
    HTMLCanvasElement.prototype.getContext = (() => ({ drawImage: () => undefined })) as typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAEf/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=';
  });

  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');

  try {
    await page.goto(`http://127.0.0.1:${address.port}/next/`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '명함 촬영 시작' }).click();

    await expect(page.getByText('명함 앞면', { exact: true })).toBeVisible();
    await expect(page.getByLabel('후면 카메라 미리보기')).toBeVisible();
    await expect(page.getByRole('button', { name: '자동 촬영 켜짐' })).toBeVisible();
    await page.getByRole('button', { name: '앞면 촬영' }).click();
    await expect(page.getByAltText('앞면 촬영 미리보기')).toBeVisible();
    await expect(page.getByText('앞면 준비 완료', { exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: '이름 후보' })).toHaveValue('김카이렌');
    await expect(page.getByText('인식 완료 · 확인해 주세요', { exact: true })).toBeVisible();
    await page.getByLabel('어디서 만났는지 · 2시간 유지').fill('2026 로보월드');
    await page.getByLabel('나와 이 사람과의 관계 · 2시간 유지').fill('오늘 처음 인사');
    await page.getByLabel('Kairen과 이 사람과의 관계 · 2시간 유지').fill('잠재 고객');
    await page.getByLabel('메모').fill('자료 보내기');
    await page.getByRole('button', { name: '뒷면도 찍기' }).click();
    await expect(page.getByText('명함 뒷면', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '뒷면 촬영' }).click();
    await expect(page.getByAltText('뒷면 촬영 미리보기')).toBeVisible();
    await expect(page.getByRole('link', { name: '이전 촬영 화면 열기 · 복구용' })).toBeVisible();
    await page.getByRole('button', { name: '완료하고 대기열에 저장' }).click();
    await expect(page.getByText('사진을 로컬 대기열에 보관했습니다. 연결 설정 뒤 자동으로 전송합니다.', { exact: false })).toBeVisible();
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
      items: [{
        event: '2026 로보월드',
        relSelf: '오늘 처음 인사',
        relKairen: '잠재 고객',
        memo: '자료 보내기',
        note: '나와의 관계: 오늘 처음 인사\nKairen과의 관계: 잠재 고객\n메모: 자료 보내기',
        images: [{ name: 'front.jpg', mime: 'image/jpeg' }, { name: 'back.jpg', mime: 'image/jpeg' }],
        quickName: { name: '김카이렌', source: 'device_text_detector', confidence: 80, confirmed: false },
        state: 'queued',
        tries: 0,
      }],
      postCount: 0,
    });
    expect((queueReceipt.items as Array<{ images: Array<{ dataB64: string }> }>)[0].images[0].dataB64).toMatch(/^\/9j\//);
  } finally {
    await stopStaticServer(server);
  }
});
