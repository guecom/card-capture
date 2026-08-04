// INT-000036 승인안 전체를 **사용자 눈높이에서** 판정하는 독립 게이트 — Kairen-Ref: TSK-000562
//
// 승인안 v2 (founder, 2026-08-04):
//   1. manual refresh 진행 상태는 누른 button 하나가 소유하고 진행 toast와 ambient `갱신 중`
//      중복을 제거한다.
//   2. 자동 갱신 toggle은 주변 header·card token과 같은 높이·굵기·정렬을 사용하되 44px tap
//      target을 유지한다.
//   3. `파일 올리기`만 중간 sheet 없이 native file picker로 바로 이어진다. `명함 앞면 촬영`과
//      `직접 입력`의 현재 아래→위 전환은 유지한다.
//   4. 빠른·일반·깊은 mode는 처음부터 조건 없이 즉시 선택 가능하다. internal binding은
//      빠른=Luna, 일반=Terra, 깊은=Sol이며 사용자 UI에는 model 이름을 노출하지 않는다.
//      깊은 조사의 목적 requirement가 필요하면 제출 validation과 inline recovery가 소유한다.
//
// 이 파일은 **네 항목을 구현하지 않는다.** 세 lane이 각자 자기 방식으로 구현하는 동안, 이 게이트는
// 그 결과를 밖에서 잰다. 그래서 판정 대상은 class 이름·state 변수·컴포넌트 구조가 아니라
// 접근성 role/이름, 눈에 보이는 글자, 계산된 스타일, 실제로 일어난 event, 요소 수, 기하다.
//
// ── 수정 전 증거 (2026-08-04, 통합 전 main = 13f6f85에서 실측. 두 판 연속 같은 값) ──────
// 25개 판정 중 12개 FAIL. 아래 넷은 승인안의 핵심이라 **오늘 반드시 FAIL해야 하고**,
// 하나라도 통과하면 그 게이트를 잘못 쓴 것이다.
//   1. 아무도 안 눌렀는데 새로고침 버튼이 521개 표본 중 84개(약 16%)에서 `aria-busy=true`이고
//      같은 84개에서 아이콘이 돌았다. 자동 폴링 3건 × 각 700ms에 정확히 대응한다
//      (`refreshBusy = loading` — 목록 조회 플래그를 그대로 쓴다).
//   2. 수동 갱신 중 "진행 중"을 말하는 표면이 4개다: 버튼 `aria-busy` · 상단 한 줄 `갱신 중` ·
//      기록 구획 hint `갱신 중` · toast `새로고침 중…`. 성공에도 toast `새로고침 완료 —
//      최신 상태예요`가 뜬다.
//   3. `파일 올리기`를 눌러도 4초 안에 파일 선택창이 열리지 않고, 대신 6개의 면이 새로 나타난다
//      (`cc-intake-panel` 외). 그 면이 카드 자리를 뺏어 `직접 입력` 입구가 사라진다.
//   4. 목록 응답 전에는 `깊은 조사`가 `disabled` + `data-unavailable`이라 고를 수 없다
//      (`deepResearchEnabled`가 false에서 시작해 서버 응답으로만 열린다).
//
// 그 밖에 오늘 FAIL하는 것들 (같은 승인안이 함께 요구하는 결과):
//   · 자동 갱신 스위치의 실제 히트 영역이 40×40px다 (44px 미달, 보이는 상자도 40px).
//   · 브랜드 표식(세로 중심 31.5px)과 스위치(23px)가 8.5px 어긋나 있다. 반경(모두 10px)과
//     테두리 굵기(1px)는 이미 같다.
//   · 실패가 남기는 문구는 `갱신 실패 · 다시 시도`뿐이라 원인 범주가 없고, 누를 수 있는
//     `다시 시도` 조작은 0개다.
//   · 자동 켜짐/꺼짐이 2곳, 마지막 갱신 시점이 2곳에서 읽힌다.
//   · 서버가 깊은 조사를 닫으면 **고르는 것 자체가** 막힌다 (제출만 막히지 않는다).
//   · 범위 0개로 막혔을 때 focus가 범위 영역이 아니라 안내 문단(`research-block`)으로 간다.
//
// 오늘 이미 PASS하는 것들 (lane이 깨면 안 되는 계약): 배경 갱신 침묵 · 두 표면 모순 없음 ·
// 320px 상단 바 · 색 토큰화 · 전체 화면 촬영 모달 · 아래→위 시트(850px → 66px 관측) ·
// 세 카드 같은 해부 · 이름 유출 0건 · 서버 코드 유출 0건 · 세 폭 가로 넘침 0건 ·
// 다크 대비 40개 측정/스킵 0개 · 움직임 없는 상태 구별 · 콘솔 오류 0건.
//
// ── 측정 함정과 그 회피 (이 파일이 새로 만든 기법) ────────────────────────────
//   · tap target은 **보이는 상자**가 아니라 `elementFromPoint`로 상자 밖 가장자리를 찍어
//     실제로 스위치에 닿는 범위를 잰다. 보이는 상자만 재면 pseudo-element로 넓힌 히트 영역을
//     못 보고, 반대로 넓은 투명 덮개가 이웃 버튼을 먹어도 통과한다 — 그래서 이웃이 여전히
//     자기 중심에서 눌리는지도 함께 잰다.
//   · 시트가 **아래에서 올라오는가**는 class 이름이 아니라 여는 동안의 위치 변화로 본다.
//     transform은 shadow DOM 안 wrapper에 걸리므로 host의 rect만 보면 아무 움직임도 안 보인다.
//   · 다크 대비는 계산 불가로 조용히 건너뛴 수가 상한을 넘으면 **그 자체로 FAIL**이다.
//     이 저장소에서 실제로 132개가 스킵돼 게이트가 무력화된 적이 있다. gradient는 스킵하지 않고
//     색 정지점 중 **가장 불리한 값**을 배경으로 쓴다.
//   · 이름 유출 0건은 오염 노드를 먼저 주입해 검사가 실제로 잡는 것을 본 뒤에 주장한다.
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

// ── 화면을 훑는 도구 (shadow DOM 관통) ────────────────────────────────────────
//
// Ionic은 실제로 칠해지고 실제로 읽히는 요소를 shadow root 안에 그린다. toast 문구·모달 wrapper·
// 버튼 native가 전부 그 안이라 `document.querySelectorAll`만 쓰는 검사는 "toast가 0건"을
// 언제나 통과시킨다. 그래서 훑는 도구를 페이지에 심어 두고 모든 측정이 그것을 쓴다.

declare global {
  interface Window {
    __int36: {
      walk(root?: ParentNode | Element | null): Element[];
      chain(node: Node | null): Element[];
      containsDeep(outer: Element, inner: Element): boolean;
      announced(element: Element): boolean;
      painted(element: Element): boolean;
      text(element: Element): string;
      where(element: Element): string;
      colorsIn(value: string): Array<[number, number, number, number]>;
    };
    __int36probe?: Element;
    __int36samples?: { n: number; busy: number; spin: number; ambient: number; ambientSamples: number; seen: string[] };
    __int36timer?: number;
    __int36motion?: Array<{ t: number; top: number }>;
  }
}

function installHelpers(page: Page): Promise<void> {
  return page.addInitScript(() => {
    const walk = (root?: ParentNode | Element | null): Element[] => {
      const scope = (root ?? document.body) as Element | ParentNode;
      const out: Element[] = [];
      const shadow = (scope as Element).shadowRoot;
      if (shadow) out.push(...walk(shadow));
      for (const element of Array.from(scope.querySelectorAll('*'))) {
        out.push(element);
        if (element.shadowRoot) out.push(...walk(element.shadowRoot));
      }
      return out;
    };

    const chain = (node: Node | null): Element[] => {
      const out: Element[] = [];
      let current: Node | null = node;
      while (current) {
        if (current.nodeType === 1) out.push(current as Element);
        const parent: Node | null = current.parentNode;
        if (parent && parent.nodeType === 11 && (parent as ShadowRoot).host) current = (parent as ShadowRoot).host;
        else current = parent && parent.nodeType === 1 ? parent : null;
      }
      return out;
    };

    const containsDeep = (outer: Element, inner: Element): boolean => outer !== inner && chain(inner).includes(outer);

    const announced = (element: Element): boolean => {
      for (const step of chain(element)) {
        const style = getComputedStyle(step);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (Number.parseFloat(style.opacity) === 0) return false;
        if (step.getAttribute('aria-hidden') === 'true') return false;
      }
      return true;
    };

    const painted = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1 && announced(element);
    };

    const text = (element: Element): string => (element.textContent ?? '').replace(/\s+/g, ' ').trim();

    const where = (element: Element): string => {
      const parts = chain(element).slice(0, 4).map((node) => {
        const name = node.tagName.toLowerCase();
        const cls = typeof node.className === 'string' && node.className.trim()
          ? `.${node.className.trim().split(/\s+/)[0]}` : '';
        return `${name}${cls}`;
      });
      return parts.reverse().join(' > ');
    };

    /** 문자열 안의 모든 rgb/rgba를 뽑는다. gradient의 색 정지점까지 본다. */
    const colorsIn = (value: string): Array<[number, number, number, number]> => {
      const found: Array<[number, number, number, number]> = [];
      const pattern = /rgba?\(([^)]+)\)/g;
      let hit = pattern.exec(value);
      while (hit) {
        const parts = hit[1].split(/[,/]/).map((piece) => Number.parseFloat(piece.trim()));
        if (parts.length >= 3 && parts.slice(0, 3).every((piece) => Number.isFinite(piece))) {
          found.push([parts[0], parts[1], parts[2], Number.isFinite(parts[3]) ? parts[3] : 1]);
        }
        hit = pattern.exec(value);
      }
      return found;
    };

    window.__int36 = { walk, chain, containsDeep, announced, painted, text, where, colorsIn };
  });
}

// ── 서버 harness ─────────────────────────────────────────────────────────────

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function person(index: number, name: string, organization: string) {
  return {
    captureId: `2026080${index}-090000-p${index}`,
    receivedAt: ago(index * 60),
    status: 'processed',
    person: `PER-00000${index}`,
    capturer: '이강규',
    event: '고객사 방문 미팅',
    contact: { name, title: '구매팀장', organization },
    brief: `# ${name} — 이런 분이에요\n${organization} 구매팀장입니다.`,
  };
}

/** `active`면 아직 끝나지 않은 카드가 있어 앱이 빠른 박자(4초)를 쓴다 — 20초를 기다리지 않는다. */
function listFixture(options: { active: boolean; deepOpen: boolean }) {
  const items: Array<Record<string, unknown>> = [person(1, '김민서', '한화시스템'), person(2, '이서연', '넥스트로보')];
  if (options.active) items.push({ captureId: '20260804-100000-a1', receivedAt: ago(2), status: 'received' });
  return {
    ok: true,
    seeAll: true,
    researchInstructionEnabled: true,
    deepResearchEnabled: options.deepOpen,
    hasMore: false,
    items,
  };
}

interface Harness {
  server: Server;
  origin: string;
  url: string;
  /** 서버가 실제로 받은 list 요청 수. "정말로 폴링했는가"의 진실값이다. */
  readonly listRequests: number;
  readonly listInFlight: number;
  /** 서버로 실제로 나간 조사 요청 본문 */
  readonly submitted: Array<Record<string, unknown>>;
  delayList(ms: number): void;
  failList(fail: boolean): void;
  /** 목록 응답을 붙잡아 둔다. 놓기 전까지 앱은 "아직 아무것도 못 들은" 상태다. */
  holdList(hold: boolean): void;
  releaseList(): void;
}

