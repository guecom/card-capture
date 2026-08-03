// `AI 조사 요청` 작성 자리. 두 화면(촬영 탭·인물 카드 시트)이 이 하나를 같이 쓴다.
//
// 이 컴포넌트가 소유하는 것은 **작성 · 선택 · 제출 · 접수 확인/접수 실패**까지다 (TSK-000535 / ISS-000050).
// 접수된 뒤의 처리 진행은 여기서 말하지 않는다 — founder 판정 2026-08-04:
//   "캡처 탭의 AI 조사 요청에 나와 있는 진행 막대기가 필요 없는 것 같아. 완료하게 되면 명함 기록
//    혹은 진행에 블록이 생성돼서 그곳에서 진행 막대기가 올라가는데, 그렇기 때문에 AI 조사 요청에
//    있는 진행 막대기는 현재 무의미한 것 같아."
// 그래서 `AiStageRail`은 여기서 걷어내고, 접수가 끝나면 **진행을 소유한 기록 블록으로 손을 넘긴다**.
// (`AiStageRail` 자체는 지우지 않는다 — 기록 블록과 `AI 사람 찾기`가 계속 쓴다.)
//
// 항목 선택(TSK-000536)은 `research-scope.ts`가 소유한다. 이 파일은 그 상태를 그리기만 한다.
import './../styles/int29-research.css';
import { CircleAlert, CircleCheck, Eraser, ListChecks } from 'lucide-react';
import { IonTextarea } from '@ionic/react';
import { useMemo } from 'react';
import { AiScopeNote, AiSurface, AiSurfaceHead } from './AiTaskSurface';
import { RESEARCH_SCOPE_DOES, RESEARCH_SCOPE_LIMITS } from '../services/ai-stages';
import {
  RESEARCH_SCOPES,
  composeResearchInstruction,
  decomposeResearchInstruction,
  nextResearchScopeSelection,
  researchSelectAllLabel,
  researchSelectAllPressed,
  researchSelectionCountLabel,
  researchSelectionState,
  researchTextBudget,
  toggleResearchScope,
} from '../services/research-scope';

/**
 * 제출의 결과. `작성 중`이 아니라 **접수됐는가 / 접수에 실패했는가**만 말한다.
 * 접수 뒤의 단계는 기록 블록이 소유하므로 여기에는 없다.
 */
export type ResearchReceipt =
  | { state: 'idle' }
  | { state: 'accepted'; note: string; progressLabel?: string; onOpenProgress?: () => void }
  | { state: 'failed'; reason: string; retryLabel?: string; onRetry?: () => void };

export interface ResearchComposerProps {
  /** 실제로 제출될 문장. 항목과 자유 입력이 이미 합쳐진 값이다. */
  value: string;
  onChange: (next: string) => void;
  helper: string;
  placeholder: string;
  /** 지금 보내는 중인가 */
  busy?: boolean;
  autofocus?: boolean;
  receipt?: ResearchReceipt;
}

const IDLE: ResearchReceipt = { state: 'idle' };

/** 화면을 덮고 있는 시트가 아직 있는가. 시트가 있는 동안에는 그 뒤로 손을 넘기지 않는다. */
function sheetStillCovering(): boolean {
  return Boolean(document.querySelector('ion-modal.show-modal'));
}

/**
 * 진행을 소유한 기록 블록으로 손을 넘긴다 — 스크롤·포커스·잠깐의 강조까지.
 *
 * 세 가지를 기다려야 한다.
 *  1. 블록이 아직 없을 수 있다 (서버 응답 → 목록 갱신 → 렌더).
 *  2. 시트가 아직 닫히는 중일 수 있다. 시트가 덮고 있는 동안 뒤쪽에 포커스를 주면 사용자는
 *     보이지도 않는 곳에 서 있게 된다.
 *  3. Ionic 시트는 **닫히면서 원래 자리로 포커스를 되돌린다.** 그 되돌림이 우리 포커스보다 늦게
 *     오면 손이 도로 끌려간다. 그래서 준 다음에도 잠깐 지켜보다가 밀려났으면 한 번 더 준다.
 *
 * 끝내 블록을 못 찾으면 아무 일도 하지 않는다 — **없는 곳으로 스크롤해 사용자를 빈 화면에
 * 떨어뜨리지 않는다.** 찾았는지를 boolean으로 돌려주므로 호출한 쪽이 다른 대상을 고를 수 있다.
 */
export function focusCaptureProgress(captureId: string, timeoutMs = 4000): Promise<boolean> {
  if (!captureId || typeof document === 'undefined') return Promise.resolve(false);
  const deadline = Date.now() + timeoutMs;
  return new Promise((done) => {
    const attempt = () => {
      const block = document.getElementById(`capture-${captureId}`);
      if (!block || sheetStillCovering()) {
        if (Date.now() > deadline) { done(false); return; }
        window.requestAnimationFrame(attempt);
        return;
      }
      const handle = block.querySelector<HTMLElement>('.brief-summary, .queue-row-main') ?? block;
      if (handle === block && !block.hasAttribute('tabindex')) block.setAttribute('tabindex', '-1');
      block.scrollIntoView({ block: 'center', behavior: 'smooth' });
      handle.focus({ preventScroll: true });
      // 강조는 "여기다"라고 말하는 표식이지 상태가 아니다 — 스스로 사라진다.
      block.setAttribute('data-progress-handoff', 'on');
      window.setTimeout(() => block.removeAttribute('data-progress-handoff'), 4000);

      // 늦게 오는 시트의 포커스 되돌림에 밀리지 않게 잠깐만 지켜본다.
      let guard = 0;
      const hold = window.setInterval(() => {
        guard += 1;
        if (!document.contains(handle) || guard > 12) { window.clearInterval(hold); return; }
        if (document.activeElement !== handle) handle.focus({ preventScroll: true });
      }, 60);
      done(true);
    };
    attempt();
  });
}

