// 회귀 게이트: 기다리는 자리마다 화면이 **지금 실제로 일어나는 일만** 말하는가.
// Kairen-Ref: TSK-000305
//
// founder 실기기 판정 2026-07-27:
//   "명함 기록: '전송 중...'이 아님에도 이렇게 표기되는 것 이상함"
//   "모든 기다려야 하는 것들에 대해 사용자가 '되는 것인가?'라는 의문을 품지 않도록 해줬으면 함"
//
// 이 파일이 잠그는 것은 두 종류다.
//   (결함) UX-1 전송 진행 표시가 전역 boolean 하나라 보낼 것이 없어도 켜졌다 — FI-034 위반
//          ("unknown을 progress로 보여 주지 않는다").
//   (결함) UX-2 상단 상태 문구의 숫자가 로컬 미전송과 서버 비종료를 한 숫자로 합산했다.
//   (추가) 버전 표기 · 빠른 검색 진행 · 저장/재시도 대기 표시 · 다크 보라 · AI 표면 테두리 발광.
//
// 게이트 전제에 대한 자기 점검:
//   - "보이지 않는다"만 재는 단언은 표면이 통째로 사라져도 통과한다. 그래서 부정 단언에는
//     그 순간 정말로 그 구간에 있었다는 양성 증거를 함께 요구한다. 그 증거는 **화면 글자가 아니라
//     서버 쪽 사실**(응답을 붙들고 있는 요청 수)로 잡는다 — 문구를 증거로 쓰면 그 문구가 바뀌는 순간
//     게이트가 전제부터 무너져 무엇을 재려던 것인지 알 수 없게 된다(회귀 주입에서 실제로 그렇게 됐다).
//   - 20초 기본 주기를 기다리지 않는다. active cadence 또는 흔들리지 않는 즉시 trigger(`online`)를 쓴다.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const buildRoot = resolve(fileURLToPath(new URL('../../docs/', import.meta.url)));
const packageJsonPath = resolve(fileURLToPath(new URL('../package.json', import.meta.url)));

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

/** 서버 목록. `processed` 하나 + 아직 끝나지 않은 `received` 하나. */
function listFixture(extra: Array<Record<string, unknown>> = []) {
  return {
    ok: true,
    seeAll: true,
    researchInstructionEnabled: true,
    hasMore: false,
    items: [
      {
        captureId: '20260720-090000-s1', receivedAt: ago(3 * 24 * 60), status: 'processed', person: 'PER-000901', capturer: '이강규', event: '합성 전시회',
        contact: { name: '합성인물-하나', title: '팀장', organization: '합성상사' },
        brief: '# 합성인물-하나 — 이런 분이에요\n합성 데이터입니다.',
      },
      { captureId: '20260726-100000-s2', receivedAt: ago(9), status: 'received' },
      ...extra,
    ],
  };
}

/** 아직 이 기기에만 있는 촬영 한 장 (합성). 서버 목록에는 없는 captureId다. */
function localCapture(captureId: string, state: 'queued' | 'failed') {
  return {
    captureId,
    capturedAt: ago(4),
    event: '합성 전시회',
    relSelf: '', relKairen: '', memo: '', note: '', disp: '',
    images: [{ name: 'front.jpg', mime: 'image/jpeg', dataB64: 'AAAA' }],
    quickName: { name: '합성인물-대기', source: 'device_ppocr', confidence: 70, confirmed: false, recognizedAt: ago(4) },
    state,
    tries: state === 'failed' ? 1 : 0,
    ...(state === 'failed' ? { err: 'synthetic_rejected', errKind: 'rejected' } : {}),
  };
}

interface Harness {
  server: Server;
  /** 다음 `list` 응답을 이만큼 늦춘다. 0이면 즉시. */
  delayList: (ms: number) => void;
  /** 다음 업로드 POST를 이만큼 늦춘다. */
  delayUpload: (ms: number) => void;
  /** 다음 `search` 응답을 이만큼 늦춘다. */
  delaySearch: (ms: number) => void;
  /** 지금 서버가 붙들고 있는 `list` 요청 수. "앱이 갱신 주기 안에 있다"의 진실값이다. */
  readonly listInFlight: number;
  /** 이 세션에서 시작한 list 요청 수와 최대 동시 요청 수. */
  readonly listRequests: number;
  readonly listStartedAt: number[];
  readonly maxListInFlight: number;
  setListResponse: (response: ReturnType<typeof listFixture>) => void;
  snapshotListOnRequest: (enabled: boolean) => void;
  uploads: string[];
}

