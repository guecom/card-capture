export type CaptureState = 'queued' | 'failed' | 'sent';
export type ProcessingStatus = 'received' | 'processing' | 'processed' | 'skipped' | string;

/**
 * 이 캡처가 **어떤 방식으로 들어왔는가** (ISS-000231 / DEC-000103).
 *
 * 값이 없으면 `business_card`다 — 이 필드가 생기기 전에 기기에 저장된 대기열 항목이 전부 그렇다.
 * 출처를 섞지 않는다: 직접 입력은 사람이 기억으로 적은 글이고 명함 촬영은 인쇄면을 읽은 것이다.
 * 같은 확신도로 다루면 브리핑이 "명함에 그렇게 적혀 있었다"고 말하게 된다.
 */
export type CaptureIntake = 'business_card' | 'manual_person';

/**
 * 자연어 안에서 발견된 **신원 근거**. 자동 연결 판정의 유일한 강한 축이다 (DEC-000103).
 * 화면에는 사용자가 적은 원문 그대로(`phoneDisplays`)를 되읽어 주고, 대조는 정규화 값으로 한다.
 *
 * 이 값은 **표시 전용**이다. 서버(`Code.gs`)는 클라이언트가 보낸 근거를 믿지 않고 원문에서 다시
 * 뽑는다 — 근거가 곧 병합 권한이라 위조 가능한 자리에 두면 안 된다.
 */
export interface ManualIdentityEvidence {
  /** 소문자로 정규화한 이메일. */
  emails: string[];
  /** 숫자만 남기고 국가번호를 국내 표기로 되돌린 값. */
  phones: string[];
  /** 사용자가 실제로 적은 전화번호 표기. 화면 되읽기에만 쓴다. */
  phoneDisplays: string[];
}

export interface CaptureImage {
  name: 'front.jpg' | 'back.jpg';
  mime?: 'image/jpeg';
  dataB64?: string;
}

export interface QuickName {
  name: string;
  source: string;
  confidence: number;
  confirmed: boolean;
  recognizedAt: string;
}

export interface ResearchInstruction {
  raw: string;
  channel?: 'owner_ui';
  policyVersion?: string;
  riskFlags?: string[];
}

export interface CaptureQueueItem {
  captureId: string;
  capturedAt: string;
  /**
   * 사진 캡처인가 직접 입력인가 (ISS-000231). 값이 없으면 `business_card`.
   * 대기열 무결성 판정(`inspectQueueItems`)과 전송 경로(`uploadCapture`)가 이 값으로 갈린다.
   */
  intake?: CaptureIntake;
  /** 직접 입력 원문. `intake === 'manual_person'`일 때만 있고, 그때는 사진 대신 이것이 payload다. */
  manualText?: string;
  /** 직접 입력 원문에서 뽑은 신원 근거. 화면 되읽기 전용이며 업로드 payload에는 넣지 않는다. */
  identityEvidence?: ManualIdentityEvidence | null;
  event?: string;
  relSelf?: string;
  relKairen?: string;
  memo?: string;
  note?: string;
  disp?: string;
  images: CaptureImage[];
  quickName?: QuickName | null;
  researchInstruction?: ResearchInstruction | null;
  state: CaptureState;
  tries: number;
  thumb?: string;
  err?: string;
  /**
   * 마지막 실패가 "서버가 거절"인지 "응답을 못 받음"인지 (FI-016).
   * `ambiguous`는 접수 여부를 모르는 상태이므로 재전송 전에 서버 기록과 대조해야 한다.
   */
  errKind?: 'rejected' | 'ambiguous';
  /** 재전송 대신 서버 기록과 대조해 접수 완료로 판정한 시각 (FI-016). */
  reconciledAt?: string;
  /** 서버가 성공 receipt를 준 시각. 이 시각 이후에만 기기에 남은 원본을 정리한다 (ISS-000102). */
  sentAt?: string;
  /**
   * 이 캡처의 여정을 잇는 상관관계 ID (FI-021). **클라이언트 진단 전용**이다.
   * 재시도·대조·재전송을 거쳐도 값이 바뀌지 않아, 진단 로그에서 한 명함의 생애를 이어 볼 수 있다.
   * `UploadPayload`에는 일부러 넣지 않는다 — 서버(`Code.gs`)가 저장하지 않는 필드라
   * 전송하면 "서버에서도 추적된다"는 거짓 인상만 남는다.
   */
  correlationId?: string;
}

