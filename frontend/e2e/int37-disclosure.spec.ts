// 접기·펴기의 문법 — Kairen-Ref: TSK-000573 (ISS-000246 / INT-000037)
//
// founder 판정 2026-08-05:
//   "손수 만든 나머지 패널. 이번엔 `IonModal`로 덮이는 창만 정리했습니다.
//    설정 안의 접었다 펴는 영역들은 다른 문법이라 아직 손대지 않았습니다."
//
// v2.27.0이 **나가는** 조작을 하나로 모았다(`SheetClose`). 접었다 펴는 조작은 그대로 남았고,
// 남은 그것이 닫기 버튼이 그랬던 것과 정확히 같은 상태였다 — 자리마다 따로 발명돼 있었다.
// 어떤 자리는 lucide `ChevronRight`가 90도 돌고, 어떤 자리는 `ChevronDown`이 180도 돌고,
// `명함 기록`은 아예 `▸`/`▾` **글자**였고, 인물 문서는 브라우저가 그리는 세모였다.
//
// 그래서 이 파일이 재는 것은 다섯 문장이다. 전부 founder가 그대로 읽을 수 있는 말이어야 한다:
//   1. 접기·펴기가 어디서나 같은 표시로 열리고 닫힌다.
//   2. 키보드로 닿고 Enter·Space로 조작된다.
//   3. 낭독기가 열림·닫힘을 읽는다.
//   4. 손가락으로 누를 수 있는 크기다.
//   5. 움직임을 끄면 표시가 돌아가는 동작이 사라진다.
//
// ── 이 게이트가 형식적이지 않다는 근거 ──
// 변경 **전** 번들(v2.27.0, `docs/`에 커밋된 그 바이트)에서 1·3·4가 실제로 FAIL한다.
//   1 — `명함 기록`이 글자 세모(`▸`)이고, 나머지 셋의 표시가 서로 다른 아이콘·다른 회전각이다.
//   3 — 넷 중 셋(`브리핑 상세`·`만남 맥락`·`명함 기록`)에 `aria-controls`가 없다.
//   4 — `명함 기록` 줄이 24px이라 손가락이 닿는 자리가 44px에 못 미친다.
// 2와 5는 성질상 변경 전에도 통과한다(전역 `button:focus-visible`와 전역
// `prefers-reduced-motion` 규칙이 이미 있다). 그래서 그 둘은 **스스로 반대 조건을 걸어**
// 판정한다: 5번은 움직임을 켠 상태에서 회전이 실제로 애니메이션되는지를 먼저 확인한 뒤에
// "끄면 사라진다"를 주장한다. 확인 없이 0을 주장하면 규칙이 아무 데도 안 걸려 있어도 초록이다.
//
// 판정 기준은 렌더된 픽셀과 접근성 트리다. 앱의 상태값을 다시 계산하지 않는다.
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const buildRoot = resolve(fileURLToPath(new URL('../../docs/', import.meta.url)));
const MOCK_API = 'https://api.example.test/exec';
const DAY_MINUTES = 24 * 60;

/** 손가락 최소 크기. `int37-dismiss.spec.ts`가 나가는 조작에 대고 있는 자와 같은 값이다. */
const TOUCH_MIN = 44;

/** 손으로 그린 세모. 표시가 글꼴에 따라 달라지는 순간 "같은 표시"라는 약속이 깨진다. */
const CARET_GLYPHS = ['▸', '▾', '▴', '▹', '▼', '▲', '►', '◄', '➤', '‣'];

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
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
  return new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => done(server)); });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((done) => { server.close(() => done()); server.closeAllConnections(); });
}

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function person(index: number, name: string, organization: string) {
  return {
    captureId: `2026080${index}-090000-d${index}`,
    receivedAt: ago(index * DAY_MINUTES),
    status: 'processed',
    person: `PER-00000${index}`,
    capturer: '이강규',
    event: '고객사 방문 미팅',
    contact: { name, title: '구매팀장', organization },
    brief: `# ${name} — 이런 분이에요\n${organization} 구매팀장입니다.`,
  };
}

