// INT-000016 회귀 게이트.
//   001 하단 탭 바가 스크롤과 무관하게 같은 자리·같은 높이인가 (ISS-000084 / TSK-000220)
//   002 AI 표면이 평소에도 은은하게 살아 있고 처리 중에는 분명해지는가 (같은 Issue의 후속 visual slice)
//   003 다크 모드가 있고, 사용자가 직접 고른 값이 유지되는가
//
// 정직한 경계: 001의 원인은 브라우저 주소창이 접혔다 펴지며 보이는 높이가 바뀌는 것인데,
// headless Chrome에는 접히는 주소창이 없다. 그래서 여기서는 (a) 껍데기가 "지금 보이는 높이"에서
// 오는지, (b) 탭 바 높이가 실행 중에 변할 수 있는 값에 매달려 있지 않은지, (c) 실제 스크롤에
// 바가 1px도 움직이지 않는지를 잠근다. 실폰 판정은 이 게이트가 대신하지 못한다.
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const buildRoot = resolve(fileURLToPath(new URL('../../docs/', import.meta.url)));
const DAY_MINUTES = 24 * 60;

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

// 화면이 길어야 스크롤이 생긴다 — 항목 001은 스크롤이 있는 화면에서만 재현된다.
function listFixture() {
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const person = (index: number) => ({
    captureId: `2026072${index}-090000-b${index}`,
    receivedAt: ago(index * DAY_MINUTES),
    status: 'processed',
    person: `PER-00001${index}`,
    capturer: '이강규',
    event: '판교 밋업',
    contact: { name: `후보 ${index}`, title: '팀장', organization: `회사 ${index}` },
    brief: `# 후보 ${index} — 이런 분이에요\n회사 ${index} 팀장입니다.`,
  });
  return {
    ok: true,
    seeAll: true,
    researchInstructionEnabled: true,
    hasMore: false,
    items: Array.from({ length: 24 }, (_unused, index) => person(index + 1)),
  };
}

interface Harness { server: Server }

async function boot(page: Page, options: { theme?: string } = {}): Promise<Harness> {
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');

  await page.context().route('**/vendor/**', (route) => route.abort());
  await page.route('https://api.example.test/**', async (route) => {
    const action = new URL(route.request().url()).searchParams.get('action');
    if (action === 'list') { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(listFixture()) }); return; }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [] }) });
  });

  const theme = options.theme;
  await page.addInitScript((value) => {
    localStorage.setItem('cc_name', '이강규');
    if (value) localStorage.setItem('cc_theme', value);
  }, theme);
  await page.setViewportSize({ width: 390, height: 844 });
  const api = encodeURIComponent('https://api.example.test/exec');
  await page.goto(`http://127.0.0.1:${address.port}/next/?api=${api}&k=owner-token`, { waitUntil: 'networkidle' });
  return { server };
}

// ── 001: 하단 탭 바 ──

test('the app shell is sized to the height the user can actually see', async ({ page }) => {
  const harness = await boot(page);
  try {
    // 껍데기가 "주소창이 접힌 상태의 큰 viewport"(100%)에 묶여 있으면, 주소창이 펴져 있는 동안
    // 화면 아래 수십 px이 가려지고 거기 있는 탭 바가 통째로 사라진다. `dvh`는 지금 보이는 높이다.
    const shell = await page.evaluate(() => ({
      appHeight: getComputedStyle(document.documentElement).getPropertyValue('--cc-app-height').trim(),
      bodyHeight: getComputedStyle(document.body).height,
      safeBottom: getComputedStyle(document.documentElement).getPropertyValue('--cc-safe-bottom').trim(),
      documentScrolls: document.scrollingElement!.scrollHeight > document.scrollingElement!.clientHeight,
    }));
    expect(shell.appHeight, '껍데기 높이가 dvh(지금 보이는 높이)에서 오지 않는다').toBe('100dvh');
    expect(shell.bodyHeight).toBe('844px');
    // 탭 바 높이가 실행 중에 값이 바뀌는 `env(safe-area-inset-bottom)`에 그대로 매달려 있으면
    // iOS에서 주소창이 접힐 때 바 높이가 오르내린다. 부팅 시 실측한 px으로 고정돼야 한다.
    expect(shell.safeBottom, 'safe-area 여백이 부팅 시 고정된 px 값이 아니다').toMatch(/^-?\d+(\.\d+)?px$/);
    // 스크롤은 내부 컨테이너가 소유한다 — 문서가 스크롤되면 모바일 주소창이 그때마다 접힌다.
    expect(shell.documentScrolls, '문서 자체가 스크롤된다').toBe(false);
  } finally {
    harness.server.close();
  }
});

