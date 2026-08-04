/**
 * 상단 바 오른쪽의 갱신 덩어리 (INT-000030 / TSK-000543, INT-000036 / TSK-000559).
 *
 * founder 판정 1 (INT-000030): "이게 뭔가 새로고침이 되고 있는 건지, 자동 새로고침 기능이
 * 꺼져서 켜져서인지 라든가, 뭐 이런 것들이 좀 헷갈리는 것 같아."
 *
 * 원인은 배치가 아니라 **기호 하나가 세 가지 뜻을 겸했다**는 것이다. 돌아가는 아이콘 하나가
 * (1) 자동 갱신이 켜져 있다 (2) 지금 요청이 오간다 (3) 화면이 최신이다 를 동시에 말하려 했다.
 * 어느 뜻인지 알 방법이 없으니 셋 다 못 읽는다.
 *
 * 그래서 여기서 셋을 갈라 각자 다른 시각적 일을 맡긴다.
 *   1. 기능 상태 — 스위치. 켜짐/꺼짐이 모양으로 명시된다. 추측할 것이 없다.
 *   2. 작업 상태 — 새로고침 버튼. 회전과 `aria-busy`는 **사용자가 누른 요청** 동안에만 있다.
 *   3. 신선도 — 아래 한 줄. 마지막으로 받은 시점과 지금 걸려 있는 박자를 글자로 말한다.
 *
 * ── founder 판정 2 (INT-000036): "오른쪽 위에 새로고침 버튼이 돌아가고 있는데, 이제 갱신
 * 중이라고 뜨는 게 이상해. 그러고 눌렀을 때 새로고침 중이라고 뭔가 위에서 내려오는데,
 * 이거 굳이 있어야 되나 싶어."
 *
 * 위의 (2)는 계약으로만 옳았고 실제로는 지켜지지 않았다. `busy`가 App의 `loading`에서 왔고
 * `loading`은 **모든 목록 조회**에서 참이 된다 — 자동 폴링을 포함해서. 그래서 아무도 누르지
 * 않은 화면이 스스로 돌았고, 그 위에 토스트 세 장(진행·완료·실패)이 겹쳤다.
 *
 * 이제 진행 사실의 주인은 **누른 사람의 영수증 하나**다.
 *   - `busy`는 prop이 아니라 `status.state === 'in-flight'`에서만 나온다. 공유 플래그를
 *     넘겨받을 통로 자체를 없앴다 — 통로가 있으면 언젠가 다시 그리로 흘러 들어온다.
 *   - 성공은 신선도 줄이 바뀌는 것으로 닫힌다. 성공 토스트는 없다.
 *   - 실패·막힘은 사라지지 않는 안내(`.int30-refresh-notice`)로 이 덩어리 안에 남는다.
 *
 * 박자 숫자는 `plan.intervalMs`에서만 나온다(`refreshCadenceText`). 적응형이라 처리 중에는
 * 4초, 조용할 때는 20초인데 화면에 20초를 박아 두면 그 자체로 거짓말이 된다.
 */
