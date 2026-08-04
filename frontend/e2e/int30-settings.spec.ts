// 설정 정보구조 회귀 게이트 (INT-000030 항목 004 · DEC-000105 — Kairen-Ref: TSK-000544)
//
// founder: "설정 페이지는 전반적으로 세련되지 않은 느낌이야. ... 유저가 설정 페이지에 처음 혹은
// 자주 들어올 만한 이유들, 반드시 써야 될 것들을 중심으로 다시 잘 구성되었으면 좋겠어."
//
// 이 게이트가 지키는 것은 **문장이 아니라 구조**다:
//   1. 묶음 순서가 방문 job 순서다.
//   2. 처음 온 사람이 해야 하는 일과, 다시 온 사람이 확인할 상태가 1차 탐색에 있다.
//   3. 지속 선택 / 읽기 전용 사실 / 되돌릴 수 없는 정리가 **눈으로 구분된다**.
//   4. 진단·제보는 접힌 자리에서 발견되고, 여는 것만으로 아무것도 나가지 않는다.
//   5. 320px과 데스크톱 폭 둘 다에서 새지 않는다.
//
// 기대값은 여기 **문자열로 박아 둔다.** 앱의 등록소(`services/settings-ia.ts`)를 불러다 기대값을
// 계산하면 등록소가 잘못돼도 게이트가 같이 잘못되어 통과한다 — 그것은 판정이 아니라 동어반복이다.
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const buildRoot = resolve(fileURLToPath(new URL('../../docs/', import.meta.url)));

/** founder가 말한 순서. 이 배열이 계약이다. */
const GROUP_ORDER = ['계정·연결', '캡처·조사', '알림', '데이터·개인정보', '앱 정보·지원'] as const;

/** 연결된 기기에서 화면에 나타나는 항목 순서. `connect-next-step`은 연결 전에만 맨 앞에 붙는다. */
const ITEM_ORDER_CONNECTED = [
  'connection-state',
  'now-facts',
  'capturer-name',
  'api-endpoint',
  'personal-token',
  'save-config',
  'capture-method',
  'gallery-note',
  'theme',
  'motion-note',
  'research-availability',
  'notify-state',
  'notify-action',
  'notify-scope',
  'privacy-boundary',
  'disconnect',
  'version',
  'support-entry',
  'diagnostics',
  'bug-report',
  'report-copy',
] as const;

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

interface BootOptions {
  /** 아직 개인 링크를 받지 못한 새 사용자. */
  connected?: boolean;
  theme?: 'light' | 'dark';
  width?: number;
  height?: number;
}

interface Harness {
  server: Server;
  origin: string;
  /** 앱이 실제로 보낸 요청 전부. "여는 것만으로 나가지 않는다"를 여기서 판정한다. */
  requests: string[];
}

async function boot(page: Page, options: BootOptions = {}): Promise<Harness> {
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');
  const origin = `http://127.0.0.1:${address.port}/`;
  const requests: string[] = [];

  await page.context().route('**/vendor/**', (route) => route.abort());
  // 빌드에 박힌 실제 배포본으로는 어떤 요청도 나가지 않는다.
  await page.context().route('https://script.google.com/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [], seeAll: false }),
  }));
  await page.route('https://api.example.test/**', async (route) => {
    const url = route.request().url();
    requests.push(url);
    const action = new URL(url).searchParams.get('action');
    if (action === 'list') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, seeAll: true, researchInstructionEnabled: true, hasMore: false, items: [] }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, enabled: false, items: [] }) });
  });
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith(origin) && !url.startsWith('data:') && !url.startsWith('blob:')) requests.push(url);
  });

  await page.addInitScript((setup: BootOptions) => {
    localStorage.setItem('cc_name', '이강규');
    if (setup.theme) localStorage.setItem('cc_theme', setup.theme);
  }, options);

  await page.setViewportSize({ width: options.width ?? 390, height: options.height ?? 844 });
  const api = encodeURIComponent('https://api.example.test/exec');
  const query = options.connected === false ? '' : `?api=${api}&k=owner-token`;
  await page.goto(`${origin}next/${query}`, { waitUntil: 'networkidle' });
  return { server, origin, requests };
}

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: '주요 화면' }).getByRole('button', { name: '설정' }).click();
  await expect(page.getByRole('heading', { name: '계정·연결' })).toBeVisible();
}

