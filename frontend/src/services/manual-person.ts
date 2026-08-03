// 직접 입력 — 자연어로 사람을 등록한다 (ISS-000231 / TSK-000533 / DEC-000103)
//
// founder 요구 (INT-000029): "어떤 사람인지에 대한 정보를 수기로 입력하면 그것을 마치 명함의
// 정보들을 검색하는 것처럼 이제 진행해 주는 게 있었으면 좋겠어."
//
// 그래서 이 모듈이 책임지는 것은 셋이다.
//   1. **입력 판정** — 한 칸의 자연어. 구조화된 연락처 칸을 강요하지 않는다. 2,000자 상한.
//   2. **신원 근거 추출** — 글 안의 이메일·전화를 찾아 사용자에게 되읽어 준다.
//   3. **연결 판정 규칙** — 언제 기존 인물에 붙이고 언제 새 인물로 만드는가.
//
// 3번이 이 모듈의 존재 이유다. founder 판정: "물어보지 말고 알아서. 마찰 최소화."
// 확인 모달이 없다는 것은 **틀린 병합을 사람이 막아 줄 자리가 없다**는 뜻이다. 잘못된 병합은
// 중복 인물보다 훨씬 나쁘다 — 중복은 나중에 합칠 수 있지만, 남의 이력이 섞인 Person은
// 어디까지가 누구 것인지 되돌릴 근거가 사라진다. 그래서 규칙을 한쪽으로 기울인다:
//
//   **강한 신원 근거가 정확히 한 사람을 가리킬 때만 연결한다. 나머지는 전부 새 인물이다.**
//
// 강한 근거는 셋뿐이다: 정확한 이메일 일치, 정규화 후 정확한 전화 일치, 그리고 모호하지 않은
// 이름+소속 완전 일치. 이름만 같은 것은 근거가 아니다(동명이인). 이름+소속이 맞아도 연락처가
// 어긋나면 근거가 아니라 **모순**이고, 모순은 언제나 새 인물로 간다.
//
// 이 판정은 클라이언트와 처리 단계가 공유하는 **규칙의 원본**이다. 실제 대조는 Person 저장소를
// 가진 처리 단계가 수행한다 — 앱은 Person 목록을 갖고 있지 않다. 앱이 쓰는 것은 신원 근거
// 추출과 입력 판정이고, 연결 규칙은 여기 코드로 고정해 `PROCESSING_CONTRACT.md`가 참조한다.

import type { CaptureIntake, CaptureQueueItem, ManualIdentityEvidence } from '../contracts/capture';
import { MANUAL_INTAKE_NOT_DEPLOYED } from './api';
import { buildLegacyNote, createCaptureId } from './capture-item';
import { loadManualDraftRaw, saveManualDraftRaw } from './storage';
import { createCorrelationId, traceCapture } from './trace';
import type { QueueWriteFailure } from './queue';

export const MANUAL_INTAKE: CaptureIntake = 'manual_person';

/** 자유 입력 상한. 서버(`Code.gs`)도 같은 값으로 자른다. */
export const MANUAL_TEXT_MAX = 2000;

/**
 * 남은 글자를 알려 주기 시작하는 지점.
 *
 * 처음부터 `0 / 2000`을 띄우면 잔소리가 된다 — 세 단어만 적어도 되는 화면에서 카운터는
 * "더 써야 한다"는 압박으로 읽힌다. 상한이 실제로 가까워졌을 때만 남은 여유를 말한다.
 */
export const MANUAL_TEXT_HINT_REMAINING = 200;

export interface ManualTextBudget {
  length: number;
  remaining: number;
  /** 남은 여유를 화면에 보여 줄 때인가. */
  nearLimit: boolean;
  over: boolean;
}

export function manualTextBudget(text: string): ManualTextBudget {
  const length = String(text ?? '').length;
  const remaining = MANUAL_TEXT_MAX - length;
  return { length, remaining, nearLimit: remaining <= MANUAL_TEXT_HINT_REMAINING, over: remaining < 0 };
}