async function boot(page: Page): Promise<Server> {
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');

  await page.context().route('**/vendor/**', (route) => route.abort());
  await page.context().route('https://script.google.com/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [], seeAll: false }),
  }));
  await page.route(`${MOCK_API}**`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ok: true, seeAll: true, researchInstructionEnabled: true, hasMore: false,
      items: [person(1, '김민서', '한화시스템'), person(2, '이서연', '넥스트로보')],
    }),
  }));
  // 첫 실행 이름 게이트는 이 게이트의 대상이 아니다. 이름을 미리 넣어 그 표면을 지나친다.
  await page.addInitScript(() => localStorage.setItem('cc_name', '이강규'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`http://127.0.0.1:${address.port}/next/?api=${encodeURIComponent(MOCK_API)}&k=fake-e2e-int37-disclosure`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('navigation', { name: '주요 화면' })).toBeVisible({ timeout: 20_000 });
  // 기록이 도착해야 브리핑 카드(접기 조작 하나)가 화면에 선다.
  await expect(page.locator('.brief-summary').first()).toBeVisible({ timeout: 20_000 });
  return server;
}

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: '주요 화면' }).getByRole('button', { name: '설정' }).click();
  await expect(page.getByRole('button', { name: /문제가 생겼을 때/ })).toBeVisible({ timeout: 15_000 });
}

/** 화면에 선 접기 조작 하나를 문법의 자로 읽은 값. */
interface Reading {
  /** 사람이 실패 문장에서 알아볼 이름. */
  label: string;
  /** 지금 열려 있는가 — `aria-expanded`가 말하는 그대로. */
  expanded: string | null;
  /** 무엇을 여닫는지 말하는가. 그 id가 문서에 몇 개 있는가. */
  controls: string | null;
  controlsFound: number;
  /** 열려 있을 때 그 영역이 실제로 보이는가. */
  regionVisible: boolean | null;
  /** 공용 표시를 갖고 있는가. */
  hasIndicator: boolean;
  indicatorWidth: number;
  indicatorHeight: number;
  /** 표시의 회전. 같은 문법이면 닫힘·열림의 값이 어디서나 같아야 한다. */
  indicatorTransform: string;
  indicatorTransitionMs: number;
  /** 조작 글자 안에 손으로 그린 세모가 섞여 있는가. */
  caretGlyphs: string[];
  /** 손가락이 닿는 자리 — 44×44 상자 안 9곳이 전부 이 조작에 떨어지는가. */
  touchMisses: number;
  width: number;
  height: number;
  /** 조작 **안에** 계속 말하는 자리가 있는가 (RELEASE.md v2.26.0 항목 5의 회귀). */
  liveInside: number;
}

/**
 * 지금 화면의 접기 조작을 **전부** 읽는다.
 *
 * 목록을 class 이름으로 만들지 않는다 — `aria-expanded`라는 **뜻**으로 센다. 그래야 다음에
 * 누가 공용 조작을 안 쓰고 손으로 만들어도 이 목록에 잡힌다. class로 세면 새로 만든 것은
 * 애초에 목록에 안 들어와서 게이트가 조용히 통과한다.
 */
async function readDisclosures(page: Page): Promise<Reading[]> {
  return page.evaluate(({ touchMin, caretGlyphs }) => {
    const scope = document.querySelector('#kairen-ui') ?? document.body;
    const controls = Array.from(scope.querySelectorAll<HTMLElement>('[aria-expanded]'))
      .filter((node) => node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0);

    return controls.map((node) => {
      /* 손가락 판정 전에 이 조작을 화면 한가운데로 가져온다. 화면 밖에 있는 것을
         `elementFromPoint`로 찍으면 "좁다"가 아니라 "안 보인다"를 재게 된다 — 그러면 이 게이트는
         조작 크기가 아니라 스크롤 위치를 판정한다. 자리마다 따로 재므로 목록 순서는 그대로다. */
      node.scrollIntoView({ block: 'center', inline: 'nearest' });
      const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      const label = node.getAttribute('aria-label')
        ?? node.querySelector('strong')?.textContent?.trim()
        ?? (text.length > 26 ? `${text.slice(0, 26)}…` : text)
        ?? '(이름 없음)';

      const indicator = node.querySelector<SVGElement>('[data-disclosure-chevron]');
      const indicatorBox = indicator?.getBoundingClientRect();
      const indicatorStyle = indicator ? getComputedStyle(indicator) : null;

      const controlsId = node.getAttribute('aria-controls');
      const region = controlsId ? document.getElementById(controlsId) : null;
      const regionBox = region?.getBoundingClientRect();

      /* 손가락 판정은 상자 크기가 아니라 **눌리는 자리**로 한다. 보이는 chrome을 얇게 두고
         가상 요소로 hit area만 넓히는 수법이 이 저장소에 이미 있으므로(`int30-refresh.css`),
         `getBoundingClientRect()`만 재면 넓힌 것을 못 보고 반대로 가려진 것도 못 본다. */
      const box = node.getBoundingClientRect();
      const centerX = box.left + box.width / 2;
      const centerY = box.top + box.height / 2;
      const reach = touchMin / 2 - 1;
      let touchMisses = 0;
      for (const dx of [-reach, 0, reach]) {
        for (const dy of [-reach, 0, reach]) {
          const hit = document.elementFromPoint(centerX + dx, centerY + dy);
          if (!hit || !(hit === node || node.contains(hit))) touchMisses += 1;
        }
      }

      return {
        label,
        expanded: node.getAttribute('aria-expanded'),
        controls: controlsId,
        controlsFound: controlsId ? document.querySelectorAll(`[id="${CSS.escape(controlsId)}"]`).length : 0,
        regionVisible: region ? Boolean(regionBox && regionBox.width > 0 && regionBox.height > 0) : null,
        hasIndicator: Boolean(indicator),
        indicatorWidth: indicatorBox ? Math.round(indicatorBox.width) : 0,
        indicatorHeight: indicatorBox ? Math.round(indicatorBox.height) : 0,
        indicatorTransform: indicatorStyle?.transform ?? 'none',
        indicatorTransitionMs: indicatorStyle ? Math.round(parseFloat(indicatorStyle.transitionDuration || '0') * 1000) : -1,
        caretGlyphs: caretGlyphs.filter((glyph) => text.includes(glyph)),
        touchMisses,
        width: Math.round(box.width),
        height: Math.round(box.height),
        liveInside: node.querySelectorAll('[role="status"], [aria-live]').length,
      };
    });
  }, { touchMin: TOUCH_MIN, caretGlyphs: CARET_GLYPHS });
}

