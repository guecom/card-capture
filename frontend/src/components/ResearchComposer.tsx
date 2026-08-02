import { IonTextarea } from '@ionic/react';
import { AiResearchExamples, AiScopeNote, AiStageRail, AiSurface, AiSurfaceHead, type AiSurfaceState } from './AiTaskSurface';
import {
  RESEARCH_PLACEHOLDER,
  RESEARCH_SCOPE_DOES,
  RESEARCH_SCOPE_LIMITS,
  researchStages,
  type ResearchStageKey,
} from '../services/ai-stages';
import { RESEARCH_FOCUS_OPTIONS, RESEARCH_PURPOSES, type ResearchFocusId, type ResearchMode, type ResearchPurpose } from '../services/research';

export function ResearchComposer({
  value,
  onChange,
  mode,
  onModeChange,
  purposes,
  onPurposesChange,
  focusIds,
  onFocusIdsChange,
  deepEnabled,
  surfaceState = 'idle',
  stage = 'draft',
  autofocus = false,
}: {
  value: string;
  onChange: (value: string) => void;
  mode: ResearchMode;
  onModeChange: (mode: ResearchMode) => void;
  purposes: ResearchPurpose[];
  onPurposesChange: (purposes: ResearchPurpose[]) => void;
  focusIds: ResearchFocusId[];
  onFocusIdsChange: (focusIds: ResearchFocusId[]) => void;
  deepEnabled: boolean;
  surfaceState?: AiSurfaceState;
  stage?: ResearchStageKey;
  autofocus?: boolean;
}) {
  const togglePurpose = (purpose: ResearchPurpose) => {
    onPurposesChange(purposes.includes(purpose)
      ? purposes.filter((candidate) => candidate !== purpose)
      : [...purposes, purpose]);
  };

  return (
    <AiSurface className="research-request" state={surfaceState}>
      <AiSurfaceHead
        title="AI 조사 요청"
        badge="소유자 전용"
        helper="원하는 깊이와 목적을 고르면, 공개·합법 출처만 사용해 사실과 불확실성을 분리합니다."
      />
      <div className="research-mode-switch" role="radiogroup" aria-label="조사 깊이">
        <button type="button" role="radio" aria-checked={mode === 'standard'} className={mode === 'standard' ? 'on' : ''} onClick={() => onModeChange('standard')}>
          <strong>빠른 조사</strong><small>만남 전 핵심만 요약</small>
        </button>
        {deepEnabled && (
          <button type="button" role="radio" aria-checked={mode === 'deep_evidence_graph'} className={mode === 'deep_evidence_graph' ? 'on' : ''} onClick={() => onModeChange('deep_evidence_graph')}>
            <strong>Deep Research</strong><small>근거·반증·미확인을 함께 추적</small>
          </button>
        )}
      </div>
      {mode === 'deep_evidence_graph' && (
        <fieldset className="research-purpose-grid">
          <legend>이번 조사에서 필요한 것</legend>
          {RESEARCH_PURPOSES.map((purpose) => (
            <button
              key={purpose.id}
              type="button"
              aria-pressed={purposes.includes(purpose.id)}
              className={purposes.includes(purpose.id) ? 'on' : ''}
              onClick={() => togglePurpose(purpose.id)}
            >
              <strong>{purpose.label}</strong><small>{purpose.hint}</small>
            </button>
          ))}
        </fieldset>
      )}
      {mode === 'deep_evidence_graph' && !purposes.length && (
        <p className="research-validation" role="alert">Deep Research가 어디에 쓰일지 목적을 하나 이상 선택해 주세요.</p>
      )}
      <IonTextarea
        aria-label="AI 조사 요청"
        autofocus={autofocus}
        maxlength={2000}
        autoGrow
        placeholder={RESEARCH_PLACEHOLDER}
        value={value}
        onIonInput={(event) => onChange(String(event.detail.value ?? ''))}
      />
      <AiResearchExamples examples={RESEARCH_FOCUS_OPTIONS} selectedIds={focusIds} onChange={onFocusIdsChange} label="조사 요청 예시" />
      <AiStageRail stages={researchStages(stage)} label="AI 조사 요청 진행 단계" />
      <AiScopeNote>{mode === 'deep_evidence_graph' ? '주장을 사실·충돌·미확인·가설로 나누고 각 근거와 반증, 타임라인, 남은 질문을 보여줍니다.' : RESEARCH_SCOPE_DOES}</AiScopeNote>
      <AiScopeNote limit>{RESEARCH_SCOPE_LIMITS} 로그인·사적 자료·민감정보 추론·외부 전송은 요청해도 실행하지 않습니다.</AiScopeNote>
    </AiSurface>
  );
}
