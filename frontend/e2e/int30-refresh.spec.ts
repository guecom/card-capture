// 회귀 게이트: 자동 갱신 스위치와 수동 새로고침이 **서로 다른 사실**로 읽히는가.
// Kairen-Ref: TSK-000543 (INT-000030 / DEC-000105)
//
// founder 판정: "이게 뭔가 새로고침이 되고 있는 건지, 자동 새로고침 기능이 꺼져서 켜져서인지
// 라든가, 뭐 이런 것들이 좀 헷갈리는 것 같아."
//
// 결함의 정체는 배치가 아니라 **기호 하나가 세 뜻을 겸했다**는 것이다. 돌아가는 아이콘이
// (1) 자동 갱신이 켜져 있다 (2) 지금 요청이 오간다 (3) 화면이 최신이다 를 동시에 말했다.
// 이 파일은 셋이 갈라진 상태를 잠근다.
//
// 게이트 전제에 대한 자기 점검:
//   - "안 돈다"만 재는 단언은 표면이 통째로 사라져도 통과한다. 그래서 부정 단언에는
//     **서버 쪽 사실**(실제로 들어온 list 요청 수)을 양성 증거로 함께 요구한다.
//   - 20초 기본 주기를 기다리지 않는다. 처리 중인 카드가 있는 fixture로 4초 박자를 쓴다.
//   - 문구의 숫자는 앱의 공식을 다시 계산해서 맞추지 않는다. 실제로 들어온 요청의 **간격**을
//     재서, 화면이 말한 초와 대조한다 — 자기충족을 피한다.
import { expect, test, type Locator, type Page } from '@playwright/test';
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

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/** 서버 목록. `active`면 아직 끝나지 않은 카드가 있어 빠른 박자(4초)를 쓴다. */
function listFixture(active: boolean) {
  return {
    ok: true,
    seeAll: true,
    researchInstructionEnabled: true,
    hasMore: false,
    items: [
      {
        captureId: '20260720-090000-s1', receivedAt: ago(3 * 24 * 60), status: 'processed', person: 'PER-000901',
        capturer: '이강규', event: '합성 전시회',
        contact: { name: '합성인물-하나', title: '팀장', organization: '합성상사' },
        brief: '# 합성인물-하나 — 이런 분이에요\n합성 데이터입니다.',
      },
      { captureId: '20260726-100000-s2', receivedAt: ago(9), status: active ? 'received' : 'processed' },
    ],
  };
}

interface Harness {
  server: Server;
  origin: string;
  /** 이 세션에서 서버가 받은 list 요청의 시작 시각. "정말로 폴링했는가"의 진실값이다. */
  readonly listStartedAt: number[];
  readonly listRequests: number;
  readonly listInFlight: number;
  readonly maxListInFlight: number;
  setListResponse: (active: boolean) => void;
  delayList: (ms: number) => void;
  failList: (fail: boolean) => void;
}

async function boot(page: Page, options: { active?: boolean; reducedMotion?: boolean } = {}): Promise<Harness> {
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');
  const origin = `http://127.0.0.1:${address.port}/`;

  const state = {
    response: listFixture(options.active !== false),
    delay: 0,
    fail: false,
    inFlight: 0,
    maxInFlight: 0,
    requests: 0,
    startedAt: [] as number[],
  };
  const wait = (ms: number) => (ms > 0 ? new Promise((done) => setTimeout(done, ms)) : Promise.resolve());

  await page.context().route('**/vendor/**', (route) => route.abort());
  await page.route('https://api.example.test/**', async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.searchParams.get('action') === 'list') {
      state.inFlight += 1;
      state.requests += 1;
      state.startedAt.push(Date.now());
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        await wait(state.delay);
        if (state.fail) { await route.fulfill({ status: 500, contentType: 'application/json', body: '{"ok":false}' }); return; }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state.response) });
      } finally {
        state.inFlight -= 1;
      }
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.addInitScript(() => localStorage.setItem('cc_name', '이강규'));
  if (options.reducedMotion) await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  const api = encodeURIComponent('https://api.example.test/exec');
  await page.goto(`${origin}next/?api=${api}&k=owner-token`, { waitUntil: 'networkidle' });

  return {
    server,
    origin,
    get listStartedAt() { return [...state.startedAt]; },
    get listRequests() { return state.requests; },
    get listInFlight() { return state.inFlight; },
    get maxListInFlight() { return state.maxInFlight; },
    setListResponse: (active) => { state.response = listFixture(active); },
    delayList: (ms) => { state.delay = ms; },
    failList: (fail) => { state.fail = fail; },
  };
}

