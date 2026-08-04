// 직접 입력 — 자연어로 사람을 등록하는 화면 (ISS-000231 / TSK-000533 / DEC-000103)
//
// 이 파일이 스타일을 먼저 들여온다. 공용 `app.css`에 새 규칙을 얹지 않기 위한 자리다.
import '../styles/int29-manual.css';

import { IonButton, IonContent, IonHeader, IonModal, IonTextarea, IonTitle, IonToolbar } from '@ionic/react';
import { CircleAlert, PenLine, Plus, ShieldCheck, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CaptureQueueItem } from '../contracts/capture';
import { captureContextSummary } from '../services/capture-context';
import {
  buildManualIntake,
  clearManualDraft,
  extractIdentityEvidence,
  hasIdentityEvidence,
  manualQueueWriteMessage,
  manualSubmitRefusal,
  manualSubmitRefusalMessage,
  manualTextBudget,
  manualUploadErrorMessage,
  MANUAL_PLACEHOLDER,
  MANUAL_SCOPE_DOES,
  MANUAL_SCOPE_LIMITS,
  MANUAL_TEXT_MAX,
  saveManualDraft,
  startManualDraft,
  type ManualDraft,
  type ManualSubmitRefusal,
} from '../services/manual-person';
import { putQueueItemVerified, QueueWriteError } from '../services/queue';

export interface ManualPersonEntryProps {
  /** 연결 설정이 끝났는가. 아직이면 기기에만 저장된다는 사실을 그대로 말한다. */
  configured: boolean;
  /** 촬영 화면이 이미 들고 있는 만남 맥락. 여기서 다시 묻지 않고 그대로 함께 저장한다. */
  context: { event: string; relKairen: string; relSelf: string };
  /** 대기열 현재 상태. 접수 영수증이 "지금 어디까지 갔는가"를 추측하지 않고 읽는다. */
  queue: CaptureQueueItem[];
  /** 기기 저장이 확인된 항목. 호출자가 목록에 넣고 전송을 시작한다. */
  onQueued: (item: CaptureQueueItem) => void;
  /**
   * 열림을 밖에서 소유할 때 쓴다 (TSK-000220).
   *
   * 진입 카드가 `CaptureEntry`로 옮겨 가면서 이 컴포넌트는 더 이상 자기 트리거를 그리지 않는다 —
   * 두 입구가 서로 다른 파일에서 각자 그려지던 것이 "하나는 설명이 있고 하나는 없고"의 원인이었다.
   * 값을 주지 않으면 예전처럼 자기 버튼을 그리고 스스로 연다(기존 호출자 호환).
   */
  open?: boolean;
  /** 통제 모드에서 열림이 바뀔 때. 닫힘(`false`)이 오면 호출자가 초안 상태를 다시 읽는다. */
  onOpenChange?: (open: boolean) => void;
}

type ManualPhase = 'compose' | 'saving' | 'receipt';

/**
 * 촬영 버튼의 쌍둥이 + 입력 시트 + 접수 영수증.
 *
 * 버튼은 `.primary-entries` grid의 두 번째 칸으로 들어간다 — 하위 메뉴가 아니라 형제다.
 * `ion-modal`은 열릴 때 `position: fixed`로 뜨고 닫혀 있을 때는 `display: none`이라
 * 같은 grid 안에 있어도 칸을 만들지 않는다.
 */