export function ResearchComposer({
  value,
  onChange,
  helper,
  placeholder,
  busy = false,
  autofocus = false,
  receipt = IDLE,
}: ResearchComposerProps) {
  const draft = useMemo(() => decomposeResearchInstruction(value), [value]);
  const selection = researchSelectionState(draft.scopeKeys);
  const countLabel = researchSelectionCountLabel(draft.scopeKeys);
  const budget = researchTextBudget(draft.scopeKeys);
  const preview = composeResearchInstruction(draft);

  const applyScopes = (scopeKeys: string[]) => onChange(composeResearchInstruction({ scopeKeys, text: draft.text }));
  const applyText = (text: string) => onChange(composeResearchInstruction({ scopeKeys: draft.scopeKeys, text }));

  const surfaceState = busy
    ? 'active'
    : receipt.state === 'failed' ? 'error'
      : receipt.state === 'accepted' ? 'done' : 'idle';

  return (
    <AiSurface className="research-request" state={surfaceState}>
      <AiSurfaceHead title="AI 조사 요청" badge="소유자 전용" helper={helper} />

      <section className="research-scopes" aria-labelledby="research-scope-title">
        <div className="research-scope-bar">
          <span className="research-scope-title" id="research-scope-title">
            <ListChecks aria-hidden="true" size={13} />무엇을 조사할까요?
          </span>
          {/* 개수는 언제나 읽힌다. 버튼 글자는 지금 상태의 사실만 말한다 — 다 골라 놓고 `모두 선택`이라
              적혀 있으면 거짓말이 된다. 일부만 고른 상태는 `aria-pressed="mixed"`로 남는다. */}
          <span className="research-scope-count" role="status">{countLabel}</span>
          <button
            className="research-scope-all"
            type="button"
            aria-pressed={researchSelectAllPressed(draft.scopeKeys)}
            onClick={() => applyScopes(nextResearchScopeSelection(draft.scopeKeys))}
          >{researchSelectAllLabel(draft.scopeKeys)}</button>
          {/* 일부만 고른 상태에서는 `모두 선택`이 비우지 않으므로(누르면 전부가 된다) 비우는 길을 따로 낸다. */}
          {selection === 'partial' && (
            <button className="research-scope-clear" type="button" onClick={() => applyScopes([])}>
              <Eraser aria-hidden="true" size={12} />선택 지우기
            </button>
          )}
        </div>
        <div className="research-scope-grid" role="group" aria-label="AI 조사 항목">
          {RESEARCH_SCOPES.map((scope) => {
            const on = draft.scopeKeys.includes(scope.key);
            return (
              <button
                key={scope.key}
                className={on ? 'research-scope-block on' : 'research-scope-block'}
                type="button"
                aria-pressed={on}
                onClick={() => applyScopes(toggleResearchScope(draft.scopeKeys, scope.key))}
              >
                {/* 상태를 색으로만 말하지 않는다 — 켜진 항목에는 표식이 붙는다. */}
                <span className="research-scope-tick" aria-hidden="true">{on ? '✓' : '+'}</span>
                <span className="research-scope-name">{scope.label}</span>
                <span className="research-scope-hint">{scope.hint}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* 항목을 골라도 자유 입력은 그대로 남는다. 둘은 경쟁하지 않는다. */}
      <IonTextarea
        aria-label="AI 조사 요청"
        autofocus={autofocus}
        autoGrow
        maxlength={budget}
        placeholder={placeholder}
        value={draft.text}
        onIonInput={(inputEvent) => applyText(String(inputEvent.detail.value ?? ''))}
      />

      {/* 보내기 전에 **보낼 그 문장**을 그대로 보여 준다. 합쳐지는 방식을 설명하지 않고 결과를 보인다. */}
      <div className="research-preview" aria-label="보낼 요청 미리보기">
        <span className="research-preview-label">이대로 보냅니다</span>
        {preview
          ? <p className="research-preview-body">{preview}</p>
          : <p className="research-preview-empty">아직 고른 항목도, 적은 내용도 없어요. 위에서 항목을 고르거나 직접 적으면 보낼 문장이 여기 그대로 보입니다.</p>}
      </div>

      {receipt.state === 'accepted' && (
        <div className="research-receipt is-accepted" role="status">
          <span className="research-receipt-mark" aria-hidden="true"><CircleCheck size={15} /></span>
          <div className="research-receipt-copy">
            <strong>접수 확인</strong>
            <p>{receipt.note}</p>
          </div>
          {receipt.onOpenProgress && (
            <button type="button" onClick={receipt.onOpenProgress}>{receipt.progressLabel ?? '진행 보기'}</button>
          )}
        </div>
      )}

      {receipt.state === 'failed' && (
        <div className="research-receipt is-failed" role="alert">
          <span className="research-receipt-mark" aria-hidden="true"><CircleAlert size={15} /></span>
          <div className="research-receipt-copy">
            <strong>접수 실패</strong>
            <p>{receipt.reason}</p>
            <p className="research-receipt-keep">적어 둔 내용과 고른 항목은 그대로 있어요.</p>
          </div>
          {receipt.onRetry && (
            <button type="button" onClick={receipt.onRetry}>{receipt.retryLabel ?? '다시 시도'}</button>
          )}
        </div>
      )}

      <AiScopeNote>{RESEARCH_SCOPE_DOES}</AiScopeNote>
      <AiScopeNote limit>{RESEARCH_SCOPE_LIMITS}</AiScopeNote>
    </AiSurface>
  );
}
