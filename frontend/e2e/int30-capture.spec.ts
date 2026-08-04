// 캡처 진입 카드와 만남 맥락의 시각 통일 — Kairen-Ref: TSK-000220 / INT-000030 / DEC-000105
//
// founder 판정 둘을 이 게이트가 지킨다.
//   (1) "캡처 페이지에 명함 촬영, 직접 입력, 구도는 좋아. 근데 하나는 설명이 있고 하나는 없고
//        그래서 시각적으로 뭔가 통일감이 떨어져."
//   (2) "만남 맥락 글 작성하는 박스 포함해서 테두리 뭔가 좀 구려. 다른 곳의 작성하는 박스
//        테두리와 통일성도 없고, 이거 작성해야 엄청 좋은건데 왠지 작성해야 할 것 같은
//        느낌(설명보다 직관적으로)이 들면 좋겠어."
//
// 고정하는 계약:
//   1. 진입 카드는 예외 없이 같은 해부(제목 · 한 줄 outcome · 행동)를 갖는다.
//   2. 초안이 있어도 설명 줄은 사라지지 않는다 — 상태는 다섯 번째 자리다.
//   3. 화면에 있는 **모든** 작성 box가 같은 테두리 굵기·모서리를 쓰고, focus에서 같은 링을 그린다.
//   4. 만남 맥락은 면적·focus·진행으로 초대하되 필수 표식·오류색으로 강제하지 않는다.
//   5. 안면 촬영·얼굴 식별은 영구 non-goal이라 어떤 표현도 화면에 없다.
//   6. compact phone(390×844)·desktop(1280×800)·긴 내용에서 가로로 새지 않고 해부가 유지된다.
//
// 판정 기준은 렌더된 픽셀이다. 앱 내부 상태나 컴포넌트 이름을 다시 계산하지 않는다 —
// 카드의 해부는 class 이름이 아니라 **글자를 가진 줄들의 배치**로 잰다. 그래야 구현을 바꿔도
// 계약만 남는다.
import { expect, test, type Page } from '@playwright/test';
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

interface Harness { server: Server; origin: string }

/** `AI 조사 요청` 작성 자리까지 화면에 있어야 "모든 작성 box"를 잴 수 있다. */
function listFixture() {
  return { ok: true, seeAll: true, researchInstructionEnabled: true, hasMore: false, items: [] };
}

async function boot(page: Page, size = { width: 390, height: 844 }): Promise<Harness> {
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');
  const origin = `http://127.0.0.1:${address.port}/`;

  // 카메라·OCR 자산은 이 게이트와 무관하다. 받으면 느려지기만 한다.
  await page.context().route('**/vendor/**', (route) => route.abort());
  await page.route('https://api.example.test/**', async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, captureId: 'server-side' }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(listFixture()) });
  });
  await page.addInitScript(() => localStorage.setItem('cc_name', 'E2E Owner'));
  /* 이 게이트가 재는 것은 **해부**이지 가용성이 아니다. 그런데 카드가 쓸 수 있는지는 이제
     기기가 정하므로(`device-capability.ts`), 웹캠 없는 기계에서 돌리면 카메라 카드가 이유·회복
     줄을 달고 나와 줄 수가 달라진다 — 게이트가 코드가 아니라 **실행한 기계**에 따라 붙었다
     떨어졌다 하게 된다. 그래서 여기서는 기기 축을 못 박는다. 못 쓰는 카드의 해부는
     `int30-integration.spec.ts`가 따로 잰다. */
  await page.addInitScript(() => {
    const media = navigator.mediaDevices;
    if (!media) return;
    media.enumerateDevices = async () => [{ kind: 'videoinput', deviceId: '', label: '', groupId: '', toJSON: () => ({}) } as MediaDeviceInfo];
  });
  await page.setViewportSize(size);
  const api = encodeURIComponent('https://api.example.test/exec');
  await page.goto(`${origin}next/?api=${api}&k=owner-token`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('button', { name: '명함 앞면 촬영' })).toBeVisible();
  return { server, origin };
}

interface CardRow { text: string; fontSize: number; fontWeight: number; top: number; bottom: number; left: number }
interface CardShape {
  label: string;
  rect: { top: number; left: number; width: number; height: number };
  rows: CardRow[];
  hasIcon: boolean;
  tag: string;
}

