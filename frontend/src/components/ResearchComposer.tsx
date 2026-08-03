import { IonTextarea } from '@ionic/react';
import { useMemo } from 'react';
import { Circle, CircleDot, Square, SquareCheck } from 'lucide-react';
import {
  AiResearchExamples,
  AiScopeNote,
  AiStageRail,
  AiSurface,
  AiSurfaceHead,
  type AiSurfaceState,
} from './AiTaskSurface';
import {
  RESEARCH_PLACEHOLDER,
  RESEARCH_SCOPE_DOES,
  RESEARCH_SCOPE_LIMITS,
  researchStages,
  type ResearchStageKey,
} from '../services/ai-stages';
import { RESEARCH_FOCUS_OPTIONS, RESEARCH_PURPOSES, type ResearchFocusId, type ResearchMode, type ResearchPurpose } from '../services/research';
import { loadStageTelemetry, stageStats } from '../services/stage-telemetry';
import { weightStages, type StageWeighting } from '../services/stage-weights';

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
  stageWeighting = null,
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
  /**
   * 관측된 소요시간에서 온 단계 칸 폭. 넘기지 않으면 이 기기의 관측(`stage-telemetry`)으로
   * 직접 계산한다. 어느 쪽이든 폭은 관측에서만 온다 — 지어내지 않는다.
   */
  stageWeighting?: StageWeighting | null;
  autofocus?: boolean;
}) {
  const togglePurpose = (purpose: ResearchPurpose) => {
    onPurposesChange(purposes.includes(purpose)
      ? purposes.filter((candidate) => candidate !== purpose)
      : [...purposes, purpose]);
  };

  // 접수 중에는 고르던 항목과 실제로 보낸 요청이 어긋난다 — 선택 조작만 잠근다.
  const busy = surfaceState === 'active';
  const deep = mode === 'deep_evidence_graph';
  // 아직 요청이 없으면 단계는 "진행"이 아니라 "예정"이다 (설계 계약 §3).
  const railMode = stage === 'draft' ? 'preview' : 'progress';
  // 예정 순서에는 칸 폭이 없다 — 아직 아무것도 걸리지 않았기 때문이다.
  const railWeighting = useMemo(() => {
    if (stage === 'draft') return null;
    if (stageWeighting) return stageWeighting;
    const keys = researchStages(stage).map((entry) => entry.key);
    return weightStages(keys, stageStats(loadStageTelemetry(), keys));
  }, [stage, stageWeighting]);
  const typed = value.trim().length > 0;
  const packed = [
    focusIds.length ? `추천 항목 ${focusIds.length}개` : '',
    deep && purposes.length ? `목적 ${purposes.length}개` : '',
    typed ? '직접 적은 요청' : '',
  ].filter(Boolean);

  return (
    <AiSurface className="research-request" state={surfaceState}>
      <AiSurfaceHead
        title="AI 조사 요청"
        badge="소유자 전용"
        helper="원하는 깊이와 목적을 고르면, 공개·합법 출처만 사용해 사실과 불확실성을 분리합니다."
      />

      {/* 1. 얼마나 깊게 — 두 선택지는 같은 구조·같은 언어로 읽혀야 한다.
          `Deep Research`는 이 mode의 제품명이라 표식으로만 남기고, 읽는 이름은 한국어가 먼저 온다.
          (완전한 한국어화는 int15-surfaces T5의 `/Deep Research/` 정규식과 함께 바꿔야 한다.) */}
      <div className="research-mode-switch" role="radiogroup" aria-label="조사 깊이">
        <button type="button" role="radio" aria-checked={!deep} disabled={busy} className={!deep ? 'on' : ''} onClick={() => onModeChange('standard')}>
          <span className="research-choice-mark" aria-hidden="true">{!deep ? <CircleDot size={14} strokeWidth={2.4} /> : <Circle size={14} strokeWidth={2} />}</span>
          <strong>빠른 조사</strong>
          <small>만남 전 핵심만 요약</small>
        </button>
        {deepEnabled && (
          <button type="button" role="radio" aria-checked={deep} disabled={busy} className={deep ? 'on' : ''} onClick={() => onModeChange('deep_evidence_graph')}>
            <span className="research-choice-mark" aria-hidden="true">{deep ? <CircleDot size={14} strokeWidth={2.4} /> : <Circle size={14} strokeWidth={2} />}</span>
            <strong>깊은 근거 조사</strong>
            <span className="research-mode-tag">Deep Research</span>
            <small>근거·반증·미확인을 함께 추적</small>
          </button>
        )}
      </div>
      {!deepEnabled && (
        <p className="research-mode-note">지금 연결된 서버는 깊은 근거 조사를 아직 지원하지 않아요. 빠른 조사로 접수됩니다.</p>
      )}

      {/* 2. 무엇에 쓸 것인가 — 깊은 근거 조사에서만 묻는다. */}
      {deep && (
        <fieldset className="research-purpose-grid" disabled={busy}>
          <legend>이번 조사에서 필요한 것</legend>
          {RESEARCH_PURPOSES.map((purpose) => {
            const on = purposes.includes(purpose.id);
            return (
              <button
                key={purpose.id}
                type="button"
                aria-pressed={on}
                className={on ? 'on' : ''}
                onClick={() => togglePurpose(purpose.id)}
              >
                <span className="research-choice-mark" aria-hidden="true">{on ? <SquareCheck size={14} strokeWidth={2.4} /> : <Square size={14} strokeWidth={2} />}</span>
                <strong>{purpose.label}</strong>
                <small>{purpose.hint}</small>
              </button>
            );
          })}
        </fieldset>
      )}
      {deep && !purposes.length && (
        <p className="research-validation" role="alert">깊은 근거 조사가 어디에 쓰일지 목적을 하나 이상 선택해 주세요.</p>
      )}

      {/* 3. 자주 맡기는 판단을 먼저 꺼내 놓는다 — 빈 칸 앞에서 무엇을 적을지 고민하지 않게. */}
      <AiResearchExamples examples={RESEARCH_FOCUS_OPTIONS} selectedIds={focusIds} onChange={onFocusIdsChange} label="조사 요청 예시" busy={busy} />

      {/* 4. 그리고 나서 직접 적는다. 지름길을 먼저 보여 준 뒤에 빈 칸이 온다. */}
      <IonTextarea
        aria-label="AI 조사 요청"
        autofocus={autofocus}
        maxlength={2000}
        autoGrow
        placeholder={RESEARCH_PLACEHOLDER}
        value={value}
        onIonInput={(event) => onChange(String(event.detail.value ?? ''))}
      />

      {/* 5. 무엇이 실제로 담기는지 — 칩이 화면 밖으로 밀려도 접수 직전에 확인된다. */}
      {packed.length > 0 && <p className="research-packed">이 요청에 담겨요 · {packed.join(' · ')}</p>}
      {busy && <p className="research-packed is-busy" role="status">요청을 접수하는 중이에요. 잠시만 기다려 주세요.</p>}

      {/* 6. 접수 뒤 거치는 순서. 요청이 뜨기 전에는 진행 막대가 아니라 예정 순서다. */}
      <AiStageRail stages={researchStages(stage)} label="AI 조사 요청 진행 단계" mode={railMode} weighting={railWeighting} />

      <AiScopeNote>{deep ? '주장을 사실·충돌·미확인·가설로 나누고 각 근거와 반증, 타임라인, 남은 질문을 보여줍니다.' : RESEARCH_SCOPE_DOES}</AiScopeNote>
      <AiScopeNote limit>{RESEARCH_SCOPE_LIMITS} 로그인·사적 자료·민감정보 추론·외부 전송은 요청해도 실행하지 않습니다.</AiScopeNote>
    </AiSurface>
  );
}