interface BootOptions {
  width?: number;
  height?: number;
  theme?: 'light' | 'dark';
  active?: boolean;
  deepOpen?: boolean;
  reducedMotion?: boolean;
  camera?: 'present' | 'absent';
  /** 첫 응답을 받아 owner 게이트를 기기에 남긴 뒤, 목록을 붙잡은 채로 다시 연다. */
  reopenWithHeldList?: boolean;
}

async function boot(page: Page, options: BootOptions = {}): Promise<Harness> {
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');
  const origin = `http://127.0.0.1:${address.port}/`;
  const api = encodeURIComponent('https://api.example.test/exec');
  const url = `${origin}next/?api=${api}&k=owner-token`;

  const state = {
    active: options.active !== false,
    deepOpen: options.deepOpen !== false,
    delay: 0,
    fail: false,
    hold: false,
    requests: 0,
    inFlight: 0,
    submitted: [] as Array<Record<string, unknown>>,
  };
  let releaseHeld: () => void = () => undefined;
  const held = new Promise<void>((done) => { releaseHeld = done; });
  const wait = (ms: number) => (ms > 0 ? new Promise((done) => setTimeout(done, ms)) : Promise.resolve());

  await page.context().route('**/vendor/**', (route) => route.abort());
  await page.route('https://api.example.test/**', async (route) => {
    const request = route.request();
    const action = new URL(request.url()).searchParams.get('action');
    if (action === 'list') {
      state.requests += 1;
      state.inFlight += 1;
      try {
        if (state.hold) await held;
        await wait(state.delay);
        if (state.fail) { await route.fulfill({ status: 500, contentType: 'application/json', body: '{"ok":false,"error":"list_failed"}' }); return; }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(listFixture({ active: state.active, deepOpen: state.deepOpen })),
        });
      } finally {
        state.inFlight -= 1;
      }
      return;
    }
    if (request.method() === 'POST') {
      const body = JSON.parse(request.postData() ?? '{}') as Record<string, unknown>;
      if (body.action === 'researchinstruction') {
        state.submitted.push(body);
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, receiptId: 'research-int36-0001', person: 'PER-000001', status: 'received' }) });
        return;
      }
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [] }) });
  });

  await installHelpers(page);
  await page.addInitScript((theme) => {
    localStorage.setItem('cc_name', '이강규');
    if (theme) localStorage.setItem('cc_theme', theme);
  }, options.theme ?? null);
  /* 기기 능력을 못 박는다. 선언하지 않으면 이 파일은 코드가 아니라 **실행한 기계**를 잰다 —
     웹캠 없는 runner에서는 촬영 카드가 이유·회복 줄을 달고 나와 카드 해부가 달라진다. */
  await page.addInitScript((present) => {
    const media = navigator.mediaDevices;
    if (!media) return;
    media.enumerateDevices = async () => (present
      ? [{ kind: 'videoinput', deviceId: '', label: '', groupId: '', toJSON: () => ({}) } as MediaDeviceInfo]
      : []);
    media.getUserMedia = async () => {
      if (present) return new MediaStream();
      const error = new Error('Requested device not found');
      error.name = 'NotFoundError';
      throw error;
    };
  }, (options.camera ?? 'present') === 'present');

  if (options.reducedMotion) await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: options.width ?? 390, height: options.height ?? 844 });
  await page.goto(url, { waitUntil: 'networkidle' });

  if (options.reopenWithHeldList) {
    // 첫 응답으로 owner 게이트가 기기에 남았다. 이제 **아무것도 못 들은 상태**로 다시 연다.
    await expect(page.getByRole('radio', { name: '일반 조사' })).toHaveCount(1);
    state.hold = true;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }

  return {
    server,
    origin,
    url,
    get listRequests() { return state.requests; },
    get listInFlight() { return state.inFlight; },
    get submitted() { return state.submitted; },
    delayList: (ms) => { state.delay = ms; },
    failList: (fail) => { state.fail = fail; },
    holdList: (hold) => { state.hold = hold; },
    releaseList: () => { state.hold = false; releaseHeld(); },
  };
}

async function teardown(harness: Harness): Promise<void> {
  harness.releaseList();
  await stopServer(harness.server);
}

// ── 손잡이 (role·이름으로만 찾는다) ──────────────────────────────────────────

/** 자동 갱신 스위치. role이 먼저고, 이름은 확인용이다. */
async function autoSwitch(page: Page): Promise<Locator> {
  const header = page.locator('ion-header');
  const byRole = header.getByRole('switch');
  if (await byRole.count() > 0) return byRole.first();
  const fallback = header.locator('[role="switch"], ion-toggle, input[type="checkbox"]');
  expect(await fallback.count(), '상단 바에서 자동 갱신 스위치를 찾지 못했다').toBeGreaterThan(0);
  return fallback.first();
}

/** 수동 새로고침 버튼. 이름이 바뀌어도 상단 바의 비-스위치 버튼으로 되찾는다. */
async function refreshButton(page: Page): Promise<Locator> {
  const header = page.locator('ion-header');
  const named = header.getByRole('button', { name: /최신|새로고침|갱신|refresh/i });
  if (await named.count() > 0) return named.first();
  const generic = header.locator('button:not([role="switch"]), ion-button:not([role="switch"])');
  expect(await generic.count(), '상단 바에서 수동 새로고침 버튼을 찾지 못했다').toBeGreaterThan(0);
  return generic.first();
}

/** 조사 깊이 세 칸을 담은 묶음. */
function depthGroup(scope: Page | Locator): Locator {
  return scope.getByRole('radiogroup').filter({ hasText: '깊은 조사' }).first();
}

const DEPTH_LABELS = ['빠른 조사', '일반 조사', '깊은 조사'] as const;

/**
 * 깊이 하나를 **사람이 누르는 방식으로** 고른다.
 *
 * native radio는 라벨 밑에 깔려 있어 pointer event를 받지 못한다(`radiogroup intercepts pointer
 * events`). input을 강제로 누르면 게이트가 사용자에게는 불가능한 경로로만 통과하게 되므로,
 * 라벨을 누른다 — 못 고르는 칸을 눌렀을 때 **아무 일도 안 일어나는 것**까지 그대로 관측된다.
 */
async function chooseDepth(scope: Page | Locator, label: (typeof DEPTH_LABELS)[number]): Promise<void> {
  const radio = depthGroup(scope).getByRole('radio', { name: label });
  const surface = radio.locator('xpath=ancestor-or-self::label[1]');
  const target = (await surface.count()) > 0 ? surface.first() : radio;
  /* `force: true`가 필요한 이유: Playwright는 disabled 컨트롤을 감싼 label을 `not enabled`로 보고
     30초를 기다리다 죽는다. 그러면 "못 고른다"가 **측정값이 아니라 timeout**이 되어, 무엇이
     막혔는지 대신 게이트가 멈췄다는 사실만 남는다. 여기서는 사람이 하듯 그 타일을 실제로 누르고,
     아무 일도 안 일어났다는 것을 그 다음 상태로 판정한다. */
  await target.click({ force: true, timeout: 5_000 });
}

const ENTRY_NAMES = { camera: '명함 앞면 촬영', manual: '직접 입력', upload: /(파일|사진) 올리기/ } as const;

function entryCard(page: Page, which: keyof typeof ENTRY_NAMES): Locator {
  return page.getByRole('button', { name: ENTRY_NAMES[which] }).first();
}

// ── 갱신 사실을 말하는 표면을 세는 자 ────────────────────────────────────────

const PHRASES = {
  busy: '갱신\\s*중|새로고침\\s*중|불러오는\\s*중|가져오는\\s*중|확인\\s*중|업데이트\\s*중|동기화\\s*중',
  success: '방금 업데이트|갱신 완료|새로고침 완료|최신 상태예요|최신입니다|업데이트했어요',
  failure: '갱신 실패|새로고침 실패|갱신하지 못|불러오지 못|가져오지 못|확인하지 못|갱신에 실패',
  freshness: '방금|\\d+\\s*초 전|\\d+\\s*분 전|\\d+\\s*시간 전',
  freshnessContext: '갱신|업데이트|초마다|분마다|자동|확인',
  autoState: '자동 갱신\\s*(켜짐|꺼짐)|자동 꺼짐|자동 켜짐|자동 갱신이 (켜|꺼)',
} as const;

interface Surface { where: string; text: string; kind: 'text' | 'control' }
interface RefreshReport {
  busy: Surface[];
  success: Surface[];
  failure: Surface[];
  freshness: Surface[];
  autoState: Surface[];
  switches: number;
  overlays: Surface[];
  retryControls: string[];
}

/**
 * 지금 이 순간 화면이 갱신에 대해 말하고 있는 **모든** 표면.
 *
 * 눈에 보이는 글자만 훑으면 절반만 보는 것이다. shadow DOM 안의 toast 문구와 낭독기 전용 줄까지
 * 포함하고, 겹쳐 잡히는 조상은 버려 가장 안쪽 표면만 남긴다 — 그래야 "몇 자리에서 말하는가"가
 * DOM 깊이가 아니라 사람이 세는 수와 같아진다.
 */
