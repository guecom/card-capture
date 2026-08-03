// AI 조사 요청에서 "무엇을 조사할지"는 매번 새로 쓰는 글이 아니라 **고르는 항목**이다 (TSK-000536 / ISS-000082).
//
// founder 판정 2026-08-04: "AI 조사 요청에 모두 선택 버튼이 있으면 좋겠어. 모두 선택을 누르면은
// 실력, 전문성 추정, 의사 결정 권한 등 블록으로 돼 있는 것들을 모두 클릭하는 형태야.
// 비즈니스 미팅 등에서 만난 사람들을 등록할 때 보통 다 누르게 되더라고."
//
// 예전 `RESEARCH_EXAMPLE_CHIPS`는 누르면 자유 입력칸에 **글자를 덧붙이는** 예시였다. 그래서
// (a) 지금 무엇이 골라져 있는지 화면에 상태로 남지 않았고, (b) 한 번에 다 고르려면 여덟 번을
// 눌러야 했고, (c) 이미 적어 둔 문장 뒤에 쉼표로 붙어 문장이 망가졌다. 여기서는 항목을
// **켜고 끄는 상태**로 바꾸고, 자유 입력은 그대로 둔 채 둘을 합쳐 제출한다.
//
// 권한은 넓히지 않는다. `public-research-v1`의 mode는 `public_professional_background`이고
// 금지되는 민감 특성(정치성향·종교·성적 지향·건강·질병·인종)은 어떤 항목으로도 들어오지 않는다.
// 바뀐 것은 **표면**이지 계약이 아니다 (DEC-000035 유지).

export interface ResearchScope {
  /** 저장·비교에 쓰는 안정 키. 라벨을 바꿔도 이 값은 바뀌지 않는다. */
  key: string;
  /** 블록에 적히는 이름이자, 제출 문장에 그대로 들어가는 말 */
  label: string;
  /** 그 항목이 실제로 무엇을 묻는지 한 줄 */
  hint: string;
}

/**
 * 고를 수 있는 조사 항목.
 *
 * 목록의 출처는 이미 허용된 범위다 — `RESEARCH_SCOPE_DOES`(공개된 결과물을 근거로 한 직업적 판단)
 * 안에서만 고른다. 예전 예시 chip 여덟 개의 뜻을 그대로 옮기고, founder가 실제로 매번 원하는
 * `전문 분야`와 `대화 시작점`을 더했다.
 *
 * **순서가 계약이다.** 제출 문장의 항목 순서는 사용자가 누른 순서가 아니라 이 배열의 순서다 —
 * 같은 선택이면 언제나 같은 문장이 되어야 되풀이·중복 판정이 성립한다.
 */
export const RESEARCH_SCOPES: readonly ResearchScope[] = [
  { key: 'capability', label: '실력·역량 근거', hint: '공개된 결과물로 실력이 진짜인지' },
  { key: 'expertise', label: '전문 분야', hint: '어느 분야를 실제로 하는 사람인지' },
  { key: 'authority', label: '의사결정 권한·직급', hint: '실제로 결정할 수 있는 자리인지' },
  { key: 'reputation', label: '평판·레퍼런스', hint: '같이 일해 본 사람들의 공개 평가' },
  { key: 'recent', label: '최근 활동·발표', hint: '요즘 무엇을 하고 있는지' },
  { key: 'organization', label: '소속 조직·사업 맥락', hint: '회사가 지금 어디에 힘을 쓰는지' },
  { key: 'interest', label: '이해관계·경쟁 구도', hint: '우리와 이해가 맞는지 부딪치는지' },
  { key: 'overlap', label: '함께 아는 사람·접점', hint: '아는 사람이 겹치는지' },
  { key: 'opener', label: '대화 시작점', hint: '다음에 만나면 꺼낼 이야기' },
] as const;

/** 제출 문장 첫 줄의 표식. 사람이 읽어도 뜻이 통하는 말이어야 한다 — 기계용 토큰을 심지 않는다. */
export const RESEARCH_SCOPE_PREFIX = '조사 항목: ';
const SCOPE_SEPARATOR = ', ';

const LABEL_TO_KEY = new Map(RESEARCH_SCOPES.map((scope) => [scope.label, scope.key]));
const KEY_TO_SCOPE = new Map(RESEARCH_SCOPES.map((scope) => [scope.key, scope]));

/** 고른 항목 + 자유 입력. 화면이 다루는 단위다. */
export interface ResearchDraft {
  scopeKeys: string[];
  text: string;
}

export type ResearchSelectionState = 'none' | 'partial' | 'all';

/** 알 수 없는 키를 버리고, 중복을 없애고, 항상 `RESEARCH_SCOPES` 순서로 정렬한다. */
export function normalizeResearchScopeKeys(keys: readonly string[] | undefined): string[] {
  const wanted = new Set(keys ?? []);
  return RESEARCH_SCOPES.filter((scope) => wanted.has(scope.key)).map((scope) => scope.key);
}

export function researchScopeLabels(keys: readonly string[]): string[] {
  return normalizeResearchScopeKeys(keys).map((key) => KEY_TO_SCOPE.get(key)!.label);
}

/**
 * 고른 항목과 자유 입력을 **실제로 제출될 한 문장**으로 합친다.
 *
 * 규칙 두 가지가 전부다:
 *  1. 자유 입력은 절대 손대지 않는다. 다듬지도, 자르지도, 순서를 바꾸지도 않는다 —
 *     타이핑 도중의 공백까지 그대로 돌아와야 커서가 튀지 않는다.
 *  2. 고른 항목이 하나도 없으면 결과는 자유 입력 **그 자체**다. 그래야 이 기능이 생기기 전에
 *     저장된 2시간 유지 값이 그대로 자유 입력으로 되살아난다.
 */
