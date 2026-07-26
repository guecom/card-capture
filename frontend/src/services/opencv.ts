export interface Point {
  x: number;
  y: number;
}

// OpenCV.js is a pinned legacy UMD runtime with no maintained TypeScript surface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OpenCvRuntime = any;

let runtimePromise: Promise<OpenCvRuntime | null> | null = null;

function resolveRuntime(candidate: OpenCvRuntime): Promise<OpenCvRuntime | null> {
  if (!candidate) return Promise.resolve(null);
  if (typeof candidate.then === 'function') return candidate.then((runtime: OpenCvRuntime) => runtime ?? null);
  if (candidate.Mat) return Promise.resolve(candidate);
  return new Promise((resolve) => {
    candidate.onRuntimeInitialized = () => resolve(candidate);
  });
}

// 파일만 미리 받아 캐시에 넣는다 — 실행·컴파일은 하지 않으므로 메인 스레드를 막지 않는다.
// 실제 실행(loadOpenCv)은 카메라 미리보기가 뜬 뒤라, 버튼을 누르는 순간 프리즈가 생기지 않는다.
export function prefetchOpenCv(): void {
  if (runtimePromise || typeof fetch !== 'function') return;
  void fetch(new URL('../vendor/opencv.js', document.baseURI).href, { cache: 'force-cache' }).catch(() => undefined);
}

export function loadOpenCv(): Promise<OpenCvRuntime | null> {
  if (runtimePromise) return runtimePromise;
  if (!window.WebAssembly) return Promise.resolve(null);
  const globalWindow = window as typeof window & { cv?: OpenCvRuntime };
  if (globalWindow.cv) {
    runtimePromise = resolveRuntime(globalWindow.cv);
    return runtimePromise;
  }

  runtimePromise = new Promise<OpenCvRuntime | null>((resolve) => {
    const script = document.createElement('script');
    script.src = new URL('../vendor/opencv.js', document.baseURI).href;
    script.async = true;
    script.onload = () => void resolveRuntime(globalWindow.cv).then(resolve);
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });
  return runtimePromise;
}

export function orderQuad(points: Point[]): Point[] {
  const bySum = points.slice().sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const byDifference = points.slice().sort((a, b) => (a.y - a.x) - (b.y - b.x));
  return [bySum[0], byDifference[0], bySum[3], byDifference[3]];
}

export function plausibleCard(quad: Point[]): boolean {
  if (quad.length !== 4) return false;
  const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  const width = Math.max(distance(quad[0], quad[1]), distance(quad[3], quad[2]));
  const height = Math.max(distance(quad[0], quad[3]), distance(quad[1], quad[2]));
  if (width < 20 || height < 20) return false;
  const ratio = width / height;
  return (ratio >= 1.15 && ratio <= 2.7) || (ratio >= 0.37 && ratio <= 0.87);
}