test('the bottom tab bar does not move a pixel however fast the screen is scrolled', async ({ page }) => {
  const harness = await boot(page);
  try {
    await page.getByRole('button', { name: '진행', exact: true }).click();
    const footer = page.locator('ion-footer.tab-footer');
    await expect(footer).toBeVisible();
    const before = await footer.boundingBox();

    // 빠른 왕복 스크롤. 실제로 스크롤된 화면에서 재야 의미가 있다.
    const scrolled = await page.evaluate(async () => {
      const scroller = await document.querySelector('ion-content')!.getScrollElement();
      const positions = [600, 0, 1200, 40, 900, 0];
      const seen: number[] = [];
      for (const top of positions) {
        scroller.scrollTop = top;
        await new Promise((done) => requestAnimationFrame(() => done(null)));
        seen.push(scroller.scrollTop);
      }
      return { max: Math.max(...seen), height: scroller.scrollHeight, client: scroller.clientHeight };
    });
    expect(scrolled.height, '스크롤이 생기지 않아 이 게이트가 아무것도 재지 못한다').toBeGreaterThan(scrolled.client + 200);
    expect(scrolled.max).toBeGreaterThan(200);

    const after = await footer.boundingBox();
    expect(after).toEqual(before);
  } finally {
    harness.server.close();
  }
});

// ── 002: AI 표면의 동적 시인성 ──

async function openRecall(page: Page) {
  await page.getByRole('button', { name: '검색', exact: true }).click();
  await page.getByRole('tab', { name: 'AI 사람 찾기' }).click();
}

// 평소(idle)에도 실제로 도는 애니메이션이 있는지 — 이름까지 받아 와 무엇이 도는지 남긴다.
async function runningAnimations(surface: ReturnType<Page['locator']>): Promise<string[]> {
  return surface.evaluate((node) => node
    .getAnimations({ subtree: true })
    .filter((animation) => animation.playState === 'running')
    .map((animation) => (animation as CSSAnimation).animationName ?? 'unnamed'));
}

test('both AI surfaces stay gently alive while idle and get louder while working', async ({ page }) => {
  const harness = await boot(page);
  try {
    // 조사 요청 — 촬영 화면. 평소에도 움직인다 (founder 확정: 처리 중이 아닐 때도 은은하게).
    const research = page.locator('.ai-surface.research-request');
    await expect(research).toHaveAttribute('data-ai-state', 'idle');
    expect(await runningAnimations(research), 'AI 조사 요청이 평소에 멈춰 있다').not.toEqual([]);

    // AI 사람 찾기 — 검색 화면. 확정된 범위는 "두 표면 모두"다.
    await openRecall(page);
    const recall = page.locator('.ai-surface.recall-request');
    await expect(recall).toHaveAttribute('data-ai-state', 'idle');
    expect(await runningAnimations(recall), 'AI 사람 찾기가 평소에 멈춰 있다').not.toEqual([]);

    // 처리 중에는 상태가 바뀌고, 움직임과 별개로 테두리만 봐도 구분된다.
    const idleBorder = await recall.evaluate((node) => getComputedStyle(node).borderTopColor);
    await page.getByRole('textbox', { name: '기억나는 대로 문장으로 찾기' }).fill('판교에서 만난 팀장');
    await page.route('https://api.example.test/**', async (route) => {
      await new Promise((done) => setTimeout(done, 2_500));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(listFixture()) });
    });
    await page.getByRole('button', { name: '찾기' }).click();
    await expect(recall).toHaveAttribute('data-ai-state', 'active');
    const activeBorder = await recall.evaluate((node) => getComputedStyle(node).borderTopColor);
    expect(activeBorder, '처리 중과 평소가 시각적으로 같다').not.toBe(idleBorder);

    // 진행 표면도 같은 문법을 쓴다.
    await expect(page.locator('.ai-surface.recall-progress')).toHaveAttribute('data-ai-state', 'active');
  } finally {
    harness.server.close();
  }
});

