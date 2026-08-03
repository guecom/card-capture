// founder 판정 2026-07-28 (ISS-000111) 회귀 게이트.
//   001 다크에서 K 표식이 테마 강조색을 따르는가 (라이트 파랑이 남아 있지 않은가)
//   002 다크 idle에서 AI 표면의 은은한 하이라이팅이 **눈에 보이는가**
//   003 `AI 조사 요청`과 `AI 사람 찾기`가 같은 색 맥락인가
//   004 하이라이팅이 박스 **전체**를 지나가는가
//   005 모서리 반경이 정해진 계단 안에 있는가 (둥글둥글 → 또렷한 위계)
//   006 강조색이 토큰화돼 다크에 라이트 파랑이 새지 않는가
//
// 진실값은 렌더된 픽셀이다. 002·004는 앱의 CSS 값을 다시 읽어 확인하지 않는다 —
// 애니메이션을 프레임 단위로 고정해 실제로 찍은 두 장의 차이를 잰다.
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

declare global {
  interface Window { ccWalk: (root?: ParentNode) => Generator<Element>; }
}

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

/** 화면을 훑을 때 shadow DOM 안까지 들어간다.
 *
 *  Ionic 컴포넌트는 실제로 칠해지는 요소가 shadow root 안에 있다. `document.querySelectorAll`만
 *  쓰면 `ion-button`의 반경은 host의 `0px`로 읽히고 진짜 값(내부 `.button-native`)은 보이지 않는다.
 *  실제로 클래스를 안 준 `IonButton` 14곳이 Ionic 기본 알약으로 남아 있었는데, shadow를 뚫지 않는
 *  게이트는 그것을 통과시켰다 — 즉 이 앱의 Ionic 표면 전체가 사각지대였다. */
const SHADOW_WALKER = `window.ccWalk = function* ccWalk(root) {
  for (const element of (root ?? document.body).querySelectorAll('*')) {
    yield element;
    if (element.shadowRoot) yield* ccWalk(element.shadowRoot);
  }
};`;