export function composeResearchInstruction(draft: ResearchDraft): string {
  const labels = researchScopeLabels(draft.scopeKeys);
  const text = String(draft.text ?? '');
  if (!labels.length) return text;
  const head = `${RESEARCH_SCOPE_PREFIX}${labels.join(SCOPE_SEPARATOR)}`;
  return text ? `${head}\n${text}` : head;
}

/**
 * 합쳐진 문장을 다시 (고른 항목, 자유 입력)으로 되돌린다. `compose`의 정확한 역이다.
 *
 * 첫 줄이 표식으로 시작하고 **그 줄의 모든 조각이 아는 항목 이름일 때만** 항목으로 읽는다.
 * 하나라도 모르는 말이 섞이면 전부 자유 입력이다 — 사용자가 우연히 비슷하게 쓴 문장을
 * 항목으로 삼켜 버리지 않기 위해서다.
 *
 * 사용자가 정확히 이 형식을 손으로 적은 경우에는 항목으로 읽힌다. 그래도 `compose`가 같은
 * 문자열을 돌려주므로 잃는 글자는 없다 (멱등).
 */
export function decomposeResearchInstruction(value: string): ResearchDraft {
  const raw = String(value ?? '');
  if (!raw.startsWith(RESEARCH_SCOPE_PREFIX)) return { scopeKeys: [], text: raw };
  const breakAt = raw.indexOf('\n');
  const head = breakAt < 0 ? raw : raw.slice(0, breakAt);
  const rest = breakAt < 0 ? '' : raw.slice(breakAt + 1);
  const tokens = head.slice(RESEARCH_SCOPE_PREFIX.length).split(SCOPE_SEPARATOR).map((token) => token.trim());
  if (!tokens.length || tokens.some((token) => !LABEL_TO_KEY.has(token))) return { scopeKeys: [], text: raw };
  return {
    scopeKeys: normalizeResearchScopeKeys(tokens.map((token) => LABEL_TO_KEY.get(token)!)),
    text: rest,
  };
}

/** 항목 하나를 켜고 끈다. 자유 입력에는 손대지 않는다. */
export function toggleResearchScope(keys: readonly string[], key: string): string[] {
  const current = new Set(normalizeResearchScopeKeys(keys));
  if (current.has(key)) current.delete(key);
  else if (KEY_TO_SCOPE.has(key)) current.add(key);
  return normalizeResearchScopeKeys([...current]);
}

export function researchSelectionState(keys: readonly string[]): ResearchSelectionState {
  const count = normalizeResearchScopeKeys(keys).length;
  if (count === 0) return 'none';
  return count === RESEARCH_SCOPES.length ? 'all' : 'partial';
}

/**
 * `모두 선택` 한 번을 눌렀을 때의 다음 상태 (3단 토글).
 *
 * 아무것도 없음 → 전부. 일부만 → **전부**(비우지 않는다 — founder는 "다 누르게 된다"고 했다).
 * 전부 → 없음. 즉 이 버튼으로 비우는 길은 `전부`를 지날 때뿐이고, 일부 선택 상태에서 비우려면
 * 화면이 따로 내미는 `선택 지우기`를 쓴다.
 */
export function nextResearchScopeSelection(keys: readonly string[]): string[] {
  return researchSelectionState(keys) === 'all' ? [] : RESEARCH_SCOPES.map((scope) => scope.key);
}

/** 버튼에 적히는 말. 지금 상태의 사실이어야 한다 — `전부 골라진 상태의 모두 선택`은 거짓말이다. */
export function researchSelectAllLabel(keys: readonly string[]): string {
  return researchSelectionState(keys) === 'all' ? '모두 해제' : '모두 선택';
}

/** `9개 중 3개 선택`. 숫자는 언제나 읽을 수 있어야 한다. */
export function researchSelectionCountLabel(keys: readonly string[]): string {
  return `${RESEARCH_SCOPES.length}개 중 ${normalizeResearchScopeKeys(keys).length}개 선택`;
}

/** 토글 버튼의 `aria-pressed` 값. 일부 선택은 `mixed`다. */
export function researchSelectAllPressed(keys: readonly string[]): 'true' | 'false' | 'mixed' {
  const state = researchSelectionState(keys);
  return state === 'all' ? 'true' : state === 'none' ? 'false' : 'mixed';
}

/** 보낼 것이 있는가. 항목만 골라도, 글만 적어도 성립한다. */
export function researchDraftFilled(draft: ResearchDraft): boolean {
  return normalizeResearchScopeKeys(draft.scopeKeys).length > 0 || Boolean(draft.text.trim());
}

/**
 * 자유 입력칸에 남은 글자 예산.
 *
 * 합쳐진 문장이 2000자에서 잘리므로, 항목을 고를수록 자유 입력의 상한은 줄어야 한다.
 * 그러지 않으면 사용자가 다 적은 뒤 조용히 뒷부분이 잘린다.
 */
export const RESEARCH_INSTRUCTION_MAX = 2000;

export function researchTextBudget(scopeKeys: readonly string[]): number {
  const head = composeResearchInstruction({ scopeKeys: [...scopeKeys], text: '' });
  // 항목 줄과 그 뒤 줄바꿈 한 칸을 뺀 나머지가 자유 입력의 몫이다.
  return Math.max(0, RESEARCH_INSTRUCTION_MAX - (head ? head.length + 1 : 0));
}