export function detectCardQuad(canvas: HTMLCanvasElement, cv: OpenCvRuntime, minAreaRatio = 0.06, fast = false): Point[] | null {
  if (!cv) return null;
  const mats: OpenCvRuntime[] = [];
  const track = (mat: OpenCvRuntime) => { if (mat) mats.push(mat); return mat; };
  const width = canvas.width;
  const height = canvas.height;
  const minimumArea = minAreaRatio * width * height;
  const maximumArea = 0.96 * width * height;
  let best: Point[] | null = null;
  let bestScore = 0;

  try {
    const source = track(cv.imread(canvas));
    const gray = track(new cv.Mat());
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    const equalized = track(new cv.Mat());
    cv.equalizeHist(gray, equalized);
    const kernel = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
    const edgeMaps: OpenCvRuntime[] = [];
    const otsuMat = track(new cv.Mat());
    const otsu = cv.threshold(equalized, otsuMat, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    const canny = track(new cv.Mat());
    cv.Canny(equalized, canny, Math.max(10, 0.5 * otsu), Math.max(40, otsu));
    cv.dilate(canny, canny, kernel);
    edgeMaps.push(canny);

    if (!fast) {
      const adaptive = track(new cv.Mat());
      cv.adaptiveThreshold(gray, adaptive, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 21, 6);
      cv.morphologyEx(adaptive, adaptive, cv.MORPH_CLOSE, kernel);
      edgeMaps.push(adaptive);
    }

    edgeMaps.forEach((edgeMap) => {
      const contours = new cv.MatVector();
      mats.push(contours);
      const hierarchy = track(new cv.Mat());
      cv.findContours(edgeMap, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      for (let index = 0; index < contours.size(); index += 1) {
        const contour = contours.get(index);
        const approximation = new cv.Mat();
        try {
          const perimeter = cv.arcLength(contour, true);
          cv.approxPolyDP(contour, approximation, 0.02 * perimeter, true);
          if (approximation.rows !== 4 || !cv.isContourConvex(approximation)) continue;
          const area = cv.contourArea(approximation);
          if (area <= minimumArea || area >= maximumArea) continue;
          const quad = orderQuad(Array.from({ length: 4 }, (_, pointIndex) => ({
            x: approximation.data32S[pointIndex * 2],
            y: approximation.data32S[pointIndex * 2 + 1],
          })));
          const score = area * (plausibleCard(quad) ? 1.6 : 0.35);
          if (score > bestScore) {
            best = quad;
            bestScore = score;
          }
        } finally {
          approximation.delete();
          contour.delete();
        }
      }
    });
    return best;
  } catch {
    return null;
  } finally {
    mats.forEach((mat) => { try { mat?.delete(); } catch { /* best-effort OpenCV cleanup */ } });
  }
}

export function warpCard(sourceCanvas: HTMLCanvasElement, quad: Point[], cv: OpenCvRuntime): HTMLCanvasElement | null {
  if (!cv || !plausibleCard(quad)) return null;
  const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  const width = Math.round(Math.max(distance(quad[0], quad[1]), distance(quad[3], quad[2])));
  const height = Math.round(Math.max(distance(quad[0], quad[3]), distance(quad[1], quad[2])));
  if (width < 60 || height < 60) return null;
  let source: OpenCvRuntime;
  let sourceTriangle: OpenCvRuntime;
  let destinationTriangle: OpenCvRuntime;
  let matrix: OpenCvRuntime;
  let destination: OpenCvRuntime;
  try {
    source = cv.imread(sourceCanvas);
    sourceTriangle = cv.matFromArray(4, 1, cv.CV_32FC2, quad.flatMap((point) => [point.x, point.y]));
    destinationTriangle = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width, 0, width, height, 0, height]);
    matrix = cv.getPerspectiveTransform(sourceTriangle, destinationTriangle);
    destination = new cv.Mat();
    cv.warpPerspective(source, destination, matrix, new cv.Size(width, height), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
    const output = document.createElement('canvas');
    cv.imshow(output, destination);
    return output;
  } catch {
    return null;
  } finally {
    [source, sourceTriangle, destinationTriangle, matrix, destination].forEach((mat) => {
      try { mat?.delete(); } catch { /* best-effort OpenCV cleanup */ }
    });
  }
}

export function rectifyCardCanvas(source: HTMLCanvasElement, cv: OpenCvRuntime): HTMLCanvasElement | null {
  const previewWidth = 640;
  const previewHeight = Math.max(1, Math.round(previewWidth * source.height / source.width));
  const preview = document.createElement('canvas');
  preview.width = previewWidth;
  preview.height = previewHeight;
  const context = preview.getContext('2d');
  if (!context) return null;
  context.drawImage(source, 0, 0, previewWidth, previewHeight);
  const quad = detectCardQuad(preview, cv);
  if (!quad || !plausibleCard(quad)) return null;
  const scale = source.width / previewWidth;
  return warpCard(source, quad.map((point) => ({ x: point.x * scale, y: point.y * scale })), cv);
}

export function blurScore(canvas: HTMLCanvasElement, cv: OpenCvRuntime): number | null {
  if (!cv) return null;
  let source: OpenCvRuntime;
  let gray: OpenCvRuntime;
  let laplacian: OpenCvRuntime;
  let mean: OpenCvRuntime;
  let standardDeviation: OpenCvRuntime;
  try {
    source = cv.imread(canvas);
    gray = new cv.Mat();
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
    laplacian = new cv.Mat();
    cv.Laplacian(gray, laplacian, cv.CV_64F);
    mean = new cv.Mat();
    standardDeviation = new cv.Mat();
    cv.meanStdDev(laplacian, mean, standardDeviation);
    return Math.pow(standardDeviation.data64F[0], 2);
  } catch {
    return null;
  } finally {
    [source, gray, laplacian, mean, standardDeviation].forEach((mat) => {
      try { mat?.delete(); } catch { /* best-effort OpenCV cleanup */ }
    });
  }
}
