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

// ── 명함 사각형 감지 v2 (TSK-000244) ──────────────────────────────────────────
//
// v1은 equalizeHist + Canny → findContours → approxPolyDP → "면적 큰 것" 이었다.
// 실측 결과 그림자가 없는 수직 촬영·저대비 책상에서 검출률 0.5, IoU 0.17~0.49로 무너졌다.
// 카드 윤곽선이 한 군데라도 끊기면 닫힌 컨투어가 안 만들어지기 때문이다. 사선 촬영이 잘 되던
// 이유는 드롭 섀도가 윤곽을 진하게 만들어 주기 때문이고, 수직에서는 그 그림자가 사라진다.
//
// v2가 바꾼 것:
//  1) 조명 평탄화(gray - 큰 블러 + 128)로 균일하지 않은 조명·기울기를 먼저 제거한다.
//     opencv.js 빌드에 createCLAHE가 없어 고주파 통과로 같은 효과를 낸다.
//  2) edge map을 Canny·모폴로지 그래디언트·adaptiveThreshold 세 갈래로 만들고 닫아서(close)
//     끊긴 윤곽을 잇는다.
//  3) 후보를 컨투어(approxPolyDP 2단계) + minAreaRect + **Hough 직선 교점**에서 모은다.
//     직선 기반은 윤곽이 끊겨도 사각형을 복원한다(문헌상 approxPolyDP 대비 오차 60% 감소).
//  4) "면적 최대" 대신 edge support(변이 실제 edge 위에 얹혀 있는 비율)·종횡비·직각도·면적을
//     합친 점수로 고른다. 배경의 큰 사각형이 이기던 문제가 사라진다.
const CARD_RATIOS = [1.8, 1.586]; // KR 90x50, ISO 85.6x54

function quadFromPoints(points: WorkerPoint[]): WorkerPoint[] {
  return orderQuad(points);
}

// RotatedRect → 네 꼭짓점. 이 vendor 빌드에는 cv.boxPoints가 없어서 직접 계산한다
// (없는 줄 모르고 호출하면 minAreaRect 후보가 조용히 사라진다 — e2e/opencv-api.spec.ts가 이를 막는다).
function rotatedRectCorners(rect: { center: { x: number; y: number }; size: { width: number; height: number }; angle: number }): WorkerPoint[] {
  const radians = (rect.angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const halfWidth = rect.size.width / 2;
  const halfHeight = rect.size.height / 2;
  return quadFromPoints([
    { x: -halfWidth, y: -halfHeight }, { x: halfWidth, y: -halfHeight },
    { x: halfWidth, y: halfHeight }, { x: -halfWidth, y: halfHeight },
  ].map((corner) => ({
    x: rect.center.x + corner.x * cos - corner.y * sin,
    y: rect.center.y + corner.x * sin + corner.y * cos,
  })));
}

function quadArea(quad: WorkerPoint[]): number {
  let total = 0;
  for (let index = 0; index < 4; index += 1) {
    const a = quad[index];
    const b = quad[(index + 1) % 4];
    total += a.x * b.y - b.x * a.y;
  }
  return Math.abs(total) / 2;
}

function sideLengths(quad: WorkerPoint[]): { width: number; height: number } {
  const distance = (a: WorkerPoint, b: WorkerPoint) => Math.hypot(a.x - b.x, a.y - b.y);
  return {
    width: (distance(quad[0], quad[1]) + distance(quad[3], quad[2])) / 2,
    height: (distance(quad[0], quad[3]) + distance(quad[1], quad[2])) / 2,
  };
}

// 명함 종횡비에 얼마나 가까운가 (0..1). 세로로 세워 찍은 경우도 같은 점수를 준다.
function aspectScore(quad: WorkerPoint[]): number {
  const { width, height } = sideLengths(quad);
  if (width < 8 || height < 8) return 0;
  const ratio = width > height ? width / height : height / width;
  const best = CARD_RATIOS.reduce((closest, target) => Math.min(closest, Math.abs(ratio - target) / target), Number.POSITIVE_INFINITY);
  return Math.max(0, 1 - best * 2.2);
}

// 네 모서리가 직각에 가까운가 (0..1). 원근 때문에 완전한 직각은 아니므로 느슨하게 본다.
function rightAngleScore(quad: WorkerPoint[]): number {
  let total = 0;
  for (let index = 0; index < 4; index += 1) {
    const previous = quad[(index + 3) % 4];
    const current = quad[index];
    const next = quad[(index + 1) % 4];
    const ax = previous.x - current.x; const ay = previous.y - current.y;
    const bx = next.x - current.x; const by = next.y - current.y;
    const magnitude = Math.hypot(ax, ay) * Math.hypot(bx, by);
    if (!magnitude) return 0;
    const cosine = Math.abs((ax * bx + ay * by) / magnitude);
    total += Math.max(0, 1 - cosine * 2.4);
  }
  return total / 4;
}

// edge support: 사각형의 변이 실제 edge 픽셀 위에 얹혀 있는 비율 (0..1).
// 배경의 그럴듯한 사각형과 진짜 카드 경계를 가르는 핵심 신호다.
// 허용 오차(±2px)는 edge map을 미리 한 번 팽창시켜 흡수한다 — 후보마다 5x5를 훑으면
// 라이브 루프에서 감당이 안 된다(잠금 지연의 주범이었다).
function edgeSupport(supportMap: Cv, quad: WorkerPoint[]): number {
  const width = supportMap.cols;
  const height = supportMap.rows;
  const data = supportMap.data;
  let hits = 0;
  let samples = 0;
  for (let side = 0; side < 4; side += 1) {
    const from = quad[side];
    const to = quad[(side + 1) % 4];
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(8, Math.min(48, Math.round(length / 5)));
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      const x = Math.round(from.x + (to.x - from.x) * t);
      const y = Math.round(from.y + (to.y - from.y) * t);
      samples += 1;
      if (x >= 0 && y >= 0 && x < width && y < height && data[y * width + x]) hits += 1;
    }
  }
  return samples ? hits / samples : 0;
}

