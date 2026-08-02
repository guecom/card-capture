import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureQueueItem } from '../contracts/capture';
import {
  deleteQueueItem,
  flushQueue,
  inspectQueueItems,
  pruneSentQueue,
  putQueueItem,
  putQueueItemVerified,
  QueueWriteError,
  readQueue,
  readQueueChecked,
  takeBackQueueItem,
  undoRefusalOf,
  withQueueLock,
} from './queue';
import { FakeStorage } from './test-storage';
import { clearTrace, REDACTED, traceOf } from './trace';

Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: indexedDB });
Object.defineProperty(globalThis, 'IDBKeyRange', { configurable: true, value: IDBKeyRange });

function item(captureId: string, state: CaptureQueueItem['state'] = 'queued'): CaptureQueueItem {
  return {
    captureId,
    capturedAt: '2026-07-25T12:00:00.000Z',
    images: [{ name: 'front.jpg', mime: 'image/jpeg', dataB64: `${captureId}-image` }],
    note: '',
    event: '',
    state,
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
});

describe('offline queue contract', () => {
  it('persists captures across database reopen without changing the legacy store', async () => {
    await putQueueItem(item('20260725-120001-a'));
    await putQueueItem(item('20260725-120002-b'));

    const reopened = await readQueue();
    expect(reopened.map((value) => value.captureId).sort()).toEqual([
      '20260725-120001-a',
      '20260725-120002-b',
    ]);
  });

  it('sends pending captures oldest first and never resends terminal local items', async () => {
    await putQueueItem(item('20260725-120003-c'));
    await putQueueItem(item('20260725-120001-a', 'sent'));
    await putQueueItem(item('20260725-120002-b', 'failed'));
    const order: string[] = [];
    const sender = vi.fn(async (value: CaptureQueueItem) => { order.push(value.captureId); });

    const result = await flushQueue(sender);
    expect(result).toEqual({ attempted: 2, sent: 2, failed: 0, quarantined: 0, reconciled: 0 });
    expect(order).toEqual(['20260725-120002-b', '20260725-120003-c']);

    const second = await flushQueue(sender);
    expect(second).toEqual({ attempted: 0, sent: 0, failed: 0, quarantined: 0, reconciled: 0 });
    expect(sender).toHaveBeenCalledTimes(2);
  });

  it('keeps failed data, increments tries, and succeeds on a later retry', async () => {
    await putQueueItem(item('20260725-120004-d'));
    const firstSender = vi.fn(async () => { throw new Error('offline'); });

    expect(await flushQueue(firstSender)).toEqual({ attempted: 1, sent: 0, failed: 1, quarantined: 0, reconciled: 0 });
    const [failed] = await readQueue();
    expect(failed).toMatchObject({ state: 'failed', tries: 1, err: 'offline' });
    expect(failed.images[0].dataB64).toBe('20260725-120004-d-image');

    const retrySender = vi.fn(async () => undefined);
    expect(await flushQueue(retrySender)).toEqual({ attempted: 1, sent: 1, failed: 0, quarantined: 0, reconciled: 0 });
    const [sent] = await readQueue();
    expect(sent.state).toBe('sent');
    expect(sent.tries).toBe(1);
    expect(sent.err).toBeUndefined();
  });

  it('keeps an initial capture research requestId through an ambiguous upload retry', async () => {
    const capture = {
      ...item('20260802-120004-research'),
      researchInstruction: { raw: '공개 결과물 확인', mode: 'standard' as const, requestId: 'request-00000011' },
    };
    await putQueueItem(capture);
    const sentRequestIds: Array<string | undefined> = [];

    await flushQueue(async (queued) => {
      sentRequestIds.push(queued.researchInstruction?.requestId);
      throw Object.assign(new Error('network_failed'), { kind: 'ambiguous' });
    });
    await flushQueue(async (queued) => {
      sentRequestIds.push(queued.researchInstruction?.requestId);
    }, async () => new Set());

    expect(sentRequestIds).toEqual(['request-00000011', 'request-00000011']);
    expect((await readQueue())[0].researchInstruction?.requestId).toBe('request-00000011');
  });

  it('stamps the success receipt time so cleanup can only run after a real send', async () => {
    await putQueueItem(item('20260725-120005-e'));
    await flushQueue(async () => undefined);
    const [sent] = await readQueue();
    expect(Number.isNaN(Date.parse(String(sent.sentAt)))).toBe(false);
  });

  // ISS-000102: 전송이 끝난 명함 원본이 기기에 무기한 남지 않는다. 대기·실패 항목은 복구를 위해 남긴다.
  it('clears sent originals once the recovery grace period has passed, and never touches unsent ones', async () => {
    const sentAt = Date.parse('2026-07-25T12:00:00.000Z');
    await putQueueItem({ ...item('20260725-000001-old', 'sent'), sentAt: new Date(sentAt).toISOString() });
    await putQueueItem({ ...item('20260725-000002-fresh', 'sent'), sentAt: new Date(sentAt + 9 * 60_000).toISOString() });
    await putQueueItem(item('20260725-000003-queued'));
    await putQueueItem(item('20260725-000004-failed', 'failed'));

    expect(await pruneSentQueue(sentAt + 10 * 60_000)).toBe(1);
    const items = (await readQueue()).sort((a, b) => a.captureId.localeCompare(b.captureId));
    expect(items[0].images[0]).not.toHaveProperty('dataB64');
    expect(items[1].images[0]).toHaveProperty('dataB64');
    expect(items[2].images[0]).toHaveProperty('dataB64');
    expect(items[3].images[0]).toHaveProperty('dataB64');

    // 유예가 지나면 남은 전송 완료 원본도 정리되고, 대기·실패 항목은 그대로다.
    expect(await pruneSentQueue(sentAt + 60 * 60_000)).toBe(1);
    const later = (await readQueue()).sort((a, b) => a.captureId.localeCompare(b.captureId));
    expect(later[1].images[0]).not.toHaveProperty('dataB64');
    expect(later[2].images[0]).toHaveProperty('dataB64');
    expect(later[3].images[0]).toHaveProperty('dataB64');
  });
});

