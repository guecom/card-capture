// AI에게 일을 맡기는 자리는 앱 안에서 늘 같은 모양이어야 한다 (INT-000015).
//
// 일반 입력 박스와 구분되는 표면 + sparkle 표식 + 권한 배지 + 실제 단계 막대.
// `조사 지시`와 `AI 사람 찾기`가 같은 문법을 쓰므로, 사용자는 한 번 배우면 둘 다 안다.
import { Check, Minus, Plus, Sparkles } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import type { AiStage } from '../services/ai-stages';
import { researchBulkState, toggleAllResearchFocus, type ResearchFocusId } from '../services/research';
import { stageWidthPercents, type StageWeighting } from '../services/stage-weights';

// 표면의 상태. 장식이 아니라 실제 lifecycle에 붙는다 (INT-000016 항목 002):
// `idle`은 평소, `active`는 지금 처리 중, `done`·`error`는 끝난 뒤다.
// idle에도 표면은 은은하게 살아 있고, active에서 그 움직임이 분명해진다 (CSS가 소유).
export type AiSurfaceState = 'idle' | 'active' | 'done' | 'error';

// 색 갈래(`tone`)는 없다 (founder 판정 2026-07-28 항목 4). AI가 일하는 자리는 언제나 같은 색이다 —
// `AI 사람 찾기`만 teal이던 예전 화면은 두 표면을 다른 기능처럼 보이게 했다. "기기 안에서 대조한다"는
// 경계는 배지 글자가 말하고, teal은 이 앱에서 계속 기기 경계 안내(boundary-note 계열)의 색으로 남는다.
export function AiSurface({ state = 'idle', className = '', children }: {
  state?: AiSurfaceState;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`ai-surface is-${state} ${className}`.trim()} data-ai-state={state} aria-busy={state === 'active'}>
      {children}
    </section>
  );
}

export function AiSurfaceHead({ title, badge, helper }: { title: string; badge?: string; helper?: string }) {
  return (
    <div className="ai-surface-head">
      <span className="ai-mark" aria-hidden="true"><Sparkles size={13} /></span>
      <strong>{title}</strong>
      {badge && <span className="ai-badge">{badge}</span>}
      {helper && <p>{helper}</p>}
    </div>
  );
}

/**
 * 단계 막대의 두 갈래.
 *
 * - `preview`: **아직 요청이 없다.** 접수하면 거칠 순서를 보여 줄 뿐이므로 진행 막대도,
 *   진행을 알리는 live region도 만들지 않는다. 빈 입력칸 옆에서 1/5칸이 차 있고 낭독기가
 *   "작성 중"을 진행 상태로 읽던 것이 founder가 지적한 가짜 진행이다.
 * - `progress`: 실제 요청이 떠 있다. 이때만 막대와 `role="status"`가 존재한다.
 */
export type AiStageRailMode = 'preview' | 'progress';

// 단계 막대. 진행률을 시간으로 채우지 않고, 실제로 일어나는 단계만 보여 준다.
// 이름은 흐르는 한 줄로 분리한다 — 좁은 폰에서 칸마다 이름이 세 줄로 접히면
// 오히려 미완성으로 보인다 (INT-000015가 고치려는 바로 그 인상이다).
export function AiStageRail({ stages, label, mode = 'progress', weighting = null }: {
  stages: AiStage[];
  label: string;
  mode?: AiStageRailMode;
  /**
   * 관측된 소요시간에서 온 칸 폭 (`services/stage-weights`). 폭은 여기서 만들지 않는다 —
   * `confident:false`면 균등 칸으로 되돌린 뒤 그 사실을 글로 말한다 (설계 계약 §3).
   */
  weighting?: StageWeighting | null;
}) {
  const active = stages.find((stage) => stage.state === 'active') ?? stages[stages.length - 1];
  const path = (
    <ol className="ai-stage-path">
      {stages.map((stage) => <li key={stage.key} className={`ai-stage-${stage.state}`}>{stage.label}</li>)}
    </ol>
  );

  // 요청이 없으면 진행이 아니라 **예정 순서**다. 막대도, live region도 만들지 않는다.
  if (mode === 'preview') {
    return (
      // `ai-stage-basis`는 여기 두지 않는다. "아직 시작한 일은 없어요 · 접수한 뒤에 진행이 표시됩니다"는
      // 바로 위 `접수하면 거치는 순서`와 `ai-stage-todo` 표시가 이미 말한 것을 한 번 더 말한 것이었다.
      // 진행 모드의 `ai-stage-basis`는 관측 건수라는 **새 사실**을 말하므로 그대로 남는다.
      <div className="ai-stage-rail is-preview" role="group" aria-label={label}>
        <span className="ai-stage-headline">접수하면 거치는 순서</span>
        {path}
      </div>
    );
  }

  // 관측이 실제로 쌓였을 때만 칸 폭을 주장한다. 단계 목록과 가중치가 키까지 일치해야 하고,
  // 하나라도 어긋나면 균등 칸으로 되돌린다 — 절반만 비례하는 막대는 폭의 뜻을 없앤다.
  const aligned = Boolean(weighting
    && weighting.confident
    && weighting.weights.length === stages.length
    && weighting.weights.every((weight, index) => weight.key === stages[index].key));
  const percents = aligned && weighting ? stageWidthPercents(weighting) : null;
  // 폭은 디자인 토큰이 아니라 **관측 데이터**다. 그래서 CSS가 아니라 여기서만 나올 수 있다.
  // `fr`을 쓰는 이유: `%`로 주면 칸 사이 간격(4px)만큼 막대가 넘쳐 마지막 칸이 잘린다.
  const barStyle: CSSProperties | undefined = percents
    ? { gridTemplateColumns: percents.map((percent) => `${percent}fr`).join(' ') }
    : undefined;
  const samples = aligned && weighting
    ? weighting.weights.reduce((total, weight) => total + weight.samples, 0)
    : 0;

  return (
    <div className="ai-stage-rail" role="status" aria-label={label}>
      <span className="ai-stage-headline">{active?.headline ?? ''}</span>
      <div className="ai-stage-bars" aria-hidden="true" style={barStyle}>
        {stages.map((stage) => <i key={stage.key} className={`ai-stage-${stage.state}`} />)}
      </div>
      {path}
      {percents
        ? <small className="ai-stage-basis">관측 {samples}건의 실제 소요시간으로 칸 크기를 맞췄어요.</small>
        : null}
      {weighting && !percents
        ? <small className="ai-stage-basis is-unmeasured">각 단계가 얼마나 걸리는지 아직 충분히 관측되지 않았어요. 칸 크기는 같고, 남은 시간을 뜻하지 않아요.</small>
        : null}
    </div>
  );
}

