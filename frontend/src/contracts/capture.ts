export type CaptureState = 'queued' | 'failed' | 'sent';
export type ProcessingStatus = 'received' | 'processing' | 'processed' | 'skipped' | string;

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
