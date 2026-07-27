import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// 회귀 게이트: 이전 앱(`docs/legacy.html`)은 **촬영·업로드·전송 상태**만 하는 화면이다.
// owner 기능(조사 지시·브리핑 열람·Person 전문·인맥 검색·사후 메모·수정 요청)은 화면에서
// 숨긴 것이 아니라 **코드에서 없앤다**.
//
// 이 게이트의 전제는 하나다 — "버튼이 안 보인다"와 "호출할 수 없다"는 다르다.
// 숨긴 버튼은 함수를 남기고, 남은 함수는 콘솔 한 줄로 owner action을 그대로 부른다.
// 그래서 이 파일은 UI 부재가 아니라 **호출 가능성**을 판정한다:
//   1) 진입점 함수가 전역에 존재하지 않는다
//   2) owner 권한을 다 열어 준 서버 응답을 받고, 남은 코드로 직접 호출을 시도해도 wire에 안 나간다
//   3) 인라인 핸들러로 우회할 수 없게 소스에 action 문자열 자체가 없다
// 동시에 남겨야 할 것(촬영 → 대기열 → 업로드, 전송·처리 상태, 다시 처리 요청)이 그대로임을 고정한다.
//
// Kairen-Ref: TSK-000301

const buildRoot = resolve(fileURLToPath(new URL('../../docs/', import.meta.url)));

/** 빌드에 박힌 유일한 신뢰 API origin — `docs/legacy.html` 의 DEFAULT_API 와 같은 origin. */
const PINNED_ORIGIN = 'https://script.google.com';
/** 명백히 가짜인 테스트 값. 실토큰은 어떤 경우에도 쓰지 않는다. */
const FAKE_TOKEN = 'e2e-fake-token-not-a-real-credential';

/** founder 결정으로 이전 앱에서 제거된 owner action. 하나라도 wire에 나오면 축소가 안 된 것이다. */
const REMOVED_ACTIONS = ['researchinstruction', 'persondoc', 'doc', 'search', 'addnote', 'correction'] as const;

/**
 * 제거된 기능의 진입점. 전역 함수 선언이라 남아 있으면 `window.<이름>` 으로 그대로 호출된다 —
 * 이것이 "숨겼다"와 "없앴다"를 가르는 실제 판정 대상이다.
 */
const REMOVED_ENTRY_POINTS = [
  'addNoteFlow', 'requestCorrection', 'openPersonDoc', 'openPersonDocById', 'runSearch',
  'researchInstructionFlow', 'closeResearchInstruction', 'canUseResearchInstruction',
  'applyResearchCapability', 'setContextInputTab', 'renderBriefs', 'renderPersonMd', 'prepCardOf',
  'contactRow', 'vcardDownload', 'contactsFromBrief', 'parseFm', 'mdLite', 'mdTable', 'mdInline',
  'briefNameMap', 'nameFromBrief', 'toggleSearchUI', 'renderRecentSearches', 'pushRecentSearch',
] as const;

/** 이 문장이 화면이나 저장소에 나타나면 브리핑 본문이 아직 열람 가능한 것이다. */
const BRIEF_BODY = '합성 브리핑 본문 — 이 문장은 이전 앱에 나타나면 안 된다.';
const SYNTHETIC_PERSON_MD = '---\nname: 합성 담당자\n---\n# 합성 담당자\n합성 Person 전문 본문.';

/** 서버가 owner 권한을 **전부 열어 준** 응답. 축소가 진짜면 이걸 받아도 owner 기능이 살아나지 않는다. */
function ownerList(): unknown {
  const now = Date.now();
  const recent = new Date(now - 2 * 60_000).toISOString();
  const late = new Date(now - 41 * 60_000).toISOString();
  return {
    ok: true,
    seeAll: true,
    researchInstructionEnabled: true,
    hasMore: true,
    items: [
      {
        captureId: '20260727-100000-e2e1',
        capturedAt: recent,
        receivedAt: recent,
        status: 'processed',
        person: 'PER-000777',
        capturer: 'E2E Owner',
        quickName: { name: '합성 담당자' },
        contact: {
          name: '합성 담당자', organization: '합성상사', title: '합성 담당',
          phones: ['010-0000-0000'], emails: ['synthetic@example.invalid'],
        },
        brief: `# 합성 담당자 — 이런 분이에요\n${BRIEF_BODY}`,
      },
      {
        captureId: '20260727-090000-e2e2',
        capturedAt: late,
        receivedAt: late,
        status: 'received',
        capturer: 'E2E Owner',
        quickName: { name: '합성 대기자' },
      },
    ],
  };
}

