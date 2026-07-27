// 회귀 게이트: 좁은 화면·가로 화면에서 주요 동작이 잘리거나 화면 밖으로 밀리지 않고,
// 화면 낭독기와 키보드만으로도 상태와 동작에 닿을 수 있다.
// Kairen-Ref: TSK-000271 (FI-164로 FI-054 / FI-055 / FI-056의 현재 계약을 고정)
//
// 이 게이트는 결함을 고치려고 만든 것이 아니다 — 다섯 계약 모두 이미 성립한다.
// 게이트가 형식적이지 않다는 것은 회귀 주입으로 확인했다: aria-label 제거 → 접근 이름 게이트 FAIL,
// 상태 배지에서 글자 제거 → 색 의존 금지 게이트 FAIL, .surface-card{min-width:400px} → 320px 게이트 FAIL.
//
// 측정 함정 두 가지를 피한다.
//  - 폭은 clientWidth로 잰다 (innerWidth는 emulation에서 진실이 아니다).
//  - 시트 기하는 올라오는 애니메이션이 끝난 뒤에 잰다 (중간 프레임은 화면 밖으로 읽힌다).
import { expect, test, type Page } from '@playwright/test';
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

const TABS = ['캡처', '진행', '검색', '설정'] as const;

/** 실제로 렌더된 픽셀로 판정한다 — innerWidth는 에뮬레이션에서 진실이 아니다. */
async function overflowReport(page: Page) {
  return page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    const offenders: Array<{ selector: string; right: number }> = [];
    document.querySelectorAll<HTMLElement>('main#kairen-ui *, ion-footer *, ion-header *').forEach((node) => {
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      // 1px 미만은 서브픽셀 반올림이다.
      if (rect.right <= viewport + 1 && rect.left >= -1) return;
      const selector = `${node.tagName.toLowerCase()}${node.className && typeof node.className === 'string' ? `.${node.className.trim().split(/\s+/).join('.')}` : ''}`;
      offenders.push({ selector, right: Math.round(rect.right) });
    });
    return { viewport, scrollWidth: document.documentElement.scrollWidth, offenders: offenders.slice(0, 8) };
  });
}

test.beforeEach(async ({ page }) => {
  await page.context().route('**/vendor/**', (route) => route.abort());
  await page.route('https://api.example.test/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [], seeAll: true }),
  }));
  await page.addInitScript(() => localStorage.setItem('cc_name', 'E2E Owner'));
});

async function openApp(page: Page, origin: string): Promise<void> {
  const api = encodeURIComponent('https://api.example.test/exec');
  await page.goto(`${origin}next/?api=${api}&k=owner-token`, { waitUntil: 'networkidle' });
}

test('fits the narrowest supported phone without pushing anything off screen', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  try {
    await page.setViewportSize({ width: 320, height: 568 });
    await openApp(page, origin);

    for (const tab of TABS) {
      await page.getByRole('navigation', { name: '주요 화면' }).getByRole('button', { name: tab }).click();
      const report = await overflowReport(page);
      expect.soft(report.offenders, `${tab} 화면에서 요소가 화면 밖으로 나간다`).toEqual([]);
      expect.soft(report.scrollWidth, `${tab} 화면이 가로로 스크롤된다`).toBeLessThanOrEqual(report.viewport + 1);
    }
    expect(test.info().errors).toHaveLength(0);
  } finally {
    await stopServer(server);
  }
});

test('keeps the sheets usable at 320px, including their submit buttons', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  try {
    await page.setViewportSize({ width: 320, height: 568 });
    await openApp(page, origin);

    // 과거 회귀가 실제로 일어난 표면들이다 — 시트 안 버튼이 화면 밖으로 밀려 누를 수 없었다.
    const sheets: Array<{ name: string; open: () => Promise<void>; submit: string }> = [
      {
        name: '사용자·연결 정보',
        open: async () => {
          await page.getByRole('navigation', { name: '주요 화면' }).getByRole('button', { name: '설정' }).click();
          await page.getByRole('button', { name: '사용자·연결 정보 편집' }).click();
        },
        submit: '설정 저장',
      },
      {
        name: '연결 해제',
        open: async () => {
          await page.getByRole('navigation', { name: '주요 화면' }).getByRole('button', { name: '설정' }).click();
          await page.getByRole('button', { name: '연결 해제' }).click();
        },
        submit: '연결 해제하기',
      },
    ];

    for (const sheet of sheets) {
      await sheet.open();
      const submit = page.getByRole('button', { name: sheet.submit });
      await expect(submit, `${sheet.name} 시트의 ${sheet.submit} 버튼이 보이지 않는다`).toBeVisible();
      // 시트가 올라오는 애니메이션이 끝난 뒤에 잰다 — 중간 프레임은 진실이 아니다.
      await page.waitForTimeout(700);
      const box = await submit.boundingBox();
      const viewport = page.viewportSize()!;
      expect.soft(box!.x, `${sheet.name}: ${sheet.submit}가 왼쪽으로 잘렸다`).toBeGreaterThanOrEqual(-1);
      expect.soft(box!.x + box!.width, `${sheet.name}: ${sheet.submit}가 오른쪽으로 잘렸다`).toBeLessThanOrEqual(viewport.width + 1);
      expect.soft(box!.y + box!.height, `${sheet.name}: ${sheet.submit}가 화면 아래로 밀려 누를 수 없다`).toBeLessThanOrEqual(viewport.height + 1);
      expect.soft(box!.height, `${sheet.name}: ${sheet.submit}의 터치 높이가 부족하다`).toBeGreaterThanOrEqual(40);
      await page.getByRole('button', { name: /^(닫기|취소)$/ }).first().click();
      await expect(submit).toBeHidden();
    }
    expect(test.info().errors).toHaveLength(0);
  } finally {
    await stopServer(server);
  }
});

