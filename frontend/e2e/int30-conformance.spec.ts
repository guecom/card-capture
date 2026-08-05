// Product 계약 적합성 게이트 — `깊은 조사`의 접수 조건 (INT-000030 / TSK-000542 / DEC-000110).
//
// 계약 원본은 vault `03_Product/Kairen_Card_Capture_Product_Docs/63_Research_Instruction_Contract.md`이고
// 이 저장소는 그 구현이다. **계약 문장이 2026-08-05에 뒤집혔다.**
//
// 옛 문장: "깊은 조사는 목적을 하나 이상 골라야 접수된다."
// founder 판정 (DEC-000110): "빠른 조사, 일반 조사, 깊은 조사는 … 오직 모델만 차이가 있는 거야.
//   그러고 깊은 조사를 클릭했을 때 조사 범위를 골라야 한다는 둥, 이런 것이 아니야."
//
// 그래서 이 파일의 A·B 묶음은 **지워지지 않고 뒤집혔다.** 예전에는 "범위 0개인 깊은 조사가
// 막히는가"를 잠갔고 지금은 "그 조건이 다시 생기지 않는가"를 잠근다. 지우면 조건이 슬며시
// 돌아와도 아무도 모른다 — 이 파일이 있는 이유가 바로 그것이다.
//
// 여기서 재는 것은 규칙이 **사용자의 손과 낭독기에 도달하는가**다:
//   깊이를 고르는 것만으로 숙제가 생기지 않는가 / 세 깊이의 조건이 서로 같은가 /
//   깊이를 몰래 낮추지 않는가 / 범위를 대신 골라 주지 않는가 /
//   그러면서도 서버가 닫아 둔 경우(D 묶음)의 fail-closed는 그대로인가.
//
// 통과만 하는 검사는 검사가 아니므로 접근성 이름 검사는 **shadow DOM 안의 native button**을
// 읽는다 — host에 얹은 `aria-label`을 그대로 되읽으면 자기가 쓴 값을 자기가 확인하는
// 자기충족 검사가 된다.
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const buildRoot = resolve(fileURLToPath(new URL('../../docs/', import.meta.url)));
const DAY_MINUTES = 24 * 60;
const RESEARCH_RECEIPT_ID = 'research-int30-conf-1';
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

interface Harness {
  server: Server;
  /** 서버로 실제로 나간 조사 요청의 본문. **비어 있어야 한다는 것이 이 파일의 주장이다.** */
  submitted: Array<Record<string, unknown>>;
}

async function boot(page: Page, options: { width?: number; height?: number; deepOpen?: boolean } = {}): Promise<Harness> {
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');

  const submitted: Array<Record<string, unknown>> = [];
  /* 계약: 깊은 조사는 서버가 열어 뒀다고 말한 경우에만 열린다. 이 파일의 검사는 대부분 열린
     서버를 전제로 하므로 기본값이 열림이다 — 닫힌 서버는 그 경우를 보는 검사가 직접 끈다. */
  const deepOpen = options.deepOpen !== false;

  await page.context().route('**/vendor/**', (route) => route.abort());
  await page.route('https://api.example.test/**', async (route) => {
    const request = route.request();
    const action = new URL(request.url()).searchParams.get('action');
    if (action === 'list') {
      const items = [person(1, '김민서', '한화시스템'), person(2, '이서연', '넥스트로보')];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, seeAll: true, researchInstructionEnabled: true, deepResearchEnabled: deepOpen, hasMore: false, items }) });
      return;
    }
    if (request.method() === 'POST') {
      const body = JSON.parse(request.postData() ?? '{}') as Record<string, unknown>;
      if (body.action === 'researchinstruction') {
        submitted.push(body);
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, receiptId: RESEARCH_RECEIPT_ID, person: 'PER-000001', status: 'received' }) });
        return;
      }
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [] }) });
  });

  await page.addInitScript(() => { localStorage.setItem('cc_name', '이강규'); });
  await page.setViewportSize({ width: options.width ?? 390, height: options.height ?? 844 });
  const api = encodeURIComponent('https://api.example.test/exec');
  await page.goto(`http://127.0.0.1:${address.port}/next/?api=${api}&k=owner-token`, { waitUntil: 'networkidle' });
  return { server, submitted };
}