/**
 * 진입 카드를 **글자를 가진 줄들**로 읽는다.
 *
 * class 이름으로 재면 구현을 바꿀 때마다 게이트를 같이 고쳐야 하고, 그러면 계약이 아니라
 * 현재 구현을 박제하게 된다. 여기서는 "카드 안에 글자가 있는 줄이 몇 개이고 어디에 있는가"만 본다.
 */
async function cardShapes(page: Page): Promise<CardShape[]> {
  return page.evaluate(() => {
    const container = document.querySelector('.primary-entries');
    if (!container) return [];
    return Array.from(container.children).map((node) => {
      const card = node as HTMLElement;
      const rect = card.getBoundingClientRect();
      const rows = Array.from(card.querySelectorAll<HTMLElement>('*'))
        .filter((child) => Array.from(child.childNodes).some((leaf) => leaf.nodeType === 3 && (leaf.textContent ?? '').trim()))
        .map((child) => {
          const style = getComputedStyle(child);
          const box = child.getBoundingClientRect();
          return {
            text: (child.textContent ?? '').trim(),
            fontSize: Math.round(parseFloat(style.fontSize) * 10) / 10,
            fontWeight: parseInt(style.fontWeight, 10),
            top: Math.round(box.top - rect.top),
            bottom: Math.round(rect.bottom - box.bottom),
            left: Math.round(box.left - rect.left),
          };
        })
        .sort((a, b) => a.top - b.top || a.left - b.left);
      return {
        label: (card.textContent ?? '').trim().slice(0, 12),
        rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
        rows,
        hasIcon: Boolean(card.querySelector('svg')),
        tag: card.tagName.toLowerCase(),
      };
    });
  });
}

interface FieldShape {
  where: string;
  borderWidth: number;
  borderColor: string;
  radius: number;
  height: number;
  shadow: string;
}

/**
 * 지금 화면에 실제로 그려진 모든 작성 box. 숨어 있는 modal 안의 칸은 크기가 0이라 빠진다.
 *
 * **굵기로만 재지 말 것.** Chrome은 `border-width: 1.5px`의 computed 값을 `1px`로 돌려준다
 * (DPR 1에서 device pixel로 반올림). 그래서 굵기만 보는 검사는 1px과 1.5px을 구별하지 못하고
 * 조용히 통과한다 — 이 게이트의 첫 판이 실제로 그렇게 통과했다(수정 전 빌드에서). 자리마다
 * 진짜로 달랐던 축은 **테두리 색**과 **평상시 그림자**였다:
 *   만남 맥락 rgba(42,63,89,0.26) · AI 조사 요청 rgba(35,104,216,0.16) · 직접 입력 rgba(42,63,89,0.12)
 */
async function authoringBoxes(page: Page): Promise<FieldShape[]> {
  return page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('ion-input, ion-textarea'))
    .filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 2 && rect.height > 2;
    })
    .map((node) => {
      const style = getComputedStyle(node);
      return {
        where: `${node.tagName.toLowerCase()}[${node.getAttribute('aria-label') ?? node.getAttribute('label') ?? node.className}]`,
        borderWidth: Math.round(parseFloat(style.borderTopWidth) * 100) / 100,
        borderColor: style.borderTopColor.replace(/\s/g, ''),
        radius: Math.round(parseFloat(style.borderTopLeftRadius) * 100) / 100,
        height: Math.round(node.getBoundingClientRect().height),
        shadow: style.boxShadow,
      };
    }));
}

/**
 * transition이 **끝난 뒤의** 값을 읽는다.
 *
 * 테두리 색과 그림자에 140ms transition이 걸려 있어서, class가 바뀐 직후 한 번만 읽으면
 * 중간 프레임(예: 3px 링이 아직 0.38px)을 재게 된다. 그러면 게이트가 기계 속도에 따라
 * 붙었다 떨어졌다 한다 — 실제로 단독 실행은 통과하고 전체 실행은 실패했다.
 * `getAnimations()`는 CSS transition도 포함하므로 기다릴 대상이 실제로 있는지까지 확인된다.
 */
