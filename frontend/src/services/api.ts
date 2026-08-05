import type {
  BriefItem,
  CaptureQueueItem,
  ActionResponse,
  DocumentResponse,
  ListResponse,
  ManualPersonPayload,
  PersonTarget,
  ResearchInstruction,
  RuntimeConfig,
  SearchResponse,
  UploadPayload,
} from '../contracts/capture';
import { downgradeQuickMode, quickModeRejected } from './research-envelope';
import { resolveResearchRoute } from './research-mode';
import { recordResearchRoute } from './research-telemetry';
import type { ResearchSubmission } from './research';

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

/**
 * 옛 서버가 `빠른 조사`를 아직 모르는 구간의 처리 (TSK-000542).
 *
 * `Code.gs`는 사람이 따로 재배포해야 반영되므로 **앱은 아는데 서버는 모르는 구간**이 반드시
 * 생긴다. 그 구간에서 `quick`은 서버 allowlist에 없어 요청 전체가 `bad_research_request`로
 * 거절된다 — 촬영 업로드 경로에서는 **사진까지 함께** 거절된다.
 *
 * 그래서 같은 요청을 표준 깊이로 **딱 한 번** 다시 보낸다. 사용자는 조사를 받고, 내려갔다는
 * 사실은 개발자 채널에만 남는다 (founder: "사용자는 모르게, 개발자에게는 알려줘야지").
 *
 * **진짜 실패를 감추지 않는다는 근거.** 두 시도의 차이는 `mode` 한 칸뿐이고, 서버의 나머지 검사
 * (빈 요청·target·권한·일일 한도)는 `quick`과 `standard`에서 완전히 같다. 원인이 mode가
 * 아니었다면 두 번째 시도도 정확히 같은 코드로 거절되고, 그 실패가 그대로 위로 올라간다.
 */
function recordQuickModeFallback(envelope: ResearchInstruction, recovered: boolean, reason?: unknown): void {
  recordResearchRoute(resolveResearchRoute(envelope.depth), {
    event: recovered ? 'degraded' : 'failed',
    degraded: true,
    reason: recovered ? 'quick_mode_unsupported' : reason,
    ...(envelope.requestId ? { requestId: envelope.requestId } : {}),
  });
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
/**
 * 업로드 본문 한 번의 왕복. 응답을 못 읽는 모든 경우는 `ambiguous`로 던진다 —
 * 그 상태에서는 **다시 보내지 않는다**(FI-016).
 */
async function postCapture(config: RuntimeConfig, payload: UploadPayload | ManualPersonPayload): Promise<{ ok?: boolean; error?: string }> {
  let response: Response;
  try {
    response = await fetch(normalizedBase(config.apiUrl), { method: 'POST', body: JSON.stringify(payload) });
  } catch (error) {
    throw new UploadError('ambiguous', error instanceof Error ? error.message : 'network_failed');
  }

  // 5xx는 쓰기 도중 죽었을 수 있다 — 접수 여부를 단정하지 않는다.
  if (!response.ok) throw new UploadError('ambiguous', `http_${response.status}`);

  try {
    return (await response.json()) as { ok?: boolean; error?: string };
  } catch {
    throw new UploadError('ambiguous', 'unreadable_response');
  }
}

export async function uploadCapture(config: RuntimeConfig, item: CaptureQueueItem): Promise<void> {
  const manual = item.intake === 'manual_person';
  const payload = manual ? toManualPersonPayload(item, config) : toUploadPayload(item, config);
  let result = await postCapture(config, payload);

  // 옛 서버가 `빠른 조사`를 모를 때만 한 번 더. 거절 코드가 다르거나 `quick`이 아니었으면
  // 아무 일도 하지 않는다 — 재시도가 실패를 감추는 길이 되면 안 된다.
  const envelope = item.researchInstruction;
  if (!result.ok && !manual && envelope && quickModeRejected(envelope, result.error)) {
    const retry = await postCapture(config, { ...(payload as UploadPayload), researchInstruction: downgradeQuickMode(envelope) });
    recordQuickModeFallback(envelope, Boolean(retry.ok), retry.error);
    result = retry;
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

/**
 * 조사 요청 하나가 실제로 실려 나가는 모양 (계약 §Request Contract).
 *
 * 서버는 `req.instruction || req.text`를 읽는다. 구조화된 봉투가 있으면 그것이 이기고,
 * `text`는 봉투를 모르는 서버를 위한 자리다 — 그래서 **자유 입력 원문 그대로**를 담는다.
 * 고른 항목을 이 문자열에 다시 섞지 않는다: 제 칸이 있는 값을 자유 텍스트에 숨기면
 * 서버의 allowlist 검사와 요청 지문이 그 값을 보지 못한다.
 *
 * `depth`는 DEC-000110에서 이 자리에 들어왔다. 그 전까지 이 경로는 깊이를 **아예 보내지 않았고**,
 * 촬영 업로드 경로만 보냈다 — 같은 선택이 어느 화면에서 눌렸느냐에 따라 서버에 도착하기도 하고
 * 사라지기도 했다. 서버는 이 값을 allowlist로 정규화해 capture envelope에 남기고, 워처가 그것으로
 * 처리 모델을 고른다. 모델 id는 여기서 정하지도, 보내지도 않는다.
 */
function researchInstructionPayload(target: PersonTarget, submission: ResearchSubmission): Record<string, unknown> {
  return {
    action: 'researchinstruction',
    ...target,
    text: submission.raw,
    instruction: {
      raw: submission.raw,
      depth: submission.depth,
      mode: submission.mode,
      purposes: submission.purposes,
      focusIds: submission.focusIds,
      requestId: submission.requestId,
    },
  };
}

/**
 * 조사 요청을 접수한다 (TSK-000542).
 *
 * 어느 내부 자리로 갈지는 클라이언트가 정하지 않고 보내지도 않는다 — 그 판정은
 * `services/research-mode.ts`의 버전 붙은 설정이 소유하고 개발자 telemetry에만 남는다.
 * 옛 서버가 `quick`을 모르면 같은 요청을 표준 깊이로 한 번만 다시 보낸다(위 주석 참고).
 */
export async function submitResearchInstruction(
  config: RuntimeConfig,
  target: PersonTarget,
  submission: ResearchSubmission,
): Promise<ActionResponse> {
  const first = await postAction(config, researchInstructionPayload(target, submission));
  if (first.ok || !quickModeRejected(submission, first.error)) return first;

  const retry = await postAction(config, researchInstructionPayload(target, downgradeQuickMode(submission)));
  recordQuickModeFallback(submission, retry.ok === true, retry.error);
  return retry;
}

export function requestCorrection(config: RuntimeConfig, captureId: string, text: string): Promise<ActionResponse> {
  return postAction(config, { action: 'correction', captureId, text: text.trim().slice(0, 2000) });
}
