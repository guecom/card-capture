// founder 판정 2026-07-28 (ISS-000111) 회귀 게이트.
//   001 다크에서 K 표식이 테마 강조색을 따르는가 (라이트 파랑이 남아 있지 않은가)
//   002 다크 idle에서 AI 표면의 은은한 하이라이팅이 **눈에 보이는가**
//   003 `AI 조사 요청`과 `AI 사람 찾기`가 같은 색 맥락인가
//   004 하이라이팅이 박스 **전체**를 지나가는가
//   005 모서리 반경이 정해진 계단 안에 있는가 (둥글둥글 → 또렷한 위계)
//   006 강조색이 토큰화돼 다크에 라이트 파랑이 새지 않는가
//
// founder 판정 2026-08-04 (INT-000030 v2.25.0 통합 검수) 회귀 게이트 — Kairen-Ref: TSK-000220.
// 다섯 lane이 서로를 못 보고 만든 표면들의 이음매다. 전부 "조용히 되돌아가는" 종류라 게이트를 남긴다.
//   009 나란한 진입 카드의 제목·설명·행동이 **같은 선**에서 시작하는가 (통일감의 실체)
//   010 카드 설명 상자에 늘어난 죽은 공백이 없고, 두 칸을 가로지르는 카드가 세로로 부풀지 않는가
//   011 `예시` 이름표 밑으로 둘째 줄 chip이 파고들지 않는가
//   012 어떤 폭·연결 상태에서도 진입 카드 설명이 `…`로 잘리지 않는가
//   013 3칸 선택 위젯 두 벌(`조사 깊이`·`화면 테마`)이 한 벌의 해부를 쓰는가
//   014 설정의 그룹 이름표와 첫 항목이 서로 구별되는가
//   015 미연결에서 위·아래 두 갱신 표면이 같은 말을 하는가
//   016 경고 색조가 손으로 베낀 값이 아니라 테마 토큰을 따르는가
//
// 진실값은 렌더된 픽셀이다. 002·004는 앱의 CSS 값을 다시 읽어 확인하지 않는다 —
// 애니메이션을 프레임 단위로 고정해 실제로 찍은 두 장의 차이를 잰다.
// 012도 같은 규율을 따른다: `scrollWidth - clientWidth`는 이 프로젝트에서 거짓 통과를 낸 적이
// 있어 쓰지 않고, **클램프를 푼 복제본의 높이**와 실제 렌더 높이를 견준다.
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

interface BootOptions {
  width?: number;
  height?: number;
  /** 개인 링크로 열렸는가. `false`면 미연결 첫 방문 상태 그대로 뜬다. */
  connected?: boolean;
  /**
   * 이 기기에 카메라가 있는가.
   *
   * 선언하지 않으면 이 파일은 **실행한 기계**를 잰다. 진입 카드의 조각 수와 마지막 조각의 모양이
   * 기기 능력으로 갈리기 때문이다(`services/device-capability.ts`): 웹캠이 있으면 카드는
   * `행동` 한 줄로 끝나고, 없으면 `이유`가 붙고 마지막 줄이 34px짜리 회복 버튼이 된다.
   * 2026-08-04 CI 실패가 바로 그 차이였다 — 웹캠 있는 개발 PC에서는 전부 통과하고
   * 웹캠 없는 runner에서만 두 카드의 행동 줄이 20px 어긋났다. 기본값은 `present`다.
   */
  camera?: 'present' | 'absent';
}

/** 기기의 카메라 사실을 못 박는다. 두 세계 모두 이 앱이 실제로 만나는 세계다. */
async function declareCamera(page: Page, world: 'present' | 'absent'): Promise<void> {
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
  }, world === 'present');
}

