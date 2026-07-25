import type {
  CaptureQueueItem,
  ActionResponse,
  DocumentResponse,
  ListResponse,
  PersonTarget,
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

export function buildDocumentUrl(config: RuntimeConfig, action: 'doc' | 'persondoc', value: string): string {
  const url = new URL(normalizedBase(config.apiUrl));
  url.searchParams.set('action', action);
  url.searchParams.set('k', config.token);
  url.searchParams.set(action === 'doc' ? 'id' : 'captureId', value);
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

export async function loadPersonDocument(config: RuntimeConfig, target: { id?: string; captureId?: string }): Promise<DocumentResponse> {
  if (target.id) return getJson<DocumentResponse>(buildDocumentUrl(config, 'doc', target.id));
  if (target.captureId) return getJson<DocumentResponse>(buildDocumentUrl(config, 'persondoc', target.captureId));
  throw new Error('missing_person_target');
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

async function postAction(config: RuntimeConfig, payload: Record<string, unknown>): Promise<ActionResponse> {
  const response = await fetch(normalizedBase(config.apiUrl), {
    method: 'POST',
    body: JSON.stringify({ ...payload, k: config.token }),
  });
  return (await response.json()) as ActionResponse;
}

export function requeueCapture(config: RuntimeConfig, captureId: string): Promise<ActionResponse> {
  return postAction(config, { action: 'requeue', captureId });
}

export function addPersonNote(config: RuntimeConfig, target: PersonTarget, text: string): Promise<ActionResponse> {
  return postAction(config, { action: 'addnote', ...target, text: text.trim().slice(0, 2000) });
}

export function submitResearchInstruction(config: RuntimeConfig, target: PersonTarget, text: string): Promise<ActionResponse> {
  return postAction(config, { action: 'researchinstruction', ...target, text: text.trim().slice(0, 2000) });
}

export function requestCorrection(config: RuntimeConfig, captureId: string, text: string): Promise<ActionResponse> {
  return postAction(config, { action: 'correction', captureId, text: text.trim().slice(0, 2000) });
}
