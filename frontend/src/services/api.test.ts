import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureQueueItem, ResearchMode, RuntimeConfig } from '../contracts/capture';
import { addPersonNote, buildDocumentUrl, buildListUrl, buildSearchUrl, fetchServerCaptureIds, isTerminalStatus, listBriefsUpTo, manualIntakeUnsupported, MANUAL_INTAKE_NOT_DEPLOYED, requestCorrection, submitResearchInstruction, toManualPersonPayload, toUploadPayload, uploadCapture, UploadError } from './api';
import type { ResearchSubmission } from './research';
import { clearResearchRouteLog, readResearchRouteLog } from './research-telemetry';

const config: RuntimeConfig = {
  apiUrl: 'https://script.google.com/macros/s/example/exec',
  token: 'fixture-token',
  capturer: 'Fixture Owner',
};

/** 조사 요청 봉투 하나. 값이 고정이라 나가는 본문을 글자 단위로 잠글 수 있다. */
function researchSubmission(mode: ResearchMode): ResearchSubmission {
  return {
    raw: 'research',
    channel: 'owner_ui',
    policyVersion: 'public-research-v1',
    riskFlags: [],
    depth: mode === 'deep_evidence_graph' ? 'deep' : mode,
    mode,
    purposes: mode === 'deep_evidence_graph' ? ['meeting_preparation'] : [],
    focusIds: ['career'],
    requestId: 'rr-fixture01',
  };
}

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
    await submitResearchInstruction(config, { captureId: 'CAP-1' }, researchSubmission('standard'));
    await requestCorrection(config, 'CAP-1', ' correction ');
    expect(fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)))).toEqual([
      { action: 'addnote', person: 'PER-000001', text: 'note', k: 'fixture-token' },
      {
        action: 'researchinstruction',
        captureId: 'CAP-1',
        // 옛 서버를 위한 자유 입력 자리. 고른 항목을 여기 다시 섞지 않는다.
        text: 'research',
        // 계약 §Request Contract의 다섯 칸이 구조화된 봉투로 나간다.
        instruction: { raw: 'research', mode: 'standard', purposes: [], focusIds: ['career'], requestId: 'rr-fixture01' },
        k: 'fixture-token',
      },
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

/* 직접 입력 (ISS-000231 / DEC-000103).
   전송로는 사진과 **한 곳**을 지난다 — 나누면 잠금·대조·재시도·실패 분류가 두 벌이 된다. */
describe('manual person intake shares one send path with photo captures', () => {
  const manualConfig: RuntimeConfig = { apiUrl: 'https://api.example.test/exec', token: 'fixture-token', capturer: 'Fixture Owner' };
  const manualItem: CaptureQueueItem = {
    captureId: '20260804-010203-abcd',
    capturedAt: '2026-08-04T01:02:03.000Z',
    intake: 'manual_person',
    manualText: '가온테크 김미래 CTO, mirae.kim@gaontech-fake.co.kr',
    identityEvidence: { emails: ['mirae.kim@gaontech-fake.co.kr'], phones: [], phoneDisplays: [] },
    event: '전시회·박람회',
    note: '나와의 관계: 오늘 처음',
    relSelf: '오늘 처음',
    relKairen: '',
    memo: '',
    images: [],
    quickName: null,
    researchInstruction: null,
    state: 'queued',
    tries: 0,
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('serializes the manual action without the capturer or client-derived evidence', () => {
    // capturer는 서버가 토큰에서 정한다. 근거는 서버가 원문에서 다시 뽑는다 — 보내면 위조 표면이 된다.
    expect(toManualPersonPayload(manualItem, manualConfig)).toEqual({
      action: 'manualperson',
      k: 'fixture-token',
      captureId: '20260804-010203-abcd',
      capturedAt: '2026-08-04T01:02:03.000Z',
      event: '전시회·박람회',
      note: '나와의 관계: 오늘 처음',
      text: '가온테크 김미래 CTO, mirae.kim@gaontech-fake.co.kr',
    });
  });

  it('sends the manual payload through uploadCapture, not a second sender', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetchMock);
    await uploadCapture(manualConfig, manualItem);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).action).toBe('manualperson');
  });

  it('keeps the same captureId across retries so the server can dedupe', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetchMock);
    await uploadCapture(manualConfig, manualItem);
    await uploadCapture(manualConfig, { ...manualItem, tries: 1 });
    const ids = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).captureId);
    expect(new Set(ids).size, '재시도마다 id가 바뀌면 서버가 job을 하나로 접을 수 없다').toBe(1);
  });

  it('turns an older backend refusal into an actionable code instead of a silent success', async () => {
    // Code.gs는 사람이 따로 재배포한다. 옛 서버는 action을 모르고 업로드 경로로 떨어져 no_images로 거절한다.
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: false, error: 'no_images' }) });
    vi.stubGlobal('fetch', fetchMock);
    await expect(uploadCapture(manualConfig, manualItem)).rejects.toMatchObject({
      kind: 'rejected',
      message: MANUAL_INTAKE_NOT_DEPLOYED,
    });
  });

  it('does not relabel an unrelated refusal as a deployment problem', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: false, error: 'daily_limit' }) });
    vi.stubGlobal('fetch', fetchMock);
    await expect(uploadCapture(manualConfig, manualItem)).rejects.toMatchObject({ kind: 'rejected', message: 'daily_limit' });
  });

  it('keeps photo captures on the photo payload — no_images stays a plain refusal there', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: false, error: 'no_images' }) });
    vi.stubGlobal('fetch', fetchMock);
    const photo: CaptureQueueItem = { ...manualItem, intake: undefined, manualText: undefined, images: [] };
    await expect(uploadCapture(manualConfig, photo)).rejects.toMatchObject({ kind: 'rejected', message: 'no_images' });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).action).toBeUndefined();
  });

  it('recognizes exactly the refusals that mean the backend has not been redeployed', () => {
    expect(manualIntakeUnsupported('no_images')).toBe(true);
    expect(manualIntakeUnsupported('unknown_action')).toBe(true);
    expect(manualIntakeUnsupported('daily_limit')).toBe(false);
    expect(manualIntakeUnsupported(undefined)).toBe(false);
  });
});

