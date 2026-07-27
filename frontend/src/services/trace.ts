// 캡처 한 건의 여정을 PII 없이 추적한다 (FI-021) — Kairen-Ref: TSK-000281
//
// 왜 필요한가: 업로드 실패는 이미 `rejected`(서버 거절)와 `ambiguous`(응답 없음)로 나뉘지만,
// "이 명함이 언제 만들어져서 몇 번 시도했고 왜 실패했다가 어떻게 접수됐는지"를 이어서 볼 방법이
// 없었다. 실패 하나만 보고는 재전송해도 되는지 판단할 수 없다.
//
// 왜 조심해야 하는가: 진단 로그는 개인정보가 새는 가장 흔한 자리다. 큐 항목에는 이름, 전화번호,
// 이메일, 메모, 만남 라벨, 조사 지시문, 사진 원본이 전부 들어 있고, `err`에는 **서버가 보낸
// 임의의 텍스트**가 그대로 저장된다(실제 HTTP 서버로 재현 확인). 게다가 이 런타임의 fetch는
// URL을 파싱하지 못하면 `Failed to parse URL from <주소 전체>`를 던지는데, 그 주소에는
// 개인 링크 코드가 들어 있을 수 있다(`?api=` 로 들어온 주소는 query string이 보존된다).
//
// 그래서 이 모듈의 계약은 **거부 목록이 아니라 허용 목록**이다.
//   1. 기록은 열거된 필드로만 만든다. 캡처의 자유 입력 칸은 어느 것도 읽지 않는다.
//   2. 유일한 자유 텍스트 자리인 `reason`은 불투명한 오류 코드 **모양**만 통과시킨다.
//   3. 로그는 메모리에만, 상한을 두고 산다. 기기에 새로운 개인정보 저장소를 만들지 않는다.
//
// correlationId는 **클라이언트 진단 전용**이다. `UploadPayload`에 넣지 않는다 —
// 서버(`Code.gs`)는 이 필드를 저장하지 않으므로, 전송하면 "서버에서도 추적된다"는 거짓 인상만
// 남기고 실제로는 아무 데도 남지 않는다.

import type { CaptureQueueItem } from '../contracts/capture';

/** 캡처 여정의 단계. 캡처가 담고 있는 만남 라벨(`CaptureQueueItem.event`)과는 다른 것이다. */
export type TraceEvent =
  /** 촬영이 대기열 항목이 된 순간. */
  | 'created'
  /** 서버로 보내기 직전. */
  | 'attempt'
  /** 서버가 성공 receipt를 줬다. */
  | 'sent'
  /** 실패했다. `errKind`가 거절인지 응답 없음인지 알려 준다. */
  | 'failed'
  /** 재전송 대신 서버 기록과 대조해 접수 완료로 판정했다. */
  | 'reconciled'
  /** 서버 목록을 읽을 수 없어 판정을 미뤘다. 재전송하지 않았다. */
  | 'deferred';

export interface TraceRecord {
  ts: string;
  correlationId: string;
  captureId: string;
  event: TraceEvent;
  tries: number;
  errKind?: 'rejected' | 'ambiguous';
  /** 걸러진 오류 코드. 원문은 절대 여기 들어오지 않는다. */
  reason?: string;
}

/** 통과하지 못한 값이 남기는 자리 표시자. 원문의 길이·모양도 남기지 않는다. */
export const REDACTED = 'redacted';

/** 로그가 보관하는 최대 기록 수. 넘치면 오래된 것부터 버린다. */
export const TRACE_LIMIT = 200;

// 실제 오류 코드는 짧은 소문자 단어를 `_`로 이은 모양이다
// (`http_503`, `unreadable_response`, `person_folder_not_found`, `queue_write_quota`).
// 이 세 가지 상한이 함께 URL·이메일·전화번호·한글·산문·긴 토큰을 전부 걸러 낸다.
const CODE_SHAPE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const MAX_REASON_LENGTH = 40;
/** 토큰과 식별자는 한 덩어리가 길다. 사람이 쓰는 오류 단어는 그렇지 않다. */
const MAX_SEGMENT_LENGTH = 12;
/** 문장은 단어가 많다. 오류 코드는 그렇지 않다. */
const MAX_SEGMENTS = 6;

