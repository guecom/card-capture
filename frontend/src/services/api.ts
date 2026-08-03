import type {
  BriefItem,
  CaptureQueueItem,
  ActionResponse,
  DocumentResponse,
  ListResponse,
  ManualPersonPayload,
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

/** 서버가 한 번에 주는 최대 건수 (Code.gs `listCaptures_`가 limit을 1~100으로 clamp한다). */
export const LIST_PAGE_MAX = 100;

/** 한 번의 읽기에서 이어 읽을 최대 페이지 수. 넘어가면 "다 읽었다"고 말하지 않는다. */
const LIST_PAGE_BUDGET = 20;

/** 재전송 판정을 위해 읽는 최대 캡처 수. 여기에 걸리면 "없다"가 아니라 "모른다"다. */
const RECONCILE_MAX_ITEMS = LIST_PAGE_MAX * LIST_PAGE_BUDGET;

export function buildListUrl(config: RuntimeConfig, limit = 30, now = Date.now(), offset = 0): string {
  const url = new URL(normalizedBase(config.apiUrl));
  url.searchParams.set('action', 'list');
  url.searchParams.set('k', config.token);
  url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), LIST_PAGE_MAX)));
  // 서버는 offset을 받는다. 보내지 않으면 첫 페이지 밖의 캡처에 닿을 방법이 없다 (FI-100).
  url.searchParams.set('offset', String(Math.max(Math.trunc(offset) || 0, 0)));
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

/**
 * 직접 입력 접수 payload (ISS-000231 / DEC-000103).
 *
 * 사진 경로와 **같은 멱등 장치**를 쓴다 — 새 장치를 만들지 않는다. 클라이언트가 만든
 * `captureId`가 서버 폴더 이름이 되고, 서버는 내용 지문으로 같은 접수를 알아본다.
 * 그래서 연타·타임아웃 뒤 재시도·앱 재시작 뒤 재전송이 전부 job 하나로 수렴한다.
 */
export function toManualPersonPayload(item: CaptureQueueItem, config: RuntimeConfig): ManualPersonPayload {
  return {
    action: 'manualperson',
    k: config.token,
    captureId: item.captureId,
    capturedAt: item.capturedAt,
    event: item.event ?? '',
    note: item.note ?? '',
    text: String(item.manualText ?? '').trim().slice(0, 2000),
  };
}

/**
 * 배포된 GAS가 직접 입력을 아직 모를 때 나오는 서버 코드 (ISS-000231).
 *
 * `Code.gs`는 사람이 따로 재배포해야 반영된다 — 앱만 새로 올라간 구간이 반드시 생긴다.
 * 그때 옛 서버는 `action`을 못 알아보고 업로드 경로로 떨어져 "사진이 없다"고 거절한다.
 * 그 거절을 그대로 두면 사용자에게는 원인 없는 실패로 보이고, 조용히 성공으로 바꾸면
 * 접수되지 않은 등록이 접수된 것처럼 남는다. 둘 다 하지 않고 **분명한 코드**로 바꿔 둔다.
 */
const MANUAL_INTAKE_UNSUPPORTED_REASONS = new Set(['no_images', 'unknown_action', 'bad_action']);

/** 서버가 아직 직접 입력을 받을 준비가 안 된 상태에서 나온 실패인가. */
export const MANUAL_INTAKE_NOT_DEPLOYED = 'manual_intake_not_deployed';

export function manualIntakeUnsupported(reason: unknown): boolean {
  return MANUAL_INTAKE_UNSUPPORTED_REASONS.has(String(reason ?? ''));
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' });
  return (await response.json()) as T;
}

export async function listBriefs(config: RuntimeConfig, limit = 30, offset = 0): Promise<ListResponse> {
  return getJson<ListResponse>(buildListUrl(config, limit, Date.now(), offset));
}

/**
 * 화면이 요청한 건수만큼 목록을 이어 읽는다 (FI-100).
 *
 * 서버 한 페이지는 최대 100건이다. 한 페이지만 읽으면 101번째부터는 앱에서 존재하지 않는 것이
 * 되고, `hasMore`가 계속 참이라 `더 보기` 버튼은 눌러도 아무 일이 없는 죽은 버튼이 된다.
 * 실패한 페이지는 그대로 돌려준다 — 짧은 목록으로 위장하지 않는다.
 */
