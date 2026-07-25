import { describe, expect, it, vi } from 'vitest';
import { nameCandidate, recognizeNameFromAttempts } from './vision';

// @ts-expect-error The legacy UMD fixture intentionally has no TypeScript declaration.
import legacyVisionModule from '../../../docs/camera-quality.js';

const legacyVision = legacyVisionModule as { nameCandidate(text: string): string };

describe('quick-name OCR contract', () => {
  it.each([
    ['김카이렌\n대표이사\nKairen', '김카이렌'],
    ['Kairen Company\nAlex Kim\nDirector', 'Alex Kim'],
    ['hello@example.com\n02-123-4567', ''],
  ])('matches the legacy name candidate for %j', (text, expected) => {
    expect(nameCandidate(text)).toBe(expected);
    expect(nameCandidate(text)).toBe(legacyVision.nameCandidate(text));
  });

  it('uses the fast device detector before the Tesseract fallback', async () => {
    const fallback = vi.fn(async () => ({ text: 'Fallback Name', confidence: 70, source: 'device_tesseract' }));
    await expect(recognizeNameFromAttempts([
      async () => ({ text: '김카이렌\n대표', confidence: 79.6, source: 'device_text_detector' }),
      fallback,
    ], () => new Date('2026-07-25T13:00:00.000Z'))).resolves.toEqual({
      name: '김카이렌',
      source: 'device_text_detector',
      confidence: 80,
      confirmed: false,
      recognizedAt: '2026-07-25T13:00:00.000Z',
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('falls back after an unavailable detector and keeps capture non-blocking on failure', async () => {
    await expect(recognizeNameFromAttempts([
      async () => { throw new Error('detector_failed'); },
      async () => ({ text: 'Jane Park\nManager', confidence: 62.4, source: 'device_tesseract' }),
    ], () => new Date('2026-07-25T13:00:00.000Z'))).resolves.toMatchObject({
      name: 'Jane Park', source: 'device_tesseract', confidence: 62,
    });
    await expect(recognizeNameFromAttempts([
      async () => null,
      async () => { throw new Error('ocr_failed'); },
    ])).resolves.toBeNull();
  });
});
