import type {
  CaptureQueueItem,
  ListResponse,
  RuntimeConfig,
  SearchResponse,
  UploadPayload,
} from '../contracts/capture';

function normalizedBase(apiUrl: string): string {
  const trimmed = apiUrl.trim();
  if (!trimmed) throw new Error('missing_api');
  return trimmed;
}

export function buildListUrl(config: RuntimeConfig, limit = 30, now = Date.now()): string {
  const url = new URL(normalizedBase(config.apiUrl));
  url.searchParams.set('action', 'list');
  url.searchParams.set('k', config.token);
  url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 100)));
  url.searchParams.set('_ts', String(now));
  return url.toString();
}

export function buildSearchUrl(config: RuntimeConfig, query: string): string {
  const url = new URL(normalizedBase(config.apiUrl));
  url.searchParams.set('action', 'search');
  url.searchParams.set('k', config.token);
  url.searchParams.set('q', query.trim());
  return url.toString();
}

export function toUploadPayload(item: CaptureQueueItem, config: RuntimeConfig): UploadPayload {
  return {
    k: config.token,
    captureId: item.captureId,
    capturedAt: item.capturedAt,
    capturer: config.capturer,
    event: item.event ?? '',
    note: item.note ?? '',
    quickName: item.quickName ?? null,
    researchInstruction: item.researchInstruction ?? null,
    images: item.images,
  };
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' });
  return (await response.json()) as T;
}

export async function listBriefs(config: RuntimeConfig, limit = 30): Promise<ListResponse> {
  return getJson<ListResponse>(buildListUrl(config, limit));
}

export async function searchPeople(config: RuntimeConfig, query: string): Promise<SearchResponse> {
  return getJson<SearchResponse>(buildSearchUrl(config, query));
}

export async function uploadCapture(config: RuntimeConfig, item: CaptureQueueItem): Promise<void> {
  const response = await fetch(normalizedBase(config.apiUrl), {
    method: 'POST',
    body: JSON.stringify(toUploadPayload(item, config)),
  });
  const result = (await response.json()) as { ok?: boolean; error?: string };
  if (!result.ok) throw new Error(result.error ?? 'upload_failed');
}

export function isTerminalStatus(status: string): boolean {
  return status === 'processed' || status === 'skipped';
}