import { RefreshCw, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import {
  refreshCadenceSentence,
  refreshHeadlineText,
  refreshNotice,
  type RefreshCadencePlan,
  type RefreshStatus,
} from '../services/refresh-orchestrator';
import '../styles/int30-refresh.css';

const CADENCE_ID = 'int30-refresh-cadence';
const SENTENCE_ID = 'int30-refresh-sentence';
const NOTICE_ID = 'int30-refresh-notice';
/** 누름 표시가 살아 있는 시간. 연타의 두 번째·세 번째가 화면에서 사라지지 않게 한다. */
const PRESS_ACK_MS = 600;

export interface RefreshControlProps {
  autoRefreshOn: boolean;
  onAutoRefreshChange(next: boolean): void;
  onManualRefresh(): void;
  /**
   * 온라인으로 돌아왔을 때의 **조용한** 재개. 사용자가 한 일이 아니므로 영수증을 남기지
   * 않는다 — 여기서 `onManualRefresh`를 부르면 아무도 누르지 않은 화면이 다시 돌기 시작한다.
   */
  onResume?(): void;
  /** 지금 걸려 있는 폴링 계획. 타이머를 거는 것과 **같은 값**이라 문구가 실제와 어긋날 수 없다. */
  plan: RefreshCadencePlan;
  /** 직접 누른 갱신의 영수증(진행·성공·실패). 자동 박자는 여기에 영수증을 남기지 않는다. */
  status: RefreshStatus | null;
  /** 마지막 성공에서 지난 시간(ms). 아직 한 번도 못 받았으면 null. */
  lastSuccessAgoMs: number | null;
}

/** 이 기기가 네트워크에 붙어 있는가. 브라우저가 이미 관리하는 사실을 화면이 직접 본다. */
function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    update();
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

export function RefreshControl(props: RefreshControlProps): ReactElement {
  const { autoRefreshOn, plan, status } = props;
  const online = useOnline();
  /* 진행 사실의 유일한 출처. prop으로 받지 않는 것이 이 컴포넌트의 계약이다 —
     `loading` 같은 공유 플래그가 다시 흘러 들어올 통로를 만들지 않는다. */
  const busy = status?.state === 'in-flight';
  const blocked = plan.reason === 'disconnected';

  /* 실패 영수증이 아직 유효한가.
     자동 폴링은 orchestrator를 거치지 않으므로, 실패 안내가 떠 있는 동안 배경 갱신이 조용히
     성공하면 안내만 옛 사실로 남는다. 그때 화면은 최신인데 "실패"라고 쓰여 있다. 그래서
     실패 시점의 신선도를 기억해 두고, 그보다 **새 성공**이 도착하면 안내를 스스로 거둔다.
     ("다음 요청이 결말을 낼 때까지 남는다"의 정확한 뜻은 이것이다.) */
  const failureGeneration = status?.state === 'failure' ? status.generation : null;
  const ageAtFailureRef = useRef<number | null>(null);
  useEffect(() => {
    ageAtFailureRef.current = failureGeneration === null
      ? null
      : props.lastSuccessAgoMs ?? Number.POSITIVE_INFINITY;
    // 실패 세대가 바뀌는 순간의 신선도만 붙잡는다. 매 초 다시 잡으면 영영 갱신되지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failureGeneration]);
  const supersededByFreshData = failureGeneration !== null
    && ageAtFailureRef.current !== null
    && props.lastSuccessAgoMs !== null
    && props.lastSuccessAgoMs < ageAtFailureRef.current;
  const liveStatus = supersededByFreshData ? null : status;

  /* 연결이 없는 상태에서 사용자가 갱신을 시도했는가. 미연결 안내는 본문 연결 카드가 이미
     상시로 말하므로 상단에는 **물어봤을 때만** 답한다. */
  const [asked, setAsked] = useState(false);
  useEffect(() => { if (!blocked) setAsked(false); }, [blocked]);

  /* 누름 표시. 요청이 이미 떠 있을 때의 두 번째 누름은 새 요청을 만들지 않지만(single-flight),
     그렇다고 아무 일도 없었던 것은 아니다 — orchestrator가 떠 있는 조회 **직후 한 번 더**
     읽는다. 화면도 그만큼은 되돌려 줘야 무시당한 것으로 읽히지 않는다. */
  const [pressCount, setPressCount] = useState(0);
  const pressTimerRef = useRef<number | null>(null);
  const clearPressTimer = () => {
    if (pressTimerRef.current !== null) window.clearTimeout(pressTimerRef.current);
    pressTimerRef.current = null;
  };
  const notePress = useCallback(() => {
    setPressCount((current) => current + 1);
    clearPressTimer();
    pressTimerRef.current = window.setTimeout(() => setPressCount(0), PRESS_ACK_MS);
  }, []);
  useEffect(() => clearPressTimer, []);

  const requestRefresh = useCallback(() => {
    if (blocked) {
      // 연결이 없으면 요청은 성립하지 않는다. 헛돌게 두면 `방금 업데이트`라는 거짓 영수증이
      // 뜬다 — 아무것도 받아오지 않았는데도. 대신 왜 못 하는지로 답한다.
      setAsked(true);
      return;
    }
    notePress();
    props.onManualRefresh();
  }, [blocked, notePress, props]);

  /* 온라인 복귀. 자동 갱신을 켜 둔 사람에게만 재개한다 — 스위치를 끈 사람에게 네트워크가
     돌아왔다는 이유로 목록을 새로 불러오면 그 스위치는 아무것도 끄지 못한 것이다.
     최신 값은 ref로 읽어 listener를 다시 걸지 않는다. */
  const resumeRef = useRef(props.onResume);
  resumeRef.current = props.onResume;
  const autoOnRef = useRef(autoRefreshOn);
  autoOnRef.current = autoRefreshOn;
  useEffect(() => {
    const resume = () => { if (autoOnRef.current) resumeRef.current?.(); };
    window.addEventListener('online', resume);
    return () => window.removeEventListener('online', resume);
  }, []);

  const notice = refreshNotice({ plan, failure: liveStatus, online, asked });
  const headline = refreshHeadlineText({
    plan,
    // 실패는 아래 안내가 소유한다. 같은 사실을 두 줄이 겹쳐 말하면 어느 쪽이 참인지 알 수 없다.
    status: notice ? null : liveStatus,
    busy,
    lastSuccessAgoMs: props.lastSuccessAgoMs,
  });
  const sentence = refreshCadenceSentence(plan);
  /* 낭독 지점은 이 덩어리에 **하나뿐이다**. 자동 박자마다 live region을 갱신하면 4초짜리
     화면에서 낭독기가 끝없이 끼어들어 다른 것을 아무것도 읽을 수 없게 된다. orchestrator가
     이미 그 판정을 갖고 있다: 자동 trigger는 `role`이 비어 있다.
     막힘·실패 안내도 같은 지점으로 흐른다 — 안내 상자를 따로 live region으로 만들면 같은
     사실이 두 번 들린다. */
  const receipt = liveStatus && liveStatus.role !== null ? liveStatus.text : '';
  const announcement = notice ? `${notice.title}. ${notice.detail}` : receipt;

  return (
    <div className={`int30-refresh${notice ? ' has-notice' : ''}`}>
      <div className="int30-refresh-row">
        <button
          type="button"
          role="switch"
          aria-checked={autoRefreshOn}
          aria-label="자동 갱신"
          aria-describedby={`${CADENCE_ID} ${SENTENCE_ID}`}
          className="int30-refresh-switch"
          onClick={() => props.onAutoRefreshChange(!autoRefreshOn)}
        >
          <span className="int30-refresh-switch-text">자동</span>
          <span className="int30-refresh-track" aria-hidden="true"><i /></span>
        </button>
        {/* 접근 이름은 상태와 무관하게 고정한다 — 요청 중이라고 버튼 이름이 바뀌면 낭독기
            사용자에게는 누르려던 버튼이 사라진 것처럼 들린다. 진행은 `aria-busy`가 말한다. */}
        <button
          type="button"
          className="int30-refresh-now"
          aria-label="최신 상태 확인"
          aria-busy={busy}
          aria-describedby={notice ? `${CADENCE_ID} ${SENTENCE_ID} ${NOTICE_ID}` : `${CADENCE_ID} ${SENTENCE_ID}`}
          data-pressed={pressCount > 0 ? 'true' : undefined}
          data-press-count={pressCount > 0 ? String(pressCount) : undefined}
          onClick={requestRefresh}
        >
          <RefreshCw className={busy ? 'int30-refresh-spin' : undefined} aria-hidden="true" size={16} />
        </button>
      </div>
      <span
        className={`int30-refresh-line${busy ? ' is-busy' : ''}`}
        id={CADENCE_ID}
        data-reason={plan.reason}
        data-state={liveStatus?.state ?? 'idle'}
      >
        {headline}
      </span>
      {/* 막힘·실패. 토스트가 아니라 **여기** 있는 이유는 무엇이 막혔는지와 그것을 푸는 손잡이가
          같은 자리에 있어야 하기 때문이다. 스스로 사라지지 않고, 다음 요청이 결말을 낼 때
          거둬진다. live region이 아니다 — 낭독은 위의 한 지점이 대신한다. */}
      {notice && (
        <div className="int30-refresh-notice" id={NOTICE_ID} data-tone={notice.tone} data-reason={notice.reason}>
          <TriangleAlert className="int30-refresh-notice-icon" aria-hidden="true" size={14} />
          <span className="int30-refresh-notice-text" title={notice.detail}>{notice.title}</span>
          {notice.retry && (
            <button type="button" className="int30-refresh-notice-retry" onClick={requestRefresh}>다시 시도</button>
          )}
        </div>
      )}
      {/* 전문. 짧은 조각이 못 담는 "왜 박자가 달라지는가"를 낭독기와 설명 참조가 읽는다. */}
      <span className="int30-refresh-sentence" id={SENTENCE_ID}>{sentence}</span>
      <span className="int30-refresh-sentence" role="status" aria-live="polite">{announcement}</span>
    </div>
  );
}
