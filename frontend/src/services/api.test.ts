import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CaptureQueueItem, RuntimeConfig } from '../contracts/capture';
import { addPersonNote, buildDocumentUrl, buildListUrl, buildSearchUrl, fetchServerCaptureIds, isTerminalStatus, listBriefsUpTo, requestCorrection, submitResearchInstruction, toUploadPayload, uploadCapture, UploadError } from './api';

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
    const instruction = { raw: 'research', mode: 'standard' as const, focusIds: ['expertise' as const] };
    await submitResearchInstruction(config, { captureId: 'CAP-1' }, instruction);
    await requestCorrection(config, 'CAP-1', ' correction ');
    expect(fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)))).toEqual([
      { action: 'addnote', person: 'PER-000001', text: 'note', k: 'fixture-token' },
      { action: 'researchinstruction', captureId: 'CAP-1', instruction, k: 'fixture-token' },
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

// FI-100: 서버는 offset·hasMore로 과거 기록 전체를 줄 수 있다 (Code.gs `listCaptures_`).
// 한 페이지만 읽으면 첫 페이지 밖의 캡처는 앱에서 존재하지 않는 것이 된다.
describe('reading the capture list past the first server page', () => {
  const pagedConfig: RuntimeConfig = { apiUrl: 'https://api.example.test/exec', token: 'fixture-token', capturer: 'Fixture Owner' };

  afterEach(() => vi.unstubAllGlobals());

  /** Code.gs `listCaptures_`와 같은 규칙으로 답하는 합성 서버: limit 1~100 clamp, offset 건너뛰기, hasMore 보고. */
  function stubPagedServer(total: number, options: { reportHasMore?: boolean } = {}) {
    const requests: Array<{ limit: number; offset: number }> = [];
    vi.stubGlobal('fetch', async (input: string) => {
      const url = new URL(String(input));
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '30', 10) || 30, 1), 100);
      const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0);
      requests.push({ limit, offset });
      const items = Array.from({ length: Math.max(Math.min(offset + limit, total) - offset, 0) }, (_unused, index) => ({
        captureId: `synthetic-${String(offset + index + 1).padStart(4, '0')}`,
      }));
      const body: Record<string, unknown> = { ok: true, seeAll: true, items, offset };
      if (options.reportHasMore !== false) body.hasMore = offset + items.length < total;
      return { ok: true, json: async () => body };
    });
    return requests;
  }

  it('asks the server for a page offset so older captures are reachable at all', () => {
    const url = new URL(buildListUrl(pagedConfig, 30, 1234, 60));
    expect(url.searchParams.get('limit')).toBe('30');
    expect(url.searchParams.get('offset'), 'offset 없이는 31번째 이후를 요청할 방법이 없다').toBe('60');
  });

  it('keeps offset absent-safe for the first page', () => {
    expect(new URL(buildListUrl(pagedConfig, 30, 1234)).searchParams.get('offset')).toBe('0');
  });

  it('accumulates pages until it has as many captures as the screen asked for', async () => {
    const requests = stubPagedServer(150);
    const response = await listBriefsUpTo(pagedConfig, 120);
    expect(response.ok).toBe(true);
    expect(response.items?.length).toBe(120);
    expect(response.items?.[100]?.captureId).toBe('synthetic-0101');
    expect(response.hasMore).toBe(true);
    expect(requests).toEqual([{ limit: 100, offset: 0 }, { limit: 20, offset: 100 }]);
  });

  it('stops and reports the end of the list instead of looping forever', async () => {
    stubPagedServer(150);
    const response = await listBriefsUpTo(pagedConfig, 400);
    expect(response.items?.length).toBe(150);
    expect(response.items?.[149]?.captureId).toBe('synthetic-0150');
    expect(response.hasMore, '끝까지 읽었으면 더 보기 버튼이 남으면 안 된다').toBe(false);
  });

  it('never reports the same capture twice when pages overlap', async () => {
    stubPagedServer(150);
    const response = await listBriefsUpTo(pagedConfig, 150);
    const ids = (response.items ?? []).map((item) => item.captureId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('passes a failed page straight through rather than pretending the list is short', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ ok: false, error: 'invalid_token' }) }));
    const response = await listBriefsUpTo(pagedConfig, 120);
    expect(response.ok).toBe(false);
    expect(response.error).toBe('invalid_token');
  });
});

// FI-015/FI-016 되돌림 방지: 재전송 판단은 "서버에 있다/없다"를 단정한다.
// 한 페이지만 읽으면 오래된 captureId가 빠지고, 이미 처리된 캡처를 다시 올리게 된다.
describe('reconcile reads the whole server list before deciding a capture is missing', () => {
  const pagedConfig: RuntimeConfig = { apiUrl: 'https://api.example.test/exec', token: 'fixture-token', capturer: 'Fixture Owner' };

  afterEach(() => vi.unstubAllGlobals());

  function stubPagedServer(total: number, options: { reportHasMore?: boolean } = {}) {
    const requests: Array<{ limit: number; offset: number }> = [];
    vi.stubGlobal('fetch', async (input: string) => {
      const url = new URL(String(input));
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '30', 10) || 30, 1), 100);
      const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0);
      requests.push({ limit, offset });
      const items = Array.from({ length: Math.max(Math.min(offset + limit, total) - offset, 0) }, (_unused, index) => ({
        captureId: `synthetic-${String(offset + index + 1).padStart(4, '0')}`,
      }));
      const body: Record<string, unknown> = { ok: true, seeAll: true, items, offset };
      if (options.reportHasMore !== false) body.hasMore = offset + items.length < total;
      return { ok: true, json: async () => body };
    });
    return requests;
  }

  it('still knows about a capture that sits past the first server page', async () => {
    stubPagedServer(150);
    const ids = await fetchServerCaptureIds(pagedConfig);
    expect(ids, '조회에 성공했으므로 판정을 포기하면 안 된다').not.toBeNull();
    expect(ids?.has('synthetic-0101'), '101번째 캡처가 빠지면 이미 접수된 명함을 다시 올린다').toBe(true);
    expect(ids?.has('synthetic-0150'), '가장 오래된 캡처가 빠지면 이미 접수된 명함을 다시 올린다').toBe(true);
    expect(ids?.size).toBe(150);
  });

  it('answers 모른다 rather than 없다 when the list is longer than it will read', async () => {
    stubPagedServer(5_000);
    expect(
      await fetchServerCaptureIds(pagedConfig, 300),
      '상한에 걸렸으면 부분 집합이 아니라 null(모른다)이어야 한다 — 부분 집합은 "서버에 없다"로 오독된다',
    ).toBeNull();
  });

  it('answers 모른다 when an older server cannot say whether more pages exist', async () => {
    stubPagedServer(150, { reportHasMore: false });
    expect(
      await fetchServerCaptureIds(pagedConfig),
      'hasMore를 모르는 서버가 꽉 찬 페이지를 주면 더 있는지 알 수 없다',
    ).toBeNull();
  });

  it('accepts a short final page from an older server as the whole list', async () => {
    stubPagedServer(42, { reportHasMore: false });
    expect(await fetchServerCaptureIds(pagedConfig)).toEqual(
      new Set(Array.from({ length: 42 }, (_unused, index) => `synthetic-${String(index + 1).padStart(4, '0')}`)),
    );
  });
});