/**
 * 자유 텍스트를 불투명한 오류 코드로 좁힌다. 통과시킬 수 없으면 `REDACTED`.
 *
 * 남는 한계: `john_smith`처럼 짧은 ASCII 소문자 두 단어는 오류 코드와 구분할 수 없다.
 * 그래서 이 로그는 기기 밖으로 나가지 않고, `reason`은 오류 코드 자리에서만 채워진다.
 */
export function redactReason(raw: unknown): string | undefined {
  const text = raw === null || raw === undefined ? '' : String(raw);
  const normalized = text.trim().toLowerCase().replace(/\s+/g, '_');
  if (!normalized) return undefined;
  if (normalized.length > MAX_REASON_LENGTH) return REDACTED;
  if (!CODE_SHAPE.test(normalized)) return REDACTED;
  const segments = normalized.split('_');
  if (segments.length > MAX_SEGMENTS) return REDACTED;
  if (segments.some((segment) => segment.length > MAX_SEGMENT_LENGTH)) return REDACTED;
  return normalized;
}

/** 캡처 내용과 무관한 새 상관관계 ID. 난수만 쓴다. */
export function createCorrelationId(random: () => number = Math.random): string {
  let suffix = '';
  while (suffix.length < 12) {
    suffix += Math.floor(random() * 36 ** 6).toString(36).padStart(6, '0');
  }
  return `cc-${suffix.slice(0, 12)}`;
}

/**
 * 이 항목의 상관관계 ID. 저장된 값이 있으면 그대로 쓴다.
 *
 * 이 계약 이전에 저장된 항목은 값이 없다. 그때는 `captureId`와 `capturedAt`에서 **결정적으로**
 * 만든다 — 둘 다 시각과 난수라서 사람에 대한 정보가 아니고, 추가 쓰기 없이도 flush를 반복할 때마다
 * 같은 값이 나와 여정이 끊기지 않는다.
 */
export function correlationIdOf(item: Pick<CaptureQueueItem, 'captureId' | 'capturedAt' | 'correlationId'>): string {
  const stored = item.correlationId?.trim();
  if (stored) return stored;
  let hash = 2166136261;
  for (const character of `${item.captureId}|${item.capturedAt ?? ''}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `cc-${(hash >>> 0).toString(36)}`;
}

let records: TraceRecord[] = [];

/** 지금까지의 기록 사본. 호출자가 로그를 망가뜨릴 수 없도록 원본을 넘기지 않는다. */
export function readTrace(): TraceRecord[] {
  return records.slice();
}

export function clearTrace(): void {
  records = [];
}

export interface TraceOptions {
  errKind?: CaptureQueueItem['errKind'];
  /** 걸러지기 전의 원문. 이 함수를 통과한 뒤에만 기록된다. */
  reason?: unknown;
  tries?: number;
  now?: Date;
}

/**
 * 캡처 여정 한 단계를 기록한다.
 *
 * 이 함수가 **캡처 항목을 읽는 유일한 자리**다. 여기서 열거하지 않은 필드는 로그에 존재할 수 없다 —
 * `event`, `note`, `memo`, `relSelf`, `relKairen`, `disp`, `quickName`, `researchInstruction`,
 * `images`, `err`는 절대 읽지 않는다.
 */
export function traceCapture(
  item: Pick<CaptureQueueItem, 'captureId' | 'capturedAt' | 'correlationId' | 'tries'>,
  event: TraceEvent,
  options: TraceOptions = {},
): TraceRecord {
  const record: TraceRecord = {
    ts: (options.now ?? new Date()).toISOString(),
    correlationId: correlationIdOf(item),
    captureId: item.captureId,
    event,
    tries: options.tries ?? item.tries ?? 0,
  };
  if (options.errKind === 'rejected' || options.errKind === 'ambiguous') record.errKind = options.errKind;
  const reason = redactReason(options.reason);
  if (reason) record.reason = reason;

  records.push(record);
  if (records.length > TRACE_LIMIT) records.splice(0, records.length - TRACE_LIMIT);
  return record;
}

/**
 * 한 캡처의 생애를 시간순으로 되짚는다 (생성 → 전송 시도 → 실패 분류 → 대조 → 접수).
 * 넘겨받은 기록만 읽는 순수 함수다.
 */
export function traceOf(correlationId: string, source: readonly TraceRecord[] = readTrace()): TraceRecord[] {
  return source.filter((record) => record.correlationId === correlationId);
}
