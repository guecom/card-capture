// 빠른 이름의 상태 문구 (FI-067).
//
// 이름을 모르는 것은 **정상 결과**다. 예전 문구는 못 읽은 결과를 `직접 확인해 주세요`,
// 지운 빈칸을 `이름을 입력해 주세요`라고 말해, 빈칸을 사용자가 아직 못 끝낸 숙제처럼 보이게 했다.
// 목록에서는 이름 없는 캡처가 `이름 인식 대기`로 남았는데, 인식은 이미 끝났으므로 사실이 아니다.
//
// 여기서 만드는 것은 **문구와 표시 규칙뿐**이다. 저장되는 진실은 지금과 같이 `quickName` 하나이며
// (모르면 `null`), `모름 / 나중에`를 눌렀다는 사실을 담는 숨은 필드나 두 번째 진실 원본을
// 만들지 않는다 — 그것은 업로드 payload와 워처 계약을 바꾸는 일이라 이 lane의 권한이 아니다.
import type { QuickName } from '../contracts/capture';

export type QuickNameStatus =
  /** 아직 인식을 시작하지 않았다. */
  | 'idle'
  /** 기기 안에서 읽고 있다. */
  | 'reading'
  /** 후보를 읽어냈다 — 사용자 확인이 남았다. */
  | 'read'
  /** 읽어내지 못했다. 실패가 아니라 "지금은 모른다"는 결과다. */
  | 'unreadable'
  /** 사용자가 직접 적었다. */
  | 'confirmed'
  /** 사용자가 칸을 비웠다. */
  | 'blank'
  /** 사용자가 `모름 / 나중에`를 명시적으로 골랐다. */
  | 'later';

export const QUICK_NAME_STATUS_COPY: Record<QuickNameStatus, string> = {
  idle: '이름 인식 대기',
  reading: '이름 읽는 중…',
  read: '인식 완료 · 확인해 주세요',
  unreadable: '이름을 못 읽었어요 · 지금 적어도 되고 나중에 해도 돼요',
  confirmed: '직접 확인됨',
  blank: '이름 없이 저장해도 괜찮아요',
  later: '이름은 나중에 · 사진과 맥락으로 정리해요',
};

/** 모른다고 명시하는 선택지. 비워 두는 것과 결과는 같지만, 고를 수 있어야 정상 결과가 된다. */
export const QUICK_NAME_LATER_LABEL = '모름 / 나중에';

/** 이름을 아직 모르는 캡처의 목록 표시. `대기`는 거짓이다 — 기다리고 있는 처리가 없다. */
export const UNKNOWN_NAME_LABEL = '이름 미정';

export function quickNameReadingCopy(progress?: number): string {
  return typeof progress === 'number' ? `이름 읽는 중 ${progress}%` : QUICK_NAME_STATUS_COPY.reading;
}

/** 대기열·기록 행에 쓸 이름. 처리된 이름 → 촬영 때 확인한 이름 → `이름 미정` 순. */
export function queueRowName(processedName: string | undefined, quickName: QuickName | null | undefined): string {
  return (processedName ?? '').trim() || (quickName?.name ?? '').trim() || UNKNOWN_NAME_LABEL;
}
