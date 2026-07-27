import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CaptureQueueItem } from '../contracts/capture';
import { toUploadPayload } from './api';
import { flushQueue, putQueueItem } from './queue';
import {
  clearTrace,
  correlationIdOf,
  createCorrelationId,
  readTrace,
  REDACTED,
  redactReason,
  traceCapture,
  TRACE_LIMIT,
  traceOf,
} from './trace';

Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: indexedDB });
Object.defineProperty(globalThis, 'IDBKeyRange', { configurable: true, value: IDBKeyRange });

/** 명백히 가짜인 값만 쓴다 — 실제 링크 코드·실명함은 어떤 형태로도 넣지 않는다. */
const FAKE_TOKEN = 'AKfycbFAKEFAKEFAKE0000notarealtoken';
const FAKE_API = `https://script.google.com/macros/s/AAA/exec?k=${FAKE_TOKEN}`;

/** 자유 입력 칸을 전부 PII로 채운 합성 캡처. 어느 한 글자도 로그에 나오면 안 된다. */
const PII_VALUES = [
  '김민서',
  '민서 김 상무',
  'minseo.kim@example.com',
  '010-1234-5678',
  '2026 로보월드 부스 A-12',
  '공장장 직속, 다음 주 자료 보내기',
  '예전 동료',
  '잠재 고객',
  '공개 이력과 최근 발표 확인해 줘',
  FAKE_TOKEN,
];

function piiItem(captureId = '20260727-090000-a'): CaptureQueueItem {
  return {
    captureId,
    capturedAt: '2026-07-27T09:00:00.000Z',
    correlationId: 'cc-fixture0001',
    event: '2026 로보월드 부스 A-12',
    relSelf: '예전 동료',
    relKairen: '잠재 고객',
    memo: '공장장 직속, 다음 주 자료 보내기',
    note: '나와의 관계: 예전 동료\nKairen과의 관계: 잠재 고객\n메모: 공장장 직속, 다음 주 자료 보내기',
    disp: '공장장 직속, 다음 주 자료 보내기',
    images: [{ name: 'front.jpg', mime: 'image/jpeg', dataB64: 'front-bytes' }],
    quickName: {
      name: '김민서', source: 'device_text_detector', confidence: 82, confirmed: true,
      recognizedAt: '2026-07-27T09:00:00.000Z',
    },
    researchInstruction: {
      raw: '공개 이력과 최근 발표 확인해 줘', channel: 'owner_ui', policyVersion: 'public-research-v1', riskFlags: [],
    },
    state: 'queued',
    tries: 0,
  };
}

function deleteDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('cardcapture');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('delete_failed'));
  });
}

beforeEach(async () => {
  await deleteDatabase();
  clearTrace();
});

// 진단 로그의 유일한 자유 텍스트 자리가 `reason`이다. 여기가 뚫리면 나머지 방어는 의미가 없다.
// 계약은 거부 목록이 아니라 **허용 형태**다 — 불투명한 오류 코드 모양만 통과시키고 나머지는 전부 버린다.
describe('redactReason keeps opaque codes and drops everything else (FI-021)', () => {
  it('keeps the error codes this app and its server actually emit', () => {
    for (const code of [
      'fetch_failed', 'http_503', 'unreadable_response', 'missing_api', 'network_failed', 'upload_failed',
      'invalid_token', 'daily_limit', 'no_images', 'bad_image_data', 'image_too_large', 'duplicate_image_slot',
      'person_folder_not_found', 'not_your_capture', 'vault_walk_failed', 'queue_write_quota',
    ]) {
      expect(redactReason(code)).toBe(code);
    }
  });

  it('normalizes the runtime message shape instead of dropping it', () => {
    // undici가 실제로 던지는 문구 (PROBE C에서 확인).
    expect(redactReason('fetch failed')).toBe('fetch_failed');
    expect(redactReason('  Fetch Failed  ')).toBe('fetch_failed');
  });

  it('drops a URL that carries the personal link code', () => {
    // Node 22/24 undici가 실제로 던지는 문구 (PROBE A에서 확인) — 링크 코드가 통째로 들어 있다.
    const leak = `Failed to parse URL from ${FAKE_API}`;
    expect(redactReason(leak)).toBe(REDACTED);
    expect(redactReason(leak)).not.toContain(FAKE_TOKEN);
    expect(redactReason(FAKE_API)).toBe(REDACTED);
    expect(redactReason(FAKE_TOKEN)).toBe(REDACTED);
  });

  it('drops server-controlled text carrying a name, phone and email', () => {
    // PROBE D에서 실제 HTTP 서버로 재현한 값이 그대로 err에 저장된다.
    expect(redactReason('김민서 010-1234-5678 hong@example.com')).toBe(REDACTED);
    for (const value of PII_VALUES) expect(redactReason(value)).toBe(REDACTED);
  });

  it('drops prose, notes and anything non-ASCII even when it has no punctuation', () => {
    expect(redactReason('자료 보내기')).toBe(REDACTED);
    expect(redactReason('send the deck to the plant manager tomorrow')).toBe(REDACTED);
    expect(redactReason('a'.repeat(64))).toBe(REDACTED);
  });

  it('treats a missing reason as absent rather than as a code', () => {
    expect(redactReason(undefined)).toBeUndefined();
    expect(redactReason('')).toBeUndefined();
    expect(redactReason('   ')).toBeUndefined();
  });
});