function responseFor(action: string): unknown {
  if (action === 'list') return ownerList();
  if (action === 'search') return { ok: true, items: [{ id: 'FILE-SYNTHETIC', title: 'PER-000777 합성 담당자', via: 'content' }] };
  if (action === 'persondoc' || action === 'doc') return { ok: true, markdown: SYNTHETIC_PERSON_MD };
  return { ok: true, receiptId: 'synthetic-receipt', status: 'received' };
}

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

function stopStaticServer(server: Server): Promise<void> {
  return new Promise((resolveStop, reject) => {
    server.close((error) => error ? reject(error) : resolveStop());
    server.closeAllConnections();
  });
}

async function serverOrigin(): Promise<{ server: Server; origin: string }> {
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');
  return { server, origin: `http://127.0.0.1:${address.port}/` };
}

interface WireRecord {
  url: string;
  method: string;
  action: string;
  body: string;
}

function actionOf(url: string, postData: string | null): string {
  const fromQuery = new URL(url).searchParams.get('action');
  if (fromQuery) return fromQuery;
  if (!postData) return '';
  try {
    return String((JSON.parse(postData) as { action?: unknown }).action ?? '');
  } catch {
    return '';
  }
}

/** 이 컨텍스트가 내보내는 모든 요청을 기록하고 harness origin 밖으로는 한 바이트도 내보내지 않는다. */
async function fenceNetwork(page: Page, origin: string): Promise<WireRecord[]> {
  const wire: WireRecord[] = [];
  await page.context().route(() => true, async (route) => {
    const request = route.request();
    const postData = request.postData() ?? null;
    wire.push({ url: request.url(), method: request.method(), action: actionOf(request.url(), postData), body: postData ?? '' });
    if (request.url().startsWith(origin)) {
      // 카메라/OCR 엔진 자산은 이 게이트와 무관하다 — 내려받지 않아 테스트를 가볍게 유지한다.
      if (request.url().includes('/vendor/')) return route.abort();
      return route.continue();
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(responseFor(actionOf(request.url(), postData))),
    });
  });
  return wire;
}

const listRequests = (wire: WireRecord[]) => wire.filter((record) => record.action === 'list');
const removed = (wire: WireRecord[]) => wire
  .filter((record) => (REMOVED_ACTIONS as readonly string[]).includes(record.action))
  .map((record) => `${record.method} ${record.action}`);

async function waitForBootRequest(wire: WireRecord[]): Promise<void> {
  await expect.poll(() => listRequests(wire).length, { timeout: 15_000 }).toBeGreaterThan(0);
}

/**
 * 남아 있는 코드로 owner action을 **실제로 부르려는 시도**. 함수가 살아 있으면 여기서 fetch가 나간다.
 * `prompt`를 미리 채워 두지 않으면 addnote·correction이 조용히 return해 게이트가 헛통과한다.
 */