// ── 저장 실패를 구분되는 사실로 만든다 (FI-032 / FI-052) ──

/** 저장소가 특정 이유로 실패하는 상황을 재현하는 최소 대역. */
function failingIndexedDb(errorName: string) {
  const error = Object.assign(new Error('stub'), { name: errorName });
  return {
    open: () => {
      const request: Record<string, unknown> = {
        result: {
          objectStoreNames: { contains: () => true },
          transaction: () => {
            const transaction: Record<string, unknown> = { error, objectStore: () => ({ put: () => undefined }) };
            setTimeout(() => (transaction.onerror as (() => void) | undefined)?.(), 0);
            return transaction;
          },
          close: () => undefined,
        },
      };
      setTimeout(() => (request.onsuccess as (() => void) | undefined)?.(), 0);
      return request;
    },
  };
}

/** 쓰기는 성공했다고 하면서 실제로는 아무것도 남기지 않는 저장소. */
function forgetfulIndexedDb() {
  return {
    open: () => {
      const request: Record<string, unknown> = {
        result: {
          objectStoreNames: { contains: () => true },
          transaction: () => {
            const transaction: Record<string, unknown> = {
              objectStore: () => ({
                put: () => undefined,
                getAll: () => {
                  const getAll: Record<string, unknown> = { result: [] };
                  setTimeout(() => (getAll.onsuccess as (() => void) | undefined)?.(), 0);
                  return getAll;
                },
              }),
            };
            setTimeout(() => (transaction.oncomplete as (() => void) | undefined)?.(), 0);
            return transaction;
          },
          close: () => undefined,
        },
      };
      setTimeout(() => (request.onsuccess as (() => void) | undefined)?.(), 0);
      return request;
    },
  };
}