/** 두 화면(촬영·설정)의 접기 조작을 한 목록으로 모은다. */
async function readAllScreens(page: Page): Promise<Reading[]> {
  const capture = await readDisclosures(page);
  await openSettings(page);
  const settings = await readDisclosures(page);
  return [...capture, ...settings];
}

const describeAll = (readings: Reading[]) =>
  readings.map((reading) => `  · ${reading.label} — ${reading.width}×${reading.height}px, 표시 ${reading.hasIndicator ? `${reading.indicatorWidth}×${reading.indicatorHeight}px ${reading.indicatorTransform}` : '없음'}, aria-controls ${reading.controls ?? '없음'}, 세모글자 ${reading.caretGlyphs.join('') || '없음'}, 닿지 않는 곳 ${reading.touchMisses}/9`).join('\n');

// ── 1. 접기·펴기가 어디서나 같은 표시로 열리고 닫힌다 ──────────────────────────

test('접기·펴기가 어디서나 같은 표시로 열리고 닫힌다', async ({ page }) => {
  const server = await boot(page);
  try {
    const readings = await readAllScreens(page);
    const report = describeAll(readings);

    expect(readings.length, `접기 조작을 하나도 못 찾았다 — 게이트가 빈 집합을 훑고 있다\n${report}`).toBeGreaterThanOrEqual(4);

    const missing = readings.filter((reading) => !reading.hasIndicator).map((reading) => reading.label);
    expect(missing, `공용 표시가 없는 접기 조작이 있다 (\`DisclosureToggle\`을 쓰지 않았다)\n${report}`).toEqual([]);

    const glyphed = readings.filter((reading) => reading.caretGlyphs.length > 0).map((reading) => `${reading.label}(${reading.caretGlyphs.join('')})`);
    expect(glyphed, `글자로 그린 세모가 남아 있다 — 표시는 한 종류여야 한다\n${report}`).toEqual([]);

    const sizes = new Set(readings.map((reading) => `${reading.indicatorWidth}×${reading.indicatorHeight}`));
    expect([...sizes], `표시 크기가 자리마다 다르다\n${report}`).toHaveLength(1);

    /* 닫힘·열림의 회전값이 자리마다 다르면 "같은 표시"가 아니다. 지금 화면에는 닫힌 것과
       열린 것이 섞여 있으므로 상태별로 나눠 각각 한 값인지 본다. */
    const byState = new Map<string, Set<string>>();
    for (const reading of readings) {
      const key = reading.expanded ?? '(없음)';
      if (!byState.has(key)) byState.set(key, new Set());
      byState.get(key)!.add(reading.indicatorTransform);
    }
    for (const [state, transforms] of byState) {
      expect([...transforms], `${state === 'true' ? '열린' : '닫힌'} 표시의 회전이 자리마다 다르다: ${[...transforms].join(' / ')}\n${report}`).toHaveLength(1);
    }
    // 열림과 닫힘이 같은 그림이면 표시가 아무것도 말하지 않는다.
    if (byState.size > 1) {
      const values = [...byState.values()].map((set) => [...set][0]);
      expect(new Set(values).size, `열림과 닫힘의 표시가 같다 — 표시가 상태를 말하지 않는다\n${report}`).toBeGreaterThan(1);
    }
  } finally {
    await stopServer(server);
  }
});

