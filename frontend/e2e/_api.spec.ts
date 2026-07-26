import { test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const buildRoot = resolve(fileURLToPath(new URL('../../docs/', import.meta.url)));
const types: Record<string,string> = { '.js':'text/javascript','.html':'text/html','.wasm':'application/wasm','.css':'text/css','.json':'application/json' };
function serve(): Promise<Server> {
  const s = createServer(async (rq, rs) => {
    try {
      let p = decodeURIComponent(new URL(rq.url ?? '/', 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
      if (p.endsWith('/')) p += 'index.html';
      const f = resolve(buildRoot, p);
      if (f !== buildRoot && !f.startsWith(`${buildRoot}${sep}`)) { rs.writeHead(403).end(); return; }
      const body = await readFile(f);
      rs.writeHead(200, { 'content-type': types[extname(f)] ?? 'application/octet-stream' });
      rs.end(body);
    } catch { if (!rs.headersSent) rs.writeHead(404); rs.end(); }
  });
  s.keepAliveTimeout = 1;
  return new Promise((ok, no) => { s.once('error', no); s.listen(0, '127.0.0.1', () => ok(s)); });
}
test('opencv api probe', async ({ page }) => {
  test.setTimeout(180_000);
  const server = await serve();
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  try {
    await page.goto(`http://127.0.0.1:${a.port}/next/`, { waitUntil: 'domcontentloaded' });
    const out = await page.evaluate(async (port) => {
      const code = `
        importScripts('http://127.0.0.1:${port}/vendor/opencv.js');
        function report(cv){
          const names=['createCLAHE','HoughLinesP','HoughLines','convexHull','minAreaRect','bilateralFilter','medianBlur','Scharr','Sobel','morphologyEx','adaptiveThreshold','equalizeHist','approxPolyDP','contourArea','arcLength','isContourConvex','warpPerspective','getPerspectiveTransform','findContours','Canny','dilate','erode','GaussianBlur','resize','cvtColor','matFromImageData','threshold','countNonZero','MORPH_GRADIENT','MORPH_CLOSE','MORPH_RECT','RETR_LIST','RETR_EXTERNAL','CHAIN_APPROX_SIMPLE','THRESH_OTSU','INTER_AREA','BORDER_REPLICATE','Laplacian','meanStdDev','convertScaleAbs','addWeighted','bitwise_or','normalize','copyMakeBorder','remap','minMaxLoc','split','merge'];
          const has={}; names.forEach(n=>{has[n]= typeof cv[n] !== 'undefined';});
          postMessage({has, version: cv.getBuildInformation ? 'has-build-info' : 'no-build-info'});
        }
        if (self.cv && self.cv.Mat) report(self.cv);
        else if (self.cv && typeof self.cv.then==='function') self.cv.then(report);
        else self.cv.onRuntimeInitialized=()=>report(self.cv);
      `;
      const worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
      return new Promise((done) => { worker.onmessage = (e) => done(e.data); });
    }, a.port);
    const has = (out as { has: Record<string, boolean> }).has;
    console.log('MISSING', JSON.stringify(Object.keys(has).filter((k) => !has[k])));
    console.log('PRESENT_COUNT', Object.values(has).filter(Boolean).length, '/', Object.keys(has).length);
  } finally { await new Promise<void>((k) => { server.close(() => k()); server.closeAllConnections(); }); }
});