const captureComposer = (page: Page) => page.locator('.cc-stack > section .ai-surface.research-request').first();
const sheet = (page: Page) => page.locator('ion-modal.person-action-modal');
const sheetComposer = (page: Page) => sheet(page).locator('.ai-surface.research-request');

function depthOption(scope: ReturnType<typeof captureComposer>, depth: string) {
  return scope.locator(`.research-depth-option[data-depth="${depth}"]`);
}

/** 시트 아래에 고정된 제출 버튼. **shadow DOM 안의 진짜 버튼**을 잡는다 — 낭독기가 읽는 것이 이것이다. */
const sheetSubmitNative = (page: Page) => sheet(page).locator('.person-action-submit ion-button button.button-native');

async function openPersonSheet(page: Page): Promise<void> {
  await page.getByRole('button', { name: '진행', exact: true }).click();
  await page.locator('.brief-summary').filter({ hasText: '김민서' }).click();
  await page.locator('.brief-detail').getByRole('button', { name: 'AI 조사 요청' }).click();
  await expect(sheetComposer(page)).toBeVisible();
}

/** 범위 0개 + 자유 입력만 있는 깊은 조사 — 예전 계약이 **받지 않던** 바로 그 상태를 만든다. */
async function makeZeroScopeDeepRequest(page: Page): Promise<void> {
  await openPersonSheet(page);
  await sheetComposer(page).locator('ion-textarea textarea').fill('공개 경력과 최근 발표를 확인해 주세요');
  await depthOption(sheetComposer(page), 'deep').click();
  await expect(sheetComposer(page).locator('.research-scope-count')).toHaveText(`${SCOPE_COUNT}개 중 0개 선택`);
}

// ── A. 막지 않는다 ───────────────────────────────────────────────────────────

test('범위 0개인 깊은 조사가 그대로 접수된다 — 누르면 서버로 나간다', async ({ page }) => {
  const harness = await boot(page);
  try {
    await makeZeroScopeDeepRequest(page);
    await sheetSubmitNative(page).click();

    // 접수됐다는 증거는 문구가 아니라 **실제로 나간 요청**이다.
    await expect.poll(() => harness.submitted.length, { timeout: 10_000 }).toBe(1);
    const envelope = harness.submitted[0].instruction as Record<string, unknown>;
    // 낮춰서 보내지 않는다. 사용자가 고른 깊이 그대로 나간다 — 서버가 읽는 두 칸에서 확인한다.
    expect(envelope.mode, '깊이를 몰래 낮춰 보냈다').toBe('deep_evidence_graph');
    expect(envelope.depth, '고른 깊이가 요청에 실리지 않았다').toBe('deep');
    // 고른 범위가 없으므로 자리도 비어 있다 — 비어 있다고 거절되지 않는다는 것이 이 검사의 전부다.
    expect(envelope.focusIds).toEqual([]);
  } finally {
    await stopServer(harness.server);
  }
});

test('깊은 조사를 골라도 사용자가 더 해야 하는 일이 생기지 않는다', async ({ page }) => {
  const harness = await boot(page);
  try {
    const composer = captureComposer(page);
    // 아무것도 적지 않은 상태에서 깊이만 고른다. 예전에는 이 순간 조건 안내가 떴다.
    await depthOption(composer, 'deep').click();
    await expect(composer.locator('.research-depth-option[data-depth="deep"] input')).toBeChecked();

    await expect(composer.locator('.research-block'), '깊이를 고른 것만으로 숙제가 생겼다').toHaveCount(0);
    await expect(page.locator('ion-button.primary-action'), '깊이를 고른 것만으로 완료가 막혔다')
      .toHaveAttribute('data-blocked', 'no');

    // 깊은 조사 칸이 자기와 무관한 조건을 낭독기에 물고 있지도 않다.
    const described = await composer.evaluate((root) =>
      root.querySelector('.research-depth-option[data-depth="deep"] input')?.getAttribute('aria-describedby') ?? '');
    expect(described, `깊은 조사 칸이 아직 조건과 이어져 있다: ${described}`).toBe('');
  } finally {
    await stopServer(harness.server);
  }
});