async function settled(locator: ReturnType<Page['locator']>, property: 'boxShadow' | 'borderTopColor'): Promise<string> {
  return locator.evaluate(async (node, key) => {
    await Promise.all(node.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
    return getComputedStyle(node)[key as 'boxShadow'];
  }, property);
}

test('진입 카드가 모두 같은 해부를 쓴다 — 설명 있는 카드/없는 카드가 없다', async ({ page }) => {
  const harness = await boot(page);
  try {
    const cards = await cardShapes(page);
    /* 셋이다: 촬영 · 직접 입력 · 파일 올리기. 생산자를 연결하기 전에는 둘이었다 —
       임시 배열이 두 입구만 들고 있었기 때문이고, 그때는 파일 올리기가 화면에 없었다. */
    expect(cards.length, '진입 카드가 셋이 아니다').toBe(3);

    for (const card of cards) {
      expect(card.hasIcon, `${card.label}: 아이콘이 없다`).toBe(true);
      // 제목 · 한 줄 outcome · 행동. 셋 중 하나라도 빠진 카드가 있으면 조립식으로 읽힌다.
      expect(card.rows.length, `${card.label}: 글자 줄이 3개가 아니다 — ${JSON.stringify(card.rows.map((row) => row.text))}`).toBe(3);
      for (const row of card.rows) {
        expect(row.text, `${card.label}: 빈 줄이 있다`).not.toBe('');
        // Ionic 전역 `small { font-size: 75% }`와 미리셋이 조용히 글자를 줄인다.
        expect(row.fontSize, `${card.label}: "${row.text}"가 너무 작다 (${row.fontSize}px)`).toBeGreaterThan(10);
      }
    }

    const [first, second, third] = cards;
    // 같은 부모의 형제이고, 같은 줄에서 같은 크기다 (DEC-000103: 촬영·직접 입력의 동등 위계).
    expect(Math.abs(first.rect.top - second.rect.top), '같은 줄에 있지 않다').toBeLessThanOrEqual(2);
    expect(Math.abs(first.rect.height - second.rect.height), '높이가 다르다').toBeLessThanOrEqual(2);
    expect(Math.abs(first.rect.width - second.rect.width), '폭이 다르다').toBeLessThanOrEqual(2);
    /* 셋째 카드(파일 올리기)는 둘째 줄에서 **두 칸을 가로지른다**. 반만 그려진 카드는 잘린 것으로
       보이고, 무엇보다 이 카드가 첫 줄에 끼면 직접 입력이 둘째 줄로 밀려 위 계약이 깨진다. */
    expect(third.rect.top, '셋째 카드가 첫 줄에 끼어 있다').toBeGreaterThan(first.rect.top + first.rect.height - 2);
    expect(third.rect.width, '셋째 카드가 두 칸을 가로지르지 않는다').toBeGreaterThan(first.rect.width * 1.6);

    // 줄마다 같은 글자 크기·굵기를 쓴다 — 위계가 카드마다 달라지면 그것이 곧 통일감의 붕괴다.
    for (let index = 0; index < first.rows.length; index += 1) {
      expect(second.rows[index].fontSize, `${index}번째 줄의 글자 크기가 다르다`).toBe(first.rows[index].fontSize);
      expect(second.rows[index].fontWeight, `${index}번째 줄의 글자 굵기가 다르다`).toBe(first.rows[index].fontWeight);
      expect(second.rows[index].fontSize, `${index}번째 줄이 12.5px 이하로 줄었다`).toBeGreaterThan(10);
    }
    // 제목은 같은 높이에서 시작하고, 행동은 같은 높이에서 끝난다(가운데 줄 길이는 달라도 된다).
    expect(Math.abs(first.rows[0].top - second.rows[0].top), '제목 줄의 시작 높이가 다르다').toBeLessThanOrEqual(2);
    expect(Math.abs(first.rows[2].bottom - second.rows[2].bottom), '행동 줄이 바닥에 같이 붙어 있지 않다').toBeLessThanOrEqual(2);
    expect(Math.abs(first.rows[0].left - second.rows[0].left), '안쪽 여백이 다르다').toBeLessThanOrEqual(1);
  } finally {
    await stopServer(harness.server);
  }
});

test('쓰다 만 초안이 있어도 설명 줄이 사라지지 않는다', async ({ page }) => {
  const harness = await boot(page);
  try {
    // 초안을 남기고 시트를 닫는다.
    await page.getByRole('button', { name: '직접 입력' }).click();
    const field = page.getByRole('textbox', { name: '이 사람에 대해 아는 내용' });
    await expect(field).toBeVisible();
    await page.waitForTimeout(400);
    await field.fill('판교에서 만난 배터리 소재 회사 연구소장님');
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: /^(닫기|취소)$/ }).first().click();
    await expect(page.locator('ion-modal.manual-sheet')).toBeHidden();

    const cards = await cardShapes(page);
    const manual = cards.find((card) => card.label.includes('직접 입력'));
    expect(manual, '직접 입력 카드가 없다').toBeTruthy();
    const texts = manual!.rows.map((row) => row.text);
    // 예전에는 상태 뱃지가 설명 자리를 **차지했다**. 이제 둘 다 남는다.
    expect(texts.some((text) => text.includes('이어서')), `진행 상태가 없다: ${JSON.stringify(texts)}`).toBe(true);
    expect(texts.some((text) => text.includes('명함이 없어도')), `설명 줄이 사라졌다: ${JSON.stringify(texts)}`).toBe(true);

    // 다른 카드의 해부는 그대로다 — 한쪽에 상태가 생겼다고 두 카드의 높이가 달라지면 안 된다.
    const camera = cards.find((card) => card.label.includes('명함'));
    expect(Math.abs(manual!.rect.height - camera!.rect.height), '상태 뱃지가 카드 높이를 흔들었다').toBeLessThanOrEqual(2);
  } finally {
    await stopServer(harness.server);
  }
});

