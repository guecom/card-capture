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
  /**
   * 목록 응답을 **놓을 때까지** 붙잡아 둔다.
   *
   * `delayList(3_000)`은 관측 창의 길이를 시계에 맡기는 것이다. 바쁜 기계에서는 클릭 왕복 ·
   * 폴링 · 무거운 DOM 읽기가 그 3초를 다 먹고, 창이 닫힌 뒤에 재고는 "진행 표시가 없다"고
   * 말한다 — 제품이 아니라 시점 때문이다. 붙잡아 두면 창은 시험이 놓을 때까지 닫히지 않는다.
   * 판정 기준은 하나도 바뀌지 않고, 창 안에서 쟀다는 사실만 확실해진다.
   */
  holdList: (hold: boolean) => void;
}

interface BootOptions {
  active?: boolean;
  reducedMotion?: boolean;
  /** `false`면 개인 링크 코드 없이 연다 — 서버에 물어볼 수 없는 상태를 그대로 재현한다. */
  connected?: boolean;
  theme?: 'light' | 'dark';
}

async function boot(page: Page, options: BootOptions = {}): Promise<Harness> {
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');
  const origin = `http://127.0.0.1:${address.port}/`;

  const state = {
    response: listFixture(options.active !== false),
    delay: 0,
    fail: false,
    hold: false,
    inFlight: 0,
    maxInFlight: 0,
    requests: 0,
    startedAt: [] as number[],
  };
  const wait = (ms: number) => (ms > 0 ? new Promise((done) => setTimeout(done, ms)) : Promise.resolve());
  let releaseHeld: () => void = () => undefined;
  let held: Promise<void> = Promise.resolve();

  await page.context().route('**/vendor/**', (route) => route.abort());
  await page.route('https://api.example.test/**', async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.searchParams.get('action') === 'list') {
      state.inFlight += 1;
      state.requests += 1;
      state.startedAt.push(Date.now());
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        if (state.hold) await held;
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

  await page.addInitScript((theme) => {
    localStorage.setItem('cc_name', '이강규');
    if (theme) localStorage.setItem('cc_theme', theme);
  }, options.theme ?? '');
  if (options.reducedMotion) await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  const api = encodeURIComponent('https://api.example.test/exec');
  const token = options.connected === false ? '' : '&k=owner-token';
  await page.goto(`${origin}next/?api=${api}${token}`, { waitUntil: 'networkidle' });

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
    holdList: (hold) => {
      if (hold) {
        if (state.hold) return;
        state.hold = true;
        held = new Promise((done) => { releaseHeld = () => done(); });
        return;
      }
      state.hold = false;
      releaseHeld();
    },
  };
}

/**
 * 스위치 손잡이의 전환이 **실제로 끝날 때까지** 기다린다.
 *
 * 고정 대기(`waitForTimeout(350)`)는 "160ms면 끝났겠지"라는 짐작이고, 바쁜 기계에서 그 짐작이
 * 틀리면 게이트가 전환 도중 값을 잰다. 아직 시작하지 않은 전환도 있을 수 있어 한 프레임 뒤에
 * 한 번 더 비운다. 8초 상한은 판정이 아니라 교착 방지다.
 */
async function settleKnob(page: Page): Promise<void> {
  await page.locator('.int30-refresh-track i').evaluate(async (node) => {
    const drain = async () => {
      await Promise.race([
        Promise.all(node.getAnimations().filter((animation) => animation.playState === 'running')
          .map((animation) => animation.finished.catch(() => undefined))),
        new Promise((done) => setTimeout(done, 8_000)),
      ]);
    };
    await drain();
    await new Promise((done) => requestAnimationFrame(() => done(undefined)));
    await drain();
  });
}

const autoSwitch = (page: Page): Locator => page.getByRole('switch', { name: '자동 갱신' });
const refreshNow = (page: Page): Locator => page.getByRole('button', { name: '최신 상태 확인' });
const refreshLine = (page: Page): Locator => page.locator('.int30-refresh-line');
const refreshNotice = (page: Page): Locator => page.locator('.int30-refresh-notice');
const retryButton = (page: Page): Locator => refreshNotice(page).getByRole('button', { name: '다시 시도' });

/**
 * 지금 화면에 떠 있는 토스트.
 *
 * `is-open` 속성을 읽으면 안 된다 — Ionic React는 `isOpen`을 **DOM property**로만 넘기므로
 * 그 속성은 열려 있어도 없다. 속성만 보는 검사는 토스트가 세 장 떠 있어도 통과하는 빈
 * 게이트가 된다(실제로 이 저장소에 그런 단언이 있었다). 그려진 상자와 문구를 직접 본다.
 */
function openToasts(): string[] {
  return Array.from(document.querySelectorAll('ion-toast'))
    .filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && !node.classList.contains('overlay-hidden');
    })
    .map((node) => String((node as HTMLElement & { message?: string }).message ?? node.textContent ?? '').trim());
}

/**
 * 페이지 안에서 도는 실측기. **보이는 상자가 아니라 손가락이 닿는 자리**를 잰다.
 *
 * 상단 바의 조작은 chrome을 얇게 두고 hit area만 넓히므로 `getBoundingClientRect().height`는
 * 눌리는 크기와 다르다. 그래서 조작의 중심에서 위·아래로 1px씩 나가며 `elementFromPoint`가
 * 여전히 그 조작을 돌려주는 마지막 지점을 찾는다 — 가상 요소로 넓힌 자리도 그대로 잡힌다.
 */
