// 명함 한 장이 "촬영 → 완료"까지 가는 길을 사용자 언어로 하나의 진행 모델로 합친다 (TSK-000249).
//
// 예전에는 기기 쪽 상태(전송 대기/전송됨)와 서버 쪽 상태(접수됨/처리 중/완료)가 서로 다른
// 문구로 흩어져 있었고, 남은 단계 수도 남은 시간도 보이지 않았다.
// founder 판정 2026-07-26: "몇 단계가 얼마나 남았는지, 실질적으로 몇 분 남았는지,
// 보통 얼마나 걸리는지 사용자 경험이 세련됐으면 좋겠다."
import type { BriefItem, CaptureQueueItem } from '../contracts/capture';

export type StageKey = 'upload' | 'receive' | 'read' | 'research';
export type StageState = 'done' | 'active' | 'todo' | 'failed';

export interface Stage {
  key: StageKey;
  label: string;
  state: StageState;
  /** 이 단계가 보통 걸리는 시간(분) */
  typicalMinutes: number;
}

export interface CaptureProgress {
  stages: Stage[];
  /** 현재 진행 중인 단계 번호 (1-based). 완료면 stages.length + 1 */
  step: number;
  total: number;
  /** 0..1 */
  percent: number;
  done: boolean;
  failed: boolean;
  late: boolean;
  /** "4단계 중 3단계 · 이름·정보 인식 중" */
  headline: string;
  /** "8분 경과 · 약 6분 남음 · 보통 6~20분" */
  detail: string;
}

const STAGE_DEFS: Array<{ key: StageKey; label: string; typicalMinutes: number }> = [
  { key: 'upload', label: '사진 전송', typicalMinutes: 1 },
  { key: 'receive', label: '서버 접수', typicalMinutes: 1 },
  { key: 'read', label: '이름·정보 인식', typicalMinutes: 3 },
  { key: 'research', label: '웹 조사·기록 정리', typicalMinutes: 10 },
];

export const TYPICAL_TOTAL_RANGE = { min: 6, max: 20 };

function label(index: number): string {
  return STAGE_DEFS[index]?.label ?? '';
}

// 서버 응답과 로컬 큐 상태를 합쳐 "지금 몇 번째 단계인가"를 정한다 (0-based, 4 = 완료).
export function stageIndexOf(input: { brief?: BriefItem | null; queue?: CaptureQueueItem | null }): number {
  const { brief, queue } = input;
  if (brief) {
    if (brief.status === 'processed' || brief.status === 'skipped') return 4;
    if (brief.status === 'processing') return 3;
    // contact는 서버가 처리 중 채워 넣는 요약이다 — 이게 있어야 "이름·정보 인식"이 끝난 것이다.
    // quickName은 기기에서 촬영 직후 미리 채운 값이라 서버 진행 상태의 근거가 되지 못한다.
    return brief.contact?.name ? 3 : 2;
  }
  if (queue) {
    if (queue.state === 'sent') return 1;   // 전송됨 — 서버 접수 대기
    return 0;                               // 전송 대기·전송 중
  }
  return 0;
}

function minutesText(minutes: number): string {
  if (minutes < 1) return '1분 이내';
  if (minutes < 60) return `${Math.round(minutes)}분`;
  return `${Math.round(minutes / 60)}시간`;
}

export function captureProgress(input: {
  brief?: BriefItem | null;
  queue?: CaptureQueueItem | null;
  elapsedMinutes?: number | null;
}): CaptureProgress {
  const { brief, queue } = input;
  const failed = queue?.state === 'failed';
  const index = failed ? 0 : stageIndexOf({ brief, queue });
  const done = index >= STAGE_DEFS.length;
  const elapsed = input.elapsedMinutes ?? null;

  const stages: Stage[] = STAGE_DEFS.map((definition, position) => ({
    key: definition.key,
    label: definition.label,
    typicalMinutes: definition.typicalMinutes,
    state: failed && position === 0 ? 'failed' : position < index ? 'done' : position === index ? 'active' : 'todo',
  }));

  const remainingTypical = STAGE_DEFS.slice(Math.min(index, STAGE_DEFS.length))
    .reduce((total, definition) => total + definition.typicalMinutes, 0);
  const spentTypical = STAGE_DEFS.slice(0, Math.min(index, STAGE_DEFS.length))
    .reduce((total, definition) => total + definition.typicalMinutes, 0);
  // 남은 시간 추정: 남은 단계의 평소 소요에서, 현재 단계에서 이미 쓴 시간을 뺀다.
  const spentInStage = elapsed === null ? 0 : Math.max(0, elapsed - spentTypical);
  const estimate = Math.max(1, Math.round(remainingTypical - spentInStage));
  const late = !done && elapsed !== null && elapsed > TYPICAL_TOTAL_RANGE.max + 10;

  if (failed) {
    return {
      stages, step: 1, total: STAGE_DEFS.length, percent: 0, done: false, failed: true, late: false,
      headline: '전송 실패 — 다시 보내면 이어서 진행돼요',
      detail: queue?.tries ? `${queue.tries}회 시도함 · 전파가 약한 곳에서는 자동으로 다시 시도해요` : '전파가 약한 곳에서는 자동으로 다시 시도해요',
    };
  }

  if (done) {
    const terminal = brief?.status === 'skipped' ? '명함이 아니어서 건너뜀' : '완료';
    return {
      stages, step: STAGE_DEFS.length + 1, total: STAGE_DEFS.length, percent: 1, done: true, failed: false, late: false,
      headline: terminal,
      detail: elapsed === null ? '브리핑이 도착했어요' : `${minutesText(elapsed)} 만에 도착했어요`,
    };
  }

  const step = index + 1;
  const parts = [
    elapsed === null ? null : `${minutesText(elapsed)} 경과`,
    late ? `평소(${TYPICAL_TOTAL_RANGE.min}~${TYPICAL_TOTAL_RANGE.max}분)보다 오래 걸리고 있어요` : `약 ${minutesText(estimate)} 남음`,
    late ? null : `보통 ${TYPICAL_TOTAL_RANGE.min}~${TYPICAL_TOTAL_RANGE.max}분`,
  ].filter(Boolean);

  return {
    stages,
    step,
    total: STAGE_DEFS.length,
    percent: Math.min(0.95, (index + 0.5) / STAGE_DEFS.length),
    done: false,
    failed: false,
    late,
    headline: `${STAGE_DEFS.length}단계 중 ${step}단계 · ${label(index)} 중`,
    detail: parts.join(' · '),
  };
}

// 자동 새로고침 안내 문구. "언제 저절로 갱신되는지"를 사용자가 알 수 있어야 한다.
export function refreshHint(secondsToNext: number, lastUpdatedMinutes: number | null): string {
  const next = secondsToNext <= 1 ? '곧' : `${Math.ceil(secondsToNext)}초 뒤`;
  if (lastUpdatedMinutes === null) return `${next} 자동 새로고침`;
  const last = lastUpdatedMinutes < 1 ? '방금' : `${Math.round(lastUpdatedMinutes)}분 전`;
  return `${last} 업데이트 · ${next} 자동 새로고침`;
}