test('화면의 모든 작성 box가 같은 테두리·모서리를 쓴다', async ({ page }) => {
  const harness = await boot(page);
  try {
    const onScreen = await authoringBoxes(page);
    // 만남 맥락 4칸 + AI 조사 요청 1칸이 최소 구성이다. 아무것도 못 재면 이 게이트는 침묵이다.
    expect(onScreen.length, `잰 작성 box가 너무 적다: ${JSON.stringify(onScreen)}`).toBeGreaterThanOrEqual(5);

    // 직접 입력 시트의 칸까지 같은 자로 잰다 — "다른 곳의 작성하는 박스"가 정확히 이것이다.
    await page.getByRole('button', { name: '직접 입력' }).click();
    await expect(page.getByRole('textbox', { name: '이 사람에 대해 아는 내용' })).toBeVisible();
    await page.waitForTimeout(400);
    const withSheet = await authoringBoxes(page);
    expect(withSheet.length, '시트를 열었는데 잰 칸이 늘지 않았다').toBeGreaterThan(onScreen.length);

    const widths = new Set(withSheet.map((box) => box.borderWidth));
    const colors = new Set(withSheet.map((box) => box.borderColor));
    const radii = new Set(withSheet.map((box) => box.radius));
    const shadows = new Set(withSheet.map((box) => box.shadow));
    expect([...widths], `테두리 굵기가 제각각이다: ${JSON.stringify(withSheet)}`).toHaveLength(1);
    // 색이 자리마다 다르면 굵기가 같아도 "다른 물건"으로 읽힌다. 예전에 셋이 서로 달랐다.
    expect([...colors], `테두리 색이 제각각이다: ${JSON.stringify(withSheet.map((box) => [box.where, box.borderColor]))}`).toHaveLength(1);
    expect([...radii], `모서리가 제각각이다: ${JSON.stringify(withSheet)}`).toHaveLength(1);
    // 평상시 그림자까지 같아야 한다 — 한 곳만 눌려 보이고 나머지는 평평하던 것이 예전 상태다.
    expect([...shadows], `평상시 그림자가 제각각이다: ${JSON.stringify(withSheet.map((box) => [box.where, box.shadow]))}`).toHaveLength(1);
    expect([...widths][0], '테두리가 없는 작성 box가 있다').toBeGreaterThanOrEqual(1);
    // 모서리 계단은 최대 16px이다 (surface-polish 게이트와 같은 기준).
    expect([...radii][0]).toBeGreaterThan(0);
    expect([...radii][0]).toBeLessThanOrEqual(16);
    for (const box of withSheet) expect(box.height, `${box.where}: 누르기에 너무 얕다`).toBeGreaterThanOrEqual(44);
  } finally {
    await stopServer(harness.server);
  }
});

