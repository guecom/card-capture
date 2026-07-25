import type { QuickName } from '../contracts/capture';

export interface OcrTextResult {
  text: string;
  confidence: number;
  source: string;
}

export type OcrAttempt = () => Promise<OcrTextResult | null>;

export function nameCandidate(text: string): string {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const blocked = /주식회사|유한회사|회사|그룹|센터|연구소|대학교|병원|협회|대표이사|대표|이사|부장|차장|과장|팀장|매니저|director|manager|president|company|corporation|corp\.?|inc\.?|ltd\.?|team/i;
  const candidates: Array<{ name: string; score: number }> = [];

  lines.forEach((line, lineIndex) => {
    if (/@|https?:|www\.|\d{3}[-.)]/i.test(line)) return;
    const koreanNames = line.match(/[가-힣]{2,4}/g) ?? [];
    koreanNames.forEach((word) => {
      if (blocked.test(word)) return;
      const score = 70 + (line === word ? 48 : 0) + (line.length <= 12 ? 18 : 0) - lineIndex * 2 - (blocked.test(line) ? 24 : 0);
      candidates.push({ name: word, score });
    });
    const englishNames = line.match(/\b[A-Z][A-Za-z'.-]{1,20}(?:\s+[A-Z][A-Za-z'.-]{1,20}){1,2}\b/g) ?? [];
    englishNames.forEach((word) => {
      if (!blocked.test(word)) candidates.push({ name: word, score: 90 + (line === word ? 32 : 0) - lineIndex * 2 });
    });
  });

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.name ?? '';
}

export async function recognizeNameFromAttempts(
  attempts: OcrAttempt[],
  now: () => Date = () => new Date(),
): Promise<QuickName | null> {
  for (const attempt of attempts) {
    let result: OcrTextResult | null = null;
    try {
      result = await attempt();
    } catch {
      continue;
    }
    if (!result) continue;
    const name = nameCandidate(result.text);
    if (!name) continue;
    return {
      name,
      source: result.source,
      confidence: Math.max(0, Math.min(100, Math.round(result.confidence || 0))),
      confirmed: false,
      recognizedAt: now().toISOString(),
    };
  }
  return null;
}

interface TextDetectorRow { rawValue?: string }
interface TextDetectorInstance { detect(source: CanvasImageSource): Promise<TextDetectorRow[]> }
interface TextDetectorConstructor { new(): TextDetectorInstance }
interface TesseractWorker {
  setParameters(parameters: Record<string, string>): Promise<unknown>;
  recognize(source: CanvasImageSource): Promise<{ data?: { text?: string; confidence?: number } }>;
}
interface TesseractGlobal {
  createWorker(
    languages: string,
    engineMode: number,
    options: { workerPath: string; langPath: string; corePath: string; logger: (message: { status?: string; progress?: number }) => void },
  ): Promise<TesseractWorker>;
}

const scriptLoads = new Map<string, Promise<void>>();
let tesseractWorker: Promise<TesseractWorker> | null = null;

function loadScriptOnce(src: string): Promise<void> {
  const existing = scriptLoads.get(src);
  if (existing) return existing;
  const pending = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`script_load_failed:${src}`));
    document.head.appendChild(script);
  }).catch((error) => {
    scriptLoads.delete(src);
    throw error;
  });
  scriptLoads.set(src, pending);
  return pending;
}

function imageCanvas(dataUrl: string): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, 1400 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) {
        reject(new Error('ocr_canvas_failed'));
        return;
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas);
    };
    image.onerror = () => reject(new Error('ocr_image_failed'));
    image.src = dataUrl;
  });
}

async function ensureTesseractWorker(onProgress: (progress: number) => void): Promise<TesseractWorker> {
  if (tesseractWorker) return tesseractWorker;
  const scriptUrl = new URL('../vendor/tesseract/tesseract.min.js', document.baseURI).href;
  tesseractWorker = loadScriptOnce(scriptUrl).then(async () => {
    const runtime = window as typeof window & { Tesseract?: TesseractGlobal };
    if (!runtime.Tesseract) throw new Error('tesseract_unavailable');
    const worker = await runtime.Tesseract.createWorker('kor+eng', 1, {
      workerPath: new URL('../vendor/tesseract/worker.min.js', document.baseURI).href,
      langPath: new URL('../vendor/tesseract/', document.baseURI).href,
      corePath: new URL('../vendor/tesseract/tesseract-core-simd-lstm.wasm.js', document.baseURI).href,
      logger: (message) => {
        if (message.status === 'recognizing text') onProgress(Math.round((message.progress ?? 0) * 100));
      },
    });
    await worker.setParameters({ tessedit_pageseg_mode: '11', preserve_interword_spaces: '1' });
    return worker;
  }).catch((error) => {
    tesseractWorker = null;
    throw error;
  });
  return tesseractWorker;
}

export async function recognizeQuickName(
  dataUrl: string,
  onProgress: (progress: number) => void = () => undefined,
): Promise<QuickName | null> {
  const canvas = await imageCanvas(dataUrl);
  const runtime = window as typeof window & { TextDetector?: TextDetectorConstructor };
  return recognizeNameFromAttempts([
    async () => {
      if (!runtime.TextDetector) return null;
      const rows = await new runtime.TextDetector().detect(canvas);
      return { text: rows.map((row) => row.rawValue ?? '').join('\n'), confidence: 80, source: 'device_text_detector' };
    },
    async () => {
      const worker = await ensureTesseractWorker(onProgress);
      const result = await worker.recognize(canvas);
      return {
        text: result.data?.text ?? '',
        confidence: result.data?.confidence ?? 0,
        source: 'device_tesseract',
      };
    },
  ]);
}