const autoSwitch = (page: Page): Locator => page.getByRole('switch', { name: '자동 갱신' });
const refreshNow = (page: Page): Locator => page.getByRole('button', { name: '최신 상태 확인' });
const refreshLine = (page: Page): Locator => page.locator('.int30-refresh-line');

// ── 1. 기능 상태: 스위치가 명시적으로 말한다 ──

test('자동 갱신은 새 session에서 켜진 채로 시작하고, 스위치가 그 사실을 명시한다', async ({ page }) => {
  const harness = await boot(page);
  try {
    await expect(autoSwitch(page)).toBeVisible();
    await expect(autoSwitch(page)).toHaveAttribute('aria-checked', 'true');
    // 수동 새로고침은 스위치 상태와 무관하게 **언제나** 있다.
    await expect(refreshNow(page)).toBeVisible();
  } finally {
    await stopServer(harness.server);
  }
});

test('끈 상태는 기기에 남지 않는다 — 새 session은 다시 켜진 채로 열린다', async ({ page, context }) => {
  const harness = await boot(page);
  try {
    await autoSwitch(page).click();
    await expect(autoSwitch(page)).toHaveAttribute('aria-checked', 'false');

    // 기기에 남은 것이 정말로 0건인가. 문구가 아니라 저장소를 직접 뒤진다.
    const persisted = await page.evaluate(async () => {
      const local = Object.entries(localStorage).map(([key, value]) => `${key}=${String(value)}`);
      const session = Object.entries(sessionStorage).map(([key, value]) => `${key}=${String(value)}`);
      const databases = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
      const names = databases.map((entry) => entry.name ?? '');
      return { local, session, names };
    });
    const haystack = [...persisted.local, ...persisted.session].join('\n');
    expect(haystack, `자동 갱신 선호가 기기에 저장됐다: ${haystack}`).not.toMatch(/auto.?refresh|자동.?갱신/i);

    // 새 탭 = 새 session. 껐다는 사실을 잊은 사용자에게 멈춘 목록을 물려주지 않는다.
    const fresh = await context.newPage();
    await fresh.context().route('**/vendor/**', (route) => route.abort());
    await fresh.route('https://api.example.test/**', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(listFixture(true)),
    }));
    const api = encodeURIComponent('https://api.example.test/exec');
    await fresh.goto(`${harness.origin}next/?api=${api}&k=owner-token`, { waitUntil: 'networkidle' });
    await expect(autoSwitch(fresh)).toHaveAttribute('aria-checked', 'true');
    await fresh.close();
  } finally {
    await stopServer(harness.server);
  }
});

// ── 2. 박자를 정직하게 말한다 ──

test('화면이 말한 초가 실제 폴링 간격과 같다 (적응형 박자를 평균으로 뭉개지 않는다)', async ({ page }) => {
  const harness = await boot(page, { active: true });
  try {
    // 처리 중인 카드가 있는 동안의 문구. 숫자는 앱 공식을 다시 계산하지 않고 그대로 읽는다.
    await expect(refreshLine(page)).toContainText(/\d+초마다/, { timeout: 8_000 });
    const activeText = (await refreshLine(page).textContent()) ?? '';
    const claimedSeconds = Number(/(\d+)초마다/.exec(activeText)?.[1]);
    expect(claimedSeconds, `박자 문구를 읽지 못했다: ${activeText}`).toBeGreaterThan(0);

    // 진실값은 서버에 실제로 도착한 요청 사이의 간격이다.
    const before = harness.listRequests;
    await expect.poll(() => harness.listRequests, { timeout: 15_000 }).toBeGreaterThanOrEqual(before + 3);
    const stamps = harness.listStartedAt.slice(before);
    const gaps = stamps.slice(1).map((value, index) => value - stamps[index]);
    const observed = Math.min(...gaps);
    expect(observed, `화면은 ${claimedSeconds}초마다라고 하는데 실제 간격은 ${observed}ms다`)
      .toBeGreaterThanOrEqual(claimedSeconds * 1_000 - 1_200);
    expect(observed, `화면은 ${claimedSeconds}초마다라고 하는데 실제로는 ${observed}ms마다 요청한다`)
      .toBeLessThanOrEqual(claimedSeconds * 1_000 + 2_500);

    // 낭독기와 설명 참조가 읽는 전문은 "왜 달라지는지"까지 말한다 — 짧은 조각만으로는 4↔20을
    // 설명할 수 없고, 설명 없는 숫자는 지켜지지 않는 약속으로 읽힌다.
    const sentence = await page.locator('#int30-refresh-sentence').textContent();
    expect(sentence, `전문 실측: ${sentence}`).toMatch(/4초마다/);
    expect(sentence, `전문 실측: ${sentence}`).toMatch(/20초마다/);
    // 스위치와 버튼은 그 전문을 실제로 가리킨다.
    await expect(autoSwitch(page)).toHaveAttribute('aria-describedby', /int30-refresh-sentence/);
    await expect(refreshNow(page)).toHaveAttribute('aria-describedby', /int30-refresh-sentence/);
  } finally {
    await stopServer(harness.server);
  }
});