test('reduced motion removes the movement but never the meaning', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const harness = await boot(page);
  try {
    await openRecall(page);
    const recall = page.locator('.ai-surface.recall-request');
    const looping = await recall.evaluate((node) => node
      .getAnimations({ subtree: true })
      .filter((animation) => animation.playState === 'running' && (animation.effect?.getComputedTiming().iterations ?? 1) === Infinity)
      .length);
    expect(looping, '움직임을 끈 사용자에게도 무한 애니메이션이 돈다').toBe(0);

    // 상태는 여전히 읽힌다 — 표면 상태와 지금 고른 것이 글자·속성으로 남는다.
    // (조사 요청의 처리 단계 막대는 TSK-000535로 사라졌다. 진행은 명함 기록·진행의 블록이 소유한다.)
    await expect(recall).toHaveAttribute('data-ai-state', 'idle');
    await page.getByRole('button', { name: '캡처', exact: true }).click();
    const research = page.locator('.ai-surface.research-request');
    await expect(research).toHaveAttribute('data-ai-state', 'idle');
    await expect(research.locator('.research-scope-count')).toHaveText(/9개 중 0개 선택/);
    await research.getByRole('button', { name: '모두 선택' }).click();
    await expect(research.getByRole('button', { name: '모두 해제' })).toHaveAttribute('aria-pressed', 'true');
  } finally {
    harness.server.close();
  }
});

// ── 003: 다크 모드 ──

/** WCAG 대비 계산. 앱의 공식이 아니라 표준 공식을 여기서 다시 쓴다 — 자기충족 검사를 피한다. */
const CONTRAST_SWEEP = `(() => {
  const parse = (value) => {
    const match = value.match(/rgba?\\(([^)]+)\\)/);
    if (!match) return null;
    const parts = match[1].split(/[,\\s/]+/).filter(Boolean).map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const over = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  });
  const luminance = (color) => {
    const channel = (value) => { const s = value / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
  };
  const ratio = (a, b) => {
    const first = luminance(a); const second = luminance(b);
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
  };
  const pageBackground = parse(getComputedStyle(document.documentElement).getPropertyValue('--cc-page').trim()) ?? { r: 255, g: 255, b: 255, a: 1 };
  const failures = []; const skipped = [];
  for (const element of document.querySelectorAll('body *')) {
    const ownsText = [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());
    if (!ownsText) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const style = getComputedStyle(element);
    if (style.visibility === 'hidden' || style.opacity === '0') continue;
    const color = parse(style.color);
    if (!color || color.a === 0) continue;

    // 뒤에 있는 배경을 실제로 겹쳐서 계산한다.
    // 그라데이션은 색이 하나가 아니므로 색 정지점들의 평균으로 근사한다 — 우리 그라데이션은
    // 모두 한 색조 안에서 미세하게 변하는 종류라 평균이 실제 뒷배경을 잘 대변한다.
    // 정지점을 하나도 못 읽으면 그때는 포기하고 건너뛴 수를 센다(조용한 누락 금지).
    const averageStops = (image) => {
      const stops = (image.match(/rgba?\\([^)]+\\)/g) ?? []).map(parse).filter(Boolean);
      if (!stops.length) return null;
      const sum = stops.reduce((total, stop) => ({ r: total.r + stop.r, g: total.g + stop.g, b: total.b + stop.b, a: total.a + stop.a }), { r: 0, g: 0, b: 0, a: 0 });
      return { r: sum.r / stops.length, g: sum.g / stops.length, b: sum.b / stops.length, a: sum.a / stops.length };
    };
    const layers = []; let node = element; let unknown = false;
    while (node && node !== document.documentElement) {
      const nodeStyle = getComputedStyle(node);
      const background = parse(nodeStyle.backgroundColor);
      const hasGradient = nodeStyle.backgroundImage.includes('gradient');
      if (hasGradient) {
        const approximated = averageStops(nodeStyle.backgroundImage);
        if (!approximated) { unknown = true; break; }
        layers.push(approximated);
        if (approximated.a >= 0.98) break;
      }
      if (background && background.a > 0) { layers.push(background); if (background.a === 1) break; }
      node = node.parentElement;
    }
    if (unknown) { skipped.push(element.className || element.tagName); continue; }
    let background = pageBackground;
    for (let index = layers.length - 1; index >= 0; index -= 1) background = over(layers[index], background);

    const size = parseFloat(style.fontSize);
    const large = size >= 24 || (size >= 18.66 && parseInt(style.fontWeight, 10) >= 700);
    const needed = large ? 3 : 4.5;
    const measured = ratio(over(color, background), background);
    if (measured < needed) {
      failures.push({
        where: element.tagName.toLowerCase() + '.' + String(element.className || '').split(' ').slice(0, 2).join('.'),
        text: element.textContent.trim().slice(0, 20),
        color: style.color,
        ratio: Math.round(measured * 100) / 100,
        needed,
      });
    }
  }
  return { failures, skipped: skipped.length };
})()`;