export interface UploadPayload {
  k: string;
  captureId: string;
  capturedAt: string;
  capturer: string;
  event: string;
  note: string;
  quickName: QuickName | null;
  researchInstruction: ResearchInstruction | null;
  images: CaptureImage[];
}

/**
 * 직접 입력 접수 payload (ISS-000231 / DEC-000103).
 *
 * 사진 업로드와 **같은 멱등 장치**를 쓴다: 클라이언트가 만든 `captureId` 폴더 하나에 `capture.json`
 * 하나. 두 번 눌러도 서버가 지문으로 같은 접수임을 알아본다. 이미지는 없고 원문 글이 payload다.
 *
 * `capturer`를 보내지 않는다 — 서버가 토큰에서 유도하는 값이라 보내면 "내가 정한다"는 거짓
 * 인상만 남는다(사진 경로에서도 서버는 보낸 값을 무시한다).
 * `identityEvidence`도 보내지 않는다 — 서버가 원문에서 다시 뽑는다.
 */
export interface ManualPersonPayload {
  action: 'manualperson';
  k: string;
  captureId: string;
  capturedAt: string;
  event: string;
  note: string;
  text: string;
}

export interface ContactSummary {
  name?: string;
  title?: string;
  company?: string;
  organization?: string;
  email?: string;
  phone?: string;
  emails?: string[];
  phones?: string[];
}

/* 서버가 "사람이 손을 대야 넘어간다"고 표시한 상태. 처리 실패와 다르다 — 재시도로는 풀리지 않고
   사용자가 무엇을 해야 하는지 알아야 닫힌다. `reasonCode`는 닫힌 enum이며 화면에는 그대로 찍지
   않는다(사용자에게 `identity_ambiguous`는 아무 뜻도 아니다). 실제 판정은 서버 값을 믿지 않고
   `services/capture-progress.ts`의 `captureAttentionOf()`가 런타임에서 다시 좁힌다. */
export interface CaptureAttentionPayload {
  kind: 'input_required';
  reasonCode: 'unreadable_capture' | 'missing_required_side' | 'identity_ambiguous';
  requestedAt: string;
}

export interface BriefItem {
  captureId: string;
  capturedAt?: string;
  receivedAt?: string;
  status: ProcessingStatus;
  person?: string;
  type?: string;
  brief?: string;
  contact?: ContactSummary;
  quickName?: QuickName;
  event?: string;
  note?: string;
  capturer?: string;
  attention?: CaptureAttentionPayload;
}

export interface ListResponse {
  ok: boolean;
  error?: string;
  items?: BriefItem[];
  seeAll?: boolean;
  researchInstructionEnabled?: boolean;
  hasMore?: boolean;
}

export interface SearchItem {
  id: string;
  title: string;
  via?: 'title' | 'content' | string;
}

export interface SearchResponse {
  ok: boolean;
  error?: string;
  items?: SearchItem[];
}

export interface RuntimeConfig {
  apiUrl: string;
  token: string;
  capturer: string;
}

export interface DocumentResponse {
  ok: boolean;
  error?: string;
  markdown?: string;
}

export interface ActionResponse {
  ok: boolean;
  error?: string;
  receiptId?: string;
  alreadyTerminal?: boolean;
  deduped?: boolean;
  status?: string;
}

export interface PersonTarget {
  captureId?: string;
  person?: string;
}