// ── 3. 끄면 실제로 멈춘다 ──

test('끄면 폴링이 멈추고, 그 뒤에도 수동 새로고침은 그대로 동작한다', async ({ page }) => {
  const harness = await boot(page, { active: true });
  try {
    // 양성 증거 먼저: 지금은 정말로 폴링하고 있다. 이 확인이 없으면 아래 "0건"은
    // 표면이 통째로 죽어도 통과하는 빈 단언이 된다.
    const before = harness.listRequests;
    await expect.poll(() => harness.listRequests, { timeout: 8_000 }).toBeGreaterThan(before);

    await autoSwitch(page).click();
    await expect(autoSwitch(page)).toHaveAttribute('aria-checked', 'false');
    await expect(refreshLine(page)).toContainText('자동 꺼짐');

    // 빠른 박자(4초)의 세 배를 기다린다. 한 건도 늘면 안 된다.
    const stopped = harness.listRequests;
    await page.waitForTimeout(12_000);
    expect(harness.listRequests, '자동 갱신을 껐는데 계속 가져오고 있다').toBe(stopped);

    // 껐어도 새로고침 버튼은 사라지지 않고, 누르면 실제로 요청이 나간다.
    await expect(refreshNow(page)).toBeVisible();
    await refreshNow(page).click();
    await expect.poll(() => harness.listRequests, { timeout: 5_000 }).toBeGreaterThan(stopped);

    // 수동으로 한 번 읽었다고 자동 폴링이 되살아나지는 않는다.
    await expect(autoSwitch(page)).toHaveAttribute('aria-checked', 'false');
    const afterManual = harness.listRequests;
    await page.waitForTimeout(9_000);
    expect(harness.listRequests, '한 번 눌렀더니 자동 폴링이 되살아났다').toBe(afterManual);
  } finally {
    await stopServer(harness.server);
  }
});

// ── 4. 작업 상태는 요청이 실제로 떠 있는 동안에만 ──

test('회전과 aria-busy는 요청이 떠 있는 동안에만 있고, 끝나면 영수증으로 닫힌다', async ({ page }) => {
  const harness = await boot(page, { active: false });
  try {
    // 조용한 상태(20초 박자)에서 관측한다 — 자동 폴링이 끼어들어 busy를 만들지 않는 창이다.
    await expect(refreshNow(page)).toHaveAttribute('aria-busy', 'false');
    const spinningAtRest = await page.locator('.int30-refresh-spin').count();
    expect(spinningAtRest, '아무 요청도 없는데 아이콘이 돌고 있다').toBe(0);

    harness.delayList(3_000);
    await refreshNow(page).click();
    await expect(refreshNow(page)).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('.int30-refresh-spin')).toHaveCount(1);
    await expect(refreshLine(page)).toHaveText('갱신 중');
    // 요청이 떠 있다는 것을 서버 쪽 사실로도 확인한다.
    expect(harness.listInFlight, '읽는 사이에 요청이 이미 끝났다 — 관측 창이 너무 좁다').toBeGreaterThan(0);

    harness.delayList(0);
    await expect(refreshLine(page)).toHaveText('방금 업데이트', { timeout: 8_000 });
    await expect(refreshNow(page)).toHaveAttribute('aria-busy', 'false');
    expect(await page.locator('.int30-refresh-spin').count(), '영수증이 떴는데 아직 돌고 있다').toBe(0);

    // 영수증은 잠깐 머물다 신선도로 돌아간다 — 끝난 일을 진행처럼 남겨 두지 않는다.
    await expect(refreshLine(page)).toContainText('20초마다', { timeout: 8_000 });
  } finally {
    await stopServer(harness.server);
  }
});

