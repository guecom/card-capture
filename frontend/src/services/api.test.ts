import { describe, expect, it } from 'vitest';
import type { CaptureQueueItem, RuntimeConfig } from '../contracts/capture';
import { buildListUrl, buildSearchUrl, isTerminalStatus, toUploadPayload } from './api';

const config: RuntimeConfig = {
  apiUrl: 'https://script.google.com/macros/s/example/exec',
  token: 'fixture-token',
  capturer: 'Fixture Owner',
};

describe('legacy GAS contract adapter', () => {
  it('builds the cache-busting list request without changing action names', () => {
    const url = new URL(buildListUrl(config, 300, 1234));
    expect(url.searchParams.get('action')).toBe('list');
    expect(url.searchParams.get('k')).toBe('fixture-token');
    expect(url.searchParams.get('limit')).toBe('100');
    expect(url.searchParams.get('_ts')).toBe('1234');
  });

  it('builds the owner search request with the legacy query field', () => {
    const url = new URL(buildSearchUrl(config, '  홍 길동  '));
    expect(url.searchParams.get('action')).toBe('search');
    expect(url.searchParams.get('q')).toBe('홍 길동');
  });

  it('serializes only the existing upload payload contract', () => {
    const item: CaptureQueueItem = {
      captureId: '20260725-204800-fixture',
      capturedAt: '2026-07-25T11:48:00.000Z',
      event: 'fixture event',
      note: '메모: fixture',
      relSelf: 'must not be duplicated',
      relKairen: 'must not be duplicated',
      memo: 'must not be duplicated',
      disp: 'UI only',
      thumb: 'data:image/jpeg;base64,thumb',
      state: 'queued',
      tries: 2,
      images: [{ name: 'front.jpg', mime: 'image/jpeg', dataB64: 'front-data' }],
      quickName: null,
      researchInstruction: null,
    };

    expect(toUploadPayload(item, config)).toEqual({
      k: 'fixture-token',
      captureId: '20260725-204800-fixture',
      capturedAt: '2026-07-25T11:48:00.000Z',
      capturer: 'Fixture Owner',
      event: 'fixture event',
      note: '메모: fixture',
      quickName: null,
      researchInstruction: null,
      images: [{ name: 'front.jpg', mime: 'image/jpeg', dataB64: 'front-data' }],
    });
  });

  it('keeps completed and skipped captures terminal', () => {
    expect(isTerminalStatus('processed')).toBe(true);
    expect(isTerminalStatus('skipped')).toBe(true);
    expect(isTerminalStatus('received')).toBe(false);
    expect(isTerminalStatus('processing')).toBe(false);
  });
});
