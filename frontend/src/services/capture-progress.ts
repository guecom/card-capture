import type { BriefItem, CaptureAttention, CaptureQueueItem } from '../contracts/capture';

export type StageKey = 'upload' | 'receive' | 'process' | 'complete';
export type StageState = 'done' | 'active' | 'todo' | 'failed';

export interface Stage {
  key: StageKey;
  label: string;
  state: StageState;
}

export interface CaptureProgress {
  stages: Stage[];
  step: number;
  total: number;
  /** Terminal truth only: 1 means complete; non-terminal work never fabricates a percentage. */
  percent: 0 | 1;
  done: boolean;
  failed: boolean;
  late: false;
  headline: string;
  detail: string;
}

const STAGE_DEFS: ReadonlyArray<{ key: StageKey; label: string }> = [
  { key: 'upload', label: '기기에서 전송' },
  { key: 'receive', label: '서버 접수' },
  { key: 'process', label: '서버 처리' },
  { key: 'complete', label: '결과 준비' },
];

const ATTENTION_DETAIL: Record<NonNullable<BriefItem['attention']>['reasonCode'], string> = {
  unreadable_capture: '사진의 글자를 확실히 읽지 못했어요 · 더 선명한 사진이나 내용을 보완해 주세요',
  missing_required_side: '처리에 필요한 명함 면이 없어요 · 빠진 면을 보완해 주세요',
  identity_ambiguous: '누구의 명함인지 확정하지 못했어요 · 이름이나 회사를 확인해 주세요',
};

/** Treat list JSON as untrusted: only the bounded, user-actionable attention contract renders. */
export function captureAttentionOf(brief?: BriefItem | null): CaptureAttention | null {
  const attention = brief?.attention;
  if (!attention || attention.kind !== 'input_required') return null;
  if (!Object.prototype.hasOwnProperty.call(ATTENTION_DETAIL, attention.reasonCode)) return null;
  if (typeof attention.requestedAt !== 'string' || !attention.requestedAt || Number.isNaN(Date.parse(attention.requestedAt))) return null;
  return attention;
}

/** Only map states explicitly proven by the local queue or server response. */
export function stageIndexOf(input: { brief?: BriefItem | null; queue?: CaptureQueueItem | null }): number {
  const { brief, queue } = input;
  if (brief) {
    if (brief.status === 'processed' || brief.status === 'skipped') return 4;
    if (brief.status === 'processing') return 2;
    return 1;
  }
  if (queue?.state === 'sent') return 1;
  return 0;
}

function elapsedText(minutes: number | null): string {
  if (minutes === null) return '마지막으로 확인된 상태를 표시합니다';
  if (minutes < 1) return '1분 미만 경과 · 남은 시간은 아직 알 수 없어요';
  if (minutes < 60) return `${Math.floor(minutes)}분 경과 · 남은 시간은 아직 알 수 없어요`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.floor(minutes % 60);
  return `${hours}시간${rest ? ` ${rest}분` : ''} 경과 · 남은 시간은 아직 알 수 없어요`;
}

export function captureProgress(input: {
  brief?: BriefItem | null;
  queue?: CaptureQueueItem | null;
  elapsedMinutes?: number | null;
}): CaptureProgress {
  const failed = input.queue?.state === 'failed';
  const index = failed ? 0 : stageIndexOf(input);
  const done = index >= STAGE_DEFS.length;
  const stages: Stage[] = STAGE_DEFS.map((definition, position) => ({
    ...definition,
    state: failed && position === 0 ? 'failed' : done || position < index ? 'done' : position === index ? 'active' : 'todo',
  }));

  if (failed) {
    const tries = input.queue?.tries ?? 0;
    return {
      stages,
      step: 1,
      total: STAGE_DEFS.length,
      percent: 0,
      done: false,
      failed: true,
      late: false,
      headline: '전송하지 못했어요',
      detail: `${tries ? `${tries}회 시도 · ` : ''}연결되면 자동 재시도하고, 지금 직접 다시 보낼 수도 있어요`,
    };
  }

  if (done) {
    const attention = captureAttentionOf(input.brief);
    return {
      stages,
      step: STAGE_DEFS.length + 1,
      total: STAGE_DEFS.length,
      percent: 1,
      done: true,
      failed: false,
      late: false,
      headline: attention ? '확인이 필요해요' : input.brief?.status === 'skipped' ? '명함이 아니어서 처리하지 않았어요' : '결과가 준비됐어요',
      detail: attention
        ? ATTENTION_DETAIL[attention.reasonCode]
        : input.elapsedMinutes === null || input.elapsedMinutes === undefined ? '서버가 완료 상태를 확인했습니다' : `${Math.max(0, Math.floor(input.elapsedMinutes))}분 경과 뒤 완료 상태를 확인했습니다`,
    };
  }

  const headlines = ['기기에서 전송을 기다려요', '서버가 접수했어요', '서버에서 처리 중이에요', '결과를 확인하고 있어요'];
  return {
    stages,
    step: index + 1,
    total: STAGE_DEFS.length,
    percent: 0,
    done: false,
    failed: false,
    late: false,
    headline: headlines[index],
    detail: elapsedText(input.elapsedMinutes ?? null),
  };
}
