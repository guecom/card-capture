// 촬영 화면의 `만남 맥락` — 예전 이름은 `기억할 맥락` (INT-000015 Feedback item 001).
//
// founder 판정 2026-07-26: "기억할 맥락, 여기 어디서 만났는지 뭐 막 요런 박스들하고 적혀있는
// 말들 있잖아. 이거 시인성 좀 많이 떨어져서 좀 아쉽고."
//
// 문제는 필드 수가 아니라 위계였다. 네 칸이 같은 무게로 쌓이고 칸마다 `(선택, 2시간 유지)`가
// 반복돼, 무엇을 왜 적는지가 안 읽히고 촬영 버튼이 화면 아래로 밀렸다.
// 그래서 (a) 안내는 영역 위에 한 번만, (b) 자주 쓰는 답은 chip으로, (c) 입력이 생기면
// 한 줄 요약으로 접는다.
import type { BriefItem } from '../contracts/capture';

export interface CaptureContextValue {
  event: string;
  relKairen: string;
  relSelf: string;
  memo: string;
}

/** 처음 만나는 자리에서 실제로 자주 쓰는 답. 직접 입력을 대체하지 않고 먼저 제안만 한다. */
export const KAIREN_RELATION_CHIPS = ['잠재 고객', '부품 공급사', '협력사', '투자자', '채용 후보'] as const;
export const SELF_RELATION_CHIPS = ['오늘 처음', '소개로 만남', '예전 동료', '학교 선후배'] as const;

function clean(value: string | undefined): string {
  return String(value ?? '').trim();
}

export function captureContextFilled(value: CaptureContextValue): number {
  return [value.event, value.relKairen, value.relSelf, value.memo].filter((entry) => clean(entry)).length;
}

// 접힌 상태에서 보여 줄 한 줄. 저장될 내용을 그대로 요약한다 — 새로 지어내지 않는다.
export function captureContextSummary(value: CaptureContextValue): string {
  const parts: string[] = [];
  if (clean(value.event)) parts.push(clean(value.event));
  if (clean(value.relKairen)) parts.push(`Kairen: ${clean(value.relKairen)}`);
  if (clean(value.relSelf)) parts.push(`나: ${clean(value.relSelf)}`);
  const memo = clean(value.memo);
  if (memo) parts.push(memo.length > 18 ? `메모 ${memo.slice(0, 18).trimEnd()}…` : `메모 ${memo}`);
  return parts.join(' · ');
}

// 최근에 실제로 입력한 만난 곳을 chip으로 되돌려 준다. 같은 행사에서 여러 장을 찍는 게 보통이다.
export function recentEventChips(briefs: BriefItem[], current = '', limit = 4): string[] {
  const seen: string[] = [];
  for (const item of briefs ?? []) {
    const event = clean(item.event);
    if (!event || event === clean(current)) continue;
    if (seen.includes(event)) continue;
    seen.push(event);
    if (seen.length >= limit) break;
  }
  return seen;
}

// chip은 켜고 끄는 토글이다 — 이미 그 값이면 비우고, 아니면 그 값으로 바꾼다.
export function toggleChipValue(current: string, chip: string): string {
  return clean(current) === chip ? '' : chip;
}
