import * as ort from 'onnxruntime-web';
import { quadFromCornerHeatmaps, rgbaToBgrChw } from '../services/card-quad-heatmap';

interface InitMessage {
  id: number;
  type: 'init';
  ortBase: string;
  model: string;
}

interface DetectMessage {
  id: number;
  type: 'detect';
  image: ImageData;
}

const INPUT_SIZE = 256;
let session: ort.InferenceSession | null = null;

function resizeForModel(image: ImageData): ImageData | null {
  const source = new OffscreenCanvas(image.width, image.height);
  const sourceContext = source.getContext('2d');
  const target = new OffscreenCanvas(INPUT_SIZE, INPUT_SIZE);
  const targetContext = target.getContext('2d', { willReadFrequently: true });
  if (!sourceContext || !targetContext) return null;
  sourceContext.putImageData(image, 0, 0);
  targetContext.drawImage(source, 0, 0, INPUT_SIZE, INPUT_SIZE);
  return targetContext.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
}

self.onmessage = async (messageEvent: MessageEvent<InitMessage | DetectMessage>) => {
  const message = messageEvent.data;
  try {
    if (message.type === 'init') {
      ort.env.wasm.wasmPaths = message.ortBase;
      ort.env.wasm.numThreads = 1;
      session = await ort.InferenceSession.create(message.model, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
      self.postMessage({ id: message.id, ok: true });
      return;
    }
    if (!session) {
      self.postMessage({ id: message.id, ok: false });
      return;
    }
    const resized = resizeForModel(message.image);
    if (!resized) {
      self.postMessage({ id: message.id, ok: false });
      return;
    }
    const input = new ort.Tensor('float32', rgbaToBgrChw(resized.data), [1, 3, INPUT_SIZE, INPUT_SIZE]);
    const output = await session.run({ img: input });
    const heatmap = output.heatmap;
    const shape = heatmap?.dims ?? [];
    const result = heatmap?.data instanceof Float32Array && shape.length === 4
      ? quadFromCornerHeatmaps(heatmap.data, Number(shape[3]), Number(shape[2]), message.image.width, message.image.height)
      : null;
    self.postMessage({ id: message.id, ok: true, quad: result?.quad ?? null, confidence: result?.confidence ?? 0 });
  } catch (error) {
    console.error('[card-quad-worker]', error instanceof Error ? error.message : String(error));
    self.postMessage({ id: message.id, ok: false });
  }
};