async function attemptRemovedActions(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = window as unknown as Record<string, (argument?: unknown) => unknown>;
    const attempt = (run: () => unknown) => { try { run(); } catch { /* 이미 없으면 그것이 통과다 */ } };
    const target = { captureId: '20260727-100000-e2e1', person: 'PER-000777', label: '합성 담당자' };

    attempt(() => scope.addNoteFlow?.(target));
    attempt(() => scope.requestCorrection?.(target));
    attempt(() => scope.openPersonDoc?.(target));
    attempt(() => scope.openPersonDocById?.({ id: 'FILE-SYNTHETIC', title: 'PER-000777 합성 담당자' }));

    attempt(() => {
      const input = document.getElementById('searchInput') as HTMLInputElement | null;
      if (input) input.value = '합성';
      scope.runSearch?.();
    });
    attempt(() => {
      scope.researchInstructionFlow?.(target);
      (window as unknown as Record<string, unknown>).activeResearchTarget = target;
      const overlayInput = document.getElementById('researchOverlayInput') as HTMLTextAreaElement | null;
      if (overlayInput) overlayInput.value = '합성 조사 지시 문장';
      document.getElementById('researchSubmit')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  });
  // 비동기 fetch가 wire에 도달할 시간을 준다.
  await page.waitForTimeout(1_500);
}

/** 제거 대상 기능이 화면에 내걸던 라벨. 하나라도 눌리면 그 경로가 아직 살아 있는 것이다. */
const OWNER_LABELS = ['전체 프로필 보기', '메모 추가', '메모', '조사 지시', '수정 요청', '검색', '다시 처리 요청'];

/**
 * 화면에 남은 owner 컨트롤을 실제로 눌러 본다 — 목록을 먼저 펼쳐야 그 안의 버튼이 살아난다.
 * 카메라를 여는 버튼은 전체 화면 오버레이가 다음 클릭을 가로채므로 건드리지 않는다.
 */
async function sweepVisibleControls(page: Page): Promise<void> {
  const rows = await page.locator('#briefList > .item, #recentList > .item').all();
  for (const row of rows.slice(0, 6)) await row.click({ timeout: 1_000, force: true }).catch(() => undefined);

  for (const label of OWNER_LABELS) {
    const control = page.getByRole('button', { name: label, exact: true });
    const count = Math.min(await control.count().catch(() => 0), 4);
    for (let index = 0; index < count; index += 1) {
      await control.nth(index).click({ timeout: 1_000 }).catch(() => undefined);
      // 오버레이가 열렸으면 닫아 다음 클릭이 가려지지 않게 한다.
      await page.locator('#docClose, #researchCancel, #dClose').first().click({ timeout: 500 }).catch(() => undefined);
    }
  }
  await page.waitForTimeout(1_000);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('cc_name', 'E2E Owner');
    // prompt가 null을 돌려주면 addnote·correction은 fetch 전에 return한다 — 게이트가 헛통과한다.
    window.prompt = () => '합성 회귀 입력';
    window.confirm = () => true;
    window.alert = () => undefined;
  });
});

test('제거된 owner 기능의 진입점이 코드에 남아 있지 않다', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  const wire = await fenceNetwork(page, origin);

  try {
    await page.goto(`${origin}legacy.html?k=${FAKE_TOKEN}`, { waitUntil: 'domcontentloaded' });
    await waitForBootRequest(wire);

    const stillDefined = await page.evaluate((names) => {
      const scope = window as unknown as Record<string, unknown>;
      return names.filter((name) => typeof scope[name] === 'function');
    }, REMOVED_ENTRY_POINTS as unknown as string[]);
    expect(stillDefined).toEqual([]);

    // 조사 지시 정책 모듈은 이전 앱이 더 이상 싣지 않는다 (남아 있으면 제출 경로가 되살아난다).
    expect(await page.evaluate(() => typeof (window as unknown as Record<string, unknown>).CardCaptureResearch)).toBe('undefined');
    expect(await page.locator('script[src="research-policy.js"]').count()).toBe(0);
  } finally {
    await stopStaticServer(server);
  }
});