async function boot(page: Page, theme: 'light' | 'dark', options: BootOptions = {}): Promise<Harness> {
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
  await declareCamera(page, options.camera ?? 'present');
  await page.setViewportSize({ width: options.width ?? 390, height: options.height ?? 844 });
  const api = encodeURIComponent('https://api.example.test/exec');
  const query = options.connected === false ? '' : `?api=${api}&k=owner-token`;
  await page.goto(`http://127.0.0.1:${address.port}/next/${query}`, { waitUntil: 'networkidle' });
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

// ── 007: 폰이 줄이라고 하지 않으면 빛은 실제로 움직인다 ──
//
// 원래 이 자리는 `화면 움직임` preference를 지키는 게이트였다. DEC-000093이 그 preference를
// 없앴다 — 움직임은 사용자가 관리할 설정이 아니라 제품이 책임질 동작이고, 폰의 `움직임 최소화`가
// 유일한 기준이다. 그래서 그때의 (b)(화면이 왜 멈췄는지 말한다)와 (c)(설정에서 되켤 수 있다)는
// 지킬 계약이 아니게 됐다.
//
// 그런데 (a)만 남기고 지우면 **구멍이 생긴다.** `prefers-reduced-motion`을 존중하는지 보는
// 게이트는 두 개 더 있지만(`int16-surfaces` 무한 애니메이션 0건, `status-truth` animationName
// none) 셋 다 "줄이라고 했을 때 멈추는가"만 본다. 빛을 통째로 지워도 전부 통과한다 —
// ISS-000129가 정확히 그 방식으로 늦게 발견됐다.
//
// 그래서 방향을 뒤집어 **줄이라고 하지 않았을 때 실제로 움직이는가**를 픽셀로 확인한다.
// 값이 아니라 픽셀인 이유: 애니메이션이 "돈다"고 보고되면서 화면은 정지해 있던 경우가 실제로 있었다.
test('a phone that does not reduce motion actually gets the moving light', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const harness = await boot(page, 'dark');
  try {
    const surface = page.locator('.ai-surface.research-request');
    await surface.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    const running = await surface.evaluate((node) => ({
      sweep: getComputedStyle(node, '::before').display,
      looping: node.getAnimations({ subtree: true })
        .filter((a) => a.playState === 'running' && (a.effect?.getComputedTiming().iterations ?? 1) === Infinity).length,
    }));
    expect(running.sweep, '움직임을 줄이지 않은 폰에서 빛이 아예 그려지지 않는다').not.toBe('none');
    expect(running.looping, '움직임을 줄이지 않은 폰에서 애니메이션이 돌지 않는다').toBeGreaterThan(0);

    const box = (await surface.boundingBox())!;
    const clip = { x: Math.round(box.x) + 8, y: Math.round(box.y) + 2, width: Math.round(box.width) - 16, height: 10 };
    const frames: Buffer[] = [];
    for (let i = 0; i < 4; i += 1) { frames.push(await page.screenshot({ clip })); await page.waitForTimeout(800); }
    let moved = 0;
    for (let i = 0; i < frames.length; i += 1) {
      for (let j = i + 1; j < frames.length; j += 1) moved = Math.max(moved, ...(await columnDeltas(page, frames[i], frames[j])));
    }
    expect(moved, `빛이 돈다고 보고되지만 화면은 실제로 정지해 있다 (${moved}/255)`).toBeGreaterThanOrEqual(10);

    // preference가 사라졌다는 것은 저장값도 사라졌다는 뜻이다 — 되살아나면 여기서 잡힌다.
    expect(await page.evaluate(() => localStorage.getItem('cc_motion'))).toBeNull();
    await page.getByRole('button', { name: '설정', exact: true }).click();
    expect(await page.getByRole('radiogroup', { name: '화면 움직임' }).count(),
      '은퇴한 `화면 움직임` preference가 설정에 되살아났다').toBe(0);
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

// ══════════════════════════════════════════════════════════════════════════════
// INT-000030 v2.25.0 통합 검수 (2026-08-04) — Kairen-Ref: TSK-000220
// ══════════════════════════════════════════════════════════════════════════════

interface EntryProbe {
  title: string;
  cardTop: number;
  cardHeight: number;
  cardWidth: number;
  titleTop: number | null;
  outcomeTop: number | null;
  actionTop: number | null;
  outcomeText: string;
  /** 설명 상자가 실제로 차지한 높이 */
  boxHeight: number;
  /** 클램프 안에서 글자가 실제로 쓰는 줄 수 */
  shownLines: number;
  /** 클램프를 풀었을 때 필요한 줄 수 */
  neededLines: number;
  clampLines: number;
  lineHeight: number;
}

/** 진입 카드의 해부를 값으로 읽는다.
 *
 *  잘림은 **클램프를 푼 복제본의 높이**로 판정한다. `scrollWidth - clientWidth`는
 *  `-webkit-box` 클램프에서 0이 나와 거짓 통과를 낸다 — 이 저장소가 이미 한 번 당한 방식이다. */
function readEntryProbes(): EntryProbe[] {
  return [...document.querySelectorAll<HTMLElement>('.cc-entry-card')].map((card) => {
    const rect = card.getBoundingClientRect();
    const pick = (selector: string) => card.querySelector<HTMLElement>(selector);
    const topOf = (node: HTMLElement | null) => (node ? Math.round(node.getBoundingClientRect().top * 100) / 100 : null);
    const outcome = pick('.cc-entry-outcome');
    const action = pick('.cc-entry-action') ?? pick('.cc-entry-recovery');

    let boxHeight = 0; let shownLines = 0; let neededLines = 0; let clampLines = 0; let lineHeight = 0; let outcomeText = '';
    if (outcome) {
      const style = getComputedStyle(outcome);
      const box = outcome.getBoundingClientRect();
      boxHeight = Math.round(box.height * 100) / 100;
      outcomeText = (outcome.textContent ?? '').trim();
      lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
      const rawClamp = style.getPropertyValue('-webkit-line-clamp').trim();
      clampLines = rawClamp && rawClamp !== 'none' ? parseInt(rawClamp, 10) : Number.POSITIVE_INFINITY;

      const clone = outcome.cloneNode(true) as HTMLElement;
      clone.style.cssText = '';
      clone.style.position = 'absolute';
      clone.style.visibility = 'hidden';
      clone.style.left = '-9999px';
      clone.style.top = '0';
      clone.style.width = box.width + 'px';
      clone.style.display = 'block';
      clone.style.webkitLineClamp = 'unset';
      clone.style.overflow = 'visible';
      clone.style.font = style.font;
      clone.style.fontFamily = style.fontFamily;
      clone.style.fontSize = style.fontSize;
      clone.style.fontWeight = style.fontWeight;
      clone.style.lineHeight = style.lineHeight;
      clone.style.letterSpacing = style.letterSpacing;
      clone.style.wordBreak = style.wordBreak;
      clone.style.overflowWrap = style.overflowWrap;
      document.body.appendChild(clone);
      const fullHeight = clone.getBoundingClientRect().height;
      clone.remove();

      neededLines = Math.round(fullHeight / lineHeight);
      shownLines = Math.min(neededLines, clampLines);
    }

    return {
      title: pick('.cc-entry-title')?.textContent ?? '',
      cardTop: Math.round(rect.top * 100) / 100,
      cardHeight: Math.round(rect.height * 100) / 100,
      cardWidth: Math.round(rect.width * 100) / 100,
      titleTop: topOf(pick('.cc-entry-title')),
      outcomeTop: topOf(outcome),
      actionTop: topOf(action),
      outcomeText,
      boxHeight,
      shownLines,
      neededLines,
      clampLines,
      lineHeight: Math.round(lineHeight * 100) / 100,
    };
  });
}

// ── 009: 나란한 카드는 같은 선에서 시작한다 ──
//
// founder: "하나는 설명이 있고 하나는 없고 그래서 시각적으로 뭔가 통일감이 떨어져."
// 통일감의 실체는 **줄의 시작선**이다. 같은 해부라면 세 줄 모두 같은 y에서 시작해야 한다.
//
// 이 게이트는 처음에 폭 두 가지만 돌았고, 기기의 카메라 사실은 **실행한 기계**가 정했다.
// 그래서 웹캠 있는 개발 PC에서는 늘 통과하고 웹캠 없는 CI runner에서만 20~25px 어긋났다 —
// 없는 기기에서는 카드에 `이유` 줄이 하나 더 붙고 마지막 조각이 34px짜리 회복 버튼이 되기
// 때문이다. 단언은 그대로 두고 **기기 세계를 선언해** 두 세계를 모두 전수로 돈다.
// 정렬은 글자가 몇 줄로 접혔는지·조각이 몇 개인지와 무관해야 하고, 그 보장은
// `int30-capture.css`의 subgrid(카드가 바깥 grid의 줄을 그대로 쓴다)가 만든다.
for (const width of [390, 1280] as const) {
  for (const camera of ['present', 'absent'] as const) {
    test(`entry cards in the same row start their title, outcome and action on the same line at ${width}px (camera ${camera})`, async ({ page }) => {
      const harness = await boot(page, 'light', { width, height: 900, camera });
      try {
        /* 두 세계를 정말 갈라 돌았는지 **먼저** 확인한다. 선언이 안 먹으면 `absent` 회차가
           조용히 `present`를 한 번 더 도는 것이 되고, 그러면 이 게이트는 통과하면서 아무것도
           재지 않는다. 기기 조회는 비동기라(`probeDeviceEnvironment`) 여기서 기다린다 —
           확정되기 전에 재면 그 값은 화면의 최종 상태가 아니다. */
        await expect(
          page.locator('.cc-entry-card.is-unavailable'),
          camera === 'absent'
            ? '카메라 없음을 선언했는데 못 쓰는 카드가 하나도 없다 — 기기 선언이 먹지 않았다'
            : '카메라 있음을 선언했는데 못 쓰는 카드가 있다',
        ).toHaveCount(camera === 'absent' ? 1 : 0);

        const probes = await page.evaluate(readEntryProbes);
        expect(probes.length, '진입 카드를 하나도 찾지 못했다 — 재지 못한 곳은 통과한 곳이 아니다').toBeGreaterThanOrEqual(3);

        const rows = new Map<number, EntryProbe[]>();
        for (const probe of probes) {
          const key = Math.round(probe.cardTop);
          rows.set(key, [...(rows.get(key) ?? []), probe]);
        }
        let compared = 0;
        for (const [, row] of rows) {
          if (row.length < 2) continue;
          compared += 1;
          for (const axis of ['titleTop', 'outcomeTop', 'actionTop'] as const) {
            const values = row.map((probe) => probe[axis] ?? Number.NaN);
            const spread = Math.max(...values) - Math.min(...values);
            expect(
              spread,
              `같은 줄의 카드들이 ${axis}에서 어긋난다 (${spread}px): ${JSON.stringify(row.map((probe) => ({ [probe.title]: probe[axis] })))}`,
            ).toBeLessThanOrEqual(0.5);
          }
        }
        expect(compared, '나란히 선 카드 쌍을 한 번도 비교하지 못했다').toBeGreaterThan(0);
      } finally {
        harness.server.close();
      }
    });
  }
}

// ── 010: 늘어난 죽은 공백이 없다 ──
//
// 설명 상자가 남은 자리를 채우려고 늘어나면 그 안에서 글자가 세로 가운데로 밀리고(009의 원인),
// 두 칸을 가로지르는 카드는 위 행과 같은 높이가 되면서 설명과 행동 사이가 통째로 비었다.
// 넓은 카드는 **넓이를 쓰는 것**으로 갚아야지 세로로 부풀어 갚으면 안 된다.
for (const width of [390, 1280] as const) {
  test(`no entry card inflates itself with dead space at ${width}px`, async ({ page }) => {
    const harness = await boot(page, 'light', { width, height: 900 });
    try {
      const probes = await page.evaluate(readEntryProbes);
      for (const probe of probes) {
        const dead = Math.round((probe.boxHeight - probe.shownLines * probe.lineHeight) * 100) / 100;
        expect(
          dead,
          `\`${probe.title}\` 설명 상자가 글자보다 ${dead}px 크다 (상자 ${probe.boxHeight}px / 글자 ${probe.shownLines}줄 × ${probe.lineHeight}px)`,
        ).toBeLessThanOrEqual(1);
      }

      // 두 칸을 가로지르는 카드는 첫 줄 카드보다 낮아야 한다. 같은 높이라면 늘어난 것이다.
      const widest = Math.max(...probes.map((probe) => probe.cardWidth));
      const narrow = probes.filter((probe) => probe.cardWidth < widest * 0.75);
      const wide = probes.find((probe) => probe.cardWidth >= widest * 0.99);
      expect(narrow.length, '두 칸을 가로지르는 카드와 견줄 좁은 카드가 없다').toBeGreaterThan(0);
      expect(wide, '두 칸을 가로지르는 카드를 찾지 못했다').toBeTruthy();
      const rowHeight = Math.max(...narrow.map((probe) => probe.cardHeight));
      expect(
        wide!.cardHeight,
        `\`${wide!.title}\` 카드가 위 행과 같은 높이로 늘어났다 (넓은 카드 ${wide!.cardHeight}px / 위 행 ${rowHeight}px)`,
      ).toBeLessThan(rowHeight);
    } finally {
      harness.server.close();
    }
  });
}

// ── 012: 어떤 폭·연결 상태에서도 설명이 잘리지 않는다 ──
//
// 실폰에서는 짧은 모바일 문구가 나가 안 보이지만, **폭을 좁힌 데스크톱 창**에서는 데스크톱
// 문구가 그대로 들어와 3줄에서 `…`로 끊겼다. 폭과 연결 상태를 곱해 전수로 판정한다.
for (const connected of [true, false] as const) {
  test(`entry card outcomes never ellipsize at any supported width (${connected ? 'connected' : 'first visit'})`, async ({ page }) => {
    const harness = await boot(page, 'light', { width: 1280, height: 900, connected });
    try {
      const failures: string[] = [];
      for (const width of [320, 360, 390, 420, 768, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await page.waitForTimeout(150);
        const probes = await page.evaluate(readEntryProbes);
        expect(probes.length, `${width}px에서 진입 카드를 찾지 못했다`).toBeGreaterThanOrEqual(3);
        for (const probe of probes) {
          if (probe.neededLines > probe.clampLines) {
            failures.push(`${width}px · ${probe.title}: ${probe.neededLines}줄 필요 / ${probe.clampLines}줄만 보임 — "${probe.outcomeText}"`);
          }
        }
      }
      expect(failures, `진입 카드 설명이 잘린다:\n${failures.join('\n')}`).toEqual([]);
    } finally {
      harness.server.close();
    }
  });
}

// ── 011: `예시` 이름표 밑으로 chip이 파고들지 않는다 ──
//
// 첫 줄은 이름표 오른쪽에서 시작하는데 둘째 줄은 맨 왼쪽에서 시작해 이름표 밑으로 들어갔다.
// 이름표는 chip 줄 **바깥**의 열이어야 한다.
test('example chips never wrap underneath their label', async ({ page }) => {
  const harness = await boot(page, 'light', { width: 390, height: 900 });
  try {
    const rows = await page.evaluate(() => {
      return [...document.querySelectorAll<HTMLElement>('.context-chips')].map((row) => {
        const label = row.querySelector<HTMLElement>('.context-chips-label');
        if (!label) return null;
        const labelRect = label.getBoundingClientRect();
        const buttons = [...row.querySelectorAll<HTMLElement>('button')].map((button) => {
          const rect = button.getBoundingClientRect();
          return { text: button.textContent ?? '', left: Math.round(rect.left * 100) / 100, top: Math.round(rect.top * 100) / 100 };
        });
        if (!buttons.length) return null;
        const firstRowTop = Math.min(...buttons.map((button) => button.top));
        const wrapped = buttons.filter((button) => button.top > firstRowTop + 2);
        return {
          aria: row.getAttribute('aria-label') ?? '',
          wrappedCount: wrapped.length,
          tucked: wrapped
            .filter((button) => button.left < labelRect.right - 0.5)
            .map((button) => `${button.text}(left=${button.left} < 이름표 right=${Math.round(labelRect.right * 100) / 100})`),
        };
      }).filter((row): row is NonNullable<typeof row> => row !== null);
    });

    expect(rows.length, '예시 chip 줄을 하나도 찾지 못했다').toBeGreaterThanOrEqual(3);
    // 줄바꿈이 한 번도 일어나지 않았다면 이 게이트는 아무것도 재지 않은 것이다.
    expect(rows.some((row) => row.wrappedCount > 0), '390px에서 chip이 한 줄도 넘어가지 않았다 — 재지 못한 곳은 통과한 곳이 아니다').toBe(true);
    const tucked = rows.flatMap((row) => row.tucked.map((entry) => `${row.aria}: ${entry}`));
    expect(tucked, `둘째 줄 chip이 \`예시\` 이름표 밑으로 파고든다:\n${tucked.join('\n')}`).toEqual([]);
  } finally {
    harness.server.close();
  }
});

// ── 013: 3칸 선택 위젯은 한 벌의 해부를 쓴다 ──
//
// `조사 깊이`(새 표면)와 `화면 테마`(기존 표면)가 같은 종류의 선택을 서로 다른 모양으로 했다.
// 정본은 왼쪽 정렬이다: 이 앱의 나머지 전부가 왼쪽에서 시작하고, 가운데 정렬은 한국어 라벨이
// 줄바꿈되는 순간 둘째 줄이 어긋나 보인다. 눈금(ordinal)은 깊이만 갖는 선언된 예외다.
test('both three-up choice widgets share one anatomy', async ({ page }) => {
  const harness = await boot(page, 'light', { width: 390, height: 900 });
  try {
    const readWidget = (optionSelector: string, gridSelector: string) => page.evaluate(([option, grid]) => {
      const node = document.querySelector<HTMLElement>(option);
      const parent = document.querySelector<HTMLElement>(grid);
      if (!node || !parent) return null;
      const style = getComputedStyle(node);
      const parentStyle = getComputedStyle(parent);
      const normalize = (value: string) => (value === 'left' ? 'start' : value === 'normal' ? 'stretch' : value);
      return {
        textAlign: normalize(style.textAlign),
        justifyItems: normalize(style.justifyItems),
        alignContent: style.alignContent,
        borderRadius: style.borderTopLeftRadius,
        columns: parentStyle.gridTemplateColumns.split(' ').length,
        options: parent.querySelectorAll(':scope > *').length,
      };
    }, [optionSelector, gridSelector]);

    const depth = await readWidget('.research-depth-option', '.research-depth-grid');
    await page.getByRole('button', { name: '설정', exact: true }).click();
    await page.waitForTimeout(250);
    const theme = await readWidget('.int29-theme button', '.int29-theme');

    expect(depth, '`조사 깊이` 위젯을 찾지 못했다').toBeTruthy();
    expect(theme, '`화면 테마` 위젯을 찾지 못했다').toBeTruthy();
    expect(theme!.textAlign, `두 위젯의 글자 정렬이 다르다 (깊이 ${depth!.textAlign} / 테마 ${theme!.textAlign})`).toBe(depth!.textAlign);
    expect(theme!.justifyItems, `두 위젯의 칸 안 정렬이 다르다 (깊이 ${depth!.justifyItems} / 테마 ${theme!.justifyItems})`).toBe(depth!.justifyItems);
    expect(theme!.alignContent, `두 위젯의 세로 정렬이 다르다 (깊이 ${depth!.alignContent} / 테마 ${theme!.alignContent})`).toBe(depth!.alignContent);
    expect(theme!.borderRadius, `두 위젯의 모서리가 다르다 (깊이 ${depth!.borderRadius} / 테마 ${theme!.borderRadius})`).toBe(depth!.borderRadius);
    expect(theme!.columns, '두 위젯의 칸 수가 다르다').toBe(depth!.columns);
    expect(depth!.options, '`조사 깊이`가 3칸이 아니다').toBe(3);
    expect(theme!.options, '`화면 테마`가 3칸이 아니다').toBe(3);
  } finally {
    harness.server.close();
  }
});

// ── 014: 그룹 이름표와 첫 항목이 구별된다 ──
//
// `알림이 오는 경우`와 그 아래 `최종 결과`가 같은 색·거의 같은 크기·거의 같은 굵기로 붙어 있어
// 무엇이 제목인지 읽히지 않았다. lane D가 세운 "위계로 세련됨을 만든다"의 정면 반례다.
test('a settings group label reads as a label, not as its first item', async ({ page }) => {
  const harness = await boot(page, 'light', { width: 390, height: 900 });
  try {
    await page.getByRole('button', { name: '설정', exact: true }).click();
    await page.waitForTimeout(250);
    // 진단·제보는 접혀 있고 접힌 글은 rect가 0이다 — **재지 못한 곳은 통과한 곳이 아니므로** 연다.
    await page.getByRole('button', { name: /문제가 생겼을 때/ }).click();
    await page.waitForTimeout(250);
    const pairs = await page.evaluate(() => {
      return [...document.querySelectorAll<HTMLElement>('.int29-scope-label')].map((label) => {
        const list = label.parentElement?.querySelector<HTMLElement>('.int29-scope, .int30-facts');
        const first = list?.querySelector<HTMLElement>('strong, dt') ?? null;
        if (!first) return null;
        const labelStyle = getComputedStyle(label);
        const itemStyle = getComputedStyle(first);
        return {
          text: label.textContent ?? '',
          labelSize: parseFloat(labelStyle.fontSize),
          labelWeight: parseInt(labelStyle.fontWeight, 10),
          labelColor: labelStyle.color,
          itemSize: parseFloat(itemStyle.fontSize),
          itemWeight: parseInt(itemStyle.fontWeight, 10),
          itemColor: itemStyle.color,
          gap: Math.round((first.getBoundingClientRect().top - label.getBoundingClientRect().bottom) * 100) / 100,
        };
      }).filter((pair): pair is NonNullable<typeof pair> => pair !== null);
    });

    expect(pairs.length, '그룹 이름표와 항목 쌍을 하나도 찾지 못했다').toBeGreaterThan(0);
    for (const pair of pairs) {
      // 색이 같고 크기 차이가 1px 이하이며 굵기 차이가 60 이하면, 사람 눈에는 같은 것 둘이다.
      const distinct = pair.labelColor !== pair.itemColor
        || Math.abs(pair.labelSize - pair.itemSize) > 1
        || Math.abs(pair.labelWeight - pair.itemWeight) > 60;
      expect(distinct, `\`${pair.text}\`가 첫 항목과 구별되지 않는다: ${JSON.stringify(pair)}`).toBe(true);
      expect(pair.gap, `\`${pair.text}\`와 첫 항목이 붙어 있다 (${pair.gap}px)`).toBeGreaterThanOrEqual(6);
    }
  } finally {
    harness.server.close();
  }
});

// ── 015: 두 갱신 표면이 같은 말을 하고, 작업 사실은 한 곳만 소유한다 ──
//
// 미연결 PC에서 위는 `연결되면 확인`인데 아래는 `자동 갱신 켜짐`이라 서로 모순되게 읽혔다.
// 아래 줄의 뜻(DEC-000092 §2: 켜짐/꺼짐 · 지금 걸려 있는 박자 · 마지막 성공)은 그대로 두고,
// 박자 조각이 위 줄과 **같은 함수에서 파생**되게 만든다.
//
// TSK-000559에서 한 겹 더 잠근다. 아래 줄은 `refreshStatus.text`를 그대로 베껴 쓰고 있었고,
// 그래서 자동 폴링 동안 위는 `갱신 중`, 아래는 `자동 갱신 켜짐 · 20초마다`로 갈렸다. 이제
// 주변 사실(켜짐·박자·마지막 성공)만 두 줄이 함께 말하고, 진행·성공·실패는 누른 버튼 옆
// 한 줄이 혼자 소유한다 — 겹쳐 말할 곳이 없으면 어긋날 방법도 없다.
for (const connected of [true, false] as const) {
  test(`the two refresh surfaces state the same fact (${connected ? 'connected' : 'first visit'})`, async ({ page }) => {
    const harness = await boot(page, 'light', { width: 1280, height: 900, connected });
    try {
      await page.waitForTimeout(500);
      const said = await page.evaluate(() => ({
        top: (document.querySelector('.int30-refresh-line')?.textContent ?? '').trim(),
        reason: document.querySelector('.int30-refresh-line')?.getAttribute('data-reason') ?? '',
        bottom: (document.querySelector('.refresh-hint')?.textContent ?? '').trim(),
      }));
      expect(said.top, '상단 갱신 줄이 비어 있다').not.toBe('');
      expect(said.bottom, '`명함 기록` 옆 갱신 줄이 비어 있다').not.toBe('');
      // 위 줄의 마지막 조각이 지금 걸린 박자(또는 왜 박자가 없는지)다. 아래 줄에도 그대로 있어야 한다.
      const beat = said.top.split(' · ').pop() ?? '';
      expect(
        said.bottom.includes(beat),
        `두 표면이 같은 사실을 다르게 말한다 — 위 "${said.top}" (reason=${said.reason}) / 아래 "${said.bottom}"`,
      ).toBe(true);

      // 작업 사실의 주인은 하나다. 아래 줄은 진행·성공·실패를 절대 베껴 쓰지 않는다.
      expect(said.bottom, `아래 줄이 작업 상태까지 겹쳐 말한다: "${said.bottom}"`)
        .not.toMatch(/갱신 중|방금 업데이트|갱신 실패/);
      // 낭독 지점도 하나다 — 1초마다 `N초 전`이 바뀌는 문구에 live region을 달면
      // 낭독기가 매초 끼어들어 다른 것을 아무것도 읽을 수 없다.
      const hintLive = await page.evaluate(() => {
        const hint = document.querySelector('.refresh-hint');
        return { role: hint?.getAttribute('role') ?? '', live: hint?.getAttribute('aria-live') ?? '' };
      });
      expect(hintLive.role, '`명함 기록` 옆 줄이 live region이라 매초 낭독기를 가로챈다').toBe('');
      expect(hintLive.live, '`명함 기록` 옆 줄이 aria-live를 들고 있다').toBe('');
    } finally {
      harness.server.close();
    }
  });
}

// ── 016: 경고 색조가 테마 토큰을 따른다 ──
//
// 다크 경고 색조가 `rgba(224,183,109,…)`로 손으로 베껴져 있었고 실제 `--cc-warn`은
// `#e2b76d` = `(226,183,109)`였다. 손으로 베낀 값은 팔레트가 바뀌는 순간 조용히 어긋난다.
for (const theme of ['light', 'dark'] as const) {
  test(`warning tints derive from the theme token in ${theme} mode`, async ({ page }) => {
    const harness = await boot(page, theme, { width: 390, height: 900 });
    try {
      const measured = await page.evaluate(() => {
        // 이 상태(만료·실패 토큰)는 boot으로 만들기 어렵다. 실제 클래스를 그대로 입힌 요소를
        // 문서에 넣어 **스타일시트가 그리는 값**을 잰다 — 기대값은 앱 공식이 아니라 토큰이다.
        const card = document.createElement('section');
        card.className = 'cc-setup-card';
        card.setAttribute('data-tone', 'warn');
        card.innerHTML = '<span class="cc-setup-icon"></span><div class="cc-setup-copy"><strong>x</strong></div>';
        const rejects = document.createElement('ul');
        rejects.className = 'cc-intake-rejects';
        rejects.innerHTML = '<li>x</li>';
        document.body.append(card, rejects);
        const read = (node: Element) => {
          const style = getComputedStyle(node);
          return { background: style.backgroundColor, border: style.borderTopColor };
        };
        const out = {
          token: getComputedStyle(document.documentElement).getPropertyValue('--cc-warn').trim(),
          card: read(card),
          icon: getComputedStyle(card.querySelector('.cc-setup-icon')!).backgroundColor,
          rejects: read(rejects),
        };
        card.remove();
        rejects.remove();
        return out;
      });

      const hex = measured.token.replace('#', '');
      const expected = [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
      /* `color-mix`의 계산값은 `color(srgb 0.54 0.41 0.15 / 0.07)`처럼 0~1 실수로 나온다.
         `rgba(138, 106, 39, 0.07)`와 같은 색인데 표기만 다르다 — 표기를 0~255로 맞춘 뒤 견준다. */
      const channelsOf = (value: string) => {
        const isSrgb = value.startsWith('color(');
        return (value.match(/\d+(\.\d+)?/g) ?? [])
          .slice(0, 3)
          .map((channel) => (isSrgb ? Math.round(Number(channel) * 255) : Number(channel)));
      };
      const surfaces: [string, string][] = [
        ['연결 안내 카드 배경', measured.card.background],
        ['연결 안내 카드 테두리', measured.card.border],
        ['연결 안내 아이콘', measured.icon],
        ['거절 목록 배경', measured.rejects.background],
        ['거절 목록 테두리', measured.rejects.border],
      ];
      for (const [where, value] of surfaces) {
        const channels = channelsOf(value);
        expect(channels.length, `${where}의 색을 읽지 못했다 (${value})`).toBe(3);
        for (let index = 0; index < 3; index += 1) {
          expect(
            Math.abs(channels[index] - expected[index]),
            `${where}가 \`--cc-warn\`(${measured.token} = ${expected.join(',')})을 따르지 않는다: ${value}`,
          ).toBeLessThanOrEqual(1);
        }
      }
    } finally {
      harness.server.close();
    }
  });
}
