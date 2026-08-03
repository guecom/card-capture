// AI에게 맡긴 일이 지금 어디까지 왔는지를 앱 전체에서 같은 문법으로 보여 준다 (INT-000015).
//
// founder 판정 2026-07-26: "조사 지시는 사실 AI한테 시키는 거잖아. 에이전틱한 기능이라는 걸
// 직관적으로 알 수 있었으면 해." / "찾고 있는 건지, 그동안 뭘 하는 건지 하나도 모르겠거든."
//
// 규칙 두 가지:
//  1. 단계는 실제로 일어나는 일이어야 한다. 진행 막대를 시간으로 채우는 가짜 단계를 만들지 않는다.
//  2. 남은 시간은 실측이 쌓이기 전에는 숫자로 말하지 않는다. 대신 현재 단계와 경과 시간을 보여 준다.

import type { BriefItem, ResearchProgressPhase } from '../contracts/capture';
import { researchPhaseLabel, researchPhaseOf } from './research-vocabulary';
import {
  type StageSighting,
  type StageStat,
  type StageTelemetry,
  loadStageTelemetry,
  observeStages,
  saveStageTelemetry,
  stageStat,
} from './stage-telemetry';
import { type StageWeighting, weightStages } from './stage-weights';

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

// ── 서버 phase → rail 단계 (INT-000025) ──
//
// 반려 근거: `공개 자료 조사 중`·`출처 정리 중`은 rail에 있지만 **어떤 서버 필드도 그 단계를
// 증명하지 않아** 실제로는 `작성 중`과 `접수됨`만 켜졌다. 도달하지 못하는 칸이 둘 있는 막대는
// founder가 말한 "실질적으로 의미 없음"의 절반이다.
//
// 지우는 것은 답이 아니다 — 칸을 줄이면 막대는 더 말이 없어진다. 서버는 이미
// `researchProgress.phase`로 `planning|branching|triangulating|synthesizing|done`을 준다.
// 그 어휘를 rail에 **매핑**해서 다섯 칸을 전부 실제 상태로 만든다.
//
// `triangulating`(여러 출처 교차 확인)과 `synthesizing`(정리)은 둘 다 `출처 정리 중`이다.
// 서버 단계를 더 잘게 보여 주려고 rail 칸을 늘리지 않는다 — 칸의 수는 사람이 기다리는 단위지
// 서버 구현 단위가 아니다. 더 잘게 알고 싶은 사람에게는 `phaseLabel`을 따로 준다.
export const RESEARCH_PHASE_TO_STAGE: Readonly<Record<ResearchProgressPhase, ResearchStageKey>> = {
  planning: 'received',
  branching: 'searching',
  triangulating: 'sourcing',
  synthesizing: 'sourcing',
  done: 'done',
};

/** rail이 지금 단계를 무엇으로 증명했는가. `receipt_only`면 세부 단계를 아는 척하지 않는다. */
export type ResearchRailProof = 'phase' | 'terminal_status' | 'receipt_only' | 'local_draft';

export interface ResearchRailView {
  stages: AiStage[];
  stage: ResearchStageKey;
  /** 서버가 준 단계 원문. 없으면 null. */
  phase: ResearchProgressPhase | null;
  /** 그 단계의 한국어 이름. 없으면 null — 영어 enum을 화면으로 흘리지 않는다. */
  phaseLabel: string | null;
  proof: ResearchRailProof;
  /** 서버가 단계를 마지막으로 갱신했다고 말한 시각(ISO). 없으면 null. */
  updatedAt: string | null;
  /**
   * 왜 여기까지만 아는지 한 문장. 증명된 단계에서는 null이다.
   * 이 문장이 있으면 막대가 멈춘 것이 아니라 **모르는 것**이라는 뜻이다.
   */
  note: string | null;
}

const RECEIPT_ONLY_NOTE = '이 서버는 세부 단계를 알려주지 않아 접수까지만 확인했어요 · 완료되면 결과로 알려 드려요';

function railOf(stage: ResearchStageKey, proof: ResearchRailProof, phase: ResearchProgressPhase | null, updatedAt: string | null): ResearchRailView {
  return {
    stages: researchStages(stage),
    stage,
    phase,
    phaseLabel: phase ? researchPhaseLabel(phase) : null,
    proof,
    updatedAt,
    note: proof === 'receipt_only' ? RECEIPT_ONLY_NOTE : null,
  };
}