async function boot(page: Page, options: {
  theme?: string;
  seed?: ReturnType<typeof localCapture>;
  /** 첫 flush부터 업로드를 거절한다 — 씨앗 촬영이 계속 미전송으로 남아야 하는 시나리오용. */
  rejectUploads?: boolean;
  listResponse?: ReturnType<typeof listFixture>;
} = {}): Promise<Harness> {
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');

  const state = {
    list: 0,
    upload: 0,
    search: 0,
    inFlight: 0,
    maxInFlight: 0,
    listRequests: 0,
    listStartedAt: [] as number[],
    snapshotListAtRequest: false,
    listResponse: options.listResponse ?? listFixture(),
    reject: options.rejectUploads === true,
  };
  const uploads: string[] = [];
  const wait = (ms: number) => (ms > 0 ? new Promise((done) => setTimeout(done, ms)) : Promise.resolve());

  await page.context().route('**/vendor/**', (route) => route.abort());
  await page.route('https://api.example.test/**', async (route) => {
    const request = route.request();
    const action = new URL(request.url()).searchParams.get('action');
    const body = request.postData() ?? '';

    if (action === 'list') {
      // 실제 서버처럼 요청이 시작된 시점의 snapshot을 고정할 수 있어야 mutation/refresh 경합을 재현한다.
      const responseAtStart = state.snapshotListAtRequest ? structuredClone(state.listResponse) : null;
      state.inFlight += 1;
      state.listRequests += 1;
      state.listStartedAt.push(Date.now());
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        await wait(state.list);
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(responseAtStart ?? state.listResponse) });
      } finally {
        state.inFlight -= 1;
      }
      return;
    }
    if (request.method() === 'POST' && body.includes('"images"')) {
      uploads.push(String(/"captureId":"([^"]+)"/.exec(body)?.[1] ?? ''));
      await wait(state.upload);
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify(state.reject ? { ok: false, error: 'synthetic_rejected' } : { ok: true }),
      });
      return;
    }
    if (action === 'search') {
      await wait(state.search);
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, items: [{ id: 'PER-000901', title: 'PER-000901 합성인물-하나', via: 'title' }] }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.addInitScript((value) => {
    localStorage.setItem('cc_name', '이강규');
    if (value) localStorage.setItem('cc_theme', value);
  }, options.theme);

  // 기기에만 있는 촬영은 앱이 부팅해 읽기 전에 저장소에 있어야 한다.
  if (options.seed) {
    await page.addInitScript((item) => {
      const open = indexedDB.open('cardcapture', 1);
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains('q')) open.result.createObjectStore('q', { keyPath: 'captureId' });
      };
      open.onsuccess = () => {
        const database = open.result;
        database.transaction('q', 'readwrite').objectStore('q').put(item);
      };
    }, options.seed);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  const api = encodeURIComponent('https://api.example.test/exec');
  await page.goto(`http://127.0.0.1:${address.port}/next/?api=${api}&k=owner-token`, { waitUntil: 'networkidle' });
  return {
    server,
    uploads,
    get listInFlight() { return state.inFlight; },
    get listRequests() { return state.listRequests; },
    get listStartedAt() { return [...state.listStartedAt]; },
    get maxListInFlight() { return state.maxInFlight; },
    setListResponse: (response) => { state.listResponse = response; },
    snapshotListOnRequest: (enabled) => { state.snapshotListAtRequest = enabled; },
    delayList: (ms) => { state.list = ms; },
    delayUpload: (ms) => { state.upload = ms; },
    delaySearch: (ms) => { state.search = ms; },
  };
}

/** 브라우저가 다시 온라인이 된 순간. 자동 주기를 기다리지 않는 즉시 트리거다. */
async function goOnline(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
}

