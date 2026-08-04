// Product 계약 적합성 게이트 — `깊은 조사`의 접수 조건 (INT-000030 / TSK-000542).
//
// 계약 원본은 vault `03_Product/Kairen_Card_Capture_Product_Docs/63_Research_Instruction_Contract.md`이고
// 이 저장소는 그 구현이다. 계약이 말하는 문장은 하나다:
//
//   "사용자-facing mode는 `빠른 조사·일반 조사·깊은 조사`이고 신규 요청 기본값은 `일반 조사`다.
//    **깊은 조사는 목적을 하나 이상 골라야 접수된다.**"
//
// 이 파일이 재는 것은 그 문장이 **화면에서 실제로 성립하는가**다. 규칙이 서비스 계층에 있다는
// 것은 단위 테스트가 이미 증명하므로, 여기서는 그 규칙이 사용자의 손과 낭독기에 도달하는지만 본다:
//   막히는가 / 왜 막혔는지 보이는가 / 어떻게 푸는지 보이는가 / 눌렀을 때 막다른 길이 아닌가 /
//   깊이를 몰래 낮추지 않는가 / 빠른·일반을 조이지 않는가.
//
// ── 이 게이트가 형식적이지 않다는 근거 ──
// 수정 **전** 번들(lane B/C/D/E 병합 직후)에서 아래 5개가 실제로 FAIL한다. 그 상태에서는
// `깊은 조사` + 범위 0개로도 요청이 그대로 서버로 나갔다. 통과만 하는 검사는 검사가 아니므로
// 접근성 이름 검사는 **shadow DOM 안의 native button**을 읽는다 — host에 얹은 `aria-label`을
// 그대로 되읽으면 자기가 쓴 값을 자기가 확인하는 자기충족 검사가 된다.
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

/** 범위 0개 + 자유 입력만 있는 깊은 조사 — 계약이 받지 않는 바로 그 상태를 만든다. */
async function makeBlockedRequest(page: Page): Promise<void> {
  await openPersonSheet(page);
  await sheetComposer(page).locator('ion-textarea textarea').fill('공개 경력과 최근 발표를 확인해 주세요');
  await depthOption(sheetComposer(page), 'deep').click();
  await expect(sheetComposer(page).locator('.research-scope-count')).toHaveText(`${SCOPE_COUNT}개 중 0개 선택`);
}

// ── A. 막힌다 ────────────────────────────────────────────────────────────────

test('범위 0개인 깊은 조사는 접수되지 않는다 — 눌러도 서버로 나가지 않는다', async ({ page }) => {
  const harness = await boot(page);
  try {
    await makeBlockedRequest(page);
    await sheetSubmitNative(page).click();

    // 나가지 않았다는 것은 "아직 안 왔다"와 다르다. 실제로 나갔다면 이 사이에 도착한다.
    await page.waitForTimeout(700);
    expect(harness.submitted, '범위 0개인 깊은 조사가 서버로 나갔다').toEqual([]);
    // 시트도 닫히지 않는다 — 적어 둔 내용과 고른 깊이가 그대로 남아 있어야 고칠 수 있다.
    await expect(sheetComposer(page)).toBeVisible();
    await expect(sheetComposer(page).locator('ion-textarea textarea')).toHaveValue('공개 경력과 최근 발표를 확인해 주세요');
  } finally {
    await stopServer(harness.server);
  }
});

test('막히기 전에 이유와 회복 방법이 먼저 보인다 — 누른 뒤에야 알게 되지 않는다', async ({ page }) => {
  const harness = await boot(page);
  try {
    const composer = captureComposer(page);
    // 아무것도 적지 않은 상태에서 깊이만 고른다. 긴 글을 다 적은 뒤에 처음 막히면 늦다.
    await depthOption(composer, 'deep').click();

    const block = composer.locator('.research-block');
    await expect(block, '깊은 조사를 골라도 조건이 어디에도 없다').toBeVisible();
    await expect(block).toHaveAttribute('role', 'status');
    // 왜 막혔는가.
    await expect(block).toContainText('조사 범위');
    // 자유 입력만으로는 안 된다는 사실 — 가장 흔한 오해다.
    await expect(block).toContainText('직접 적은 내용');
    // 무엇을 하면 풀리는가. **두 갈래가 모두** 있어야 막다른 길이 아니다.
    await expect(block).toContainText('일반 조사');

    // 조건이 붙은 칸(깊은 조사)과 그것을 푸는 가장 큰 조작(모두 선택)이 이 설명과 이어져 있다.
    const wiring = await composer.evaluate((root) => {
      const blockId = root.querySelector('.research-block')?.id ?? '';
      const deepInput = root.querySelector('.research-depth-option[data-depth="deep"] input');
      const cta = root.querySelector('.research-scope-all');
      return {
        blockId,
        deepDescribed: (deepInput?.getAttribute('aria-describedby') ?? '').split(/\s+/).includes(blockId),
        ctaDescribed: (cta?.getAttribute('aria-describedby') ?? '').split(/\s+/).includes(blockId),
      };
    });
    expect(wiring.blockId, '설명에 이름이 없어 어디서도 가리킬 수 없다').not.toBe('');
    expect(wiring.deepDescribed, '깊은 조사 칸이 자기 조건과 이어져 있지 않다').toBe(true);
    expect(wiring.ctaDescribed, '모두 선택이 왜 필요한지와 이어져 있지 않다').toBe(true);
  } finally {
    await stopServer(harness.server);
  }
});

// ── B. 막다른 길이 아니다 ─────────────────────────────────────────────────────

