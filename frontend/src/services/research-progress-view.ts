// 조사가 끝나기 전에 **지금까지 무엇을 알아냈는지** 보여 주기 위한 view model (INT-000025).
//
// 승인된 중간 결과는 `확인된 사실 · 남은 질문 · 충돌 · 기간 커버리지`다.
// 승인 회의에서 명시적으로 제외된 것은 `검토한 source 수`다 — 몇 개를 읽었는지는 일한 양이지
// 알아낸 것이 아니라서, 많을수록 잘한 것처럼 읽히는 거짓 신호가 된다.
//
// 다만 `sourceCount`를 계약에서 **지우지는 않는다**. 서버가 실제로 보내는 값이고
// `eval/gas-research-policy.test.js`가 그 서버 동작을 검사한다. 여기서는 화면이 더 나은 것을
// 고를 수 있도록 옆에 두되, 커버리지를 `graph.timeline`에서 직접 파생해 함께 준다.
// 무엇을 보여 줄지는 화면의 판단이고, 이 모듈의 일은 **더 나은 자료를 실제로 있게 하는 것**이다.

import type { BriefItem, ResearchProgressPhase, ResearchTimelineEvent } from '../contracts/capture';
import { researchEvidenceView } from './research-result';
import { researchPhaseLabel, researchPhaseOf } from './research-vocabulary';

/** 조사가 실제로 훑은 기간. `graph.timeline`에서 파생한다 — 서버가 따로 주지 않는 값이다. */
export interface ResearchTimelineCoverage {
  /** timeline 사건 수 */
  events: number;
  /** 근거 주장이 붙은 사건 수. 붙지 않은 사건은 연표에 있을 뿐 확인된 것이 아니다. */
  citedEvents: number;
  /** 가장 이른/늦은 연도. 연도를 읽어내지 못하면 null이다. */
  earliestYear: number | null;
  latestYear: number | null;
  /** 훑은 기간(년). 같은 해면 0이다. */
  spanYears: number | null;
  /** 화면에 그대로 쓰는 한 조각: `2019~2026년 · 사건 8건` */
  label: string;
}

export interface ResearchProgressView {
  phase: ResearchProgressPhase | null;
  phaseLabel: string | null;
  /** 확인된 사실 수 */
  verifiedFacts: number | null;
  /** 아직 답하지 못한 질문 수 */
  openQuestions: number | null;
  /** 서로 어긋나는 근거가 있는 주장 수 */
  conflicts: number | null;
  /** 기간 커버리지. 근거 graph가 아직 없으면 null이다. */
  coverage: ResearchTimelineCoverage | null;
  /**
   * 위 세 숫자의 출처. `graph`면 검증된 근거 graph에서 직접 센 값이고,
   * `progress`면 서버 요약을 그대로 받은 값이다. 섞지 않는다.
   */
  countsFrom: 'graph' | 'progress' | null;
  updatedAt: string | null;
  /** 승인 회의에서 중간 결과의 지표로 쓰지 않기로 한 값. 계약에는 남기되 강조하지 않는다. */
  sourceCount: number | null;
  branchCount: number | null;
  elapsedMinutes: number | null;
  /** 근거 graph가 왔지만 검증에 실패했다. 화면은 잘못된 숫자를 보여 주는 대신 이 사실을 말한다. */
  evidenceInvalid: boolean;
}

const YEAR = /(1[89]\d{2}|20\d{2}|21\d{2})/;

function yearOf(date: string): number | null {
  const match = YEAR.exec(date);
  if (!match) return null;
  const year = Number(match[1]);
  return Number.isFinite(year) ? year : null;
}

function countOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

/** timeline 사건 목록에서 기간 커버리지를 파생한다 (순수 함수). */
export function timelineCoverage(timeline: ReadonlyArray<ResearchTimelineEvent> | null | undefined): ResearchTimelineCoverage | null {
  if (!timeline || !timeline.length) return null;
  const years = timeline
    .map((event) => yearOf(String(event?.date ?? '')))
    .filter((year): year is number => year !== null);
  const citedEvents = timeline.filter((event) => Array.isArray(event?.claimIds) && event.claimIds.length > 0).length;
  const earliestYear = years.length ? Math.min(...years) : null;
  const latestYear = years.length ? Math.max(...years) : null;
  const spanYears = earliestYear !== null && latestYear !== null ? latestYear - earliestYear : null;
  const period = earliestYear === null || latestYear === null
    ? '연도 미상'
    : earliestYear === latestYear ? `${earliestYear}년` : `${earliestYear}~${latestYear}년`;
  return {
    events: timeline.length,
    citedEvents,
    earliestYear,
    latestYear,
    spanYears,
    label: `${period} · 사건 ${timeline.length}건`,
  };
}

/**
 * 조사 receipt 하나의 중간 결과 view model.
 *
 * 검증된 근거 graph가 있으면 숫자를 **거기서 직접 센다** — 서버 요약과 graph가 어긋날 때
 * 화면에 보이는 목록과 그 위의 숫자가 다르면 둘 다 못 믿게 된다.
 * graph가 없으면 서버 요약을 쓰고, 어느 쪽인지 `countsFrom`으로 남긴다.
 */
export function researchProgressView(brief?: BriefItem | null): ResearchProgressView | null {
  if (!brief) return null;
  const progress = brief.researchProgress;
  const evidence = researchEvidenceView(brief.researchEvidence);
  if (!progress && evidence.kind === 'none') return null;

  const phase = researchPhaseOf(progress?.phase);
  const updatedAt = typeof progress?.updatedAt === 'string' ? progress.updatedAt : null;
  const base = {
    phase,
    phaseLabel: phase ? researchPhaseLabel(phase) : null,
    updatedAt,
    sourceCount: countOf(progress?.sourceCount),
    branchCount: countOf(progress?.branchCount),
    elapsedMinutes: countOf(progress?.elapsedMinutes),
    evidenceInvalid: evidence.kind === 'invalid',
  };

  if (evidence.kind === 'ready') {
    const { graph } = evidence;
    return {
      ...base,
      verifiedFacts: graph.claims.filter((claim) => claim.state === 'fact').length,
      conflicts: graph.claims.filter((claim) => claim.state === 'conflict').length,
      openQuestions: graph.openQuestions.length,
      coverage: timelineCoverage(graph.timeline),
      countsFrom: 'graph',
      sourceCount: countOf(graph.metrics.sourceCount) ?? base.sourceCount,
      branchCount: countOf(graph.metrics.branchCount) ?? base.branchCount,
      elapsedMinutes: countOf(graph.metrics.elapsedMinutes) ?? base.elapsedMinutes,
    };
  }

  const verifiedFacts = countOf(progress?.verifiedFacts);
  const conflicts = countOf(progress?.conflicts);
  const openQuestions = countOf(progress?.openQuestions);
  return {
    ...base,
    verifiedFacts,
    conflicts,
    openQuestions,
    coverage: null,
    countsFrom: verifiedFacts === null && conflicts === null && openQuestions === null ? null : 'progress',
  };
}
