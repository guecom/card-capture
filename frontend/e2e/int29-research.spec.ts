// INT-000029 회귀 게이트 — `AI 조사 요청` 작성 자리.
//   A. 조사 항목이 **고르는 블록**이고 `모두 선택`이 3단으로 도는가 (TSK-000536 / ISS-000082)
//   B. 작성 자리에서 처리 진행 막대가 사라지고, 진행은 기록 블록 하나가 소유하는가 (TSK-000535 / ISS-000050)
//
// founder 판정 2026-08-04:
//   "AI 조사 요청에 모두 선택 버튼이 있으면 좋겠어. … 블록으로 돼 있는 것들을 모두 클릭하는 형태야."
//   "캡처 탭의 AI 조사 요청에 나와 있는 진행 막대기가 필요 없는 것 같아. 완료하게 되면 명함 기록
//    혹은 진행에 블록이 생성돼서 그곳에서 진행 막대기가 올라가는데 …"
//
// 이 게이트가 형식적이지 않다는 것은 변경 전 번들에서 확인했다: 항목 블록·개수·미리보기·접수 확인이
// 모두 없어 A/B 전부 FAIL한다 (예전 화면에는 글자를 덧붙이는 예시 chip과 `.ai-stage-rail`이 있었다).
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const buildRoot = resolve(fileURLToPath(new URL('../../docs/', import.meta.url)));
const DAY_MINUTES = 24 * 60;
/** 서버가 조사 요청을 받으면 자기 captureId로 기록을 만든다 — 그 기록이 진행을 소유한다. */
const RESEARCH_RECEIPT_ID = 'research-e2e-0001';
const SCOPE_COUNT = 9;

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

function stopServer(server: Server): Promise<void> {
  return new Promise((stop) => { server.close(() => stop()); server.closeAllConnections(); });
}

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function person(index: number, name: string, organization: string) {
  return {
    captureId: `2026080${index}-090000-p${index}`,
    receivedAt: ago(index * DAY_MINUTES),
    status: 'processed',
    person: `PER-00000${index}`,
    capturer: '이강규',
    event: '고객사 방문 미팅',
    contact: { name, title: '구매팀장', organization },
    brief: `# ${name} — 이런 분이에요\n${organization} 구매팀장입니다.`,
  };
}

/** 접수된 조사 요청이 목록에 만들어 내는 기록. 아직 처리 중이므로 **여기에** 진행 막대가 있다. */
function researchReceiptItem() {
  return {
    captureId: RESEARCH_RECEIPT_ID,
    receivedAt: ago(1),
    status: 'received',
    type: 'research_instruction',
    person: 'PER-000001',
    capturer: '이강규',
  };
}

interface Harness {
  server: Server;
  /** 서버로 실제로 나간 조사 요청의 본문 */
  submitted: Array<Record<string, unknown>>;
  /** 다음 조사 요청 POST에 서버가 이렇게 답한다 */
  setActionResponse: (body: Record<string, unknown>) => void;
}

async function boot(page: Page, options: { theme?: string; width?: number; height?: number } = {}): Promise<Harness> {
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');

  const submitted: Array<Record<string, unknown>> = [];
  let actionResponse: Record<string, unknown> = { ok: true, receiptId: RESEARCH_RECEIPT_ID, person: 'PER-000001', status: 'received' };
  let receiptCreated = false;

  await page.context().route('**/vendor/**', (route) => route.abort());
  await page.route('https://api.example.test/**', async (route) => {
    const request = route.request();
    const action = new URL(request.url()).searchParams.get('action');
    if (action === 'list') {
      const items = [person(1, '김민서', '한화시스템'), person(2, '이서연', '넥스트로보')];
      // 접수가 성공한 뒤에만 조사 기록이 목록에 나타난다 — 실제 순서를 그대로 재현한다.
      if (receiptCreated) items.unshift(researchReceiptItem() as never);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, seeAll: true, researchInstructionEnabled: true, hasMore: false, items }) });
      return;
    }
    if (request.method() === 'POST') {
      const body = JSON.parse(request.postData() ?? '{}') as Record<string, unknown>;
      if (body.action === 'researchinstruction') {
        submitted.push(body);
        if (actionResponse.ok) receiptCreated = true;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(actionResponse) });
        return;
      }
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [] }) });
  });

  const theme = options.theme;
  await page.addInitScript((value) => {
    localStorage.setItem('cc_name', '이강규');
    if (value) localStorage.setItem('cc_theme', value);
  }, theme);
  await page.setViewportSize({ width: options.width ?? 390, height: options.height ?? 844 });
  const api = encodeURIComponent('https://api.example.test/exec');
  await page.goto(`http://127.0.0.1:${address.port}/next/?api=${api}&k=owner-token`, { waitUntil: 'networkidle' });
  return { server, submitted, setActionResponse: (body) => { actionResponse = body; } };
}

