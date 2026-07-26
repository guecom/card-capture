export type CandidateCameraErrorCode =
  | 'unsupported'
  | 'permission_denied'
  | 'camera_unavailable'
  | 'camera_busy'
  | 'frame_not_ready'
  | 'camera_failed';

export class CandidateCameraError extends Error {
  constructor(public readonly code: CandidateCameraErrorCode, cause?: unknown) {
    super(code, { cause });
    this.name = 'CandidateCameraError';
  }
}

export const environmentCameraConstraints: MediaStreamConstraints = {
  audio: false,
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 2560 },
    height: { ideal: 1440 },
  },
};

type CameraMediaDevices = Pick<MediaDevices, 'getUserMedia'>;

export async function openEnvironmentCamera(
  mediaDevices: CameraMediaDevices | undefined = typeof navigator === 'undefined'
    ? undefined
    : navigator.mediaDevices,
): Promise<MediaStream> {
  if (!mediaDevices?.getUserMedia) throw new CandidateCameraError('unsupported');
  try {
    return await mediaDevices.getUserMedia(environmentCameraConstraints);
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new CandidateCameraError('permission_denied', error);
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      throw new CandidateCameraError('camera_unavailable', error);
    }
    if (name === 'NotReadableError' || name === 'AbortError') {
      throw new CandidateCameraError('camera_busy', error);
    }
    throw new CandidateCameraError('camera_failed', error);
  }
}

export function stopCameraStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}

export async function setCameraTorch(stream: MediaStream | null | undefined, enabled: boolean): Promise<boolean> {
  const track = stream?.getVideoTracks()[0];
  const capabilities = track?.getCapabilities?.() as (MediaTrackCapabilities & { torch?: boolean }) | undefined;
  if (!track || !capabilities?.torch) return false;
  try {
    await track.applyConstraints({ advanced: [{ torch: enabled } as MediaTrackConstraintSet] });
    return true;
  } catch {
    return false;
  }
}

export function cameraHasTorch(stream: MediaStream | null | undefined): boolean {
  const track = stream?.getVideoTracks()[0];
  try {
    const capabilities = track?.getCapabilities?.() as (MediaTrackCapabilities & { torch?: boolean }) | undefined;
    return Boolean(capabilities?.torch);
  } catch {
    return false;
  }
}

export interface CapturedCameraFrame {
  dataUrl: string;
  width: number;
  height: number;
}

export function fitCameraFrame(width: number, height: number, maxEdge = 2000): { width: number; height: number } {
  if (width <= 0 || height <= 0) throw new CandidateCameraError('frame_not_ready');
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

type CameraVideoSource = Pick<HTMLVideoElement, 'videoWidth' | 'videoHeight'>;
export function captureCameraFrame(
  video: CameraVideoSource,
  createCanvas: () => HTMLCanvasElement = () => document.createElement('canvas'),
  transformCanvas: (source: HTMLCanvasElement) => HTMLCanvasElement = (source) => source,
): CapturedCameraFrame {
  const source = createCanvas();
  source.width = video.videoWidth;
  source.height = video.videoHeight;
  const context = source.getContext('2d');
  if (!context) throw new CandidateCameraError('camera_failed');
  context.drawImage(video as CanvasImageSource, 0, 0, source.width, source.height);
  const transformed = transformCanvas(source);
  const size = fitCameraFrame(transformed.width, transformed.height);
  let output = transformed;
  if (size.width !== transformed.width || size.height !== transformed.height) {
    output = createCanvas();
    output.width = size.width;
    output.height = size.height;
    const outputContext = output.getContext('2d');
    if (!outputContext) throw new CandidateCameraError('camera_failed');
    outputContext.drawImage(transformed, 0, 0, size.width, size.height);
  }
  return {
    dataUrl: output.toDataURL('image/jpeg', 0.85),
    ...size,
  };
}

export async function fileToCameraFrame(file: File): Promise<CapturedCameraFrame> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      try {
        return imageSourceToCameraFrame(bitmap, bitmap.width, bitmap.height);
      } finally {
        bitmap.close();
      }
    } catch {
      // Fall through to the image-element decoder used by older mobile browsers.
    }
  }

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      try {
        resolve(imageSourceToCameraFrame(image, image.naturalWidth, image.naturalHeight));
      } catch (error) {
        reject(error);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new CandidateCameraError('frame_not_ready'));
    };
    image.src = url;
  });
}

function imageSourceToCameraFrame(source: CanvasImageSource, width: number, height: number): CapturedCameraFrame {
  const size = fitCameraFrame(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (!context) throw new CandidateCameraError('camera_failed');
  context.drawImage(source, 0, 0, size.width, size.height);
  return { dataUrl: canvas.toDataURL('image/jpeg', 0.85), ...size };
}

// 촬영 파이프라인 마무리: legacy와 같은 2000px 상한·JPEG 0.85로 인코딩한다.
export function finalizeCameraFrame(canvas: HTMLCanvasElement): CapturedCameraFrame {
  const size = fitCameraFrame(canvas.width, canvas.height);
  let output = canvas;
  if (size.width !== canvas.width || size.height !== canvas.height) {
    output = document.createElement('canvas');
    output.width = size.width;
    output.height = size.height;
    const context = output.getContext('2d');
    if (!context) throw new CandidateCameraError('camera_failed');
    context.drawImage(canvas, 0, 0, size.width, size.height);
  }
  return { dataUrl: output.toDataURL('image/jpeg', 0.85), ...size };
}

// ImageData(워커 warp 결과)를 캔버스로 되돌린다.
export function canvasFromImageData(image: ImageData): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext('2d')?.putImageData(image, 0, 0);
  return canvas;
}

// 목록 표시에 원본 대신 쓸 104px 썸네일 (legacy thumbOf — 전송 후 원본이 정리돼도 남는다).
export function thumbnailOf(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        const scale = 104 / Math.max(image.width, image.height);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.6));
      } catch {
        resolve('');
      }
    };
    image.onerror = () => resolve('');
    image.src = dataUrl;
  });
}

// 감지 실패 시 가이드 프레임 영역만 잘라내는 폴백 크롭 (legacy camCapture 폴백).
export function cropCanvasRegion(source: HTMLCanvasElement, region: { x: number; y: number; w: number; h: number }): HTMLCanvasElement | null {
  const width = Math.round(region.w);
  const height = Math.round(region.h);
  if (width < 2 || height < 2) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(source, region.x, region.y, region.w, region.h, 0, 0, width, height);
  return canvas;
}