/** 지금 등록할 수 없는 이유. 버튼을 죽이는 대신 이유를 말한다. */
export type ManualSubmitRefusal = 'empty' | 'too_long';

export function manualSubmitRefusal(text: string): ManualSubmitRefusal | null {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return 'empty';
  if (trimmed.length > MANUAL_TEXT_MAX) return 'too_long';
  return null;
}

export const manualSubmitRefusalMessage: Record<ManualSubmitRefusal, string> = {
  empty: '이 사람에 대해 아는 내용을 한 줄이라도 적어 주세요. 이름을 몰라도 괜찮아요 — "어제 로보월드에서 만난 로보틱스 대표"처럼 떠오르는 단서면 충분합니다.',
  too_long: `적어 주신 내용이 ${MANUAL_TEXT_MAX}자를 넘었어요. 이 사람을 다시 떠올릴 단서 위주로 줄여 주세요 — 나머지는 등록 뒤에 메모로 덧붙일 수 있어요.`,
};

/* ── 신원 근거 추출 ─────────────────────────────────────────────────────────
   `g` 플래그가 붙은 정규식은 `lastIndex`를 들고 다니므로 모듈 상수로 재사용하면 호출마다
   결과가 달라진다. 쓸 때마다 새로 만든다. */

function emailPattern(): RegExp {
  return /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
}

/**
 * 전화번호 **후보**. 여기서 넓게 잡고 `normalizePhone`이 좁힌다.
 * 최소 9자리에 구분자·괄호·국가번호를 허용한다.
 */
function phoneCandidatePattern(): RegExp {
  return /\+?\d[\d\s.\-()]{7,}\d/g;
}

/**
 * 전화번호 정규화. 조건을 만족하지 못하면 **빈 문자열**을 돌려준다 — 애매한 값은 근거가 아니다.
 *
 * 왜 이렇게 좁은가: 이 값 하나가 기존 Person에 자동 연결시킬 수 있는 권한이다. `20260727` 같은
 * 날짜나 주문번호가 전화번호로 통과하면 엉뚱한 사람에게 붙는다. 그래서 국내 표기(`0`으로 시작,
 * 9~14자리)로 환원되는 것만 근거로 인정한다. 좁게 잡아 새 인물이 하나 더 생기는 쪽이
 * 잘못 병합되는 쪽보다 언제나 낫다.
 */
export function normalizePhone(value: string): string {
  let digits = String(value ?? '').replace(/[^0-9]/g, '');
  // 국가번호 82는 국내 표기로 되돌린다 — `+82 10-1234-5678`과 `010-1234-5678`은 같은 번호다.
  if (digits.startsWith('82')) digits = `0${digits.slice(2)}`;
  return /^0\d{8,13}$/.test(digits) ? digits : '';
}

export function normalizeEmail(value: string): string {
  return String(value ?? '').trim().toLowerCase();
}

/** 이름·소속 대조용 정규화. 공백과 대소문자 차이는 같은 값으로 본다. */
function squash(value: string | undefined): string {
  return String(value ?? '').toLowerCase().replace(/\s+/g, '');
}

function unique(values: string[]): string[] {
  return values.filter((value, index) => value && values.indexOf(value) === index);
}

export const emptyIdentityEvidence: ManualIdentityEvidence = { emails: [], phones: [], phoneDisplays: [] };

export function extractIdentityEvidence(text: string): ManualIdentityEvidence {
  const source = String(text ?? '');
  const emails = unique((source.match(emailPattern()) ?? []).map(normalizeEmail));
  // 이메일 안의 숫자가 전화번호로 잡히면 안 된다 — 먼저 지우고 나서 번호를 찾는다.
  const withoutEmails = source.replace(emailPattern(), ' ');
  const phones: string[] = [];
  const phoneDisplays: string[] = [];
  for (const candidate of withoutEmails.match(phoneCandidatePattern()) ?? []) {
    const normalized = normalizePhone(candidate);
    if (!normalized || phones.includes(normalized)) continue;
    phones.push(normalized);
    phoneDisplays.push(candidate.trim());
  }
  return { emails, phones, phoneDisplays };
}

