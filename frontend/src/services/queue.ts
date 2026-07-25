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
      await putQueueItem({ ...item, state: 'sent', err: undefined });
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
