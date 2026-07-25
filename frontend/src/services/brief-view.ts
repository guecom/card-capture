// Legacy 브리핑 표시 규칙 포팅: 제목 정규화, 이름 매핑, 처리 단계 문구, 경과 시간, 오류 문구.
import type { BriefItem } from '../contracts/capture';

// 제목이 "이름 — 이런 분이에요" 또는 "이런 분이에요 — 이름" 어느 순서든 이름만 뽑는다 (계약 규칙 9).
export function nameFromBrief(brief?: string | null): string | null {
  if (!brief) return null;
  const firstLine = String(brief).split('\n')[0];
  if (!firstLine.startsWith('# ')) return null;
  const name = firstLine.slice(2)
    .replace(/이런\s*분이에요/g, '')
    .replace(/^[\s—\-–:·]+|[\s—\-–:·]+$/g, '')
    .trim();
  return name || null;
}

// 화면 제목은 항상 "이름 — 이런 분이에요" 순서로 재조립한다 (legacy renderBriefs 규칙).
export function briefTitle(item: BriefItem): string {
  if (item.brief && item.brief.startsWith('# ')) {
    const name = nameFromBrief(item.brief);
    return name ? `${name} — 이런 분이에요` : item.brief.split('\n')[0].slice(2);
  }
  if (item.type === 'note') return `메모 → ${item.person || '처리 중'}`;
  if (item.type === 'research_instruction') return `조사 지시 → ${item.person || '처리 중'}`;
  if (item.contact?.name) return `${item.contact.name} — 브리핑 준비 중`;
  if (item.quickName?.name) return `${item.quickName.name} — 이름 확인됨 · 조사 준비 중`;
  return item.event || item.captureId;
}

export function briefDisplayName(item: BriefItem): string | null {
  return nameFromBrief(item.brief) || item.contact?.name || item.quickName?.name || null;
}

// captureId → 표시 이름. 최근 캡처 목록이 처리 결과 이름을 보여주는 데 쓴다.
export function briefNameMap(items: BriefItem[]): Record<string, string> {
  const map: Record<string, string> = {};
  (items ?? []).forEach((item) => {
    const name = briefDisplayName(item);
    if (name) map[item.captureId] = name;
  });
  return map;
}

// receivedAt → capturedAt → captureId 순 폴백 (구서버 응답 호환, legacy elapsedMinOf).
export function elapsedMinutesOf(item: Pick<BriefItem, 'captureId' | 'capturedAt' | 'receivedAt'>, now = Date.now()): number | null {
  let timestamp = Date.parse(String(item.receivedAt ?? ''));
  if (Number.isNaN(timestamp)) timestamp = Date.parse(String(item.capturedAt ?? ''));
  if (Number.isNaN(timestamp)) {
    const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(String(item.captureId ?? ''));
    if (!match) return null;
    timestamp = new Date(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]).getTime();
  }
  if (Number.isNaN(timestamp)) return null;
  const minutes = Math.round((now - timestamp) / 60_000);
  return minutes >= 0 && minutes < 60 * 24 * 30 ? minutes : null;
}

export interface PendingProgress {
  text: string;
  late: boolean;
}

// 단계 표시: 1 이름 인식(OCR) → 2 웹 조사·정리 → 3 브리핑 도착. contact/quickName 존재 = 1단계 완료 신호.
export function pendingProgress(item: BriefItem, minutes: number | null): PendingProgress | null {
  if (item.status === 'processed' || item.status === 'skipped') return null;
  if (minutes === null) return null;
  const named = Boolean(item.contact?.name || item.quickName?.name);
  if (minutes > 30) {
    return {
      late: true,
      text: `${named ? '2/3단계 웹 조사·정리 중' : '1/3단계 이름 인식 중'} · ${minutes}분 경과 — 평소(6~20분)보다 오래 걸리고 있어요.`,
    };
  }
  if (!named) {
    return {
      late: false,
      text: `1/3단계 이름 인식(OCR) 중 · ${minutes}분 경과 · 이 단계는 보통 3분 안에 끝나요 · 다음: 웹 조사 → 브리핑`,
    };
  }
  const remain = Math.max(1, 14 - minutes);
  return {
    late: false,
    text: `2/3단계 웹 조사·기록 정리 중 (이름 인식 ✓) · ${minutes}분 경과 · 완료까지 약 ${remain}분 남음(추정, 보통 6~20분)`,
  };
}

const ERROR_COPY: Record<string, string> = {
  owner_only: '소유자 토큰만 사용할 수 있어요',
  unknown_action: '서버 업데이트(GAS 재배포) 후 가능해요',
  not_processed: '브리핑 도착 후 가능해요',
  feature_disabled: '이 기능이 잠시 꺼져 있어요',
  target_mismatch: '대상 Person이 일치하지 않아 접수하지 않았어요',
  invalid_token: '링크 토큰이 유효하지 않아요 — 받은 개인 링크로 다시 열어주세요',
  daily_limit: '오늘 요청 한도를 넘었어요 — 내일 다시 시도해 주세요',
  not_your_capture: '본인이 찍은 명함에만 쓸 수 있어요',
  not_found: '해당 캡처를 찾지 못했어요',
  empty_text: '내용을 적어주세요',
  server_error: '서버 오류 — 잠시 후 다시 시도해 주세요',
  doc_not_found: '프로필 문서를 찾지 못했어요',
  missing_api: '연결 설정(API 주소)이 필요해요',
  list_failed: '브리핑을 불러오지 못했어요 — 네트워크 확인',
  search_failed: '검색하지 못했어요 — 네트워크 확인',
  upload_failed: '업로드에 실패했어요 — 잠시 후 자동으로 다시 시도해요',
};

// 서버 오류 코드·네트워크 예외를 legacy처럼 한글 안내로 바꾼다.
export function actionErrorMessage(code: unknown): string {
  const raw = code instanceof Error ? code.message : String(code ?? '');
  if (!raw) return '요청에 실패했어요 — 다시 시도해 주세요';
  if (ERROR_COPY[raw]) return ERROR_COPY[raw];
  if (/failed to fetch|networkerror|load failed|network request failed|timeout/i.test(raw)) {
    return '네트워크 오류 — 연결 확인 후 다시 시도해 주세요';
  }
  return `요청 실패: ${raw}`;
}
