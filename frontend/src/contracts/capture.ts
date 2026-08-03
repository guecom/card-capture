export type CaptureState = 'queued' | 'failed' | 'sent';
export type ProcessingStatus = 'received' | 'processing' | 'processed' | 'skipped' | string;

export interface CaptureAttention {
  kind: 'input_required';
  reasonCode: 'unreadable_capture' | 'missing_required_side' | 'identity_ambiguous';
  requestedAt: string;
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
  mode?: 'standard' | 'deep_evidence_graph';
  purposes?: Array<'meeting_preparation' | 'expertise_execution' | 'authority_interests' | 'reputation_risk'>;
  focusIds?: Array<'expertise' | 'authority' | 'reputation' | 'outcomes' | 'interests' | 'career' | 'company' | 'connection'>;
  requestId?: string;
  sourceAuthority?: 'public_lawful_only';
  budget?: {
    branchCap: number;
    timeCapMinutes: number;
  };
}

export type ResearchClaimState = 'fact' | 'conflict' | 'unknown' | 'hypothesis';
export type ResearchGraphNodeType = 'person' | 'organization' | 'project' | 'event' | 'claim' | 'source';
export type ResearchGraphRelation =
  | 'supports'
  | 'counterevidence'
  | 'affiliated_with'
  | 'leads'
  | 'member_of'
  | 'worked_on'
  | 'participated_in'
  | 'occurred_at'
  | 'involves'
  | 'related_to';

export interface ResearchGraphNode {
  id: string;
  type: ResearchGraphNodeType;
  label: string;
  url?: string;
}

export interface ResearchGraphEdge {
  id: string;
  sourceId: string;
  targetId: string;
  relation: ResearchGraphRelation;
  label: string;
}

export interface ResearchEvidenceLink {
  sourceId: string;
  title: string;
  url: string;
  publishedAt?: string;
}

export interface ResearchEvidenceClaim {
  id: string;
  state: ResearchClaimState;
  summary: string;
  confidence?: 'low' | 'medium' | 'high';
  evidenceFor: ResearchEvidenceLink[];
  evidenceAgainst: ResearchEvidenceLink[];
  alternativeExplanation?: string;
}

/**
 * 서버가 증명하는 Deep Research 단계 어휘 (`Code.gs` `researchProgress.phase`).
 * 진행 rail은 이 값에만 근거해 단계를 진전시킨다 — 시간으로 전진하는 단계를 만들지 않는다.
 */
export type ResearchProgressPhase = 'planning' | 'branching' | 'triangulating' | 'synthesizing' | 'done';

export interface ResearchTimelineEvent {
  date: string;
  label: string;
  claimIds: string[];
}

export interface ResearchEvidenceGraph {
  version: 'deep-research-evidence-v1';
  purposes: ResearchInstruction['purposes'];
  nodes: ResearchGraphNode[];
  edges: ResearchGraphEdge[];
  claims: ResearchEvidenceClaim[];
  timeline: ResearchTimelineEvent[];
  openQuestions: string[];
  metrics: {
    branchCount: number;
    sourceCount: number;
    elapsedMinutes: number;
  };
  stop: {
    reason: 'purpose_satisfied' | 'source_exhausted' | 'irrelevant_branch' | 'time_cap' | 'branch_cap';
    summary: string;
  };
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

export interface BriefItem {
  captureId: string;
  capturedAt?: string;
  receivedAt?: string;
  status: ProcessingStatus;
  /**
   * Human input is a terminal outcome without widening the long-lived status enum.
   * Unknown/raw server reasons are never rendered; UI maps this bounded reasonCode allowlist.
   */
  attention?: CaptureAttention;
  person?: string;
  type?: string;
  brief?: string;
  contact?: ContactSummary;
  quickName?: QuickName;
  event?: string;
  note?: string;
  capturer?: string;
  researchInstruction?: Pick<ResearchInstruction, 'mode' | 'purposes' | 'sourceAuthority' | 'policyVersion'>;
  researchProgress?: {
    phase?: ResearchProgressPhase;
    verifiedFacts?: number;
    conflicts?: number;
    openQuestions?: number;
    branchCount?: number;
    sourceCount?: number;
    elapsedMinutes?: number;
    updatedAt?: string;
  };
  researchEvidence?: ResearchEvidenceGraph;
}

export interface ListResponse {
  ok: boolean;
  error?: string;
  items?: BriefItem[];
  seeAll?: boolean;
  researchInstructionEnabled?: boolean;
  deepResearchEnabled?: boolean;
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

export interface ResearchEvidenceResponse {
  ok: boolean;
  error?: string;
  graph?: ResearchEvidenceGraph;
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
