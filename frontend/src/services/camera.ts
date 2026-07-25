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

export interface CapturedCameraFrame {
  dataUrl: string;
  width: number;
  height: number;
}

export function fitCameraFrame(width: number, height: number, maxEdge = 2400): { width: number; height: number } {
  if (width <= 0 || height <= 0) throw new CandidateCameraError('frame_not_ready');
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

type CameraVideoSource = Pick<HTMLVideoElement, 'videoWidth' | 'videoHeight'>;
interface CameraCanvas {
  width: number;
  height: number;
  getContext(contextId: '2d'): Pick<CanvasRenderingContext2D, 'drawImage'> | null;
  toDataURL(type?: string, quality?: number): string;
}

export function captureCameraFrame(
  video: CameraVideoSource,
  createCanvas: () => CameraCanvas = () => document.createElement('canvas'),
): CapturedCameraFrame {
  const size = fitCameraFrame(video.videoWidth, video.videoHeight);
  const canvas = createCanvas();
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (!context) throw new CandidateCameraError('camera_failed');
  context.drawImage(video as CanvasImageSource, 0, 0, size.width, size.height);
  return {
    dataUrl: canvas.toDataURL('image/jpeg', 0.88),
    ...size,
  };
}