// correlationId는 **클라이언트 진단 전용**이다. 서버(Code.gs)는 이 값을 저장하지 않는다.
describe('correlationId is stable and never leaves the device (FI-021)', () => {
  it('mints a value that carries no capture content', () => {
    const id = createCorrelationId(() => 0.5);
    expect(id).toMatch(/^cc-[0-9a-z]+$/);
    expect(createCorrelationId(() => 0.5)).toBe(id);
  });

  it('derives a stable id for a legacy row that never stored one', () => {
    const legacy = { ...piiItem(), correlationId: undefined };
    const first = correlationIdOf(legacy);
    expect(first).toMatch(/^cc-[0-9a-z]+$/);
    expect(correlationIdOf(legacy)).toBe(first);
    // 다른 캡처는 다른 값을 받아야 한다 — 같으면 여정이 뒤섞인다.
    expect(correlationIdOf({ ...legacy, captureId: '20260727-090001-b' })).not.toBe(first);
  });

  it('keeps the stored id instead of minting a new one', () => {
    expect(correlationIdOf(piiItem())).toBe('cc-fixture0001');
  });

  it('is not added to the upload payload — the server does not store it', () => {
    const payload = toUploadPayload(piiItem(), { apiUrl: FAKE_API, token: FAKE_TOKEN, capturer: 'tester' });
    expect(payload).not.toHaveProperty('correlationId');
    expect(Object.keys(payload).sort()).toEqual([
      'capturedAt', 'captureId', 'capturer', 'event', 'images', 'k', 'note', 'quickName', 'researchInstruction',
    ].sort());
  });
});

describe('the diagnostic log is bounded and drops the oldest first (FI-021)', () => {
  it('never grows past the limit', () => {
    for (let index = 0; index < TRACE_LIMIT + 25; index += 1) {
      traceCapture({ ...piiItem(`20260727-0900${String(index).padStart(2, '0')}-x`), correlationId: `cc-${index}` }, 'created');
    }
    const records = readTrace();
    expect(records).toHaveLength(TRACE_LIMIT);
    expect(records[0].correlationId).toBe('cc-25');
    expect(records[records.length - 1].correlationId).toBe(`cc-${TRACE_LIMIT + 24}`);
  });

  it('hands back a copy so a caller cannot corrupt the log', () => {
    traceCapture(piiItem(), 'created');
    readTrace().push({
      ts: 'x', correlationId: 'x', captureId: 'x', event: 'created', tries: 0,
    });
    expect(readTrace()).toHaveLength(1);
  });
});