test('실패한 갱신은 그 사실을 남기고, 스위치 상태를 건드리지 않는다', async ({ page }) => {
  const harness = await boot(page, { active: false });
  try {
    await expect(refreshLine(page)).toContainText('20초마다');
    harness.failList(true);
    await refreshNow(page).click();
    await expect(refreshLine(page)).toHaveText('갱신 실패', { timeout: 8_000 });
    // 실패를 색으로만 말하지 않는다 — 글자가 이미 실패라고 쓰여 있다.
    await expect(refreshLine(page)).toHaveAttribute('data-state', 'failure');
    // 갱신이 실패했다고 자동 갱신이 꺼지지는 않는다. 두 사실은 서로 다른 축이다.
    await expect(autoSwitch(page)).toHaveAttribute('aria-checked', 'true');
    await expect(refreshNow(page)).toHaveAttribute('aria-busy', 'false');
  } finally {
    await stopServer(harness.server);
  }
});

test('연타해도 요청은 하나로 합쳐지고 늦게 온 응답이 화면을 되돌리지 않는다', async ({ page }) => {
  const harness = await boot(page, { active: false });
  try {
    await expect(refreshLine(page)).toContainText('20초마다');
    harness.delayList(1_500);
    const before = harness.listRequests;
    await refreshNow(page).click();
    await refreshNow(page).click();
    await refreshNow(page).click();
    await expect.poll(() => harness.listInFlight, { timeout: 3_000 }).toBe(1);
    await page.waitForTimeout(3_500);
    expect(harness.maxListInFlight, '연타가 요청을 겹쳐 만들었다').toBe(1);
    expect(harness.listRequests, '연타가 아무 요청도 만들지 못했다 — 게이트가 아무것도 재지 못했다')
      .toBeGreaterThan(before);
  } finally {
    await stopServer(harness.server);
  }
});

// ── 5. 좁은 폭·키보드·움직임 최소화 ──

test('320px 상단 바에서 스위치·버튼·문구가 화면 밖으로 밀리지 않는다', async ({ page }) => {
  const harness = await boot(page, { active: true });
  try {
    await page.setViewportSize({ width: 320, height: 568 });
    await expect(autoSwitch(page)).toBeVisible();
    const report = await page.evaluate(() => {
      const viewport = document.documentElement.clientWidth;
      const offenders: Array<{ selector: string; right: number }> = [];
      document.querySelectorAll<HTMLElement>('ion-header .int30-refresh, ion-header .int30-refresh *').forEach((node) => {
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        if (rect.right <= viewport + 1 && rect.left >= -1) return;
        offenders.push({ selector: node.className || node.tagName, right: Math.round(rect.right) });
      });
      const line = document.querySelector<HTMLElement>('.int30-refresh-line');
      return {
        viewport,
        offenders,
        scrollWidth: document.documentElement.scrollWidth,
        // 화면 이름이 갱신 덩어리에 밀려 사라지면 안 된다.
        titleWidth: document.querySelector('.app-header-copy b')?.getBoundingClientRect().width ?? 0,
        lineFontPx: line ? parseFloat(getComputedStyle(line).fontSize) : 0,
      };
    });
    expect(report.offenders, '갱신 덩어리가 화면 밖으로 나간다').toEqual([]);
    expect(report.scrollWidth, '상단 바 때문에 화면이 가로로 스크롤된다').toBeLessThanOrEqual(report.viewport + 1);
    expect(report.titleWidth, '화면 이름이 갱신 덩어리에 밀려 사라졌다').toBeGreaterThan(40);
    // Ionic 전역 `small { font-size: 75% }`에 물려 더 작아지는 자리다. 통화하며 읽는 글자 크기를 지킨다.
    expect(report.lineFontPx, `갱신 문구가 너무 작다 (${report.lineFontPx}px)`).toBeGreaterThanOrEqual(12.5);

    // 손가락 크기. 320px에서도 두 조작이 모두 충분히 크다.
    for (const control of [autoSwitch(page), refreshNow(page)]) {
      const box = await control.boundingBox();
      expect(box!.height, '조작이 누르기에 충분히 크지 않다').toBeGreaterThanOrEqual(36);
      expect(box!.x + box!.width, '조작이 오른쪽으로 잘렸다').toBeLessThanOrEqual(320 + 1);
    }
  } finally {
    await stopServer(harness.server);
  }
});