function measureRefreshReach(): {
  auto: { height: number; center: number; band: number } | null;
  now: { height: number; center: number; band: number } | null;
  row: { height: number; center: number } | null;
  brand: { height: number; center: number } | null;
  copy: { height: number; center: number } | null;
} {
  const round = (value: number) => Math.round(value * 10) / 10;
  const owns = (node: Element, hit: Element | null) => Boolean(hit && (hit === node || node.contains(hit)));
  const band = (selector: string) => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const grow = (direction: number) => {
      let last = 0;
      for (let step = 1; step <= 40; step += 1) {
        if (!owns(node, document.elementFromPoint(cx, cy + direction * step))) break;
        last = step;
      }
      return last;
    };
    return { height: round(rect.height), center: round(cy), band: grow(-1) + grow(1) + 1 };
  };
  const box = (selector: string) => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { height: round(rect.height), center: round(rect.top + rect.height / 2) };
  };
  return {
    auto: band('.int30-refresh-switch'),
    now: band('.int30-refresh-now'),
    row: box('.int30-refresh-row'),
    brand: box('.brand-mark'),
    copy: box('.app-header-copy'),
  };
}

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

    /* 관측 창을 **놓을 때까지** 붙잡는다. 3초 지연이었을 때는 그 3초 안에 클릭 왕복과 세 개의
       폴링 단언이 다 들어가야 했고, CI에서 실제로 다 못 들어가 마지막 줄이 자기 메시지대로
       "관측 창이 너무 좁다"에 걸렸다. 단언은 그대로고, 창만 시계에서 시험으로 옮긴다. */
    harness.holdList(true);
    await refreshNow(page).click();
    await expect
      .poll(() => harness.listInFlight, { timeout: 10_000 })
      .toBeGreaterThan(0);

    await expect(refreshNow(page)).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('.int30-refresh-spin')).toHaveCount(1);
    /* 진행은 버튼만 말한다 (INT-000036). 이 줄은 그동안에도 박자를 그대로 말한다 —
       마지막으로 받은 시점은 요청이 떠 있는 동안에도 여전히 참이다. */
    await expect(refreshLine(page)).toContainText('20초마다');
    // 위 넷을 재는 내내 요청이 떠 있었다는 것을 서버 쪽 사실로 확인한다.
    expect(harness.listInFlight, '읽는 사이에 요청이 이미 끝났다 — 관측 창이 너무 좁다').toBeGreaterThan(0);

    harness.holdList(false);
    await expect(refreshLine(page)).toHaveText('방금 업데이트', { timeout: 8_000 });
    await expect(refreshNow(page)).toHaveAttribute('aria-busy', 'false');
    expect(await page.locator('.int30-refresh-spin').count(), '영수증이 떴는데 아직 돌고 있다').toBe(0);

    // 영수증은 잠깐 머물다 신선도로 돌아간다 — 끝난 일을 진행처럼 남겨 두지 않는다.
    await expect(refreshLine(page)).toContainText('20초마다', { timeout: 8_000 });
  } finally {
    harness.holdList(false);
    await stopServer(harness.server);
  }
});

test('실패한 갱신은 그 사실을 남기고, 스위치 상태를 건드리지 않는다', async ({ page }) => {
  const harness = await boot(page, { active: false });
  try {
    await expect(refreshLine(page)).toContainText('20초마다');
    harness.failList(true);
    await refreshNow(page).click();

    /* 실패는 이제 **남는 안내**가 소유한다 (TSK-000559). 예전에는 이 줄이 `갱신 실패`로 바뀌고
       동시에 토스트가 떴다 — 같은 사실을 두 자리가 말했고, 그중 하나는 2.6초 뒤 사라졌다. */
    await expect(refreshNotice(page)).toBeVisible({ timeout: 8_000 });
    await expect(refreshNotice(page)).toHaveAttribute('data-tone', 'error');
    // 실패를 색으로만 말하지 않는다 — 안내에 원인 갈래가 글자로 쓰여 있다.
    await expect(refreshNotice(page)).toContainText(/오류|실패/);
    await expect(refreshLine(page)).toHaveAttribute('data-state', 'failure');
    // 신선도 줄은 실패를 겹쳐 말하지 않고 자기 일(마지막 성공·박자)을 계속한다.
    await expect(refreshLine(page)).toContainText(/초마다/);
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
    /* 세 번의 누름이 **모두 같은 창 안에** 떨어져야 겹침을 잴 수 있다. 1.5초 지연으로는 바쁜
       기계에서 첫 요청이 셋째 누름보다 먼저 끝나 버려, 겹칠 기회 자체가 사라진 상태를 두고
       "겹치지 않았다"고 통과할 수 있었다. 붙잡아 두면 셋이 확실히 같은 창에 들어간다. */
    harness.holdList(true);
    const before = harness.listRequests;
    await refreshNow(page).click();
    await refreshNow(page).click();
    await refreshNow(page).click();
    await expect.poll(() => harness.listInFlight, { timeout: 8_000 }).toBe(1);
    expect(harness.maxListInFlight, '연타가 요청을 겹쳐 만들었다').toBe(1);

    /* 놓는다. 연타는 떠 있던 조회 **직후 한 번 더** 읽으므로(single-flight의 후속 조회),
       그 후속까지 끝난 뒤에 다시 겹침을 판정한다 — 시계로 3.5초를 세는 대신 요청 수와
       떠 있는 수로 끝났음을 확인한다. */
    harness.holdList(false);
    await expect.poll(() => harness.listRequests, { timeout: 10_000 }).toBeGreaterThanOrEqual(before + 2);
    await expect.poll(() => harness.listInFlight, { timeout: 10_000 }).toBe(0);
    expect(harness.maxListInFlight, '연타가 요청을 겹쳐 만들었다').toBe(1);
    expect(harness.listRequests, '연타가 아무 요청도 만들지 못했다 — 게이트가 아무것도 재지 못했다')
      .toBeGreaterThan(before);
  } finally {
    harness.holdList(false);
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
    // **보이는 상자 높이를 재지 않는다.** 눌리는 것은 그림이 아니라 hit area이고, 이 앱은
    // 상단 바에서 chrome을 얇게 두면서 hit area만 넓히기 때문이다 (TSK-000559). 실제로
    // 손가락이 닿는 세로 폭을 `elementFromPoint`로 바깥으로 훑어 잰다.
    const reach = await page.evaluate(measureRefreshReach);
    for (const control of ['자동 갱신 스위치', '새로고침 버튼'] as const) {
      const measured = control === '자동 갱신 스위치' ? reach.auto : reach.now;
      expect(measured, `${control}을 찾지 못했다`).not.toBeNull();
      expect(measured!.band, `${control}이 누르기에 충분히 크지 않다 (실측 ${measured!.band}px, 보이는 높이 ${measured!.height}px)`)
        .toBeGreaterThanOrEqual(44);
    }
    for (const control of [autoSwitch(page), refreshNow(page)]) {
      const box = await control.boundingBox();
      expect(box!.x + box!.width, '조작이 오른쪽으로 잘렸다').toBeLessThanOrEqual(320 + 1);
    }
  } finally {
    await stopServer(harness.server);
  }
});

