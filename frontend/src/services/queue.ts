import type { CaptureQueueItem } from '../contracts/capture';
import { correlationIdOf, traceCapture } from './trace';

const DATABASE = 'cardcapture';
const VERSION = 1;
const STORE = 'q';

/**
 * 로컬 저장이 실패하는 **구분되는** 이유 (FI-052).
 * 예전에는 전부 "다시 시도해 주세요"였는데, 저장 공간이 없을 때 다시 시도하는 것은 낫지 않다.
 */
export type QueueWriteFailure = 'quota' | 'unavailable' | 'verify' | 'unknown';

export class QueueWriteError extends Error {
  constructor(readonly failure: QueueWriteFailure, readonly detail?: unknown) {
    super(`queue_write_${failure}`);
    this.name = 'QueueWriteError';
  }
}

function classifyWriteError(error: unknown): QueueWriteFailure {
  const name = (error as { name?: string } | null)?.name ?? '';
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return 'quota';
  if (name === 'InvalidStateError' || name === 'SecurityError' || name === 'UnknownError') return 'unavailable';
  return 'unknown';
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || indexedDB === null) {
      reject(new QueueWriteError('unavailable'));
      return;
    }
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: 'captureId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new QueueWriteError('unavailable', request.error));
  });
}

export async function readQueue(): Promise<CaptureQueueItem[]> {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      request.onsuccess = () => resolve((request.result ?? []) as CaptureQueueItem[]);
      request.onerror = () => reject(request.error ?? new Error('indexeddb_read_failed'));
    });
  } finally {
    database.close();
  }
}

export async function putQueueItem(item: CaptureQueueItem): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put(item);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new QueueWriteError(classifyWriteError(transaction.error), transaction.error));
      transaction.onabort = () => reject(new QueueWriteError(classifyWriteError(transaction.error), transaction.error));
    });
  } finally {
    database.close();
  }
}

export async function deleteQueueItem(captureId: string): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).delete(captureId);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new QueueWriteError(classifyWriteError(transaction.error), transaction.error));
      transaction.onabort = () => reject(new QueueWriteError(classifyWriteError(transaction.error), transaction.error));
    });
  } finally {
    database.close();
  }
}

/** 저장된 항목이 원본과 같은 사진을 담고 있는지 (FI-032 read-back 판정 기준). */
function storesSameImages(stored: CaptureQueueItem | undefined, item: CaptureQueueItem): boolean {
  if (!stored || stored.captureId !== item.captureId) return false;
  if (stored.images.length !== item.images.length) return false;
  return item.images.every((image, index) => {
    const persisted = stored.images[index];
    return persisted?.name === image.name && (persisted?.dataB64?.length ?? 0) === (image.dataB64?.length ?? 0);
  });
}

/**
 * 쓰고 나서 **다시 읽어** 같은 사진이 들어갔는지 확인한다 (FI-032).
 * transaction이 commit됐다는 것만으로 "폰을 넣어도 안전하다"고 말하지 않는다 —
 * 저장 공간 압박이나 저장소 오류에서 commit 뒤 항목이 비어 있는 경우가 실제로 있다.
 */
export async function putQueueItemVerified(item: CaptureQueueItem): Promise<CaptureQueueItem> {
  try {
    await putQueueItem(item);
  } catch (error) {
    throw error instanceof QueueWriteError ? error : new QueueWriteError(classifyWriteError(error), error);
  }

  let stored: CaptureQueueItem | undefined;
  try {
    stored = (await readQueue()).find((candidate) => candidate.captureId === item.captureId);
  } catch (error) {
    throw new QueueWriteError('verify', error);
  }
  if (!storesSameImages(stored, item)) throw new QueueWriteError('verify', stored);
  return stored as CaptureQueueItem;
}