test('막힌 제출 버튼은 키보드로 닿고, 이름 자체로 이유를 말한다', async ({ page }) => {
  const harness = await boot(page);
  try {
    await makeBlockedRequest(page);
    const native = sheetSubmitNative(page);

    // 꺼 버리면 키보드로 닿을 수 없어 "왜 안 되는지" 물어볼 방법이 사라진다.
    await expect(native, '막힌 버튼을 아예 꺼서 키보드가 닿을 수 없다').not.toBeDisabled();
    await native.focus();
    await expect(native).toBeFocused();

    // 진실값은 shadow DOM 안 native button의 접근 이름이다 — host에 얹은 값을 되읽지 않는다.
    await expect(native, '막힌 이유가 낭독기에 도달하지 않는다').toHaveAccessibleName(/보낼 수 없어요/);
    await expect(native).toHaveAccessibleName(/일반 조사/);
  } finally {
    await stopServer(harness.server);
  }
});

/* 예전에는 이 검사가 안내 **문단**(`.research-block`)이 포커스를 받는지를 봤다. 문단은 읽히지만
   다음 키 입력으로 할 수 있는 것이 없다 — 막다른 곳이다. 승인된 acceptance는 「실패 시 **목적
   영역으로 focus**와 inline 안내를 제공한다」이고, INT-000036 독립 게이트가 그 차이를 잡아냈다.

   그래서 검사가 조여진다: 손이 가는 곳은 **이 막힘을 실제로 푸는 조작**이어야 하고, 그러면서도
   이유는 여전히 보이고 그 자리에서 함께 읽혀야 한다. 문단 하나만 보던 때보다 재는 것이 늘었다. */
test('막힌 버튼을 누르면 풀 수 있는 자리로 손이 간다 — 아무 일도 없는 버튼이 아니다', async ({ page }) => {
  const harness = await boot(page);
  try {
    await makeBlockedRequest(page);
    const composer = sheetComposer(page);
    const block = composer.locator('.research-block');
    const blockId = await block.getAttribute('id');
    expect(blockId, '막힘 안내에 고정 id가 없다 — 이유를 이어 줄 방법이 없다').toBeTruthy();

    await sheetSubmitNative(page).click();

    // 1. 손은 범위를 켜는 조작 위에 선다. 다음 키 입력(Enter/Space)이 곧 회복이다.
    const selectAll = composer.locator('.research-scope-all');
    await expect(selectAll, '눌러도 막힘을 풀 수 있는 자리로 데려다주지 않는다').toBeFocused();
    // 2. 이유는 사라지지 않고, 그 자리에서 함께 읽힌다.
    await expect(block, '손만 옮기고 왜 막혔는지는 보이지 않는다').toBeVisible();
    expect(
      ((await selectAll.getAttribute('aria-describedby')) ?? '').split(/\s+/),
      '손이 닿은 자리가 막힘 이유와 이어져 있지 않다',
    ).toContain(blockId!);
    // 3. 그 자리에서 정말로 풀린다 — 문구가 아니라 실제 상태로 확인한다.
    await page.keyboard.press('Enter');
    await expect(block, '풀 수 있는 자리라고 데려다 놓고 눌러도 안 풀린다').toHaveCount(0);
    await expect(sheetSubmitNative(page)).toHaveAccessibleName('조사 요청 접수');
  } finally {
    await stopServer(harness.server);
  }
});

test('범위를 하나 고르면 즉시 풀리고 깊은 조사가 그대로 접수된다', async ({ page }) => {
  const harness = await boot(page);
  try {
    await makeBlockedRequest(page);
    const block = sheetComposer(page).locator('.research-block');
    await expect(block).toBeVisible();

    await sheetComposer(page).locator('.research-scope-chip').first().click();
    await expect(block, '범위를 골랐는데도 막힘 안내가 남아 있다').toHaveCount(0);
    await expect(sheetSubmitNative(page)).toHaveAccessibleName('조사 요청 접수');

    await sheetSubmitNative(page).click();
    await expect.poll(() => harness.submitted.length, { timeout: 10_000 }).toBe(1);
    // 낮춰서 보내지 않는다. 사용자가 고른 깊이 그대로 나간다 — 서버가 읽는 칸에서 확인한다.
    expect((harness.submitted[0].instruction as Record<string, unknown>)?.mode, '풀린 뒤에도 깊이가 그대로 실려 나가지 않는다')
      .toBe('deep_evidence_graph');
  } finally {
    await stopServer(harness.server);
  }
});

test('막는 동안 깊이를 몰래 낮추지도, 범위를 대신 고르지도 않는다', async ({ page }) => {
  const harness = await boot(page);
  try {
    await makeBlockedRequest(page);
    await expect(sheetComposer(page).locator('.research-block')).toBeVisible();
    await sheetSubmitNative(page).click();
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

test('깊은 조사를 고른 뒤 범위를 모두 해제하면 촬영 탭의 완료가 다시 막힌다', async ({ page }) => {
  const harness = await boot(page);
  try {
    const composer = captureComposer(page);
    await composer.locator('ion-textarea textarea').fill('의사결정 권한을 확인해 주세요');
    await composer.locator('.research-scope-all').click();
    await depthOption(composer, 'deep').click();
    // 범위가 있는 동안에는 막지 않는다.
    await expect(composer.locator('.research-block')).toHaveCount(0);

    // 다 골라 둔 상태에서 같은 버튼이 `모두 해제`가 된다 — 그 순간 조건이 깨진다.
    await composer.locator('.research-scope-all').click();
    await expect(composer.locator('.research-scope-count')).toHaveText(`${SCOPE_COUNT}개 중 0개 선택`);
    await expect(composer.locator('.research-block'), '범위를 모두 해제했는데 아무 말이 없다').toBeVisible();
    await expect(page.locator('ion-button.primary-action'), '완료가 막힌 상태를 표시하지 않는다')
      .toHaveAttribute('data-blocked', 'research');
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
