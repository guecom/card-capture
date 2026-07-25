import { describe, expect, it } from 'vitest';
import { buildQueuedCapture, createCaptureId } from './capture-item';

describe('captured-image queue contract', () => {
  const now = new Date(2026, 6, 25, 22, 45, 9);

  it('keeps the legacy local-time capture id shape', () => {
    expect(createCaptureId(now, () => 0.5)).toBe('20260725-224509-i');
  });

  it('builds the existing front-image queue payload without network fields', () => {
    const item = buildQueuedCapture({
      dataUrl: 'data:image/jpeg;base64,fixture-image',
      width: 1600,
      height: 900,
    }, now, () => 0.5);

    expect(item).toMatchObject({
      captureId: '20260725-224509-i',
      capturedAt: now.toISOString(),
      images: [{ name: 'front.jpg', mime: 'image/jpeg', dataB64: 'fixture-image' }],
      quickName: null,
      researchInstruction: null,
      state: 'queued',
      tries: 0,
    });
    expect(item).not.toHaveProperty('k');
    expect(item).not.toHaveProperty('capturer');
  });

  it('rejects a non-JPEG frame before IndexedDB can receive it', () => {
    expect(() => buildQueuedCapture({
      dataUrl: 'data:image/png;base64,fixture-image',
      width: 1600,
      height: 900,
    }, now)).toThrow('invalid_camera_frame');
  });
});