// ── B. 세 깊이는 서로 같다 ────────────────────────────────────────────────────

test('제출 버튼 이름이 깊이에 따라 달라지지 않는다', async ({ page }) => {
  const harness = await boot(page);
  try {
    await openPersonSheet(page);
    await sheetComposer(page).locator('ion-textarea textarea').fill('공개 경력과 최근 발표를 확인해 주세요');
    const native = sheetSubmitNative(page);

    for (const depth of ['quick', 'standard', 'deep'] as const) {
      await depthOption(sheetComposer(page), depth).click();
      await expect(sheetComposer(page).locator(`.research-depth-option[data-depth="${depth}"] input`)).toBeChecked();
      // 꺼 버리면 키보드로 닿을 수 없다. 어느 깊이에서도 그런 일은 없다.
      await expect(native, `${depth}에서 제출 버튼이 꺼졌다`).not.toBeDisabled();
      // 진실값은 shadow DOM 안 native button의 접근 이름이다 — host에 얹은 값을 되읽지 않는다.
      await expect(native, `${depth}에서 제출 버튼 이름이 달라졌다`).toHaveAccessibleName('조사 요청 접수');
    }
  } finally {
    await stopServer(harness.server);
  }
});

test('제출은 곧바로 접수로 이어진다 — 다른 자리로 튕겨 보내지 않는다', async ({ page }) => {
  const harness = await boot(page);
  try {
    await makeZeroScopeDeepRequest(page);
    await sheetSubmitNative(page).click();

    await expect.poll(() => harness.submitted.length, { timeout: 10_000 }).toBe(1);
    // 접수됐으므로 시트는 닫힌다. 예전에는 여기서 시트가 남고 손이 범위 영역으로 옮겨졌다.
    await expect(sheet(page), '접수됐는데 작성 자리가 그대로 남아 있다').toBeHidden({ timeout: 10_000 });
  } finally {
    await stopServer(harness.server);
  }
});

test('범위를 고르면 그 범위가 함께 실려 나간다 — 좁힘은 그대로 살아 있다', async ({ page }) => {
  const harness = await boot(page);
  try {
    await makeZeroScopeDeepRequest(page);
    await sheetComposer(page).locator('.research-scope-chip').first().click();
    await expect(sheetComposer(page).locator('.research-scope-count')).toHaveText(`${SCOPE_COUNT}개 중 1개 선택`);

    await sheetSubmitNative(page).click();
    await expect.poll(() => harness.submitted.length, { timeout: 10_000 }).toBe(1);
    const envelope = harness.submitted[0].instruction as Record<string, unknown>;
    expect(envelope.mode).toBe('deep_evidence_graph');
    // 고른 범위가 서버가 읽는 자리로 옮겨졌다. 조건이 아니게 됐다고 값이 사라지면 안 된다.
    expect((envelope.focusIds as string[]).length, '고른 범위가 요청에서 사라졌다').toBeGreaterThanOrEqual(1);
    expect((envelope.purposes as string[]).length, '고른 범위의 목적이 요청에서 사라졌다').toBeGreaterThanOrEqual(1);
  } finally {
    await stopServer(harness.server);
  }
});

test('깊이를 고른다고 범위를 대신 골라 주지 않는다', async ({ page }) => {
  const harness = await boot(page);
  try {
    await makeZeroScopeDeepRequest(page);
    await page.waitForTimeout(400);

    // 고른 깊이는 고른 그대로다.
    await expect(sheetComposer(page).locator('.research-depth-option[data-depth="deep"] input')).toBeChecked();
    // 범위를 대신 켜 주지 않는다 — 고르는 것은 언제나 사람의 손이다.
    await expect(sheetComposer(page).locator('.research-scope-count')).toHaveText(`${SCOPE_COUNT}개 중 0개 선택`);
    await expect(sheetComposer(page).locator('.research-scope-chip[aria-pressed="true"]')).toHaveCount(0);
  } finally {
    await stopServer(harness.server);
  }
});

