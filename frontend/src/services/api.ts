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

/**
 * 업로드 실패의 두 종류 (FI-016 / FI-021).
 *
 * `rejected` — 서버가 요청을 받고 명시적으로 거절했다. 서버에 아무것도 남지 않은 것이 확실하다.
 * `ambiguous` — 응답을 못 받았다(네트워크 끊김·타임아웃·HTTP 오류·깨진 응답).
 *   **접수됐는지 아닌지 알 수 없다.** 이 상태에서 그냥 다시 올리면 안 된다 —
 *   서버는 같은 captureId 폴더의 `capture.json`을 덮어쓰며 `status`를 `received`로 되돌리므로,
 *   이미 처리가 끝난 캡처가 처음부터 다시 처리된다.
 */
export type UploadFailureKind = 'rejected' | 'ambiguous';

export class UploadError extends Error {
  constructor(readonly kind: UploadFailureKind, readonly reason: string) {
    super(reason);
    this.name = 'UploadError';
  }
}

export async function uploadCapture(config: RuntimeConfig, item: CaptureQueueItem): Promise<void> {
  let response: Response;
  try {
    response = await fetch(normalizedBase(config.apiUrl), {
      method: 'POST',
      body: JSON.stringify(toUploadPayload(item, config)),
    });
  } catch (error) {
    throw new UploadError('ambiguous', error instanceof Error ? error.message : 'network_failed');
  }

  // 5xx는 쓰기 도중 죽었을 수 있다 — 접수 여부를 단정하지 않는다.
  if (!response.ok) throw new UploadError('ambiguous', `http_${response.status}`);

  let result: { ok?: boolean; error?: string };
  try {
    result = (await response.json()) as { ok?: boolean; error?: string };
  } catch {
    throw new UploadError('ambiguous', 'unreadable_response');
  }

  if (!result.ok) throw new UploadError('rejected', result.error ?? 'upload_failed');
}

/**
 * 서버가 이미 갖고 있는 captureId 집합 (FI-016 reconcile).
 * 조회 자체가 실패하면 `null` — 그때는 판정하지 않고 재전송도 하지 않는다.
 */
export async function fetchServerCaptureIds(config: RuntimeConfig, limit = 100): Promise<Set<string> | null> {
  try {
    const response = await listBriefs(config, limit);
    if (!response.ok) return null;
    return new Set((response.items ?? []).map((brief) => brief.captureId));
  } catch {
    return null;
  }
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
