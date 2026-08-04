// 캡처 진입 카드의 순서·해부(anatomy)와 만남 맥락의 초대 강도 — Kairen-Ref: TSK-000220
//
// founder 판정 (INT-000030 / DEC-000105):
//   "캡처 페이지에 명함 촬영, 직접 입력, 구도는 좋아. 근데 하나는 설명이 있고 하나는 없고
//    그래서 시각적으로 뭔가 통일감이 떨어져."
//
// 원인은 카드가 **각자 무엇을 그릴지 정했다**는 것이다. 한쪽은 제목만, 다른 쪽은 제목+보조문구,
// 초안이 있으면 그 보조문구 자리를 상태 뱃지가 차지해 설명이 사라졌다. 그래서 화면이
// "부품을 모아 붙인 것"으로 읽혔다.
//
// 이 파일은 그것을 **구조적으로 불가능하게** 만든다: 모든 카드는 여기서 정확히 같은 네 줄을
// 받는다(아이콘 · 제목 · 한 줄 outcome · 행동 affordance). 하나라도 비면 여기서 메우고,
// 상태 뱃지는 설명 자리를 절대 빼앗지 않는 **다섯 번째 자리**로 분리된다.
//
// 그리기(anatomy를 화면에 얹는 일)는 `components/CaptureEntry.tsx`가 하고,
// 가용성 판정(무엇이 available인가)은 `services/device-capability.ts`(TSK-000545)가 한다.
// 이 파일은 둘 사이의 규칙만 소유한다 — DOM도 React도 모른다.

import type { CaptureMethodCard, CaptureMethodId, CaptureMethodRecovery } from '../contracts/int30';

/**
 * 카드가 놓이는 순서. **앱 전체에서 이 값 하나만 순서를 정한다** —
 * 생산자(`services/device-capability.ts`)의 `captureMethodOrder()`도 이 배열을 되읽는다.
 *
 * `camera`와 `manual`이 **붙어 있어야 한다.** 둘이 같은 줄·같은 크기라는 것이 founder 결정
 * (INT-000029 / DEC-000103)이고, 기존 회귀 게이트도 그 인접성을 잰다.
 *
 * 통합 판정(TSK-000220 + TSK-000545): PC에서는 `upload`가 가장 쓸모 있는 입구라는 관찰이
 * 있었고 생산자 초안은 PC 순서를 `upload, camera, manual`로 두었다. 하지만 칸이 2개인 grid에서
 * 그 순서는 첫 줄을 `upload`·`camera`로 만들고 **`직접 입력`을 둘째 줄로 밀어낸다.** 위계가
 * 같다는 사실이 화면에서 먼저 깨지는 쪽을 택할 수는 없다. 그래서 순서는 기기와 무관하게 하나로
 * 두고, PC에서의 `upload` 발견 가능성은 순서가 아니라 **면적**으로 갚는다 — 카드가 셋이면
 * 마지막 카드가 두 칸을 가로질러(`int30-capture.css`) 화면에서 가장 넓은 카드가 된다.
 *
 * 알 수 없는 id는 버리지 않고 맨 뒤에 원래 순서대로 붙인다. 조용히 사라진 입구는
 * "이유 없이 없는 버튼"이 되고, 그것이 이 표면이 가장 피하려는 결과다.
 */
export const CAPTURE_METHOD_ORDER: readonly CaptureMethodId[] = ['camera', 'manual', 'upload'];

/**
 * 카드 하나가 실제로 그리는 것. 필드가 전부 채워져 있고, 어느 카드도 예외가 없다.
 *
 * `status`는 진행 감각(초안 있음·앞면 담김)을 나르는 자리다. 비어 있어도 줄이 사라지지 않게
 * 컴포넌트가 자리를 유지하므로, 여기서는 있으면 있는 대로 넘긴다.
 */
export interface CaptureCardAnatomy {
  id: CaptureMethodId;
  title: string;
  /** 한 줄 outcome. 절대 빈 문자열이 되지 않는다. */
  outcome: string;
  /** 행동 affordance 문구. 카드가 눌리는 자리임을 말한다. */
  action: string;
  /** 진행 상태 한 조각. 없으면 빈 문자열이고, 설명 자리를 대체하지 않는다. */
  status: string;
  available: boolean;
  /** available=false일 때만 채워진다. */
  reason: string;
  recovery: CaptureMethodRecovery | null;
}

