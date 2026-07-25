import { describe, expect, it, vi } from 'vitest';
import {
  environmentCameraConstraints,
  openEnvironmentCamera,
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
});