test('깊은 조사를 고른 뒤 범위를 모두 해제해도 촬영 탭의 완료가 막히지 않는다', async ({ page }) => {
  const harness = await boot(page);
  try {
    const composer = captureComposer(page);
    await composer.locator('ion-textarea textarea').fill('의사결정 권한을 확인해 주세요');
    await composer.locator('.research-scope-all').click();
    await depthOption(composer, 'deep').click();
    await expect(composer.locator('.research-block')).toHaveCount(0);

    // 다 골라 둔 상태에서 같은 버튼이 `모두 해제`가 된다. 예전에는 그 순간 조건이 깨졌다.
    await composer.locator('.research-scope-all').click();
    await expect(composer.locator('.research-scope-count')).toHaveText(`${SCOPE_COUNT}개 중 0개 선택`);
    await expect(composer.locator('.research-block'), '범위를 모두 해제했더니 조건이 되살아났다').toHaveCount(0);
    await expect(page.locator('ion-button.primary-action'), '범위를 모두 해제했더니 완료가 막혔다')
      .toHaveAttribute('data-blocked', 'no');
  } finally {
    await stopServer(harness.server);
  }
});

// ── C. 규칙을 넓혀 조이지 않았다 (수정 전에도 통과해야 하는 보호선) ──────────────

test('빠른·일반은 범위 0개여도 그대로 접수된다', async ({ page }) => {
  const harness = await boot(page);
  try {
    await openPersonSheet(page);
    await sheetComposer(page).locator('ion-textarea textarea').fill('공개 경력만 간단히 확인해 주세요');
    await depthOption(sheetComposer(page), 'quick').click();
    await expect(sheetComposer(page).locator('.research-scope-count')).toHaveText(`${SCOPE_COUNT}개 중 0개 선택`);
    await expect(sheetComposer(page).locator('.research-block')).toHaveCount(0);

    await sheetSubmitNative(page).click();
    await expect.poll(() => harness.submitted.length, { timeout: 10_000 }).toBe(1);
    expect((harness.submitted[0].instruction as Record<string, unknown>)?.mode).toBe('quick');
  } finally {
    await stopServer(harness.server);
  }
});

test('모두 선택은 지금 화면에 있는 범위만 켠다 — 보이지 않는 것을 함께 켜지 않는다', async ({ page }) => {
  const harness = await boot(page);
  try {
    const composer = captureComposer(page);
    await composer.locator('.research-scope-all').click();

    const measured = await composer.evaluate((root) => {
      const chips = [...root.querySelectorAll<HTMLElement>('.research-scope-chip')];
      const visible = chips.filter((chip) => chip.getBoundingClientRect().height > 0);
      return {
        rendered: chips.length,
        visible: visible.length,
        pressed: chips.filter((chip) => chip.getAttribute('aria-pressed') === 'true').length,
        countLabel: (root.querySelector('.research-scope-count')?.textContent ?? '').trim(),
      };
    });
    // 켜진 수 = 화면에 실제로 서 있는 칸 수. 숨은 항목이 함께 켜졌다면 이 셋이 어긋난다.
    expect(measured.rendered).toBe(measured.visible);
    expect(measured.pressed).toBe(measured.visible);
    expect(measured.countLabel).toBe(`${measured.visible}개 중 ${measured.pressed}개 선택`);
  } finally {
    await stopServer(harness.server);
  }
});

// ── D. 닫힘과 남은 조건은 서로 다른 이유다 (TSK-000560 / INT-000036) ──────────
//
// 두 이유가 한 문장으로 뭉개지면 사용자는 풀 수 있는 조건(범위)과 풀 수 없는 조건(닫힘)을
// 구분하지 못한다. 그리고 풀 수 없는 조건이 뒤에 숨으면, 범위를 다 고른 뒤에야 못 보낸다는 것을
// 알게 된다 — 헛수고를 시키는 순서다.