const headerStatus = (page: Page): Locator => page.locator('ion-header .app-header small');

/**
 * 지금 화면이 "전송 중"이라고 말하고 있는 자리들.
 *
 * 왜 한 번에 읽는가: `expect(locator).toHaveCount(0)`은 재시도 단언이라 "지금 없다"가 아니라
 * "언젠가 없어진다"를 잰다. 2.5초 동안 거짓 표시가 떠 있다가 사라져도 그 단언은 통과한다 —
 * 이 게이트를 처음 썼을 때 실제로 결함이 있는 채로 PASS했다.
 */
function sendingClaims(page: Page): Promise<string[]> {
  return page.evaluate(() => Array.from(document.querySelectorAll('.sending-note, .row-sending'))
    .map((node) => node.textContent ?? ''));
}

// ── UX-1: 전송 진행은 "지금 어느 captureId를 보내는 중인가"여야 한다 (결함) ──

test('보낼 것이 하나도 없는 전송 주기에는 어디에도 전송 중이라고 쓰지 않는다', async ({ page }) => {
  // 대기열이 비어 있는 기기. `flushQueue`는 보낼 항목을 하나도 찾지 못하고 곧바로 끝난다.
  const harness = await boot(page);
  try {
    await expect(page.locator('.section-toggle', { hasText: '명함 기록' })).toBeVisible();
    expect(harness.uploads, '이 시나리오에는 보낼 촬영이 없어야 한다').toEqual([]);

    // 전송 주기를 연다. 목록 갱신을 늦춰 그 주기가 실제로 열려 있는 동안을 관측한다.
    harness.delayList(4_000);
    await goOnline(page);

    // 양성 증거는 **화면 글자가 아니라 서버 쪽 사실**로 잡는다. 화면 문구를 증거로 쓰면
    // 그 문구가 바뀌는 순간 게이트가 전제부터 무너져 무엇을 재려던 것인지 알 수 없게 된다.
    await expect.poll(() => harness.listInFlight, {
      message: '전송 주기가 시작되지 않았다 — 이 게이트가 아무것도 재지 못했다',
      timeout: 8_000,
    }).toBeGreaterThan(0);

    const claims = await sendingClaims(page);
    expect(harness.listInFlight, '읽는 사이에 전송 주기가 이미 끝났다 — 관측 창이 너무 좁다').toBeGreaterThan(0);
    expect(claims, `보낼 것이 하나도 없는데 화면이 전송 중이라고 말한다: ${JSON.stringify(claims)}`).toEqual([]);
    expect(harness.uploads, '이 구간에 업로드가 일어나면 시나리오 전제가 깨진 것이다').toEqual([]);
  } finally {
    await stopServer(harness.server);
  }
});

test('실제로 보내는 동안에는 어느 명함을 보내는 중인지 그 행에 보인다', async ({ page }) => {
  // 서버가 계속 거절하므로 씨앗 촬영은 미전송으로 남고, 매 flush마다 실제로 다시 올라간다.
  const harness = await boot(page, { seed: localCapture('20260727-113000-q1', 'queued'), rejectUploads: true });
  try {
    const row = page.locator('.queue-row', { hasText: '합성인물-대기' });
    await expect(row).toBeVisible();
    expect(harness.uploads.length, '부팅 flush가 이 촬영을 실제로 올렸어야 한다').toBeGreaterThan(0);

    // 이번 전송은 늦게 끝난다 — 그 사이가 사용자가 "되는 건가?" 하고 보는 구간이다.
    harness.delayUpload(2_500);
    await goOnline(page);

    // 지금 보내는 그 캡처의 행이 스스로 말한다.
    await expect(row.locator('.row-sending')).toBeVisible();
    // 구획 라벨도 어느 명함인지 말한다 — 익명의 "전송 중…"이 아니다.
    await expect(page.locator('.sending-note')).toHaveText(/합성인물-대기/);
  } finally {
    await stopServer(harness.server);
  }
});

// ── UX-2: 서로 다른 두 진실을 한 숫자로 합산하지 않는다 (결함) ──