/** 서버 phase 하나만으로 rail을 만든다 (순수 함수). 모르는 값이면 `접수됨`에서 멈춘다. */
export function researchRailForPhase(phase: unknown, updatedAt: string | null = null): ResearchRailView {
  const known = researchPhaseOf(phase);
  if (!known) return railOf('received', 'receipt_only', null, updatedAt);
  return railOf(RESEARCH_PHASE_TO_STAGE[known], 'phase', known, updatedAt);
}

/**
 * 조사 receipt 하나의 rail. 서버가 증명한 것만 단계로 인정한다.
 *
 * - `researchProgress.phase`가 있으면 그 단계까지 켠다.
 * - phase가 없어도 `processed`/`skipped`면 완료는 서버가 증명한 사실이다.
 * - 둘 다 없으면 `접수됨`까지만 켜고, 왜 거기서 멈췄는지 `note`로 말한다.
 *   막대가 얼어붙은 것처럼 보이지 않게 하는 것이 이 문장의 일이다.
 */
export function researchRailFromBrief(brief?: BriefItem | null): ResearchRailView {
  if (!brief) return railOf('draft', 'local_draft', null, null);
  const updatedAt = typeof brief.researchProgress?.updatedAt === 'string' ? brief.researchProgress.updatedAt : null;
  const phase = researchPhaseOf(brief.researchProgress?.phase);
  if (phase) return railOf(RESEARCH_PHASE_TO_STAGE[phase], 'phase', phase, updatedAt);
  if (brief.status === 'processed' || brief.status === 'skipped') return railOf('done', 'terminal_status', null, updatedAt);
  return railOf('received', 'receipt_only', null, updatedAt);
}

// ── 조사 rail의 관측 (DEC-000092 §1~2를 조사 표면까지) ────────────────────────
//
// 캡처 rail만 관측하면 조사 rail은 표본이 0이라 **영구히 균등 폭**이다. 관측 장치를 만들어 놓고도
// 조사 화면의 막대는 반려 당시 그대로인 셈이라, 여기까지 와야 §3.2가 실제로 지켜진다.
//
// 저장 자리는 캡처 관측과 같은 subject namespace 키(`stageDurations`) 하나다. 단계 이름만
// `research:` 접두사로 갈라 둔다 — 두 rail의 `received`/`receive`, `done`이 같은 통에서 섞이면
// 몇 분짜리 조사 시간이 몇 초짜리 캡처 단계의 중앙값을 끌고 간다.

const RESEARCH_STAGE_ORDER = RESEARCH_STAGES.map((definition) => definition.key);

/** rail이 그리는 다섯 칸. 폭 계산에 그대로 넣는 키다. */
export const RESEARCH_STAGE_KEYS: ReadonlyArray<ResearchStageKey> = RESEARCH_STAGE_ORDER;

/**
 * **기다림이 아니라 막대의 양 끝 경계인 칸.**
 *
 * `draft`는 제출 전 기기 상태다 — 서버로 간 적이 없어 어떤 상태 전이로도 관측되지 않고,
 * 관측하더라도 그것은 사람이 글을 쓴 시간이지 사람이 **기다린** 시간이 아니다.
 * `done`은 종료 표시다 — 뒤에 아무것도 없으므로 소요시간이 정의되지 않는다.
 *
 * 이 둘을 "아직 표본이 모자란 칸"으로 세면 `n>=3`을 영원히 못 채워 조사 rail이 균등 폭에 갇힌다.
 * 그래서 `weightStages`에 marker로 넘겨 가독 하한만 주고 confident 판정에서 뺀다.
 */
export const RESEARCH_MARKER_STAGE_KEYS: ReadonlyArray<ResearchStageKey> = ['draft', 'done'];

/** 실제로 관측되는 대기 칸: 접수됨 · 공개 자료 조사 중 · 출처 정리 중. */
export const RESEARCH_MEASURED_STAGE_KEYS: ReadonlyArray<ResearchStageKey> = ['received', 'searching', 'sourcing'];

const RESEARCH_TELEMETRY_PREFIX = 'research:';
const researchTelemetryKey = (stage: string): string => `${RESEARCH_TELEMETRY_PREFIX}${stage}`;
const RESEARCH_TELEMETRY_ORDER = RESEARCH_STAGE_ORDER.map(researchTelemetryKey);

