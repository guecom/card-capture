import type { CaptureQueueItem } from '../contracts/capture';

const DATABASE = 'cardcapture';
const VERSION = 1;
const STORE = 'q';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: 'captureId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('indexeddb_open_failed'));
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
      transaction.onerror = () => reject(transaction.error ?? new Error('indexeddb_write_failed'));
    });
  } finally {
    database.close();
  }
}

export type QueueSender = (item: CaptureQueueItem) => Promise<void>;

export interface FlushResult {
  attempted: number;
  sent: number;
  failed: number;
}

export async function flushQueue(send: QueueSender): Promise<FlushResult> {
  const items = (await readQueue())
    .filter((item) => item.state !== 'sent')
    .sort((a, b) => a.captureId.localeCompare(b.captureId));
  const result: FlushResult = { attempted: items.length, sent: 0, failed: 0 };

  for (const item of items) {
    try {
      await send(item);
      await putQueueItem({ ...item, state: 'sent', err: undefined, sentAt: new Date().toISOString() });
      result.sent += 1;
    } catch (error) {
      await putQueueItem({
        ...item,
        state: 'failed',
        tries: (item.tries ?? 0) + 1,
        err: error instanceof Error ? error.message : String(error),
      });
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