// `limit`은 "하지 않는 일" 줄이다. 할 수 있는 일과 시각적으로 구분해 경계가 눈에 띄게 한다.
export function AiScopeNote({ children, limit = false }: { children: ReactNode; limit?: boolean }) {
  return <p className={limit ? 'ai-scope-note is-limit' : 'ai-scope-note'}>{children}</p>;
}

export function AiResearchExamples({ examples, selectedIds, onChange, label, busy = false }: {
  examples: ReadonlyArray<{ id: ResearchFocusId; label: string }>;
  selectedIds: ResearchFocusId[];
  onChange: (value: ResearchFocusId[]) => void;
  label: string;
  /** 이미 접수 중이면 고르던 항목이 요청과 어긋나므로 잠근다. */
  busy?: boolean;
}) {
  // 서버가 추천 항목을 하나도 주지 못한 경우에도 화면은 완결돼야 한다 — 빈 chip 줄과
  // "0/0개 선택" 버튼을 남기면 고장으로 읽힌다.
  if (!examples.length) {
    return <p className="ai-research-empty">추천할 조사 항목이 아직 없어요. 확인하고 싶은 것을 아래에 직접 적어 주세요.</p>;
  }

  const bulk = researchBulkState(selectedIds, examples);
  const selected = new Set(selectedIds);
  // 표식은 앱의 다른 모든 아이콘과 같은 lucide 어휘를 쓴다. 전각 `＋`·`✓`·`–`를 글자로 찍던
  // 자리가 이 표면만 다른 물건처럼 보이게 한 원인이었다.
  const BulkMark = bulk.state === 'all' ? Check : bulk.state === 'partial' ? Minus : Plus;
  return (
    <div className="ai-research-examples">
      <button
        className={`ai-bulk-select is-${bulk.state}`}
        type="button"
        disabled={busy}
        aria-pressed={bulk.state === 'partial' ? 'mixed' : bulk.state === 'all'}
        onClick={() => onChange(toggleAllResearchFocus(selectedIds, examples))}
      >
        <span className="ai-bulk-mark" aria-hidden="true"><BulkMark size={15} strokeWidth={2.4} /></span>
        {/* 낭독 이름은 `추천 항목 모두 선택 1/8개 선택`으로 고정돼 있다(int15-surfaces T3).
            공백을 CSS(`display:grid`)에 기대면 Lane B의 레이아웃 변경이 이름을 바꾼다 — 명시한다. */}
        <span className="ai-bulk-copy">
          <strong>{bulk.state === 'all' ? '추천 항목 모두 선택됨' : '추천 항목 모두 선택'}</strong>{' '}
          <small>{bulk.selected}/{examples.length}개 선택</small>
        </span>
      </button>
      <div className="ai-example-chips" role="group" aria-label={label}>
        {examples.map((example) => {
          const on = selected.has(example.id);
          return (
            <button
              key={example.id}
              className={on ? 'is-selected' : ''}
              aria-pressed={on}
              type="button"
              disabled={busy}
              onClick={() => onChange(on
                ? selectedIds.filter((id) => id !== example.id)
                : [...selectedIds, example.id])}
            >
              {/* 선택은 옅은 채움만으로 전달되지 않는다 — 표식을 markup에 둔다 (색은 Lane B). */}
              <span className="ai-chip-mark" aria-hidden="true">
                {on ? <Check size={13} strokeWidth={2.6} /> : <Plus size={13} strokeWidth={2} />}
              </span>
              {example.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
