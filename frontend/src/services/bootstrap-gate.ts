/**
 * 연결 상태가 **무엇을 제한하는가**를 한곳에서 정한다 (TSK-000545 / INT-000030 / DEC-000105).
 *
 * 고친 결함 — 예전에는 `configured = Boolean(apiUrl && token)` boolean 하나가 세 가지를
 * 동시에 결정했다: 서버에 물어볼 수 있는가, 화면에 무엇을 그릴 것인가, 사용자가 무엇을 할 수
 * 있는가. 그 셋은 같은 것이 아니다. PC 첫 방문(개인 링크 없이 hub.kairenhq.com에서 들어온
 * 경우)에서 결과는 이랬다:
 *   - 화면 맨 위에 `링크 설정이 필요해요` 전면 경고가 떴고,
 *   - `AI 조사 요청` 작성 자리가 **DOM에서 통째로 사라졌다**.
 * 둘 다 로컬로 멀쩡히 되는 일이다. 촬영도, 직접 입력도, 조사 요청 작성도 기기 대기열에
 * 저장됐다가 연결되면 그대로 전송된다.
 *
 * 그래서 이 파일의 계약은 셋이다.
 *   1. **껍데기는 어떤 연결 상태에서도 산다.** `blocksShell`은 타입 수준에서 `false`다.
 *   2. 로컬로 끝나는 일(`capture`·`research`·`records`)은 연결과 무관하게 `usable`이고,
 *      서버 마무리가 남았을 때만 `deferred`가 켜진다.
 *   3. 진짜로 서버가 있어야 하는 일(`serverSync`·`ownerSearch`)만 `usable: false`가 되고,
 *      안내는 **그 기능 옆 inline setup card 한 장**으로 붙는다. 전면 경고는 만들지 않는다.
 */

import type { ConnectionState } from '../contracts/int30';

export type BootstrapFeature =
  | 'shell'
  | 'capture'
  | 'research'
  | 'records'
  | 'serverSync'
  | 'ownerSearch';

export interface FeatureVerdict {
  feature: BootstrapFeature;
  /** 지금 쓸 수 있는가. 로컬로 끝나는 일은 연결과 무관하게 언제나 true. */
  usable: boolean;
  /** 로컬로는 되지만 서버 쪽 마무리가 연결을 기다리는가. */
  deferred: boolean;
  /** 사용자가 읽는 한 줄. 빈 문자열 금지 — 설명 있는 기능/없는 기능이 섞이면 조립식으로 읽힌다. */
  note: string;
}

/** `configured`가 아닌 상태들. `cancelled`는 사용자가 설정을 열었다가 스스로 닫은 경우다. */
export type SetupSituation = 'unconfigured' | 'cancelled' | 'expired' | 'failed';

export interface ConnectionSetupPrompt {
  situation: SetupSituation;
  title: string;
  body: string;
  /** 한 번의 guided action. 여러 갈래로 나누지 않는다 — 고르게 하면 그것이 또 하나의 설정이다. */
  actionLabel: string;
  /** `info`는 아직 아무것도 잘못되지 않은 상태, `warn`은 되던 것이 끊긴 상태다. */
  tone: 'info' | 'warn';
}

export interface BootstrapGate {
  connection: ConnectionState;
  /** 껍데기는 늘 산다. 값이 아니라 타입으로 박아 회귀가 컴파일에서 걸리게 한다. */
  shellAlive: true;
  /** 전면 차단 오버레이는 존재하지 않는다. */
  blocksShell: false;
  features: Record<BootstrapFeature, FeatureVerdict>;
  /** setup card를 붙일 기능. 연결이 정상이면 null. */
  setupAnchor: BootstrapFeature | null;
  setup: ConnectionSetupPrompt | null;
}

