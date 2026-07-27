// 회귀 게이트: 기록 목록에 사각지대가 없고(FI-100), 검색 결과가 "왜 매칭됐는지"를
// 사적 정보 누출 없이 보여 준다(FI-104).
// Kairen-Ref: TSK-000282
//
// 측정 함정을 피한다.
//  - 폭은 clientWidth로 잰다 (innerWidth는 emulation에서 진실이 아니다).
//  - 20초 자동 주기를 기다리지 않는다 — 눌러서 즉시 일어나는 일만 판정한다.
//
// 합성 데이터만 쓴다. 실명함·실토큰·개인정보는 이 파일에 없다.
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

/** 합성 캡처 N건. 최신순 인덱스 1..N, 이름은 `합성인물-<번호>`. */
const TOTAL_SYNTHETIC = 150;

function syntheticBrief(index: number) {
  const day = String(28 - (index % 28)).padStart(2, '0');
  return {
    captureId: `2026${'07'}${day}-${String(240000 - index).padStart(6, '0')}-synthetic${String(index).padStart(3, '0')}`,
    capturer: 'E2E Owner',
    receivedAt: `2026-07-${day}T01:00:00.000Z`,
    status: 'processed',
    person: `PER-90${String(index).padStart(4, '0')}`,
    type: 'capture',
    brief: `# 합성인물-${index} — 이런 분이에요\n합성 요약 문장 ${index}번입니다.`,
  };
}

/** 최신순으로 정렬된 합성 캡처 전체. index 1이 가장 최신이다. */
const SYNTHETIC_BRIEFS = Array.from({ length: TOTAL_SYNTHETIC }, (_unused, position) => syntheticBrief(position + 1));

/** Code.gs `listCaptures_`와 같은 규칙: limit는 1~100 clamp, offset 건너뛰기, hasMore 보고. */
function listPage(limitParam: string | null, offsetParam: string | null) {
  const limit = Math.min(Math.max(parseInt(limitParam ?? '30', 10) || 30, 1), 100);
  const offset = Math.max(parseInt(offsetParam ?? '0', 10) || 0, 0);
  const items = SYNTHETIC_BRIEFS.slice(offset, offset + limit);
  return { ok: true, name: 'E2E Owner', seeAll: true, researchInstructionEnabled: false, items, offset, hasMore: offset + items.length < SYNTHETIC_BRIEFS.length };
}

/** 합성 Person 문서. 프런트매터 내부 필드·토큰 형태 문자열·Private 섹션을 일부러 담았다. */
const SYNTHETIC_PERSON_DOC = [
  '---',
  'typeID: PER-909001',
  'reviewStatus: agent_checked',
  'internal_api_key: kx9Q2mSyntheticFakeTokenValue00000000',
  'drive_folder_id: 1SyntheticFakeFolderIdValue0000000000',
  '---',
  '',
  '# 합성인물-검색 — 이런 분이에요',
  '',
  '합성 자동화 설비 회사의 합성 담당자입니다. 2026년 합성 산업전 로보월드합성 부스에서 처음 인사했고,',
  '사내 검사 공정 자동화를 검토 중이라고 했습니다.',
  '',
  '## 대화 포인트',
  '- 합성 항목 A',
  '- 합성 항목 B',
  '',
  '## Private',
  '개인 연락처 메모: 합성비공개내용, 가족 관련 사적인 이야기.',
].join('\n');

const LEAK_MARKERS = ['kx9Q2mSyntheticFakeTokenValue00000000', '1SyntheticFakeFolderIdValue0000000000', 'internal_api_key', 'drive_folder_id', '합성비공개내용'];

async function routeSyntheticApi(page: Page): Promise<void> {
  await page.context().route('**/vendor/**', (route) => route.abort());
  await page.route('https://api.example.test/**', (route) => {
    const url = new URL(route.request().url());
    const action = url.searchParams.get('action');
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (action === 'list') return json(listPage(url.searchParams.get('limit'), url.searchParams.get('offset')));
    if (action === 'search') {
      return json({
        ok: true,
        q: url.searchParams.get('q'),
        items: [
          { id: 'synthetic-file-title-0001', title: 'PER-909002 합성인물-로보월드합성', via: 'title' },
          { id: 'synthetic-file-content-01', title: 'PER-909001 합성인물-검색', via: 'content' },
        ],
      });
    }
    if (action === 'doc') return json({ ok: true, person: '합성인물-검색', markdown: SYNTHETIC_PERSON_DOC });
    return json({ ok: true, items: [] });
  });
  await page.addInitScript(() => localStorage.setItem('cc_name', 'E2E Owner'));
}

async function openApp(page: Page, origin: string): Promise<void> {
  const api = encodeURIComponent('https://api.example.test/exec');
  await page.goto(`${origin}next/?api=${api}&k=owner-token`, { waitUntil: 'networkidle' });
}

function goToTab(page: Page, name: string) {
  return page.getByRole('navigation', { name: '주요 화면' }).getByRole('button', { name }).click();
}