async function boot(page: Page, theme: 'light' | 'dark'): Promise<Harness> {
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');

  await page.context().route('**/vendor/**', (route) => route.abort());
  await page.route('https://api.example.test/**', async (route) => {
    const action = new URL(route.request().url()).searchParams.get('action');
    if (action === 'list') { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(listFixture()) }); return; }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [] }) });
  });

  await page.addInitScript((value) => {
    localStorage.setItem('cc_name', '이강규');
    localStorage.setItem('cc_theme', value);
  }, theme);
  await page.setViewportSize({ width: 390, height: 844 });
  const api = encodeURIComponent('https://api.example.test/exec');
  await page.goto(`http://127.0.0.1:${address.port}/next/?api=${api}&k=owner-token`, { waitUntil: 'networkidle' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await page.evaluate(SHADOW_WALKER);
  return { server };
}

// ── 001 · 006: 강조색은 테마가 소유한다 ──

test('the K mark and every painted surface follow the theme accent in dark mode', async ({ page }) => {
  const harness = await boot(page, 'dark');
  try {
    // K 표식이 라이트 파랑으로 박혀 있으면 보라 화면에서 이것만 튄다 (founder 항목 1).
    const mark = await page.locator('.brand-mark').evaluate((node) => {
      const style = getComputedStyle(node);
      return { image: style.backgroundImage, color: style.backgroundColor, shadow: style.boxShadow };
    });
    expect(`${mark.image} ${mark.color} ${mark.shadow}`, 'K 표식이 라이트 파랑을 그대로 쓴다').not.toMatch(/35,\s*104,\s*216/);

    // 화면 전체에서 라이트 강조색이 남아 있는 자리를 센다. 하나라도 남으면 다크는 두 색이 섞인다.
    for (const tab of ['캡처', '진행', '검색', '설정']) {
      await page.getByRole('button', { name: tab, exact: true }).click();
      if (tab === '검색') await page.getByRole('tab', { name: 'AI 사람 찾기' }).click();
      await page.waitForTimeout(120);
      const leaks = await page.evaluate(() => {
        const painted = ['backgroundColor', 'backgroundImage', 'borderTopColor', 'borderBottomColor', 'borderLeftColor', 'borderRightColor', 'color', 'boxShadow', 'outlineColor'] as const;
        const found: string[] = [];
        for (const element of window.ccWalk()) {
          const rect = element.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2) continue;
          const style = getComputedStyle(element);
          for (const property of painted) {
            if (/rgba?\(\s*35,\s*104,\s*216/.test(String(style[property]))) {
              found.push(`${element.tagName.toLowerCase()}.${String(element.className || '').split(' ').slice(0, 2).join('.')} ${property}`);
              break;
            }
          }
        }
        return found;
      });
      expect(leaks, `${tab} 화면에 라이트 파랑이 남아 있다`).toEqual([]);
    }
  } finally {
    harness.server.close();
  }
});

// ── 003: 두 AI 표면은 한 가지 색 맥락 ──

test('both AI surfaces speak the same colour', async ({ page }) => {
  const harness = await boot(page, 'dark');
  try {
    const read = (selector: string) => page.locator(selector).evaluate((node) => {
      const style = getComputedStyle(node);
      return { border: style.borderTopColor, background: style.backgroundImage, rim: style.getPropertyValue('--cc-ai-rim').trim() };
    });
    const research = await read('.ai-surface.research-request');

    await page.getByRole('button', { name: '검색', exact: true }).click();
    await page.getByRole('tab', { name: 'AI 사람 찾기' }).click();
    const recall = await read('.ai-surface.recall-request');

    expect(recall.border, 'AI 사람 찾기의 테두리색이 AI 조사 요청과 다르다').toBe(research.border);
    expect(recall.background, 'AI 사람 찾기의 배경이 AI 조사 요청과 다르다').toBe(research.background);
    expect(recall.rim, 'AI 사람 찾기의 둘레 발광색이 AI 조사 요청과 다르다').toBe(research.rim);
  } finally {
    harness.server.close();
  }
});

// ── 002 · 004: idle 하이라이팅이 실제로 보이고, 박스 전체를 지난다 ──

/** 애니메이션을 프레임으로 고정하고 그 순간의 표면을 찍는다. 값이 아니라 픽셀을 남긴다.
 *
 *  찍는 자리는 표면 **위쪽 안쪽 여백 띠**다. 여기에는 글자도, 단계 막대도, 표식도 없다 —
 *  오직 표면 자신의 배경과 그 위를 지나는 빛만 있다. 표면 전체를 찍으면 이미 움직이던
 *  단계 막대(`cc-ai-rail`)의 큰 변화가 섞여, 배경이 완전히 정지해 있어도 이 게이트가 통과한다. */
async function frameAt(page: Page, selector: string, seconds: number): Promise<Buffer> {
  await page.evaluate(({ target, at }) => {
    const node = document.querySelector(target)!;
    for (const animation of node.getAnimations({ subtree: true })) {
      if (!Number(animation.effect?.getComputedTiming().duration ?? 0)) continue;
      animation.pause();
      animation.currentTime = at * 1000;
    }
  }, { target: selector, at: seconds });
  const box = (await page.locator(selector).boundingBox())!;
  return page.screenshot({
    clip: { x: Math.round(box.x) + 8, y: Math.round(box.y) + 2, width: Math.round(box.width) - 16, height: 10 },
  });
}

/** PNG 두 장을 캔버스에 올려 열(column)별 최대 채널 차이를 낸다. */
async function columnDeltas(page: Page, first: Buffer, second: Buffer): Promise<number[]> {
  return page.evaluate(async ([a, b]) => {
    const load = (base64: string) => new Promise<HTMLImageElement>((done, fail) => {
      const image = new Image();
      image.onload = () => done(image);
      image.onerror = fail;
      image.src = `data:image/png;base64,${base64}`;
    });
    const [one, two] = await Promise.all([load(a), load(b)]);
    const draw = (image: HTMLImageElement) => {
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, image.width, image.height).data;
    };
    const left = draw(one); const right = draw(two);
    const columns: number[] = [];
    for (let x = 0; x < one.width; x += 1) {
      let worst = 0;
      for (let y = 0; y < one.height; y += 1) {
        const index = (y * one.width + x) * 4;
        worst = Math.max(worst, Math.abs(left[index] - right[index]), Math.abs(left[index + 1] - right[index + 1]), Math.abs(left[index + 2] - right[index + 2]));
      }
      columns.push(worst);
    }
    return columns;
  }, [first.toString('base64'), second.toString('base64')]);
}

