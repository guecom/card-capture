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
