import { describe, expect, it, vi } from 'vitest';
import {
  cameraHasTorch,
  captureCameraFrame,
  environmentCameraConstraints,
  fitCameraFrame,
  openEnvironmentCamera,
  setCameraTorch,
  stopCameraStream,
} from './camera';

describe('candidate camera boundary', () => {
  it('requests the same environment-facing resolution envelope as legacy', async () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValue(stream);

    await expect(openEnvironmentCamera({ getUserMedia })).resolves.toBe(stream);
    expect(getUserMedia).toHaveBeenCalledWith(environmentCameraConstraints);
  });

  it.each([
    ['NotAllowedError', 'permission_denied'],
    ['SecurityError', 'permission_denied'],
    ['NotFoundError', 'camera_unavailable'],
    ['OverconstrainedError', 'camera_unavailable'],
    ['NotReadableError', 'camera_busy'],
    ['AbortError', 'camera_busy'],
    ['UnknownError', 'camera_failed'],
  ] as const)('maps %s without changing the fallback contract', async (name, code) => {
    const failure = Object.assign(new Error(name), { name });
    const getUserMedia = vi.fn().mockRejectedValue(failure);

    await expect(openEnvironmentCamera({ getUserMedia })).rejects.toMatchObject({ code });
  });

  it('fails closed when MediaDevices is unavailable', async () => {
    await expect(openEnvironmentCamera(undefined)).rejects.toMatchObject({
      code: 'unsupported',
    });
  });

  it('stops every track when the preview closes', () => {
    const stopVideo = vi.fn();
    const stopAudio = vi.fn();
    const stream = {
      getTracks: () => [{ stop: stopVideo }, { stop: stopAudio }],
    } as unknown as MediaStream;

    stopCameraStream(stream);
    expect(stopVideo).toHaveBeenCalledOnce();
    expect(stopAudio).toHaveBeenCalledOnce();
  });

  it('fits a captured frame inside the legacy long-edge envelope', () => {
    expect(fitCameraFrame(4032, 3024)).toEqual({ width: 2000, height: 1500 });
    expect(fitCameraFrame(1280, 720)).toEqual({ width: 1280, height: 720 });
  });

  it('encodes a camera frame in memory without queue or upload effects', () => {
    const drawImage = vi.fn();
    const toDataURL = vi.fn().mockReturnValue('data:image/jpeg;base64,fixture');
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn().mockReturnValue({ drawImage }),
      toDataURL,
    } as unknown as HTMLCanvasElement;

    expect(captureCameraFrame({ videoWidth: 1600, videoHeight: 900 }, () => canvas)).toEqual({
      dataUrl: 'data:image/jpeg;base64,fixture',
      width: 1600,
      height: 900,
    });
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1600, 900);
    expect(toDataURL).toHaveBeenCalledWith('image/jpeg', 0.85);
  });

  it('exposes and applies the legacy torch capability without throwing on unsupported devices', async () => {
    const applyConstraints = vi.fn().mockResolvedValue(undefined);
    const torchTrack = { getCapabilities: () => ({ torch: true }), applyConstraints } as unknown as MediaStreamTrack;
    const stream = { getVideoTracks: () => [torchTrack] } as unknown as MediaStream;
    expect(cameraHasTorch(stream)).toBe(true);
    expect(await setCameraTorch(stream, true)).toBe(true);
    expect(applyConstraints).toHaveBeenCalledWith({ advanced: [{ torch: true }] });
    expect(await setCameraTorch({ getVideoTracks: () => [] } as unknown as MediaStream, true)).toBe(false);
  });
});