/** 화면에 실제로 그려진 순서를 그대로 읽는다. */
function readOrder(page: Page): Promise<{ groups: string[]; items: string[] }> {
  return page.evaluate(() => {
    const scope = document.querySelector('#kairen-ui');
    return {
      groups: Array.from(scope?.querySelectorAll('[data-settings-group] > h2') ?? []).map((node) => node.textContent?.trim() ?? ''),
      items: Array.from(scope?.querySelectorAll('[data-settings-item]') ?? []).map((node) => node.getAttribute('data-settings-item') ?? ''),
    };
  });
}

// ── 001: 묶음 순서가 방문 job 순서다 ──

test('설정의 묶음 순서와 항목 순서가 방문 job 순서 그대로다', async ({ page }) => {
  const harness = await boot(page);
  try {
    await openSettings(page);
    const order = await readOrder(page);

    expect(order.groups, '묶음 순서가 계약과 다르다').toEqual([...GROUP_ORDER]);
    expect(order.items, '항목 순서가 계약과 다르다').toEqual([...ITEM_ORDER_CONNECTED]);
    // 같은 항목이 두 자리에 나타나면 "어느 쪽이 진짜인가"가 생긴다.
    expect(new Set(order.items).size, '같은 항목이 두 번 그려졌다').toBe(order.items.length);

    // 없앤 묶음이 되살아나면 여기서 잡힌다 — `화면`은 독립 묶음이 아니라 캡처 경험의 일부다.
    for (const retired of ['촬영', '화면', '버전·문제 알리기']) {
      expect(await page.getByRole('heading', { name: retired, exact: true }).count(), `없앤 묶음 \`${retired}\`이 되살아났다`).toBe(0);
    }

    // 낭독기는 묶음 제목 → 항목 순으로 읽는다. 다섯 묶음 전부가 이름 있는 region이어야 한다.
    for (const label of GROUP_ORDER) {
      await expect(page.getByRole('region', { name: label, exact: true })).toBeVisible();
    }
  } finally {
    harness.server.close();
  }
});

// ── 002: 첫 방문 job과 반복 방문 job이 1차 탐색에 있다 ──
//
// "1차 탐색"의 조작적 정의: 설정을 연 직후, **스크롤하지 않고** 화면 안에서 보인다.
// 폰(320px)과 데스크톱(1280px) 둘 다에서 성립해야 한다.

for (const size of [{ name: '좁은 폰', width: 320, height: 568 }, { name: '데스크톱', width: 1280, height: 800 }]) {
  test(`${size.name}에서 처음 온 사람이 할 일이 스크롤 없이 보인다`, async ({ page }) => {
    const harness = await boot(page, { connected: false, width: size.width, height: size.height });
    try {
      await openSettings(page);

      const nextStep = page.locator('[data-settings-item="connect-next-step"]');
      await expect(nextStep, '연결되지 않은 기기에 다음 할 일이 없다').toBeVisible();
      await expect(nextStep).toContainText('개인 링크');

      const placement = await nextStep.evaluate((node) => ({
        top: node.getBoundingClientRect().top,
        height: window.innerHeight,
        scrolled: document.scrollingElement?.scrollTop ?? 0,
      }));
      expect(placement.scrolled, '설정을 열자마자 이미 스크롤돼 있다').toBeLessThanOrEqual(1);
      expect(placement.top, `다음 할 일이 첫 화면 밖에 있다 (top=${Math.round(placement.top)} / ${placement.height})`).toBeLessThan(placement.height);

      // 다음 할 일은 첫 항목이다 — 연결 전에는 이보다 앞에 올 것이 없다.
      const order = await readOrder(page);
      expect(order.items[0]).toBe('connect-next-step');
      expect(order.items, '연결 전 항목 순서가 계약과 다르다').toEqual(['connect-next-step', ...ITEM_ORDER_CONNECTED]);

      // 누르면 실제로 코드를 넣을 수 있는 자리로 간다. 안내만 하고 끝나지 않는다.
      await page.getByRole('button', { name: /코드를 직접 입력/ }).click();
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('settings-token');
    } finally {
      harness.server.close();
    }
  });

  test(`${size.name}에서 다시 온 사람이 지금 상태를 스크롤 없이 읽는다`, async ({ page }) => {
    const harness = await boot(page, { width: size.width, height: size.height });
    try {
      await openSettings(page);

      const facts = page.locator('[data-settings-item="now-facts"]');
      await expect(facts).toBeVisible();
      // 다시 오는 이유는 "지금 잘 되고 있나"다. 그 답이 네 줄로 한 자리에 있다.
      for (const label of ['접수 이름', '알림', '전송 대기', '네트워크']) {
        await expect(facts).toContainText(label);
      }
      const top = await facts.evaluate((node) => ({ top: node.getBoundingClientRect().top, height: window.innerHeight }));
      expect(top.top, `지금 상태가 첫 화면 밖에 있다 (top=${Math.round(top.top)} / ${top.height})`).toBeLessThan(top.height);
    } finally {
      harness.server.close();
    }
  });
}