/** 카드가 눌렸을 때 무엇이 열리는지. 모든 카드가 하나씩 갖는다 — 없는 카드를 만들지 않는다. */
export const CAPTURE_METHOD_ACTION: Record<CaptureMethodId, string> = {
  camera: '카메라 열기',
  manual: '적기 시작',
  upload: '사진 고르기',
};

/**
 * 생산자가 설명을 비워 보냈을 때 쓰는 최후의 한 줄.
 *
 * 이 값이 쓰이는 것은 계약 위반(설명은 필수)이지만, 그때 화면에 빈 줄을 남기면 정확히
 * founder가 지적한 "하나는 설명이 있고 하나는 없고"가 다시 생긴다. 사고가 나도 통일감은 유지한다.
 */
export const CAPTURE_METHOD_FALLBACK_OUTCOME: Record<CaptureMethodId, string> = {
  camera: '찍으면 정리·브리핑까지 이어져요',
  manual: '명함이 없어도 기억으로 등록해요',
  upload: '갤러리에 있는 명함 사진으로 등록해요',
};

/** 회복 버튼 문구가 비어 왔을 때의 기본값. 행동 없는 안내만 남는 상태를 만들지 않는다. */
export const CAPTURE_RECOVERY_FALLBACK_LABEL: Record<CaptureMethodRecovery['kind'], string> = {
  permission: '권한 다시 요청',
  setup: '설정 열기',
  help: '다른 방법 보기',
};

/** 못 쓰는 이유가 비어 왔을 때. 사라진 이유보다 모호한 이유가 낫다 — 최소한 물어볼 수는 있다. */
export const CAPTURE_UNAVAILABLE_FALLBACK_REASON = '이 기기에서는 지금 쓸 수 없어요';

function clean(value: string | undefined | null): string {
  return String(value ?? '').trim();
}

function isKnownMethod(id: string): id is CaptureMethodId {
  return (CAPTURE_METHOD_ORDER as readonly string[]).includes(id);
}

/**
 * 화면에 놓일 순서로 정렬한다. 같은 id가 두 번 오면 처음 것만 남는다 —
 * 중복 카드는 grid의 칸 수를 바꿔 두 입구가 같은 줄에 있다는 계약을 깬다.
 */
export function orderCaptureMethods(methods: readonly CaptureMethodCard[]): CaptureMethodCard[] {
  const seen = new Set<string>();
  const unique = methods.filter((card) => {
    if (seen.has(card.id)) return false;
    seen.add(card.id);
    return true;
  });
  const known = CAPTURE_METHOD_ORDER
    .map((id) => unique.find((card) => card.id === id))
    .filter((card): card is CaptureMethodCard => Boolean(card));
  const unknown = unique.filter((card) => !isKnownMethod(card.id));
  return [...known, ...unknown];
}

/**
 * 카드 하나를 "그릴 수 있는 네 줄"로 바꾼다.
 *
 * 규칙은 셋이다:
 *  1. outcome과 action은 절대 비지 않는다.
 *  2. `available=true`인 카드는 이유를 갖지 않는다 — 남아 있던 옛 이유가 정상 카드에 붙어
 *     "왜 안 되지?"를 만드는 일을 막는다.
 *  3. `available=false`인 카드는 이유를 갖고, recovery가 있으면 그 문구도 반드시 있다.
 */
export function captureCardAnatomy(
  card: CaptureMethodCard,
  options: { status?: string } = {},
): CaptureCardAnatomy {
  const id = card.id;
  const fallbackOutcome = CAPTURE_METHOD_FALLBACK_OUTCOME[id] ?? '';
  const recovery = card.recovery
    ? {
      kind: card.recovery.kind,
      label: clean(card.recovery.label) || CAPTURE_RECOVERY_FALLBACK_LABEL[card.recovery.kind],
    }
    : null;
  return {
    id,
    title: clean(card.title),
    outcome: clean(card.description) || fallbackOutcome,
    action: CAPTURE_METHOD_ACTION[id] ?? '열기',
    status: clean(options.status),
    available: card.available,
    reason: card.available ? '' : (clean(card.unavailableReason) || CAPTURE_UNAVAILABLE_FALLBACK_REASON),
    recovery: card.available ? null : recovery,
  };
}