test('320px에서 실패 안내가 떠도 화면 이름이 살아 있고 가로로 넘치지 않는다', async ({ page }) => {
  const harness = await boot(page, { active: false });
  try {
    await page.setViewportSize({ width: 320, height: 568 });
    harness.failList(true);
    await refreshNow(page).click();
    await expect(refreshNotice(page)).toBeVisible({ timeout: 8_000 });

    const report = await page.evaluate(() => {
      const viewport = document.documentElement.clientWidth;
      const offenders: string[] = [];
      document.querySelectorAll<HTMLElement>('ion-header .int30-refresh, ion-header .int30-refresh *').forEach((node) => {
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        if (rect.right <= viewport + 1 && rect.left >= -1) return;
        offenders.push(`${node.className || node.tagName} → right ${Math.round(rect.right)}`);
      });
      return {
        viewport,
        offenders,
        scrollWidth: document.documentElement.scrollWidth,
        titleWidth: Math.round(document.querySelector('.app-header-copy b')?.getBoundingClientRect().width ?? 0),
        noticeWidth: Math.round(document.querySelector('.int30-refresh-notice')?.getBoundingClientRect().width ?? 0),
      };
    });
    expect(report.offenders, `실패 안내가 화면 밖으로 나간다: ${report.offenders.join(' / ')}`).toEqual([]);
    expect(report.scrollWidth, '실패 안내 때문에 화면이 가로로 스크롤된다').toBeLessThanOrEqual(report.viewport + 1);
    // 무엇이 막혔는지 말하려고 **지금 어느 화면인지**를 지우지 않는다.
    expect(report.titleWidth, `실패 안내가 화면 이름을 밀어냈다 (${report.titleWidth}px)`).toBeGreaterThan(40);
    expect(report.noticeWidth, '실패 안내가 그려지지 않았다').toBeGreaterThan(60);

    // 손잡이도 얇은 chrome과 무관하게 눌린다.
    const retryBand = await page.evaluate(() => {
      const node = document.querySelector('.int30-refresh-notice-retry');
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const owns = (hit: Element | null) => Boolean(hit && (hit === node || node.contains(hit)));
      const grow = (direction: number) => {
        let last = 0;
        for (let step = 1; step <= 40; step += 1) {
          if (!owns(document.elementFromPoint(cx, cy + direction * step))) break;
          last = step;
        }
        return last;
      };
      return grow(-1) + grow(1) + 1;
    });
    expect(retryBand, `\`다시 시도\`의 누를 수 있는 높이가 ${retryBand}px다`).toBeGreaterThanOrEqual(44);
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
    // 이름이 그대로인지는 **요청이 떠 있는 동안** 봐야 하므로 창을 붙잡아 둔다.
    harness.holdList(true);
    await refreshNow(page).click();
    await expect.poll(() => harness.listInFlight, { timeout: 10_000 }).toBeGreaterThan(0);
    await expect(refreshNow(page)).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByRole('button', { name: '최신 상태 확인' })).toHaveCount(1);
    expect(harness.listInFlight, '읽는 사이에 요청이 이미 끝났다 — 관측 창이 너무 좁다').toBeGreaterThan(0);

    // 자동 박자는 낭독기에 끼어들지 않는다: live region은 사용자가 누른 영수증만 담는다.
    harness.holdList(false);
    await expect(page.locator('.int30-refresh [role="status"]')).toHaveText('방금 업데이트', { timeout: 8_000 });
  } finally {
    harness.holdList(false);
    await stopServer(harness.server);
  }
});

