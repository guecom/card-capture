import { describe, expect, it, vi } from 'vitest';
import type { CaptureQueueItem, RuntimeConfig } from '../contracts/capture';
import { addPersonNote, buildDocumentUrl, buildListUrl, buildSearchUrl, isTerminalStatus, requestCorrection, submitResearchInstruction, toUploadPayload } from './api';

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

  it('builds both legacy Person document routes', () => {
    expect(new URL(buildDocumentUrl(config, 'doc', 'PER-000001')).searchParams.get('id')).toBe('PER-000001');
    expect(new URL(buildDocumentUrl(config, 'persondoc', 'CAP-1')).searchParams.get('captureId')).toBe('CAP-1');
  });

  it('keeps note, research, and correction action payload names and targets', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ json: async () => ({ ok: true, receiptId: 'receipt-1' }) });
    vi.stubGlobal('fetch', fetchMock);
    await addPersonNote(config, { person: 'PER-000001' }, ' note ');
    await submitResearchInstruction(config, { captureId: 'CAP-1' }, ' research ');
    await requestCorrection(config, 'CAP-1', ' correction ');
    expect(fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)))).toEqual([
      { action: 'addnote', person: 'PER-000001', text: 'note', k: 'fixture-token' },
      { action: 'researchinstruction', captureId: 'CAP-1', text: 'research', k: 'fixture-token' },
      { action: 'correction', captureId: 'CAP-1', text: 'correction', k: 'fixture-token' },
    ]);
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