async function refreshReport(page: Page): Promise<RefreshReport> {
  return page.evaluate((phrases) => {
    const helpers = window.__int36;
    const patterns = {
      busy: new RegExp(phrases.busy),
      success: new RegExp(phrases.success),
      failure: new RegExp(phrases.failure),
      freshness: new RegExp(phrases.freshness),
      freshnessContext: new RegExp(phrases.freshnessContext),
      autoState: new RegExp(phrases.autoState),
    };
    const all = helpers.walk(document.body).filter((node) => helpers.announced(node));

    const innermost = (matches: Element[]): Element[] =>
      matches.filter((candidate) => !matches.some((other) => helpers.containsDeep(candidate, other)));

    const collect = (pattern: RegExp, extra?: (element: Element, value: string) => boolean): Surface[] => {
      const matched = all.filter((node) => {
        const value = helpers.text(node);
        if (!value || !pattern.test(value)) return false;
        return extra ? extra(node, value) : true;
      });
      return innermost(matched).map((node) => ({
        where: helpers.where(node),
        text: helpers.text(node).slice(0, 80),
        kind: 'text' as const,
      }));
    };

    const isControl = (node: Element): boolean => {
      const role = node.getAttribute('role');
      return /^(BUTTON|A|ION-BUTTON)$/.test(node.tagName) || role === 'button' || role === 'link';
    };
    const busyControls = all.filter((node) => isControl(node) && (node.getAttribute('aria-busy') === 'true' || node.getAttribute('data-busy') === 'true'));

    const busyText = collect(patterns.busy);
    // 진행을 말하는 글자가 진행 중인 버튼 **안**에 있으면 두 표면이 아니라 한 표면이다.
    const controlSurfaces: Surface[] = innermost(busyControls).map((node) => ({
      where: helpers.where(node),
      text: (helpers.text(node) || `[aria-busy] ${node.getAttribute('aria-label') ?? ''}`).slice(0, 80),
      kind: 'control' as const,
    }));
    const busy = [
      ...controlSurfaces,
      ...busyText.filter((surface) => !busyControls.some((control) => {
        const node = all.find((candidate) => helpers.where(candidate) === surface.where && helpers.text(candidate).slice(0, 80) === surface.text);
        return node ? node === control || helpers.containsDeep(control, node) : false;
      })),
    ];

    /* toast·banner: 흐름 위에 떠 있는 알림. Ionic toast와 일반 overlay를 둘 다 본다.
       `role="status"`인 한 줄은 여기 들어오지 않는다 — 그것은 자리를 차지하고 남아 있는 표면이다. */
    const overlays: Surface[] = [];
    for (const node of all) {
      const value = helpers.text(node);
      if (!value) continue;
      if (!(patterns.busy.test(value) || patterns.success.test(value) || patterns.failure.test(value))) continue;
      const style = getComputedStyle(node);
      const ionicToast = node.tagName === 'ION-TOAST' && !node.classList.contains('overlay-hidden');
      const floating = (style.position === 'fixed' || style.position === 'absolute')
        && Number.parseInt(style.zIndex || '0', 10) >= 10
        && node.getBoundingClientRect().width > 40;
      if (!ionicToast && !floating) continue;
      // 조상 overlay가 이미 잡혔으면 하나로 센다.
      if (overlays.some((existing) => existing.where === helpers.where(node))) continue;
      overlays.push({ where: helpers.where(node), text: value.slice(0, 80), kind: 'text' });
    }
    const overlayHosts = overlays.map((entry) => entry.where);
    const dedupedOverlays = overlays.filter((entry, index) => overlayHosts.indexOf(entry.where) === index
      && !overlays.some((other, otherIndex) => otherIndex !== index && entry.where.startsWith(`${other.where} > `)));

    const retryControls = all
      .filter((node) => isControl(node) && helpers.painted(node))
      .map((node) => (node.getAttribute('aria-label') ?? helpers.text(node)).trim())
      .filter((name) => /다시 시도|재시도|다시 불러|다시 확인|다시 가져/.test(name));

    return {
      busy,
      success: collect(patterns.success),
      failure: collect(patterns.failure),
      freshness: collect(patterns.freshness, (_node, value) => patterns.freshnessContext.test(value)),
      autoState: collect(patterns.autoState),
      switches: all.filter((node) => (node.getAttribute('role') === 'switch' || node.tagName === 'ION-TOGGLE') && helpers.painted(node)).length,
      overlays: dedupedOverlays,
      retryControls,
    };
  }, PHRASES);
}

const describeSurfaces = (surfaces: Surface[]): string =>
  surfaces.length === 0 ? '(없음)' : surfaces.map((surface) => `${surface.kind}:${surface.where}="${surface.text}"`).join(' | ');

// ══════════════════════════════════════════════════════════════════════════════
// 1. 갱신 — 진행 상태는 누른 버튼 하나가 소유한다
// ══════════════════════════════════════════════════════════════════════════════

test('아무도 누르지 않았는데 새로고침 버튼이 혼자 돌지 않는다', async ({ page }) => {
  const harness = await boot(page, { active: true });
  try {
    const button = await refreshButton(page);
    await button.evaluate((node) => { window.__int36probe = node; });

    /* 응답에 700ms를 준다. **즉답 서버는 이 결함을 숨긴다** — 폴링이 1ms 만에 끝나면 버튼이
       도는 프레임이 아예 없어서 "안 돈다"가 거짓으로 통과한다(첫 판이 실제로 그렇게 통과했다).
       founder가 본 화면은 실제 망 위였고, 거기서는 매 폴링이 수백 ms 동안 떠 있다. */
    harness.delayList(700);

    // 버튼은 25ms마다, DOM 전체 훑기는 150ms마다 — 훑기가 무거워 같은 박자로 돌리면 표본이 준다.
    await page.evaluate((phrases) => {
      const busy = new RegExp(phrases.busy);
      const node = window.__int36probe as HTMLElement;
      const samples = { n: 0, busy: 0, spin: 0, ambient: 0, ambientSamples: 0, seen: [] as string[] };
      window.__int36samples = samples;
      window.__int36timer = window.setInterval(() => {
        samples.n += 1;
        if (node.getAttribute('aria-busy') === 'true' || node.getAttribute('data-busy') === 'true') samples.busy += 1;
        const looping = node.getAnimations({ subtree: true })
          .filter((animation) => animation.playState === 'running'
            && (animation.effect?.getComputedTiming().iterations ?? 1) === Number.POSITIVE_INFINITY).length;
        if (looping > 0) samples.spin += 1;
        if (samples.n % 6 !== 0) return;
        samples.ambientSamples += 1;
        /* 첫 일치에서 멈추면 문서 순서상 **가장 바깥 컨테이너**가 잡혀서 "어디가 말했는지"를
           못 알려 준다(첫 판이 `body > div`를 보고했다). 글이 가장 짧은 것 = 가장 안쪽 표면이다. */
        let best: { mark: string; length: number } | null = null;
        for (const element of window.__int36.walk(document.body)) {
          if (!window.__int36.announced(element)) continue;
          const value = window.__int36.text(element);
          if (!value || !busy.test(value)) continue;
          if (!best || value.length < best.length) {
            best = { mark: `${window.__int36.where(element)}="${value.slice(0, 60)}"`, length: value.length };
          }
        }
        if (!best) return;
        samples.ambient += 1;
        if (!samples.seen.includes(best.mark)) samples.seen.push(best.mark);
      }, 25);
    }, PHRASES);

    const before = harness.listRequests;
    await page.waitForTimeout(13_000);
    const measured = await page.evaluate(() => {
      if (window.__int36timer) window.clearInterval(window.__int36timer);
      return window.__int36samples!;
    });
    const polls = harness.listRequests - before;

    // 양성 증거 먼저. 이것이 없으면 아래 "0건"은 폴링이 죽어도 통과하는 빈 단언이다.
    expect(polls, `13초 동안 자동 폴링이 ${polls}건뿐이다 — 게이트가 아무것도 재지 못했다`).toBeGreaterThanOrEqual(2);
    expect(measured.n, `버튼 표본이 ${measured.n}개뿐이다`).toBeGreaterThan(200);
    expect(measured.ambientSamples, `화면 표본이 ${measured.ambientSamples}개뿐이다`).toBeGreaterThan(30);

    expect.soft(measured.busy, `아무도 누르지 않았는데 새로고침 버튼이 ${measured.n}개 표본 중 ${measured.busy}개에서 aria-busy=true였다 (자동 폴링 ${polls}건 × 각 700ms)`).toBe(0);
    expect.soft(measured.spin, `아무도 누르지 않았는데 버튼 안 아이콘이 ${measured.n}개 표본 중 ${measured.spin}개에서 돌고 있었다`).toBe(0);
    expect.soft(measured.ambient, `아무도 누르지 않았는데 "진행 중"을 말한 표면이 ${measured.ambientSamples}개 표본 중 ${measured.ambient}개에서 있었다: ${measured.seen.join(' | ') || '(없음)'}`).toBe(0);
  } finally {
    await teardown(harness);
  }
});