test('상단 상태는 전송 대기와 서버 처리 중을 각각 말한다', async ({ page }) => {
  // 기기에 미전송 1건(서버가 거절해 계속 남는다) + 서버에 비종료 1건.
  const harness = await boot(page, { seed: localCapture('20260727-114500-q2', 'failed'), rejectUploads: true });
  try {
    await expect(page.locator('.queue-row', { hasText: '합성인물-대기' })).toBeVisible();
    // 전제 확인: 정말로 "기기 미전송 1건"과 "서버 비종료 1건"이 동시에 존재하는 상태인가.
    await expect(page.getByRole('button', { name: '다시 보내기' })).toBeVisible();
    await expect(page.locator('.brief-card')).toHaveCount(2);

    const text = await headerStatus(page).textContent();
    // 두 진실이 각각 이름을 갖는다. 합산한 숫자 하나로 말하면 그 숫자가 무엇인지 알 수 없다.
    expect(text, `상단 상태 실측: ${text}`).toMatch(/전송 대기 1건/);
    expect(text, `상단 상태 실측: ${text}`).toMatch(/1건 처리 중/);
    expect(text, `합산한 숫자 하나로 말하고 있다: ${text}`).not.toMatch(/(^|[^\d])2건 처리 중/);
  } finally {
    await stopServer(harness.server);
  }
});

// ── UX-2b: 사용자가 기다리는 카드만 빠르게 보고, 끝나면 다시 조용해진다 ──

test('명함과 조사 카드가 끝날 때까지만 빠르게 갱신하고 terminal 뒤 기본 주기로 돌아간다', async ({ page }) => {
  const research = {
    captureId: '20260730-100000-research',
    receivedAt: ago(2),
    status: 'received',
    type: 'research_instruction',
    targetPerson: 'PER-000901',
  };
  const active = listFixture([research]);
  const terminal = {
    ...active,
    items: active.items.map((item) => ({
      ...item,
      status: 'processed',
      brief: item.brief ?? '# 합성 처리 완료\n합성 상태 전이입니다.',
    })),
  };
  const harness = await boot(page, { listResponse: active });
  try {
    await expect(headerStatus(page)).toContainText('2건 처리 중');
    const before = harness.listRequests;
    const startedAt = Date.now();
    harness.setListResponse(terminal);

    // 기존 20초를 기다리지 않고 active cadence 안에 두 카드를 한 batch로 terminal 반영한다.
    await expect(headerStatus(page)).toContainText('기록 3건', { timeout: 7_000 });
    await expect(headerStatus(page)).not.toContainText('처리 중');
    const activeRequestStartedAt = harness.listStartedAt.slice(before)[0];
    expect(activeRequestStartedAt, 'active cadence의 list 요청이 시작되지 않았다').toBeDefined();
    expect(activeRequestStartedAt - startedAt, 'active list 요청 시작이 5초 경계를 넘었다').toBeLessThanOrEqual(5_000);
    expect(harness.listRequests).toBeGreaterThan(before);

    // terminal 전환 즉시 빠른 cadence가 멈춘다. 20초 기본 주기 전에는 새 요청이 없어야 한다.
    const stoppedAt = harness.listRequests;
    await page.waitForTimeout(5_500);
    expect(harness.listRequests).toBe(stoppedAt);
  } finally {
    await stopServer(harness.server);
  }
});

test('자동·수동·online 갱신이 겹쳐도 list 요청은 하나만 실행한다', async ({ page }) => {
  const active = listFixture();
  const terminal = {
    ...active,
    items: active.items.map((item) => ({ ...item, status: 'processed', brief: item.brief ?? '# 합성 처리 완료' })),
  };
  const harness = await boot(page, { listResponse: active });
  try {
    await expect(headerStatus(page)).toContainText('1건 처리 중');
    harness.setListResponse(terminal);
    harness.delayList(5_500);

    await goOnline(page);
    await expect.poll(() => harness.listInFlight, { timeout: 3_000 }).toBe(1);
    await page.getByRole('button', { name: '최신 상태 확인' }).click();
    await goOnline(page);
    // 이 사이 active 4초 tick도 한 번 온다. 모두 같은 in-flight promise를 공유해야 한다.
    await page.waitForTimeout(4_500);
    expect(harness.maxListInFlight).toBe(1);
    // 첫 느린 요청 뒤 예약된 최신 조회는 정상 속도로 응답한다.
    harness.delayList(0);
    await expect(headerStatus(page)).toContainText('기록 2건', { timeout: 3_000 });
    await expect(headerStatus(page)).not.toContainText('처리 중');
  } finally {
    await stopServer(harness.server);
  }
});