// ── 003: 세 위계가 눈으로 구분된다 ──
//
// 이 게이트가 이 task의 핵심이다. '세련되지 않음'은 장식이 아니라 **읽기 전용 사실과 조작이
// 같은 모양으로 그려진 것**이었다. 그래서 클래스 이름이 아니라 **계산된 스타일**을 잰다.

test('읽기 전용 사실이 조작처럼 보이지 않는다', async ({ page }) => {
  const harness = await boot(page);
  try {
    await openSettings(page);
    // 진단까지 포함해 재려면 접힌 자리를 먼저 연다.
    await page.getByRole('button', { name: /문제가 생겼을 때/ }).click();

    const report = await page.evaluate(() => {
      const facts = Array.from(document.querySelectorAll('#kairen-ui .int30-fact'));
      const actions = Array.from(document.querySelectorAll('#kairen-ui .int29-action'));
      const describe = (node: Element) => {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return {
          tag: node.tagName,
          radius: parseFloat(style.borderTopLeftRadius),
          cursor: style.cursor,
          height: rect.height,
          focusable: node.matches('a[href], button, input, select, textarea, [tabindex]'),
          disabled: node.matches('[disabled], [aria-disabled="true"]'),
        };
      };
      return { facts: facts.map(describe), actions: actions.map(describe) };
    });

    expect(report.facts.length, '읽기 전용 사실 행을 하나도 찾지 못했다').toBeGreaterThanOrEqual(4);
    expect(report.actions.length, '조작을 하나도 찾지 못했다').toBeGreaterThanOrEqual(4);

    for (const fact of report.facts) {
      // 1) 누를 수 있는 요소가 아니다.
      expect(['DIV', 'DT', 'DD'], `읽기 전용 행이 ${fact.tag}로 그려졌다`).toContain(fact.tag);
      expect(fact.focusable, '읽기 전용 행이 포커스 대상이다').toBe(false);
      // 2) 누를 수 있는 것처럼 보이지도 않는다 — 손 모양 커서와 버튼 모서리가 없다.
      expect(fact.cursor, '읽기 전용 행에 손 모양 커서가 있다').not.toBe('pointer');
      expect(fact.radius, `읽기 전용 행이 버튼처럼 둥글다 (${fact.radius}px)`).toBe(0);
    }

    for (const action of report.actions) {
      // 조작은 반대로 전부 갖춰야 한다 — 구분은 한쪽만 바꿔서는 생기지 않는다.
      expect(action.radius, `조작이 버튼처럼 보이지 않는다 (${action.radius}px)`).toBeGreaterThanOrEqual(8);
      expect(action.height, `조작이 손가락 크기가 아니다 (${Math.round(action.height)}px)`).toBeGreaterThanOrEqual(44);
      if (!action.disabled) expect(action.cursor, '누를 수 있는 조작에 손 모양 커서가 없다').toBe('pointer');
    }
  } finally {
    harness.server.close();
  }
});

