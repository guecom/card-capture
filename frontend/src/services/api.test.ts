import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CaptureQueueItem, RuntimeConfig } from '../contracts/capture';
import { addPersonNote, buildDocumentUrl, buildListUrl, buildSearchUrl, fetchServerCaptureIds, isTerminalStatus, requestCorrection, submitResearchInstruction, toUploadPayload, uploadCapture, UploadError } from './api';

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

// FI-016: "서버가 거절했다"와 "답을 못 받았다"는 후속 조치가 정반대다.
describe('upload failures separate a refusal from an unanswered request', () => {
  const uploadConfig: RuntimeConfig = { apiUrl: 'https://api.example.test/exec', token: 'fixture-token', capturer: 'Fixture Owner' };
  const capture: CaptureQueueItem = {
    captureId: '20260727-190000-fixture',
    capturedAt: '2026-07-27T10:00:00.000Z',
    images: [{ name: 'front.jpg', mime: 'image/jpeg', dataB64: 'front-data' }],
    state: 'queued',
    tries: 0,
  };

  afterEach(() => vi.unstubAllGlobals());

  async function failureOf(fetchImpl: unknown): Promise<UploadError> {
    vi.stubGlobal('fetch', fetchImpl);
    return await uploadCapture(uploadConfig, capture).then(
      () => { throw new Error('expected an upload failure'); },
      (error: UploadError) => error,
    );
  }

  it('treats a server refusal as rejected — nothing was stored', async () => {
    const error = await failureOf(async () => ({ ok: true, json: async () => ({ ok: false, error: 'daily_limit' }) }));
    expect(error.kind).toBe('rejected');
    expect(error.reason).toBe('daily_limit');
  });

  it('treats a dropped connection as ambiguous — it may or may not have been stored', async () => {
    const error = await failureOf(async () => { throw new TypeError('Failed to fetch'); });
    expect(error.kind).toBe('ambiguous');
  });

  it('treats a server error status as ambiguous — the write may have half happened', async () => {
    const error = await failureOf(async () => ({ ok: false, status: 502, json: async () => ({}) }));
    expect(error.kind).toBe('ambiguous');
    expect(error.reason).toBe('http_502');
  });

  it('treats an unreadable answer as ambiguous rather than assuming success', async () => {
    const error = await failureOf(async () => ({ ok: true, json: async () => { throw new SyntaxError('bad json'); } }));
    expect(error.kind).toBe('ambiguous');
    expect(error.reason).toBe('unreadable_response');
  });

  it('succeeds without throwing when the server confirms', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ ok: true, captureId: capture.captureId }) }));
    await expect(uploadCapture(uploadConfig, capture)).resolves.toBeUndefined();
  });

  it('reports unknown rather than empty when the capture list cannot be read', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch'); });
    expect(await fetchServerCaptureIds(uploadConfig)).toBeNull();

    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ ok: false, error: 'invalid_token' }) }));
    expect(await fetchServerCaptureIds(uploadConfig)).toBeNull();
  });

  it('returns the ids the server actually reported', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ ok: true, items: [{ captureId: 'a' }, { captureId: 'b' }] }),
    }));
    expect(await fetchServerCaptureIds(uploadConfig)).toEqual(new Set(['a', 'b']));
  });
});