test('키보드와 낭독기가 기능 상태·작업 상태·신선도를 따로 읽는다', async ({ page }) => {
  const harness = await boot(page, { active: false });
  try {
    // 스위치는 눌리는 버튼이 아니라 켜고 끄는 스위치로 읽힌다.
    await expect(autoSwitch(page)).toHaveRole('switch');
    // 키보드만으로 켜고 끌 수 있다.
    await autoSwitch(page).focus();
    await expect(autoSwitch(page)).toBeFocused();
    await page.keyboard.press('Space');
    await expect(autoSwitch(page)).toHaveAttribute('aria-checked', 'false');
    await page.keyboard.press('Space');
    await expect(autoSwitch(page)).toHaveAttribute('aria-checked', 'true');

    // 버튼 이름은 상태와 무관하게 고정이다 — 요청 중이라고 이름이 바뀌면 낭독기 사용자에게는
    // 누르려던 버튼이 사라진 것으로 들린다. 진행은 `aria-busy`가 말한다.
    harness.delayList(2_000);
    await refreshNow(page).click();
    await expect(refreshNow(page)).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByRole('button', { name: '최신 상태 확인' })).toHaveCount(1);

    // 자동 박자는 낭독기에 끼어들지 않는다: live region은 사용자가 누른 영수증만 담는다.
    await expect(page.locator('.int30-refresh [role="status"]')).toHaveText('방금 업데이트', { timeout: 8_000 });
  } finally {
    await stopServer(harness.server);
  }
});

test('움직임을 끈 폰에서도 요청 중임을 알 수 있고, 아이콘이 비뚤어진 채 멈추지 않는다', async ({ page }) => {
  const harness = await boot(page, { active: false, reducedMotion: true });
  try {
    const idle = await refreshNow(page).evaluate((node) => getComputedStyle(node).backgroundColor);
    harness.delayList(3_000);
    await refreshNow(page).click();
    await expect(refreshNow(page)).toHaveAttribute('aria-busy', 'true');

    const busy = await refreshNow(page).evaluate((node) => {
      const icon = node.querySelector('svg');
      return {
        background: getComputedStyle(node).backgroundColor,
        borderColor: getComputedStyle(node).borderTopColor,
        // 마지막 프레임(360°)이 곧 정적 fallback이어야 한다 — 비뚤어진 채 굳으면 고장으로 보인다.
        transform: icon ? getComputedStyle(icon).transform : 'none',
        looping: node.getAnimations({ subtree: true })
          .filter((animation) => animation.playState === 'running'
            && (animation.effect?.getComputedTiming().iterations ?? 1) === Infinity).length,
      };
    });
    expect(busy.looping, '움직임을 끈 폰에서도 무한 애니메이션이 돈다').toBe(0);
    expect(busy.background, '회전이 꺼지자 "요청 중"을 알 방법이 사라졌다 — 정지 상태로도 구별돼야 한다')
      .not.toBe(idle);
    expect(['none', 'matrix(1, 0, 0, 1, 0, 0)'], `아이콘이 비뚤어진 채 멈췄다: ${busy.transform}`)
      .toContain(busy.transform);
    // 글자도 함께 말한다 — 색과 모양만으로 상태를 전달하지 않는다.
    await expect(refreshLine(page)).toHaveText('갱신 중');
  } finally {
    await stopServer(harness.server);
  }
});

// ── 6. 갱신 사실을 두 자리에서 말하지 않는다 ──

test('상단 상태 줄은 갱신 사실을 겹쳐 말하지 않고 건수를 온전히 말한다', async ({ page }) => {
  const harness = await boot(page, { active: true });
  try {
    const headerStatus = page.locator('ion-header .app-header small');
    await expect(headerStatus).toContainText('처리 중');
    const text = (await headerStatus.textContent()) ?? '';
    expect(text, `상단 상태가 갱신 사실을 겹쳐 말한다: ${text}`).not.toMatch(/자동 갱신|초마다|방금 업데이트/);
    // 같은 사실은 갱신 덩어리 한 곳에만 있다.
    await expect(refreshLine(page)).toContainText(/초마다|자동 꺼짐/);
  } finally {
    await stopServer(harness.server);
  }
});