test('a new device starts light, and the founder can pick light, dark, or system', async ({ page }) => {
  const harness = await boot(page);
  try {
    // 최초 기본값은 라이트다 (founder 확정 2026-07-27).
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    await page.getByRole('button', { name: '설정', exact: true }).click();
    const choices = page.getByRole('radiogroup', { name: '화면 테마' });
    await expect(choices.getByRole('radio', { name: /라이트/ })).toHaveAttribute('aria-checked', 'true');

    await choices.getByRole('radio', { name: /다크/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', /#141020/);

    // 고른 값은 유지된다 — 새로고침해도 다크로 돌아온다.
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  } finally {
    harness.server.close();
  }
});

test('a chosen theme beats the phone setting, and `시스템` follows it', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  const harness = await boot(page, { theme: 'light' });
  try {
    // 사용자가 라이트를 골랐으면 폰이 다크여도 라이트다. 자동 추종만으로는 부족하다는 게 이 요구의 핵심이다.
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    await page.getByRole('button', { name: '설정', exact: true }).click();
    await page.getByRole('radiogroup', { name: '화면 테마' }).getByRole('radio', { name: /시스템/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  } finally {
    harness.server.close();
  }
});

test('every screen stays readable in dark mode', async ({ page }) => {
  const harness = await boot(page, { theme: 'dark' });
  try {
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    for (const tab of ['캡처', '진행', '검색', '설정']) {
      await page.getByRole('button', { name: tab, exact: true }).click();
      if (tab === '검색') await page.getByRole('tab', { name: 'AI 사람 찾기' }).click();
      await page.waitForTimeout(150);
      const swept = await page.evaluate(CONTRAST_SWEEP) as { failures: unknown[]; skipped: number };
      expect(swept.failures, `${tab} 화면에서 읽기 어려운 글자: ${JSON.stringify(swept.failures)}`).toEqual([]);
      // 그라데이션 뒤에 있어 계산에서 빠진 요소가 너무 많으면 이 게이트는 아무것도 보증하지 못한다.
      expect(swept.skipped, `${tab} 화면에서 대비를 잴 수 없는 요소가 너무 많다`).toBeLessThan(25);
    }
  } finally {
    harness.server.close();
  }
});