function scoreQuad(quad: WorkerPoint[], edgeMap: Cv, minimumArea: number, maximumArea: number): number {
  if (quad.length !== 4) return 0;
  const area = quadArea(quad);
  if (area <= minimumArea || area >= maximumArea) return 0;
  const aspect = aspectScore(quad);
  if (aspect <= 0) return 0;
  const angles = rightAngleScore(quad);
  if (angles <= 0) return 0;
  const support = edgeSupport(edgeMap, quad);
  const areaScore = Math.min(1, area / (0.45 * maximumArea));
  return 0.45 * support + 0.25 * aspect + 0.15 * angles + 0.15 * areaScore;
}

// Hough 직선 → 사각형. 지배 방향으로 두 묶음을 만들고 각 묶음의 양 극단 직선을 교차시킨다.
function quadFromHough(edgeMap: Cv, minimumLength: number): WorkerPoint[] | null {
  const lines = new cv.Mat();
  try {
    cv.HoughLinesP(edgeMap, lines, 1, Math.PI / 180, Math.max(20, Math.round(minimumLength * 0.5)), minimumLength, minimumLength * 0.6);
    if (lines.rows < 4) return null;
    const segments: Array<{ angle: number; length: number; nx: number; ny: number; offset: number }> = [];
    for (let index = 0; index < lines.rows; index += 1) {
      const x1 = lines.data32S[index * 4];
      const y1 = lines.data32S[index * 4 + 1];
      const x2 = lines.data32S[index * 4 + 2];
      const y2 = lines.data32S[index * 4 + 3];
      const length = Math.hypot(x2 - x1, y2 - y1);
      if (length < minimumLength) continue;
      let angle = Math.atan2(y2 - y1, x2 - x1);
      if (angle < 0) angle += Math.PI;              // 0..π (방향 무시)
      const nx = -Math.sin(angle);
      const ny = Math.cos(angle);
      segments.push({ angle, length, nx, ny, offset: nx * x1 + ny * y1 });
    }
    if (segments.length < 4) return null;
    segments.sort((a, b) => b.length - a.length);
    const base = segments[0].angle;
    const near = (angle: number, target: number) => {
      const difference = Math.abs(((angle - target + Math.PI * 1.5) % Math.PI) - Math.PI / 2);
      return difference < 0.44; // ±25°
    };
    const groupA = segments.filter((segment) => near(segment.angle, base));
    const groupB = segments.filter((segment) => near(segment.angle, base + Math.PI / 2));
    if (groupA.length < 2 || groupB.length < 2) return null;
    const extremes = (group: typeof segments) => {
      const sorted = group.slice().sort((a, b) => a.offset - b.offset);
      return [sorted[0], sorted[sorted.length - 1]];
    };
    const [a1, a2] = extremes(groupA);
    const [b1, b2] = extremes(groupB);
    if (Math.abs(a1.offset - a2.offset) < 12 || Math.abs(b1.offset - b2.offset) < 12) return null;
    const intersect = (p: typeof segments[0], q: typeof segments[0]): WorkerPoint | null => {
      const determinant = p.nx * q.ny - p.ny * q.nx;
      if (Math.abs(determinant) < 1e-6) return null;
      return {
        x: (p.offset * q.ny - p.ny * q.offset) / determinant,
        y: (p.nx * q.offset - p.offset * q.nx) / determinant,
      };
    };
    const corners = [intersect(a1, b1), intersect(a1, b2), intersect(a2, b2), intersect(a2, b1)];
    if (corners.some((corner) => !corner)) return null;
    return quadFromPoints(corners as WorkerPoint[]);
  } catch {
    return null;
  } finally {
    lines.delete();
  }
}

