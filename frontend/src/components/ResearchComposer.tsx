// `AI 조사 요청` 작성 자리. 두 화면(촬영 탭·인물 카드 시트)이 이 하나를 같이 쓴다.
//
// 이 컴포넌트가 소유하는 것은 **작성 · 선택 · 깊이 · 제출 · 접수 확인/접수 실패**까지다
// (TSK-000535 / TSK-000542 / ISS-000050). 접수된 뒤의 처리 진행은 여기서 말하지 않는다 —
// founder 판정 2026-08-04:
//   "캡처 탭의 AI 조사 요청에 나와 있는 진행 막대기가 필요 없는 것 같아. 완료하게 되면 명함 기록
//    혹은 진행에 블록이 생성돼서 그곳에서 진행 막대기가 올라가는데, 그렇기 때문에 AI 조사 요청에
//    있는 진행 막대기는 현재 무의미한 것 같아."
// 그래서 `AiStageRail`은 여기서 걷어내고, 접수가 끝나면 **진행을 소유한 기록 블록으로 손을 넘긴다**.
// (`AiStageRail` 자체는 지우지 않는다 — 기록 블록과 `AI 사람 찾기`가 계속 쓴다.)
//
// ── 위계 (TSK-000542 / INT-000030) ──
// founder 판정 2026-08-04:
//   "제안하는 것들의 블록들이 일단 크기가 너무 커. … 모두 선택을 주로 제일 많이 누르니까 그게
//    이제 내가 글로 직접 적는 부분 바로 아래에 나왔으면 해. 그것도 엄청 누르고 싶게."
// 그래서 자리 순서가 계약이다:
//   1. 자유 입력  — 사람이 직접 적는 자리가 맨 위
//   2. 모두 선택  — 가장 자주 누르는 하나. 화면 폭을 다 쓰고 채워진 면으로 선다.
//   3. 조사 범위  — 낱개는 **작게**. 설명 줄을 칸마다 붙이지 않고 접근성 이름으로 넘긴다.
//   4. 선택 수    — 결과를 확인하는 자리이므로 고르는 것들 **뒤에** 온다.
// `e2e/int30-research.spec.ts`가 이 네 자리의 문서 순서를 그대로 검사한다.
//
// ── 깊이 (TSK-000542) ──
// founder 판정 2026-08-04:
//   "빠른 조사, 일반 조사, 깊은 조사를 선택하는 옵션 버튼이 있었으면 좋겠어. … 실질적으로 유저는
//    어떤 모델이 연결되는지 사실에 대해서 몰랐으면 좋겠어."
// 그래서 이 파일은 `research-mode.ts`의 **사용자 문구 표만** 읽는다. 내부 식별자·라우팅 설정은
// 손에 쥐지 않는다 — 쥐지 않으면 실수로 그릴 수도 없다.
//
// 항목 선택(TSK-000536)은 `research-scope.ts`가 소유한다. 이 파일은 그 상태를 그리기만 한다.
import './../styles/int29-research.css';
import './../styles/int30-research.css';
import { CircleAlert, CircleCheck, Eraser, ListChecks, TriangleAlert } from 'lucide-react';
import { IonTextarea } from '@ionic/react';
import { useEffect, useId, useMemo, useRef } from 'react';
import { AiScopeNote, AiSurface, AiSurfaceHead } from './AiTaskSurface';
import { RESEARCH_SCOPE_DOES, RESEARCH_SCOPE_LIMITS } from '../services/ai-stages';
import {
  DEFAULT_RESEARCH_DEPTH,
  RESEARCH_DEEP_CLOSED,
  RESEARCH_DEPTHS,
  RESEARCH_WAIT_STEPS,
  type ResearchDeepState,
  type ResearchDepth,
  evaluateResearchSubmit,
  normalizeResearchDeepState,
  normalizeResearchDepth,
  researchDepthSummary,
  resolveResearchRoute,
} from '../services/research-mode';
import { recordResearchRoute } from '../services/research-telemetry';
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
  /** 지금 고른 조사 깊이. 없으면 `일반 조사`. */
  depth?: ResearchDepth;
  onDepthChange?: (next: ResearchDepth) => void;
  /**
   * 서버가 깊은 조사에 대해 지금까지 한 말 (`unknown` · `open` · `closed`).
   *
   * **선택 prop이 아니다.** 기본값을 주면 그 기본값이 조용히 답이 되고, 새로 생기는 사용처가
   * 물어보지도 않은 채 어느 한쪽 화면을 그리게 된다.
   *
   * 세 값이 화면에서 다르게 보이는 방식 (TSK-000560 / INT-000036):
   *   `unknown` 아무 말도 하지 않는다. 세 깊이가 평범하게 서 있고 경고 장식이 하나도 없다.
   *   `closed`  고를 수는 있되 **지금 접수되지 않는다는 사실**을 durable 문장으로 말한다.
   *   `open`    아무것도 덧붙이지 않는다.
   *
   * 어느 값에서도 **고르는 것 자체는 막지 않는다.** 예전에는 `false` 하나가 위 두 경우를 모두
   * 뜻해서, 아직 못 들은 동안 칸이 꺼져 있다가 목록 응답이 도착하는 순간 켜졌다 — 닫힌 기능이
   * 요청마다 붙는 지연처럼 보인 원인이다.
   */
  deepState: ResearchDeepState;
  helper: string;
  placeholder: string;
  /** 지금 보내는 중인가 */
  busy?: boolean;
  autofocus?: boolean;
  receipt?: ResearchReceipt;
  /**
   * 막힘 안내에 붙일 고정 id.
   *
   * 이 자리는 제출 버튼을 소유하지 않는다(촬영 탭의 `완료`, 인물 시트의 `조사 요청 접수`는 밖에 있다).
   * 밖에 있는 그 버튼이 막혔을 때 **이 설명으로 손을 데려다 놓아야** 막다른 길이 되지 않으므로,
   * 부르는 쪽이 이름을 정해 준다. 주지 않으면 인스턴스별 id를 쓴다.
   */
  noticeId?: string;
}

