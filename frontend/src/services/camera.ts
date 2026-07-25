export type CandidateCameraErrorCode =
  | 'unsupported'
  | 'permission_denied'
  | 'camera_unavailable'
  | 'camera_busy'
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