function composer(page: Page) {
  return page.locator('.ai-surface.research-request');
}

function scopes(page: Page) {
  return composer(page).getByRole('group', { name: 'AI 조사 항목' });
}

async function openPersonSheet(page: Page): Promise<void> {
  await page.getByRole('button', { name: '진행', exact: true }).click();
  await page.locator('.brief-summary').filter({ hasText: '김민서' }).click();
  await page.locator('.brief-detail').getByRole('button', { name: 'AI 조사 요청' }).click();
  await expect(page.locator('ion-modal.person-action-modal .ai-surface.research-request')).toBeVisible();
}

// ── A. 조사 항목은 고르는 블록이다 (TSK-000536) ──

test('조사 항목은 글자를 덧붙이는 예시가 아니라 켜고 끄는 블록이다', async ({ page }) => {
  const harness = await boot(page);
  try {
    const group = scopes(page);
    await expect(group).toBeVisible();
    // founder가 이름을 댄 항목이 실제로 블록으로 있다.
    for (const label of ['실력·역량 근거', '전문 분야', '의사결정 권한·직급', '최근 활동·발표', '소속 조직·사업 맥락', '함께 아는 사람·접점', '대화 시작점']) {
      await expect(group.getByRole('button', { name: label })).toBeVisible();
    }
    await expect(group.getByRole('button')).toHaveCount(SCOPE_COUNT);

    const capability = group.getByRole('button', { name: '실력·역량 근거' });
    await expect(capability).toHaveAttribute('aria-pressed', 'false');

    // 먼저 적어 둔 글이 있어도 항목을 누르면 **글은 그대로**다 (예전 chip은 뒤에 쉼표로 붙었다).
    const textarea = composer(page).locator('ion-textarea[aria-label="AI 조사 요청"] textarea');
    await textarea.fill('특히 국내 레퍼런스 위주로');
    await capability.click();
    await expect(capability).toHaveAttribute('aria-pressed', 'true');
    await expect(textarea).toHaveValue('특히 국내 레퍼런스 위주로');

    // 다시 누르면 꺼진다.
    await capability.click();
    await expect(capability).toHaveAttribute('aria-pressed', 'false');
    await expect(textarea).toHaveValue('특히 국내 레퍼런스 위주로');
  } finally {
    await stopServer(harness.server);
  }
});

test('모두 선택은 3단으로 돌고, 글자와 개수가 지금 상태를 말한다', async ({ page }) => {
  const harness = await boot(page);
  try {
    const group = scopes(page);
    const count = composer(page).locator('.research-scope-count');
    const all = composer(page).getByRole('button', { name: '모두 선택' });
    await expect(count).toHaveText(`${SCOPE_COUNT}개 중 0개 선택`);
    await expect(all).toHaveAttribute('aria-pressed', 'false');
    // 아무것도 안 골랐으면 지울 것도 없다.
    await expect(composer(page).getByRole('button', { name: '선택 지우기' })).toHaveCount(0);

    // 없음 → 전부. 한 번에 전부 켜진다 (founder: "보통 다 누르게 되더라고").
    await all.click();
    await expect(group.locator('button[aria-pressed="true"]')).toHaveCount(SCOPE_COUNT);
    await expect(count).toHaveText(`${SCOPE_COUNT}개 중 ${SCOPE_COUNT}개 선택`);
    // 전부 골라 놓고 `모두 선택`이라 적혀 있으면 거짓말이다.
    const release = composer(page).getByRole('button', { name: '모두 해제' });
    await expect(release).toBeVisible();
    await expect(release).toHaveAttribute('aria-pressed', 'true');

    // 전부 → 없음.
    await release.click();
    await expect(count).toHaveText(`${SCOPE_COUNT}개 중 0개 선택`);
    expect(await group.locator('button[aria-pressed="true"]').count()).toBe(0);
  } finally {
    await stopServer(harness.server);
  }
});