describe('local-safe truth (FI-032 / FI-052)', () => {
  afterEach(() => {
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: indexedDB });
  });

  it('confirms the capture by reading it back, not by trusting the write', async () => {
    const stored = await putQueueItemVerified(item('20260727-120000-ok'));
    expect(stored.images[0].dataB64).toBe('20260727-120000-ok-image');
  });

  it('separates a full device from a generic failure so the advice can differ', async () => {
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: failingIndexedDb('QuotaExceededError') });
    await expect(putQueueItemVerified(item('20260727-120001-full'))).rejects.toMatchObject({ failure: 'quota' });

    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: failingIndexedDb('SomethingElseError') });
    await expect(putQueueItemVerified(item('20260727-120002-odd'))).rejects.toMatchObject({ failure: 'unknown' });
  });

  it('refuses to call a capture safe when the read-back does not find it', async () => {
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: forgetfulIndexedDb() });
    const error = await putQueueItemVerified(item('20260727-120003-lost')).catch((value) => value);
    expect(error).toBeInstanceOf(QueueWriteError);
    expect(error.failure).toBe('verify');
  });

  it('reports an unusable storage engine instead of silently dropping the capture', async () => {
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined });
    await expect(putQueueItemVerified(item('20260727-120004-none'))).rejects.toMatchObject({ failure: 'unavailable' });
  });
});

describe('queue integrity is isolated, never repaired in place (FI-025)', () => {
  it('classifies each way a stored entry can be unusable', () => {
    const integrity = inspectQueueItems([
      item('20260727-130000-good'),
      { ...item('20260727-130001-bad'), state: 'weird' },
      { ...item('20260727-130002-bad'), images: [{ name: 'front.jpg', mime: 'image/jpeg' }] },
      { ...item('20260727-130003-bad'), images: undefined },
      { ...item('20260727-130004-bad'), captureId: '' },
      null,
      // 전송이 끝난 항목은 원본이 정리돼 사진이 비어 있는 것이 정상이다.
      { ...item('20260727-130005-sent', 'sent'), images: [{ name: 'front.jpg', mime: 'image/jpeg' }] },
    ]);

    expect(integrity.healthy.map((value) => value.captureId)).toEqual(['20260727-130000-good', '20260727-130005-sent']);
    expect(integrity.damaged).toEqual([
      { captureId: '20260727-130001-bad', damage: ['bad_state'] },
      { captureId: '20260727-130002-bad', damage: ['empty_payload'] },
      { captureId: '20260727-130003-bad', damage: ['no_images'] },
      { captureId: '(식별자 없음 #5)', damage: ['missing_id'] },
      { captureId: '(식별자 없음 #6)', damage: ['missing_id', 'bad_state', 'no_images'] },
    ]);
  });

  it('keeps sending the healthy captures while a damaged one sits beside them', async () => {
    await putQueueItem(item('20260727-140000-good'));
    await putQueueItem({ ...item('20260727-140001-bad'), images: [{ name: 'front.jpg', mime: 'image/jpeg' }] } as CaptureQueueItem);
    const sent: string[] = [];

    const result = await flushQueue(async (value) => { sent.push(value.captureId); });

    expect(result).toEqual({ attempted: 1, sent: 1, failed: 0, quarantined: 1, reconciled: 0 });
    expect(sent).toEqual(['20260727-140000-good']);

    // 손상 항목은 지워지지 않고 그대로 남아 사람이 판단할 수 있다.
    const stillStored = await readQueue();
    expect(stillStored.map((value) => value.captureId).sort()).toEqual(['20260727-140000-good', '20260727-140001-bad']);
    const checked = await readQueueChecked();
    expect(checked.damaged).toEqual([{ captureId: '20260727-140001-bad', damage: ['empty_payload'] }]);
  });
});

/** Web Locks 대역. `ifAvailable` 의미만 재현한다 — Node 버전에 따라 있고 없고가 갈리면 안 된다. */
function fakeLockManager() {
  const held = new Set<string>();
  return {
    request: async (name: string, options: { ifAvailable?: boolean }, callback: (lock: unknown) => Promise<unknown>) => {
      if (options?.ifAvailable && held.has(name)) return callback(null);
      held.add(name);
      try {
        return await callback({ name });
      } finally {
        held.delete(name);
      }
    },
  };
}