test('움직임을 끈 폰에서도 요청 중임을 알 수 있고, 아이콘이 비뚤어진 채 멈추지 않는다', async ({ page }) => {
  const harness = await boot(page, { active: false, reducedMotion: true });
  try {
    const idle = await refreshNow(page).evaluate((node) => getComputedStyle(node).backgroundColor);
    const idleBorder = await refreshNow(page).evaluate((node) => getComputedStyle(node).borderTopColor);
    // 관측 창을 놓을 때까지 붙잡는다 — 아래에서 한 프레임을 기다릴 여유를 창 안에 둔다.
    harness.holdList(true);
    await refreshNow(page).click();
    await expect.poll(() => harness.listInFlight, { timeout: 10_000 }).toBeGreaterThan(0);
    await expect(refreshNow(page)).toHaveAttribute('aria-busy', 'true');

    const busy = await refreshNow(page).evaluate(async (node) => {
      /* **그려진 뒤에** 읽는다.
         `aria-busy`가 막 붙은 그 프레임에 `getComputedStyle`을 부르면 아직 바뀌기 전 값이
         돌아오는 순간이 있다. 부하를 건 기계에서 16판 중 2판이 그 순간에 걸렸고, 그때
         읽힌 값은 평상시 색 그대로(`rgba(255,255,255,0.78)` / 테두리 `rgba(42,63,89,0.12)`)에
         아이콘 회전만 0% (`matrix(1,0,0,1,0,0)`)였다 — 통과한 판은 전부 회전이 이미 끝난
         뒤(`none`)였다. 즉 화면에 아직 한 프레임도 안 나간 상태를 잰 것이다. 사용자가 보는
         값은 그려진 값이므로, 두 프레임을 흘려 보내고 잰다. 판정 기준은 그대로다. */
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(undefined))));
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
    expect(harness.listInFlight, '읽는 사이에 요청이 이미 끝났다 — 관측 창이 너무 좁다').toBeGreaterThan(0);
    expect(busy.looping, '움직임을 끈 폰에서도 무한 애니메이션이 돈다').toBe(0);
    expect(busy.background, '회전이 꺼지자 "요청 중"을 알 방법이 사라졌다 — 정지 상태로도 구별돼야 한다')
      .not.toBe(idle);
    expect(['none', 'matrix(1, 0, 0, 1, 0, 0)'], `아이콘이 비뚤어진 채 멈췄다: ${busy.transform}`)
      .toContain(busy.transform);
    /* 예전에는 여기서 신선도 줄의 `갱신 중` 글자를 함께 봤다. 그 글자는 없어졌다 —
       진행을 말하는 자리가 버튼과 그 줄 둘이었고, founder 승인안이 하나로 못 박았다
       (INT-000036). 그래서 이 검사는 **남은 하나가 정말로 혼자 다 나르는지**를 잰다:
       바탕 하나에만 기대지 않고 테두리도 함께 바뀌어야 하며(색 한 축이 안 보이는 사용자),
       낭독기·자동화에는 `aria-busy`가 같은 사실을 글자 없이 나른다. */
    expect(busy.borderColor, '진행 표시가 바탕색 한 축에만 걸려 있다 — 그 축이 안 보이면 알 방법이 없다')
      .not.toBe(idleBorder);
    await expect(refreshNow(page)).toHaveAttribute('aria-busy', 'true');
    // 그리고 그 사실을 말하는 자리는 여전히 **하나**다. 줄은 박자를 그대로 말한다.
    const line = ((await refreshLine(page).textContent()) ?? '').trim();
    expect(line, `신선도 줄이 진행을 겹쳐 말한다: ${line}`).not.toMatch(/갱신 중|새로고침 중/);
  } finally {
    harness.holdList(false);
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

// ══════════════════════════════════════════════════════════════════════════════
// INT-000036 / TSK-000559 · ISS-000050 — 갱신 피드백의 주인을 **누른 버튼 하나**로
//
// founder 판정: "오른쪽 위에 새로고침 버튼이 돌아가고 있는데, 이제 갱신 중이라고 뜨는 게 이상해.
// 그러고 눌렀을 때 새로고침 중이라고 뭔가 위에서 내려오는데, 이거 굳이 있어야 되나 싶어."
//
// 결함은 문구가 아니라 **소유권**이었다. 회전과 `갱신 중`이 `loading`(모든 목록 조회)을 따랐고,
// `loading`은 자동 폴링에서도 참이 된다. 그래서 아무도 누르지 않은 화면이 스스로 돌았다.
// 여기서부터 진행 사실은 **사용자가 누른 요청의 영수증**만 소유한다.
// ══════════════════════════════════════════════════════════════════════════════

test('자동 박자는 회전도 `갱신 중`도 만들지 않는다 — 진행은 누른 사람만 본다', async ({ page }) => {
  const harness = await boot(page, { active: true });
  try {
    await expect(refreshLine(page)).toContainText('4초마다', { timeout: 8_000 });
    /* 자동 폴링 하나를 일부러 붙잡아 관측 창을 연다. 이 창 동안 사용자는 아무것도 누르지 않았다.
       2.5초 지연이었을 때는 창이 닫힌 뒤에 재면 아래 "안 돈다"가 저절로 참이 됐다 —
       빨개지지는 않지만 아무것도 재지 못하는 상태다. 놓을 때까지 붙잡아 그 구멍을 막는다. */
    harness.holdList(true);
    const before = harness.listRequests;
    await expect.poll(() => harness.listInFlight, { timeout: 12_000 }).toBeGreaterThan(0);
    // 양성 증거: 정말로 자동 요청이 떠 있다. 없으면 아래 "안 돈다"는 빈 단언이 된다.
    expect(harness.listRequests, '관측 창에서 자동 폴링이 한 번도 일어나지 않았다').toBeGreaterThan(before);

    const seen = await page.evaluate(() => ({
      busy: document.querySelector('.int30-refresh-now')?.getAttribute('aria-busy') ?? '',
      spinning: document.querySelectorAll('.int30-refresh-spin').length,
      line: (document.querySelector('.int30-refresh-line')?.textContent ?? '').trim(),
    }));
    expect(harness.listInFlight, '읽는 사이에 자동 조회가 끝났다 — 관측 창이 너무 좁다').toBeGreaterThan(0);
    expect(seen.busy, '누른 적이 없는데 버튼이 aria-busy가 됐다').toBe('false');
    expect(seen.spinning, '누른 적이 없는데 아이콘이 돌고 있다').toBe(0);
    expect(seen.line, `누른 적이 없는데 상단이 "${seen.line}"이라고 말한다`).not.toContain('갱신 중');
  } finally {
    harness.holdList(false);
    await stopServer(harness.server);
  }
});

test('수동 갱신은 위에서 내려오는 토스트를 만들지 않는다', async ({ page }) => {
  const harness = await boot(page, { active: false });
  try {
    await expect(refreshLine(page)).toContainText('20초마다');
    /* 900ms 지연으로는 아래 `sweep(8)`(8 × 140ms = 1.12초)이 창보다 길어서, 훑는 도중에 요청이
       끝나고 나머지 표본이 "진행 중이 아닌 화면"을 헛 훑었다. 놓을 때까지 붙잡아 훑기 전체가
       진행 구간 안에 들어가게 한다 — 토스트를 잡을 기회가 오히려 늘어난다. */
    harness.holdList(true);
    await refreshNow(page).click();

    // 진행 구간을 훑는다. 예전에는 여기서 `새로고침 중…`이 위에서 내려왔다.
    const opened: string[] = [];
    const sweep = async (samples: number) => {
      for (let sample = 0; sample < samples; sample += 1) {
        const shown = await page.evaluate(openToasts);
        if (shown.length > 0) opened.push(`${sample}: ${shown.join(' / ')}`);
        await page.waitForTimeout(140);
      }
    };
    // 요청이 떠 있는 창을 붙잡는 신호는 버튼의 `aria-busy`다 — 진행의 유일한 주인이다.
    await expect(refreshNow(page)).toHaveAttribute('aria-busy', 'true');
    await sweep(8);
    expect(harness.listInFlight, '훑는 사이에 요청이 이미 끝났다 — 진행 구간을 못 봤다').toBeGreaterThan(0);

    // 성공은 토스트가 아니라 신선도 줄이 바뀌는 것으로 닫힌다.
    harness.holdList(false);
    await expect(refreshLine(page)).toHaveText('방금 업데이트', { timeout: 8_000 });
    // 성공 직후 구간도 훑는다 — 완료 토스트가 여기서 떴다.
    await sweep(12);

    expect(opened, `수동 갱신이 토스트를 띄웠다 — ${opened.join(' | ')}`).toEqual([]);
    expect(await page.getByText(/새로고침 (중|완료|실패)/).count(), '새로고침 진행·완료 문구가 화면 어딘가에 남아 있다').toBe(0);
  } finally {
    harness.holdList(false);
    await stopServer(harness.server);
  }
});

test('실패는 토스트가 아니라 갱신 덩어리 안에 남고, 다음 요청이 풀어 준다', async ({ page }) => {
  const harness = await boot(page, { active: false });
  try {
    await expect(refreshLine(page)).toContainText('20초마다');
    harness.failList(true);
    await refreshNow(page).click();

    await expect(refreshNotice(page)).toBeVisible({ timeout: 8_000 });
    await expect(retryButton(page)).toBeVisible();
    const said = (await refreshNotice(page).innerText()).trim();
    expect(said, `실패의 원인 갈래를 말하지 않는다: ${said}`).toMatch(/네트워크|서버|연결|불러오/);

    // 토스트 수명(2.6초)과 성공 유지(2초)를 모두 넘겨도 사라지지 않는다.
    // 사용자가 조치해야 하는 사실에 2.6초짜리 수명을 주는 것이 애초의 결함이었다.
    await page.waitForTimeout(4_200);
    await expect(refreshNotice(page)).toBeVisible();
    expect(await page.evaluate(openToasts), '실패가 토스트로도 떴다').toEqual([]);

    // 다음 요청이 성공하면 스스로 사라진다 — 사용자가 치우는 일이 아니다.
    harness.failList(false);
    await retryButton(page).click();
    await expect(refreshNotice(page)).toHaveCount(0, { timeout: 8_000 });
    await expect(refreshLine(page)).toContainText(/방금|초마다/, { timeout: 8_000 });
  } finally {
    await stopServer(harness.server);
  }
});

test('같은 실패가 반복되면 같은 문장을 되풀이하지 않고 단계를 올린다', async ({ page }) => {
  const harness = await boot(page, { active: false });
  try {
    await expect(refreshLine(page)).toContainText('20초마다');
    harness.failList(true);

    await refreshNow(page).click();
    await expect(refreshNotice(page)).toBeVisible({ timeout: 8_000 });
    const first = (await refreshNotice(page).innerText()).replace(/\s+/g, ' ').trim();

    await retryButton(page).click();
    await expect
      .poll(async () => (await refreshNotice(page).innerText()).replace(/\s+/g, ' ').trim(), { timeout: 8_000 })
      .not.toBe(first);
    const second = (await refreshNotice(page).innerText()).replace(/\s+/g, ' ').trim();
    expect(second, `두 번째 실패가 첫 번째와 똑같은 말을 한다: ${second}`).not.toBe(first);
    expect(second, `단계를 올렸는데 사용자가 할 수 있는 일을 말하지 않는다: ${second}`).toMatch(/연결|Wi-Fi|데이터|설정/);
    // 단계를 올려도 손잡이는 그대로 하나다.
    await expect(retryButton(page)).toBeVisible();
  } finally {
    await stopServer(harness.server);
  }
});

test('오프라인이면 자동 갱신이 멈춘 이유를 말하고, 돌아오면 스스로 재개한다', async ({ page }) => {
  const harness = await boot(page, { active: true });
  try {
    await expect(refreshLine(page)).toContainText('4초마다', { timeout: 8_000 });
    harness.failList(true);
    await page.context().setOffline(true);

    await expect(refreshNotice(page)).toContainText('오프라인', { timeout: 8_000 });
    // 오프라인은 사용자가 누른 실패가 아니다 — 회전도 aria-busy도 만들지 않는다.
    await expect(refreshNow(page)).toHaveAttribute('aria-busy', 'false');
    expect(await page.locator('.int30-refresh-spin').count(), '오프라인 안내가 아이콘을 돌렸다').toBe(0);

    harness.failList(false);
    const before = harness.listRequests;
    await page.context().setOffline(false);
    await expect(refreshNotice(page)).toHaveCount(0, { timeout: 8_000 });
    // 안내만 지우고 마는 것이 아니라 **실제로 다시 받아 온다**.
    await expect.poll(() => harness.listRequests, { timeout: 8_000 }).toBeGreaterThan(before);
  } finally {
    await page.context().setOffline(false);
    await stopServer(harness.server);
  }
});

test('연결이 없으면 새로고침이 헛돌지 않고 왜 못 하는지 말한다', async ({ page }) => {
  const harness = await boot(page, { active: false, connected: false });
  try {
    await expect(refreshLine(page)).toContainText('연결되면 확인', { timeout: 8_000 });
    const before = harness.listRequests;
    await refreshNow(page).click();

    await expect(refreshNotice(page)).toBeVisible({ timeout: 5_000 });
    await expect(refreshNotice(page)).toContainText(/연결/);
    await page.waitForTimeout(1_500);
    expect(harness.listRequests, '연결이 없는데 서버로 요청을 보냈다').toBe(before);
    const line = ((await refreshLine(page).textContent()) ?? '').trim();
    expect(line, `받아온 것이 하나도 없는데 "${line}"이라고 말한다`).not.toContain('방금 업데이트');
    await expect(refreshNow(page)).toHaveAttribute('aria-busy', 'false');
  } finally {
    await stopServer(harness.server);
  }
});

/* 예전에는 이 검사가 `명함 기록` 옆 두 번째 줄(`.refresh-hint`)이 live region을 들고 있지
   않은지를 함께 봤다. 그 줄은 없어졌다 (INT-000036) — 상단 갱신 덩어리가 이미 같은 계획에서
   같은 낱말로 말하는 셋(자동 켜짐/꺼짐 · 박자 · 마지막 성공)을 한 번 더 말할 뿐이었다.
   검사는 약해지지 않는다. 오히려 **표면이 하나뿐이라는 사실 자체**를 여기서 잰다: 줄이
   없어졌는지만 확인하고 끝내면, 누군가 다른 이름으로 같은 줄을 다시 세워도 통과한다. */
test('갱신 사실을 낭독하는 live region은 하나뿐이다', async ({ page }) => {
  const harness = await boot(page, { active: false });
  try {
    await expect(refreshLine(page)).toBeVisible();
    const report = await page.evaluate(() => {
      const liveSelector = '[role="status"], [role="alert"], [aria-live]:not([aria-live="off"])';
      const facts = /갱신|새로고침|초마다|업데이트/;
      const speaking = Array.from(document.querySelectorAll(liveSelector))
        .filter((node) => facts.test(node.textContent ?? ''))
        .map((node) => `${node.className || node.tagName}: ${(node.textContent ?? '').trim().slice(0, 30)}`);
      /* 갱신 사실을 말하는 표면을 **전부** 센다 — live region인지와 무관하게. 이것이 없으면
         "두 번째 줄을 다시 세우되 role만 안 붙인다"가 그대로 통과한다. */
      const stating = Array.from(document.querySelectorAll<HTMLElement>('body *'))
        .filter((node) => {
          const own = Array.from(node.childNodes)
            .filter((child) => child.nodeType === 3)
            .map((child) => child.textContent ?? '')
            .join(' ');
          return /자동 갱신 (켜짐|꺼짐)|초마다|자동 꺼짐|되면 확인|돌아오면 확인/.test(own);
        })
        .map((node) => `${node.className || node.tagName}: ${(node.textContent ?? '').trim().slice(0, 40)}`);
      return {
        cluster: document.querySelectorAll(`.int30-refresh ${liveSelector.split(', ').join(', .int30-refresh ')}`).length,
        hint: document.querySelectorAll('.refresh-hint').length,
        speaking,
        stating,
      };
    });
    expect(report.cluster, '갱신 덩어리 안에 낭독 지점이 둘 이상이다').toBe(1);
    expect(report.hint, '`명함 기록` 옆 갱신 줄이 되살아났다 — 상단 덩어리가 이미 같은 말을 한다').toBe(0);
    expect(report.speaking.length, `갱신 사실을 말하는 live region이 여럿이다: ${report.speaking.join(' / ')}`)
      .toBeLessThanOrEqual(1);
    /* 박자·켜짐 상태를 말하는 자리는 상단 덩어리 안의 두 곳뿐이다: 짧은 신선도 줄과, 그 뜻을
       풀어 주는 전문(`aria-describedby`로만 닿는다). 그 밖에 하나라도 생기면 두 번째 표면이다. */
    expect(report.stating.length, `갱신 박자를 말하는 표면이 여럿이다: ${report.stating.join(' / ')}`)
      .toBeLessThanOrEqual(2);
    for (const surface of report.stating) {
      expect(surface, `갱신 사실이 상단 갱신 덩어리 밖에서 나온다: ${surface}`).toMatch(/int30-refresh/);
    }
  } finally {
    await stopServer(harness.server);
  }
});

/* 이 검사는 두 줄이 진행을 겹쳐 말하지 않는지를 봤다. 두 번째 줄이 없어졌으므로(INT-000036)
   같은 뜻을 **남은 표면들** 위에서 다시 잰다 — 그리고 한 겹 더 조인다: 예전에는 신선도 줄이
   진행 중에 `갱신 중`으로 바뀌었고, 그것이 버튼의 `aria-busy`와 함께 진행을 말하는 두 번째
   자리였다. 이제 진행의 주인은 버튼 하나뿐이고, 신선도 줄은 요청이 떠 있는 동안에도 박자와
   마지막 성공을 그대로 말한다 — 마지막으로 받은 시점은 요청 중에도 여전히 참이다. */
test('요청이 떠 있는 동안 진행을 말하는 것은 버튼뿐이고, 신선도 줄은 박자를 그대로 유지한다', async ({ page }) => {
  const harness = await boot(page, { active: false });
  try {
    await expect(refreshLine(page)).toContainText('20초마다');
    /* 2.5초 창 안에 폴링 두 개와 아래의 무거운 DOM 훑기가 모두 들어가야 했다. 창이 먼저 닫히면
       신선도 줄이 이미 `방금 업데이트`로 바뀌어, 제품이 아니라 시점 때문에 빨개진다.
       놓을 때까지 붙잡아 재는 내내 요청이 떠 있게 한다. */
    harness.holdList(true);
    await refreshNow(page).click();

    // 진행의 주인: 누른 버튼 하나. 회전도 여기에만 있다.
    await expect(refreshNow(page)).toHaveAttribute('aria-busy', 'true');
    await expect(refreshNow(page).locator('.int30-refresh-spin')).toHaveCount(1);

    const line = ((await refreshLine(page).textContent()) ?? '').trim();
    expect(line, `신선도 줄까지 진행을 겹쳐 말한다: ${line}`).not.toMatch(/갱신 중|방금 업데이트|갱신 실패/);
    expect(line, `요청이 떠 있다고 박자를 놓쳤다: ${line}`).toContain('20초마다');

    // 진행 문구를 말하는 표면이 화면 어디에도 없다 — 색으로도 말하지 않는다.
    const during = await page.evaluate(() => ({
      busyText: Array.from(document.querySelectorAll<HTMLElement>('body *'))
        .filter((node) => Array.from(node.childNodes).some((child) => child.nodeType === 3 && /갱신 중|새로고침 중/.test(child.textContent ?? '')))
        .map((node) => node.className || node.tagName),
      lineClass: document.querySelector('.int30-refresh-line')?.className ?? '',
    }));
    expect(during.busyText, `진행 문구를 말하는 표면이 남아 있다: ${during.busyText.join(' / ')}`).toEqual([]);
    expect(during.lineClass, '신선도 줄이 진행 중 강조를 들고 있다 — 그것도 진행을 말하는 두 번째 자리다')
      .not.toContain('is-busy');
    // 위를 재는 내내 요청이 떠 있었다.
    expect(harness.listInFlight, '읽는 사이에 요청이 이미 끝났다 — 관측 창이 너무 좁다').toBeGreaterThan(0);
  } finally {
    harness.holdList(false);
    await stopServer(harness.server);
  }
});

test('상단 조작은 K 표식과 같은 광학 중심에 서고, 보이는 크기와 무관하게 44px로 눌린다', async ({ page }) => {
  const harness = await boot(page, { active: false });
  try {
    await expect(autoSwitch(page)).toBeVisible();
    const geometry = await page.evaluate(measureRefreshReach);
    const { auto, now, row, brand, copy } = geometry;
    expect(auto && now && row && brand && copy, '상단 바 요소를 다 찾지 못했다').toBeTruthy();
    console.log(`[상단 균형] row=${row!.height}px(center ${row!.center}) brand=${brand!.height}px(center ${brand!.center}) copy=${copy!.height}px / hit auto=${auto!.band}px now=${now!.band}px`);

    // 1. 광학 중심. 갱신 조작 줄과 K 표식이 같은 높이에 선다.
    expect(Math.abs(row!.center - brand!.center), `갱신 조작 줄이 K 표식보다 ${Math.round(Math.abs(row!.center - brand!.center))}px 어긋난 높이에 있다`)
      .toBeLessThanOrEqual(1.5);

    // 2. 두께. 상단 바에서 **가장 두꺼운 것이 갱신 조작이면 안 된다** — 그러면 보조 조작이
    //    아니라 독립된 카드로 읽힌다 (founder: "명함 캡처 요 블록 두께랑 잘 안 맞는 것 같아").
    expect(row!.height, `갱신 조작(${row!.height}px)이 K 표식(${brand!.height}px)보다 두껍다`)
      .toBeLessThanOrEqual(brand!.height);
    expect(row!.height, `갱신 조작(${row!.height}px)이 화면 이름 블록(${copy!.height}px)보다 두껍다`)
      .toBeLessThanOrEqual(copy!.height + 0.5);

    // 3. 얇아진 chrome이 손가락을 잃지 않는다. 재는 것은 그림이 아니라 hit area다.
    expect(auto!.band, `자동 갱신 스위치의 누를 수 있는 높이가 ${auto!.band}px다 (보이는 높이 ${auto!.height}px)`)
      .toBeGreaterThanOrEqual(44);
    expect(now!.band, `새로고침 버튼의 누를 수 있는 높이가 ${now!.band}px다 (보이는 높이 ${now!.height}px)`)
      .toBeGreaterThanOrEqual(44);

    // 4. 두 조작이 같은 토큰 체계를 쓴다. 모서리는 선언된 계단 위의 값이어야 한다.
    const chrome = await page.evaluate(() => {
      const read = (selector: string) => {
        const style = getComputedStyle(document.querySelector(selector)!);
        return { radius: style.borderTopLeftRadius, border: style.borderTopWidth, height: style.height };
      };
      const root = getComputedStyle(document.documentElement);
      return {
        auto: read('.int30-refresh-switch'),
        now: read('.int30-refresh-now'),
        scale: ['--cc-r-xl', '--cc-r-lg', '--cc-r-md', '--cc-r-sm'].map((name) => root.getPropertyValue(name).trim()),
      };
    });
    expect(chrome.auto.height, '스위치와 새로고침 버튼의 높이가 다르다').toBe(chrome.now.height);
    expect(chrome.auto.radius, '스위치와 새로고침 버튼의 모서리가 다르다').toBe(chrome.now.radius);
    expect(chrome.auto.border, '스위치와 새로고침 버튼의 테두리 두께가 다르다').toBe(chrome.now.border);
    expect(chrome.scale, `모서리 계단이 비어 있다: ${chrome.scale.join(', ')}`).toContain(chrome.auto.radius);
  } finally {
    await stopServer(harness.server);
  }
});

test('다크에서도 켜짐·꺼짐이 색 하나에만 기대지 않는다', async ({ page }) => {
  const harness = await boot(page, { active: false, theme: 'dark' });
  try {
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const read = () => page.evaluate(() => {
      const knob = document.querySelector('.int30-refresh-track i');
      const track = document.querySelector('.int30-refresh-track');
      return {
        knob: knob ? getComputedStyle(knob).transform : '',
        knobColor: knob ? getComputedStyle(knob).backgroundColor : '',
        trackColor: track ? getComputedStyle(track).backgroundColor : '',
      };
    });

    await expect(autoSwitch(page)).toHaveAttribute('aria-checked', 'true');
    /* 손잡이 이동에는 160ms transition이 걸려 있다. 그 사이에 읽으면 두 상태가 같은 값으로
       보이고, 게이트가 통과·실패를 **엉뚱한 이유로** 판정한다. 350ms를 세는 대신 전환이
       실제로 끝난 것을 보고 읽는다 — 시계가 아니라 상태다. */
    await settleKnob(page);
    const on = await read();
    await autoSwitch(page).click();
    await expect(autoSwitch(page)).toHaveAttribute('aria-checked', 'false');
    await settleKnob(page);
    const off = await read();

    // 색이 아닌 축이 반드시 하나 이상 달라야 한다 — 손잡이 **위치**가 그 축이다.
    expect(on.knob, `켜짐·꺼짐이 손잡이 위치로 구별되지 않는다 (${on.knob} / ${off.knob})`).not.toBe(off.knob);
    expect(on.knob, '손잡이가 아예 움직이지 않는다').not.toBe('none');
  } finally {
    await stopServer(harness.server);
  }
});

test('연타는 요청을 겹쳐 만들지 않으면서도 무시당한 티를 내지 않는다', async ({ page }) => {
  const harness = await boot(page, { active: false });
  try {
    await expect(refreshLine(page)).toContainText('20초마다');
    harness.holdList(true);
    const before = harness.listRequests;

    /* 누름 표시(`data-press-count`)의 수명은 제품이 정한 600ms다. 그 안에 `toHaveAttribute`
       왕복과 `getComputedStyle` 왕복이 **둘 다** 들어가야 했고, 바쁜 기계에서는 들어가지
       않는다. 그래서 표시를 밖에서 찍지 않고, 페이지 안에서 매 프레임 지켜본다 —
       판정 기준(누름 수 2 · 자국이 `none`이 아님)은 그대로고, 놓치는 일만 없어진다. */
    await refreshNow(page).evaluate((node) => {
      const seen: Array<{ count: string; shadow: string }> = [];
      (window as unknown as { __pressAck: typeof seen }).__pressAck = seen;
      const stopAt = performance.now() + 15_000;
      const tick = () => {
        const count = node.getAttribute('data-press-count') ?? '';
        if (count) seen.push({ count, shadow: getComputedStyle(node).boxShadow });
        if (performance.now() < stopAt) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const pressAck = () => page.evaluate(() => (window as unknown as { __pressAck: Array<{ count: string; shadow: string }> })
      .__pressAck.filter((sample) => sample.count === '2'));

    await refreshNow(page).click();
    await expect(refreshNow(page)).toHaveAttribute('aria-busy', 'true');
    await refreshNow(page).click();
    // 두 번째 누름이 화면에서 사라지지 않는다: 버튼이 누름을 세어 되돌려 주고,
    // 그 표시가 눈에 보이는 값(테두리 발광)으로도 나타난다.
    await expect
      .poll(pressAck, { timeout: 8_000, message: '두 번째 누름을 버튼이 세지 않았다' })
      .not.toEqual([]);
    const acked = await pressAck();
    const marks = [...new Set(acked.map((sample) => sample.shadow))];
    expect(
      marks.some((shadow) => shadow !== 'none'),
      `두 번째 누름이 아무 자국도 남기지 않는다 (누름 수 2인 ${acked.length}개 프레임에서 본 그림자: ${marks.join(' / ')})`,
    ).toBe(true);

    await expect.poll(() => harness.listInFlight, { timeout: 8_000 }).toBe(1);
    expect(harness.maxListInFlight, '연타가 요청을 겹쳐 만들었다').toBe(1);

    // 놓는다. 두 번째 누름의 후속 조회까지 끝난 뒤에 겹침과 효과를 판정한다.
    harness.holdList(false);
    await expect.poll(() => harness.listRequests, { timeout: 10_000 }).toBeGreaterThanOrEqual(before + 2);
    await expect.poll(() => harness.listInFlight, { timeout: 10_000 }).toBe(0);
    expect(harness.maxListInFlight, '연타가 요청을 겹쳐 만들었다').toBe(1);
    // 그러면서도 두 번째 누름은 **실제 효과가 있다** — 떠 있던 조회 직후 한 번 더 읽는다.
    expect(harness.listRequests, '두 번째 누름이 아무 일도 하지 않았다').toBeGreaterThanOrEqual(before + 2);
  } finally {
    harness.holdList(false);
    await stopServer(harness.server);
  }
});

test('화면이 가려진 동안에는 가져오지 않고, 돌아오면 한 줄이 그동안의 신선도를 말한다', async ({ page }) => {
  const harness = await boot(page, { active: true });
  try {
    await expect(refreshLine(page)).toContainText('4초마다', { timeout: 8_000 });
    const setHidden = (hidden: boolean) => page.evaluate((value) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (value ? 'hidden' : 'visible') });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);

    await setHidden(true);
    const hiddenAt = harness.listRequests;
    // 빠른 박자(4초)의 세 배를 기다린다. 가려진 화면을 위해 한 건도 가져오면 안 된다.
    await page.waitForTimeout(12_500);
    expect(harness.listRequests, '가려진 화면을 위해 계속 가져오고 있다').toBe(hiddenAt);
    // 그 사실을 화면이 감추지 않는다 — 신선도가 실제로 낡았다고 말한다.
    const stale = ((await refreshLine(page).textContent()) ?? '').trim();
    expect(stale, `가려진 동안 신선도가 멈춰 있다: ${stale}`).toMatch(/\d+초 전|\d+분 전/);

    await setHidden(false);
    await expect.poll(() => harness.listRequests, { timeout: 8_000 }).toBeGreaterThan(hiddenAt);
    await expect(refreshLine(page)).toContainText(/방금/, { timeout: 8_000 });
  } finally {
    await stopServer(harness.server);
  }
});