describe('a logged record only ever carries allowlisted fields (FI-021)', () => {
  it('stores no free-text capture field, not even the meeting label', () => {
    const record = traceCapture(piiItem(), 'created');
    expect(Object.keys(record).sort()).toEqual(['captureId', 'correlationId', 'event', 'ts', 'tries'].sort());
    // `event`는 여정 이름이지 캡처의 만남 라벨이 아니다 — 이름이 같아서 잘못 배선하기 쉽다.
    expect(record.event).toBe('created');
    const serialized = JSON.stringify(readTrace());
    for (const value of PII_VALUES) expect(serialized).not.toContain(value);
  });

  it('redacts the reason it is handed instead of trusting the caller', () => {
    const record = traceCapture(piiItem(), 'failed', {
      errKind: 'rejected',
      reason: `Failed to parse URL from ${FAKE_API}`,
    });
    expect(record.reason).toBe(REDACTED);
    expect(JSON.stringify(readTrace())).not.toContain(FAKE_TOKEN);
  });
});

describe('traceOf reconstructs one capture journey without PII (FI-021)', () => {
  it('follows create -> attempt -> failed -> deferred -> reconciled through the real queue', async () => {
    const item = piiItem();
    traceCapture(item, 'created');
    await putQueueItem(item);

    // 1) 서버가 이름·전화·이메일이 섞인 오류 텍스트로 거절한다 (PROBE D에서 실제 서버로 재현한 모양).
    await flushQueue(async () => {
      throw Object.assign(new Error('김민서 010-1234-5678 hong@example.com'), { kind: 'rejected' });
    });
    // 2) 링크 코드가 통째로 들어간 런타임 오류로 다시 실패한다 (PROBE A에서 확인한 모양).
    await flushQueue(async () => {
      throw Object.assign(new Error(`Failed to parse URL from ${FAKE_API}`), { kind: 'ambiguous' });
    });
    // 3) 서버 목록을 못 읽어 판정을 미룬다.
    await flushQueue(async () => { throw new Error('unreachable'); }, async () => null);
    // 4) 서버가 이미 갖고 있어 재전송 없이 접수 완료로 판정한다.
    await flushQueue(async () => { throw new Error('unreachable'); }, async () => new Set([item.captureId]));

    const journey = traceOf('cc-fixture0001');
    expect(journey.map((record) => record.event)).toEqual([
      'created', 'attempt', 'failed', 'attempt', 'failed', 'deferred', 'reconciled',
    ]);
    expect(journey.every((record) => record.captureId === item.captureId)).toBe(true);
    // 실패 분류는 남고, 원문은 남지 않는다.
    expect(journey.filter((record) => record.event === 'failed').map((record) => record.errKind))
      .toEqual(['rejected', 'ambiguous']);
    expect(journey.filter((record) => record.event === 'failed').map((record) => record.reason))
      .toEqual([REDACTED, REDACTED]);
    // 재시도 횟수는 여정에서 읽을 수 있어야 한다.
    expect(journey.filter((record) => record.event === 'failed').map((record) => record.tries)).toEqual([1, 2]);

    const serialized = JSON.stringify(readTrace());
    for (const value of PII_VALUES) expect(serialized).not.toContain(value);
    expect(serialized).not.toContain('hong@example.com');
    expect(serialized).not.toContain('front-bytes');
  });

  it('keeps two captures apart and returns them in order', async () => {
    const first = { ...piiItem('20260727-090000-a'), correlationId: 'cc-first' };
    const second = { ...piiItem('20260727-090001-b'), correlationId: 'cc-second' };
    await putQueueItem(first);
    await putQueueItem(second);
    traceCapture(first, 'created');
    traceCapture(second, 'created');
    await flushQueue(async (value) => { if (value.captureId === second.captureId) throw new Error('http_503'); });

    expect(traceOf('cc-first').map((record) => record.event)).toEqual(['created', 'attempt', 'sent']);
    expect(traceOf('cc-second').map((record) => record.event)).toEqual(['created', 'attempt', 'failed']);
    expect(traceOf('cc-second').at(-1)?.reason).toBe('http_503');
    expect(traceOf('cc-missing')).toEqual([]);
  });

  it('is a pure read over the records it is given', () => {
    const records = [
      { ts: '2026-07-27T09:00:00.000Z', correlationId: 'cc-a', captureId: 'x', event: 'created' as const, tries: 0 },
      { ts: '2026-07-27T09:00:01.000Z', correlationId: 'cc-b', captureId: 'y', event: 'created' as const, tries: 0 },
    ];
    expect(traceOf('cc-a', records)).toEqual([records[0]]);
    expect(records).toHaveLength(2);
    expect(readTrace()).toHaveLength(0);
  });
});