test('되돌릴 수 없는 정리는 마지막 위험 영역에서 영향과 취소 불가 범위를 말한다', async ({ page }) => {
  const harness = await boot(page);
  try {
    await openSettings(page);

    const danger = page.locator('.int30-danger');
    await expect(danger).toBeVisible();
    await expect(danger).toHaveAttribute('data-settings-risk', 'destructive');

    // 1) 무엇이 지워지고 무엇이 남는지를 **누르기 전에** 말한다.
    await expect(danger).toContainText('지웁니다');
    await expect(danger).toContainText('개인 링크 코드');
    await expect(danger).toContainText('남깁니다');
    await expect(danger).toContainText('전송을 기다리는 촬영 원본');
    // 2) 되돌릴 수 없다는 것을 그 말 그대로 적는다.
    await expect(danger).toContainText('되돌릴 수 없어요');
    // 3) 위험 조작은 여기 하나뿐이다.
    expect(await page.locator('#kairen-ui .int29-action.is-danger').count(), '위험 조작이 하나가 아니다').toBe(1);
    await expect(danger.getByRole('button', { name: '연결 해제', exact: true })).toBeVisible();

    // 4) 자리도 마지막이다 — 모든 지속 선택보다 뒤에 온다.
    const order = (await readOrder(page)).items;
    const dangerAt = order.indexOf('disconnect');
    for (const choice of ['capturer-name', 'api-endpoint', 'personal-token', 'capture-method', 'theme']) {
      expect(order.indexOf(choice), `${choice}가 위험 영역 뒤에 있다`).toBeLessThan(dangerAt);
    }

    // 5) 위험 영역은 보통 카드와 **다른 자리**로 보인다. 색이 같으면 문구만으로는 늦는다.
    const distinct = await page.evaluate(() => {
      const head = document.querySelector('#kairen-ui .int30-danger-head') as HTMLElement | null;
      const card = document.querySelector('#kairen-ui .int29-card') as HTMLElement | null;
      if (!head || !card) return null;
      return {
        danger: getComputedStyle(head).backgroundColor,
        card: getComputedStyle(card).backgroundColor,
        border: getComputedStyle(document.querySelector('#kairen-ui .int30-danger') as HTMLElement).borderTopColor,
        cardBorder: getComputedStyle(card).borderTopColor,
      };
    });
    expect(distinct, '위험 영역이나 카드를 찾지 못했다').not.toBeNull();
    expect(distinct!.danger, '위험 영역 배경이 보통 카드와 같다').not.toBe(distinct!.card);
    expect(distinct!.border, '위험 영역 테두리가 보통 카드와 같다').not.toBe(distinct!.cardBorder);
  } finally {
    harness.server.close();
  }
});

// ── 004: 진단·제보는 접힌 자리에서 발견되고, 아무것도 자동으로 보내지 않는다 ──

test('진단과 버그 리포트는 접힌 지원 진입에서 발견되고 열어도 아무것도 나가지 않는다', async ({ page }) => {
  const harness = await boot(page);
  try {
    await openSettings(page);

    const toggle = page.getByRole('button', { name: /문제가 생겼을 때/ });
    // 1) 평소에는 접혀 있다. 접힌 상태에서도 안에 무엇이 있는지 적혀 있어야 열어 볼 이유가 생긴다.
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toContainText('진단 정보');
    await expect(toggle).toContainText('버그 리포트');
    await expect(page.locator('[data-settings-item="diagnostics"]')).toBeHidden();
    // 낭독기가 무엇이 열리는지 알 수 있게 연결돼 있다.
    const controls = await toggle.getAttribute('aria-controls');
    expect(controls, '접기 버튼이 무엇을 여는지 말하지 않는다').toBeTruthy();
    expect(await page.locator(`#${controls}`).count()).toBe(1);

    // 2) 버전은 접히지 않는다 — 통화하면서 읽는 값이다.
    await expect(page.locator('.int29-version-number')).toBeVisible();

    const before = harness.requests.length;
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const diagnostics = page.locator('[data-settings-item="diagnostics"]');
    await expect(diagnostics).toBeVisible();
    for (const label of ['버전', '빌드', '연결', '알림', '브라우저']) {
      await expect(diagnostics).toContainText(label);
    }

    // 3) 여는 것만으로 밖으로 나간 요청이 없다. 진단은 사람이 누를 때만 움직인다.
    await page.waitForTimeout(400);
    expect(harness.requests.slice(before).filter((url) => !url.includes('api.example.test')),
      '지원 진입을 여는 것만으로 요청이 나갔다').toEqual([]);

    // 4) 화면에 보이는 진단에도 자격 정보·사람 정보가 없다.
    const shown = (await diagnostics.textContent()) ?? '';
    for (const secret of ['owner-token', '이강규', 'api.example.test']) {
      expect(shown, `진단 화면에 "${secret}" 가 실렸다`).not.toContain(secret);
    }
    await expect(diagnostics).toContainText('자동으로 보내지 않습니다');

    // 5) 메일은 초안만 연다. 본문에도 자격 정보가 없다.
    const link = page.getByRole('link', { name: /버그 리포트 보내기/ });
    const href = await link.getAttribute('href') ?? '';
    expect(href.startsWith('mailto:'), `mailto가 아니다: ${href.slice(0, 40)}`).toBe(true);
    for (const secret of ['owner-token', '이강규', 'api.example.test']) {
      expect(href, `버그 리포트에 "${secret}" 가 실렸다`).not.toContain(secret);
      expect(href).not.toContain(encodeURIComponent(secret));
    }

    // 6) 다시 누르면 접힌다 — 연 뒤 닫을 수 없는 자리는 접기가 아니다.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(diagnostics).toBeHidden();
  } finally {
    harness.server.close();
  }
});

