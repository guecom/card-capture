// AI에게 맡긴 일이 지금 어디까지 왔는지를 앱 전체에서 같은 문법으로 보여 준다 (INT-000015).
//
// founder 판정 2026-07-26: "조사 지시는 사실 AI한테 시키는 거잖아. 에이전틱한 기능이라는 걸
// 직관적으로 알 수 있었으면 해." / "찾고 있는 건지, 그동안 뭘 하는 건지 하나도 모르겠거든."
//
// 규칙 두 가지:
//  1. 단계는 실제로 일어나는 일이어야 한다. 진행 막대를 시간으로 채우는 가짜 단계를 만들지 않는다.
//  2. 남은 시간은 실측이 쌓이기 전에는 숫자로 말하지 않는다. 대신 현재 단계와 경과 시간을 보여 준다.

export type AiStageState = 'done' | 'active' | 'todo';

export interface AiStage {
  key: string;
  /** 단계 막대에 붙는 짧은 이름 */
  label: string;
  /** 그 단계일 때 화면 위쪽에 쓰는 한 문장 */
  headline: string;
  state: AiStageState;
}

function build<K extends string>(
  definitions: ReadonlyArray<{ key: K; label: string; headline: string }>,
  active: K,
): AiStage[] {
  const index = definitions.findIndex((definition) => definition.key === active);
  const at = index < 0 ? 0 : index;
  return definitions.map((definition, position) => ({
    key: definition.key,
    label: definition.label,
    headline: definition.headline,
    state: position < at ? 'done' : position === at ? 'active' : 'todo',
  }));
}

// ── 조사 지시 (owner-only public-research-v1) ──
// 권한은 넓히지 않는다. 보이는 것만 "AI가 맡은 일"로 정직하게 바꾼다.

export type ResearchStageKey = 'draft' | 'received' | 'searching' | 'sourcing' | 'done';

const RESEARCH_STAGES = [
  { key: 'draft', label: '작성 중', headline: '무엇을 확인할지 적어 주세요' },
  { key: 'received', label: '접수됨', headline: '요청을 접수했어요' },
  { key: 'searching', label: '공개 자료 조사 중', headline: '공개 자료를 찾고 있어요' },
  { key: 'sourcing', label: '출처 정리 중', headline: '출처와 확신도를 정리하고 있어요' },
  { key: 'done', label: '완료', headline: '조사 결과가 인물 기록에 반영됐어요' },
] as const satisfies ReadonlyArray<{ key: ResearchStageKey; label: string; headline: string }>;

export function researchStages(active: ResearchStageKey): AiStage[] {
  return build(RESEARCH_STAGES, active);
}

// 조사 지시가 무엇을 하고 무엇을 안 하는지. 화면에 그대로 보여 준다 (DEC-000035).
//
// 경계를 정확히 읽는 것이 중요하다. `public-research-v1`의 mode는 `public_professional_background`이고,
// 금지되는 `민감 특성`은 정치성향·종교·성적 지향·건강·질병·인종이다. **공개된 결과물을 근거로 한
// 직업적 판단(실력·권한·평판)은 금지 대상이 아니다.** founder 지시 2026-07-27: "실력 추정 집어넣어.
// 이런 것처럼 민감하지만 진짜로 필요한 것들을 과감하게 집어넣어."
//
// 그래서 넓힌 것은 권한이 아니라 **요청 예시와 문구**다. 판단을 하되 근거·확신도를 붙이고 모르는 건
// 모른다고 남기는 것이 원래 계약(`report_sources_confidence_and_unknowns`)이다.
export const RESEARCH_SCOPE_DOES = '공개된 결과물(경력·논문·특허·발표·제품·기사·평가)을 근거로 판단까지 합니다. 근거와 확신도를 함께 적고, 모르는 건 모른다고 남겨요.';
export const RESEARCH_SCOPE_LIMITS = '로그인이 필요한 자료, 정치·종교·건강 같은 사적 특성, 집주소·가족 같은 신상, 외부로 보내는 행동은 하지 않아요.';

/** 요청 예시. 묻기 껄끄럽지만 실제로 필요한 판단을 먼저 꺼내 놓는다. */
export const RESEARCH_EXAMPLE_CHIPS = [
  '실력·전문성 추정',
  '의사결정 권한',
  '평판·레퍼런스',
  '최근 성과와 실패',
  '이해관계·경쟁 관계',
  '최근 경력·이직',
  '회사 소식·투자',
  '나와의 접점',
] as const;

/** 무엇을 맡길 수 있는지 한 문장으로 보여 주는 기본 예시. */
export const RESEARCH_PLACEHOLDER = '예: 이 사람 실력이 진짜인지 공개된 결과물로 판단해줘. 실제로 결정 권한이 있는 자리인지도.';

// ── AI 사람 찾기 (기기 안 회상 검색) ──

export type RecallStageKey = 'parse' | 'match' | 'rank' | 'done';

export function recallStages(active: RecallStageKey, recordCount: number): AiStage[] {
  return build([
    { key: 'parse', label: '단서 해석', headline: '말한 단서를 해석하고 있어요' },
    { key: 'match', label: '기록 대조', headline: `이 기기에 있는 기록 ${recordCount}건을 대조하고 있어요` },
    { key: 'rank', label: '후보 정리', headline: '가능성 높은 후보부터 정리하고 있어요' },
    { key: 'done', label: '완료', headline: '후보를 정리했어요' },
  ] as const satisfies ReadonlyArray<{ key: RecallStageKey; label: string; headline: string }>, active);
}

/** 회상 검색이 실제로 하는 일. `AI 사람 찾기`가 무엇을 하는 기능인지 오해하지 않게 한다. */
export const RECALL_SCOPE_NOTE = '문장은 이 기기 안에서만 대조해요. 밖으로 보내지 않습니다.';

// 남은 시간을 지어내지 않는다 — 대신 "얼마나 지났는지"를 정직하게 센다.
export function elapsedLabel(milliseconds: number): string {
  const seconds = Math.max(0, milliseconds) / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}초`;
  if (seconds < 60) return `${Math.round(seconds)}초`;
  return `${Math.floor(seconds / 60)}분 ${Math.round(seconds % 60)}초`;
}
