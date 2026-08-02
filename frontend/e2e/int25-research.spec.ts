import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const buildRoot = process.env.KAIREN_TEST_BUILD_ROOT
  ? resolve(process.env.KAIREN_TEST_BUILD_ROOT)
  : resolve(fileURLToPath(new URL('../../docs/', import.meta.url)));

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
      // 격리 빌드는 candidate의 내용만 담으므로 `/next/` 접두사를 벗긴다.
      if (process.env.KAIREN_TEST_BUILD_ROOT && relativePath.startsWith('next/')) relativePath = relativePath.slice('next/'.length);
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

const personBrief = {
  captureId: '20260802-100000-person',
  receivedAt: '2026-08-02T01:00:00.000Z',
  status: 'processed',
  person: 'PER-000001',
  contact: { name: '김민서', organization: 'Kairen', title: '운영 책임자' },
  brief: '# 김민서 — 이런 분이에요\n공개 자료로 확인된 프로필입니다.',
};

type ResearchPayload = {
  action?: string;
  instruction?: { requestId?: string; raw?: string };
};

interface Harness {
  server: Server;
  researchRequests: ResearchPayload[];
  listRequests: () => number;
}

async function boot(
  page: import('@playwright/test').Page,
  options: { items?: unknown[]; failFirstResearch?: boolean } = {},
): Promise<Harness> {
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');
  const researchRequests: ResearchPayload[] = [];
  let listRequestCount = 0;

  await page.context().route('**/vendor/**', (route) => route.abort());
  await page.route('https://api.example.test/**', async (route) => {
    const request = route.request();
    if (request.method() === 'GET' && new URL(request.url()).searchParams.get('action') === 'list') {
      listRequestCount += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          seeAll: true,
          researchInstructionEnabled: true,
          deepResearchEnabled: true,
          hasMore: false,
          items: options.items ?? [personBrief],
        }),
      });
      return;
    }

    const payload = JSON.parse(request.postData() ?? '{}') as ResearchPayload;
    if (payload.action === 'researchinstruction') {
      researchRequests.push(payload);
      if (options.failFirstResearch && researchRequests.length === 1) {
        await route.abort('failed');
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, receiptId: `research-${payload.instruction?.requestId}` }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.addInitScript(() => { localStorage.setItem('cc_name', '이강규'); });
  await page.setViewportSize({ width: 390, height: 844 });
  const api = encodeURIComponent('https://api.example.test/exec');
  await page.goto(`http://127.0.0.1:${address.port}/next/?api=${api}&k=owner-token`, { waitUntil: 'networkidle' });
  return { server, researchRequests, listRequests: () => listRequestCount };
}

test('an existing-person research retry survives Android-like page reload and a new draft rotates it', async ({ page }) => {
  const harness = await boot(page, { failFirstResearch: true });
  try {
    await page.getByRole('button', { name: '진행', exact: true }).click();
    await page.locator('.brief-summary').click();
    await page.locator('.brief-detail').getByRole('button', { name: 'AI 조사 요청' }).click();

    const composer = page.locator('ion-modal.person-action-modal');
    const textbox = composer.locator('ion-textarea[aria-label="AI 조사 요청"] textarea');
    await textbox.fill('공개 결과물과 최근 발표를 확인해 줘');
    await composer.getByRole('button', { name: '조사 요청 접수' }).click();

    await expect.poll(() => harness.researchRequests.length).toBe(1);
    await expect(page.getByText(/접수 실패/)).toBeVisible();
    await expect(composer).toBeVisible();

    const persisted = await page.evaluate(() => Object.entries(localStorage)
      .find(([key]) => key.endsWith('_pendingPersonResearch'))?.[1] ?? '');
    expect(persisted).toContain('requestId');
    expect(persisted).not.toContain('PER-000001');
    expect(persisted).not.toContain('공개 결과물');

    // Android가 앱 프로세스를 버린 것처럼 JS 메모리와 열린 modal을 함께 없앤다.
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '진행', exact: true }).click();
    await page.locator('.brief-summary').click();
    await page.locator('.brief-detail').getByRole('button', { name: 'AI 조사 요청' }).click();
    const recoveredComposer = page.locator('ion-modal.person-action-modal');
    await recoveredComposer.locator('ion-textarea[aria-label="AI 조사 요청"] textarea').fill('  공개 결과물과 최근 발표를 확인해 줘  ');
    await recoveredComposer.getByRole('button', { name: '조사 요청 접수' }).click();
    await expect.poll(() => harness.researchRequests.length).toBe(2);
    await expect(recoveredComposer).toBeHidden();

    const retriedIds = harness.researchRequests.slice(0, 2).map((request) => request.instruction?.requestId);
    expect(retriedIds[0]).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(retriedIds[1]).toBe(retriedIds[0]);
    expect(await page.evaluate(() => Object.keys(localStorage).some((key) => key.endsWith('_pendingPersonResearch')))).toBe(false);

    // 성공 뒤 사용자가 새 작성기를 열면 새 논리 요청이다.
    await page.locator('.brief-detail').getByRole('button', { name: 'AI 조사 요청' }).click();
    await recoveredComposer.locator('ion-textarea[aria-label="AI 조사 요청"] textarea').fill('새로운 공개 발표만 다시 확인해 줘');
    await recoveredComposer.getByRole('button', { name: '조사 요청 접수' }).click();
    await expect.poll(() => harness.researchRequests.length).toBe(3);
    expect(harness.researchRequests[2].instruction?.requestId).not.toBe(retriedIds[0]);
  } finally {
    harness.server.close();
  }
});

