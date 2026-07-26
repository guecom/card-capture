// OpenCV 전용 Web Worker — 로드·WASM 컴파일·감지·warp·흐림 점수를 전부 이 스레드에서 수행한다.
// 메인 스레드는 어떤 시점에도 엔진 때문에 멈추지 않는다 (2026-07-26 실폰 프리즈 근본 수정, TSK-000230).
// 주의: importScripts를 쓰므로 classic worker여야 한다 (Vite build는 iife로 번들링).

// import가 없는 파일이라 모듈로 명시하지 않으면 전역 스코프로 취급돼
// (@techstark/opencv-js 타입의 전역 cv 선언과) 충돌한다.
export {};

interface WorkerPoint { x: number; y: number }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cv = any;
let cv: Cv = null;

const workerScope = self as unknown as { importScripts: (url: string) => void; postMessage: (message: unknown) => void; cv?: Cv };

function orderQuad(points: WorkerPoint[]): WorkerPoint[] {
  const bySum = points.slice().sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const byDifference = points.slice().sort((a, b) => (a.y - a.x) - (b.y - b.x));
  return [bySum[0], byDifference[0], bySum[3], byDifference[3]];
}

function plausibleCard(quad: WorkerPoint[]): boolean {
  if (quad.length !== 4) return false;
  const distance = (a: WorkerPoint, b: WorkerPoint) => Math.hypot(a.x - b.x, a.y - b.y);
  const width = Math.max(distance(quad[0], quad[1]), distance(quad[3], quad[2]));
  const height = Math.max(distance(quad[0], quad[3]), distance(quad[1], quad[2]));
  if (width < 20 || height < 20) return false;
  const ratio = width / height;
  return (ratio >= 1.15 && ratio <= 2.7) || (ratio >= 0.37 && ratio <= 0.87);
}

// legacy 다중 전략 감지 (equalizeHist + Otsu auto-Canny, 저대비 폴백 adaptiveThreshold) — RGBA Mat 입력.
function detectOnMat(source: Cv, minAreaRatio: number, fast: boolean): WorkerPoint[] | null {
  const mats: Cv[] = [];
  const track = (mat: Cv) => { if (mat) mats.push(mat); return mat; };
  const width = source.cols;
  const height = source.rows;
  const minimumArea = minAreaRatio * width * height;
  const maximumArea = 0.96 * width * height;
  let best: WorkerPoint[] | null = null;
  let bestScore = 0;
  try {
    const gray = track(new cv.Mat());
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    const equalized = track(new cv.Mat());
    cv.equalizeHist(gray, equalized);
    const kernel = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
    const edgeMaps: Cv[] = [];
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
    mats.forEach((mat) => { try { mat?.delete(); } catch { /* best-effort cleanup */ } });
  }
}

function blurOnMat(source: Cv): number | null {
  let gray: Cv; let laplacian: Cv; let mean: Cv; let deviation: Cv;
  try {
    gray = new cv.Mat();
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
    laplacian = new cv.Mat();
    cv.Laplacian(gray, laplacian, cv.CV_64F);
    mean = new cv.Mat();
    deviation = new cv.Mat();
    cv.meanStdDev(laplacian, mean, deviation);
    return Math.pow(deviation.data64F[0], 2);
  } catch {
    return null;
  } finally {
    [gray, laplacian, mean, deviation].forEach((mat) => { try { mat?.delete(); } catch { /* best-effort cleanup */ } });
  }
}

// 감지 사각형 bbox의 과노출 비율 — 자동 촬영 glare 게이트 입력.
function clippedRatioInQuad(image: ImageData, quad: WorkerPoint[], threshold = 250): number {
  const left = Math.max(0, Math.floor(Math.min(...quad.map((point) => point.x))));
  const top = Math.max(0, Math.floor(Math.min(...quad.map((point) => point.y))));
  const right = Math.min(image.width, Math.ceil(Math.max(...quad.map((point) => point.x))));
  const bottom = Math.min(image.height, Math.ceil(Math.max(...quad.map((point) => point.y))));
  if (right - left < 2 || bottom - top < 2) return 0;
  let clipped = 0;
  let total = 0;
  for (let y = top; y < bottom; y += 1) {
    let offset = (y * image.width + left) * 4;
    for (let x = left; x < right; x += 1, offset += 4) {
      total += 1;
      if (image.data[offset] >= threshold && image.data[offset + 1] >= threshold && image.data[offset + 2] >= threshold) clipped += 1;
    }
  }
  return total ? clipped / total : 0;
}