/**
 * grid 열 수.
 *
 * 두 칸이 기본이다. 카드가 하나뿐이면 한 칸 — 홀로 남은 카드를 반만 그리면 잘린 것처럼 보인다.
 * 셋 이상이어도 두 칸을 유지한다: `camera`·`manual`이 첫 줄에 나란히 있어야 한다는 계약이
 * 칸 수보다 먼저다. 남는 마지막 카드는 CSS가 두 칸을 가로질러 채운다.
 */
export function captureMethodColumns(count: number): number {
  return count <= 1 ? 1 : 2;
}

/* ── 만남 맥락: 강제가 아니라 초대 ─────────────────────────────────────────
   founder 판정: "이거 작성해야 엄청 좋은건데 왠지 작성해야 할 것 같은 느낌(설명보다
   직관적으로)이 들면 좋겠어."

   그래서 이 영역이 쓸 수 있는 수단과 쓰면 안 되는 수단을 값으로 갈라 둔다.
   쓸 수 있는 것: 작성 면적, 또렷한 focus, 짧은 예시, 채워질수록 켜지는 진행 감각.
   쓰면 안 되는 것: 필수 표식, 오류색, 못 넘어가게 막는 검증, 긴 설명. */

/** 만남 맥락이 세는 칸 수 — 어디서·Kairen 관계·나와의 관계·메모. */
export const CONTEXT_FIELD_TOTAL = 4;

export interface ContextWeight {
  /** 실제로 채워진 칸 수. */
  filled: number;
  total: number;
  /** 진행 rail이 그릴 칸들. 길이는 언제나 `total`이라 rail의 폭이 흔들리지 않는다. */
  segments: boolean[];
  /** 아직 아무것도 없음 / 쓰기 시작함 / 충분히 적음. 색이 아니라 **세기**를 고르는 값이다. */
  tone: 'empty' | 'started' | 'rich';
}

/**
 * 지금 얼마나 적혔는가.
 *
 * `rich`는 "다 채웠다"가 아니라 **두 칸 이상**이다. 네 칸을 다 요구하면 그 순간 필수가 되고,
 * 이 영역은 끝까지 선택이어야 한다. 두 칸이면 나중에 이 사람을 떠올리기에 충분하다는 것이
 * 이 판정의 근거다.
 */
export function contextWeight(filled: number, total: number = CONTEXT_FIELD_TOTAL): ContextWeight {
  const safeTotal = Math.max(0, Math.trunc(total));
  const safeFilled = Math.min(Math.max(0, Math.trunc(filled)), safeTotal);
  return {
    filled: safeFilled,
    total: safeTotal,
    segments: Array.from({ length: safeTotal }, (_unused, index) => index < safeFilled),
    tone: safeFilled === 0 ? 'empty' : safeFilled >= 2 ? 'rich' : 'started',
  };
}

/**
 * 이 영역에서 금지된 어휘.
 *
 * 화면 문구가 여기 있는 말을 쓰기 시작하면 "적어도 되는 칸"이 "적어야 하는 칸"으로 바뀐다.
 * 사람의 눈으로만 지키면 반드시 새므로 테스트가 이 목록으로 실제 문구를 검사한다.
 */
export const CONTEXT_PRESSURE_WORDS: readonly string[] = ['필수', '반드시', '입력하세요', '오류', '누락', '경고', 'required'];

/** 문구가 강제 없이 초대하고 있는가. 하나라도 걸리면 false. */
export function isCalmInvite(text: string): boolean {
  const lowered = clean(text).toLowerCase();
  if (!lowered) return true;
  if (lowered.includes('*')) return false;
  return !CONTEXT_PRESSURE_WORDS.some((word) => lowered.includes(word.toLowerCase()));
}

/** 만남 맥락 chip 줄 앞에 붙는 짧은 affordance. 설명이 아니라 이름표다. */
export const CONTEXT_EXAMPLE_LABEL = '예시';