const IDLE: ResearchReceipt = { state: 'idle' };

/**
 * 막혔을 때 손을 **막힘을 풀 수 있는 자리**로 데려다 놓는다 — 화면 밖에 있는 제출 버튼을
 * 눌렀을 때의 유일한 응답이다.
 *
 * 아무 일도 일어나지 않는 버튼은 고장으로 읽힌다. 그래서 스크롤과 포커스를 함께 옮긴다.
 *
 * ── 왜 안내 문단이 아닌가 (INT-000036 / TSK-000562)
 * 승인된 acceptance는 「실패 시 **목적 영역으로 focus**와 inline 안내를 제공한다」이다.
 * 예전에는 이 함수가 `.research-block` 문단 자체에 포커스를 줬다. 문단은 읽히기는 하지만
 * **다음 키 입력으로 할 수 있는 것이 없다** — 낭독기 사용자는 이유를 듣고 나서 다시 손으로
 * 조작을 찾아 돌아가야 한다. 막다른 곳으로 데려다 놓는 것은 응답이 아니다.
 *
 * ── 갈 곳은 **막힘을 실제로 푸는 손잡이**다
 * 지금 남은 막힘은 하나뿐이다 (DEC-000110):
 *   `deep_unavailable` → 깊이 칸. 서버가 깊은 조사를 닫아 둔 상태이므로, 범위를 아무리 골라도
 *                        풀리지 않는다. 여기서 할 수 있는 일은 다른 깊이를 고르는 것뿐이다.
 * (예전에는 `deep_requires_scope`가 하나 더 있었고 그때는 조사 범위 영역으로 보냈다. 그 조건은
 *  사라졌다 — 깊이를 고르는 것만으로 사용자에게 숙제를 만들지 않는다.)
 * 안내 문단은 그대로 보이고 `aria-describedby`로 이어져 있어서, 포커스가 닿는 순간 이유가
 * 함께 읽힌다.
 */
export function focusResearchNotice(noticeId: string): boolean {
  if (!noticeId || typeof document === 'undefined') return false;
  const notice = document.getElementById(noticeId);
  if (!notice) return false;
  const surface = notice.closest('.research-request');
  /* **고른 깊이 칸**으로 간다. 진짜 라디오라 그 자리에서 화살표로 다른 깊이를
     고를 수 있다 — 풀 수 있는 손잡이 위에 서게 된다. */
  const target = surface?.querySelector<HTMLElement>('.research-depth-option input[value="deep"]');
  /* 손잡이를 못 찾으면 안내 문단이라도 읽히게 한다 — 아무 일도 일어나지 않는 것보다 낫다. */
  const node = target ?? notice;
  if (!node.hasAttribute('tabindex') && node === notice) node.setAttribute('tabindex', '-1');
  // 스크롤은 언제나 **이유가 보이는 곳**으로 맞춘다. 손잡이만 보이고 왜 막혔는지가 화면 밖이면
  // 눈으로 보는 사람에게는 버튼이 그냥 안 눌린 것과 같다.
  notice.scrollIntoView({ block: 'center', behavior: 'smooth' });
  node.focus({ preventScroll: true });
  return true;
}