function handleAnalyze(image: ImageData, minAreaRatio: number, fast: boolean, withGate: boolean) {
  const source = cv.matFromImageData(image);
  try {
    const quad = detectOnMat(source, minAreaRatio, fast);
    let blur: number | null = null;
    let clippedRatio = 0;
    if (quad && withGate) {
      blur = blurOnMat(source);
      clippedRatio = clippedRatioInQuad(image, quad);
    }
    return { quad, blur, clippedRatio };
  } finally {
    source.delete();
  }
}

// 원본 해상도 ImageData에서 명함을 감지해 perspective 보정한 ImageData를 돌려준다.
function handleRectify(image: ImageData): { image: ImageData } | null {
  const mats: Cv[] = [];
  const track = (mat: Cv) => { if (mat) mats.push(mat); return mat; };
  try {
    const source = track(cv.matFromImageData(image));
    const previewWidth = 640;
    const previewHeight = Math.max(1, Math.round(previewWidth * source.rows / source.cols));
    const preview = track(new cv.Mat());
    cv.resize(source, preview, new cv.Size(previewWidth, previewHeight), 0, 0, cv.INTER_AREA);
    const quad = detectOnMat(preview, 0.06, false);
    if (!quad || !plausibleCard(quad)) return null;
    const factor = source.cols / previewWidth;
    const scaled = quad.map((point) => ({ x: point.x * factor, y: point.y * factor }));
    const distance = (a: WorkerPoint, b: WorkerPoint) => Math.hypot(a.x - b.x, a.y - b.y);
    const width = Math.round(Math.max(distance(scaled[0], scaled[1]), distance(scaled[3], scaled[2])));
    const height = Math.round(Math.max(distance(scaled[0], scaled[3]), distance(scaled[1], scaled[2])));
    if (width < 60 || height < 60) return null;
    const sourceTriangle = track(cv.matFromArray(4, 1, cv.CV_32FC2, scaled.flatMap((point) => [point.x, point.y])));
    const destinationTriangle = track(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width, 0, width, height, 0, height]));
    const matrix = track(cv.getPerspectiveTransform(sourceTriangle, destinationTriangle));
    const destination = track(new cv.Mat());
    cv.warpPerspective(source, destination, matrix, new cv.Size(width, height), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
    const output = new ImageData(new Uint8ClampedArray(destination.data), destination.cols, destination.rows);
    return { image: output };
  } catch {
    return null;
  } finally {
    mats.forEach((mat) => { try { mat?.delete(); } catch { /* best-effort cleanup */ } });
  }
}

function resolveRuntime(candidate: Cv): Promise<Cv | null> {
  if (!candidate) return Promise.resolve(null);
  if (typeof candidate.then === 'function') return candidate.then((runtime: Cv) => runtime ?? null);
  if (candidate.Mat) return Promise.resolve(candidate);
  return new Promise((resolve) => {
    candidate.onRuntimeInitialized = () => resolve(candidate);
  });
}

self.onmessage = (messageEvent: MessageEvent) => {
  const { id, type } = messageEvent.data as { id: number; type: string };
  try {
    if (type === 'init') {
      const { vendorUrl } = messageEvent.data as { vendorUrl: string };
      try {
        workerScope.importScripts(vendorUrl);
      } catch {
        workerScope.postMessage({ id, ok: false });
        return;
      }
      void resolveRuntime(workerScope.cv).then((runtime) => {
        cv = runtime;
        workerScope.postMessage({ id, ok: Boolean(runtime) });
      });
      return;
    }
    if (!cv) {
      workerScope.postMessage({ id, ok: false });
      return;
    }
    if (type === 'analyze') {
      const { image, minAreaRatio, fast, withGate } = messageEvent.data as { image: ImageData; minAreaRatio: number; fast: boolean; withGate: boolean };
      workerScope.postMessage({ id, ok: true, ...handleAnalyze(image, minAreaRatio, fast, withGate) });
      return;
    }
    if (type === 'rectify') {
      const { image } = messageEvent.data as { image: ImageData };
      const result = handleRectify(image);
      workerScope.postMessage({ id, ok: true, image: result?.image ?? null });
      return;
    }
    if (type === 'blur') {
      const { image } = messageEvent.data as { image: ImageData };
      const source = cv.matFromImageData(image);
      try {
        workerScope.postMessage({ id, ok: true, blur: blurOnMat(source) });
      } finally {
        source.delete();
      }
      return;
    }
    workerScope.postMessage({ id, ok: false });
  } catch {
    workerScope.postMessage({ id, ok: false });
  }
};
