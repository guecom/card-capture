import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const buildRoot = process.env.KAIREN_TEST_BUILD_ROOT
  ? resolve(process.env.KAIREN_TEST_BUILD_ROOT)
  : resolve(fileURLToPath(new URL('../../docs/', import.meta.url)));

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
      if (process.env.KAIREN_TEST_BUILD_ROOT && relativePath.startsWith('next/')) relativePath = relativePath.slice('next/'.length);
      const filePath = resolve(buildRoot, relativePath);
      if (filePath !== buildRoot && !filePath.startsWith(`${buildRoot}${sep}`)) {
        response.writeHead(403).end('Forbidden');
        return;
      }
      const body = await readFile(filePath);
      response.writeHead(200, { 'cache-control': 'no-store', 'content-type': contentTypes[extname(filePath)] ?? 'application/octet-stream' });
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

async function boot(page: Page, items: unknown[] = [], notice = ''): Promise<Server> {
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');
  await page.context().route('**/vendor/**', (route) => route.abort());
  await page.route('https://api.example.test/**', async (route) => {
    const request = route.request();
    const action = request.method() === 'GET'
      ? new URL(request.url()).searchParams.get('action')
      : (JSON.parse(request.postData() ?? '{}') as { action?: string }).action;
    if (action === 'list') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, seeAll: true, hasMore: false, items }) });
      return;
    }
    if (action === 'pushconfig') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, enabled: false }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.addInitScript(() => localStorage.setItem('cc_name', 'E2E Owner'));
  await page.setViewportSize({ width: 390, height: 844 });
  const api = encodeURIComponent('https://api.example.test/exec');
  const focus = items.length ? `&view=activity&focus=20260802-180000-attention${notice ? `&notice=${notice}` : ''}` : '';
  await page.goto(`http://127.0.0.1:${address.port}/next/?api=${api}&k=owner-token${focus}`, { waitUntil: 'networkidle' });
  return server;
}

test('notification settings explain exact scope and stay disabled until the authenticated sender is ready', async ({ page }) => {
  const server = await boot(page);
  try {
    await page.getByRole('button', { name: '설정', exact: true }).click();
    const section = page.getByRole('region', { name: '알림' });
    await expect(section.getByText('안전한 전송 준비가 아직 끝나지 않았어요')).toBeVisible();
    await expect(section.getByText('최종 결과')).toBeVisible();
    await expect(section.getByText('내용 확인')).toBeVisible();
    await expect(section.getByText('복구 필요')).toBeVisible();
    await expect(section).toContainText('이름·회사·메모를 넣지 않습니다');
    await expect(section).toContainText('빠른 이름 인식이나 일반 처리 단계는 알리지 않으며');
    await expect(section.getByRole('button', { name: '현재 이 기기에서 알림을 켤 수 없어요' })).toBeDisabled();
  } finally {
    server.close();
  }
});

test('a bounded notification focus opens the matching human-input card without exposing the raw reason', async ({ page }) => {
  const attention = {
    captureId: '20260802-180000-attention',
    receivedAt: '2026-08-02T09:00:00.000Z',
    status: 'skipped',
    attention: { kind: 'input_required', reasonCode: 'identity_ambiguous', requestedAt: '2026-08-02T09:10:00.000Z' },
  };
  const server = await boot(page, [attention]);
  try {
    const card = page.locator('#capture-20260802-180000-attention');
    await expect(card.getByText('확인 필요')).toBeVisible();
    await expect(card.getByText('누구의 명함인지 확정하지 못했어요')).toBeVisible();
    await expect(card.getByRole('button', { name: '내용 보완' })).toBeVisible();
    await expect(card).not.toContainText('identity_ambiguous');
    await expect(card.locator('.brief-summary')).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('brief-summary'))).toBe(true);
    expect(new URL(page.url()).searchParams.has('focus')).toBe(false);
  } finally {
    server.close();
  }
});

test('a recovery notification opens an actionable retry surface without exposing watcher internals', async ({ page }) => {
  const received = {
    captureId: '20260802-180000-attention',
    receivedAt: '2026-08-02T09:00:00.000Z',
    status: 'received',
  };
  const server = await boot(page, [received], 'recovery_required');
  try {
    const notice = page.getByRole('alert', { name: '처리 복구 필요' });
    await expect(notice.getByText('자동 처리가 여러 번 완료되지 않았어요')).toBeVisible();
    await expect(notice).toContainText('원본과 기존 기록은 그대로입니다');
    await expect(notice).not.toContainText('quarantine');
    const request = page.waitForRequest((candidate) => {
      try { return (JSON.parse(candidate.postData() ?? '{}') as { action?: string }).action === 'requeue'; } catch { return false; }
    });
    await notice.getByRole('button', { name: '이 항목 다시 처리' }).click();
    expect(JSON.parse((await request).postData() ?? '{}')).toMatchObject({ action: 'requeue', captureId: received.captureId });
    await expect(page.getByText(/다시 처리를 요청했어요|이미 다시 처리 중이에요/)).toBeVisible();
    await expect(notice).toHaveCount(0);
    expect(new URL(page.url()).searchParams.has('focus')).toBe(false);
    expect(new URL(page.url()).searchParams.has('notice')).toBe(false);
  } finally {
    server.close();
  }
});

test('generated service worker owns fixed private copy, allowed kinds, and same-origin activity routes', async () => {
  const source = await readFile(resolve(buildRoot, process.env.KAIREN_TEST_BUILD_ROOT ? 'sw.js' : 'next/sw.js'), 'utf8');
  for (const kind of ['final_result', 'human_input_required', 'recovery_required']) expect(source).toContain(kind);
  for (const copy of ['처리가 끝났어요', '내용 확인이 필요해요', '처리를 이어가야 해요']) expect(source).toContain(copy);
  expect(source).toContain("const PUSH_TARGET = /^[A-Za-z0-9_-]{4,80}$/");
  expect(source).toContain("const PUSH_EVENT_ID = /^pne-[a-f0-9]{64}$/");
  expect(source).toContain("payload.v !== 1");
  expect(source).toContain("tag: 'cc-' + payload.eventId");
  expect(source).toContain("'./?view=activity&focus=' + encodeURIComponent(target)");
  expect(source).toContain("payload.kind === 'recovery_required' ? '&notice=recovery_required' : ''");
  expect(source).toContain("candidate.origin === self.location.origin");
  expect(source).not.toMatch(/payload\.(?:title|body|url|route)/);
  expect(source).not.toContain('quick_name');
});