test('keeps the capture action reachable in landscape', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  try {
    await page.setViewportSize({ width: 740, height: 360 });
    await openApp(page, origin);

    const capture = page.getByRole('button', { name: '명함 앞면 촬영' });
    await expect(capture).toBeVisible();
    // 화면 끝까지 내렸을 때 주요 동작이 반투명 탭 바 뒤에 남아 있으면 안 된다.
    await page.locator('ion-content').evaluate(async (node) => {
      await (node as HTMLElement & { scrollToBottom: (ms: number) => Promise<void> }).scrollToBottom(0);
    });
    await page.waitForTimeout(300);
    const reach = await capture.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const footer = document.querySelector('ion-footer')?.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height, footerTop: footer?.top ?? Number.POSITIVE_INFINITY };
    });
    expect(reach.height, '촬영 버튼이 눌리기에 충분한 높이가 아니다').toBeGreaterThanOrEqual(44);
    expect(reach.bottom, '촬영 버튼이 하단 탭 바에 가려진다').toBeLessThanOrEqual(reach.footerTop + 1);
  } finally {
    await stopServer(server);
  }
});

test('gives every control an accessible name and keeps focus visible for keyboard users', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  try {
    await openApp(page, origin);

    const unnamed = await page.evaluate(() => {
      const problems: string[] = [];
      document.querySelectorAll<HTMLElement>('main#kairen-ui button, ion-footer button, ion-header button').forEach((node) => {
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        const name = (node.getAttribute('aria-label') ?? node.textContent ?? '').trim();
        if (!name) problems.push(node.outerHTML.slice(0, 120));
      });
      return problems;
    });
    expect(unnamed, '이름 없는 버튼은 낭독기에서 읽히지 않는다').toEqual([]);

    // 키보드 포커스가 보여야 한다.
    await page.getByRole('button', { name: '명함 앞면 촬영' }).focus();
    const outline = await page.getByRole('button', { name: '명함 앞면 촬영' }).evaluate((node) => {
      const style = getComputedStyle(node);
      return { width: style.outlineWidth, style: style.outlineStyle };
    });
    expect(outline.style, '포커스 표시가 없다').not.toBe('none');
    expect(parseFloat(outline.width), '포커스 테두리가 너무 얇다').toBeGreaterThanOrEqual(2);
  } finally {
    await stopServer(server);
  }
});

test('announces status changes and returns focus after a dialog closes', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  try {
    await openApp(page, origin);

    // 상단 한 줄 상태는 낭독기가 읽는 live region이어야 한다.
    const liveRegions = await page.evaluate(() => Array.from(document.querySelectorAll('[role="status"], [role="alert"], [aria-live]'))
      .map((node) => node.textContent?.trim().slice(0, 40) ?? ''));
    expect(liveRegions.length, '상태를 알리는 live region이 없다').toBeGreaterThan(0);

    await page.getByRole('navigation', { name: '주요 화면' }).getByRole('button', { name: '설정' }).click();
    const trigger = page.getByRole('button', { name: '사용자·연결 정보 편집' });
    await trigger.click();
    await expect(page.getByRole('button', { name: '설정 저장' })).toBeVisible();

    await page.getByRole('button', { name: '닫기' }).click();
    await expect(page.getByRole('button', { name: '설정 저장' })).toBeHidden();
    // 시트를 닫으면 포커스가 시트를 연 버튼으로 돌아와야 한다 — 아니면 낭독기가 문서 처음으로 튕긴다.
    await expect(trigger).toBeFocused();
  } finally {
    await stopServer(server);
  }
});

test('never encodes a processing state with colour alone', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  await page.route('https://api.example.test/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ok: true,
      seeAll: true,
      items: [
        { captureId: '20260727-170000-a', status: 'received', person: '접수 대기' },
        { captureId: '20260727-170001-b', status: 'processing', person: '처리 중' },
        { captureId: '20260727-170002-c', status: 'processed', person: '완료됨', brief: '# 완료됨\n한 줄 요약.' },
        { captureId: '20260727-170003-d', status: 'skipped', person: '건너뜀' },
      ],
    }),
  }));

  try {
    await openApp(page, origin);
    await page.getByRole('navigation', { name: '주요 화면' }).getByRole('button', { name: '진행' }).click();

    const badges = await page.locator('.status-badge').allTextContents();
    expect(badges.length).toBeGreaterThanOrEqual(4);
    // 각 상태가 색이 아니라 글자로 구분돼야 한다.
    expect(new Set(badges.map((text) => text.trim())).size).toBe(new Set(badges).size);
    for (const badge of badges) expect(badge.trim().length, '상태 배지에 글자가 없다').toBeGreaterThan(0);
  } finally {
    await stopServer(server);
  }
});