test('작성 box는 어디에 있든 같은 focus 링을 그린다', async ({ page }) => {
  const harness = await boot(page);
  try {
    const targets = ['어디서 만났나요?', 'Kairen과의 관계', '메모', 'AI 조사 요청'];
    const rings: { label: string; idle: string; focused: string }[] = [];
    for (const label of targets) {
      const box = page.getByRole('textbox', { name: label });
      if (await box.count() === 0) continue;
      const host = box.first().locator('xpath=ancestor-or-self::*[self::ion-input or self::ion-textarea][1]');
      const idle = await settled(host, 'boxShadow');
      await box.first().click();
      const focused = await settled(host, 'boxShadow');
      rings.push({ label, idle, focused });
    }
    expect(rings.length, '잰 칸이 없다 — 이름이 바뀌었으면 이 게이트도 같이 고쳐야 한다').toBeGreaterThanOrEqual(3);

    for (const ring of rings) {
      expect(ring.focused, `${ring.label}: focus에서 아무것도 달라지지 않는다`).not.toBe(ring.idle);
      // 안쪽 그림자만 바뀌는 것은 링이 아니다 — 바깥으로 번지는 층이 실제로 하나 더 있어야 한다.
      const outer = ring.focused.split(/,(?![^(]*\))/).filter((layer) => !layer.includes('inset'));
      expect(outer.length, `${ring.label}: 바깥 링이 없다 — ${ring.focused}`).toBeGreaterThanOrEqual(1);
    }
    // 링의 모양이 자리마다 다르면 그것도 통일감이 아니다.
    const shapes = new Set(rings.map((ring) => ring.focused.split(/,(?![^(]*\))/).filter((layer) => !layer.includes('inset')).join('|').replace(/rgba?\([^)]*\)/g, 'C')));
    expect([...shapes], `focus 링의 모양이 자리마다 다르다: ${JSON.stringify(rings)}`).toHaveLength(1);
  } finally {
    await stopServer(harness.server);
  }
});

test('만남 맥락은 면적과 진행으로 초대하고, 필수 표식이나 오류색으로 강제하지 않는다', async ({ page }) => {
  const harness = await boot(page);
  try {
    const block = page.locator('.context-block');
    await expect(block).toBeVisible();

    // 메모는 한 줄짜리 칸이 아니다 — 높이가 곧 "여기에 얼마나 적어도 되는가"라는 초대다.
    const memo = await block.getByRole('textbox', { name: '메모' })
      .evaluate((node) => (node.closest('ion-textarea') ?? node).getBoundingClientRect().height);
    expect(Math.round(memo), '메모 칸이 한 줄짜리다 — 길게 적을 자리로 보이지 않는다').toBeGreaterThanOrEqual(96);

    // 진행은 채운 만큼만 켜진다. 비어 있을 때 켜진 칸이 있으면 그것은 진행이 아니라 장식이다.
    const railBefore = await block.locator('.context-rail i.on').count();
    expect(railBefore, '아무것도 안 적었는데 진행이 켜져 있다').toBe(0);
    const railTotal = await block.locator('.context-rail i').count();
    expect(railTotal, '진행 칸 수가 만남 맥락의 칸 수와 다르다').toBe(4);

    await block.getByRole('textbox', { name: '어디서 만났나요?' }).fill('고객사 방문 미팅');
    await block.getByRole('textbox', { name: '나와의 관계' }).fill('오늘 처음');
    await expect(block.locator('.context-rail i.on')).toHaveCount(2);

    // 적힌 칸은 눈에 보이게 켜진다 — 이것이 "쓰고 싶어지는" 장치다.
    const emptyBorder = await settled(block.locator('.cc-field').filter({ hasText: 'Kairen과의 관계' }).locator('ion-input'), 'borderTopColor');
    const filledBorder = await settled(block.locator('.cc-field').filter({ hasText: '어디서 만났나요?' }).locator('ion-input'), 'borderTopColor');
    expect(filledBorder, '적힌 칸과 빈 칸이 똑같아 보인다').not.toBe(emptyBorder);

    // 강제하지 않는다: 별표도, 필수도, 오류색 글자도 없다.
    const pressure = await block.evaluate((node) => {
      const text = (node as HTMLElement).innerText;
      const danger = getComputedStyle(document.documentElement).getPropertyValue('--cc-danger').trim();
      const colored = Array.from(node.querySelectorAll<HTMLElement>('*'))
        .filter((child) => Array.from(child.childNodes).some((leaf) => leaf.nodeType === 3 && (leaf.textContent ?? '').trim()))
        .filter((child) => getComputedStyle(child).color.replace(/\s/g, '') === danger.replace(/\s/g, ''))
        .map((child) => (child.textContent ?? '').trim().slice(0, 24));
      return { words: ['필수', '반드시', '오류', '누락'].filter((word) => text.includes(word)), star: text.includes('*'), colored };
    });
    expect(pressure.words, '만남 맥락이 강제하는 말을 쓴다').toEqual([]);
    expect(pressure.star, '필수 표식(별표)이 있다').toBe(false);
    expect(pressure.colored, '기본 상태에서 오류색 글자가 있다').toEqual([]);
  } finally {
    await stopServer(harness.server);
  }
});