// ── FI-100: 목록에 사각지대가 없다 ───────────────────────────────────────────
// 서버는 offset·hasMore로 과거 기록 전체를 줄 수 있다. 앱이 그것을 끝까지 읽어야 한다.
test('reaches captures past the first server page through 예전 기록 더 보기', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  try {
    await routeSyntheticApi(page);
    await openApp(page, origin);
    await goToTab(page, '진행');

    await expect(page.getByText('합성인물-1 —', { exact: false }).first()).toBeVisible();

    const loadMore = page.getByRole('button', { name: /예전 기록 더 보기/ });
    // 30건씩 늘어나므로 150건에 닿으려면 네 번이면 충분하다. 여유롭게 여섯 번까지 누른다.
    for (let press = 0; press < 6; press += 1) {
      if (!(await loadMore.isVisible())) break;
      await loadMore.click();
      await page.waitForTimeout(250);
    }

    // 101번째(첫 서버 페이지 밖)와 마지막 150번째가 실제로 화면에 있어야 한다.
    await expect(page.getByText('합성인물-101 —', { exact: false }).first(), '101번째 기록에 도달하지 못했다 — 첫 페이지 밖은 사각지대다').toBeVisible();
    await expect(page.getByText(`합성인물-${TOTAL_SYNTHETIC} —`, { exact: false }).first(), '가장 오래된 기록에 도달하지 못했다').toBeVisible();
    // 끝까지 읽었으면 더 보기 버튼은 남아 있으면 안 된다 — 눌러도 아무 일 없는 죽은 버튼이 된다.
    await expect(loadMore, '더 볼 것이 없는데 더 보기 버튼이 남아 있다').toBeHidden();
  } finally {
    await stopServer(server);
  }
});

test('keeps 더 보기 announced and keyboard-reachable while loading older records', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  try {
    await routeSyntheticApi(page);
    await openApp(page, origin);
    await goToTab(page, '진행');

    const loadMore = page.getByRole('button', { name: /예전 기록 더 보기/ });
    await expect(loadMore).toBeVisible();
    await loadMore.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);

    // 더 볼 것이 남아 있으면 포커스는 그 버튼에 그대로 있어야 한다 — 아니면 낭독기가 문서 처음으로 튕긴다.
    await expect(loadMore, '더 보기 후 포커스를 잃었다').toBeFocused();
    // 무엇이 일어났는지 낭독기에 알려야 한다.
    const status = page.locator('.records-feed [role="status"]');
    await expect(status, '더 보기 결과를 알리는 live region이 없다').toHaveCount(1);
    await expect(status).toContainText(/건/);
  } finally {
    await stopServer(server);
  }
});

// ── FI-104: 검색 결과에 근거를 붙인다 ───────────────────────────────────────
test('shows why a search hit matched, for both title and content matches', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  try {
    await routeSyntheticApi(page);
    await openApp(page, origin);
    await goToTab(page, '검색');

    await page.getByRole('textbox', { name: '이름·회사·만난 곳으로 검색' }).fill('로보월드합성');
    await page.getByRole('button', { name: '찾기' }).click();

    // 제목 일치: 제목 안의 어느 구간이 맞았는지 표시돼야 한다.
    const titleHit = page.locator('.person-row', { hasText: '합성인물-로보월드합성' });
    await expect(titleHit).toBeVisible();
    await expect(titleHit.locator('mark'), '제목의 어느 부분이 맞았는지 표시되지 않는다').toHaveText('로보월드합성');

    // 본문 일치: 매칭 위치 주변 근거 스니펫이 있어야 한다.
    const contentHit = page.locator('.person-row', { hasText: '합성인물-검색' });
    await expect(contentHit).toBeVisible();
    const evidence = contentHit.locator('.search-evidence');
    await expect(evidence, '본문 일치인데 왜 맞았는지 근거가 없다').toBeVisible();
    await expect(evidence).toContainText('로보월드합성');
    const snippet = (await evidence.innerText()).trim();
    expect(snippet.length, `근거 스니펫이 너무 길다 (${snippet.length}자) — 문서 전문을 붙이면 안 된다`).toBeLessThanOrEqual(200);
  } finally {
    await stopServer(server);
  }
});

test('never leaks frontmatter internals, credentials, or private sections into a snippet', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  try {
    await routeSyntheticApi(page);
    await openApp(page, origin);
    await goToTab(page, '검색');

    await page.getByRole('textbox', { name: '이름·회사·만난 곳으로 검색' }).fill('로보월드합성');
    await page.getByRole('button', { name: '찾기' }).click();
    await expect(page.locator('.person-row', { hasText: '합성인물-검색' }).locator('.search-evidence')).toBeVisible();

    const rendered = await page.locator('main#kairen-ui').innerText();
    for (const marker of LEAK_MARKERS) {
      expect(rendered.includes(marker), `검색 화면에 '${marker}' 가 노출됐다`).toBe(false);
    }
  } finally {
    await stopServer(server);
  }
});

test('keeps the search evidence inside the narrowest supported phone width', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  try {
    await page.setViewportSize({ width: 320, height: 568 });
    await routeSyntheticApi(page);
    await openApp(page, origin);
    await goToTab(page, '검색');

    await page.getByRole('textbox', { name: '이름·회사·만난 곳으로 검색' }).fill('로보월드합성');
    await page.getByRole('button', { name: '찾기' }).click();
    await expect(page.locator('.person-row', { hasText: '합성인물-검색' }).locator('.search-evidence')).toBeVisible();

    // 실제로 렌더된 픽셀로 판정한다 — innerWidth는 에뮬레이션에서 진실이 아니다.
    const report = await page.evaluate(() => {
      const viewport = document.documentElement.clientWidth;
      const offenders: string[] = [];
      document.querySelectorAll<HTMLElement>('main#kairen-ui *').forEach((node) => {
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        if (rect.right <= viewport + 1 && rect.left >= -1) return;
        offenders.push(`${node.tagName.toLowerCase()}.${String(node.className).trim().split(/\s+/).join('.')}`);
      });
      return { viewport, scrollWidth: document.documentElement.scrollWidth, offenders: offenders.slice(0, 8) };
    });
    expect(report.offenders, '검색 결과가 화면 밖으로 나간다').toEqual([]);
    expect(report.scrollWidth, '검색 화면이 가로로 스크롤된다').toBeLessThanOrEqual(report.viewport + 1);
  } finally {
    await stopServer(server);
  }
});
