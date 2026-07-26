// 카메라 프리즈 회귀 게이트 (TSK-000230): 실제 vendor/opencv.js를 워커에서 로드·감지시키고
// 그동안 메인 스레드 long task가 프리즈 수준으로 발생하지 않음을 검증한다.
// 주의: 이 파일은 vendor 요청을 차단하지 않는다 — 실제 엔진이 필요하다.
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

test('loads the card-detection engine in a worker and keeps the main thread responsive', async ({ page }) => {
  test.setTimeout(120_000);
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');

  try {
    await page.addInitScript(() => localStorage.setItem('cc_name', 'E2E Owner'));
    await page.goto(`http://127.0.0.1:${address.port}/next/`, { waitUntil: 'networkidle' });

    const result = await page.evaluate(async () => {
      const shell = await (await fetch('./sw.js')).text();
      const workerPath = /\.\/assets\/opencv-worker-[^"]+\.js/.exec(shell)?.[0];
      if (!workerPath) return { error: 'worker asset not in service-worker shell' };

      let maxLongTask = 0;
      const observer = new PerformanceObserver((list) => {
        list.getEntries().forEach((entry) => { maxLongTask = Math.max(maxLongTask, entry.duration); });
      });
      observer.observe({ type: 'longtask', buffered: true });

      const worker = new Worker(workerPath);
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
      const initReply = await request({ id: 1, type: 'init', vendorUrl: new URL('../vendor/opencv.js', location.href).href });
      const initMs = Math.round(performance.now() - initStart);

      // 합성 명함: 어두운 배경 위 1.75 비율의 밝은 카드.
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const context = canvas.getContext('2d');
      if (!context) return { error: 'no 2d context' };
      context.fillStyle = '#1c2733';
      context.fillRect(0, 0, 320, 180);
      context.fillStyle = '#f2f4f7';
      context.fillRect(55, 30, 210, 120);
      const image = context.getImageData(0, 0, 320, 180);
      const analysis = await request({ id: 2, type: 'analyze', image, minAreaRatio: 0.07, fast: false, withGate: true }, [image.data.buffer]);

      await new Promise((pause) => setTimeout(pause, 100));
      observer.disconnect();
      worker.terminate();
      return { initOk: initReply.ok, initMs, quad: analysis.quad, blur: analysis.blur, maxLongTask: Math.round(maxLongTask) };
    });

    console.log('WORKER_GATE', JSON.stringify(result));
    expect(result.error).toBeUndefined();
    expect(result.initOk).toBe(true);
    expect(Array.isArray(result.quad) && (result.quad as unknown[]).length === 4).toBe(true);
    // 프리즈 회귀 게이트: 엔진 로드·컴파일·감지 동안 메인 스레드 long task가 프리즈 수준이면 실패.
    expect(result.maxLongTask as number).toBeLessThan(250);
  } finally {
    await new Promise<void>((stop) => { server.close(() => stop()); server.closeAllConnections(); });
  }
});