/**
 * 저장된 연결 정보와 마지막 서버 응답에서 연결 상태를 읽는다.
 *
 * 인증 모델은 바꾸지 않는다 — 서버가 이미 말하고 있는 `invalid_token`을 화면 어휘로
 * 옮길 뿐이다. 코드 발급·회수·rotation은 여전히 서버와 사람의 일이다.
 */
export function resolveConnectionState(input: {
  apiUrl?: string;
  token?: string;
  lastError?: string | null;
}): ConnectionState {
  if (!input.apiUrl?.trim() || !input.token?.trim()) return 'unconfigured';
  const error = (input.lastError ?? '').trim();
  if (!error) return 'configured';
  if (error === 'invalid_token' || error === 'unauthorized' || error === 'forbidden') return 'expired';
  return 'failed';
}

const LOCAL_NOTE: Record<ConnectionState, string> = {
  configured: '지금 바로 되고, 저장하면 곧바로 보냅니다.',
  unconfigured: '지금 바로 됩니다. 이 기기에 저장했다가 연결되면 자동으로 보내요.',
  expired: '지금 바로 됩니다. 이 기기에 저장했다가 링크를 다시 연결하면 밀린 것부터 보내요.',
  failed: '지금 바로 됩니다. 이 기기에 저장했다가 연결이 돌아오면 자동으로 보내요.',
};

const SERVER_SYNC_NOTE: Record<ConnectionState, string> = {
  configured: '서버와 이어져 있어요. 새 기록은 자동으로 올라갑니다.',
  unconfigured: '아직 서버로 보내지 못해요. 저장된 촬영은 그대로 기다립니다.',
  expired: '개인 링크가 더 이상 통하지 않아 전송이 멈춰 있어요. 저장된 촬영은 그대로 있습니다.',
  failed: '서버에 닿지 못해 전송이 멈춰 있어요. 저장된 촬영은 그대로 있습니다.',
};

const OWNER_SEARCH_NOTE: Record<ConnectionState, string> = {
  configured: '기존 기록에서 사람을 찾을 수 있어요.',
  unconfigured: '사람 찾기는 서버 기록을 읽는 기능이라 연결이 필요해요.',
  expired: '사람 찾기는 서버 기록을 읽는 기능이라 링크를 다시 연결해야 해요.',
  failed: '사람 찾기는 서버 기록을 읽는 기능이라 연결이 돌아와야 해요.',
};

const SETUP_PROMPTS: Record<SetupSituation, ConnectionSetupPrompt> = {
  unconfigured: {
    situation: 'unconfigured',
    title: '아직 서버와 연결되지 않았어요',
    body: '촬영·파일 올리기·직접 입력·AI 조사 요청은 지금도 그대로 됩니다. 이 기기에 저장했다가 연결되면 자동으로 보내요.',
    actionLabel: '연결 설정 열기',
    tone: 'info',
  },
  cancelled: {
    situation: 'cancelled',
    title: '연결 설정을 닫았어요',
    body: '언제든 다시 열 수 있어요. 그동안 촬영과 기록은 이 기기에 계속 쌓입니다.',
    actionLabel: '연결 설정 다시 열기',
    tone: 'info',
  },
  expired: {
    situation: 'expired',
    title: '개인 링크가 더 이상 통하지 않아요',
    body: '받으신 개인 링크로 다시 열거나 설정에서 코드를 새로 넣어 주세요. 보내지 못한 기록은 지워지지 않고 기다립니다.',
    actionLabel: '연결 설정 열기',
    tone: 'warn',
  },
  failed: {
    situation: 'failed',
    title: '서버에 연결하지 못했어요',
    body: '전파나 서버 상태 때문일 수 있어요. 촬영과 직접 입력은 계속 되고, 연결이 돌아오면 밀린 것부터 보냅니다.',
    actionLabel: '연결 설정 열기',
    tone: 'warn',
  },
};

export function connectionSetupPrompt(situation: SetupSituation): ConnectionSetupPrompt {
  return SETUP_PROMPTS[situation];
}