// ── 005: 화면·접근성 조작이 캡처 경험 안에 있고, OS 선호를 덮어쓰지 않는다 ──

test('화면 테마는 캡처·조사 안에 있고 움직임은 폰 설정을 덮어쓰지 않는다', async ({ page }) => {
  const harness = await boot(page);
  try {
    await openSettings(page);

    const capture = page.getByRole('region', { name: '캡처·조사', exact: true });
    await expect(capture.getByRole('radiogroup', { name: '화면 테마' })).toBeVisible();
    await expect(capture.getByRole('radio', { name: /앱 안에서 촬영/ })).toBeVisible();

    // 은퇴한 `화면 움직임` preference를 되살리지 않는다. 움직임은 언제나 폰 설정이 이긴다.
    expect(await page.getByRole('radiogroup', { name: '화면 움직임' }).count(), '은퇴한 움직임 preference가 되살아났다').toBe(0);
    await expect(capture).toContainText('움직임 줄이기');
    expect(await page.evaluate(() => localStorage.getItem('cc_motion'))).toBeNull();

    // 조사는 켜고 끄는 값이 아니라 연결에 딸린 권한이다 — 선택이 아니라 사실로 적는다.
    const research = page.locator('[data-settings-item="research-availability"]');
    await expect(research).toBeVisible();
    expect(await research.locator('input, [role="radio"], [role="switch"]').count(),
      '조사 권한이 사용자 선택처럼 그려졌다').toBe(0);
  } finally {
    harness.server.close();
  }
});

// ── 006: 좁은 폭 ──
//
// 접힌 자리를 **연 상태**로 잰다. 예전 게이트는 접힌 내용을 한 번도 재지 못했다.

test('320px에서 접힌 자리를 열어도 가로로 새지 않는다', async ({ page }) => {
  const harness = await boot(page, { width: 320, height: 568 });
  try {
    await openSettings(page);
    await page.getByRole('button', { name: /문제가 생겼을 때/ }).click();
    await page.waitForTimeout(200);

    const report = await page.evaluate(() => {
      // 폭 기준은 `clientWidth`다. `innerWidth`는 emulation에서 실제 레이아웃 폭과 다르다.
      const viewport = document.documentElement.clientWidth;
      const overflow: { where: string; right: number }[] = [];
      const scope = document.querySelector('#kairen-ui');
      let measured = 0;
      for (const node of scope?.querySelectorAll('button, a, input, textarea, dt, dd, [role="radio"]') ?? []) {
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        measured += 1;
        if (rect.right > viewport + 1 || rect.left < -1) {
          overflow.push({ where: `${node.tagName.toLowerCase()}.${String(node.className || '').split(' ')[0]}`, right: Math.round(rect.right) });
        }
      }
      return { viewport, scrollWidth: document.scrollingElement?.scrollWidth ?? 0, overflow, measured };
    });

    expect(report.viewport).toBe(320);
    expect(report.scrollWidth, '설정 화면이 320px에서 가로로 스크롤된다').toBeLessThanOrEqual(report.viewport + 1);
    expect(report.overflow, `320px에서 화면 밖으로 밀린 요소: ${JSON.stringify(report.overflow)}`).toEqual([]);
    // 아무것도 재지 못한 스윕은 통과가 아니라 침묵이다.
    expect(report.measured, `320px에서 잰 요소가 너무 적다 (${report.measured}개)`).toBeGreaterThanOrEqual(30);
  } finally {
    harness.server.close();
  }
});
