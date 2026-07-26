// AI에게 일을 맡기는 자리는 앱 안에서 늘 같은 모양이어야 한다 (INT-000015).
//
// 일반 입력 박스와 구분되는 표면 + sparkle 표식 + 권한 배지 + 실제 단계 막대.
// `조사 지시`와 `AI 사람 찾기`가 같은 문법을 쓰므로, 사용자는 한 번 배우면 둘 다 안다.
import { Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import type { AiStage } from '../services/ai-stages';

export function AiSurface({ tone = 'blue', className = '', children }: {
  tone?: 'blue' | 'teal';
  className?: string;
  children: ReactNode;
}) {
  return <section className={`ai-surface tone-${tone} ${className}`.trim()}>{children}</section>;
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

export function AiScopeNote({ children }: { children: ReactNode }) {
  return <p className="ai-scope-note">{children}</p>;
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