test('눌렀을 때 진행 사실을 말하는 표면은 화면에 정확히 하나다', async ({ page }) => {
  const harness = await boot(page, { active: false });
  try {
    const button = await refreshButton(page);
    const atRest = await refreshReport(page);
    expect(atRest.busy.length, `아무 요청도 없는데 진행을 말하는 표면이 있다: ${describeSurfaces(atRest.busy)}`).toBe(0);

    harness.delayList(3_000);
    await button.click();
    // 요청이 실제로 떠 있는 창에서만 잰다 — 관측 창이 닫힌 뒤 재면 무엇이든 0이 된다.
    await expect.poll(() => harness.listInFlight, { timeout: 5_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(400);
    expect(harness.listInFlight, '읽는 사이에 요청이 이미 끝났다 — 관측 창이 너무 좁다').toBeGreaterThan(0);

    const pending = await refreshReport(page);
    expect.soft(
      pending.busy.length,
      `수동 갱신 중 "진행 중"을 말하는 표면이 ${pending.busy.length}개다 (정확히 1개여야 한다): ${describeSurfaces(pending.busy)}`,
    ).toBe(1);

    harness.delayList(0);
    await expect.poll(() => harness.listInFlight, { timeout: 8_000 }).toBe(0);
    await page.waitForTimeout(600);
    const done = await refreshReport(page);
    expect.soft(done.busy.length, `요청이 끝났는데 진행 표면이 남아 있다: ${describeSurfaces(done.busy)}`).toBe(0);
  } finally {
    await teardown(harness);
  }
});

test('진행·성공을 알리는 toast/banner가 0건이고 성공은 신선도가 바뀌는 것으로 닫힌다', async ({ page }) => {
  const harness = await boot(page, { active: false });
  try {
    const button = await refreshButton(page);
    const beforeFreshness = (await refreshReport(page)).freshness.map((surface) => surface.text);

    harness.delayList(1_500);
    await button.click();
    await expect.poll(() => harness.listInFlight, { timeout: 5_000 }).toBeGreaterThan(0);
    const pending = await refreshReport(page);
    expect.soft(
      pending.overlays.length,
      `진행 중에 뜬 toast/banner가 ${pending.overlays.length}건이다: ${describeSurfaces(pending.overlays)}`,
    ).toBe(0);

    harness.delayList(0);
    await expect.poll(() => harness.listInFlight, { timeout: 8_000 }).toBe(0);
    await page.waitForTimeout(500);
    const settled = await refreshReport(page);
    expect.soft(
      settled.overlays.length,
      `성공 뒤에 뜬 toast/banner가 ${settled.overlays.length}건이다: ${describeSurfaces(settled.overlays)}`,
    ).toBe(0);

    // 성공은 조용히 닫히되 **아무 일도 없던 것처럼** 닫히지는 않는다 — 신선도 표시가 살아 있어야 한다.
    expect(
      settled.freshness.length,
      `성공 뒤에 신선도를 말하는 표면이 0개다 (성공을 닫을 방법이 없다). 갱신 전: ${beforeFreshness.join(' | ') || '(없음)'}`,
    ).toBeGreaterThanOrEqual(1);
  } finally {
    await teardown(harness);
  }
});

test('실패는 사라지지 않고 남아서 원인 범주와 다시 시도를 함께 내민다', async ({ page }) => {
  const harness = await boot(page, { active: false });
  try {
    const button = await refreshButton(page);
    harness.failList(true);
    await button.click();

    await expect.poll(async () => (await refreshReport(page)).failure.length, { timeout: 10_000 }).toBeGreaterThan(0);
    const first = await refreshReport(page);

    // toast 수명(2.6초)과 성공 유지 시간(2초)을 훌쩍 넘겨 기다린다. 조용한 박자는 20초라 이 창에
    // 자동 폴링이 끼어들지 않는다.
    await page.waitForTimeout(7_000);
    const later = await refreshReport(page);

    expect.soft(
      later.failure.length,
      `실패를 알리던 표면이 7초 뒤 ${later.failure.length}개로 줄었다 (처음: ${describeSurfaces(first.failure)})`,
    ).toBeGreaterThanOrEqual(1);

    const persisted = later.failure.map((surface) => surface.text).join(' / ');
    expect.soft(
      /연결|네트워크|인터넷|서버|오프라인|권한|시간 초과|주소|응답/.test(persisted),
      `남아 있는 실패 표면이 원인 범주를 말하지 않는다: "${persisted || '(없음)'}"`,
    ).toBe(true);
    expect.soft(
      later.retryControls.length,
      `실패 뒤에 누를 수 있는 \`다시 시도\`가 ${later.retryControls.length}개다 (글자만 있고 조작이 없으면 막다른 길이다). 지금 남은 문구: "${persisted || '(없음)'}"`,
    ).toBeGreaterThanOrEqual(1);
  } finally {
    await teardown(harness);
  }
});

test('배경 갱신이 실패해도 화면은 조용하다 (기존 계약)', async ({ page }) => {
  const harness = await boot(page, { active: true });
  try {
    const before = harness.listRequests;
    harness.failList(true);
    await expect.poll(() => harness.listRequests, { timeout: 12_000 }).toBeGreaterThanOrEqual(before + 2);
    await page.waitForTimeout(600);

    const report = await refreshReport(page);
    expect(report.failure, `누르지 않은 배경 갱신 실패가 화면에 나타났다: ${describeSurfaces(report.failure)}`).toEqual([]);
    expect(report.overlays, `배경 갱신 실패로 toast가 떴다: ${describeSurfaces(report.overlays)}`).toEqual([]);
  } finally {
    await teardown(harness);
  }
});

test('같은 순간 두 표면이 서로 다른 갱신 사실을 말하지 않는다', async ({ page }) => {
  const harness = await boot(page, { active: false });
  try {
    const button = await refreshButton(page);
    const snapshots: Array<{ moment: string; states: string[]; detail: string }> = [];

    const capture = async (moment: string) => {
      const report = await refreshReport(page);
      const states: string[] = [];
      if (report.busy.length) states.push('진행 중');
      if (report.success.length) states.push('성공');
      if (report.failure.length) states.push('실패');
      snapshots.push({
        moment,
        states,
        detail: `busy=${describeSurfaces(report.busy)} success=${describeSurfaces(report.success)} failure=${describeSurfaces(report.failure)}`,
      });
    };

    await capture('가만히 있을 때');
    harness.delayList(2_000);
    await button.click();
    await expect.poll(() => harness.listInFlight, { timeout: 5_000 }).toBeGreaterThan(0);
    await capture('요청이 떠 있는 동안');
    harness.delayList(0);
    await expect.poll(() => harness.listInFlight, { timeout: 8_000 }).toBe(0);
    await page.waitForTimeout(300);
    await capture('막 끝난 직후');

    for (const snapshot of snapshots) {
      expect.soft(
        snapshot.states.length,
        `${snapshot.moment}: 화면이 동시에 ${snapshot.states.length}가지 갱신 사실을 말한다 [${snapshot.states.join(', ')}] — ${snapshot.detail}`,
      ).toBeLessThanOrEqual(1);
    }
  } finally {
    await teardown(harness);
  }
});

test('낭독기 기준으로 기능 상태·작업 상태·신선도가 각각 한 번씩만 읽힌다', async ({ page }) => {
  const harness = await boot(page, { active: false });
  try {
    const report = await refreshReport(page);

    // 기능 상태(자동 켜짐/꺼짐)는 스위치가 소유한다. 같은 사실을 글자로 한 번 더 쓰면 두 번 읽힌다.
    const featureSurfaces = report.switches + report.autoState.length;
    expect.soft(
      featureSurfaces,
      `자동 갱신 켜짐/꺼짐을 말하는 표면이 ${featureSurfaces}개다 (스위치 ${report.switches}개 + 글자 ${report.autoState.length}개): ${describeSurfaces(report.autoState)}`,
    ).toBe(1);

    expect.soft(
      report.freshness.length,
      `마지막 갱신 시점을 말하는 표면이 ${report.freshness.length}개다: ${describeSurfaces(report.freshness)}`,
    ).toBe(1);

    const button = await refreshButton(page);
    harness.delayList(2_000);
    await button.click();
    await expect.poll(() => harness.listInFlight, { timeout: 5_000 }).toBeGreaterThan(0);
    const pending = await refreshReport(page);
    expect.soft(
      pending.busy.length,
      `작업 상태를 말하는 표면이 ${pending.busy.length}개다: ${describeSurfaces(pending.busy)}`,
    ).toBe(1);
  } finally {
    await teardown(harness);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. 토글 시각 균형 — 주변과 같은 자로 서되 손가락은 그대로
// ══════════════════════════════════════════════════════════════════════════════

/**
 * **누를 수 있는 영역**을 잰다 — 보이는 상자가 아니라.
 *
 * 중심에서 한 픽셀씩 밖으로 나가며 `elementFromPoint`가 여전히 이 조작에 닿는지 확인한다.
 * 보이는 상자만 재면 (1) pseudo-element로 넓힌 히트 영역을 못 보고 (2) 반대로 이웃을 덮어 버린
 * 투명 판이 있어도 그냥 통과한다. 그래서 이웃이 자기 중심에서 여전히 눌리는지도 함께 잰다.
 */
async function hitArea(locator: Locator): Promise<{ width: number; height: number; box: { width: number; height: number } }> {
  return locator.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const cx = Math.round(rect.left + rect.width / 2);
    const cy = Math.round(rect.top + rect.height / 2);
    const owns = (x: number, y: number): boolean => {
      if (x < 0 || y < 0 || x >= document.documentElement.clientWidth || y >= document.documentElement.clientHeight) return false;
      const hit = document.elementFromPoint(x, y);
      return Boolean(hit) && window.__int36.chain(hit).includes(node);
    };
    if (!owns(cx, cy)) return { width: 0, height: 0, box: { width: rect.width, height: rect.height } };
    const probe = (dx: number, dy: number): number => {
      let distance = 0;
      while (distance < 60 && owns(cx + dx * (distance + 1), cy + dy * (distance + 1))) distance += 1;
      return distance;
    };
    return {
      width: probe(-1, 0) + probe(1, 0) + 1,
      height: probe(0, -1) + probe(0, 1) + 1,
      box: { width: Math.round(rect.width * 10) / 10, height: Math.round(rect.height * 10) / 10 },
    };
  });
}

test('자동 갱신 스위치의 실제 누를 수 있는 영역이 44×44px 이상이다', async ({ page }) => {
  const harness = await boot(page, { active: false });
  try {
    const toggle = await autoSwitch(page);
    const button = await refreshButton(page);
    const measured = await hitArea(toggle);

    expect.soft(
      measured.width,
      `자동 갱신 스위치의 가로 히트 영역이 ${measured.width}px다 (보이는 상자 ${measured.box.width}px)`,
    ).toBeGreaterThanOrEqual(44);
    expect.soft(
      measured.height,
      `자동 갱신 스위치의 세로 히트 영역이 ${measured.height}px다 (보이는 상자 ${measured.box.height}px)`,
    ).toBeGreaterThanOrEqual(44);

    // 넓힌 히트 영역이 이웃을 먹으면 그것은 고친 것이 아니라 옮긴 것이다.
    const neighbour = await hitArea(button);
    expect(
      neighbour.width * neighbour.height,
      `스위치를 넓히다가 새로고침 버튼이 자기 중심에서도 안 눌린다 (${neighbour.width}×${neighbour.height}px)`,
    ).toBeGreaterThan(0);

    // 넓어진 뒤에도 실제로 켜고 끌 수 있어야 한다.
    const before = await toggle.getAttribute('aria-checked');
    await toggle.click();
    await expect.poll(() => toggle.getAttribute('aria-checked')).not.toBe(before);
  } finally {
    await teardown(harness);
  }
});

test('스위치·새로고침·주변 header 요소가 같은 반경 스케일·테두리 굵기·세로 중심을 쓴다', async ({ page }) => {
  const harness = await boot(page, { active: false });
  try {
    await (await autoSwitch(page)).evaluate((node) => { (window as unknown as { __switch: Element }).__switch = node; });
    await (await refreshButton(page)).evaluate((node) => { (window as unknown as { __button: Element }).__button = node; });

    const measured = await page.evaluate(() => {
      const helpers = window.__int36;
      const scope = document.querySelector('ion-header');
      if (!scope) return null;
      const headerRect = scope.getBoundingClientRect();
      /* `aria-hidden`이라고 빼지 않는다 — 브랜드 표식처럼 낭독기에는 안 읽혀도 **눈에는 보이는**
         header token이 정확히 이 비교의 대상이다. 첫 판이 그것을 뺐다가 잰 상자가 둘(스위치·버튼)뿐이
         돼서 "주변과 같은 자를 쓰는가"를 아무것도 재지 못했다. */
      const boxes = helpers.walk(scope)
        .filter((node) => {
          const rect = node.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2) return false;
          const style = getComputedStyle(node);
          return style.display !== 'none' && style.visibility !== 'hidden' && Number.parseFloat(style.opacity) > 0;
        })
        .filter((node) => {
          const rect = node.getBoundingClientRect();
          const area = rect.width * rect.height;
          if (area < 500) return false;
          if (area > headerRect.width * headerRect.height * 0.55) return false;
          const style = getComputedStyle(node);
          const bordered = Number.parseFloat(style.borderTopWidth) > 0;
          const filled = helpers.colorsIn(style.backgroundColor).some((color) => color[3] > 0.02)
            || style.backgroundImage !== 'none';
          return bordered || filled;
        })
        .map((node) => {
          const style = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return {
            where: helpers.where(node),
            radius: Math.round(Number.parseFloat(style.borderTopLeftRadius) * 100) / 100,
            border: Math.round(Number.parseFloat(style.borderTopWidth) * 100) / 100,
            height: Math.round(rect.height * 10) / 10,
            centerY: Math.round((rect.top + rect.height / 2) * 10) / 10,
          };
        });

      const rootStyle = getComputedStyle(document.documentElement);
      const scale = ['--cc-r-sm', '--cc-r-md', '--cc-r-lg', '--cc-r-xl', '--cc-r-pill']
        .map((token) => Number.parseFloat(rootStyle.getPropertyValue(token)))
        .filter((value) => Number.isFinite(value));

      const shape = (node: Element | undefined) => {
        if (!node) return null;
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return {
          radius: Math.round(Number.parseFloat(style.borderTopLeftRadius) * 100) / 100,
          border: Math.round(Number.parseFloat(style.borderTopWidth) * 100) / 100,
          height: Math.round(rect.height * 10) / 10,
          centerY: Math.round((rect.top + rect.height / 2) * 10) / 10,
        };
      };
      const globals = window as unknown as { __switch?: Element; __button?: Element };
      return { boxes, scale, toggle: shape(globals.__switch), button: shape(globals.__button) };
    });

    expect(measured, 'ion-header를 찾지 못했다').not.toBeNull();
    expect(measured!.scale.length, '테마가 반경 토큰을 노출하지 않는다 — 스케일을 대조할 기준이 없다').toBeGreaterThanOrEqual(4);
    expect(measured!.boxes.length, `상단 바에서 잰 상자가 ${measured!.boxes.length}개뿐이다 — 게이트가 아무것도 재지 못했다`).toBeGreaterThanOrEqual(3);

    const offScale = measured!.boxes.filter((box) => box.radius > 0
      && !measured!.scale.some((token) => Math.abs(token - box.radius) <= 1));
    expect.soft(
      offScale.map((box) => `${box.where}=${box.radius}px`),
      `테마 반경 스케일(${measured!.scale.join(', ')}px) 밖의 모서리가 있다`,
    ).toEqual([]);

    const widths = [...new Set(measured!.boxes.filter((box) => box.border > 0).map((box) => box.border))];
    expect.soft(
      widths,
      `상단 바 테두리 굵기가 제각각이다: ${measured!.boxes.map((box) => `${box.where}=${box.border}px`).join(' | ')}`,
    ).toHaveLength(1);

    // 세로 중심. 허용 오차 1.5px — 서브픽셀 반올림은 넘기고, 눈에 보이는 어긋남은 잡는다.
    const toggle = measured!.toggle!;
    const button = measured!.button!;
    expect.soft(
      Math.abs(toggle.centerY - button.centerY),
      `스위치(중심 ${toggle.centerY}px)와 새로고침 버튼(중심 ${button.centerY}px)의 세로 중심이 ${Math.abs(toggle.centerY - button.centerY).toFixed(1)}px 어긋났다`,
    ).toBeLessThanOrEqual(1.5);

    const others = measured!.boxes.filter((box) => Math.abs(box.centerY - toggle.centerY) > 0.1 || Math.abs(box.height - toggle.height) > 0.1);
    for (const box of others) {
      expect.soft(
        Math.abs(box.centerY - toggle.centerY),
        `${box.where}(중심 ${box.centerY}px)와 자동 갱신 스위치(중심 ${toggle.centerY}px)의 세로 중심이 ${Math.abs(box.centerY - toggle.centerY).toFixed(1)}px 어긋났다`,
      ).toBeLessThanOrEqual(1.5);
    }

    // 높이도 주변과 같은 자를 쓴다.
    expect.soft(
      Math.abs(toggle.height - button.height),
      `스위치 높이 ${toggle.height}px, 새로고침 버튼 높이 ${button.height}px — 같은 자를 쓰지 않는다`,
    ).toBeLessThanOrEqual(1);
  } finally {
    await teardown(harness);
  }
});

test('320px에서 상단 클러스터가 화면 밖으로 밀리지 않는다', async ({ page }) => {
  const harness = await boot(page, { active: true, width: 320, height: 568 });
  try {
    await expect(await autoSwitch(page)).toBeVisible();
    const report = await page.evaluate(() => {
      // 폭은 clientWidth로 잰다 — innerWidth는 emulation에서 진실이 아니다.
      const viewport = document.documentElement.clientWidth;
      const scope = document.querySelector('ion-header');
      const offenders: string[] = [];
      if (scope) {
        for (const node of window.__int36.walk(scope)) {
          if (!window.__int36.painted(node)) continue;
          const rect = node.getBoundingClientRect();
          if (rect.right <= viewport + 1 && rect.left >= -1) continue;
          offenders.push(`${window.__int36.where(node)} → left ${Math.round(rect.left)} / right ${Math.round(rect.right)}`);
        }
      }
      const title = document.querySelector('.app-header-copy b, ion-header h1, ion-title');
      return {
        viewport,
        offenders: offenders.slice(0, 8),
        scrollWidth: document.documentElement.scrollWidth,
        titleWidth: Math.round(title?.getBoundingClientRect().width ?? 0),
      };
    });
    expect(report.viewport).toBe(320);
    expect(report.offenders, `320px 상단 바에서 화면 밖으로 나간 요소가 있다`).toEqual([]);
    expect(report.scrollWidth, `320px에서 가로 스크롤이 생긴다 (scrollWidth ${report.scrollWidth})`).toBeLessThanOrEqual(report.viewport + 1);
    expect(report.titleWidth, '화면 이름이 갱신 덩어리에 밀려 사라졌다').toBeGreaterThan(40);
  } finally {
    await teardown(harness);
  }
});

/**
 * 갱신 덩어리가 지금 칠하고 있는 색.
 *
 * "하드코딩이 아닌가"를 CSS 파일을 다시 읽어 확인하지 않는다 — 그것은 앱의 공식을 앱으로
 * 되풀이하는 자기충족이다. 대신 **테마를 실제로 바꿔서** 칠해진 값이 따라 바뀌는지 본다.
 * 안 바뀌면 그 색은 토큰에서 나온 값이 아니다.
 */
async function refreshPaint(page: Page): Promise<Record<string, string>> {
  const toggle = await autoSwitch(page);
  const button = await refreshButton(page);
  const one = (locator: Locator, key: string) => locator.evaluate((node, name) => {
    const style = getComputedStyle(node);
    return {
      [`${name}.bg`]: style.backgroundColor,
      [`${name}.border`]: style.borderTopColor,
      [`${name}.ink`]: style.color,
    } as Record<string, string>;
  }, key);
  return { ...(await one(toggle, '자동 갱신 스위치')), ...(await one(button, '새로고침 버튼')) };
}

test('갱신 덩어리에 하드코딩된 색이 없다 — 라이트↔다크에서 실제로 바뀐다', async ({ page }) => {
  const light = await boot(page, { theme: 'light', active: false });
  let lightPaint: Record<string, string>;
  try {
    lightPaint = await refreshPaint(page);
  } finally {
    await teardown(light);
  }

  const dark = await boot(page, { theme: 'dark', active: false });
  try {
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const darkPaint = await refreshPaint(page);

    // 투명(alpha 0)은 테마를 타지 않아도 되는 값이다 — 칠하지 않았다는 뜻이니 셈에서 뺀다.
    const painted = Object.keys(lightPaint).filter((key) => !/rgba\([^)]*,\s*0\)$/.test(lightPaint[key]));
    expect(painted.length, '갱신 덩어리에서 잰 색이 없다 — 게이트가 아무것도 재지 못했다').toBeGreaterThanOrEqual(3);

    const stuck = painted.filter((key) => lightPaint[key] === darkPaint[key]);
    expect.soft(
      stuck.map((key) => `${key} = ${lightPaint[key]} (라이트·다크 동일)`),
      `테마를 바꿔도 따라오지 않는 색이 ${stuck.length}개다 — 토큰이 아니라 손으로 박은 값이다`,
    ).toEqual([]);

    // 다크에 라이트 강조색(rgb(35,104,216))이 남아 있으면 이 덩어리만 혼자 파랗게 튄다.
    const leaks = Object.entries(darkPaint).filter(([, value]) => /rgba?\(\s*35,\s*104,\s*216/.test(value));
    expect.soft(
      leaks.map(([key, value]) => `${key} = ${value}`),
      `다크 화면에 라이트 강조색이 그대로 남아 있다`,
    ).toEqual([]);
  } finally {
    await teardown(dark);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. 파일 올리기 — 중간 화면 없이 곧바로
// ══════════════════════════════════════════════════════════════════════════════

/** 지금 화면을 차지하고 있는 큰 면·시트·모달의 서명. 클릭 전후를 견주는 기준이다. */
async function panelSignatures(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const helpers = window.__int36;
    const viewport = document.documentElement.clientWidth * document.documentElement.clientHeight;
    const found = new Set<string>();
    for (const node of helpers.walk(document.body)) {
      if (!helpers.painted(node)) continue;
      const rect = node.getBoundingClientRect();
      const isDialog = node.tagName === 'ION-MODAL' || node.tagName === 'DIALOG'
        || node.getAttribute('role') === 'dialog' || node.getAttribute('aria-modal') === 'true';
      if (!isDialog && rect.width * rect.height < viewport * 0.08) continue;
      const cls = typeof node.className === 'string' && node.className.trim()
        ? `.${node.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
      found.add(`${node.tagName.toLowerCase()}${cls}`);
    }
    return [...found];
  });
}

test('파일 올리기 카드는 중간 화면 없이 곧바로 OS 파일 선택창을 연다', async ({ page }) => {
  const harness = await boot(page, { active: false });
  try {
    const card = entryCard(page, 'upload');
    await expect(card).toBeVisible();
    const before = await panelSignatures(page);

    let chooserOpened = false;
    const chooser = page.waitForEvent('filechooser', { timeout: 4_000 }).then(() => { chooserOpened = true; }).catch(() => undefined);
    await card.click();
    await chooser;
    await page.waitForTimeout(700);

    const after = await panelSignatures(page);
    const appeared = after.filter((entry) => !before.includes(entry));

    expect.soft(
      chooserOpened,
      `\`파일 올리기\`를 눌렀는데 4초 안에 파일 선택창이 열리지 않았다. 대신 나타난 면: ${appeared.join(', ') || '(없음)'}`,
    ).toBe(true);
    expect.soft(
      appeared,
      `클릭과 파일 선택창 사이에 ${appeared.length}개의 면이 새로 나타났다 (0개여야 한다)`,
    ).toEqual([]);
  } finally {
    await teardown(harness);
  }
});

test('파일 선택창을 지나쳐도 막다른 곳이 없다 — 세 입구가 그대로 남는다', async ({ page }) => {
  const harness = await boot(page, { active: false });
  try {
    const card = entryCard(page, 'upload');
    const chooser = page.waitForEvent('filechooser', { timeout: 4_000 }).catch(() => undefined);
    await card.click();
    await chooser; // 아무 파일도 고르지 않는다 = 취소와 같은 상태다.
    await page.waitForTimeout(700);

    for (const key of ['camera', 'manual', 'upload'] as const) {
      const entry = entryCard(page, key);
      expect.soft(
        await entry.count(),
        `파일 선택을 취소했더니 \`${String(ENTRY_NAMES[key])}\` 입구가 사라졌다`,
      ).toBeGreaterThanOrEqual(1);
    }

    const report = await refreshReport(page);
    expect.soft(
      report.busy,
      `파일 선택을 취소했는데 진행 중 표시가 남았다: ${describeSurfaces(report.busy)}`,
    ).toEqual([]);
  } finally {
    await teardown(harness);
  }
});

test('명함 앞면 촬영은 여전히 전체 화면 촬영 모달로 이어진다', async ({ page }) => {
  const harness = await boot(page, { active: false });
  try {
    await entryCard(page, 'camera').click();
    await page.waitForTimeout(900);
    const measured = await page.evaluate(() => {
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = document.documentElement.clientHeight;
      let best: { where: string; width: number; height: number; top: number } | null = null;
      for (const node of window.__int36.walk(document.body)) {
        const isDialog = node.tagName === 'ION-MODAL' || node.tagName === 'DIALOG'
          || node.getAttribute('role') === 'dialog' || node.getAttribute('aria-modal') === 'true';
        if (!isDialog || !window.__int36.painted(node)) continue;
        const rect = node.getBoundingClientRect();
        if (!best || rect.width * rect.height > best.width * best.height) {
          best = { where: window.__int36.where(node), width: Math.round(rect.width), height: Math.round(rect.height), top: Math.round(rect.top) };
        }
      }
      return { viewportWidth, viewportHeight, best };
    });
    expect(measured.best, '촬영 카드를 눌렀는데 모달이 열리지 않았다').not.toBeNull();
    expect(
      measured.best!.width / measured.viewportWidth,
      `촬영 모달이 화면 폭을 다 쓰지 않는다 (${measured.best!.width} / ${measured.viewportWidth}px)`,
    ).toBeGreaterThanOrEqual(0.9);
    expect(
      measured.best!.height / measured.viewportHeight,
      `촬영 모달이 전체 화면이 아니다 (${measured.best!.height} / ${measured.viewportHeight}px)`,
    ).toBeGreaterThanOrEqual(0.85);
  } finally {
    await teardown(harness);
  }
});

test('직접 입력은 여전히 아래에서 올라오는 시트로 이어진다', async ({ page }) => {
  const harness = await boot(page, { active: false });
  try {
    /* 시트가 **아래에서** 오는지는 class 이름으로 알 수 없다. 여는 동안의 위치를 프레임마다 찍는다.
       transform은 shadow DOM 안 wrapper에 걸리므로 host의 rect만 보면 아무 움직임도 안 보인다.
       그렇다고 "칠해진 큰 면"을 쫓으면 **backdrop**이 걸린다 — 그것은 전체 화면을 덮고 움직이지
       않아서 첫 판이 매 프레임 `top = 0`을 읽었다(움직임 0px). 그래서 **글자를 가진 요소**의
       가장 위 가장자리를 쫓는다. backdrop에는 글자가 없고, 시트의 내용은 wrapper와 함께 움직인다. */
    await page.evaluate(() => {
      const samples: Array<{ t: number; top: number }> = [];
      window.__int36motion = samples;
      const start = performance.now();
      const step = () => {
        let top: number | null = null;
        for (const node of window.__int36.walk(document.body)) {
          const isDialog = node.tagName === 'ION-MODAL' || node.tagName === 'DIALOG'
            || node.getAttribute('role') === 'dialog' || node.getAttribute('aria-modal') === 'true';
          if (!isDialog) continue;
          if (getComputedStyle(node).display === 'none') continue;
          for (const inner of window.__int36.walk(node)) {
            const own = Array.from(inner.childNodes).filter((leaf) => leaf.nodeType === 3)
              .map((leaf) => leaf.textContent ?? '').join('').trim();
            if (!own) continue;
            const style = getComputedStyle(inner);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            const rect = inner.getBoundingClientRect();
            if (rect.width < 2 || rect.height < 2) continue;
            top = top === null ? rect.top : Math.min(top, rect.top);
          }
        }
        if (top !== null) samples.push({ t: Math.round(performance.now() - start), top: Math.round(top) });
        if (performance.now() - start < 1_400) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });

    await entryCard(page, 'manual').click();
    await page.waitForTimeout(1_600);
    const motion = await page.evaluate(() => window.__int36motion ?? []);
    const viewportHeight = page.viewportSize()!.height;

    expect(motion.length, '시트가 열리는 동안 아무 프레임도 못 찍었다 — 시트가 열리지 않았거나 면을 못 찾았다').toBeGreaterThanOrEqual(3);
    const first = motion[0];
    const last = motion[motion.length - 1];
    expect.soft(
      first.top,
      `시트가 처음 나타난 위치가 화면 위쪽 ${first.top}px다 — 아래에서 올라오는 전환이 아니다 (화면 높이 ${viewportHeight}px)`,
    ).toBeGreaterThanOrEqual(viewportHeight * 0.6);
    expect.soft(
      first.top - last.top,
      `시트가 여는 동안 세로로 ${first.top - last.top}px밖에 움직이지 않았다 (${first.top}px → ${last.top}px)`,
    ).toBeGreaterThanOrEqual(80);
    expect.soft(
      last.top,
      `다 열린 시트가 화면 맨 위(${last.top}px)까지 올라와 전체 화면처럼 보인다 — 시트가 아니라 모달이다`,
    ).toBeGreaterThan(0);
  } finally {
    await teardown(harness);
  }
});

test('세 입구 카드는 같은 해부를 쓰고 같은 줄에서 정렬이 맞는다', async ({ page }) => {
  const harness = await boot(page, { active: false });
  try {
    for (const key of ['camera', 'manual', 'upload'] as const) {
      await expect(entryCard(page, key), `\`${String(ENTRY_NAMES[key])}\` 입구가 없다`).toBeVisible();
    }
    const cards = await page.evaluate(() => {
      const names = ['명함 앞면 촬영', '직접 입력', '올리기'];
      const buttons = Array.from(document.querySelectorAll<HTMLElement>('button'))
        .filter((node) => names.some((name) => (node.textContent ?? '').includes(name)))
        .filter((node) => window.__int36.painted(node));
      return buttons.map((card) => {
        const rect = card.getBoundingClientRect();
        const rows = Array.from(card.querySelectorAll<HTMLElement>('*'))
          .filter((child) => Array.from(child.childNodes).some((leaf) => leaf.nodeType === 3 && (leaf.textContent ?? '').trim()))
          .map((child) => {
            const style = getComputedStyle(child);
            const box = child.getBoundingClientRect();
            return {
              text: (child.textContent ?? '').trim().slice(0, 24),
              fontSize: Math.round(Number.parseFloat(style.fontSize) * 10) / 10,
              fontWeight: Number.parseInt(style.fontWeight, 10),
              top: Math.round(box.top - rect.top),
            };
          })
          .sort((a, b) => a.top - b.top);
        return {
          label: (card.textContent ?? '').trim().slice(0, 12),
          top: Math.round(rect.top),
          height: Math.round(rect.height),
          width: Math.round(rect.width),
          rows,
          hasIcon: Boolean(card.querySelector('svg')),
        };
      });
    });

    expect(cards.length, `진입 카드가 ${cards.length}개다 (셋이어야 한다)`).toBe(3);
    for (const card of cards) {
      expect.soft(card.hasIcon, `${card.label}: 아이콘이 없다`).toBe(true);
      expect.soft(card.rows.length, `${card.label}: 글자 줄이 ${card.rows.length}개다 (아이콘·제목·한 줄 설명·다음 동작의 세 줄이어야 한다) — ${JSON.stringify(card.rows.map((row) => row.text))}`).toBe(3);
    }
    const sameRow = cards.filter((card) => Math.abs(card.top - cards[0].top) <= 2);
    expect(sameRow.length, `첫 줄에 선 카드가 ${sameRow.length}개다`).toBeGreaterThanOrEqual(2);
    expect.soft(
      Math.abs(sameRow[0].height - sameRow[1].height),
      `같은 줄의 두 카드 높이가 ${sameRow[0].height}px vs ${sameRow[1].height}px로 어긋났다`,
    ).toBeLessThanOrEqual(2);
    for (let index = 0; index < Math.min(sameRow[0].rows.length, sameRow[1].rows.length); index += 1) {
      expect.soft(
        sameRow[1].rows[index].fontSize,
        `${index}번째 줄의 글자 크기가 카드마다 다르다 (${sameRow[0].rows[index].fontSize}px vs ${sameRow[1].rows[index].fontSize}px)`,
      ).toBe(sameRow[0].rows[index].fontSize);
      expect.soft(
        sameRow[1].rows[index].fontWeight,
        `${index}번째 줄의 글자 굵기가 카드마다 다르다 (${sameRow[0].rows[index].fontWeight} vs ${sameRow[1].rows[index].fontWeight})`,
      ).toBe(sameRow[0].rows[index].fontWeight);
    }
  } finally {
    await teardown(harness);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. 조사 깊이 — 처음부터 조건 없이
// ══════════════════════════════════════════════════════════════════════════════

/** 세 깊이 칸의 지금 상태. `disabled`·`aria-disabled`·`data-unavailable`을 모두 본다. */
async function depthState(page: Page, scope?: Locator): Promise<Array<{ label: string; enabled: boolean; checked: boolean; why: string }>> {
  const group = depthGroup(scope ?? page);
  return group.evaluate((root) => {
    const radios = Array.from(root.querySelectorAll<HTMLElement>('[role="radio"], input[type="radio"]'));
    return radios.map((radio) => {
      const container = radio.closest('label') ?? radio.parentElement ?? radio;
      const input = radio as HTMLInputElement;
      const ariaDisabled = radio.getAttribute('aria-disabled') === 'true' || container.getAttribute('aria-disabled') === 'true';
      const unavailable = container.getAttribute('data-unavailable') === 'yes' || container.getAttribute('data-unavailable') === 'true';
      const nativeDisabled = Boolean(input.disabled);
      const label = (container.textContent ?? '').replace(/\s+/g, ' ').trim();
      return {
        label: label.slice(0, 40),
        enabled: !nativeDisabled && !ariaDisabled,
        checked: input.checked === true || radio.getAttribute('aria-checked') === 'true',
        why: [nativeDisabled ? 'disabled' : '', ariaDisabled ? 'aria-disabled' : '', unavailable ? 'data-unavailable' : ''].filter(Boolean).join('+'),
      };
    });
  });
}

test('앱을 열자마자, 목록 응답이 도착하기 전에 세 깊이가 모두 고를 수 있다', async ({ page }) => {
  const harness = await boot(page, { active: false, reopenWithHeldList: true });
  try {
    // 응답을 붙잡아 둔 채로 잰다 — 앱은 서버에서 아무것도 못 들은 상태다.
    // 요청이 실제로 떠서 붙잡힌 것을 먼저 기다린다. 한 번만 읽으면 앱이 화면을 먼저 그리고
    // 요청을 나중에 보내는 순서일 때 아직 0이라, 제품과 무관하게 게이트가 빨개진다
    // (수정 전 실측: 10회 중 3회). 이 파일의 다른 여섯 자리는 전부 이미 poll을 쓴다.
    await expect
      .poll(() => harness.listInFlight, { timeout: 10_000 })
      .toBeGreaterThan(0);
    const group = depthGroup(page);
    await expect(group, '목록 응답이 오기 전에는 조사 깊이 자리가 아예 없다').toHaveCount(1, { timeout: 10_000 });
    expect(harness.listInFlight, '읽는 사이에 응답이 도착했다 — 관측 창이 너무 좁다').toBeGreaterThan(0);

    const states = await depthState(page);
    expect(states.length, `깊이 칸이 ${states.length}개다 (셋이어야 한다)`).toBe(3);
    const blocked = states.filter((state) => !state.enabled);
    expect.soft(
      blocked.map((state) => `${state.label} (${state.why})`),
      `목록 응답이 오기 전에 고를 수 없는 깊이가 ${blocked.length}개다`,
    ).toEqual([]);

    // 새 요청은 `일반 조사`에서 시작하고, 그 자리에서 바로 다른 깊이로 바꿀 수 있다.
    const started = states.find((state) => state.checked);
    expect.soft(started?.label ?? '(없음)', `새 요청이 시작한 깊이가 \`일반 조사\`가 아니다`).toContain('일반 조사');

    for (const label of ['빠른 조사', '깊은 조사'] as const) {
      await chooseDepth(page, label);
      const after = await depthState(page);
      const now = after.find((state) => state.checked);
      expect.soft(
        now?.label ?? '(없음)',
        `목록 응답 전에 \`${label}\`로 바꿀 수 없다 (지금 고른 것: ${now?.label ?? '(없음)'})`,
      ).toContain(label);
    }
  } finally {
    await teardown(harness);
  }
});

test('서버가 깊은 조사를 닫아 뒀다고 말해도 고르는 것은 막히지 않고 제출이 막힌다', async ({ page }) => {
  const harness = await boot(page, { active: false, deepOpen: false });
  try {
    const group = depthGroup(page);
    await expect(group).toHaveCount(1);
    const states = await depthState(page);
    const deep = states.find((state) => state.label.includes('깊은 조사'));
    expect(deep, '깊은 조사 칸이 사라졌다 — 없어진 선택지는 고장으로 읽힌다').toBeTruthy();
    expect.soft(
      `${deep!.enabled} (${deep!.why || '열림'})`,
      `서버가 닫아 뒀다는 이유로 \`깊은 조사\`를 고르는 것 자체가 막혔다`,
    ).toBe('true (열림)');

    await chooseDepth(page, '깊은 조사');
    const afterClick = await depthState(page);
    const deepChosen = afterClick.find((state) => state.label.includes('깊은 조사'))?.checked === true;

    // 왜 지금 안 되는지는 **지속 상태**로 읽혀야 한다 — "잠시 뒤에 된다"는 지키지 못할 약속이다.
    const explanation = await page.evaluate(() => {
      const helpers = window.__int36;
      return helpers.walk(document.body)
        .filter((node) => helpers.announced(node))
        .map((node) => helpers.text(node))
        .filter((value) => /깊은 조사/.test(value) && /못|없|않|닫|꺼/.test(value))
        .sort((a, b) => a.length - b.length)
        .slice(0, 3);
    });
    expect.soft(explanation.length, '깊은 조사가 왜 지금 안 되는지 말하는 문장이 없다').toBeGreaterThan(0);
    const joined = explanation.join(' / ');
    expect.soft(
      /잠시|곧|잠깐|이따|나중에 다시|준비 중|기다려/.test(joined),
      `이유가 "잠시 뒤에 가능하다"는 지연처럼 읽힌다: "${joined}"`,
    ).toBe(false);
    expect.soft(
      /지금은|열어 두지 않|받을 수 없|사용할 수 없|꺼져|닫혀/.test(joined),
      `이유가 "지금 꺼져 있다"는 지속 상태로 읽히지 않는다: "${joined}"`,
    ).toBe(true);

    if (!deepChosen) {
      // 고를 수조차 없으면 제출 차단은 잴 수 없다. 위 soft 실패가 이미 그 사실을 말한다.
      expect.soft(deepChosen, '깊은 조사를 고를 수 없어 "제출만 막힌다"를 확인할 수 없었다').toBe(true);
      return;
    }

    const before = harness.submitted.length;
    await openPersonResearch(page);
    const sheet = page.locator('ion-modal').filter({ hasText: 'AI 조사 요청' }).first();
    await chooseDepth(sheet, '깊은 조사');
    await sheet.locator('ion-textarea textarea').first().fill('공개 경력을 확인해 주세요');
    await sheet.getByRole('button', { name: /조사 요청 접수|접수/ }).first().click();
    await page.waitForTimeout(800);
    expect.soft(
      harness.submitted.length - before,
      `깊은 조사가 닫혀 있는데 요청이 ${harness.submitted.length - before}건 나갔다`,
    ).toBe(0);
  } finally {
    await teardown(harness);
  }
});

/** 인물 시트의 `AI 조사 요청` 작성 자리를 연다 — 여기 제출 버튼은 사진 없이도 누를 수 있다. */
async function openPersonResearch(page: Page): Promise<void> {
  await page.getByRole('button', { name: '진행', exact: true }).click();
  await page.locator('.brief-summary').filter({ hasText: '김민서' }).first().click();
  await page.locator('.brief-detail').getByRole('button', { name: 'AI 조사 요청' }).first().click();
  await expect(page.locator('ion-modal').filter({ hasText: 'AI 조사 요청' }).first()).toBeVisible();
  // 올라오는 시트 위의 요소는 `not stable`이라 클릭을 못 받는다. 전환이 끝난 뒤에 손을 댄다.
  await page.waitForTimeout(700);
}

test('깊은 조사 + 범위 0개 제출은 막히고, 범위를 하나 고르면 즉시 풀린다', async ({ page }) => {
  const harness = await boot(page, { active: false, deepOpen: true });
  try {
    await openPersonResearch(page);
    const sheet = page.locator('ion-modal').filter({ hasText: 'AI 조사 요청' }).first();
    await chooseDepth(sheet, '깊은 조사');
    await sheet.locator('ion-textarea textarea').first().fill('의사결정 권한을 확인해 주세요');

    const submit = sheet.getByRole('button', { name: /조사 요청 접수|접수/ }).first();
    await submit.click();
    await page.waitForTimeout(700);

    expect.soft(harness.submitted.length, `범위 0개인 깊은 조사가 서버로 ${harness.submitted.length}건 나갔다`).toBe(0);

    const recovery = await page.evaluate(() => {
      const helpers = window.__int36;
      let active: Element | null = document.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      const chain = active ? helpers.chain(active) : [];
      const scopeRegion = helpers.walk(document.body).find((node) => {
        const label = node.getAttribute('aria-label') ?? '';
        return /조사 범위|조사 항목/.test(label) && helpers.painted(node);
      }) ?? null;
      const composer = helpers.walk(document.body).find((node) => node.getAttribute('role') === 'radiogroup'
        && helpers.text(node).includes('깊은 조사')) ?? null;
      const composerRoot = composer ? helpers.chain(composer).find((node) => helpers.text(node).includes('AI 조사 요청')) ?? null : null;
      return {
        focused: active ? helpers.where(active) : '(없음)',
        focusedText: active ? helpers.text(active).slice(0, 90) : '',
        inScopeRegion: Boolean(scopeRegion && active && (scopeRegion === active || chain.includes(scopeRegion))),
        inComposer: Boolean(composerRoot && active && (composerRoot === active || chain.includes(composerRoot))),
      };
    });

    expect.soft(recovery.inComposer, `막혔는데 focus가 작성 자리 밖에 있다 (지금: ${recovery.focused})`).toBe(true);
    expect.soft(
      recovery.inScopeRegion,
      `막혔을 때 focus가 범위 영역으로 가지 않았다 (지금: ${recovery.focused} "${recovery.focusedText}")`,
    ).toBe(true);
    expect.soft(
      /범위|항목|고르|선택/.test(recovery.focusedText),
      `막힌 자리가 무엇을 하면 풀리는지 말하지 않는다: "${recovery.focusedText}"`,
    ).toBe(true);

    // 깊이를 몰래 낮추지 않는다.
    const stillDeep = (await depthState(page, sheet)).find((state) => state.checked)?.label ?? '(없음)';
    expect.soft(stillDeep, `막히면서 고른 깊이가 조용히 바뀌었다 (지금: ${stillDeep})`).toContain('깊은 조사');

    // 범위를 하나 고르면 즉시 풀린다 — 풀린 증거는 문구가 아니라 **실제로 나간 요청**이다.
    await sheet.getByRole('button', { name: /모두 선택/ }).first().click();
    await submit.click();
    await expect
      .poll(() => harness.submitted.length, { timeout: 10_000, message: '범위를 골랐는데도 요청이 나가지 않는다' })
      .toBe(1);
  } finally {
    await teardown(harness);
  }
});

/** 사용자에게 절대 나타나면 안 되는 말 — 내부 binding + 흔한 공급자·모델 이름. */
const FORBIDDEN_LATIN = ['luna', 'terra', 'sol', 'gpt', 'claude', 'gemini', 'llama', 'mistral', 'opus', 'sonnet', 'haiku', 'anthropic', 'openai'];
const FORBIDDEN_KOREAN = ['모델', '엔진', '공급자'];
const TEXTUAL_ATTRIBUTES = ['aria-label', 'aria-description', 'aria-placeholder', 'aria-roledescription', 'aria-valuetext', 'title', 'placeholder', 'alt'];

test('화면·접근성 이름·속성 어디에도 model·provider 이름이 없다', async ({ page }) => {
  const harness = await boot(page, { active: false, deepOpen: true });
  try {
    // 상태를 다 펼쳐 놓고 훑는다 — 접힌 자리에 숨어 있으면 검사가 헛돈다.
    await page.getByRole('button', { name: /모두 선택/ }).first().click();
    await chooseDepth(page, '깊은 조사');

    const scan = async () => page.evaluate(({ latin, korean, attributes }) => {
      const hits: string[] = [];
      const check = (where: string, value: string) => {
        const text = (value ?? '').trim();
        if (!text) return;
        for (const needle of latin) {
          if (new RegExp(`\\b${needle}\\b`, 'i').test(text)) hits.push(`${needle} @ ${where}: ${text.slice(0, 40)}`);
        }
        for (const needle of korean) {
          if (text.includes(needle)) hits.push(`${needle} @ ${where}: ${text.slice(0, 40)}`);
        }
      };
      check('body', document.body.innerText);
      for (const element of window.__int36.walk(document.body)) {
        for (const attribute of attributes) {
          const value = element.getAttribute(attribute);
          if (value) check(`${element.tagName.toLowerCase()}[${attribute}]`, value);
        }
        // shadow DOM 안의 글자는 `innerText`에 없다 — toast·모달 내부가 통째로 사각지대다.
        const owned = Array.from(element.childNodes).filter((node) => node.nodeType === 3)
          .map((node) => node.textContent ?? '').join(' ').trim();
        if (owned && element.getRootNode() !== document) check(`${element.tagName.toLowerCase()}(shadow)`, owned);
      }
      return hits;
    }, { latin: FORBIDDEN_LATIN, korean: FORBIDDEN_KOREAN, attributes: TEXTUAL_ATTRIBUTES });

    // 먼저 이 검사가 **실제로 잡는지** 확인한다. 통과만 하는 검사는 검사가 아니다.
    await page.evaluate(() => {
      const bait = document.createElement('p');
      bait.id = 'int36-name-leak-bait';
      bait.textContent = '깊은 조사는 Sol 모델로 처리합니다';
      document.body.appendChild(bait);
    });
    expect(await scan(), '이름 유출 검사가 일부러 넣은 오염을 못 잡는다 — 이 검사는 아무것도 재지 못한다').not.toEqual([]);
    await page.evaluate(() => document.getElementById('int36-name-leak-bait')?.remove());

    const leaks = await scan();
    expect(leaks, `사용자 화면에 내부 이름이 보인다: ${leaks.join(' / ')}`).toEqual([]);
  } finally {
    await teardown(harness);
  }
});

test('서버 설정 이름·오류 코드가 사용자 화면에 없다', async ({ page }) => {
  const harness = await boot(page, { active: false, deepOpen: false });
  try {
    await chooseDepth(page, '깊은 조사');
    const screen = await page.evaluate(() => {
      const helpers = window.__int36;
      const own = helpers.walk(document.body)
        .filter((node) => helpers.announced(node))
        .map((node) => Array.from(node.childNodes).filter((leaf) => leaf.nodeType === 3).map((leaf) => leaf.textContent ?? '').join(' '))
        .join('\n');
      return `${document.body.innerText}\n${own}`.toLowerCase();
    });
    for (const leak of ['deep_research', 'deep_feature_disabled', 'bad_research_request', 'script', 'enabled']) {
      expect.soft(screen.includes(leak), `화면에 서버 설정 이름·오류 코드가 있다: ${leak}`).toBe(false);
    }
  } finally {
    await teardown(harness);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 가로지르는 판정
// ══════════════════════════════════════════════════════════════════════════════

test('320 / 390 / 1280px에서 세 표면 어디에도 가로 넘침이 없다', async ({ page }) => {
  const harness = await boot(page, { active: false });
  try {
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: width === 1280 ? 800 : 844 });
      await page.waitForTimeout(350);
      const report = await page.evaluate(() => {
        const viewport = document.documentElement.clientWidth;
        const offenders: string[] = [];
        for (const node of window.__int36.walk(document.body)) {
          if (!window.__int36.painted(node)) continue;
          const rect = node.getBoundingClientRect();
          if (rect.right <= viewport + 1 && rect.left >= -1) continue;
          offenders.push(`${window.__int36.where(node)} → ${Math.round(rect.left)}…${Math.round(rect.right)}`);
        }
        return { viewport, scrollWidth: document.documentElement.scrollWidth, offenders: offenders.slice(0, 6) };
      });
      expect.soft(report.offenders, `${width}px에서 화면 밖으로 나간 요소가 있다`).toEqual([]);
      expect.soft(
        report.scrollWidth,
        `${width}px에서 가로 스크롤이 생긴다 (scrollWidth ${report.scrollWidth} > viewport ${report.viewport})`,
      ).toBeLessThanOrEqual(report.viewport + 1);
    }
  } finally {
    await teardown(harness);
  }
});

test('다크 모드에서 세 표면의 렌더된 글자 대비가 WCAG 기준을 넘는다', async ({ page }) => {
  const harness = await boot(page, { theme: 'dark', active: false });
  try {
    const measured = await page.evaluate(() => {
      const helpers = window.__int36;
      type Rgba = [number, number, number, number];
      const over = (front: Rgba, back: Rgba): Rgba => {
        const alpha = front[3];
        return [
          front[0] * alpha + back[0] * (1 - alpha),
          front[1] * alpha + back[1] * (1 - alpha),
          front[2] * alpha + back[2] * (1 - alpha),
          1,
        ];
      };
      const luminance = (color: Rgba): number => {
        const channel = (value: number) => {
          const scaled = value / 255;
          return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel(color[0]) + 0.7152 * channel(color[1]) + 0.0722 * channel(color[2]);
      };
      const ratio = (a: Rgba, b: Rgba): number => {
        const first = luminance(a);
        const second = luminance(b);
        return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
      };

      /* 배경은 조상을 타고 올라가며 합성한다. gradient는 **건너뛰지 않고** 색 정지점 중
         가장 불리한 값을 쓴다 — 스킵이 늘면 게이트가 조용히 아무것도 검사하지 않게 된다. */
      const backgroundOf = (element: Element): { color: Rgba | null; note: string } => {
        let accumulated: Rgba | null = null;
        for (const step of helpers.chain(element)) {
          const style = getComputedStyle(step);
          let layer: Rgba | null = null;
          if (style.backgroundImage && style.backgroundImage !== 'none') {
            const stops = helpers.colorsIn(style.backgroundImage) as Rgba[];
            if (stops.length === 0) return { color: null, note: `배경 이미지(${style.backgroundImage.slice(0, 24)})` };
            layer = stops.reduce((worst, stop) => (luminance(stop) > luminance(worst) ? stop : worst), stops[0]);
          }
          const flat = (helpers.colorsIn(style.backgroundColor) as Rgba[])[0] ?? null;
          if (flat && flat[3] > 0) layer = layer ? over(layer, flat) : flat;
          if (!layer || layer[3] === 0) continue;
          accumulated = accumulated ? over(accumulated, layer) : layer;
          if (accumulated[3] >= 0.999) return { color: accumulated, note: '' };
        }
        const bodyColor = (helpers.colorsIn(getComputedStyle(document.body).backgroundColor) as Rgba[])[0];
        const base: Rgba = bodyColor && bodyColor[3] > 0 ? bodyColor : [0, 0, 0, 1];
        return { color: accumulated ? over(accumulated, base) : base, note: '' };
      };

      /* 세 표면의 뿌리를 찾는다 — 상단 갱신 덩어리 · 진입 카드 · 조사 작성 자리.
         진입 카드의 뿌리는 **세 카드를 모두 담는 가장 가까운 조상**으로 올라가서 잡는다.
         첫 판은 `document.querySelector('button').parentElement`를 썼는데, 문서에서 첫 `<button>`은
         상단 바의 자동 갱신 스위치라 그 뿌리가 header가 됐다 — 게이트가 header를 두 번 재고
         진입 카드는 한 번도 안 재면서 통과했다. */
      const header = document.querySelector('ion-header');
      const entryNames = ['명함 앞면 촬영', '직접 입력', '올리기'];
      const cards = Array.from(document.querySelectorAll<HTMLElement>('button'))
        .filter((node) => entryNames.some((name) => (node.textContent ?? '').includes(name)));
      let entry: Element | null = null;
      if (cards.length >= 2) {
        entry = helpers.chain(cards[0]).find((step) => cards.every((card) => step === card || step.contains(card))) ?? null;
      }
      const depth = helpers.walk(document.body).find((node) => node.getAttribute('role') === 'radiogroup'
        && helpers.text(node).includes('깊은 조사')) ?? null;
      const composer = depth ? helpers.chain(depth).find((node) => helpers.text(node).includes('AI 조사 요청')) ?? null : null;
      const roots = [header, entry, composer].filter(Boolean) as Element[];

      const checked: Array<{ where: string; ratio: number; need: number; text: string }> = [];
      const skipped: string[] = [];
      for (const root of roots) {
        for (const node of [root, ...helpers.walk(root)]) {
          const own = Array.from(node.childNodes).filter((leaf) => leaf.nodeType === 3)
            .map((leaf) => leaf.textContent ?? '').join(' ').trim();
          if (!own) continue;
          if (!helpers.painted(node)) continue;
          const style = getComputedStyle(node);
          const ink = (helpers.colorsIn(style.color) as Rgba[])[0];
          if (!ink) { skipped.push(`${helpers.where(node)} — 글자색을 못 읽음(${style.color})`); continue; }
          const background = backgroundOf(node);
          if (!background.color) { skipped.push(`${helpers.where(node)} — ${background.note}`); continue; }
          const front = ink[3] < 1 ? over(ink, background.color) : ink;
          const size = Number.parseFloat(style.fontSize);
          const weight = Number.parseInt(style.fontWeight, 10) || 400;
          const large = size >= 24 || (size >= 18.66 && weight >= 700);
          checked.push({
            where: helpers.where(node),
            ratio: Math.round(ratio(front, background.color) * 100) / 100,
            need: large ? 3 : 4.5,
            text: own.slice(0, 30),
          });
        }
      }
      return { checked, skipped, roots: roots.length };
    });

    expect(measured.roots, `대비를 잴 표면을 ${measured.roots}개밖에 못 찾았다 (셋이어야 한다)`).toBe(3);
    expect(
      measured.checked.length,
      `대비를 실제로 잰 글자가 ${measured.checked.length}개뿐이다 — 게이트가 아무것도 검사하지 않는 상태다`,
    ).toBeGreaterThanOrEqual(20);
    expect(
      measured.skipped.length,
      `계산 불가로 건너뛴 요소가 ${measured.skipped.length}개다 (상한 15개): ${measured.skipped.slice(0, 8).join(' | ')}`,
    ).toBeLessThanOrEqual(15);

    const failures = measured.checked.filter((entry) => entry.ratio < entry.need);
    expect.soft(
      failures.map((entry) => `${entry.where} "${entry.text}" = ${entry.ratio}:1 (필요 ${entry.need}:1)`),
      `다크 모드에서 대비가 모자란 글자가 ${failures.length}개다 (총 ${measured.checked.length}개 측정)`,
    ).toEqual([]);
  } finally {
    await teardown(harness);
  }
});

test('움직임을 끈 기기에서도 진행·선택 상태를 읽을 수 있다', async ({ page }) => {
  const harness = await boot(page, { active: false, reducedMotion: true });
  try {
    const button = await refreshButton(page);
    const idle = await button.evaluate((node) => {
      const style = getComputedStyle(node);
      return `${style.backgroundColor}|${style.borderTopColor}|${style.color}`;
    });

    harness.delayList(2_500);
    await button.click();
    await expect.poll(() => harness.listInFlight, { timeout: 5_000 }).toBeGreaterThan(0);
    const busy = await button.evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        paint: `${style.backgroundColor}|${style.borderTopColor}|${style.color}`,
        looping: node.getAnimations({ subtree: true })
          .filter((animation) => animation.playState === 'running'
            && (animation.effect?.getComputedTiming().iterations ?? 1) === Number.POSITIVE_INFINITY).length,
      };
    });
    expect.soft(busy.looping, `움직임을 끈 기기에서도 무한 애니메이션이 ${busy.looping}개 돈다`).toBe(0);
    expect.soft(busy.paint, `회전이 꺼지자 "진행 중"을 알 방법이 사라졌다 — 정지 상태로도 구별돼야 한다 (평상시와 같은 값: ${idle})`).not.toBe(idle);

    harness.delayList(0);
    await expect.poll(() => harness.listInFlight, { timeout: 8_000 }).toBe(0);

    // 고른 깊이도 움직임 없이 읽혀야 한다 — 고른 칸과 안 고른 칸이 정지 화면에서 달라야 한다.
    const depths = await depthGroup(page).evaluate((root) => {
      const containers = Array.from(root.querySelectorAll<HTMLElement>('[role="radio"], input[type="radio"]'))
        .map((radio) => ({ radio, box: (radio.closest('label') ?? radio.parentElement ?? radio) as HTMLElement }));
      return containers.map(({ radio, box }) => {
        const style = getComputedStyle(box);
        return {
          label: (box.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 20),
          checked: (radio as HTMLInputElement).checked === true || radio.getAttribute('aria-checked') === 'true',
          paint: `${style.backgroundColor}|${style.borderTopColor}|${style.color}|${style.fontWeight}|${style.boxShadow}`,
        };
      });
    });
    const chosen = depths.find((entry) => entry.checked);
    const others = depths.filter((entry) => !entry.checked);
    expect(chosen, '고른 깊이가 없다').toBeTruthy();
    expect(others.length, '안 고른 깊이가 없다 — 비교할 대상이 없다').toBeGreaterThan(0);
    for (const other of others) {
      expect.soft(
        other.paint,
        `움직임 없이 보면 \`${chosen!.label}\`(고름)과 \`${other.label}\`(안 고름)이 똑같이 보인다: ${chosen!.paint}`,
      ).not.toBe(chosen!.paint);
    }
  } finally {
    await teardown(harness);
  }
});

test('세 표면을 오가는 동안 콘솔 오류가 0건이다', async ({ page }) => {
  const noise: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') noise.push(`console: ${message.text()}`); });
  page.on('pageerror', (error) => noise.push(`pageerror: ${error.message}`));

  const harness = await boot(page, { active: false });
  try {
    const button = await refreshButton(page);
    await button.click();
    await (await autoSwitch(page)).click();
    await chooseDepth(page, '깊은 조사');
    await page.getByRole('button', { name: /모두 선택/ }).first().click();
    await entryCard(page, 'manual').click();
    await page.waitForTimeout(900);
    await page.getByRole('button', { name: /^(닫기|취소)$/ }).first().click();
    await page.waitForTimeout(500);

    /* 자산 abort는 이 게이트의 대상이 아니다 (카메라·OCR vendor 파일을 일부러 끊는다).
       그 밖의 오류는 전부 보고한다 — 무엇을 걸렀는지도 함께 남긴다. */
    const ignored = noise.filter((line) => /vendor|net::ERR_FAILED|net::ERR_ABORTED|Failed to load resource/.test(line));
    const real = noise.filter((line) => !ignored.includes(line));
    expect(real, `콘솔 오류 ${real.length}건 (자산 abort ${ignored.length}건은 제외했다)`).toEqual([]);
  } finally {
    await teardown(harness);
  }
});