test('a malformed research result is contained in one card with deterministic recovery actions', async ({ page }) => {
  const malformedResearch = {
    ...personBrief,
    captureId: 'research-request-00000001',
    type: 'research_instruction',
    researchEvidence: {
      version: 'deep-research-evidence-v1',
      purposes: ['expertise_execution'],
      claims: [null, { id: 'c1', state: 'fact', summary: '깨진 근거', evidenceFor: [null], evidenceAgainst: [] }],
      timeline: [{ date: '2026', label: '공개', claimIds: ['missing'] }],
      openQuestions: [],
      stop: { reason: 'purpose_satisfied', summary: '완료' },
    },
  };
  const harness = await boot(page, { items: [malformedResearch] });
  try {
    await page.getByRole('button', { name: '진행', exact: true }).click();
    await page.locator('.brief-summary').click();

    const recovery = page.getByRole('alert', { name: '조사 결과 복구 안내' });
    await expect(recovery.getByRole('heading', { name: '조사 결과를 안전하게 열지 못했어요' })).toBeVisible();
    await expect(recovery).toContainText('기존 기록은 그대로');
    await expect(recovery.getByRole('button', { name: '다시 확인' })).toBeVisible();
    await expect(recovery.getByRole('button', { name: '새 조사 요청' })).toBeVisible();
    await expect(page.locator('.research-claim')).toHaveCount(0);

    const before = harness.listRequests();
    await recovery.getByRole('button', { name: '다시 확인' }).click();
    await expect.poll(() => harness.listRequests()).toBeGreaterThan(before);
    await expect(recovery).toBeVisible();
  } finally {
    harness.server.close();
  }
});

test('a valid relationship graph exposes real endpoints, sources, and timeline claims on phone and desktop', async ({ page }) => {
  const validResearch = {
    ...personBrief,
    captureId: 'research-request-00000002',
    type: 'research_instruction',
    researchEvidence: {
      version: 'deep-research-evidence-v1',
      purposes: ['meeting_preparation'],
      nodes: [
        { id: 'person-1', type: 'person', label: '김민서' },
        { id: 'org-1', type: 'organization', label: 'Kairen' },
        { id: 'claim-1', type: 'claim', label: '공개 발표를 이끌었다' },
        { id: 'source-1', type: 'source', label: '공식 발표', url: 'https://example.test/announcement' },
      ],
      edges: [
        { id: 'edge-1', sourceId: 'source-1', targetId: 'claim-1', relation: 'supports', label: '주장을 뒷받침' },
        { id: 'edge-2', sourceId: 'person-1', targetId: 'org-1', relation: 'leads', label: '운영을 이끎' },
      ],
      claims: [{
        id: 'claim-1', state: 'fact', summary: '공개 발표를 이끌었다', confidence: 'high',
        evidenceFor: [{ sourceId: 'source-1', title: '공식 발표', url: 'https://example.test/announcement' }],
        evidenceAgainst: [],
      }],
      timeline: [{ date: '2026-07', label: '공개 발표', claimIds: ['claim-1'] }],
      openQuestions: ['후속 실행 결과는 무엇인가?'],
      metrics: { branchCount: 4, sourceCount: 1, elapsedMinutes: 37 },
      stop: { reason: 'purpose_satisfied', summary: '만남 준비에 필요한 근거를 확보했다' },
    },
  };
  const harness = await boot(page, { items: [validResearch] });
  try {
    await page.getByRole('button', { name: '진행', exact: true }).click();
    await page.locator('.brief-summary').click();
    const overview = page.getByRole('region', { name: '조사 관계와 타임라인 범위' });
    await expect(overview).toContainText('출처 · 공식 발표');
    await expect(overview).toContainText('→ 주장 · 공개 발표를 이끌었다');
    await expect(overview).toContainText('사람 · 김민서');
    await expect(overview).toContainText('→ 조직 · Kairen');
    await expect(overview.getByRole('link', { name: '원문 출처 열기' })).toHaveAttribute('href', 'https://example.test/announcement');
    await expect(overview).toContainText('2026-07');
    await expect(overview).toContainText('공개 발표를 이끌었다');

    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(overview).toBeVisible();
    await expect(page.locator('.research-claim')).toHaveCount(1);
  } finally {
    harness.server.close();
  }
});