describe('an unanswered upload is reconciled, never blindly resent (FI-016)', () => {
  /** 응답을 못 받아 `ambiguous`로 실패한 항목을 만든다. */
  async function ambiguouslyFailed(captureId: string): Promise<void> {
    await putQueueItem(item(captureId));
    await flushQueue(async () => {
      throw Object.assign(new Error('network_failed'), { kind: 'ambiguous' });
    });
  }

  it('marks the last failure as ambiguous when no answer came back', async () => {
    await ambiguouslyFailed('20260727-180000-a');
    const [failed] = await readQueue();
    expect(failed).toMatchObject({ state: 'failed', errKind: 'ambiguous', tries: 1 });
  });

  it('marks an explicit server refusal as rejected so it is not reconciled', async () => {
    await putQueueItem(item('20260727-180001-b'));
    await flushQueue(async () => {
      throw Object.assign(new Error('daily_limit'), { kind: 'rejected' });
    });

    const [failed] = await readQueue();
    expect(failed.errKind).toBe('rejected');

    // 거절은 서버에 아무것도 남기지 않았으므로 대조 없이 그대로 재전송한다.
    const sent: string[] = [];
    const reconcile = vi.fn(async () => new Set<string>());
    await flushQueue(async (value) => { sent.push(value.captureId); }, reconcile);
    expect(reconcile).not.toHaveBeenCalled();
    expect(sent).toEqual(['20260727-180001-b']);
  });

  it('does not resend a capture the server already has — that would restart its processing', async () => {
    await ambiguouslyFailed('20260727-180002-c');
    const sent: string[] = [];

    const result = await flushQueue(
      async (value) => { sent.push(value.captureId); },
      async () => new Set(['20260727-180002-c']),
    );

    expect(sent).toEqual([]);
    expect(result).toMatchObject({ attempted: 0, sent: 0, failed: 0, reconciled: 1 });
    const [reconciled] = await readQueue();
    expect(reconciled.state).toBe('sent');
    expect(reconciled.errKind).toBeUndefined();
    expect(Number.isNaN(Date.parse(String(reconciled.reconciledAt)))).toBe(false);
  });

  it('resends when the server turns out not to have it', async () => {
    await ambiguouslyFailed('20260727-180003-d');
    const sent: string[] = [];

    const result = await flushQueue(
      async (value) => { sent.push(value.captureId); },
      async () => new Set(['20260727-999999-other']),
    );

    expect(sent).toEqual(['20260727-180003-d']);
    expect(result).toMatchObject({ attempted: 1, sent: 1, reconciled: 0 });
  });

  it('waits rather than guessing when the server cannot be asked', async () => {
    await ambiguouslyFailed('20260727-180004-e');
    const sent: string[] = [];

    const result = await flushQueue(async (value) => { sent.push(value.captureId); }, async () => null);

    expect(sent).toEqual([]);
    expect(result).toMatchObject({ attempted: 0, sent: 0, failed: 0, reconciled: 0 });
    // 항목은 그대로 남아 다음 연결에서 다시 판정된다.
    const [waiting] = await readQueue();
    expect(waiting).toMatchObject({ state: 'failed', errKind: 'ambiguous' });
  });

  it('asks the server only once per flush no matter how many captures are waiting', async () => {
    await ambiguouslyFailed('20260727-180005-f');
    await ambiguouslyFailed('20260727-180006-g');
    const reconcile = vi.fn(async () => new Set(['20260727-180005-f', '20260727-180006-g']));

    const result = await flushQueue(async () => undefined, reconcile);

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(result.reconciled).toBe(2);
  });
});

describe('one tab owns the send — Web Locks path (FI-053)', () => {
  beforeEach(() => vi.stubGlobal('navigator', { locks: fakeLockManager() }));
  afterEach(() => vi.unstubAllGlobals());

  it('lets a second tab find the lock held instead of sending the same capture twice', async () => {
    let release: (() => void) | null = null;
    const firstDone = withQueueLock(() => new Promise<string>((resolve) => { release = () => resolve('first'); }));
    await Promise.resolve();

    expect(await withQueueLock(async () => 'second')).toBeNull();
    release!();
    expect(await firstDone).toBe('first');

    // 첫 탭이 끝나면 잠금이 풀린다.
    expect(await withQueueLock(async () => 'third')).toBe('third');
  });

  it('releases the lock even when the send throws', async () => {
    await expect(withQueueLock(async () => { throw new Error('offline'); })).rejects.toThrow('offline');
    expect(await withQueueLock(async () => 'next')).toBe('next');
  });

  // Web Locks는 진짜 상호배제이고 storage lease는 그렇지 않다 (아래 fallback 계약 참고).
  // 순서가 뒤집혀 modern 브라우저가 조용히 약한 경로로 내려가면 안 된다.
  // 쓰기를 **기록**해서 본다 — 마지막에 남은 값만 보면 쓰고 지운 흔적을 놓친다.
  it('claims the browser lock and never writes the weaker storage lease', async () => {
    const store = new FakeStorage();
    const writes: string[] = [];
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.getItem(key),
      setItem: (key: string, value: string) => { writes.push(key); store.setItem(key, value); },
      removeItem: (key: string) => store.removeItem(key),
    });

    expect(await withQueueLock(async () => 'sent')).toBe('sent');
    expect(writes).toEqual([]);
  });
});