for (const theme of ['dark', 'light'] as const) {
  test(`the idle AI surface visibly breathes across its whole width in ${theme} mode`, async ({ page }) => {
    const harness = await boot(page, theme);
    try {
      const selector = '.ai-surface.research-request';
      await expect(page.locator(selector)).toHaveAttribute('data-ai-state', 'idle');
      await page.locator(selector).scrollIntoViewIfNeeded();
      await page.waitForTimeout(150);

      // 실제 시간(초) 위에서 표본을 뜬다. "동적으로 보인다"는 주기 안의 어느 국면이냐가 아니라
      // **1초 사이에 눈에 띄게 변하느냐**의 문제다 — 9.5초에 걸쳐 서서히 밝아지는 빛은
      // 두 극단을 나란히 놓으면 달라 보이지만, 화면을 보고 있는 사람에게는 정지 화면이다.
      const step = 0.5;
      const seconds = Array.from({ length: 17 }, (_unused, index) => index * step);
      const frames: Buffer[] = [];
      for (const at of seconds) frames.push(await frameAt(page, selector, at));

      let perSecond = 0;
      let bestPeak = 0;
      let bestCoverage = 0;
      for (let i = 0; i < frames.length; i += 1) {
        for (let j = i + 1; j < frames.length; j += 1) {
          const columns = await columnDeltas(page, frames[i], frames[j]);
          const peak = Math.max(...columns);
          // 항목 004: 빛이 박스 **전체**를 지나야 한다 — 일부 열만 변하면 구석의 얼룩으로 읽힌다.
          bestCoverage = Math.max(bestCoverage, columns.filter((delta) => delta >= 3).length / columns.length);
          bestPeak = Math.max(bestPeak, peak);
          if ((j - i) * step <= 1) perSecond = Math.max(perSecond, peak);
        }
      }
      console.log(`[${theme}] perSecond=${perSecond} peak=${bestPeak} coverage=${Math.round(bestCoverage * 100)}%`);
      // 1초 안의 변화가 10/255에 못 미치면 화면은 멈춰 있는 것으로 읽힌다 (founder 항목 2).
      expect(perSecond, `${theme} idle 하이라이팅이 1초 안에 거의 변하지 않는다 (${perSecond}/255)`).toBeGreaterThanOrEqual(10);
      // 그러나 **은은해야** 한다. 위쪽 경계가 없으면 다음 사람이 "잘 보이게" 밝히다 광고판이 된다.
      expect(bestPeak, `${theme} idle 하이라이팅이 은은하지 않다 (${bestPeak}/255)`).toBeLessThanOrEqual(70);
      expect(bestCoverage, `${theme} 하이라이팅이 박스 일부에만 나타난다 (폭의 ${Math.round(bestCoverage * 100)}%)`).toBeGreaterThanOrEqual(0.9);
    } finally {
      harness.server.close();
    }
  });
}

// ── 005: 모서리 계단 ──

