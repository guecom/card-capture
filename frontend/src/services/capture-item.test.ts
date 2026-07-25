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
    }, { now, random: () => 0.5, quickName: {
      name: '김카이렌', source: 'device_text_detector', confidence: 80, confirmed: false, recognizedAt: now.toISOString(),
    } });

    expect(item).toMatchObject({
      captureId: '20260725-224509-i',
      capturedAt: now.toISOString(),
      images: [{ name: 'front.jpg', mime: 'image/jpeg', dataB64: 'fixture-image' }],
      quickName: { name: '김카이렌', source: 'device_text_detector', confidence: 80, confirmed: false },
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
    }, { now })).toThrow('invalid_camera_frame');
  });

  it('preserves back image, sticky context labels, memo, and research instruction', () => {
    const item = buildQueuedCapture({ dataUrl: 'data:image/jpeg;base64,front', width: 1600, height: 900 }, {
      backFrame: { dataUrl: 'data:image/jpeg;base64,back', width: 1600, height: 900 },
      event: ' 2026 로보월드 ',
      relSelf: ' 오늘 처음 인사 ',
      relKairen: ' 잠재 고객 ',
      memo: ' 자료 보내기 ',
      researchInstruction: { raw: '공개 이력 확인', channel: 'owner_ui', policyVersion: 'public-research-v1', riskFlags: [] },
      now,
    });

    expect(item).toMatchObject({
      event: '2026 로보월드',
      relSelf: '오늘 처음 인사',
      relKairen: '잠재 고객',
      memo: '자료 보내기',
      note: '나와의 관계: 오늘 처음 인사\nKairen과의 관계: 잠재 고객\n메모: 자료 보내기',
      disp: '자료 보내기',
      images: [{ name: 'front.jpg', dataB64: 'front' }, { name: 'back.jpg', dataB64: 'back' }],
      researchInstruction: { raw: '공개 이력 확인', policyVersion: 'public-research-v1' },
    });
  });
});