const FLUSH_LOCK_KEY = 'cc_queue_flush_lock';

/**
 * 두 탭이 같은 origin의 localStorage lease를 두고 겹치는 순간을 한 스레드에서 재현한다 (FI-053).
 *
 * 실제 두 탭은 별개 프로세스라 "읽고 → 판단하고 → 쓴다"가 진짜로 겹친다. 한 스레드에서는 그
 * 겹침을 명시적 스케줄로 고정할 수밖에 없다.
 *
 * - `whenLeaseWritten(step)`: 첫 탭의 lease 쓰기가 저장소에 닿는 순간 `step`(= 다른 탭)이 끼어든다.
 * - 끼어든 탭의 **첫 lease 읽기**는 그 쓰기 직전 값을 본다. 두 탭이 같은 순간에 읽어 둘 다
 *   "비어 있음"을 본 상태 — check-then-act 창 그 자체다.
 *
 * 나머지 읽기·쓰기는 전부 공유 저장소 그대로다. 스케줄만 고정하고 값은 꾸미지 않는다.
 */
function racingTabs() {
  const shared = new FakeStorage();
  let interrupt: (() => void) | null = null;
  let leaseBeforeWrite: string | null = null;
  let staleReads = 0;

  return {
    shared,
    /** 첫 탭의 lease 쓰기가 닿는 순간 다른 탭을 끼워 넣는다. 한 번만 발동한다. */
    whenLeaseWritten(step: () => void): void {
      interrupt = step;
    },
    storage: {
      getItem(key: string): string | null {
        if (key === FLUSH_LOCK_KEY && staleReads > 0) {
          staleReads -= 1;
          return leaseBeforeWrite;
        }
        return shared.getItem(key);
      },
      setItem(key: string, value: string): void {
        const before = shared.getItem(key);
        shared.setItem(key, value);
        if (key !== FLUSH_LOCK_KEY || !interrupt) return;
        const step = interrupt;
        interrupt = null;
        leaseBeforeWrite = before;
        staleReads = 1;
        step();
        staleReads = 0;
      },
      removeItem(key: string): void {
        shared.removeItem(key);
      },
    },
  };
}

