/**
 * INT-000030 실행 lane 사이의 공유 이음매(seam).
 *
 * 다섯 표면(캡처 진입·조사 composer·자동 갱신·설정 IA·PC 진입)이 동시에 구현되기 때문에,
 * lane 경계를 넘는 타입은 여기 한 곳에만 둔다. 구현은 각 lane이 소유하고 이 파일은
 * "무엇을 주고받는가"만 고정한다.
 *
 * Kairen-Ref: TSK-000220 / TSK-000542 / TSK-000543 / TSK-000544 / TSK-000545
 */

/** 사람을 등록하는 입구. 위계가 같고 device capability에 따라 가용성만 달라진다. */
export type CaptureMethodId = 'camera' | 'upload' | 'manual';

/**
 * 캡처 진입 카드 하나가 읽는 사실.
 *
 * - 생산자: `services/device-capability.ts` (TSK-000545) — 기기가 무엇을 할 수 있는지 판정한다.
 * - 소비자: `components/CaptureEntry.tsx` (TSK-000220) — 공통 card anatomy로 그린다.
 *
 * 카드는 스스로 가용성을 추측하지 않는다. 못 쓰는 이유와 회복 행동은 항상 값으로 온다 —
 * 그래야 "이유 없이 사라진 버튼"이 생기지 않는다.
 */
export interface CaptureMethodCard {
  id: CaptureMethodId;
  /** 카드 제목. 모든 카드가 같은 자리에 같은 무게로 갖는다. */
  title: string;
  /** 한 줄 outcome 설명. 빈 문자열 금지 — 설명 있는 카드/없는 카드가 섞이면 조립식으로 읽힌다. */
  description: string;
  /** 지금 이 기기에서 쓸 수 있는가. */
  available: boolean;
  /** available=false일 때만 채운다. 사용자 언어로 쓴 이유 한 줄. */
  unavailableReason?: string;
  /** 못 쓰는 상태에서 벗어나는 단 하나의 행동. 없으면 안내만 남는다. */
  recovery?: CaptureMethodRecovery;
}

export interface CaptureMethodRecovery {
  label: string;
  /** permission=브라우저 권한 재요청, setup=연결 설정 열기, help=도움말/대체 수단 안내 */
  kind: 'permission' | 'setup' | 'help';
}

/**
 * 연결(개인 링크) 상태.
 *
 * 전면 경고로 껍데기를 덮지 않는다. 영향을 받는 기능 옆에 inline으로 붙는 것이 계약이다
 * (DEC-000105 / ISS-000235).
 */
export type ConnectionState = 'configured' | 'unconfigured' | 'expired' | 'failed';

/** 조사 깊이. 사용자에게는 결과·대기 특성만 말하고 model 이름은 어디에도 나타나지 않는다. */
export type ResearchDepth = 'quick' | 'standard' | 'deep';

export const DEFAULT_RESEARCH_DEPTH: ResearchDepth = 'standard';