test('corner radii stay on a deliberate scale instead of blanket softness', async ({ page }) => {
  const harness = await boot(page, 'light');
  try {
    for (const tab of ['캡처', '진행', '검색', '설정']) {
      await page.getByRole('button', { name: tab, exact: true }).click();
      if (tab === '검색') await page.getByRole('tab', { name: 'AI 사람 찾기' }).click();
      await page.waitForTimeout(120);
      const swept = await page.evaluate(() => {
        const found: { where: string; radius: string }[] = [];
        let inspected = 0;
        let shadowSeen = 0;
        for (const element of window.ccWalk()) {
          if (element.getRootNode() !== document) shadowSeen += 1;
          const rect = element.getBoundingClientRect();
          if (rect.width < 24 || rect.height < 20) continue;
          inspected += 1;
          const style = getComputedStyle(element);
          const radius = parseFloat(style.borderTopLeftRadius);
          if (!Number.isFinite(radius)) continue;
          const where = `${element.tagName.toLowerCase()}.${String(element.className || '').split(' ').slice(0, 2).join('.')}`;
          // 알약은 **읽는 이름표**의 모양이다. 누르는 자리가 알약이면 계단이 깨진다 —
          // 클래스 없는 `IonButton`이 Ionic 기본 알약으로 남아 설정 화면만 예전 인상이던 자리다.
          // Ionic은 실제 버튼을 shadow root 안(`.button-native`)에 그리므로 그 이름도 받아 준다.
          const pressable = ['BUTTON', 'ION-BUTTON', 'A'].includes(element.tagName)
            || element.classList.contains('button-native')
            || element.getAttribute('role') === 'button';
          if (radius >= 100) {
            if (pressable && rect.height >= 36) found.push({ where, radius: '알약(누르는 자리)' });
            continue;
          }
          if (radius > 16) found.push({ where, radius: style.borderTopLeftRadius });
        }
        return { found, inspected, shadowSeen };
      });
      expect(swept.found, `${tab} 화면의 모서리가 계단(최대 16px)을 넘는다: ${JSON.stringify(swept.found)}`).toEqual([]);
      // 아무것도 훑지 못한 스윕은 통과가 아니라 침묵이다 — 특히 shadow DOM에 한 번도 못 들어갔다면
      // Ionic 표면 전체가 검사 밖이라는 뜻이다.
      expect(swept.inspected, `${tab} 화면에서 잰 요소가 너무 적다`).toBeGreaterThan(15);
      expect(swept.shadowSeen, `${tab} 화면에서 shadow DOM 안으로 한 번도 들어가지 못했다`).toBeGreaterThan(0);
    }
  } finally {
    harness.server.close();
  }
});

// ── 007: 폰이 움직임을 줄여도, 사용자가 켜기를 고르면 앱은 움직인다 ──
//
// founder 2차 판정 2026-07-28: "여전히 하이라이팅이 안 나옴".
// 실측으로 원인을 갈랐다 — 폰이 `움직임 최소화`를 켜고 있으면 우리 빛은 한 픽셀도 그려지지 않았다
// (그 조건에서 시간에 따른 픽셀 변화 0). 그건 결함이 아니라 존중이지만 **말없이 사라지면 고장으로
// 읽힌다.** 그래서 OS 설정은 기본값이 되고, 설정에서 직접 켤 수 있어야 한다.
//
// 이 게이트가 지키는 계약은 셋이다:
//   (a) 아무것도 고르지 않은 사람에게는 폰 설정이 그대로 존중된다 (지금까지의 약속을 깨지 않는다)
//   (b) 그때 화면은 **왜** 멈춰 있는지 말한다
//   (c) `켜기`를 고르면 폰이 여전히 줄이라고 해도 앱 안에서는 움직인다
test('a phone that reduces motion stops the light, says so, and can be overridden', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const harness = await boot(page, 'dark');
  try {
    // (a) 기본값 `시스템` — 폰이 줄이라고 하면 멈춘다.
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'off');
    const surface = page.locator('.ai-surface.research-request');
    const stopped = await surface.evaluate((node) => ({
      sweep: getComputedStyle(node, '::before').display,
      looping: node.getAnimations({ subtree: true })
        .filter((a) => a.playState === 'running' && (a.effect?.getComputedTiming().iterations ?? 1) === Infinity).length,
    }));
    expect(stopped.sweep, '움직임을 줄인 폰에서 빛이 계속 그려진다').toBe('none');
    expect(stopped.looping, '움직임을 줄인 폰에서 무한 애니메이션이 돈다').toBe(0);

    // (b) 왜 멈춰 있는지 화면이 말한다.
    await page.getByRole('button', { name: '설정', exact: true }).click();
    const card = page.getByRole('radiogroup', { name: '화면 움직임' });
    await expect(card).toBeVisible();
    await expect(page.getByText(/움직임 최소화를 켜 두어서/)).toBeVisible();

    // (c) 켜기를 고르면 폰 설정과 무관하게 앱 안에서 움직인다 — 이게 이번 판정의 핵심이다.
    await card.getByRole('radio', { name: /켜기/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-motion', 'on');
    await page.getByRole('button', { name: '캡처', exact: true }).click();
    await surface.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    const revived = await surface.evaluate((node) => ({
      sweep: getComputedStyle(node, '::before').display,
      looping: node.getAnimations({ subtree: true })
        .filter((a) => a.playState === 'running' && (a.effect?.getComputedTiming().iterations ?? 1) === Infinity).length,
    }));
    expect(revived.sweep, '켜기를 골랐는데도 빛이 그려지지 않는다').not.toBe('none');
    expect(revived.looping, '켜기를 골랐는데도 애니메이션이 돌지 않는다').toBeGreaterThan(0);

    // 값이 아니라 픽셀로 확인한다 — 애니메이션이 "돈다"고 보고되면서 화면은 정지한 경우가 실제로 있었다.
    const box = (await surface.boundingBox())!;
    const clip = { x: Math.round(box.x) + 8, y: Math.round(box.y) + 2, width: Math.round(box.width) - 16, height: 10 };
    const frames: Buffer[] = [];
    for (let i = 0; i < 4; i += 1) { frames.push(await page.screenshot({ clip })); await page.waitForTimeout(800); }
    let moved = 0;
    for (let i = 0; i < frames.length; i += 1) {
      for (let j = i + 1; j < frames.length; j += 1) moved = Math.max(moved, ...(await columnDeltas(page, frames[i], frames[j])));
    }
    expect(moved, `켜기를 골랐는데 화면이 실제로는 정지해 있다 (${moved}/255)`).toBeGreaterThanOrEqual(10);

    // 고른 값은 이 기기에 남는다.
    expect(await page.evaluate(() => localStorage.getItem('cc_motion'))).toBe('on');
  } finally {
    harness.server.close();
  }
});

