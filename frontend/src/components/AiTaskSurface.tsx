// AI에게 일을 맡기는 자리는 앱 안에서 늘 같은 모양이어야 한다 (INT-000015).
//
// 일반 입력 박스와 구분되는 표면 + sparkle 표식 + 권한 배지 + 실제 단계 막대.
// `조사 지시`와 `AI 사람 찾기`가 같은 문법을 쓰므로, 사용자는 한 번 배우면 둘 다 안다.
import { Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import type { AiStage } from '../services/ai-stages';

// 표면의 상태. 장식이 아니라 실제 lifecycle에 붙는다 (INT-000016 항목 002):
// `idle`은 평소, `active`는 지금 처리 중, `done`·`error`는 끝난 뒤다.
// idle에도 표면은 은은하게 살아 있고, active에서 그 움직임이 분명해진다 (CSS가 소유).
export type AiSurfaceState = 'idle' | 'active' | 'done' | 'error';

export function AiSurface({ tone = 'blue', state = 'idle', className = '', children }: {
  tone?: 'blue' | 'teal';
  state?: AiSurfaceState;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`ai-surface tone-${tone} is-${state} ${className}`.trim()} data-ai-state={state}>
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

// 단계 막대. 진행률을 시간으로 채우지 않고, 실제로 일어나는 단계만 보여 준다.
// 막대는 균등 칸, 이름은 흐르는 한 줄로 분리한다 — 좁은 폰에서 칸마다 이름이 세 줄로 접히면
// 오히려 미완성으로 보인다 (INT-000015가 고치려는 바로 그 인상이다).
export function AiStageRail({ stages, label }: { stages: AiStage[]; label: string }) {
  const active = stages.find((stage) => stage.state === 'active') ?? stages[stages.length - 1];
  return (
    <div className="ai-stage-rail" role="status" aria-label={label}>
      <span className="ai-stage-headline">{active?.headline ?? ''}</span>
      <div className="ai-stage-bars" aria-hidden="true">
        {stages.map((stage) => <i key={stage.key} className={`ai-stage-${stage.state}`} />)}
      </div>
      <ol className="ai-stage-path">
        {stages.map((stage) => <li key={stage.key} className={`ai-stage-${stage.state}`}>{stage.label}</li>)}
      </ol>
    </div>
  );
}

// `limit`은 "하지 않는 일" 줄이다. 할 수 있는 일과 시각적으로 구분해 경계가 눈에 띄게 한다.
export function AiScopeNote({ children, limit = false }: { children: ReactNode; limit?: boolean }) {
  return <p className={limit ? 'ai-scope-note is-limit' : 'ai-scope-note'}>{children}</p>;
}

export function AiExampleChips({ examples, onPick, label }: {
  examples: readonly string[];
  onPick: (value: string) => void;
  label: string;
}) {
  return (
    <div className="ai-example-chips" role="group" aria-label={label}>
      {examples.map((example) => (
        <button key={example} type="button" onClick={() => onPick(example)}>{example}</button>
      ))}
    </div>
  );
}