test('일부만 고른 상태는 mixed이고, 누르면 비우지 않고 전부가 된다', async ({ page }) => {
  const harness = await boot(page);
  try {
    const group = scopes(page);
    await group.getByRole('button', { name: '대화 시작점' }).click();
    await group.getByRole('button', { name: '전문 분야' }).click();

    const all = composer(page).getByRole('button', { name: '모두 선택' });
    await expect(all).toHaveAttribute('aria-pressed', 'mixed');
    await expect(composer(page).locator('.research-scope-count')).toHaveText(`${SCOPE_COUNT}개 중 2개 선택`);

    // 일부 상태에서 비우는 길은 따로 있다.
    const clear = composer(page).getByRole('button', { name: '선택 지우기' });
    await expect(clear).toBeVisible();

    await all.click();
    expect(await group.locator('button[aria-pressed="true"]').count()).toBe(SCOPE_COUNT);

    // 전부 상태에서는 `모두 해제`가 그 일을 하므로 `선택 지우기`는 사라진다.
    await expect(composer(page).getByRole('button', { name: '선택 지우기' })).toHaveCount(0);
  } finally {
    await stopServer(harness.server);
  }
});

test('선택 지우기는 항목만 비우고 적어 둔 글은 지키지 않고 남긴다', async ({ page }) => {
  const harness = await boot(page);
  try {
    const textarea = composer(page).locator('ion-textarea[aria-label="AI 조사 요청"] textarea');
    await textarea.fill('공개 인터뷰 위주로');
    await scopes(page).getByRole('button', { name: '평판·레퍼런스' }).click();
    await composer(page).getByRole('button', { name: '선택 지우기' }).click();

    await expect(composer(page).locator('.research-scope-count')).toHaveText(`${SCOPE_COUNT}개 중 0개 선택`);
    await expect(textarea).toHaveValue('공개 인터뷰 위주로');
  } finally {
    await stopServer(harness.server);
  }
});

test('키보드만으로 항목을 켜고 끌 수 있다', async ({ page }) => {
  const harness = await boot(page);
  try {
    const opener = scopes(page).getByRole('button', { name: '대화 시작점' });
    await opener.focus();
    await expect(opener).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(opener).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Space');
    await expect(opener).toHaveAttribute('aria-pressed', 'false');
  } finally {
    await stopServer(harness.server);
  }
});

test('고른 항목과 적은 글이 보내기 전에 그대로 보이고, 그 문장이 서버로 간다', async ({ page }) => {
  const harness = await boot(page);
  try {
    // 아무것도 없으면 빈 자리가 아니라 빈 상태 안내가 있다.
    await expect(composer(page).locator('.research-preview-empty')).toBeVisible();

    await openPersonSheet(page);
    const sheet = page.locator('ion-modal.person-action-modal');
    await sheet.getByRole('button', { name: '모두 선택' }).click();
    await sheet.locator('ion-textarea[aria-label="AI 조사 요청"] textarea').fill('특히 국내 레퍼런스 위주로');

    const preview = sheet.locator('.research-preview-body');
    await expect(preview).toContainText('조사 항목: 실력·역량 근거');
    await expect(preview).toContainText('대화 시작점');
    await expect(preview).toContainText('특히 국내 레퍼런스 위주로');
    const shown = (await preview.innerText()).trim();

    await sheet.getByRole('button', { name: '조사 요청 접수' }).click();
    await expect.poll(() => harness.submitted.length).toBe(1);
    // 화면에 보여 준 문장과 실제로 보낸 문장이 같아야 한다 — 미리보기가 장식이면 안 된다.
    expect(String(harness.submitted[0].text).trim()).toBe(shown);
    expect(String(harness.submitted[0].text)).toContain('의사결정 권한·직급');
  } finally {
    await stopServer(harness.server);
  }
});

