// 빠른 이름 인식 품질 게이트 (TSK-000236): 실제 PP-OCRv5 한국어 모델을 워커에서 로드해
// 합성 명함에서 이름을 정확히 뽑는지, 그동안 메인 스레드가 잠기지 않는지 검증한다.
// 주의: 이 파일은 vendor 요청을 차단하지 않는다 — 실제 모델·ORT WASM이 필요하다.
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const buildRoot = resolve(fileURLToPath(new URL('../../docs/', import.meta.url)));

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
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
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': contentTypes[extname(filePath)] ?? 'application/octet-stream',
      });
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

test('recognizes the name on a synthetic korean card via the PP-OCR worker without blocking the main thread', async ({ page }) => {
  test.setTimeout(180_000);
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');

  try {
    page.on('console', (m) => { if (m.type() === 'error') console.log('PAGE_CONSOLE', m.type(), m.text().slice(0, 300)); });
    page.on('response', (r) => { if (r.status() === 404) console.log('HTTP404', r.url()); });
    page.on('pageerror', (e) => console.log('PAGE_ERROR', e.message.slice(0, 300)));
    await page.addInitScript(() => localStorage.setItem('cc_name', 'E2E Owner'));
    await page.goto(`http://127.0.0.1:${address.port}/next/`, { waitUntil: 'networkidle' });

    const result = await page.evaluate(async () => {
      const shell = await (await fetch('./sw.js')).text();
      const workerPath = /\.\/assets\/quickocr-worker-[^"]+\.js/.exec(shell)?.[0];
      if (!workerPath) return { error: 'quickocr worker asset not in service-worker shell' };

      // 관찰은 부팅이 가라앉은 뒤 워커 생성 직전부터 (buffered 금지 — CI 부팅 태스크 소급 방지).
      await new Promise((settle) => setTimeout(settle, 500));
      let maxLongTask = 0;
      const observer = new PerformanceObserver((list) => {
        list.getEntries().forEach((entry) => { maxLongTask = Math.max(maxLongTask, entry.duration); });
      });
      observer.observe({ type: 'longtask' });

      const worker = new Worker(workerPath, { type: 'module' });
      const request = (message: Record<string, unknown>, transfer: Transferable[] = []) => new Promise<Record<string, unknown>>((resolveReply) => {
        const handler = (replyEvent: MessageEvent<Record<string, unknown>>) => {
          if (replyEvent.data.id !== message.id) return;
          worker.removeEventListener('message', handler);
          resolveReply(replyEvent.data);
        };
        worker.addEventListener('message', handler);
        worker.postMessage(message, transfer);
      });

      const initStart = performance.now();
      const initReply = await request({
        id: 1,
        type: 'init',
        ortBase: new URL('../vendor/ort/', location.href).href,
        detection: new URL('../vendor/paddleocr/PP-OCRv5_mobile_det_infer.onnx', location.href).href,
        recognition: new URL('../vendor/paddleocr/korean_PP-OCRv5_mobile_rec_infer.onnx', location.href).href,
        dictionary: new URL('../vendor/paddleocr/ppocrv5_korean_dict.txt', location.href).href,
      });
      const initMs = Math.round(performance.now() - initStart);
      if (!initReply.ok) { observer.disconnect(); return { error: 'init failed', initMs }; }

      // 합성 명함: 흰 배경, 큰 이름·작은 직함·회사·연락처 (실카드 레이아웃 근사).
      const canvas = document.createElement('canvas');
      canvas.width = 960;
      canvas.height = 560;
      const context = canvas.getContext('2d');
      if (!context) { observer.disconnect(); return { error: 'no 2d context' }; }
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, 960, 560);
      context.fillStyle = '#10233d';
      context.font = '700 96px "Malgun Gothic", sans-serif';
      context.fillText('김진우', 70, 220);
      context.font = '400 44px "Malgun Gothic", sans-serif';
      context.fillText('대표이사', 70, 300);
      context.font = '600 40px "Malgun Gothic", sans-serif';
      context.fillText('카이렌 로보틱스', 70, 400);
      context.font = '400 32px "Malgun Gothic", sans-serif';
      context.fillText('010-1234-5678  jinwoo@kairen.kr', 70, 480);
      const image = context.getImageData(0, 0, 960, 560);

      const recognizeStart = performance.now();
      const reply = await request({ id: 2, type: 'recognize', image }, [image.data.buffer]);
      const recognizeMs = Math.round(performance.now() - recognizeStart);

      await new Promise((pause) => setTimeout(pause, 100));
      observer.disconnect();
      worker.terminate();
      const results = (reply.results ?? []) as Array<{ text: string; confidence: number; box: { height: number } }>;
      return {
        ok: reply.ok,
        initMs,
        recognizeMs,
        maxLongTask: Math.round(maxLongTask),
        texts: results.map((item) => item.text),
        tallest: results.slice().sort((a, b) => b.box.height - a.box.height)[0]?.text ?? null,
      };
    });

    console.log('PPOCR_GATE', JSON.stringify(result));
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    // 가장 큰 글씨(=이름)가 정확히 읽혀야 한다 — 기존 Tesseract가 처참했던 지점.
    expect(result.tallest).toContain('김진우');
    expect((result.texts as string[]).join(' ')).toContain('대표이사');
    // 프리즈 회귀 게이트: 모델 로드·추론 동안 메인 스레드 long task 한도.
    expect(result.maxLongTask as number).toBeLessThan(250);
  } finally {
    await new Promise<void>((stop) => { server.close(() => stop()); server.closeAllConnections(); });
  }
});