test('작업 전 조회와 수동 확인이 겹치면 직후 한 번 더 읽어 새 카드를 놓치지 않는다', async ({ page }) => {
  const initial = listFixture();
  initial.items = initial.items.map((item) => ({ ...item, status: 'processed', brief: item.brief ?? '# 합성 처리 완료' }));
  const newReceipt = {
    captureId: '20260730-110000-new',
    receivedAt: ago(0),
    status: 'received',
    type: 'research_instruction',
    targetPerson: 'PER-000901',
  };
  const harness = await boot(page, { listResponse: initial });
  try {
    await expect(headerStatus(page)).toContainText('기록 2건');
    harness.snapshotListOnRequest(true);
    harness.delayList(1_500);
    const before = harness.listRequests;
    await page.getByRole('button', { name: '최신 상태 확인' }).click();
    await expect.poll(() => harness.listInFlight).toBe(1);

    // 첫 요청이 시작된 뒤 서버에 새 receipt가 생긴다. 이때 누른 확인은 오래된 응답을 최신으로
    // 오인하지 않고, 현재 요청 직후의 trailing 조회까지 기다려야 한다.
    harness.setListResponse({ ...initial, items: [...initial.items, newReceipt] });
    await page.getByRole('button', { name: '최신 상태 확인' }).click();
    await expect(headerStatus(page)).toContainText('1건 처리 중', { timeout: 5_000 });
    expect(harness.listRequests).toBeGreaterThanOrEqual(before + 2);
    expect(harness.maxListInFlight).toBe(1);
  } finally {
    await stopServer(harness.server);
  }
});

test('연결 해제 뒤 늦게 도착한 이전 토큰 응답은 화면과 캐시를 되살리지 않는다', async ({ page }) => {
  const harness = await boot(page);
  try {
    await expect(headerStatus(page)).toContainText('1건 처리 중');
    harness.snapshotListOnRequest(true);
    harness.delayList(1_500);
    await goOnline(page);
    await expect.poll(() => harness.listInFlight).toBe(1);

    await page.getByRole('navigation', { name: '주요 화면' }).getByRole('button', { name: '설정' }).click();
    await page.getByRole('button', { name: '연결 해제', exact: true }).click();
    await page.getByRole('button', { name: '연결 해제하기' }).click();
    await expect.poll(() => harness.listInFlight, { timeout: 4_000 }).toBe(0);
    await expect(headerStatus(page)).toContainText('연결 필요');
    expect(await page.evaluate(() => Object.values(localStorage).map(String).join('\n'))).not.toContain('20260720-090000-s1');

    // 연결 해제 뒤 뜨는 이름 온보딩을 마친 뒤에도 이전 계정 카드가 화면에 없어야 한다.
    await page.getByRole('textbox', { name: '이름', exact: true }).fill('합성 검증자');
    await page.locator('ion-modal.name-onboard-modal ion-button').evaluate((button: HTMLElement) => button.click());
    await expect(page.locator('ion-modal.name-onboard-modal')).not.toHaveClass(/show-modal/);
    await page.getByRole('navigation', { name: '주요 화면' }).getByRole('button', { name: '진행' }).click();
    await expect(page.locator('.brief-card')).toHaveCount(0);
  } finally {
    await stopServer(harness.server);
  }
});

test('앱이 숨겨진 동안에는 active 빠른 갱신을 멈추고 돌아오면 즉시 확인한다', async ({ page }) => {
  const harness = await boot(page);
  try {
    await expect(headerStatus(page)).toContainText('1건 처리 중');
    await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, value: true }));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const hiddenAt = harness.listRequests;
    await page.waitForTimeout(4_500);
    expect(harness.listRequests).toBe(hiddenAt);

    await page.evaluate(() => {
      Reflect.deleteProperty(document, 'hidden');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => harness.listRequests).toBeGreaterThan(hiddenAt);
  } finally {
    await stopServer(harness.server);
  }
});