test('항목만 고르고 아무것도 적지 않아도 보낼 수 있다', async ({ page }) => {
  const harness = await boot(page);
  try {
    await openPersonSheet(page);
    const sheet = page.locator('ion-modal.person-action-modal');
    const submit = sheet.getByRole('button', { name: '조사 요청 접수' });
    await expect(submit).toBeDisabled();

    await sheet.getByRole('button', { name: '모두 선택' }).click();
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect.poll(() => harness.submitted.length).toBe(1);
    expect(String(harness.submitted[0].text)).toContain('조사 항목: 실력·역량 근거');
  } finally {
    await stopServer(harness.server);
  }
});

test('고른 항목은 2시간 유지 창 안에서 다음 촬영에도 그대로 남는다', async ({ page }) => {
  const harness = await boot(page);
  try {
    await composer(page).getByRole('button', { name: '모두 선택' }).click();
    await expect(composer(page).locator('.research-scope-count')).toHaveText(`${SCOPE_COUNT}개 중 ${SCOPE_COUNT}개 선택`);

    await page.reload({ waitUntil: 'networkidle' });
    // 습관처럼 고르는 묶음이 다시 열었을 때 그대로 있어야 한다 (founder: "보통 다 누르게 되더라고").
    await expect(composer(page).locator('.research-scope-count')).toHaveText(`${SCOPE_COUNT}개 중 ${SCOPE_COUNT}개 선택`);
    await expect(composer(page).getByRole('button', { name: '모두 해제' })).toBeVisible();
  } finally {
    await stopServer(harness.server);
  }
});

test('가장 좁은 폰에서도 조사 항목이 화면 밖으로 나가지 않는다', async ({ page }) => {
  const harness = await boot(page, { width: 320, height: 568 });
  try {
    await composer(page).getByRole('button', { name: '모두 선택' }).click();
    const report = await page.evaluate(() => {
      // 폭은 clientWidth로 잰다 — innerWidth는 emulation에서 진실이 아니다.
      const viewport = document.documentElement.clientWidth;
      const offenders: string[] = [];
      document.querySelectorAll<HTMLElement>('.ai-surface.research-request *').forEach((node) => {
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        if (rect.right <= viewport + 1 && rect.left >= -1) return;
        offenders.push(`${node.tagName.toLowerCase()}.${String(node.className || '').split(' ')[0]} → ${Math.round(rect.right)}`);
      });
      return { viewport, offenders, scrollWidth: document.documentElement.scrollWidth };
    });
    expect(report.viewport).toBe(320);
    expect(report.offenders, '조사 항목이 320px 화면 밖으로 나간다').toEqual([]);
    expect(report.scrollWidth, '가로 스크롤이 생긴다').toBeLessThanOrEqual(report.viewport + 1);
  } finally {
    await stopServer(harness.server);
  }
});

// ── B. 진행은 기록 블록 하나가 소유한다 (TSK-000535) ──

test('작성 자리에는 처리 진행 막대가 없다 — 두 화면 모두', async ({ page }) => {
  const harness = await boot(page);
  try {
    await expect(composer(page)).toBeVisible();
    await expect(composer(page).locator('.ai-stage-rail'), '촬영 탭 작성 자리에 아직 진행 막대가 있다').toHaveCount(0);
    await expect(composer(page).locator('.ai-stage-bars')).toHaveCount(0);

    await openPersonSheet(page);
    const sheet = page.locator('ion-modal.person-action-modal');
    await expect(sheet.locator('.ai-stage-rail'), '인물 시트 작성 자리에 아직 진행 막대가 있다').toHaveCount(0);
  } finally {
    await stopServer(harness.server);
  }
});

test('접수되면 시트가 닫히고, 진행을 소유한 기록 블록으로 데려간다', async ({ page }) => {
  const harness = await boot(page);
  try {
    await openPersonSheet(page);
    const sheet = page.locator('ion-modal.person-action-modal');
    await sheet.getByRole('button', { name: '모두 선택' }).click();
    await sheet.getByRole('button', { name: '조사 요청 접수' }).click();

    // 시트는 스스로 닫힌다.
    await expect(sheet.locator('.ai-surface.research-request')).toHaveCount(0, { timeout: 10_000 });

    // 서버가 만든 기록 블록이 나타나고, 그 블록이 진행 막대를 소유한다.
    const block = page.locator(`#capture-${RESEARCH_RECEIPT_ID}`);
    await expect(block).toBeVisible({ timeout: 10_000 });
    await expect(block.locator('.stage-track'), '기록 블록에 진행 막대가 없다 — 진행을 아무도 소유하지 않는다').toHaveCount(1);

    // 손이 그리로 넘어갔다: 잠깐의 표식 + 포커스.
    // (표식은 스스로 사라지므로 포커스보다 먼저 본다 — 순서를 바꾸면 기다리는 사이에 지워진다.)
    await expect(block).toHaveAttribute('data-progress-handoff', 'on');
    await expect(block.locator('.brief-summary')).toBeFocused();
  } finally {
    await stopServer(harness.server);
  }
});