export function hasIdentityEvidence(evidence: ManualIdentityEvidence): boolean {
  return evidence.emails.length > 0 || evidence.phones.length > 0;
}

/* ── 연결 판정 ───────────────────────────────────────────────────────────── */

/** 이 등록이 주장하는 신원. 이름·소속은 처리 단계가 자연어에서 확정했을 때만 채워진다. */
export interface ManualPersonClaim {
  evidence: ManualIdentityEvidence;
  fullName?: string;
  organization?: string;
}

/** 대조 대상인 기존 Person 하나. */
export interface PersonCandidate {
  personId: string;
  fullName?: string;
  organization?: string;
  emails?: string[];
  phones?: string[];
}

export type ManualMatchDecision = 'link' | 'new';

export type ManualMatchReason =
  /** 이메일이 정확히 한 사람과 일치했다. */
  | 'exact_email'
  /** 정규화한 전화가 정확히 한 사람과 일치했다. */
  | 'exact_phone'
  /** 이름과 소속이 모두 정확히 일치하고 후보가 하나뿐이다. */
  | 'exact_name_and_organization'
  /** 대조할 기존 인물이 없다. */
  | 'no_candidate'
  /** 강한 근거가 하나도 없다 — 이름조차 확정되지 않았다. */
  | 'weak_evidence'
  /** 같은 강도의 후보가 둘 이상이다. 모르는 채로 고르지 않는다. */
  | 'ambiguous_candidates'
  /** 근거끼리 서로 다른 사람을 가리킨다. */
  | 'conflicting_evidence'
  /** 이름만 같다 — 동명이인일 수 있으므로 근거가 아니다. */
  | 'name_only'
  /** 이름은 같은데 소속이 다르거나 확인되지 않는다. */
  | 'organization_mismatch';

export interface ManualMatchOutcome {
  decision: ManualMatchDecision;
  reason: ManualMatchReason;
  /** `link`일 때만 채워진다. */
  personId?: string;
  matchedOn?: 'email' | 'phone' | 'name_and_organization';
}

function candidateEmails(candidate: PersonCandidate): string[] {
  return unique((candidate.emails ?? []).map(normalizeEmail));
}

function candidatePhones(candidate: PersonCandidate): string[] {
  return unique((candidate.phones ?? []).map(normalizePhone));
}

function hasStoredContact(candidate: PersonCandidate): boolean {
  return candidateEmails(candidate).length > 0 || candidatePhones(candidate).length > 0;
}

/**
 * 직접 입력을 기존 Person에 붙일지 새로 만들지 (DEC-000103).
 *
 * 순서가 규칙의 전부다.
 *  1. 연락처가 정확히 일치하는 후보를 모은다. **둘 이상이면 모순**이므로 새 인물이다.
 *  2. 하나면 연결한다.
 *  3. 연락처 근거를 갖고 있는데 아무도 맞지 않으면, 이름+소속이 맞더라도 연결하지 않는다 —
 *     연락처가 다르다는 것은 다른 사람일 수 있다는 적극적 신호다(퇴사·동명이인·대표 메일 공유).
 *     단, 그 후보가 연락처를 하나도 갖고 있지 않다면 어긋난 것이 아니라 **비어 있는** 것이므로
 *     이름+소속 완전 일치를 근거로 인정한다.
 *  4. 연락처 근거가 없으면 이름+소속 완전 일치 하나만 근거다. 후보가 여럿이면 새 인물이다.
 *  5. 이름만 같은 것은 어떤 경우에도 근거가 아니다.
 */