// ── UX-3: 설정에 릴리즈 버전과 소스 식별자가 함께 보인다 ──

test('설정이 사람이 말할 수 있는 버전과 대조할 수 있는 소스 식별자를 함께 보여 준다', async ({ page }) => {
  const declared = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { version: string };
  const harness = await boot(page);
  try {
    await page.getByRole('button', { name: '설정', exact: true }).click();
    const line = page.locator('.build-line');
    await expect(line).toBeVisible();
    // 버전은 저장소가 선언한 값 그대로여야 한다 — 화면에만 있는 두 번째 진실을 만들지 않는다.
    await expect(line).toContainText(`버전 ${declared.version}`);
    // 소스 식별자는 그대로 남는다. 버전은 말하기 위한 것이고, 이 값은 대조하기 위한 것이다.
    await expect(line).toContainText(/빌드 src-[0-9a-f]{12}/);
  } finally {
    await stopServer(harness.server);
  }
});

// ── UX-4: 빠른 검색도 되고 있다는 것이 보인다 ──

test('빠른 검색은 찾는 동안 결과 자리에 진행을 보여 주고, 가짜 진행률을 만들지 않는다', async ({ page }) => {
  const harness = await boot(page);
  try {
    await page.getByRole('button', { name: '검색', exact: true }).click();
    harness.delaySearch(2_500);
    await page.getByRole('textbox', { name: '이름·회사·만난 곳으로 검색' }).fill('합성');
    await page.locator('form.search-shell').getByRole('button', { name: '찾기', exact: true }).click();

    const progress = page.locator('.search-progress');
    await expect(progress).toBeVisible();
    await expect(progress).toContainText('합성');
    // 남은 시간·진행률을 지어내지 않는다. 아는 것(경과 시간)만 센다.
    await expect(progress).toContainText(/경과/);
    await expect(progress).not.toContainText('%');

    // 결과가 오면 진행 표시는 사라진다 — 끝난 일을 진행으로 남겨 두지 않는다.
    await expect(page.locator('.person-row')).toHaveCount(1);
    await expect(progress).toHaveCount(0);
  } finally {
    await stopServer(harness.server);
  }
});

// ── UX-5: 기다리게 하는 동작에는 예외 없이 진행 표시가 붙는다 ──

test('다시 처리 요청은 누른 순간부터 접수될 때까지 그 사실을 말한다', async ({ page }) => {
  // 지연 구간(평소 20분 + 10분 초과)에 들어간 캡처라야 `다시 처리 요청`이 나온다.
  const harness = await boot(page);
  try {
    await page.route('https://api.example.test/**', async (route) => {
      const request = route.request();
      const action = new URL(request.url()).searchParams.get('action');
      const body = request.postData() ?? '';
      if (action === 'list') {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ ok: true, seeAll: true, hasMore: false, items: [{ captureId: '20260727-020000-l1', receivedAt: ago(120), status: 'received' }] }),
        });
        return;
      }
      if (body.includes('"requeue"')) {
        await new Promise((done) => setTimeout(done, 2_000));
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await page.getByRole('button', { name: '최신 상태 확인' }).click();

    const button = page.getByRole('button', { name: /다시 처리 요청/ });
    await expect(button).toBeVisible();
    await button.click();
    // 누른 뒤 아무 반응도 없는 구간이 있으면 안 된다.
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await expect(button).toBeDisabled();
    await expect(button).toHaveText(/요청하는 중/);
  } finally {
    await stopServer(harness.server);
  }
});

// ── UX-6: 다크는 보라 중심 ──