// 직전 프레임 사각형과의 근접도 (0..1). 후보가 프레임마다 갈아타며 박스가 떠는 것을 막는다.
function proximityScore(quad: WorkerPoint[], previous: WorkerPoint[] | null, diagonal: number): number {
  if (!previous || previous.length !== 4) return 0;
  const drift = quad.reduce((total, point, corner) => total + Math.hypot(point.x - previous[corner].x, point.y - previous[corner].y), 0) / 4;
  return Math.max(0, 1 - drift / (diagonal * 0.06));
}

function detectOnMat(source: Cv, minAreaRatio: number, fast: boolean, previous: WorkerPoint[] | null = null): WorkerPoint[] | null {
  const mats: Cv[] = [];
  const track = (mat: Cv) => { if (mat) mats.push(mat); return mat; };
  const width = source.cols;
  const height = source.rows;
  const minimumArea = minAreaRatio * width * height;
  const maximumArea = 0.96 * width * height;
  const minimumLineLength = Math.min(width, height) * 0.28;
  let best: WorkerPoint[] | null = null;
  let bestScore = 0;
  const diagonal = Math.hypot(width, height);
  let previousBest = 0; // 직전 사각형이 이번 프레임에서 받는 점수 (교체 비용 계산용)
  const consider = (quad: WorkerPoint[] | null, edgeMap: Cv) => {
    if (!quad) return;
    const base = scoreQuad(quad, edgeMap, minimumArea, maximumArea);
    if (base <= 0) return;
    const score = base + 0.14 * proximityScore(quad, previous, diagonal);
    if (score > bestScore) {
      best = quad;
      bestScore = score;
    }
  };

  try {
    const gray = track(new cv.Mat());
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
    cv.medianBlur(gray, gray, 3);

    // 조명 평탄화: 큰 블러(=조명 성분)를 빼서 지역 대비만 남긴다.
    const illumination = track(new cv.Mat());
    const small = track(new cv.Mat());
    const smallSize = new cv.Size(Math.max(16, Math.round(width / 4)), Math.max(16, Math.round(height / 4)));
    cv.resize(gray, small, smallSize, 0, 0, cv.INTER_AREA);
    const sigma = Math.max(2, Math.round(Math.min(smallSize.width, smallSize.height) / 12));
    cv.GaussianBlur(small, small, new cv.Size(0, 0), sigma, sigma, cv.BORDER_REPLICATE);
    cv.resize(small, illumination, new cv.Size(width, height), 0, 0, cv.INTER_LINEAR);
    const flat = track(new cv.Mat());
    cv.addWeighted(gray, 1, illumination, -1, 128, flat);

    const kernel = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
    const closeKernel = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5)));
    const edgeMaps: Cv[] = [];

    const otsuMat = track(new cv.Mat());
    const otsu = cv.threshold(flat, otsuMat, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    const canny = track(new cv.Mat());
    cv.Canny(flat, canny, Math.max(8, 0.4 * otsu), Math.max(30, otsu));
    cv.morphologyEx(canny, canny, cv.MORPH_CLOSE, closeKernel); // 끊긴 윤곽 잇기
    edgeMaps.push(canny);

    if (!fast) {
      // 모폴로지 그래디언트: 대비가 약해도 경계에서 확실히 반응한다 (깊은 프레임 전용 — 비싸다).
      const gradient = track(new cv.Mat());
      cv.morphologyEx(flat, gradient, cv.MORPH_GRADIENT, kernel);
      cv.threshold(gradient, gradient, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      cv.morphologyEx(gradient, gradient, cv.MORPH_CLOSE, closeKernel);
      edgeMaps.push(gradient);

      const adaptive = track(new cv.Mat());
      cv.adaptiveThreshold(gray, adaptive, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 21, 6);
      cv.morphologyEx(adaptive, adaptive, cv.MORPH_CLOSE, closeKernel);
      edgeMaps.push(adaptive);
    }

    const supportKernel = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5)));

    // 추적 우선(track-then-detect): 직전 사각형이 이번 프레임에서도 경계 위에 있으면 그대로 쓴다.
    // 후보 생성(Hough·컨투어)을 통째로 건너뛰므로 느린 기기에서 프레임당 비용이 크게 떨어진다.
    // 단 가벼운 프레임에서만 — 깊은 프레임은 항상 재탐색해서 잘못 잡힌 락이 굳지 않게 한다.
    if (fast && previous) {
      const trackMap = track(new cv.Mat());
      cv.dilate(edgeMaps[0], trackMap, supportKernel);
      const held = scoreQuad(previous, trackMap, minimumArea, maximumArea);
      if (held >= 0.5) return previous;
      previousBest = held;
    }

    edgeMaps.forEach((edgeMap) => {
      // edge support 조회용으로 한 번만 팽창시킨 맵 (±2px 허용 오차를 여기서 흡수한다).
      const supportMap = track(new cv.Mat());
      cv.dilate(edgeMap, supportMap, supportKernel);
      if (previous) previousBest = Math.max(previousBest, scoreQuad(previous, supportMap, minimumArea, maximumArea));

      // (1) 직선 기반 — 윤곽이 끊겨도 복원된다 (비싸므로 깊은 프레임에서만).
      if (!fast) consider(quadFromHough(edgeMap, minimumLineLength), supportMap);

      // (2) 컨투어 기반 — 윤곽이 살아 있으면 가장 정확하다.
      const contours = new cv.MatVector();
      mats.push(contours);
      const hierarchy = track(new cv.Mat());
      cv.findContours(edgeMap, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      // 면적 상위 컨투어만 본다 — 저대비 프레임에서는 컨투어가 수천 개 나온다.
      const ranked: Array<{ index: number; area: number }> = [];
      for (let index = 0; index < contours.size(); index += 1) {
        const contour = contours.get(index);
        const rawArea = Math.abs(cv.contourArea(contour));
        contour.delete();
        if (rawArea > minimumArea) ranked.push({ index, area: rawArea });
      }
      ranked.sort((a, b) => b.area - a.area);
      const shortlist = ranked.slice(0, 8);
      let largest: { contour: Cv; area: number } | null = null;
      for (const entry of shortlist) {
        const contour = contours.get(entry.index);
        try {
          if (!largest || entry.area > largest.area) {
            largest?.contour.delete();
            largest = { contour, area: entry.area };
          }
          const perimeter = cv.arcLength(contour, true);
          if (perimeter < minimumLineLength * 2) continue;
          for (const epsilon of [0.02, 0.04]) {
            const approximation = new cv.Mat();
            try {
              cv.approxPolyDP(contour, approximation, epsilon * perimeter, true);
              if (approximation.rows !== 4 || !cv.isContourConvex(approximation)) continue;
              consider(quadFromPoints(Array.from({ length: 4 }, (_, corner) => ({
                x: approximation.data32S[corner * 2],
                y: approximation.data32S[corner * 2 + 1],
              }))), supportMap);
            } finally {
              approximation.delete();
            }
          }
        } finally {
          if (largest?.contour !== contour) contour.delete();
        }
      }
      // (3) 가장 큰 덩어리의 최소 외접 사각형 — 윤곽이 볼록하지 않아도 후보를 하나 준다.
      if (largest) {
        try {
          consider(rotatedRectCorners(cv.minAreaRect(largest.contour)), supportMap);
        } catch { /* minAreaRect 실패는 후보 하나를 잃을 뿐이다 */ }
        largest.contour.delete();
      }
    });
    // 최소 품질선 — 이보다 낮으면 "못 찾았다"고 말하는 편이 낫다(엉뚱한 박스 금지).
    if (bestScore < 0.42 || !best) return null;
    const settled: WorkerPoint[] = best;
    // 교체 비용: 직전 사각형이 이번 프레임에서도 충분히 좋으면 갈아타지 않는다.
    // 후보 생성기(Hough·컨투어·minAreaRect)가 프레임마다 번갈아 이기며 박스가 튀는 것을 막는다.
    // 카드가 실제로 움직이면 직전 사각형의 edge support가 떨어져 자연히 교체된다.
    if (previous && previousBest >= 0.42 && previousBest >= bestScore * 0.9) return previous;
    // 데드밴드: 직전과 거의 같으면 직전 값을 그대로 쓴다 (미세 진동 제거).
    if (previous && proximityScore(settled, previous, diagonal) > 0.965) return previous;
    return settled;
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

function handleAnalyze(image: ImageData, minAreaRatio: number, fast: boolean, withGate: boolean, previous: WorkerPoint[] | null) {
  const source = cv.matFromImageData(image);
  try {
    const quad = detectOnMat(source, minAreaRatio, fast, previous);
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
      const { image, minAreaRatio, fast, withGate, previousQuad } = messageEvent.data as { image: ImageData; minAreaRatio: number; fast: boolean; withGate: boolean; previousQuad?: WorkerPoint[] | null };
      workerScope.postMessage({ id, ok: true, ...handleAnalyze(image, minAreaRatio, fast, withGate, previousQuad ?? null) });
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