export function classifyPersonMatch(claim: ManualPersonClaim, candidates: PersonCandidate[]): ManualMatchOutcome {
  const evidence = claim.evidence ?? emptyIdentityEvidence;
  const claimEmails = unique(evidence.emails.map(normalizeEmail));
  const claimPhones = unique(evidence.phones.map(normalizePhone));
  const pool = candidates ?? [];

  const emailHits = pool.filter((candidate) => candidateEmails(candidate).some((email) => claimEmails.includes(email)));
  const phoneHits = pool.filter((candidate) => candidatePhones(candidate).some((phone) => claimPhones.includes(phone)));
  const contactHitIds = unique([...emailHits, ...phoneHits].map((candidate) => candidate.personId));

  if (contactHitIds.length > 1) {
    // 이메일은 A를, 전화는 B를 가리킨다. 둘 중 하나를 고르는 근거가 없으므로 어느 쪽도 건드리지 않는다.
    return { decision: 'new', reason: 'conflicting_evidence' };
  }
  if (contactHitIds.length === 1) {
    const personId = contactHitIds[0];
    return {
      decision: 'link',
      reason: emailHits.some((candidate) => candidate.personId === personId) ? 'exact_email' : 'exact_phone',
      personId,
      matchedOn: emailHits.some((candidate) => candidate.personId === personId) ? 'email' : 'phone',
    };
  }

  const claimName = squash(claim.fullName);
  const claimOrg = squash(claim.organization);
  const nameHits = claimName ? pool.filter((candidate) => squash(candidate.fullName) === claimName) : [];
  const nameOrgHits = claimOrg ? nameHits.filter((candidate) => squash(candidate.organization) === claimOrg) : [];

  if (hasIdentityEvidence(evidence)) {
    // 연락처를 갖고 왔는데 아무도 맞지 않았다. 이름+소속이 맞는 후보가 이미 다른 연락처를
    // 갖고 있다면 그것은 일치가 아니라 모순이다.
    const empties = nameOrgHits.filter((candidate) => !hasStoredContact(candidate));
    if (nameOrgHits.length > 0 && empties.length !== nameOrgHits.length) {
      return { decision: 'new', reason: 'conflicting_evidence' };
    }
    if (empties.length === 1) {
      return { decision: 'link', reason: 'exact_name_and_organization', personId: empties[0].personId, matchedOn: 'name_and_organization' };
    }
    if (empties.length > 1) return { decision: 'new', reason: 'ambiguous_candidates' };
    if (nameHits.length > 0) return { decision: 'new', reason: claimOrg ? 'organization_mismatch' : 'name_only' };
    return { decision: 'new', reason: 'no_candidate' };
  }

  if (!claimName) return { decision: 'new', reason: 'weak_evidence' };
  if (nameOrgHits.length === 1) {
    return { decision: 'link', reason: 'exact_name_and_organization', personId: nameOrgHits[0].personId, matchedOn: 'name_and_organization' };
  }
  if (nameOrgHits.length > 1) return { decision: 'new', reason: 'ambiguous_candidates' };
  if (nameHits.length > 0) return { decision: 'new', reason: claimOrg ? 'organization_mismatch' : 'name_only' };
  return { decision: 'new', reason: 'no_candidate' };
}

/** 판정 이유를 사람이 읽는 한 줄로. 화면·기록·감사 로그가 같은 문장을 쓴다. */
export const manualMatchReasonCopy: Record<ManualMatchReason, string> = {
  exact_email: '이메일이 정확히 일치해 기존 인물에 이어 붙였어요.',
  exact_phone: '전화번호가 정확히 일치해 기존 인물에 이어 붙였어요.',
  exact_name_and_organization: '이름과 소속이 모두 정확히 일치해 기존 인물에 이어 붙였어요.',
  no_candidate: '같은 사람으로 볼 기존 기록이 없어 새 인물로 등록했어요.',
  weak_evidence: '같은 사람인지 확정할 단서가 부족해 새 인물로 등록했어요.',
  ambiguous_candidates: '비슷한 기록이 둘 이상이라 어느 쪽인지 확정할 수 없어 새 인물로 등록했어요.',
  conflicting_evidence: '단서들이 서로 다른 사람을 가리켜, 기존 기록은 그대로 두고 새 인물로 등록했어요.',
  name_only: '이름만 같고 다른 단서가 없어 동명이인일 수 있습니다 — 새 인물로 등록했어요.',
  organization_mismatch: '이름은 같지만 소속이 달라 다른 사람일 수 있습니다 — 새 인물로 등록했어요.',
};