test('접수 실패는 이유를 한국어로 말하고, 적어 둔 글과 고른 항목을 지킨다', async ({ page }) => {
  const harness = await boot(page);
  try {
    harness.setActionResponse({ ok: false, error: 'daily_limit' });
    await openPersonSheet(page);
    const sheet = page.locator('ion-modal.person-action-modal');
    await sheet.getByRole('button', { name: '모두 선택' }).click();
    await sheet.locator('ion-textarea[aria-label="AI 조사 요청"] textarea').fill('특히 국내 레퍼런스 위주로');
    await sheet.getByRole('button', { name: '조사 요청 접수' }).click();

    const failure = sheet.locator('.research-receipt.is-failed');
    await expect(failure).toBeVisible({ timeout: 10_000 });
    await expect(failure).toContainText('접수 실패');
    await expect(failure).toContainText('오늘 요청 한도를 넘었어요');

    // 다시 시도할 때 처음부터 다시 적게 하지 않는다.
    await expect(sheet.locator('ion-textarea[aria-label="AI 조사 요청"] textarea')).toHaveValue('특히 국내 레퍼런스 위주로');
    await expect(sheet.locator('.research-scope-count')).toHaveText(`${SCOPE_COUNT}개 중 ${SCOPE_COUNT}개 선택`);

    // 접수되지 않았으므로 기록 블록도 생기지 않는다 — 거짓 진행을 만들지 않는다.
    await expect(page.locator(`#capture-${RESEARCH_RECEIPT_ID}`)).toHaveCount(0);

    // 다시 시도 한 번에 같은 내용이 다시 나간다.
    harness.setActionResponse({ ok: true, receiptId: RESEARCH_RECEIPT_ID, person: 'PER-000001', status: 'received' });
    await failure.getByRole('button', { name: '다시 시도' }).click();
    await expect.poll(() => harness.submitted.length, { timeout: 10_000 }).toBe(2);
    expect(harness.submitted[1].text).toBe(harness.submitted[0].text);
  } finally {
    await stopServer(harness.server);
  }
});

test('빠르게 두 번 눌러도 요청은 한 번만 나간다', async ({ page }) => {
  const harness = await boot(page);
  try {
    await openPersonSheet(page);
    const sheet = page.locator('ion-modal.person-action-modal');
    await sheet.getByRole('button', { name: '모두 선택' }).click();
    const submit = sheet.getByRole('button', { name: '조사 요청 접수' });
    await submit.click();
    await submit.click({ force: true, timeout: 3_000 }).catch(() => undefined);
    await expect.poll(() => harness.submitted.length, { timeout: 10_000 }).toBe(1);
    await page.waitForTimeout(400);
    expect(harness.submitted).toHaveLength(1);
  } finally {
    await stopServer(harness.server);
  }
});