/** `모두 선택` 버튼의 두 번째 줄. 지금 상태에서 **누르면 무슨 일이 일어나는지**를 말한다. */
function selectAllSubLabel(selection: 'none' | 'partial' | 'all'): string {
  if (selection === 'all') return `${RESEARCH_SCOPES.length}가지 전부 켜짐`;
  if (selection === 'partial') return '나머지도 한 번에';
  return `조사 범위 ${RESEARCH_SCOPES.length}가지를 한 번에`;
}

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
  depth = DEFAULT_RESEARCH_DEPTH,
  onDepthChange,
  deepState,
  helper,
  placeholder,
  busy = false,
  autofocus = false,
  receipt = IDLE,
  noticeId,
}: ResearchComposerProps) {
  const draft = useMemo(() => decomposeResearchInstruction(value), [value]);
  const selection = researchSelectionState(draft.scopeKeys);
  const countLabel = researchSelectionCountLabel(draft.scopeKeys);
  const budget = researchTextBudget(draft.scopeKeys);
  const preview = composeResearchInstruction(draft);
  const activeDepth = normalizeResearchDepth(depth);
  const deep = normalizeResearchDeepState(deepState);
  // 서버가 **말한** 닫힘. `unknown`은 여기에 들어오지 않는다 — 못 들은 것을 닫힘처럼 그리면
  // 그 화면이 곧 지연으로 읽힌다 (TSK-000560).
  const deepClosed = deep === 'closed';
  // 접수 조건은 `research-mode.ts`가 판정한다. 이 파일은 그 결과를 **그리기만** 한다 —
  // 같은 규칙을 JSX에 한 벌 더 쓰면 두 화면 중 하나만 고쳐지는 날이 온다.
  const gate = evaluateResearchSubmit({
    depth: activeDepth,
    scopeCount: draft.scopeKeys.length,
    hasText: Boolean(draft.text.trim()),
    deepState: deep,
  });

  // 두 화면(촬영 탭·인물 시트)이 동시에 떠 있을 수 있다. 라디오 묶음 이름이 같으면 한쪽을 고를 때
  // 다른 쪽이 조용히 풀린다 — 브라우저는 문서 전체에서 같은 `name`을 한 묶음으로 본다.
  const instanceId = useId();
  const depthGroupName = `research-depth-${instanceId}`;
  const depthTitleId = `research-depth-title-${instanceId}`;
  const countId = `research-scope-count-${instanceId}`;
  const blockId = noticeId ?? `research-block-${instanceId}`;

  const applyScopes = (scopeKeys: string[]) => onChange(composeResearchInstruction({ scopeKeys, text: draft.text }));
  const applyText = (text: string) => onChange(composeResearchInstruction({ scopeKeys: draft.scopeKeys, text }));

  // 접수 실패는 개발자 채널에도 남긴다. 사용자에게 보이는 실패와 라우팅 기록이 어긋나면
  // "깊은 조사를 골랐는데 왜"를 나중에 되짚을 수 없다. 사용자가 적은 글자는 넘기지 않는다 —
  // 사유는 닫힌 코드 하나(`receipt_failed`)이고, 한국어 원문은 이 경계를 넘지 않는다.
  const reportedFailureRef = useRef<string | null>(null);
  useEffect(() => {
    if (receipt.state !== 'failed') { reportedFailureRef.current = null; return; }
    const signature = `${activeDepth}|${receipt.reason}`;
    if (reportedFailureRef.current === signature) return;
    reportedFailureRef.current = signature;
    recordResearchRoute(resolveResearchRoute(activeDepth), { event: 'failed', reason: 'receipt_failed' });
  }, [activeDepth, receipt]);

  const surfaceState = busy
    ? 'active'
    : receipt.state === 'failed' ? 'error'
      : receipt.state === 'accepted' ? 'done' : 'idle';

  return (
    <AiSurface className="research-request" state={surfaceState}>
      <AiSurfaceHead title="AI 조사 요청" badge="소유자 전용" helper={helper} />

      {/* 1. 직접 적는 자리가 맨 위다. 항목을 골라도 여기 적은 글은 그대로 남는다 — 둘은 경쟁하지 않는다. */}
      <IonTextarea
        aria-label="AI 조사 요청"
        autofocus={autofocus}
        autoGrow
        maxlength={budget}
        placeholder={placeholder}
        value={draft.text}
        onIonInput={(inputEvent) => applyText(String(inputEvent.detail.value ?? ''))}
      />

      <section className="research-scopes" aria-label="조사 범위">
        {/* 2. 가장 자주 누르는 하나. 폭을 다 쓰고, 할 일이 남았을 때 채워진 면으로 선다.
            다 골라 놓으면 조용한 면으로 뒤집히고 글자도 `모두 해제`가 된다 — 고장이 아니라 끝난 상태다. */}
        <button
          className="research-scope-all"
          type="button"
          aria-pressed={researchSelectAllPressed(draft.scopeKeys)}
          /* 지금 개수만 잇는다. 예전에는 막힘 안내도 함께 이어 줬는데, 그때는 이 버튼이 막힘을
             푸는 길이었기 때문이다(`deep_requires_scope`). 남은 막힘 하나(`deep_unavailable`)는
             범위와 아무 상관이 없다 — 그것을 여기 이어 두면 "모두 선택"이 자기와 무관한 이유로
             막힌 것처럼 읽힌다. */
          aria-describedby={countId}
          disabled={busy}
          onClick={() => applyScopes(nextResearchScopeSelection(draft.scopeKeys))}
        >
          <span className="research-scope-all-mark" aria-hidden="true">
            <ListChecks size={17} />
          </span>
          <span className="research-scope-all-copy">
            <strong>{researchSelectAllLabel(draft.scopeKeys)}</strong>
            <span className="research-scope-all-sub">{selectAllSubLabel(selection)}</span>
          </span>
        </button>

        {/* 3. 낱개는 작게. 한 줄짜리 chip이고, 설명은 접근성 이름과 툴팁으로 넘겼다 —
            칸마다 두 줄이 붙으면 founder가 말한 "너무 큰 블록"으로 돌아간다. */}
        <div className="research-scope-grid" role="group" aria-label="AI 조사 항목">
          {RESEARCH_SCOPES.map((scope) => {
            const on = draft.scopeKeys.includes(scope.key);
            return (
              <button
                key={scope.key}
                className={on ? 'research-scope-chip on' : 'research-scope-chip'}
                type="button"
                aria-pressed={on}
                title={scope.hint}
                disabled={busy}
                onClick={() => applyScopes(toggleResearchScope(draft.scopeKeys, scope.key))}
              >
                {/* 상태를 색으로만 말하지 않는다 — 켜진 항목에는 표식이 붙는다. */}
                <span className="research-scope-tick" aria-hidden="true">{on ? '✓' : '+'}</span>
                <span className="research-scope-name">{scope.label}</span>
                {/* 눈으로는 안 보이지만 읽어 주는 말에는 남는다. 무엇을 묻는 항목인지 잃지 않는다. */}
                <span className="research-sr-only">{scope.hint}</span>
              </button>
            );
          })}
        </div>

        {/* 4. 결과 확인 줄. 고르는 것들 뒤에 오고, 바뀔 때마다 읽어 준다. */}
        <div className="research-scope-foot">
          <span className="research-scope-count" id={countId} role="status">{countLabel}</span>
          {/* 일부만 고른 상태에서는 `모두 선택`이 비우지 않으므로(누르면 전부가 된다) 비우는 길을 따로 낸다. */}
          {selection === 'partial' && (
            <button className="research-scope-clear" type="button" disabled={busy} onClick={() => applyScopes([])}>
              <Eraser aria-hidden="true" size={12} />선택 지우기
            </button>
          )}
        </div>
      </section>

      {/* 5. 얼마나 깊게. 자리는 `모두 선택` 바로 아래다 — 무엇을 조사할지 정한 손이 그대로
          "얼마나"로 이어진다. 어떤 모델이 붙는지는 여기 없고, 있을 자리도 아니다.

          **세 칸은 첫 render부터 전부 고를 수 있다** (TSK-000560 / INT-000036).
          founder: "빠른조사, 일반조사는 그냥 선택할 수 있는데, 깊은 조사는 왜 버튼 클릭할 수 있을
          때 까지 시간이 지나야하는지 모르겠네?" / "깊은 조사 활성화는 조건이 아니라 그냥 선택할
          수 있게 해줘." 그래서 `disabled`에 남은 이유는 `busy`(보내는 중) 하나뿐이고, 그 하나는
          세 칸에 똑같이 걸린다 — 어느 깊이도 남보다 늦게 열리지 않는다. */}
      <section className="research-depth" aria-labelledby={depthTitleId} data-deep-state={deep}>
        <span className="research-depth-title" id={depthTitleId}>얼마나 깊게 볼까요?</span>
        <div className="research-depth-grid" role="radiogroup" aria-labelledby={depthTitleId}>
          {RESEARCH_DEPTHS.map((option) => {
            const on = option.depth === activeDepth;
            /* 서버가 지금 접수하지 않는다고 **말한** 칸. 지우지도, 끄지도 않는다 —
               고르는 것은 사람의 손이고 조건이 붙지 않는다. 바뀌는 것은 이 칸이 말하는 사실과,
               고른 채로 제출할 때의 판정(`evaluateResearchSubmit`)뿐이다. 고른 깊이를 대신
               낮추지 않는다. */
            const closed = option.depth === 'deep' && deepClosed;
            return (
              <label
                key={option.depth}
                className={`research-depth-option${on ? ' on' : ''}${closed ? ' closed' : ''}`}
                data-depth={option.depth}
                /* 표식이 말하는 것은 **접수**가 닫혔다는 사실이다. 여기 있던 `data-unavailable`은
                   이 칸이 꺼져 있던 시절의 표식이고, 이 저장소에서 그 이름은 지금도 "이 조작을
                   쓸 수 없다"는 뜻이다(`CaptureEntry`의 카메라 없는 카드가 그 이름을 그대로
                   쓴다). 선택이 열린 칸에 그 이름을 남겨 두면 DOM이 화면과 다른 말을 한다 —
                   사람에게는 "고를 수 있다", 기계에게는 "쓸 수 없다". INT-000036 독립 게이트가
                   실제로 그 어긋남을 잡았다 (`enabled=true` 인데 `why=data-unavailable`).
                   막힌 자리가 선택이 아니라 접수라는 것이 이 이름에도 그대로 있어야 한다. */
                data-intake={closed ? 'closed' : undefined}
                /* 고르기 **전에** 무엇이 달라지는지 볼 수 있는 자리. 칸마다 설명 줄을 붙이면
                   founder가 지적한 "너무 큰 블록"으로 돌아가므로 높이를 쓰지 않는 통로로 넘긴다. */
                title={closed ? RESEARCH_DEEP_CLOSED.detail : option.detail}
              >
                <input
                  type="radio"
                  name={depthGroupName}
                  value={option.depth}
                  checked={on}
                  /* 보내는 중에만 잠긴다. 연결 상태·목적 선택·서버 응답은 선택 조건이 아니다. */
                  disabled={busy}
                  /* 조건이 붙은 것은 이 칸이다. 고른 순간 낭독기가 이름 다음에 조건을 읽는다. */
                  aria-describedby={gate.notice && option.depth === 'deep' ? blockId : undefined}
                  onChange={() => onDepthChange?.(option.depth)}
                />
                {/* 고른 칸을 색으로만 말하지 않는다. 자리를 차지하지 않게 겹쳐 두어 320px에서도
                    줄바꿈을 만들지 않는다 (`position: absolute`). */}
                {on && <span className="research-depth-pick" aria-hidden="true">✓</span>}
                {/* 기다림의 무게는 눈금으로도 보인다. 분·초를 약속하지 않고 **순서만** 말한다. */}
                <span className="research-depth-meter" aria-hidden="true">
                  {Array.from({ length: RESEARCH_WAIT_STEPS }, (_, step) => (
                    <i key={step} className={step < option.wait ? 'on' : ''} />
                  ))}
                </span>
                <span className="research-depth-name">{option.label}</span>
                {/* 닫혀 있으면 결과 요약 대신 **지금의 사실**을 말한다. "못 골라요"가 아니다 —
                    고르는 것은 되고, 안 되는 것은 접수다. 색으로만 알리지 않는다. */}
                <span className="research-depth-short">{closed ? RESEARCH_DEEP_CLOSED.short : option.short}</span>
                {/* 눈으로는 눈금이, 읽어 주는 말에는 문장이 간다. */}
                <span className="research-sr-only">{closed ? RESEARCH_DEEP_CLOSED.detail : option.detail}</span>
              </label>
            );
          })}
        </div>
        {/* 고른 깊이 하나만 길게 설명한다. 칸마다 문장을 붙이지 않아 높이가 세 배로 늘지 않고,
            바꿀 때마다 이 줄이 읽혀서 "무엇이 달라지는지"가 예측 가능해진다.
            고른 깊이가 지금 닫혀 있으면 **하게 될 일을 설명하지 않는다** — 하지 않을 일을 설명하는
            문장은 거짓말이고, 이 줄이 사용자가 고른 것에 대해 읽는 유일한 문장이다. */}
        <p className="research-depth-summary" role="status">
          {activeDepth === 'deep' && deepClosed ? `깊은 조사 — ${RESEARCH_DEEP_CLOSED.detail}` : researchDepthSummary(activeDepth)}
        </p>
        {/* 닫혀 있다는 사실을 **네 번째 블록으로 세우지 않는다.**

            세워 봤고, 그것이 표면을 뷰포트보다 크게 만들었다 (866.7px vs 844px). 이 작성 자리는
            이미 폰 화면 하나를 거의 다 쓰고 있어서, 여기에 새 문단을 얹으면 표면 위쪽 기준선이
            화면 밖으로 밀려나고 `e2e/surface-polish.spec.ts`의 표면 측정이 실제로 깨진다
            (빛 번짐 폭 90% → 84%). 공간은 이 lane 혼자 쓰는 예산이 아니다.

            그래서 닫힘은 **이미 있는 자리 넷**이 나눠 말한다 — 어느 것도 진행이 아니고, 어느
            것도 새 높이를 쓰지 않는다:
              1. 깊이 칸 안의 `지금은 접수 안 돼요` — 닫혀 있는 내내 눈에 보이는 사실.
              2. 그 칸의 `title`(호버)과 `research-sr-only`(낭독기) — 뜻과 회복 방법 한 문장.
              3. 깊은 조사를 고르는 순간의 접수 조건 안내(`.research-block`) — 이유와 회복 방법.
              4. 같은 순간의 요약 줄 — 하지 않을 일을 설명하지 않는다. */}
      </section>

      {/* 보내기 전에 **보낼 그 문장**을 그대로 보여 준다. 합쳐지는 방식을 설명하지 않고 결과를 보인다. */}
      <div className="research-preview" aria-label="보낼 요청 미리보기">
        <span className="research-preview-label">이대로 보냅니다</span>
        {preview
          ? <p className="research-preview-body">{preview}</p>
          : <p className="research-preview-empty">아직 고른 항목도, 적은 내용도 없어요. 위에서 항목을 고르거나 직접 적으면 보낼 문장이 여기 그대로 보입니다.</p>}
      </div>

      {/* 접수 조건 안내. **지금 여기 뜨는 이유는 하나뿐이다** — 서버가 깊은 조사를 열어 두지
          않았다고 말한 경우(`deep_unavailable`). 사용자가 고른 것 때문에 뜨는 조건은 없다
          (DEC-000110: 깊이는 모델만 바꾼다).
          자리는 **제출 버튼 바로 위**다 — 제출은 이 컴포넌트 밖에 있고(촬영 탭의 `완료`,
          인물 시트의 `조사 요청 접수`), 눌러서 튕겨 나온 사람이 가장 먼저 보는 곳이 여기다.
          실패가 아니라 **지금의 사실**이므로 `role="alert"`가 아니라 `role="status"`다.
          아직 아무것도 적지 않았을 때에도 같은 말을 미리 보여 준다 — 긴 글을 다 적은 뒤에
          처음 알게 되면 늦다.

          `data-block`은 장식이 아니다. 막혔을 때 손이 어디로 가야 하는지를 이 값이 정한다
          (`focusResearchNotice`). 판정은 `evaluateResearchSubmit` 하나가 하고 이 자리는 그것을
          그대로 싣는다. */}
      {gate.notice && (
        <p
          className="research-block"
          data-block={gate.notice.block}
          data-blocked={gate.blocked ? 'yes' : 'not-yet'}
          id={blockId}
          role="status"
        >
          <span className="research-block-mark" aria-hidden="true"><TriangleAlert size={15} /></span>
          <span className="research-block-copy">
            <strong>{gate.notice.title}</strong>
            <span>{gate.notice.reason}</span>
            <span className="research-block-fix">{gate.notice.fix}</span>
          </span>
        </p>
      )}

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
            <p className="research-receipt-keep">적어 둔 내용과 고른 항목, 고른 깊이는 그대로 있어요.</p>
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