test('화면 어디에도 글자로 그린 세모 표시가 없다', async ({ page }) => {
  const server = await boot(page);
  try {
    for (const screen of ['촬영', '설정'] as const) {
      if (screen === '설정') await openSettings(page);
      const found = await page.evaluate((glyphs) => {
        const scope = document.querySelector('#kairen-ui') ?? document.body;
        const text = (scope as HTMLElement).innerText ?? '';
        return glyphs.filter((glyph) => text.includes(glyph));
      }, CARET_GLYPHS);
      expect(found, `${screen} 화면에 글자 세모가 남아 있다`).toEqual([]);
    }
  } finally {
    await stopServer(server);
  }
});

// ── 2. 키보드로 닿고 Enter·Space로 조작된다 ───────────────────────────────────

test('접기 조작에 키보드로 닿고 초점이 눈에 보인다', async ({ page }) => {
  const server = await boot(page);
  try {
    /* `focus()`로 옮기면 안 된다 — 브라우저는 그때 초점 **표시**를 켜지 않는다
       (`:focus-visible`은 키보드로 옮겼을 때만 선다). 그래서 실제로 Tab을 눌러 간다.
       한 바퀴 도는 동안 만난 접기 조작을 모두 적어 두고 마지막에 한꺼번에 판정한다. */
    const seen = new Map<string, { outlineStyle: string; outlineWidth: number }>();
    const expected = (await readDisclosures(page)).map((reading) => reading.label);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    for (let step = 0; step < 160; step += 1) {
      await page.keyboard.press('Tab');
      const hit = await page.evaluate(() => {
        const node = document.activeElement as HTMLElement | null;
        if (!node || !node.hasAttribute('aria-expanded')) return null;
        const style = getComputedStyle(node);
        const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
        return {
          label: node.getAttribute('aria-label') ?? node.querySelector('strong')?.textContent?.trim() ?? (text.length > 26 ? `${text.slice(0, 26)}…` : text),
          outlineStyle: style.outlineStyle,
          outlineWidth: parseFloat(style.outlineWidth),
        };
      });
      if (hit) seen.set(hit.label, { outlineStyle: hit.outlineStyle, outlineWidth: hit.outlineWidth });
      if (expected.every((label) => seen.has(label))) break;
    }

    const unreached = expected.filter((label) => !seen.has(label));
    expect(unreached, `Tab으로 닿지 않는 접기 조작이 있다`).toEqual([]);
    for (const [label, focus] of seen) {
      expect(focus.outlineStyle, `${label}: 키보드 초점 표시가 없다`).not.toBe('none');
      expect(focus.outlineWidth, `${label}: 초점 테두리가 너무 얇다`).toBeGreaterThanOrEqual(2);
    }
  } finally {
    await stopServer(server);
  }
});

test('Enter와 Space 둘 다로 열고 닫을 수 있다', async ({ page }) => {
  const server = await boot(page);
  try {
    for (const target of [/명함 기록/, /만남 맥락/]) {
      const toggle = page.getByRole('button', { name: target });
      const before = await toggle.getAttribute('aria-expanded');
      await toggle.focus();
      await page.keyboard.press('Enter');
      await expect(toggle, `${target}: Enter로 상태가 바뀌지 않는다`).not.toHaveAttribute('aria-expanded', String(before));
      await page.keyboard.press('Space');
      await expect(toggle, `${target}: Space로 되돌아오지 않는다`).toHaveAttribute('aria-expanded', String(before));
    }
  } finally {
    await stopServer(server);
  }
});

// ── 3. 낭독기가 열림·닫힘을 읽는다 ────────────────────────────────────────────