/**
 * 목록 한 번에서 뽑은 조사 단계 관측.
 *
 * **서버 phase로 증명된 상태만 관측한다.** phase를 주지 않는 서버에서는 `접수됨`에 머물다가
 * 완료로 건너뛰는데, 그것은 "조사가 순식간이었다"가 아니라 "우리가 못 봤다"이다. 그 구간을
 * 표본으로 삼으면 `공개 자료 조사 중` 칸이 0ms로 굳어 막대가 거짓말을 한다.
 * 다만 phase로 지켜보던 중에 종료 상태가 오면 그 마지막 구간은 닫아 준다 — 완료는 서버가 증명한다.
 */
export function researchStageSightings(
  briefs: ReadonlyArray<BriefItem> | null | undefined,
  watching: Readonly<Record<string, unknown>> = {},
): StageSighting[] {
  const sightings: StageSighting[] = [];
  for (const item of briefs ?? []) {
    if (!item?.captureId) continue;
    const rail = researchRailFromBrief(item);
    const id = researchTelemetryKey(item.captureId);
    const observable = rail.proof === 'phase'
      || (rail.proof === 'terminal_status' && Object.prototype.hasOwnProperty.call(watching, id));
    if (!observable) continue;
    sightings.push({ id, stage: researchTelemetryKey(rail.stage), rank: RESEARCH_STAGE_ORDER.indexOf(rail.stage) });
  }
  return sightings;
}

/** 목록 한 번을 조사 telemetry에 반영한다 (순수 함수). */
export function recordResearchStageObservations(input: {
  telemetry: StageTelemetry;
  briefs?: ReadonlyArray<BriefItem> | null;
  now: number;
}): { telemetry: StageTelemetry; changed: boolean } {
  const observed = observeStages({
    telemetry: input.telemetry,
    sightings: researchStageSightings(input.briefs, input.telemetry.watch),
    now: input.now,
    order: RESEARCH_TELEMETRY_ORDER,
  });
  return { telemetry: observed.telemetry, changed: observed.changed };
}

/** 저장된 조사 관측을 rail 키로 되돌려 읽는다. 저장은 접두사, 화면은 rail 키다. */
export function researchStageStats(telemetry: StageTelemetry = loadStageTelemetry()): Record<string, StageStat | null> {
  const summary: Record<string, StageStat | null> = {};
  for (const key of RESEARCH_STAGE_ORDER) {
    const stat = stageStat(telemetry, researchTelemetryKey(key));
    summary[key] = stat ? { ...stat, stage: key } : null;
  }
  return summary;
}

/**
 * 목록을 새로 받을 때마다 호출한다. 조사 관측을 저장하고 지금 쓸 단계 요약을 돌려준다.
 * 실제로 바뀐 것이 있을 때만 저장한다 — 4초 폴링마다 localStorage를 쓰지 않기 위해서다.
 */
export function syncResearchStageTelemetry(input: {
  briefs?: ReadonlyArray<BriefItem> | null;
  now?: number;
}): Record<string, StageStat | null> {
  const result = recordResearchStageObservations({
    telemetry: loadStageTelemetry(),
    briefs: input.briefs,
    now: input.now ?? Date.now(),
  });
  if (result.changed) saveStageTelemetry(result.telemetry);
  return researchStageStats(result.telemetry);
}

/**
 * 조사 rail 다섯 칸의 폭. marker 두 칸을 자동으로 빼 주므로 화면은 이것만 부르면 된다.
 * `weightStages`를 직접 부르면 `draft`·`done` 때문에 영원히 `confident:false`가 된다.
 */
export function researchStageWeighting(stats: Readonly<Record<string, StageStat | null | undefined>>): StageWeighting {
  return weightStages(RESEARCH_STAGE_KEYS, stats, { markers: RESEARCH_MARKER_STAGE_KEYS });
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

// 요청 예시 등록소는 `research.ts`의 `RESEARCH_FOCUS_OPTIONS` 하나다.
// 여기 있던 `RESEARCH_EXAMPLE_CHIPS`는 같은 라벨 8개를 id 없이 복제한 두 번째 등록소였고
// 아무 데서도 쓰이지 않았다. 등록소가 둘이면 한쪽만 고쳐진 채로 표면마다 다른 말이 남는다.

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