export const queueWriteMessage: Record<QueueWriteFailure, string> = {
  quota: '휴대폰 저장 공간이 부족해 이 촬영을 기기에 넣지 못했어요. 아직 저장되지 않았으니 화면을 닫지 마세요 — 전송이 끝난 예전 명함을 정리하거나 공간을 확보한 뒤 다시 눌러 주세요.',
  unavailable: '이 브라우저에서 기기 저장소를 열 수 없어 촬영을 보관하지 못했어요. 아직 저장되지 않았습니다 — 시크릿 모드라면 일반 창에서 다시 열어 주세요.',
  verify: '저장을 시도했지만 다시 읽었을 때 사진이 온전하지 않았어요. 안전하다고 말할 수 없으니 다시 촬영해 주세요.',
  unknown: '촬영을 기기에 보관하지 못했어요. 아직 저장되지 않았으니 다시 시도해 주세요.',
};

/** 대기열 항목이 실제로 전송 가능한 상태인지 (FI-025). */
export type QueueDamage = 'missing_id' | 'bad_state' | 'no_images' | 'empty_payload';

export interface DamagedQueueEntry {
  captureId: string;
  damage: QueueDamage[];
}

export interface QueueIntegrity {
  healthy: CaptureQueueItem[];
  damaged: DamagedQueueEntry[];
}

const VALID_STATES = new Set(['queued', 'failed', 'sent']);

function damageOf(value: unknown): QueueDamage[] {
  const item = value as Partial<CaptureQueueItem> | null;
  const damage: QueueDamage[] = [];
  if (!item || typeof item.captureId !== 'string' || !item.captureId.trim()) damage.push('missing_id');
  if (!item || !VALID_STATES.has(String(item.state))) damage.push('bad_state');
  if (!item || !Array.isArray(item.images)) damage.push('no_images');
  // 전송이 끝난 항목은 원본이 정리돼 사진이 비어 있는 것이 정상이다.
  else if (item.state !== 'sent' && !item.images.some((image) => image?.dataB64)) damage.push('empty_payload');
  return damage;
}

/**
 * 손상된 항목을 **격리만** 한다 — 지우거나 고쳐 쓰지 않는다.
 * 원본은 그대로 두고 화면과 전송 경로에서만 빼서, 한 항목이 대기열 전체를 막지 않게 한다.
 */
export function inspectQueueItems(items: unknown[]): QueueIntegrity {
  const integrity: QueueIntegrity = { healthy: [], damaged: [] };
  items.forEach((value, index) => {
    const damage = damageOf(value);
    if (damage.length === 0) {
      integrity.healthy.push(value as CaptureQueueItem);
      return;
    }
    const captureId = (value as { captureId?: unknown } | null)?.captureId;
    integrity.damaged.push({ captureId: typeof captureId === 'string' && captureId ? captureId : `(식별자 없음 #${index + 1})`, damage });
  });
  return integrity;
}

export async function readQueueChecked(): Promise<QueueIntegrity> {
  return inspectQueueItems(await readQueue());
}

const LOCK_NAME = 'cardcapture-queue-flush';
const LOCK_KEY = 'cc_queue_flush_lock';
const LOCK_TTL_MS = 60_000;

/** 저장된 lease를 지금 들고 있는 탭. 값이 없거나 형식이 깨졌으면 `undefined`. 저장소 오류는 그대로 던진다. */
function leaseOwner(): string | undefined {
  const raw = localStorage.getItem(LOCK_KEY);
  return (raw ? JSON.parse(raw) as { owner?: string } : null)?.owner;
}

/**
 * 탭 하나만 대기열을 전송한다 (FI-053).
 * 두 탭이 동시에 flush하면 같은 captureId가 두 번 올라가고, 한쪽의 `sent` 표시를
 * 다른 쪽이 예전 상태로 덮어쓴다. Web Locks가 있으면 그것을, 없으면 만료가 있는
 * localStorage lease를 쓴다.
 *
 * 두 경로의 세기는 같지 않다. Web Locks는 브라우저가 보장하는 상호배제이고,
 * localStorage lease는 **확률을 낮춘 것**이다 (아래 한계 주석).
 */