/* ── 대기열 항목 만들기 ──────────────────────────────────────────────────── */

export interface ManualIntakeInput {
  /** 초안이 들고 있던 값을 그대로 쓴다 — 이것이 멱등의 기준이다. */
  captureId: string;
  text: string;
  event?: string;
  relKairen?: string;
  relSelf?: string;
  now?: Date;
  random?: () => number;
}

/** 목록 한 줄에 보여 줄 요약. 새로 지어내지 않고 적힌 첫 줄을 그대로 줄인다. */
export function manualDisplayText(text: string, limit = 40): string {
  const firstLine = String(text ?? '').trim().split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  return firstLine.length > limit ? `${firstLine.slice(0, limit).trimEnd()}…` : firstLine;
}

export function buildManualIntake(input: ManualIntakeInput): CaptureQueueItem {
  const now = input.now ?? new Date();
  const random = input.random ?? Math.random;
  const text = String(input.text ?? '').trim().slice(0, MANUAL_TEXT_MAX);
  if (!text) throw new Error('empty_manual_text');
  const event = input.event?.trim() ?? '';
  const relKairen = input.relKairen?.trim() ?? '';
  const relSelf = input.relSelf?.trim() ?? '';

  const item: CaptureQueueItem = {
    // 초안이 들고 있던 id를 그대로 쓴다. 여기서 새로 만들면 연타·재시도마다 job이 하나씩 늘어난다.
    captureId: input.captureId || createCaptureId(now, random),
    capturedAt: now.toISOString(),
    intake: MANUAL_INTAKE,
    manualText: text,
    identityEvidence: extractIdentityEvidence(text),
    event,
    relSelf,
    relKairen,
    // 메모 칸은 쓰지 않는다 — 직접 입력에서는 원문 전체가 그 자리다. 중복 저장하지 않는다.
    memo: '',
    note: buildLegacyNote(relSelf, relKairen, ''),
    disp: manualDisplayText(text),
    images: [],
    quickName: null,
    researchInstruction: null,
    state: 'queued',
    tries: 0,
    thumb: '',
    correlationId: createCorrelationId(random),
  };
  // 기록되는 것은 식별자와 단계뿐이다 — 원문은 진단 로그로 가지 않는다 (FI-021).
  traceCapture(item, 'created');
  return item;
}

/* ── 초안 보관 ───────────────────────────────────────────────────────────
   앱을 내려놓거나 전화를 받는 동안 쓰던 글이 사라지면 안 된다. 저장은 입력 즉시 한다 —
   `등록하기`를 누르지 못한 초안이 살아 있어야 "마찰 최소화"가 성립한다.

   초안은 **사적 상태**다. 그 사람이 직접 적은, 특정 인물에 대한 메모이므로 subject namespace
   안에 산다 (FI-006). 자리 배정은 `storage.ts`가, 형식 해석은 여기가 책임진다. */

export interface ManualDraft {
  /**
   * 이 초안이 만들어질 때 확정한 captureId. 초안이 살아 있는 동안 바뀌지 않는다.
   *
   * 멱등의 근거가 여기다. 연타든, 타임아웃 뒤 재시도든, 앱을 껐다 켜고 다시 누른 것이든
   * 같은 초안에서 나가는 요청은 전부 같은 captureId를 쓴다. 서버는 사진 업로드와 똑같이
   * captureId 폴더 + 내용 지문으로 같은 접수임을 알아본다.
   */
  captureId: string;
  text: string;
  updatedAt: string;
}

function draftShape(value: unknown): ManualDraft | null {
  const draft = value as Partial<ManualDraft> | null;
  if (!draft || typeof draft.captureId !== 'string' || !draft.captureId.trim()) return null;
  if (typeof draft.text !== 'string') return null;
  return { captureId: draft.captureId, text: draft.text, updatedAt: String(draft.updatedAt ?? '') };
}

