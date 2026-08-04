// 조사 요청이 **어디로 갔는가**를 개발자만 보는 채널에 남긴다 (INT-000030 / TSK-000542).
//
// 왜 필요한가: 사용자는 `빠른·일반·깊은`만 고른다. 화면 어디에도 내부 식별자가 없으므로,
// "깊은 조사를 골랐는데 왜 얕게 나왔지"를 사용자 화면만 보고는 영영 알 수 없다. 요청한 깊이,
// 실제로 쓰인 binding과 그 설정 버전, 내려간 이유, 실패를 남기는 자리가 하나 있어야 한다.
//
// 왜 조심해야 하는가: 여기에는 **binding 식별자**가 들어간다. 그것이 사용자 화면으로 새는 순간
// founder 요구("유저는 어떤 모델이 연결되는지 몰랐으면 좋겠어")가 깨진다. 그래서 이 모듈은
//   1. 기억 속에만 산다. 저장소·주소창·화면 어디에도 쓰지 않는다.
//   2. 열거된 필드만 만든다. 조사 지시문·이름·메모는 인자로 받지도 않는다.
//   3. 유일한 자유 텍스트 자리인 `reason`은 `trace.ts`의 `redactReason`을 그대로 빌려 쓴다 —
//      redaction 규칙을 두 벌 만들지 않는다. 통과 못 하면 `redacted`가 남는다.
//
// alert: 내려감·실패는 조용히 쌓이기만 하면 아무도 안 본다. 구독자에게 즉시 알린다.
// 구독자가 없으면 아무 일도 일어나지 않는다 — 사용자에게 보이는 경고를 만들지 않는다.

import type { ResearchDepth } from '../contracts/int30';
import type { ResearchRoute } from './research-mode';
import { redactReason } from './trace';

/** 무슨 일이 있었나. `routed`는 정상, 나머지는 개발자가 봐야 하는 사건이다. */
export type ResearchRouteEvent = 'routed' | 'degraded' | 'failed';

export interface ResearchRouteReceipt {
  ts: string;
  /** 이 기록 한 줄의 이름. 캡처 내용과 무관한 난수다. */
  requestId: string;
  event: ResearchRouteEvent;
  /** 사용자가 고른 깊이. */
  requestedDepth: ResearchDepth;
  /** 실제로 라우팅에 쓰인 깊이. */
  depth: ResearchDepth;
  /** 실제로 쓰인 내부 식별자. 어디로도 못 갔으면 null. **개발자 전용 값이다.** */
  binding: string | null;
  /** 그때의 라우팅 설정 판. */
  routeVersion: string;
  degraded: boolean;
  /** 좁혀진 코드. 원문은 절대 여기 들어오지 않는다. */
  reason?: string;
}

/** 기억에 두는 최대 줄 수. 넘치면 오래된 것부터 버린다. */
export const RESEARCH_ROUTE_LOG_LIMIT = 100;

let receipts: ResearchRouteReceipt[] = [];
const alertListeners = new Set<(receipt: ResearchRouteReceipt) => void>();

/** 요청 한 건의 이름. 난수만 쓴다 — 사람·회사·시각에서 유도하지 않는다. */
export function createResearchRequestId(random: () => number = Math.random): string {
  let suffix = '';
  while (suffix.length < 10) suffix += Math.floor(random() * 36 ** 5).toString(36).padStart(5, '0');
  return `rr-${suffix.slice(0, 10)}`;
}

export interface ResearchRouteRecordOptions {
  /** 사건을 직접 지정한다. 생략하면 `route.degraded`가 정한다. */
  event?: ResearchRouteEvent;
  /**
   * 내려감 여부를 직접 지정한다. 생략하면 `route.degraded`가 정한다.
   *
   * 라우팅 자체는 멀쩡했는데 **전송 단계에서** 내려간 경우가 있다 — 옛 서버가 mode를 몰라
   * 같은 요청을 표준 깊이로 다시 보낸 경우가 그렇다. 그때 `route.degraded`는 거짓이지만
   * 이 요청은 분명히 내려갔다. 그 사실을 잃지 않게 한 칸을 연다.
   */
  degraded?: boolean;
  /** 걸러지기 전의 사유. `redactReason`을 통과한 값만 남는다. */
  reason?: unknown;
  requestId?: string;
  now?: Date;
}

/**
 * 라우팅 영수증 한 줄을 남긴다.
 *
 * 이 함수가 **binding 식별자를 읽는 유일한 자리**다. 화면 컴포넌트는 `ResearchRoute`를 통째로
 * 손에 쥐지 않고, 필요하면 이 함수에 넘겨 주기만 한다.
 */
export function recordResearchRoute(route: ResearchRoute, options: ResearchRouteRecordOptions = {}): ResearchRouteReceipt {
  const event: ResearchRouteEvent = options.event ?? (route.degraded ? 'degraded' : 'routed');
  const receipt: ResearchRouteReceipt = {
    ts: (options.now ?? new Date()).toISOString(),
    requestId: options.requestId ?? createResearchRequestId(),
    event,
    requestedDepth: route.requestedDepth,
    depth: route.depth,
    binding: route.binding,
    routeVersion: route.version,
    degraded: options.degraded ?? route.degraded,
  };
  const reason = redactReason(options.reason ?? route.reason);
  if (reason) receipt.reason = reason;

  receipts.push(receipt);
  if (receipts.length > RESEARCH_ROUTE_LOG_LIMIT) receipts.splice(0, receipts.length - RESEARCH_ROUTE_LOG_LIMIT);
  if (event !== 'routed') notify(receipt);
  return receipt;
}

/**
 * 구독자에게 알린다. 한 구독자가 던져도 기록과 다른 구독자는 살아남는다 —
 * 진단 채널이 앱을 멈추면 안 된다.
 */
function notify(receipt: ResearchRouteReceipt): void {
  for (const listener of [...alertListeners]) {
    try {
      listener(receipt);
    } catch {
      // 진단이 앱을 넘어뜨리지 않는다.
    }
  }
}

/** 내려감·실패만 받아 보는 개발자 채널. 돌려받은 함수를 부르면 구독이 끊긴다. */
export function subscribeResearchRouteAlert(listener: (receipt: ResearchRouteReceipt) => void): () => void {
  alertListeners.add(listener);
  return () => { alertListeners.delete(listener); };
}

/** 지금까지의 기록 사본. 호출자가 로그를 망가뜨릴 수 없도록 원본을 넘기지 않는다. */
export function readResearchRouteLog(): ResearchRouteReceipt[] {
  return receipts.slice();
}

export function clearResearchRouteLog(): void {
  receipts = [];
}