export async function withQueueLock<T>(run: () => Promise<T>, now = Date.now()): Promise<T | null> {
  const locks = (globalThis.navigator as Navigator & { locks?: LockManager } | undefined)?.locks;
  if (locks?.request) {
    return await locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => (lock ? run() : null)) as T | null;
  }

  let held = '';
  try {
    const raw = localStorage.getItem(LOCK_KEY);
    const lease = raw ? JSON.parse(raw) as { owner?: string; expiresAt?: number } : null;
    // 만료된 lease는 크래시한 탭이 남긴 것이므로 회수한다.
    if (lease?.expiresAt && lease.expiresAt > now) return null;
    held = `${now}-${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem(LOCK_KEY, JSON.stringify({ owner: held, expiresAt: now + LOCK_TTL_MS }));
  } catch {
    // 저장소를 못 쓰면 잠금 없이 진행한다 — 이 탭이 유일한 탭일 가능성이 높다.
    return run();
  }

  // 위의 "읽고 → 판단하고 → 쓴다"는 원자적이지 않다. 두 탭이 같은 순간에 읽으면 둘 다
  // "비어 있음"을 보고 둘 다 쓴다. 쓴 직후 다시 읽어, lease가 아직 우리 것일 때만 전송한다 —
  // 저장소가 쓰기를 직렬화하므로 마지막에 쓴 탭만 자기 owner를 되읽는다. 진 탭은 조용히 물러난다.
  //
  // **이것은 상호배제가 아니다.** localStorage에는 compare-and-swap이 없으므로 창을 없앨 수는
  // 없고 좁힐 수만 있다. 남는 창:
  //   1. 다른 탭의 쓰기가 우리의 쓰기와 이 확인 **사이**가 아니라 확인 **뒤**에 도착하면 둘 다 통과한다.
  //   2. 다른 탭의 쓰기가 이 탭 프로세스에 언제 보이는지는 브라우저 구현에 달렸다. 탭마다
  //      캐시된 사본을 되읽으면 이 확인은 아무것도 걸러내지 못한다.
  // 창을 실제로 닫는 것은 서버 멱등(FI-010)이다. 여기서는 중복 업로드 확률만 낮춘다.
  try {
    if (leaseOwner() !== held) return null;
  } catch {
    // 확인할 수 없으면 이미 쓴 lease를 우리 것으로 보고 정상 경로로 간다 — 해제까지 책임진다.
  }

  try {
    return await run();
  } finally {
    try {
      // 우리 것일 때만 지운다. 우리를 밀어낸 탭의 lease를 지우면 세 번째 탭까지 들어온다.
      if (leaseOwner() === held) localStorage.removeItem(LOCK_KEY);
    } catch {
      // 해제 실패는 TTL이 정리한다.
    }
  }
}

/**
 * 방금 찍은 촬영을 대기열에서 되돌릴 수 없는 이유 (FI-049).
 * 되돌리기는 "아직 이 폰에만 있는" 촬영에만 성립한다.
 */
export type UndoRefusal =
  /** 대기열에 그 항목이 없다. */
  | 'missing'
  /** 서버가 이미 받았다 — 로컬에서 지워도 서버의 캡처는 사라지지 않는다. */
  | 'already_sent'
  /** 원본 사진이 정리돼 촬영 화면으로 되돌릴 것이 없다. */
  | 'no_original'
  /** 지금 전송 중이라 판정할 수 없다. 모르는 채로 지우지 않는다. */
  | 'busy';

export function undoRefusalOf(item: CaptureQueueItem | undefined): UndoRefusal | null {
  if (!item) return 'missing';
  // reconciledAt/sentAt은 "서버가 갖고 있다"는 기록이다 — state만 보면 판정이 헐거워진다.
  if (item.state === 'sent' || item.sentAt || item.reconciledAt) return 'already_sent';
  if (!item.images.some((image) => image.dataB64)) return 'no_original';
  return null;
}

export interface UndoOutcome {
  /** 대기열에서 빼낸 항목. 호출자가 촬영 초안으로 되돌려 준다. */
  item?: CaptureQueueItem;
  refusal?: UndoRefusal;
}

/**
 * 대기열에서 항목을 빼내 호출자에게 돌려준다 (FI-049 되돌리기).
 *
 * 전송 잠금을 잡고, **잠금 안에서 상태를 다시 읽어** 판정한다. 화면이 알고 있던 상태를 믿고
 * 지우면 전송이 이미 시작된 촬영을 지워 서버에만 남는 유령 캡처가 생긴다. 잠금을 못 잡으면
 * (다른 탭이나 이 탭의 전송이 진행 중) 추측하지 않고 `busy`로 거절한다.
 */
export async function takeBackQueueItem(captureId: string): Promise<UndoOutcome> {
  const outcome = await withQueueLock<UndoOutcome>(async () => {
    const item = (await readQueue()).find((candidate) => candidate.captureId === captureId);
    const refusal = undoRefusalOf(item);
    if (refusal || !item) return { refusal: refusal ?? 'missing' };
    await deleteQueueItem(captureId);
    return { item };
  });
  return outcome ?? { refusal: 'busy' };
}

export const undoRefusalMessage: Record<UndoRefusal, string> = {
  missing: '되돌릴 촬영을 대기열에서 찾지 못했어요. 명함 기록에서 상태를 확인해 주세요.',
  already_sent: '이미 서버가 받은 촬영이라 이 폰에서 되돌릴 수 없어요. 내용은 다시 열어 고칠 수 있어요.',
  no_original: '이 촬영은 원본 사진이 정리돼 촬영 화면으로 되돌릴 수 없어요. 다시 열어 새로 찍어 주세요.',
  busy: '지금 전송 중이라 되돌릴 수 없어요 — 대기열은 그대로 두었습니다. 잠시 뒤 다시 눌러 주세요.',
};

export type QueueSender = (item: CaptureQueueItem) => Promise<void>;

export interface FlushResult {
  attempted: number;
  sent: number;
  failed: number;
  /** 전송할 수 없어 건너뛴 손상 항목 수. 지우지 않고 남겨 둔다 (FI-025). */
  quarantined: number;
  /** 재전송 대신 서버 기록과 대조해 접수 완료로 판정한 수 (FI-016). */
  reconciled: number;
}

/**
 * 서버가 이미 갖고 있는 captureId 집합을 돌려준다. 조회할 수 없으면 `null`.
 * `null`은 "없다"가 아니라 "모른다"이며, 모를 때는 재전송하지 않는다 (FI-016).
 */
export type QueueReconciler = () => Promise<Set<string> | null>;

/** 실패 원인을 모르는 채로 다시 올리면 안 되는 항목인가. */
function needsReconcile(item: CaptureQueueItem): boolean {
  return item.state === 'failed' && item.errKind === 'ambiguous';
}

export async function flushQueue(send: QueueSender, reconcile?: QueueReconciler): Promise<FlushResult> {
  const integrity = inspectQueueItems(await readQueue());
  const items = integrity.healthy
    .filter((item) => item.state !== 'sent')
    .sort((a, b) => a.captureId.localeCompare(b.captureId));
  // 손상 항목은 아무리 재시도해도 성공하지 못한다. 큐 전체를 막지 않도록 건너뛴다.
  const result: FlushResult = { attempted: 0, sent: 0, failed: 0, quarantined: integrity.damaged.length, reconciled: 0 };

  // 응답을 못 받았던 항목이 있을 때만, 그리고 이 flush 안에서 딱 한 번만 서버 목록을 읽는다.
  // `undefined`=아직 안 물어봄, `null`=물어봤지만 알 수 없음.
  let serverIds: Set<string> | null | undefined;

  for (const original of items) {
    // 이 계약 이전에 저장된 항목에는 상관관계 ID가 없다. 여기서 한 번 확정해 두면
    // 아래의 모든 쓰기가 같은 값을 이어서 저장한다 (FI-021).
    const item: CaptureQueueItem = { ...original, correlationId: correlationIdOf(original) };

    // reconciler가 없으면 호출자가 대조를 쓰지 않기로 한 것이다 — 기존대로 그냥 보낸다.
    if (reconcile && needsReconcile(item)) {
      if (serverIds === undefined) serverIds = await reconcile();
      if (serverIds === null) {
        // 서버에 물어볼 수 없다. 모르는 채로 덮어쓰지 않고 다음 flush로 미룬다
        // (대개 오프라인이라 재전송해도 어차피 실패한다).
        traceCapture(item, 'deferred');
        continue;
      }
      if (serverIds.has(item.captureId)) {
        // 이미 접수됐다. 다시 올리면 서버가 capture.json을 덮어써 처리 상태가 처음으로 되돌아간다.
        await putQueueItem({
          ...item,
          state: 'sent',
          err: undefined,
          errKind: undefined,
          reconciledAt: new Date().toISOString(),
          sentAt: item.sentAt ?? new Date().toISOString(),
        });
        traceCapture(item, 'reconciled');
        result.reconciled += 1;
        continue;
      }
    }

    result.attempted += 1;
    traceCapture(item, 'attempt');
    try {
      await send(item);
      await putQueueItem({ ...item, state: 'sent', err: undefined, errKind: undefined, sentAt: new Date().toISOString() });
      traceCapture(item, 'sent');
      result.sent += 1;
    } catch (error) {
      const kind = (error as { kind?: CaptureQueueItem['errKind'] })?.kind;
      const errKind = kind === 'ambiguous' || kind === 'rejected' ? kind : 'ambiguous';
      const tries = (item.tries ?? 0) + 1;
      // `err`는 화면 문구를 만들기 위해 원문 그대로 둔다(기존 계약). 진단 로그로는
      // 걸러진 코드만 넘긴다 — 이 문자열은 서버가 보낸 임의의 텍스트일 수 있고,
      // 런타임 오류일 때는 개인 링크 코드가 들어간 주소 전체가 담길 수 있다 (FI-021).
      await putQueueItem({
        ...item,
        state: 'failed',
        tries,
        err: error instanceof Error ? error.message : String(error),
        errKind,
      });
      traceCapture(item, 'failed', { errKind, tries, reason: error instanceof Error ? error.message : error });
      result.failed += 1;
    }
  }

  return result;
}

/** 전송 성공 receipt 이후 원본을 기기에 남겨 두는 유예 시간. 이 시간 안에는 재전송 복구가 가능하다. */
export const SENT_ORIGINAL_GRACE_MS = 10 * 60 * 1000;

// 기기에 남는 명함 원본 정리 (ISS-000102).
// 예전에는 "최근 50건 밖"만 지워서, 전송이 끝난 명함 원본 50장이 기기에 무기한 남았다.
// 이제는 서버가 성공 receipt를 준 뒤 유예 시간이 지나면 원본을 지우고 104px 썸네일만 남긴다.
// 대기·실패 항목은 절대 건드리지 않는다 — 재전송 복구 경로가 살아 있어야 한다.
export async function pruneSentQueue(now = Date.now(), graceMs = SENT_ORIGINAL_GRACE_MS): Promise<number> {
  const items = await readQueue();
  let pruned = 0;
  for (const item of items) {
    if (item.state !== 'sent' || !item.images.some((image) => image.dataB64)) continue;
    // sentAt이 없는 구버전 항목은 촬영 시각을 기준으로 같은 유예를 적용한다.
    const sentAt = Date.parse(String(item.sentAt ?? item.capturedAt ?? ''));
    if (!Number.isNaN(sentAt) && now - sentAt < graceMs) continue;
    await putQueueItem({ ...item, images: item.images.map((image) => ({ name: image.name, mime: image.mime })) });
    pruned += 1;
  }
  return pruned;
}