// ── GAS 재배포 전의 `빠른 조사` (TSK-000542) ──
//
// `Code.gs`는 사람이 따로 재배포하므로 **앱은 아는데 서버는 모르는 구간**이 반드시 생긴다.
// 그 구간의 계약은 셋이다: (1) 사용자의 조사는 된다, (2) 내려간 사실은 개발자 채널에만 남는다,
// (3) **다른 이유로 난 실패를 이 길로 감추지 않는다.**
describe('quick mode fallback — 배포 창을 건너는 한 번의 되돌림', () => {
  const target = { person: 'PER-000001' };
  const quickCapture: CaptureQueueItem = {
    captureId: '20260804-090000-quick',
    capturedAt: '2026-08-04T00:00:00.000Z',
    images: [{ name: 'front.jpg', mime: 'image/jpeg', dataB64: 'front-data' }],
    state: 'queued',
    tries: 0,
    researchInstruction: researchSubmission('quick'),
  };

  /** 옛 서버: `quick`은 모르고 `standard`는 받는다. 그 밖의 모든 검사는 두 mode에서 같다. */
  function oldServer() {
    return vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(String(init.body));
      const mode = body.instruction?.mode ?? body.researchInstruction?.mode;
      return mode === 'quick'
        ? { ok: true, json: async () => ({ ok: false, error: 'bad_research_request' }) }
        : { ok: true, json: async () => ({ ok: true, receiptId: 'research-0001' }) };
    });
  }

  beforeEach(() => { clearResearchRouteLog(); });
  afterEach(() => vi.unstubAllGlobals());

  it('인물 시트: 옛 서버가 거절하면 같은 요청을 표준으로 한 번 더 보내 접수시킨다', async () => {
    const fetchMock = oldServer();
    vi.stubGlobal('fetch', fetchMock);
    const response = await submitResearchInstruction(config, target, researchSubmission('quick'));
    expect(response).toMatchObject({ ok: true, receiptId: 'research-0001' });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [first, second] = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    expect(first.instruction.mode).toBe('quick');
    expect(second.instruction.mode).toBe('standard');
    // 같은 요청이므로 멱등 키를 포함한 나머지 칸은 한 글자도 달라지지 않는다.
    expect({ ...second.instruction, mode: 'quick' }).toEqual(first.instruction);
  });

  it('내려간 사실은 개발자 채널에만 남는다 — 사용자 응답에는 아무 표식도 없다', async () => {
    vi.stubGlobal('fetch', oldServer());
    const response = await submitResearchInstruction(config, target, researchSubmission('quick'));
    expect(Object.keys(response).sort()).toEqual(['ok', 'receiptId']);

    const [receipt] = readResearchRouteLog();
    expect(receipt).toMatchObject({ event: 'degraded', degraded: true, reason: 'quick_mode_unsupported', requestedDepth: 'quick' });
    // 요청의 멱등 키로 기록돼 있어야 나중에 이 한 건을 이어 볼 수 있다.
    expect(receipt.requestId).toBe('rr-fixture01');
  });

  it('촬영 업로드: 옛 서버가 거절해도 사진까지 함께 잃지 않는다', async () => {
    const fetchMock = oldServer();
    vi.stubGlobal('fetch', fetchMock);
    await expect(uploadCapture(config, quickCapture)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [first, second] = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    expect([first.researchInstruction.mode, second.researchInstruction.mode]).toEqual(['quick', 'standard']);
    // 사진과 나머지 payload는 두 번 다 같다 — 되돌림은 mode 한 칸만 건드린다.
    expect({ ...second, researchInstruction: first.researchInstruction }).toEqual(first);
  });

  it('저장된 요청을 몰래 고치지 않는다 — 재배포되면 다음 전송이 저절로 `quick`으로 돌아간다', async () => {
    vi.stubGlobal('fetch', oldServer());
    await uploadCapture(config, quickCapture);
    expect(quickCapture.researchInstruction?.mode).toBe('quick');
  });

  // ── 여기부터가 "가리지 않는다"의 증거 ──

  it('mode 말고 다른 이유로 난 `bad_research_request`는 두 번째 시도도 똑같이 실패한다', async () => {
    // 서버의 나머지 검사는 quick·standard에서 동일하므로 mode를 바꿔도 결과가 바뀌지 않는다.
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: false, error: 'bad_research_request' }) });
    vi.stubGlobal('fetch', fetchMock);
    const response = await submitResearchInstruction(config, target, researchSubmission('quick'));
    expect(response).toMatchObject({ ok: false, error: 'bad_research_request' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 성공으로 위장하지 않았고, 개발자 채널에는 **실패**로 남는다.
    expect(readResearchRouteLog()[0]).toMatchObject({ event: 'failed', reason: 'bad_research_request' });
  });

  it.each(['daily_limit', 'owner_only', 'feature_disabled', 'target_mismatch', 'not_configured'])(
    '%s는 되돌리지 않는다 — 한 번만 보내고 그대로 실패한다',
    async (error) => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: false, error }) });
      vi.stubGlobal('fetch', fetchMock);
      await expect(submitResearchInstruction(config, target, researchSubmission('quick'))).resolves.toMatchObject({ ok: false, error });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(readResearchRouteLog()).toHaveLength(0);
    },
  );

  it.each(['standard', 'deep_evidence_graph'] as const)('%s 요청은 절대 되돌리지 않는다 — 깊이를 몰래 낮추지 않는다', async (mode) => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: false, error: 'bad_research_request' }) });
    vi.stubGlobal('fetch', fetchMock);
    await submitResearchInstruction(config, target, researchSubmission(mode));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('조사 요청이 없는 업로드는 이 길을 지나지 않는다', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: false, error: 'bad_research_request' }) });
    vi.stubGlobal('fetch', fetchMock);
    await expect(uploadCapture(config, { ...quickCapture, researchInstruction: null }))
      .rejects.toMatchObject({ kind: 'rejected', message: 'bad_research_request' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('응답을 못 받은 첫 시도는 다시 보내지 않는다 — 접수 여부를 모르는 상태에서 재전송하지 않는다', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(uploadCapture(config, quickCapture)).rejects.toMatchObject({ kind: 'ambiguous' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