test('낭독기가 열림·닫힘과 여닫는 영역을 읽는다', async ({ page }) => {
  const server = await boot(page);
  try {
    const readings = await readAllScreens(page);
    const report = describeAll(readings);

    const unsaid = readings.filter((reading) => reading.expanded !== 'true' && reading.expanded !== 'false').map((reading) => reading.label);
    expect(unsaid, `열림·닫힘을 말하지 않는 접기 조작이 있다\n${report}`).toEqual([]);

    const unlinked = readings.filter((reading) => !reading.controls).map((reading) => reading.label);
    expect(unlinked, `무엇을 여닫는지 말하지 않는 접기 조작이 있다 (\`aria-controls\` 없음)\n${report}`).toEqual([]);

    const broken = readings.filter((reading) => reading.controlsFound !== 1).map((reading) => `${reading.label}→${reading.controls}(${reading.controlsFound}개)`);
    expect(broken, `\`aria-controls\`가 가리키는 영역이 문서에 정확히 하나가 아니다\n${report}`).toEqual([]);

    const lying = readings.filter((reading) => reading.expanded === 'true' && reading.regionVisible === false).map((reading) => reading.label);
    expect(lying, `열렸다고 말하면서 영역이 보이지 않는다\n${report}`).toEqual([]);

    /* v2.26.0에서 `명함 기록` 옆 갱신 줄이 1초마다 글자가 바뀌는 `role="status"`라 낭독기를
       1초에 한 번씩 끊었다 (RELEASE.md v2.26.0 항목 5 / TSK-000562). 접기 조작 안에 계속
       말하는 자리를 두면 같은 결함이 그대로 돌아온다. */
    const noisy = readings.filter((reading) => reading.liveInside > 0).map((reading) => reading.label);
    expect(noisy, `접기 조작 안에 계속 말하는 자리가 있다 — 낭독기를 끊는다\n${report}`).toEqual([]);
  } finally {
    await stopServer(server);
  }
});

test('눌렀을 때 열림·닫힘과 영역이 함께 움직인다', async ({ page }) => {
  const server = await boot(page);
  try {
    const toggle = page.getByRole('button', { name: /명함 기록/ });
    const controlsId = await toggle.getAttribute('aria-controls');
    expect(controlsId, '`명함 기록`이 무엇을 여닫는지 말하지 않는다').toBeTruthy();
    const region = page.locator(`#${controlsId}`);

    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(region).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(region, '접었는데 영역이 그대로 보인다').toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(region, '폈는데 영역이 돌아오지 않는다').toBeVisible();
  } finally {
    await stopServer(server);
  }
});

// ── 4. 손가락으로 누를 수 있는 크기다 ─────────────────────────────────────────

test('접기 조작이 손가락으로 누를 수 있는 크기다', async ({ page }) => {
  const server = await boot(page);
  try {
    const readings = await readAllScreens(page);
    const report = describeAll(readings);

    /* 통과할 때도 실측을 남긴다. 다음 사람이 "44px이 어디서 오는지"를 코드에서 다시 추적하지
       않아도 되고, 어느 자리가 바닥에 딱 붙어 있는지가 보인다 (`int30-refresh.spec.ts`가
       상단 균형을 찍는 것과 같은 이유). */
    console.log(`[접기 손가락] ${readings.map((reading) => `${reading.label}=${reading.width}×${reading.height}`).join(' / ')}`);

    const thin = readings
      .filter((reading) => reading.touchMisses > 0)
      .map((reading) => `${reading.label}(${reading.width}×${reading.height}px, 44×44 중 ${reading.touchMisses}/9곳이 다른 것에 떨어진다)`);
    expect(thin, `손가락으로 누르기에 좁은 접기 조작이 있다\n${report}`).toEqual([]);
  } finally {
    await stopServer(server);
  }
});

// ── 5. 움직임을 끄면 표시가 돌아가는 동작이 사라진다 ──────────────────────────

test('움직임을 끄면 표시가 돌아가는 동작이 사라진다', async ({ page }) => {
  const server = await boot(page);
  try {
    /* 먼저 **켠 상태**에서 회전이 실제로 애니메이션되는지 본다. 이 확인 없이 "끄면 0"만
       주장하면, 애초에 아무 데도 회전이 안 걸려 있어도 초록이 된다.

       두 화면을 각각 두 상태로 읽는다 — 한 화면만 끈 상태로 보면 나머지 화면의 표시가 계속
       돌아도 초록이다. */
    const moving: Reading[] = [];
    const still: Reading[] = [];

    for (const screen of ['촬영', '설정'] as const) {
      if (screen === '설정') await openSettings(page);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      moving.push(...await readDisclosures(page));
      await page.emulateMedia({ reducedMotion: 'reduce' });
      still.push(...await readDisclosures(page));
    }

    expect(moving.length, '읽은 접기 조작이 없다 — 게이트가 빈 집합을 훑고 있다').toBeGreaterThanOrEqual(4);
    for (const reading of moving) {
      expect(reading.indicatorTransitionMs, `${reading.label}: 움직임을 켰는데도 표시가 부드럽게 돌지 않는다`).toBeGreaterThan(50);
    }
    for (const reading of still) {
      expect(reading.indicatorTransitionMs, `${reading.label}: 움직임을 껐는데도 표시가 돌아가는 동작이 남아 있다`).toBeLessThanOrEqual(20);
    }
  } finally {
    await stopServer(server);
  }
});