test('안면 촬영·얼굴 식별 진입은 어디에도 없다', async ({ page }) => {
  const harness = await boot(page);
  try {
    // 영구 non-goal이다 (INT-000029). 진입이 늘어날 때 조용히 끼어드는 것을 막는 상시 감시다.
    const forbidden = /안면|얼굴|생체|face\s*id|facial|biometric/i;
    const screen = await page.locator('main#kairen-ui').innerText();
    expect(screen.match(forbidden), `안면 인식 표현이 화면에 있다: ${screen.match(forbidden)?.[0]}`).toBeNull();

    const names = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('main#kairen-ui button'))
      .map((node) => (node.getAttribute('aria-label') ?? node.textContent ?? '').trim()));
    expect(names.filter((name) => forbidden.test(name)), '안면 인식 버튼이 있다').toEqual([]);
  } finally {
    await stopServer(harness.server);
  }
});

for (const viewport of [{ name: 'compact phone', width: 390, height: 844 }, { name: 'desktop', width: 1280, height: 800 }]) {
  test(`${viewport.name}에서 해부가 유지되고 긴 내용에도 가로로 새지 않는다`, async ({ page }) => {
    const harness = await boot(page, { width: viewport.width, height: viewport.height });
    try {
      const cards = await cardShapes(page);
      expect(cards.length).toBe(3);
      for (const card of cards) {
        expect(card.rows.length, `${viewport.name}: ${card.label}의 줄이 사라졌다`).toBe(3);
      }
      /* 높이 하한은 **해부별로** 다르다 (통합 검수 2026-08-04).
         첫 줄의 두 카드는 네 조각을 세로로 쌓으므로 140px 아래로 내려가면 조각이 뭉개진다.
         셋째 카드는 두 칸을 가로지르며 아이콘을 왼쪽 기둥으로 눕히는 **가로 해부**다. 예전에는
         이 카드도 같은 하한(실제로는 `min-height: 190px`)에 묶여 위 행과 똑같은 높이로 부풀었고,
         그 결과 설명 한 줄(16.68px)이 54.81px짜리 상자 안에 떠서 `사진 고르기`와의 사이가
         통째로 비었다. 넓은 카드는 넓이로 갚고 높이는 자기 내용만 쓴다. */
      expect(cards[0].rect.height, `${viewport.name}: 촬영 카드가 너무 낮다`).toBeGreaterThanOrEqual(140);
      expect(cards[1].rect.height, `${viewport.name}: 직접 입력 카드가 너무 낮다`).toBeGreaterThanOrEqual(140);
      expect(cards[2].rect.height, `${viewport.name}: 넓은 카드가 아이콘도 못 담을 만큼 낮다`).toBeGreaterThanOrEqual(70);
      expect(cards[2].rect.height, `${viewport.name}: 넓은 카드가 위 행 높이로 다시 부풀었다`).toBeLessThan(cards[0].rect.height);
      expect(Math.abs(cards[0].rect.height - cards[1].rect.height), '높이가 어긋났다').toBeLessThanOrEqual(2);

      // 아주 긴 값을 넣어도 카드·칸이 가로로 새지 않는다.
      const long = '가나다라마바사아자차카타파하'.repeat(12);
      await page.getByRole('textbox', { name: '어디서 만났나요?' }).fill(long);
      await page.getByRole('textbox', { name: '메모' }).fill(`${long} ${long}`);
      await page.waitForTimeout(200);

      const overflow = await page.evaluate(() => {
        const root = document.documentElement;
        const offenders = Array.from(document.querySelectorAll<HTMLElement>('main#kairen-ui *'))
          .filter((node) => node.getBoundingClientRect().right > root.clientWidth + 1)
          .map((node) => `${node.tagName.toLowerCase()}.${String(node.className || '').split(' ')[0]}`);
        return { viewport: root.clientWidth, scrollWidth: root.scrollWidth, offenders: offenders.slice(0, 6) };
      });
      expect(overflow.offenders, `${viewport.name}: 화면 밖으로 나간 요소가 있다`).toEqual([]);
      expect(overflow.scrollWidth, `${viewport.name}: 가로 스크롤이 생긴다`).toBeLessThanOrEqual(overflow.viewport + 1);

      const after = await cardShapes(page);
      for (const card of after) expect(card.rows.length, `${viewport.name}: 긴 내용 뒤에 카드 해부가 무너졌다`).toBe(3);

      // 이 화면의 disabled 상태(사진이 없어 아직 완료할 수 없는 `완료`)도 같은 자로 본다:
      // 흐려지되 낭독기가 이름과 상태를 함께 읽을 수 있어야 한다. 색만으로 말하지 않는다.
      await expect(page.getByRole('button', { name: '완료' })).toBeDisabled();
      // 이름·투명도·높이는 **host**(`ion-button`)에서 읽는다. Ionic은 실제 버튼을 shadow root 안에
      // 그리고 글자는 slot으로 넘기므로, role이 가리키는 `.button-native`의 textContent는 비어 있다.
      const doneShape = await page.locator('.capture-card ion-button.primary-action').evaluate((node) => {
        const style = getComputedStyle(node);
        return { name: (node.textContent ?? '').trim(), opacity: parseFloat(style.opacity), height: node.getBoundingClientRect().height };
      });
      expect(doneShape.name, 'disabled 버튼이 이름을 잃었다').toBe('완료');
      expect(doneShape.opacity, 'disabled 버튼이 안 보일 만큼 흐리다').toBeGreaterThan(0.3);
      expect(doneShape.height, 'disabled 버튼이 자리를 잃었다').toBeGreaterThanOrEqual(40);
    } finally {
      await stopServer(harness.server);
    }
  });
}