/**
 * 연결 상태 하나로 기능별 판정을 만든다.
 *
 * `setupCancelled`는 "사용자가 설정을 열었다가 스스로 닫았다"만 뜻한다. 취소해도 판정은
 * 미설정과 **똑같다** — 취소를 벌하지 않는다. 달라지는 것은 안내 문구 한 장뿐이다.
 */
export function evaluateBootstrap(input: {
  connection: ConnectionState;
  setupCancelled?: boolean;
}): BootstrapGate {
  const { connection } = input;
  const online = connection === 'configured';
  const deferred = !online;

  const features: Record<BootstrapFeature, FeatureVerdict> = {
    shell: { feature: 'shell', usable: true, deferred: false, note: '앱 화면과 이 기기의 기록은 언제나 열려 있어요.' },
    capture: { feature: 'capture', usable: true, deferred, note: LOCAL_NOTE[connection] },
    research: { feature: 'research', usable: true, deferred, note: LOCAL_NOTE[connection] },
    records: { feature: 'records', usable: true, deferred, note: LOCAL_NOTE[connection] },
    serverSync: { feature: 'serverSync', usable: online, deferred, note: SERVER_SYNC_NOTE[connection] },
    ownerSearch: { feature: 'ownerSearch', usable: online, deferred: false, note: OWNER_SEARCH_NOTE[connection] },
  };

  if (online) {
    return { connection, shellAlive: true, blocksShell: false, features, setupAnchor: null, setup: null };
  }

  const situation: SetupSituation = connection === 'unconfigured'
    ? (input.setupCancelled ? 'cancelled' : 'unconfigured')
    : connection;

  return {
    connection,
    shellAlive: true,
    blocksShell: false,
    features,
    // 안내는 실제로 막힌 것 옆에 붙는다. 촬영 카드 위나 화면 맨 위가 아니다.
    setupAnchor: 'serverSync',
    setup: SETUP_PROMPTS[situation],
  };
}

/**
 * `AI 조사 요청` 작성 자리를 그릴 것인가.
 *
 * 이 판정이 founder가 PC에서 본 결함의 진원지다. 예전 규칙은 `seeAll && researchInstructionEnabled`
 * 하나였는데, 그 두 값은 **서버 목록 응답에서만** 채워진다. 그리고 목록 조회는 `configured`가
 * 아니면 시작조차 하지 않는다. 즉 연결이 없는 기기에서 두 값은 영원히 false이고, 화면은
 * 서버가 한 번도 하지 않은 대답을 `아니오`로 읽어 작성 자리를 통째로 지웠다.
 *
 * 고친 규칙:
 *   - `unconfigured` — 서버가 대답한 적이 없다. **없는 대답을 거절로 읽지 않는다.** 보여 준다.
 *     이 기기에는 아직 토큰이 없어 아무것도 전송되지 않으므로 권한이 열리는 것도 아니다.
 *   - `expired` / `failed` — 이 subject에 대해 서버가 **이미 대답한 적이 있다.** 마지막으로
 *     증명된 값을 그대로 쓴다. 연결이 끊겼다는 이유로 없던 권한을 새로 보여 주지 않고,
 *     있던 자리를 이유 없이 지우지도 않는다.
 *   - `configured` — 예전과 같다. 서버가 방금 증명한 값이 정본이다.
 *
 * 실행 권한은 어느 경우에도 여기서 생기지 않는다. 업로드를 받는 서버가 토큰과 기능 플래그를
 * 다시 판정한다(`Code.gs`: `invalid_token` · `feature_disabled`).
 */
export function researchSurfaceVisible(
  provenFlags: { seeAll: boolean; researchInstructionEnabled: boolean },
  connection: ConnectionState,
): boolean {
  if (connection === 'unconfigured') return true;
  return provenFlags.seeAll && provenFlags.researchInstructionEnabled;
}