// ── 008: 스타일시트가 요구하는 굵기가 실제로 렌더된다 ──
//
// founder 2026-07-28: "서체는 너가 확인해봐."
// 확인 결과 `Inter, Pretendard`를 이름으로만 적어 두고 한 번도 싣지 않았다. 모든 기기가 OS 기본
// 서체로 떨어졌고, 위계를 위해 쓴 numeric weight 15종이 두 단계로 뭉개졌다 — 수정 전 실측에서
// `650`과 `780`의 글자 폭이 **완전히 같았다**(둘 다 bold로 스냅).
// 이 게이트는 "서체 파일이 있다"가 아니라 **"굵기가 서로 다르게 그려진다"**를 잰다.
test('the weights the stylesheet asks for are actually different on screen', async ({ page }) => {
  const harness = await boot(page, 'light');
  try {
    const measured = await page.evaluate(async () => {
      await document.fonts.ready;
      const family = getComputedStyle(document.documentElement).getPropertyValue('--ion-font-family');
      const loaded = [...document.fonts].filter((face) => face.status === 'loaded').map((face) => face.family);
      const probe = document.createElement('div');
      probe.style.cssText = 'position:fixed;left:-9999px;top:0;font-size:40px;white-space:nowrap';
      probe.style.fontFamily = family;
      document.body.appendChild(probe);
      const widths: Record<number, number> = {};
      // 한글과 라틴을 같이 잰다 — 라틴만 실린 서체는 본문 대부분을 못 고친다.
      for (const weight of [400, 550, 650, 700, 780, 800]) {
        probe.style.fontWeight = String(weight);
        probe.textContent = '명함 캡처 Kairen';
        widths[weight] = Math.round(probe.getBoundingClientRect().width * 100) / 100;
      }
      probe.remove();
      return { loaded, widths };
    });
    expect(measured.loaded.length, '실제로 로드된 웹폰트가 하나도 없다 — 이름만 적어 둔 상태다').toBeGreaterThan(0);
    const distinct = new Set(Object.values(measured.widths));
    expect(
      distinct.size,
      `굵기가 화면에서 구분되지 않는다 (요청 6단계 → 실제 ${distinct.size}단계): ${JSON.stringify(measured.widths)}`,
    ).toBeGreaterThanOrEqual(5);
  } finally {
    harness.server.close();
  }
});
