/**
 * 상단 바 오른쪽의 갱신 덩어리 (INT-000030 / TSK-000543).
 *
 * founder 판정: "이게 뭔가 새로고침이 되고 있는 건지, 자동 새로고침 기능이 꺼져서 켜져서인지
 * 라든가, 뭐 이런 것들이 좀 헷갈리는 것 같아."
 *
 * 원인은 배치가 아니라 **기호 하나가 세 가지 뜻을 겸했다**는 것이다. 돌아가는 아이콘 하나가
 * (1) 자동 갱신이 켜져 있다 (2) 지금 요청이 오간다 (3) 화면이 최신이다 를 동시에 말하려 했다.
 * 어느 뜻인지 알 방법이 없으니 셋 다 못 읽는다.
 *
 * 그래서 여기서 셋을 갈라 각자 다른 시각적 일을 맡긴다.
 *   1. 기능 상태 — 스위치. 켜짐/꺼짐이 모양으로 명시된다. 추측할 것이 없다.
 *   2. 작업 상태 — 새로고침 버튼. 회전과 `aria-busy`는 **요청이 실제로 떠 있는 동안에만** 있다.
 *   3. 신선도 — 아래 한 줄. 마지막으로 받은 시점과 지금 걸려 있는 박자를 글자로 말한다.
 *
 * 박자 숫자는 `plan.intervalMs`에서만 나온다(`refreshCadenceText`). 적응형이라 처리 중에는
 * 4초, 조용할 때는 20초인데 화면에 20초를 박아 두면 그 자체로 거짓말이 된다.
 */
import { RefreshCw } from 'lucide-react';
import type { ReactElement } from 'react';
import {
  refreshCadenceSentence,
  refreshHeadlineText,
  type RefreshCadencePlan,
  type RefreshStatus,
} from '../services/refresh-orchestrator';
import '../styles/int30-refresh.css';

const CADENCE_ID = 'int30-refresh-cadence';
const SENTENCE_ID = 'int30-refresh-sentence';

export interface RefreshControlProps {
  autoRefreshOn: boolean;
  onAutoRefreshChange(next: boolean): void;
  onManualRefresh(): void;
  /** 지금 걸려 있는 폴링 계획. 타이머를 거는 것과 **같은 값**이라 문구가 실제와 어긋날 수 없다. */
  plan: RefreshCadencePlan;
  /** 직접 누른 갱신의 영수증(성공·실패). 자동 박자는 여기에 영수증을 남기지 않는다. */
  status: RefreshStatus | null;
  /** 마지막 성공에서 지난 시간(ms). 아직 한 번도 못 받았으면 null. */
  lastSuccessAgoMs: number | null;
  /** 지금 목록 요청이 실제로 떠 있는가. 회전과 `aria-busy`가 따르는 단 하나의 값이다. */
  busy: boolean;
}

export function RefreshControl(props: RefreshControlProps): ReactElement {
  const { autoRefreshOn, busy, plan, status } = props;
  const headline = refreshHeadlineText({
    plan,
    status,
    busy,
    lastSuccessAgoMs: props.lastSuccessAgoMs,
  });
  const sentence = refreshCadenceSentence(plan);
  /* 낭독기 통지는 **사용자가 직접 누른 결과**에만 준다. 자동 박자마다 live region을 갱신하면
     4초짜리 화면에서 낭독기가 끝없이 끼어들어 다른 것을 아무것도 읽을 수 없게 된다.
     orchestrator가 이미 그 판정을 갖고 있다: 자동 trigger는 `role`이 비어 있다. */
  const announcement = status && status.role !== null ? status.text : '';

  return (
    <div className="int30-refresh">
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
          aria-describedby={`${CADENCE_ID} ${SENTENCE_ID}`}
          onClick={props.onManualRefresh}
        >
          <RefreshCw className={busy ? 'int30-refresh-spin' : undefined} aria-hidden="true" size={17} />
        </button>
      </div>
      <span
        className={`int30-refresh-line${busy ? ' is-busy' : ''}`}
        id={CADENCE_ID}
        data-reason={plan.reason}
        data-state={status?.state ?? 'idle'}
      >
        {headline}
      </span>
      {/* 전문. 짧은 조각이 못 담는 "왜 박자가 달라지는가"를 낭독기와 설명 참조가 읽는다. */}
      <span className="int30-refresh-sentence" id={SENTENCE_ID}>{sentence}</span>
      <span className="int30-refresh-sentence" role="status" aria-live="polite">{announcement}</span>
    </div>
  );
}