/** 계산된 색을 HSL의 색상각으로. 앱 공식이 아니라 표준 변환을 여기서 다시 쓴다. */
const HUE_PROBE = `(() => {
  const parse = (value) => {
    const match = value.match(/rgba?\\(([^)]+)\\)/);
    if (!match) return null;
    const parts = match[1].split(/[,\\s/]+/).filter(Boolean).map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const hue = (color) => {
    const r = color.r / 255, g = color.g / 255, b = color.b / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), span = max - min;
    if (span === 0) return null;
    let h;
    if (max === r) h = ((g - b) / span) % 6;
    else if (max === g) h = (b - r) / span + 2;
    else h = (r - g) / span + 4;
    h = Math.round(h * 60);
    return h < 0 ? h + 360 : h;
  };
  const style = getComputedStyle(document.documentElement);
  const read = (name) => {
    const raw = style.getPropertyValue(name).trim();
    const probe = document.createElement('span');
    probe.style.color = raw;
    document.body.appendChild(probe);
    const computed = getComputedStyle(probe).color;
    probe.remove();
    const color = parse(computed);
    return color ? { name, css: raw, hue: hue(color) } : { name, css: raw, hue: null };
  };
  return ['--cc-blue', '--cc-blue-ink', '--ion-color-primary', '--cc-ai-glow'].map(read);
})()`;

test('다크 강조색이 파랑이 아니라 보라 계열이다', async ({ page }) => {
  const harness = await boot(page, { theme: 'dark' });
  try {
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const probes = await page.evaluate(HUE_PROBE) as Array<{ name: string; css: string; hue: number | null }>;
    for (const probe of probes) {
      expect(probe.hue, `${probe.name}(${probe.css})의 색상각을 읽지 못했다`).not.toBeNull();
      // 보라 구간(자주빛~남보라). 파랑(200~250)과 명확히 구분된다.
      expect(probe.hue, `${probe.name}(${probe.css}) 색상각 ${probe.hue}° 는 보라가 아니다`).toBeGreaterThanOrEqual(255);
      expect(probe.hue, `${probe.name}(${probe.css}) 색상각 ${probe.hue}° 는 보라가 아니다`).toBeLessThanOrEqual(320);
    }
  } finally {
    await stopServer(harness.server);
  }
});

// ── UX-7: AI 표면 테두리가 아주 은은하게 빛난다 ──

test('AI 표면은 테두리 전체가 은은하게 빛나고, 움직임을 끄면 멈추되 빛은 남는다', async ({ page }) => {
  const harness = await boot(page);
  try {
    const research = page.locator('.ai-surface.research-request');
    await expect(research).toBeVisible();

    // 테두리 발광은 무한 반복하는 애니메이션으로 표면 전체 둘레에 있다.
    const rim = await research.evaluate((node) => {
      const animations = node.getAnimations().map((animation) => ({
        name: (animation as CSSAnimation).animationName ?? 'unnamed',
        iterations: animation.effect?.getComputedTiming().iterations ?? 1,
        running: animation.playState === 'running',
      }));
      return { animations, shadow: getComputedStyle(node).boxShadow };
    });
    expect(rim.animations.some((entry) => entry.name === 'cc-ai-rim' && entry.running && entry.iterations === Infinity),
      `테두리 발광이 돌지 않는다: ${JSON.stringify(rim.animations)}`).toBe(true);
    expect(rim.shadow, '테두리 둘레의 빛이 없다').not.toBe('none');
  } finally {
    await stopServer(harness.server);
  }
});

test('움직임을 끈 사용자에게 테두리 발광은 정지하되 사라지지 않는다', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const harness = await boot(page);
  try {
    const research = page.locator('.ai-surface.research-request');
    await expect(research).toBeVisible();
    const state = await research.evaluate((node) => ({
      looping: node.getAnimations({ subtree: true })
        .filter((animation) => animation.playState === 'running' && (animation.effect?.getComputedTiming().iterations ?? 1) === Infinity)
        .length,
      shadow: getComputedStyle(node).boxShadow,
      animationName: getComputedStyle(node).animationName,
    }));
    expect(state.looping, '움직임을 끈 사용자에게도 무한 애니메이션이 돈다').toBe(0);
    expect(state.animationName, '테두리 발광 애니메이션이 꺼지지 않았다').toBe('none');
    // 의미는 남는다 — 이 박스가 AI 표면이라는 표식(테두리 둘레의 빛)은 정지 상태로 그대로 있다.
    expect(state.shadow, '움직임을 끄자 AI 표면의 빛까지 사라졌다').not.toBe('none');
  } finally {
    await stopServer(harness.server);
  }
});