test('owner 권한을 다 열어 준 서버 응답에도 제거된 action이 어떤 경로로도 나가지 않는다', async ({ page }) => {
  test.setTimeout(120_000); // 컨트롤 전수 클릭 스윕 + 직접 호출 시도
  const { server, origin } = await serverOrigin();
  const wire = await fenceNetwork(page, origin);

  try {
    await page.goto(`${origin}legacy.html?k=${FAKE_TOKEN}`, { waitUntil: 'domcontentloaded' });
    await waitForBootRequest(wire);

    await sweepVisibleControls(page);
    await attemptRemovedActions(page);

    expect(removed(wire)).toEqual([]);
    // credential 경계는 축소 뒤에도 그대로다 — 나가는 요청은 빌드에 박힌 origin뿐이다.
    expect(wire.filter((record) => !record.url.startsWith(origin) && !record.url.startsWith(PINNED_ORIGIN)).map((record) => record.url)).toEqual([]);
  } finally {
    await stopStaticServer(server);
  }
});

test('제거된 action 문자열이 이전 앱 소스에 아예 없다', async ({ page }) => {
  const { server, origin } = await serverOrigin();

  try {
    const source = await page.request.get(`${origin}legacy.html`).then((response) => response.text());
    // 인라인 핸들러로 우회하려면 결국 action 이름이 소스에 있어야 한다.
    const present = REMOVED_ACTIONS.filter((action) => source.includes(`'${action}'`) || source.includes(`"${action}"`));
    expect(present).toEqual([]);
    // 남아야 하는 것: 빌드에 박힌 신뢰 주소와 상태 조회·재처리 경로.
    expect(source).toContain("var DEFAULT_API = 'https://script.google.com/macros/s/");
    expect(source).toContain("action=list");
    expect(source).toContain("action: 'requeue'");
  } finally {
    await stopStaticServer(server);
  }
});

test('브리핑 본문을 그리지도, 기기에 저장하지도 않는다', async ({ page }) => {
  test.setTimeout(120_000); // 컨트롤 전수 클릭 스윕
  const { server, origin } = await serverOrigin();
  const wire = await fenceNetwork(page, origin);

  try {
    await page.goto(`${origin}legacy.html?k=${FAKE_TOKEN}`, { waitUntil: 'domcontentloaded' });
    await waitForBootRequest(wire);
    await sweepVisibleControls(page);

    expect(await page.evaluate(() => document.body.innerText)).not.toContain(BRIEF_BODY);
    // owner의 브리핑 전문이 namespace 없는 전역 자리에 남으면 다음 사람이 그대로 본다 (SECURITY.md).
    const leftovers = await page.evaluate(() => ({
      briefs: localStorage.getItem('cc_briefs'),
      seeAll: localStorage.getItem('cc_briefSeeAll'),
      research: localStorage.getItem('cc_researchInstructionEnabled'),
      searches: localStorage.getItem('cc_recentSearches'),
    }));
    expect(leftovers).toEqual({ briefs: null, seeAll: null, research: null, searches: null });
  } finally {
    await stopStaticServer(server);
  }
});