test('서버가 닫아 둔 깊은 조사는 범위를 다 골라도 다른 이유로 막힌다', async ({ page }) => {
  const harness = await boot(page, { deepOpen: false });
  try {
    await openPersonSheet(page);
    const composer = sheetComposer(page);
    await composer.locator('ion-textarea textarea').fill('공개 경력과 최근 발표를 확인해 주세요');

    // 고르는 것 자체는 막히지 않는다 — 예전에는 이 칸이 꺼져 있어 클릭이 아무 일도 하지 않았다.
    await depthOption(composer, 'deep').click();
    await expect(composer.locator('.research-depth-option[data-depth="deep"] input')).toBeChecked();

    const block = composer.locator('.research-block');
    await expect(block).toBeVisible();
    // 범위 조건이 아니라 닫힘을 말한다.
    await expect(block).toContainText('지금 접수하지 않아요');
    await expect(block, '풀 수 없는 조건 자리에 풀 수 있는 조건을 적었다').not.toContainText('조사 범위를 하나 이상');

    // 범위를 다 골라도 그대로다. 사용자가 이 자리에서 풀 수 있는 조건이 아니기 때문이다.
    await composer.locator('.research-scope-all').click();
    await expect(composer.locator('.research-scope-count')).toHaveText(`${SCOPE_COUNT}개 중 ${SCOPE_COUNT}개 선택`);
    await expect(block, '범위를 다 골랐더니 닫힘이 사라졌다 — 열리지 않은 것을 열린 것처럼 보인다').toBeVisible();
    await expect(block).toContainText('지금 접수하지 않아요');

    // 막힌 버튼은 여전히 키보드로 닿고, 이름 자체로 이 이유를 말한다.
    const native = sheetSubmitNative(page);
    await expect(native).not.toBeDisabled();
    await expect(native).toHaveAccessibleName(/보낼 수 없어요/);
    await expect(native).toHaveAccessibleName(/일반 조사/);

    /* 손이 가는 곳이 위의 `범위 0개` 막힘과 **다르다**. 여기서 범위 영역으로 데려가면 그것은
       거짓말이다 — 범위를 다 골라도(바로 위에서 골랐다) 닫힘은 그대로다. 풀 수 있는 것은
       깊이를 바꾸는 것 하나뿐이므로 손은 깊이 라디오 위에 선다 (INT-000036 / TSK-000562). */
    await native.click();
    await expect(
      composer.locator('.research-depth-option[data-depth="deep"] input'),
      '풀 수 없는 조건인데 손이 깊이 자리로 가지 않았다',
    ).toBeFocused();
    await expect(block, '손만 옮기고 왜 막혔는지는 보이지 않는다').toBeVisible();
    await expect(composer.locator('.research-scope-all'), '범위를 골라도 안 풀리는 막힘인데 손이 범위로 갔다')
      .not.toBeFocused();
    await page.waitForTimeout(400);
    expect(harness.submitted, '닫힌 깊은 조사가 서버로 나갔다').toEqual([]);

    // 그 자리에서 화살표 하나로 회복된다 — 데려다 놓은 곳이 정말 푸는 자리라는 증거다.
    await page.keyboard.press('ArrowLeft');
    await expect(composer.locator('.research-depth-option[data-depth="standard"] input')).toBeChecked();

    // 회복은 깊이를 낮추는 것 하나다. 그 순간 그대로 보낼 수 있어야 한다.
    await depthOption(composer, 'standard').click();
    await expect(block).toHaveCount(0);
    await expect(native).toHaveAccessibleName('조사 요청 접수');
    await native.click();
    await expect.poll(() => harness.submitted.length, { timeout: 10_000 }).toBe(1);
    // 낮춰 준 것이 아니라 사용자가 바꾼 것이다 — 나가는 값이 그 사실을 증명한다.
    expect((harness.submitted[0].instruction as Record<string, unknown>)?.mode).toBe('standard');
  } finally {
    await stopServer(harness.server);
  }
});