export async function listBriefsUpTo(config: RuntimeConfig, wanted: number): Promise<ListResponse> {
  const target = Math.max(Math.trunc(wanted) || 0, 1);
  const items: BriefItem[] = [];
  const seen = new Set<string>();
  let meta: ListResponse | null = null;
  let hasMore = false;

  for (let page = 0; page < LIST_PAGE_BUDGET; page += 1) {
    const response = await listBriefs(config, Math.min(target - items.length, LIST_PAGE_MAX), items.length);
    if (!response.ok) return response;
    meta = response;
    const pageItems = response.items ?? [];
    // 페이지 사이에 새 캡처가 들어오면 offset이 밀려 같은 항목이 두 번 올 수 있다.
    pageItems.forEach((item) => {
      if (seen.has(item.captureId)) return;
      seen.add(item.captureId);
      items.push(item);
    });
    hasMore = response.hasMore === true;
    if (!hasMore || pageItems.length === 0 || items.length >= target) break;
  }

  return { ...(meta ?? { ok: true }), ok: true, items, hasMore };
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

/**
 * 대기열 항목 하나를 서버로 보낸다.
 *
 * 사진이든 직접 입력이든 **이 함수 하나**를 지난다. 전송로를 둘로 나누면 잠금·대조·재시도·
 * 실패 분류(FI-016)가 두 벌이 되고, 둘 중 한쪽만 고쳐지는 날이 온다.
 */
export async function uploadCapture(config: RuntimeConfig, item: CaptureQueueItem): Promise<void> {
  const manual = item.intake === 'manual_person';
  let response: Response;
  try {
    response = await fetch(normalizedBase(config.apiUrl), {
      method: 'POST',
      body: JSON.stringify(manual ? toManualPersonPayload(item, config) : toUploadPayload(item, config)),
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

  if (result.ok) return;
  // 서버가 아직 직접 입력을 모른다. 실패는 실패로 두되, 사람이 무엇을 해야 하는지 알 수 있는
  // 코드로 바꾼다 — 여기서 성공으로 바꾸면 접수되지 않은 등록이 접수된 것처럼 남는다.
  if (manual && manualIntakeUnsupported(result.error)) throw new UploadError('rejected', MANUAL_INTAKE_NOT_DEPLOYED);
  throw new UploadError('rejected', result.error ?? 'upload_failed');
}

/**
 * 서버가 이미 갖고 있는 captureId 집합 (FI-016 reconcile).
 *
 * 조회 자체가 실패하면 `null` — 그때는 판정하지 않고 재전송도 하지 않는다.
 *
 * **부분 집합을 돌려주면 안 된다.** 호출측(`flushQueue`)은 여기 없는 captureId를 "서버에 없다"로
 * 읽고 다시 올린다. 한 페이지(최대 100건)만 읽으면 오래된 captureId가 빠지고, 이미 접수·처리된
 * 캡처가 처음부터 다시 처리된다 — FI-015/FI-016이 막으려던 바로 그 되돌림이다.
 * 그래서 `hasMore`를 따라 끝까지 읽고, 상한에 걸리거나 서버가 더 있는지 말해 주지 않으면
 * `null`("모른다")을 돌려준다.
 */
export async function fetchServerCaptureIds(config: RuntimeConfig, maxItems = RECONCILE_MAX_ITEMS): Promise<Set<string> | null> {
  const budget = Math.max(Math.trunc(maxItems) || 0, 1);
  const ids = new Set<string>();
  let offset = 0;
  try {
    for (let page = 0; page < LIST_PAGE_BUDGET; page += 1) {
      const response = await listBriefs(config, LIST_PAGE_MAX, offset);
      if (!response.ok) return null;
      const items = response.items ?? [];
      items.forEach((brief) => ids.add(brief.captureId));
      offset += items.length;
      if (response.hasMore === false) return ids;
      // `hasMore`를 주지 않는 구서버: 페이지가 꽉 찼으면 더 있는지 알 수 없다.
      if (response.hasMore !== true) return items.length >= LIST_PAGE_MAX ? null : ids;
      if (items.length === 0) return null;
      if (ids.size >= budget) return null;
    }
    return null;
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