describe('one tab owns the send — storage lease fallback (FI-053)', () => {
  // Web Locks가 없는 브라우저에서도 같은 계약이 성립해야 한다.
  beforeEach(() => {
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('localStorage', new FakeStorage());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('holds the lease while one tab is sending and hands it back afterwards', async () => {
    let release: (() => void) | null = null;
    const firstDone = withQueueLock(() => new Promise<string>((resolve) => { release = () => resolve('first'); }), 1_000);
    await Promise.resolve();

    expect(await withQueueLock(async () => 'second', 1_100)).toBeNull();
    release!();
    expect(await firstDone).toBe('first');
    expect(localStorage.getItem('cc_queue_flush_lock')).toBeNull();
    expect(await withQueueLock(async () => 'third', 1_200)).toBe('third');
  });

  it('reclaims a lease left behind by a tab that never came back', async () => {
    localStorage.setItem('cc_queue_flush_lock', JSON.stringify({ owner: 'crashed-tab', expiresAt: 1_000 }));
    expect(await withQueueLock(async () => 'recovered', 1_001)).toBe('recovered');
    expect(localStorage.getItem('cc_queue_flush_lock')).toBeNull();
  });

  it('still sends when the browser gives no usable storage at all', async () => {
    vi.stubGlobal('localStorage', undefined);
    expect(await withQueueLock(async () => 'sent-anyway')).toBe('sent-anyway');
  });

  // localStorage에는 compare-and-swap이 없다. 읽고 나서 쓰는 사이에 다른 탭이 끼어들면
  // 두 탭 다 "비어 있다"를 보고 둘 다 전송한다 — 같은 명함이 서버에 두 번 올라간다.
  it('lets only one tab send when both started from the same empty lease', async () => {
    const tabs = racingTabs();
    vi.stubGlobal('localStorage', tabs.storage);
    const sending: string[] = [];
    const running: Promise<unknown>[] = [];

    // 두 번째 탭은 첫 탭의 쓰기와 겹쳐 출발한다 — 자기 읽기에서는 lease가 아직 비어 있다.
    tabs.whenLeaseWritten(() => {
      running.push(withQueueLock(async () => { sending.push('second'); }, 1_000));
    });

    running.push(withQueueLock(async () => { sending.push('first'); }, 1_000));
    await Promise.all(running);

    expect(sending).toHaveLength(1);
  });

  // 좁힌 창에 남는 경우: 두 탭이 모두 전송에 들어갔다. 먼저 끝난 탭이 lease를 자기 것인 양
  // 지워 버리면 아직 보내고 있는 탭 위로 세 번째 탭이 들어온다.
  it('does not release a lease that another tab has since taken over', async () => {
    const store = new FakeStorage();
    vi.stubGlobal('localStorage', store);
    const otherTabLease = JSON.stringify({ owner: 'other-tab', expiresAt: 61_000 });

    await withQueueLock(async () => { store.setItem(FLUSH_LOCK_KEY, otherTabLease); }, 1_000);

    expect(store.getItem(FLUSH_LOCK_KEY)).toBe(otherTabLease);
  });

  it('gives up without sending when another tab overwrote the lease it just wrote', async () => {
    const tabs = racingTabs();
    vi.stubGlobal('localStorage', tabs.storage);
    const sending: string[] = [];
    const otherTabLease = JSON.stringify({ owner: 'other-tab', expiresAt: 61_000 });
    tabs.whenLeaseWritten(() => tabs.shared.setItem(FLUSH_LOCK_KEY, otherTabLease));

    expect(await withQueueLock(async () => { sending.push('me'); }, 1_000)).toBeNull();
    expect(sending).toEqual([]);
    // 진 탭이 이긴 탭의 lease를 지워 버리면 세 번째 탭까지 들어온다.
    expect(tabs.shared.getItem(FLUSH_LOCK_KEY)).toBe(otherTabLease);
  });
});

// 방금 찍은 촬영을 되돌릴 수 있는가 (FI-049). 되돌리기는 "아직 이 폰에만 있는" 촬영에만 성립한다.
describe('taking a just-taken capture back out of the queue (FI-049)', () => {
  beforeEach(() => {
    // Web Locks 없는 경로로 고정해 `전송 중` 판정까지 재현한다.
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('localStorage', new FakeStorage());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('refuses on every state where the capture is not this phone’s alone', () => {
    expect(undoRefusalOf(undefined)).toBe('missing');
    expect(undoRefusalOf({ ...item('20260727-120001-a'), state: 'sent' })).toBe('already_sent');
    expect(undoRefusalOf({ ...item('20260727-120001-a'), sentAt: '2026-07-27T03:00:00.000Z' })).toBe('already_sent');
    expect(undoRefusalOf({ ...item('20260727-120001-a'), reconciledAt: '2026-07-27T03:00:00.000Z' })).toBe('already_sent');
    expect(undoRefusalOf({ ...item('20260727-120001-a'), images: [{ name: 'front.jpg', mime: 'image/jpeg' }] })).toBe('no_original');
    expect(undoRefusalOf(item('20260727-120001-a'))).toBeNull();
    expect(undoRefusalOf(item('20260727-120001-a', 'failed'))).toBeNull();
  });

  it('hands the capture back with its original image and removes exactly that row', async () => {
    await putQueueItem(item('20260727-120001-a'));
    await putQueueItem(item('20260727-120002-b'));

    const outcome = await takeBackQueueItem('20260727-120002-b');
    expect(outcome.refusal).toBeUndefined();
    expect(outcome.item?.images[0].dataB64).toBe('20260727-120002-b-image');
    expect((await readQueue()).map((row) => row.captureId)).toEqual(['20260727-120001-a']);
  });

  it('never deletes a capture the server already has', async () => {
    await putQueueItem({ ...item('20260727-120003-c', 'sent'), sentAt: '2026-07-27T03:00:00.000Z' });

    expect(await takeBackQueueItem('20260727-120003-c')).toEqual({ refusal: 'already_sent' });
    expect((await readQueue()).map((row) => row.captureId)).toEqual(['20260727-120003-c']);
  });

  it('refuses while the queue is being sent instead of guessing', async () => {
    await putQueueItem(item('20260727-120004-d'));
    // 다른 탭(또는 이 탭의 전송)이 잠금을 들고 있는 상태.
    localStorage.setItem('cc_queue_flush_lock', JSON.stringify({ owner: 'sending-tab', expiresAt: Date.now() + 30_000 }));

    expect(await takeBackQueueItem('20260727-120004-d')).toEqual({ refusal: 'busy' });
    expect((await readQueue()).map((row) => row.captureId)).toEqual(['20260727-120004-d']);
  });

  it('reports a row that is no longer there without touching the rest', async () => {
    await putQueueItem(item('20260727-120005-e'));
    await deleteQueueItem('20260727-120005-e');

    expect(await takeBackQueueItem('20260727-120005-e')).toEqual({ refusal: 'missing' });
    expect(await readQueue()).toEqual([]);
  });
});

// 한 캡처의 여정을 PII 없이 추적한다 (FI-021).
// correlationId는 **클라이언트 진단 전용**이다 — 업로드 payload에는 들어가지 않는다.
describe('correlation id survives retry, reconcile and send (FI-021)', () => {
  it('keeps the same correlation id through fail -> reconcile -> sent', async () => {
    await putQueueItem({ ...item('20260727-130001-a'), correlationId: 'cc-journey01' });

    await flushQueue(async () => { throw new Error('http_503'); });
    const afterFailure = (await readQueue())[0];
    expect(afterFailure.correlationId).toBe('cc-journey01');
    expect(afterFailure.state).toBe('failed');

    await flushQueue(async () => { throw new Error('unreachable'); }, async () => new Set(['20260727-130001-a']));
    const afterReconcile = (await readQueue())[0];
    expect(afterReconcile.correlationId).toBe('cc-journey01');
    expect(afterReconcile.state).toBe('sent');
  });

  it('keeps the correlation id when the original images are pruned', async () => {
    await putQueueItem({
      ...item('20260727-130002-b', 'sent'),
      correlationId: 'cc-journey02',
      sentAt: '2026-07-27T00:00:00.000Z',
    });

    expect(await pruneSentQueue(Date.parse('2026-07-27T05:00:00.000Z'))).toBe(1);
    expect((await readQueue())[0].correlationId).toBe('cc-journey02');
  });

  it('backfills a stable correlation id onto a row saved before this contract', async () => {
    await putQueueItem(item('20260727-130003-c'));

    await flushQueue(async () => { throw new Error('http_503'); });
    const first = (await readQueue())[0].correlationId;
    expect(first).toMatch(/^cc-[0-9a-z]+$/);

    await flushQueue(async () => { throw new Error('http_503'); });
    expect((await readQueue())[0].correlationId).toBe(first);
  });

  it('never writes the raw failure text into the diagnostic log', async () => {
    clearTrace();
    await putQueueItem({ ...item('20260727-130004-d'), correlationId: 'cc-journey04' });
    await flushQueue(async () => { throw new Error('김민서 010-1234-5678 hong@example.com'); });

    // 큐 항목의 err는 화면 문구를 위해 기존 계약 그대로 둔다 — 로그만 걸러진다.
    expect((await readQueue())[0].err).toBe('김민서 010-1234-5678 hong@example.com');
    const journey = traceOf('cc-journey04');
    expect(journey.map((record) => record.event)).toEqual(['attempt', 'failed']);
    expect(journey.at(-1)?.reason).toBe(REDACTED);
    expect(JSON.stringify(journey)).not.toContain('김민서');
    expect(JSON.stringify(journey)).not.toContain('hong@example.com');
  });
});
