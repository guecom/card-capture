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
  /** 서버가 성공 receipt를 준 시각. 이 시각 이후에만 기기에 남은 원본을 정리한다 (ISS-000102). */
  sentAt?: string;
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