test('키보드만으로 두 입구에 닿고, 닿은 자리가 보인다', async ({ page }) => {
  const harness = await boot(page);
  try {
    for (const name of ['명함 앞면 촬영', '직접 입력']) {
      const entry = page.getByRole('button', { name });
      await entry.focus();
      const focus = await entry.evaluate((node) => ({
        focused: document.activeElement === node,
        width: parseFloat(getComputedStyle(node).outlineWidth),
        style: getComputedStyle(node).outlineStyle,
      }));
      expect(focus.focused, `${name}: 키보드 포커스를 받지 못한다`).toBe(true);
      expect(focus.style, `${name}: 포커스 표시가 없다`).not.toBe('none');
      expect(focus.width, `${name}: 포커스 테두리가 너무 얇다`).toBeGreaterThanOrEqual(2);
    }

    // 낭독기는 제목 → 설명 → 행동 순서로 읽는다. 접근 이름이 그 순서를 담고 있어야 한다.
    const name = await page.getByRole('button', { name: '직접 입력' }).evaluate((node) => (node.textContent ?? '').trim());
    expect(name.indexOf('직접 입력'), '제목이 먼저 읽히지 않는다').toBeLessThan(name.indexOf('명함이 없어도'));
    expect(name.indexOf('명함이 없어도'), '설명이 행동보다 먼저 읽히지 않는다').toBeLessThan(name.indexOf('적기 시작'));
  } finally {
    await stopServer(harness.server);
  }
});