test('촬영 → 대기열 → 업로드 경로는 축소 뒤에도 그대로 동작한다', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => new MediaStream() },
    });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 1600 });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 900 });
    HTMLMediaElement.prototype.play = async () => undefined;
    Object.defineProperty(window, 'TextDetector', {
      configurable: true,
      value: class { async detect() { return [{ rawValue: '김카이렌\n대표이사\nKairen' }]; } },
    });
    // legacy 카메라 루프는 2D 컨텍스트 API를 넓게 쓴다 — 통째로 no-op 로 세운다.
    const context2d = new Proxy({}, {
      get: (_target, property) => {
        if (property === 'getImageData') return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
        return () => undefined;
      },
      set: () => true,
    });
    HTMLCanvasElement.prototype.getContext = (() => context2d) as typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toDataURL = () => 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAEf/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=';
  });

  const { server, origin } = await serverOrigin();
  const wire = await fenceNetwork(page, origin);

  try {
    await page.goto(`${origin}legacy.html?k=${FAKE_TOKEN}`, { waitUntil: 'domcontentloaded' });
    await waitForBootRequest(wire);

    await expect(page.locator('#sendBtn')).toBeDisabled();
    await page.locator('#frontBtn').click();
    await expect(page.locator('#cam')).toHaveClass(/show/);
    await page.locator('#camShot').click();
    await expect(page.locator('#camChoice')).toBeVisible();
    await page.locator('#camDone').click();

    await expect(page.locator('#frontBtn img')).toBeVisible();
    await expect(page.locator('#quickNameInput')).toHaveValue('김카이렌');
    await page.locator('#eventInput').fill('2026 합성 전시회');
    await page.locator('#relSelfInput').fill('오늘 처음 인사');
    await page.locator('#relKairenInput').fill('잠재 고객');
    await page.locator('#noteInput').fill('자료 보내기');
    await expect(page.locator('#sendBtn')).toBeEnabled();
    await page.locator('#sendBtn').click();

    // 업로드는 빌드에 박힌 주소로 정확히 한 번 나간다.
    await expect.poll(() => wire.filter((record) => record.method === 'POST' && record.action === '').length, { timeout: 15_000 }).toBe(1);
    const upload = wire.filter((record) => record.method === 'POST' && record.action === '')[0];
    expect(upload.url.startsWith(`${PINNED_ORIGIN}/`)).toBe(true);
    const payload = JSON.parse(upload.body) as {
      k: string; capturer: string; event: string; note: string;
      quickName: { name: string } | null; images: Array<{ name: string }>;
    };
    expect(payload.k).toBe(FAKE_TOKEN);
    expect(payload.capturer).toBe('E2E Owner');
    expect(payload.event).toBe('2026 합성 전시회');
    expect(payload.note).toBe('나와의 관계: 오늘 처음 인사\nKairen과의 관계: 잠재 고객\n메모: 자료 보내기');
    expect(payload.quickName?.name).toBe('김카이렌');
    expect(payload.images.map((image) => image.name)).toEqual(['front.jpg']);

    // 전송 상태가 화면에 남는다.
    await expect(page.locator('#recentList .st.sent')).toHaveText('전송됨');
  } finally {
    await stopStaticServer(server);
  }
});

test('전송·처리 상태 확인과 다시 처리 요청은 그대로 남는다', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  const wire = await fenceNetwork(page, origin);

  try {
    await page.goto(`${origin}legacy.html?k=${FAKE_TOKEN}`, { waitUntil: 'domcontentloaded' });
    await waitForBootRequest(wire);

    // 이 기기가 올린 캡처 하나 — 서버는 아직 처리 중이라고 답한다(41분 경과, 지연 구간).
    await page.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolveDatabase, reject) => {
        const request = indexedDB.open('cardcapture', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('q', { keyPath: 'captureId' });
        request.onsuccess = () => resolveDatabase(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolveWrite, reject) => {
        const transaction = database.transaction('q', 'readwrite');
        transaction.objectStore('q').put({
          captureId: '20260727-090000-e2e2',
          capturedAt: '2026-07-27T09:00:00.000Z',
          event: '합성 전시회',
          note: '',
          images: [{ name: 'front.jpg' }],
          quickName: { name: '합성 대기자' },
          state: 'sent',
          tries: 0,
          thumb: '',
        });
        transaction.oncomplete = () => resolveWrite();
        transaction.onerror = () => reject(transaction.error);
      });
      database.close();
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect.poll(() => listRequests(wire).length, { timeout: 15_000 }).toBeGreaterThan(1);

    const row = page.locator('#recentList .item', { hasText: '합성 대기자' });
    await expect(row).toContainText('전송됨');
    await expect(row).toContainText('분 경과');
    await row.getByRole('button', { name: '다시 처리 요청' }).click();

    await expect.poll(() => wire.filter((record) => record.action === 'requeue').length, { timeout: 10_000 }).toBe(1);
    const requeue = wire.filter((record) => record.action === 'requeue')[0];
    expect(requeue.method).toBe('POST');
    expect(requeue.url.startsWith(`${PINNED_ORIGIN}/`)).toBe(true);
    expect(JSON.parse(requeue.body)).toMatchObject({ action: 'requeue', k: FAKE_TOKEN, captureId: '20260727-090000-e2e2' });
  } finally {
    await stopStaticServer(server);
  }
});