export function loadManualDraft(): ManualDraft | null {
  const raw = loadManualDraftRaw();
  if (!raw) return null;
  try {
    return draftShape(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveManualDraft(draft: ManualDraft): void {
  saveManualDraftRaw(JSON.stringify(draft));
}

export function clearManualDraft(): void {
  saveManualDraftRaw('');
}

/**
 * 지금 이어 쓸 초안. 없으면 새 captureId로 하나 만든다(저장은 하지 않는다 —
 * 사용자가 한 글자도 쓰지 않았는데 빈 초안을 남길 이유가 없다).
 */
export function startManualDraft(now = new Date(), random: () => number = Math.random): ManualDraft {
  return loadManualDraft() ?? { captureId: createCaptureId(now, random), text: '', updatedAt: now.toISOString() };
}

/* ── 화면 문구 ─────────────────────────────────────────────────────────── */

/** 기기 저장 실패 문구. 사진용 문구는 "촬영"을 말하므로 직접 입력에는 맞지 않는다. */
export const manualQueueWriteMessage: Record<QueueWriteFailure, string> = {
  quota: '휴대폰 저장 공간이 부족해 적으신 내용을 기기에 넣지 못했어요. 아직 저장되지 않았으니 화면을 닫지 마세요 — 전송이 끝난 예전 기록을 정리한 뒤 다시 눌러 주세요.',
  unavailable: '이 브라우저에서 기기 저장소를 열 수 없어 적으신 내용을 보관하지 못했어요. 아직 저장되지 않았습니다 — 시크릿 모드라면 일반 창에서 다시 열어 주세요.',
  verify: '저장을 시도했지만 다시 읽었을 때 내용이 온전하지 않았어요. 안전하다고 말할 수 없으니 다시 눌러 주세요.',
  unknown: '적으신 내용을 기기에 보관하지 못했어요. 아직 저장되지 않았으니 다시 시도해 주세요.',
};

/**
 * 전송 실패 문구. 서버가 아직 직접 입력을 모르는 구간(`Code.gs` 재배포 전)은 사용자가
 * 재시도해서 풀 수 있는 문제가 아니므로, 무엇이 남아 있고 누가 무엇을 해야 하는지 말한다.
 */
export function manualUploadErrorMessage(code: unknown): string {
  const raw = code instanceof Error ? code.message : String(code ?? '');
  if (raw === MANUAL_INTAKE_NOT_DEPLOYED) {
    return '적으신 내용은 이 폰에 안전하게 남아 있지만, 서버가 아직 직접 입력을 받을 준비가 되지 않았어요. 서버(Apps Script)를 새 버전으로 다시 배포하면 다시 보내기 없이 자동으로 올라갑니다. 그때까지 내용은 지워지지 않아요.';
  }
  if (!raw) return '보내지 못했어요 — 적으신 내용은 이 폰에 남아 있고 연결되면 자동으로 다시 보냅니다.';
  if (/failed to fetch|networkerror|load failed|network request failed|timeout/i.test(raw)) {
    return '연결이 닿지 않아 아직 보내지 못했어요. 적으신 내용은 이 폰에 남아 있고, 연결되면 자동으로 다시 보냅니다.';
  }
  return `아직 보내지 못했어요 (${raw}). 적으신 내용은 이 폰에 남아 있고 연결되면 자동으로 다시 보냅니다.`;
}

export const MANUAL_PLACEHOLDER ='예: 어제 로보월드 부스에서 만난 가온테크 김미래 CTO. 배터리 열관리 쪽 담당이고, 우리 방열 부품에 관심 많았음. 명함은 못 받았고 mirae.kim@gaontech-fake.co.kr 로 연락 달라고 함.';

export const MANUAL_SCOPE_DOES = '적어 주신 내용에서 이름·회사·역할·연락처 단서를 뽑아, 명함을 찍었을 때와 똑같이 중복을 확인하고 공개된 정보로 브리핑을 만듭니다.';

export const MANUAL_SCOPE_LIMITS = '이름을 몰라도 됩니다. 확실하지 않은 내용은 지어내지 않고 모른다고 적습니다. 기존 인물과 같은 사람이라는 확실한 단서(이메일·전화·이름+소속 완전 일치)가 없으면 기존 기록을 고치지 않고 새 인물로 등록합니다.';