export function ManualPersonEntry({ configured, context, queue, onQueued, open: openProp, onOpenChange }: ManualPersonEntryProps) {
  // 통제 모드에서는 열림의 진실이 밖에 있다. 안쪽 state를 함께 두면 두 진실이 어긋난다.
  const controlled = openProp !== undefined;
  const [selfOpen, setSelfOpen] = useState(false);
  const open = controlled ? openProp : selfOpen;
  const setOpen = useCallback((next: boolean) => {
    if (!controlled) setSelfOpen(next);
    onOpenChange?.(next);
  }, [controlled, onOpenChange]);
  const [draft, setDraft] = useState<ManualDraft>(() => startManualDraft());
  const [phase, setPhase] = useState<ManualPhase>('compose');
  const [refusal, setRefusal] = useState<ManualSubmitRefusal | null>(null);
  const [writeError, setWriteError] = useState('');
  const [receiptId, setReceiptId] = useState('');
  const [receiptText, setReceiptText] = useState('');
  const fieldRef = useRef<HTMLIonTextareaElement>(null);
  // 연타의 두 번째 클릭은 재렌더 전에 도착할 수 있다. state로 막으면 늦는다.
  const submittingRef = useRef(false);

  const text = draft.text;
  const budget = useMemo(() => manualTextBudget(text), [text]);
  const evidence = useMemo(() => extractIdentityEvidence(text), [text]);
  const contextSummary = useMemo(
    () => captureContextSummary({ event: context.event, relKairen: context.relKairen, relSelf: context.relSelf, memo: '' }),
    [context.event, context.relKairen, context.relSelf],
  );
  const receiptItem = useMemo(
    () => queue.find((item) => item.captureId === receiptId) ?? null,
    [queue, receiptId],
  );

  // 다른 화면(연결 변경 등)에서 subject가 바뀌면 초안 자리도 바뀐다. 열 때 다시 읽는다.
  useEffect(() => {
    if (!open || phase !== 'compose' || draft.text) return;
    const stored = startManualDraft();
    if (stored.captureId !== draft.captureId || stored.text !== draft.text) setDraft(stored);
    // draft는 의도적으로 의존성에서 뺀다 — 여기서 다시 읽는 순간은 시트를 여는 때 하나뿐이다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, phase]);

  const updateText = useCallback((value: string) => {
    setRefusal(null);
    setWriteError('');
    setDraft((current) => {
      // 상한을 넘겨 붙여 넣으면 잘라 낸다. 넘긴 채로 두면 서버가 자르는 자리가 어디인지
      // 사용자가 알 수 없다 — 잘리는 것을 지금 보여 준다.
      const next = { ...current, text: value.slice(0, MANUAL_TEXT_MAX), updatedAt: new Date().toISOString() };
      // 입력 즉시 저장한다 — `등록하기`를 못 눌러도 앱을 껐다 켜면 그대로 있어야 한다.
      saveManualDraft(next);
      return next;
    });
  }, []);

  const closeSheet = useCallback(() => {
    setOpen(false);
    // 영수증을 보고 닫았다면 다음에 열 때는 빈 화면에서 시작한다.
    setPhase('compose');
    setRefusal(null);
    setWriteError('');
  }, [setOpen]);

  const submit = useCallback(async () => {
    if (submittingRef.current) return;
    const reason = manualSubmitRefusal(draft.text);
    if (reason) {
      setRefusal(reason);
      void fieldRef.current?.setFocus();
      return;
    }
    submittingRef.current = true;
    setRefusal(null);
    setWriteError('');
    setPhase('saving');
    try {
      // 초안이 들고 있던 captureId를 그대로 쓴다 — 이것이 "같은 내용은 job 하나"의 근거다.
      const item = buildManualIntake({
        captureId: draft.captureId,
        text: draft.text,
        event: context.event,
        relKairen: context.relKairen,
        relSelf: context.relSelf,
      });
      // 저장했다고 말하기 전에 다시 읽어 내용이 온전한지 확인한다 (FI-032).
      await putQueueItemVerified(item);
      clearManualDraft();
      setReceiptId(item.captureId);
      setReceiptText(item.manualText ?? '');
      // 다음 등록은 새 초안 = 새 captureId. 방금 것과 섞이지 않는다.
      setDraft(startManualDraft());
      setPhase('receipt');
      onQueued(item);
    } catch (error) {
      // 실패했을 때 적은 글은 그대로 남아 있다 — 다시 누르면 같은 내용으로 재시도된다.
      setPhase('compose');
      setWriteError(error instanceof QueueWriteError ? manualQueueWriteMessage[error.failure] : manualQueueWriteMessage.unknown);
    } finally {
      submittingRef.current = false;
    }
  }, [context.event, context.relKairen, context.relSelf, draft.captureId, draft.text, onQueued]);

  const startAnother = useCallback(() => {
    setPhase('compose');
    setRefusal(null);
    setWriteError('');
    setReceiptId('');
    setReceiptText('');
    window.setTimeout(() => void fieldRef.current?.setFocus(), 60);
  }, []);

  // 상태 한 줄. 늘 같은 자리에서 지금 사실만 말한다(낭독기도 이 자리를 읽는다).
  const tip = refusal
    ? manualSubmitRefusalMessage[refusal]
    : writeError
      ? writeError
      : hasIdentityEvidence(evidence)
        ? `이메일 ${evidence.emails.length}개, 전화 ${evidence.phones.length}개를 식별 단서로 읽었어요.`
        : '이름을 몰라도 괜찮아요. 언제·어디서 만났고 무슨 일을 하는 사람인지 기억나는 대로 적어 주세요.';

  const sendState = receiptItem?.state ?? 'queued';
  const sendCopy = sendState === 'sent'
    ? '서버가 접수했어요. 처리 상태는 아래 명함 기록에서 이어서 볼 수 있어요.'
    : sendState === 'failed'
      ? manualUploadErrorMessage(receiptItem?.err)
      : configured
        ? '전송은 알아서 이어갑니다 — 지금 폰을 넣어도 괜찮아요.'
        : '연결 설정이 끝나면 자동으로 전송합니다. 그때까지 이 폰에 안전하게 보관돼요.';

  return (
    <>
      {/* 통제 모드에서는 진입 카드가 `CaptureEntry`에 있다. 여기서 또 그리면 같은 입구가 두 개가 된다. */}
      {!controlled && (
        <button className="manual-main" type="button" onClick={() => setOpen(true)}>
          <span className="manual-main-icon" aria-hidden="true"><PenLine size={24} /></span>
          <span>직접 입력</span>
          {draft.text.trim()
            ? <span className="manual-main-resume">이어서 쓰기</span>
            : <span className="manual-main-sub">명함 없이 기억으로</span>}
        </button>
      )}

      <IonModal
        className="manual-sheet"
        aria-label="직접 입력으로 사람 등록"
        isOpen={open}
        handle={false}
        initialBreakpoint={0.94}
        breakpoints={[0, 0.94]}
        onDidDismiss={closeSheet}
        onDidPresent={() => { if (phase === 'compose') void fieldRef.current?.setFocus(); }}
      >
        <IonHeader>
          <IonToolbar>
            <IonTitle>직접 입력</IonTitle>
            <IonButton slot="end" fill="clear" disabled={phase === 'saving'} onClick={closeSheet}>
              {phase === 'receipt' ? '닫기' : '취소'}
            </IonButton>
          </IonToolbar>
        </IonHeader>
        <IonContent>
          <div className="manual-sheet-body">
            {phase === 'receipt' ? (
              <section className="manual-receipt" aria-label="직접 입력 접수 결과">
                <div className="manual-receipt-head">
                  <span className="manual-receipt-icon" aria-hidden="true"><ShieldCheck size={20} /></span>
                  <div className="manual-receipt-copy">
                    <strong>이 폰에 저장했어요 — 접수 완료</strong>
                    <small role="status">{sendCopy}</small>
                  </div>
                </div>
                <blockquote>{receiptText}</blockquote>
                {sendState === 'failed' && (
                  <p className="manual-blocked">적으신 내용은 지워지지 않았어요. 위 안내대로 해결되면 다시 입력할 필요 없이 자동으로 올라갑니다.</p>
                )}
                <ul className="manual-next">
                  <li>명함을 찍었을 때와 같은 순서로 처리해요 — 중복 확인, 공개 정보 조사, 브리핑.</li>
                  <li>이메일·전화처럼 확실한 단서가 기존 인물과 정확히 맞을 때만 그 사람에게 이어 붙여요.</li>
                  <li>확실하지 않으면 기존 기록은 건드리지 않고 새 인물로 등록합니다.</li>
                  <li>진행 상황은 아래 <b>명함 기록</b>에서 다른 캡처와 같은 자리에 나타나요.</li>
                </ul>
                <div className="manual-actions">
                  <IonButton className="primary-action" expand="block" onClick={startAnother}>
                    <Plus aria-hidden="true" size={16} />&nbsp;한 사람 더 적기
                  </IonButton>
                </div>
              </section>
            ) : (
              <>
                <div className="manual-sheet-head">
                  <span className="manual-kicker"><Sparkles aria-hidden="true" size={13} />명함 없이 등록</span>
                  <h2>기억나는 대로 적어 주세요</h2>
                  <p>명함을 못 받았거나 사진을 찍기 어려운 자리에서 쓰는 입구예요. 적어 주신 글을 명함처럼 읽어 인물로 정리합니다.</p>
                </div>

                <div className="manual-field">
                  <label className="manual-label" htmlFor="manual-person-text">이 사람에 대해 아는 내용</label>
                  <IonTextarea
                    id="manual-person-text"
                    className="manual-input"
                    ref={fieldRef}
                    aria-label="이 사람에 대해 아는 내용"
                    autoGrow
                    maxlength={MANUAL_TEXT_MAX}
                    placeholder={MANUAL_PLACEHOLDER}
                    value={text}
                    onIonInput={(inputEvent) => updateText(String(inputEvent.detail.value ?? ''))}
                  />
                  <div className="manual-field-foot">
                    <p className="manual-tip" role="status">{tip}</p>
                    {/* 상한이 실제로 가까워졌을 때만 남은 여유를 말한다 — 늘 떠 있는 카운터는 잔소리다. */}
                    {budget.nearLimit && (
                      <span className={budget.over ? 'manual-budget over' : 'manual-budget'}>
                        {budget.over ? `${-budget.remaining}자 초과` : `${budget.remaining}자 남음`}
                      </span>
                    )}
                  </div>
                </div>

                {hasIdentityEvidence(evidence) && (
                  <section className="manual-evidence" aria-label="찾은 식별 단서">
                    <strong>이걸 식별 단서로 읽었어요</strong>
                    <ul>
                      {evidence.emails.map((email) => <li key={`mail-${email}`}>이메일 {email}</li>)}
                      {evidence.phoneDisplays.map((phone) => <li key={`tel-${phone}`}>전화 {phone}</li>)}
                    </ul>
                    <p className="manual-evidence-note">이 단서가 기존 인물과 <b>정확히</b> 일치할 때만 그 사람에게 이어 붙여요. 조금이라도 어긋나면 기존 기록은 그대로 두고 새 인물로 등록합니다.</p>
                  </section>
                )}

                <section className="manual-context" aria-label="함께 저장되는 만남 맥락">
                  <strong>함께 저장되는 만남 맥락</strong>
                  <p>{contextSummary
                    ? `${contextSummary} — 촬영 화면의 만남 맥락을 그대로 씁니다.`
                    : '아직 비어 있어요. 촬영 화면의 만남 맥락에 적으면 직접 입력에도 함께 저장됩니다.'}</p>
                </section>

                <div className="manual-scope">
                  <p>{MANUAL_SCOPE_DOES}</p>
                  <p>{MANUAL_SCOPE_LIMITS}</p>
                </div>

                {refusal && (
                  <p className="manual-refusal" role="alert">
                    <CircleAlert aria-hidden="true" size={14} />&nbsp;{manualSubmitRefusalMessage[refusal]}
                  </p>
                )}
                {writeError && <p className="manual-refusal" role="alert">{writeError}</p>}

                <div className="manual-actions">
                  {/* 비활성 버튼은 이유를 말할 수 없다. 눌리게 두고 왜 안 되는지 알려 준다. */}
                  <IonButton className="primary-action" expand="block" disabled={phase === 'saving'} onClick={() => void submit()}>
                    {phase === 'saving' ? '저장 중…' : '등록하기'}
                  </IonButton>
                  <button className="manual-secondary" type="button" disabled={phase === 'saving'} onClick={closeSheet}>취소</button>
                </div>
              </>
            )}
          </div>
        </IonContent>
      </IonModal>
    </>
  );
}