test('다크 모드에서도 조사 항목 글자가 읽힌다', async ({ page }) => {
  const harness = await boot(page, { theme: 'dark' });
  try {
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    // 일부만 고른 상태 — 켜진 블록과 꺼진 블록이 한 화면에 같이 있어야 둘 다 잰다.
    await scopes(page).getByRole('button', { name: '실력·역량 근거' }).click();
    await scopes(page).getByRole('button', { name: '전문 분야' }).click();
    await page.waitForTimeout(120);

    // WCAG 대비를 표준 공식으로 여기서 다시 계산한다 — 앱 공식을 재사용하면 자기충족 검사가 된다.
    const failures = await page.evaluate(() => {
      const parse = (value: string) => {
        const match = value.match(/rgba?\(([^)]+)\)/);
        if (!match) return null;
        const parts = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
        return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
      };
      type Rgba = { r: number; g: number; b: number; a: number };
      const over = (top: Rgba, bottom: Rgba): Rgba => ({
        r: top.r * top.a + bottom.r * (1 - top.a),
        g: top.g * top.a + bottom.g * (1 - top.a),
        b: top.b * top.a + bottom.b * (1 - top.a),
        a: 1,
      });
      const luminance = (color: Rgba) => {
        const channel = (value: number) => { const s = value / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
        return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
      };
      const ratio = (a: Rgba, b: Rgba) => {
        const first = luminance(a); const second = luminance(b);
        return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
      };
      const averageStops = (image: string) => {
        const stops = (image.match(/rgba?\([^)]+\)/g) ?? []).map(parse).filter(Boolean) as Rgba[];
        if (!stops.length) return null;
        const sum = stops.reduce((total, stop) => ({ r: total.r + stop.r, g: total.g + stop.g, b: total.b + stop.b, a: total.a + stop.a }), { r: 0, g: 0, b: 0, a: 0 });
        return { r: sum.r / stops.length, g: sum.g / stops.length, b: sum.b / stops.length, a: sum.a / stops.length };
      };
      const page = parse(getComputedStyle(document.documentElement).getPropertyValue('--cc-page').trim()) ?? { r: 0, g: 0, b: 0, a: 1 };
      const bad: Array<{ where: string; text: string; ratio: number; needed: number }> = [];
      for (const element of document.querySelectorAll<HTMLElement>('.ai-surface.research-request *')) {
        const ownsText = [...element.childNodes].some((node) => node.nodeType === 3 && (node.textContent ?? '').trim());
        if (!ownsText) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) continue;
        const style = getComputedStyle(element);
        if (style.visibility === 'hidden' || style.opacity === '0') continue;
        const color = parse(style.color);
        if (!color || color.a === 0) continue;
        const layers: Rgba[] = []; let node: HTMLElement | null = element;
        while (node && node !== document.documentElement) {
          const nodeStyle = getComputedStyle(node);
          if (nodeStyle.backgroundImage.includes('gradient')) {
            const approximated = averageStops(nodeStyle.backgroundImage);
            if (approximated) { layers.push(approximated); if (approximated.a >= 0.98) break; }
          }
          const background = parse(nodeStyle.backgroundColor);
          if (background && background.a > 0) { layers.push(background); if (background.a === 1) break; }
          node = node.parentElement;
        }
        let background = page;
        for (let index = layers.length - 1; index >= 0; index -= 1) background = over(layers[index], background);
        const size = parseFloat(style.fontSize);
        const large = size >= 24 || (size >= 18.66 && parseInt(style.fontWeight, 10) >= 700);
        const needed = large ? 3 : 4.5;
        const measured = ratio(over(color, background), background);
        if (measured < needed) {
          bad.push({
            where: `${element.tagName.toLowerCase()}.${String(element.className || '').split(' ').slice(0, 2).join('.')}`,
            text: (element.textContent ?? '').trim().slice(0, 18),
            ratio: Math.round(measured * 100) / 100,
            needed,
          });
        }
      }
      return bad;
    });
    expect(failures, `다크 모드에서 읽기 어려운 글자: ${JSON.stringify(failures)}`).toEqual([]);
  } finally {
    await stopServer(harness.server);
  }
});

test('움직임을 줄인 폰에서도 지금 고른 것이 그대로 읽힌다', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const harness = await boot(page);
  try {
    await composer(page).getByRole('button', { name: '모두 선택' }).click();
    const looping = await composer(page).evaluate((node) => node
      .getAnimations({ subtree: true })
      .filter((animation) => animation.playState === 'running' && (animation.effect?.getComputedTiming().iterations ?? 1) === Infinity)
      .length);
    expect(looping, '움직임을 끈 사용자에게도 무한 애니메이션이 돈다').toBe(0);
    // 의미는 글자와 속성으로 남는다.
    await expect(composer(page).locator('.research-scope-count')).toHaveText(`${SCOPE_COUNT}개 중 ${SCOPE_COUNT}개 선택`);
    await expect(composer(page).getByRole('button', { name: '모두 해제' })).toHaveAttribute('aria-pressed', 'true');
  } finally {
    await stopServer(harness.server);
  }
});
