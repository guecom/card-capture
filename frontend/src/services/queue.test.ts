import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureQueueItem } from '../contracts/capture';
import { flushQueue, pruneSentQueue, putQueueItem, readQueue } from './queue';

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
    expect(result).toEqual({ attempted: 2, sent: 2, failed: 0 });
    expect(order).toEqual(['20260725-120002-b', '20260725-120003-c']);

    const second = await flushQueue(sender);
    expect(second).toEqual({ attempted: 0, sent: 0, failed: 0 });
    expect(sender).toHaveBeenCalledTimes(2);
  });

  it('keeps failed data, increments tries, and succeeds on a later retry', async () => {
    await putQueueItem(item('20260725-120004-d'));
    const firstSender = vi.fn(async () => { throw new Error('offline'); });

    expect(await flushQueue(firstSender)).toEqual({ attempted: 1, sent: 0, failed: 1 });
    const [failed] = await readQueue();
    expect(failed).toMatchObject({ state: 'failed', tries: 1, err: 'offline' });
    expect(failed.images[0].dataB64).toBe('20260725-120004-d-image');

    const retrySender = vi.fn(async () => undefined);
    expect(await flushQueue(retrySender)).toEqual({ attempted: 1, sent: 1, failed: 0 });
    const [sent] = await readQueue();
    expect(sent.state).toBe('sent');
    expect(sent.tries).toBe(1);
    expect(sent.err).toBeUndefined();
  });

  it('prunes original image bytes only from sent captures beyond the retention count', async () => {
    await putQueueItem(item('20260725-000001-old', 'sent'));
    await putQueueItem(item('20260725-000002-new', 'sent'));
    expect(await pruneSentQueue(1)).toBe(1);
    const items = (await readQueue()).sort((a, b) => a.captureId.localeCompare(b.captureId));
    expect(items[0].images[0]).not.toHaveProperty('dataB64');
    expect(items[1].images[0]).toHaveProperty('dataB64');
  });
});
