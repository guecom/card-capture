import {
  IonApp,
  IonButton,
  IonContent,
  IonFooter,
  IonHeader,
  IonInput,
  IonItem,
  IonList,
  IonModal,
  IonPage,
  IonSpinner,
  IonTextarea,
  IonTitle,
  IonToast,
  IonToolbar,
  setupIonicReact,
} from '@ionic/react';
import { ArrowUpRight, Camera, ChevronRight, FileText, ImageOff, Mail, MessageCircle, Mic, PenLine, Plus, RefreshCw, RotateCcw, Search, Settings2, ShieldCheck, Sparkles, SunMoon, Waves } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
// 릴리즈 버전은 저장소가 선언한 값 하나만 쓴다 (founder 지시 2026-07-27: "버전이 설정에 표기되었으면 함").
// `package.json`은 이미 빌드 식별자의 해시 입력이므로 값이 바뀌면 식별자도 함께 바뀐다 —
// 벽시계·환경변수와 달리 빌드마다 달라지지 않아 재현성 계약(eval/build-reproducibility.test.js)을 깨지 않는다.
import { version as APP_VERSION } from '../package.json';
import type { BriefItem, CaptureQueueItem, PersonTarget, QuickName, RuntimeConfig, SearchItem } from './contracts/capture';
import { CameraCaptureModal, type CapturedSideMeta, type CardSide } from './components/CameraPreviewModal';
import { StatusBadge } from './components/StatusBadge';
import { MarkdownLite } from './components/MarkdownLite';
import { ActionSection, ContactActions, PersonDocument } from './components/PersonDocument';
import { AiExampleChips, AiScopeNote, AiStageRail, AiSurface, AiSurfaceHead } from './components/AiTaskSurface';
import { addPersonNote, fetchServerCaptureIds, listBriefsUpTo, loadPersonDocument, requeueCapture, requestCorrection, searchPeople, submitResearchInstruction, uploadCapture } from './services/api';
import {
  contentEvidence,
  contentLookupTargets,
  evidenceSegments,
  titleEvidence,
  type SearchEvidence,
} from './services/recall-evidence';
import {
  elapsedLabel,
  RECALL_SCOPE_NOTE,
  recallStages,
  RESEARCH_EXAMPLE_CHIPS,
  RESEARCH_PLACEHOLDER,
  RESEARCH_SCOPE_DOES,
  RESEARCH_SCOPE_LIMITS,
  researchStages,
  type RecallStageKey,
  type ResearchStageKey,
} from './services/ai-stages';
import { type CapturedCameraFrame, storedCameraFrame, thumbnailOf } from './services/camera';
import {
  QUICK_NAME_LATER_LABEL,
  QUICK_NAME_STATUS_COPY,
  queueRowName,
  quickNameReadingCopy,
} from './services/capture-name';
import {
  captureContextFilled,
  captureContextSummary,
  eventChips as buildEventChips,
  KAIREN_RELATION_CHIPS,
  SELF_RELATION_CHIPS,
  toggleChipValue,
} from './services/capture-context';
import { buildLegacyNote, buildQueuedCapture, parseLegacyNote, restoredDraftOf } from './services/capture-item';
import { actionErrorMessage, briefListTitle, briefNameMap, briefTitle, elapsedMinutesOf } from './services/brief-view';
import { captureProgress, refreshHint } from './services/capture-progress';
import { refreshCadenceMs } from './services/refresh-cadence';
import { contactCardFromBrief } from './services/contacts';
import { getOpenCvWorker, prefetchOpenCv } from './services/opencv';
import { prefetchQuickOcrAssets } from './services/paddle-quickname';
import {
  type DamagedQueueEntry,
  flushQueue,
  pruneSentQueue,
  putQueueItem,
  putQueueItemVerified,
  QueueWriteError,
  queueWriteMessage,
  readQueueChecked,
  takeBackQueueItem,
  undoRefusalMessage,
  undoRefusalOf,
  withQueueLock,
} from './services/queue';
import {
  appliedClueChips,
  describeRecallQuery,
  groupRecallCandidates,
  matchesFacet,
  recallFacets,
  type RecallFacet,
  type RecallResult,
  runRecallSearch,
  serverFallbackTerm,
} from './services/recall-search';
import { buildResearchInstruction } from './services/research';
import { recognizeQuickName } from './services/vision';
import {
  loadCachedBriefs,
  loadGalleryFree,
  loadOwnerFlags,
  loadRecentSearches,
  loadRuntimeConfigDetailed,
  loadSectionCollapsed,
  loadStickyCaptureContext,
  loadMotionPreference,
  loadThemePreference,
  saveCachedBriefs,
  saveGalleryFree,
  saveOwnerFlags,
  saveRecentSearch,
  saveRuntimeConfig,
  saveSectionCollapsed,
  saveStickyCaptureContext,
  saveMotionPreference,
  saveThemePreference,
  signOutDevice,
  type MotionPreference,
  type ThemePreference,
} from './services/storage';
import { applyTheme, resolveTheme, systemPrefersDark, THEME_CHOICES, watchSystemTheme } from './services/theme';
import { applyMotion, MOTION_CHOICES, resolveMotion, systemPrefersReducedMotion, watchSystemMotion } from './services/motion';
import { holdSafeAreaInset } from './services/viewport-shell';
import { apiRejectionMessage, canEditApiEndpoint } from './services/api-origin';
import { scrubCredentialParams } from './services/url-credentials';

setupIonicReact({ mode: 'ios' });

type Tab = 'capture' | 'activity' | 'people' | 'settings';

function initialTab(): Tab {
  const view = new URLSearchParams(globalThis.location?.search ?? '').get('view');
  if (view === 'search') return 'people';
  if (view === 'briefs' || view === 'activity') return 'activity';
  return 'capture';
}

const tabs: Array<{ id: Tab; label: string; icon: LucideIcon }> = [
  { id: 'capture', label: '캡처', icon: Camera },
  { id: 'activity', label: '진행', icon: Waves },
  { id: 'people', label: '검색', icon: Search },
  { id: 'settings', label: '설정', icon: Settings2 },
];

// 상단 바가 화면 이름을 소유한다 — 예전에는 제품 이름만 띄우고 각 화면이 큰 제목을 또 그려
// 폰 화면 위쪽 160px이 제목 두 줄로 쓰였다 (founder 판정 2026-07-26: "허접해 보인다").
const screenTitles: Record<Tab, string> = {
  capture: '명함 캡처',
  activity: '처리 진행',
  people: '사람 찾기',
  settings: '내 앱 설정',
};

type SearchMode = 'quick' | 'recall';

function formatMoment(value?: string): string {
  if (!value) return '시간 정보 없음';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function queueNamedImageSource(item: CaptureQueueItem, name: 'front.jpg' | 'back.jpg'): string {
  const image = item.images.find((candidate) => candidate.name === name && candidate.dataB64);
  return image?.dataB64 ? `data:${image.mime ?? 'image/jpeg'};base64,${image.dataB64}` : '';
}

function queueImageSource(item: CaptureQueueItem): string {
  if (item.thumb) return item.thumb;
  return queueNamedImageSource(item, 'front.jpg');
}

// `예전 기록 더 보기` 한 번에 늘어나는 건수. 서버 한 페이지(최대 100건)와는 별개로,
// 화면이 요청하는 총 건수를 이만큼씩 키우고 `listBriefsUpTo`가 필요한 만큼 페이지를 이어 읽는다.
const LIST_PAGE_STEP = 30;

// 대기열 행에 보여 줄 단계 요약. 서버 응답이 아직 없으면 로컬 전송 상태만으로 계산한다.
function queueProgressOf(item: CaptureQueueItem) {
  return captureProgress({ queue: item, elapsedMinutes: elapsedMinutesOf(item) });
}

function queueStateCopy(item: CaptureQueueItem): string {
  if (item.state === 'sent') return '전송됨';
  if (item.state === 'failed') return `재시도 필요${item.tries ? ` · ${item.tries}회` : ''}`;
  return '전송 대기';
}

// 구버전(legacy가 저장한) 큐 항목은 관계 필드 없이 note만 있다 — 편집 화면에서 되살린다.
function normalizedQueueItem(item: CaptureQueueItem): CaptureQueueItem {
  if (item.relSelf !== undefined) return item;
  const parsed = parseLegacyNote(item.note);
  return { ...item, relSelf: parsed.relSelf, relKairen: parsed.relKairen, memo: parsed.memo };
}

function queueContextLine(item: CaptureQueueItem): string {
  const relations = item.relSelf === undefined ? parseLegacyNote(item.note) : { relSelf: item.relSelf ?? '', relKairen: item.relKairen ?? '', memo: '' };
  const parts: string[] = [];
  if (item.event) parts.push(item.event);
  if (relations.relKairen) parts.push(`Kairen: ${relations.relKairen}`);
  if (relations.relSelf) parts.push(`나: ${relations.relSelf}`);
  return parts.join(' · ');
}

// 촬영 직후 토스트 문구 (legacy camCapture 토스트 규칙).
function captureToast(side: CardSide, meta: CapturedSideMeta): string {
  const label = side === 'front' ? '앞면' : '뒷면';
  let text: string;
  // 기본 카메라 앱으로 찍은 사진은 그 앱이 갤러리에 저장한다 — 우리가 지울 수 없으니 사실대로 알린다.
  if (meta.source === 'native') text = `${label} 준비 완료 · 기본 카메라로 찍어 갤러리에 사진이 남았어요`;
  else if (meta.cropState === 'rectified') text = meta.source === 'auto' ? `${label} 자동 촬영 · 크롭 완료` : `${label} 저장 — 자동 크롭됨`;
  else text = `${label} 저장`;
  if (meta.blurry) text += ' · 사진이 조금 흐릿해요 — 필요하면 다시 찍어주세요';
  return text;
}

// 로컬 캡처와 서버 브리핑을 captureId로 병합한 단일 목록 항목 (2026-07-26 실폰 피드백 2).
interface FeedEntry {
  id: string;
  brief?: BriefItem;
  local?: CaptureQueueItem;
}

type PersonActionComposer =
  | { kind: 'note'; target: PersonTarget }
  | { kind: 'research'; target: PersonTarget }
  | { kind: 'correction'; captureId: string };

const personActionCopy = {
  note: {
    eyebrow: '내 기록',
    title: '메모 추가',
    helper: '다음 만남에 기억하고 싶은 사실이나 약속을 남겨주세요. 접수한 메모는 인물 기록에 병합됩니다.',
    placeholder: '예: 3분기 협력안을 논의했고, 다음 주에 자료를 보내기로 함',
    submit: '메모 저장',
  },
  research: {
    eyebrow: '공개 정보 조사',
    title: 'AI 조사 요청',
    helper: '묻기 껄끄럽지만 알아야 하는 것까지 맡기세요. 공개된 근거로 판단하고 확신도를 함께 적습니다. 요청 내용·대상·시각과 처리 결과가 기록됩니다.',
    placeholder: '예: 이 사람 실력이 진짜인지 공개된 결과물로 판단해줘. 실제로 결정 권한이 있는 자리인지도.',
    submit: '조사 요청 접수',
  },
  correction: {
    eyebrow: '정보 바로잡기',
    title: '수정 요청',
    helper: '어떤 정보가 어떻게 달라야 하는지 알려주세요. 다음 처리에서 기존 근거와 함께 다시 확인합니다.',
    placeholder: '예: 직함은 CTO가 아니라 CPO이고, 영문 이름 표기는 Jiyoon An',
    submit: '수정 요청 보내기',
  },
} as const;

// 손상 사유를 사람이 읽는 말로 (FI-025).
const damageLabels: Record<DamagedQueueEntry['damage'][number], string> = {
  missing_id: '식별자 없음',
  bad_state: '알 수 없는 상태',
  no_images: '사진 목록 손상',
  empty_payload: '사진 내용 비어 있음',
};

// boot에서 딱 한 번: 신뢰 판정 → subject namespace 결정 → 주소창 정리 (FI-004·005·006).
// 사적 캐시를 읽는 useState 초기값보다 반드시 먼저 끝나야 한다.
const boot = loadRuntimeConfigDetailed();
if (boot.scrubUrl) scrubCredentialParams();

// 고급 설정의 연결 주소를 편집할 수 있는가 (founder 결정 — Kairen-Ref: TSK-000302).
// 배포본에서는 무엇을 넣어도 신뢰 판정이 거부하므로 편집 가능한 칸은 거짓 선택지다.
// 페이지 origin은 한 세션 동안 바뀌지 않으므로 boot에서 한 번만 정한다.
const apiEndpointEditable = canEditApiEndpoint();
const API_ENDPOINT_LOCK_NOTE = '이 앱은 배포본에 박힌 주소 한 곳으로만 연결해요. 그래서 여기서는 바꿀 수 없어요 — 다른 주소로 옮기려면 새 배포본이 필요합니다.';

function App() {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [config, setConfig] = useState<RuntimeConfig>(boot.config);
  const [draftConfig, setDraftConfig] = useState<RuntimeConfig>(config);
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [briefs, setBriefs] = useState<BriefItem[]>(loadCachedBriefs);
  const [queue, setQueue] = useState<CaptureQueueItem[]>([]);
  const [damagedQueue, setDamagedQueue] = useState<DamagedQueueEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [nameOnboardOpen, setNameOnboardOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  // 빠른 검색이 시작된 시각. "빠르긴 하지만 텀이 있는 만큼 진행을 인지할 수 있으면 좋겠다"
  // (founder 2026-07-27). 남은 시간을 지어내지 않고, 아는 것(경과)만 센다.
  const [searchStartedAt, setSearchStartedAt] = useState<number | null>(null);
  const [searchResults, setSearchResults] = useState<SearchItem[]>([]);
  // 검색 결과 근거 (FI-104). 서버는 `via`만 주고 어디가 맞았는지는 말하지 않는다.
  // 제목 일치는 제목 안 매칭 구간 자체가 근거이고, 본문 일치는 문서를 읽어 주변만 잘라 온다.
  const [searchTerm, setSearchTerm] = useState('');
  const [searchEvidence, setSearchEvidence] = useState<Record<string, SearchEvidence | null>>({});
  const searchRunRef = useRef(0);
  const [recentSearches, setRecentSearches] = useState<string[]>(loadRecentSearches);
  const [searchMode, setSearchMode] = useState<SearchMode>('quick');
  const [recallResult, setRecallResult] = useState<RecallResult | null>(null);
  const [recallServerItems, setRecallServerItems] = useState<SearchItem[]>([]);
  // 검색 진행 상태 — "찾고 있는 건지, 그동안 뭘 하는 건지"를 화면에 드러낸다 (INT-000015 항목 003).
  const [recallStage, setRecallStage] = useState<RecallStageKey>('done');
  const [recallStartedAt, setRecallStartedAt] = useState<number | null>(null);
  const [recallFinishedMs, setRecallFinishedMs] = useState<number | null>(null);
  const [recallSyncing, setRecallSyncing] = useState(false);
  const [recallFacet, setRecallFacet] = useState<RecallFacet | null>(null);
  const [recallLimit, setRecallLimit] = useState(15);
  const recallRunRef = useRef(0);
  const [galleryFree, setGalleryFree] = useState(loadGalleryFree);
  // 화면 테마 (INT-000016 항목 003). 저장된 건 사용자가 고른 preference이고,
  // 실제로 칠하는 값은 `시스템`일 때만 OS 설정에 따라 달라진다.
  const [theme, setTheme] = useState<ThemePreference>(loadThemePreference);
  const [osPrefersDark, setOsPrefersDark] = useState(systemPrefersDark);
  const resolvedTheme = resolveTheme(theme, osPrefersDark);
  // 화면 움직임 (founder 판정 2026-07-28). 폰의 `움직임 최소화`가 켜져 있으면 AI 표면의 빛이
  // 하나도 그려지지 않는다 — 그건 결함이 아니라 존중이지만, **왜 안 보이는지 말해 주고 직접 켤 수도**
  // 있어야 한다. 그래서 OS 설정은 기본값이지 잠금장치가 아니다.
  const [motion, setMotion] = useState<MotionPreference>(loadMotionPreference);
  const [osPrefersReducedMotion, setOsPrefersReducedMotion] = useState(systemPrefersReducedMotion);
  const resolvedMotion = resolveMotion(motion, osPrefersReducedMotion);
  /**
   * 지금 **실제로 서버에 올리고 있는** captureId. 없으면 보내는 중이 아니다 (FI-034).
   *
   * 예전에는 전역 boolean 하나였다. `flushQueue`는 20초 주기와 `online` 이벤트로도 돌기 때문에
   * **보낼 것이 하나도 없는 flush 동안에도** 그 값이 켜졌고, 화면은 그것을 구획별·항목별
   * 진행처럼 렌더했다 — founder가 실기기에서 본 "'전송 중...'이 아님에도 이렇게 표기되는 것"이다.
   * 이제 값의 출처는 업로드 호출 그 자체이므로, 보낼 것이 없으면 아무 데도 켜지지 않는다.
   */
  const [sendingId, setSendingId] = useState<string | null>(null);
  // owner 게이트는 legacy처럼 localStorage 캐시로 시작해 서버 응답으로 갱신한다 — 오프라인에도 유지.
  const [ownerCanSeeAll, setOwnerCanSeeAll] = useState(() => loadOwnerFlags().seeAll);
  const [researchInstructionEnabled, setResearchInstructionEnabled] = useState(() => {
    const flags = loadOwnerFlags();
    return flags.seeAll && flags.researchInstructionEnabled;
  });
  // 화면이 서버에 요청하는 총 건수. `더 보기`를 누를 때마다 커지고 상한이 없다 —
  // 서버 한 페이지(100건) 안에서만 움직이면 101번째부터는 앱에서 존재하지 않는 것이 된다 (FI-100).
  const listWantedRef = useRef(LIST_PAGE_STEP);
  const [hasMoreBriefs, setHasMoreBriefs] = useState(false);
  const [feedLimit, setFeedLimit] = useState(LIST_PAGE_STEP);
  const [loadingMore, setLoadingMore] = useState(false);
  const [feedMoreStatus, setFeedMoreStatus] = useState('');
  const loadMoreRef = useRef<HTMLButtonElement>(null);
  const feedStatusRef = useRef<HTMLParagraphElement>(null);
  const focusFeedStatusRef = useRef(false);
  const [expandedBriefs, setExpandedBriefs] = useState<Set<string>>(() => new Set());
  const [recordsCollapsed, setRecordsCollapsed] = useState(() => loadSectionCollapsed('briefs'));
  const [documentOpen, setDocumentOpen] = useState(false);
  const [documentTitle, setDocumentTitle] = useState('프로필');
  const [documentBody, setDocumentBody] = useState('');
  const [documentError, setDocumentError] = useState('');
  const [documentLoading, setDocumentLoading] = useState(false);
  const [documentNoteTarget, setDocumentNoteTarget] = useState<PersonTarget | null>(null);
  const [personActionComposer, setPersonActionComposer] = useState<PersonActionComposer | null>(null);
  const [personActionText, setPersonActionText] = useState('');
  const [personActionSubmitting, setPersonActionSubmitting] = useState(false);
  const [queueEdit, setQueueEdit] = useState<CaptureQueueItem | null>(null);
  // 기다리게 하는 동작에는 예외 없이 "지금 하고 있다"가 붙어야 한다 (founder 원칙 2026-07-27).
  const [savingQueueEdit, setSavingQueueEdit] = useState(false);
  const [retryingId, setRetryingId] = useState('');
  const [requeueingId, setRequeueingId] = useState('');
  const [queueRetakeSide, setQueueRetakeSide] = useState<'front.jpg' | 'back.jpg'>('front.jpg');
  // 카메라 모달이 "새 캡처"가 아니라 "기존 캡처의 한 면 교체"로 열렸는지.
  const [retakeMode, setRetakeMode] = useState(false);
  const flushingRef = useRef(false);
  const contentRef = useRef<HTMLIonContentElement>(null);

  // ── 촬영 초안: 맥락 필드·빠른 이름은 legacy처럼 메인 화면이 소유한다 ──
  const sticky = useMemo(() => loadStickyCaptureContext(), []);
  const [frontFrame, setFrontFrame] = useState<CapturedCameraFrame | null>(null);
  const [backFrame, setBackFrame] = useState<CapturedCameraFrame | null>(null);
  const [event, setEvent] = useState(sticky.event);
  const [relSelf, setRelSelf] = useState(sticky.relSelf);
  const [relKairen, setRelKairen] = useState(sticky.relKairen);
  const [memo, setMemo] = useState('');
  const [researchText, setResearchText] = useState(sticky.research);
  const [contextCollapsed, setContextCollapsed] = useState(() => loadSectionCollapsed('context', false));
  const [queueing, setQueueing] = useState(false);
  // 자동 새로고침 안내용: 마지막 갱신 시각과 현재 시각(1초 tick).
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const [clockTick, setClockTick] = useState(() => Date.now());
  const [quickName, setQuickName] = useState<QuickName | null>(null);
  const [nameText, setNameText] = useState('');
  const [ocrState, setOcrState] = useState(QUICK_NAME_STATUS_COPY.idle);
  // 사용자가 `모름 / 나중에`를 **명시적으로** 골랐는가 (FI-067). 화면 표시 전용이다 —
  // 저장되는 값은 이름 없음(quickName: null) 그대로이고 새 필드를 만들지 않는다.
  const [nameLater, setNameLater] = useState(false);
  const ocrSessionRef = useRef(0);
  const nameEditedRef = useRef(false);
  const [cameraSession, setCameraSession] = useState<{ side: CardSide; withChoice: boolean } | null>(null);
  // 방금 저장한 촬영의 captureId (FI-049). 되돌리기·다시 열기의 대상이다.
  const [lastSavedId, setLastSavedId] = useState('');
  const [undoing, setUndoing] = useState(false);
  const refreshInFlightRef = useRef<Promise<{ count: number; hasMore: boolean } | null> | null>(null);
  const refreshQueuedRef = useRef(false);
  // 연결 정보가 바뀌거나 연결을 해제하면 이전 토큰으로 시작한 응답은 화면·사적 캐시에 쓰지 않는다.
  const refreshSessionRef = useRef(0);
  // 이 render에서 만든 refresh callback이 어느 연결 세션에 속하는지 고정한다. 연결 해제 뒤에도
  // 이전 callback을 들고 있던 upload/flush 작업이 늦게 호출될 수 있으므로 실행 시작부터 막는다.
  const refreshCallbackSession = refreshSessionRef.current;

  const configured = Boolean(config.apiUrl && config.token);
  const refreshIntervalMs = useMemo(() => refreshCadenceMs(briefs), [briefs]);

  // 자동 trigger끼리는 같은 요청을 공유한다. 반면 사용자의 확인이나 새 작업 직후 trigger가 이미
  // 진행 중인 조회와 겹치면, 그 조회가 끝난 직후 한 번 더 읽는다. 그래야 작업 전 snapshot을
  // "최신"으로 오인하지 않으면서도 list 요청은 언제나 하나씩만 실행된다.
  const refresh = useCallback(function runRefresh(ensureFresh = false): Promise<{ count: number; hasMore: boolean } | null> {
    if (refreshCallbackSession !== refreshSessionRef.current) return Promise.resolve(null);
    const active = refreshInFlightRef.current;
    if (active) {
      if (!ensureFresh) return active;
      refreshQueuedRef.current = true;
      return active.catch(() => null).then(() => {
        // 먼저 깨어난 강한 trigger가 trailing 조회를 시작했다면 나머지는 그것을 함께 기다린다.
        if (refreshInFlightRef.current) return refreshInFlightRef.current;
        if (!refreshQueuedRef.current) return null;
        refreshQueuedRef.current = false;
        return runRefresh(false);
      });
    }

    const session = refreshCallbackSession;

    const request = (async (): Promise<{ count: number; hasMore: boolean } | null> => {
      setLoading(true);
      try {
        await pruneSentQueue();
        // 손상 항목은 화면·전송에서 빼되 기기에서 지우지 않는다 (FI-025).
        const integrity = await readQueueChecked();
        setQueue(integrity.healthy.sort((a, b) => b.captureId.localeCompare(a.captureId)));
        setDamagedQueue(integrity.damaged);
        if (!configured) return null;
        // 화면이 요청한 건수만큼 페이지를 이어 읽는다 — 첫 페이지에서 끊으면 사각지대가 생긴다.
        const response = await listBriefsUpTo(config, listWantedRef.current);
        // 연결 해제·계정 변경 뒤 늦게 도착한 이전 응답은 개인 데이터를 되살릴 수 없다.
        if (session !== refreshSessionRef.current) return null;
        if (!response.ok) throw new Error(response.error ?? 'list_failed');
        const nextBriefs = response.items ?? [];
        setBriefs(nextBriefs);
        saveCachedBriefs(nextBriefs);
        const seeAll = response.seeAll === true;
        const research = response.researchInstructionEnabled === true;
        setOwnerCanSeeAll(seeAll);
        setResearchInstructionEnabled(seeAll && research);
        saveOwnerFlags({ seeAll, researchInstructionEnabled: research });
        const hasMore = response.hasMore === true;
        setHasMoreBriefs(hasMore);
        setRefreshedAt(Date.now());
        return { count: nextBriefs.length, hasMore };
      } finally {
        if (session === refreshSessionRef.current) setLoading(false);
      }
    })().finally(() => {
      if (refreshInFlightRef.current === request) refreshInFlightRef.current = null;
    });

    refreshInFlightRef.current = request;
    return request;
  }, [config, configured, refreshCallbackSession]);

  // 배경 갱신은 실패를 조용히 넘긴다 — 오프라인 토스트 스팸 방지 (legacy 규칙).
  const silentRefresh = useCallback(async (ensureFresh = false) => {
    await refresh(ensureFresh).catch(() => undefined);
  }, [refresh]);

  // 수동 새로고침은 즉시 진행 토스트 → 완료/실패 토스트로 반응한다 (2026-07-26 실폰 피드백 7).
  const manualRefresh = useCallback(async () => {
    setMessage('새로고침 중…');
    try {
      await refresh(true);
      setMessage((current) => current === '' || current === '새로고침 중…' ? '새로고침 완료 — 최신 상태예요' : current);
    } catch (error) {
      setMessage(`새로고침 실패: ${actionErrorMessage(error)}`);
    }
  }, [refresh]);

  // `예전 기록 더 보기` (FI-100). 서버가 offset·hasMore로 과거 기록 전체를 줄 수 있으므로
  // 화면도 끝까지 갈 수 있어야 한다. 무엇이 일어났는지는 낭독기에도 들리게 알린다.
  const loadMoreBriefs = useCallback(async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    const before = briefs.length;
    listWantedRef.current += LIST_PAGE_STEP;
    setFeedLimit((current) => current + LIST_PAGE_STEP);
    try {
      const outcome = await refresh(true);
      if (!outcome) return;
      const added = Math.max(outcome.count - before, 0);
      setFeedMoreStatus(outcome.hasMore
        ? `예전 기록 ${added}건을 더 불러왔어요 · 지금까지 ${outcome.count}건`
        : `예전 기록을 모두 불러왔어요 · 총 ${outcome.count}건`);
      // 더 볼 것이 없으면 버튼이 사라진다 — 포커스가 문서 처음으로 튕기지 않게 안내문으로 옮긴다.
      if (!outcome.hasMore && document.activeElement === loadMoreRef.current) focusFeedStatusRef.current = true;
    } catch {
      setFeedMoreStatus('예전 기록을 불러오지 못했어요 — 연결을 확인하고 다시 눌러 주세요.');
    } finally {
      setLoadingMore(false);
    }
  }, [briefs.length, loadingMore, refresh]);

  useEffect(() => {
    if (!focusFeedStatusRef.current) return;
    focusFeedStatusRef.current = false;
    feedStatusRef.current?.focus();
  }, [feedMoreStatus, hasMoreBriefs]);

  const flushPendingQueue = useCallback(async (announce = false) => {
    if (!configured || flushingRef.current) return;
    flushingRef.current = true;
    try {
      // 탭 하나만 전송한다 — 두 탭이 동시에 올리면 같은 명함이 두 번 접수된다 (FI-053).
      // 응답을 못 받았던 항목은 다시 올리기 전에 서버 기록과 대조한다 (FI-016).
      //
      // 전송 진행의 진실 원천은 여기다: `flushQueue`는 실제로 올릴 항목에 대해서만 이 함수를
      // 부른다(대조로 건너뛴 항목·보류한 항목에는 부르지 않는다). 그래서 화면이 "지금 무엇을
      // 보내는 중인가"를 추측하지 않고 그대로 말할 수 있다.
      const result = await withQueueLock(() => flushQueue(
        async (item) => {
          setSendingId(item.captureId);
          try {
            await uploadCapture(config, item);
          } finally {
            // 이 항목의 전송이 끝났다. 다음 항목이 이미 시작했다면 그 값을 덮어쓰지 않는다.
            setSendingId((current) => (current === item.captureId ? null : current));
          }
        },
        () => fetchServerCaptureIds(config),
      ));
      if (result === null) {
        if (announce) setMessage('다른 탭에서 전송 중이라 여기서는 기다립니다 — 같은 명함을 두 번 보내지 않아요.');
        return;
      }
      await refresh(true).catch(() => undefined);
      const reconciled = result.reconciled > 0 ? ` ${result.reconciled}건은 이미 접수돼 있어 다시 보내지 않았어요.` : '';
      if (announce && (result.attempted > 0 || result.reconciled > 0)) {
        setMessage(result.failed > 0
          ? `${result.sent}건 전송, ${result.failed}건은 다음 연결 때 다시 시도합니다.${reconciled}`
          : `${result.sent}건을 기존 처리 대기열로 보냈습니다.${reconciled}`);
      }
    } catch (error) {
      if (announce) setMessage(`전송 재시도 실패: ${actionErrorMessage(error)}`);
    } finally {
      flushingRef.current = false;
      // 안전망. 정상 경로에서는 위의 항목별 정리가 이미 비웠다.
      setSendingId(null);
    }
  }, [config, configured, refresh]);

  useEffect(() => {
    void silentRefresh(true);
    void flushPendingQueue();
    const handleOnline = () => void flushPendingQueue(true);
    const handleVisibility = () => {
      if (document.hidden) return;
      // 앱 복귀 시 legacy처럼 전송 재시도·브리핑 갱신·스티키 복원을 함께 한다.
      void flushPendingQueue();
      void silentRefresh(true);
      const restored = loadStickyCaptureContext();
      setEvent((value) => value || restored.event);
      setRelSelf((value) => value || restored.relSelf);
      setRelKairen((value) => value || restored.relKairen);
      setResearchText((value) => value || restored.research);
    };
    const clock = window.setInterval(() => setClockTick(Date.now()), 1_000);
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.clearInterval(clock);
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [flushPendingQueue, silentRefresh]);

  // 서버에서 아직 끝나지 않은 명함·조사 receipt가 있을 때만 더 빠르게 확인한다.
  // setInterval tick이 겹쳐도 refresh single-flight가 같은 요청을 공유한다.
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (!document.hidden) void silentRefresh();
    }, refreshIntervalMs);
    return () => window.clearInterval(interval);
  }, [refreshIntervalMs, silentRefresh]);

  // 감지 엔진을 유휴 시점에 워커에서 미리 기동한다 — legacy(v1.0)가 페이지 로드 2.5초 뒤
  // OpenCV를 미리 컴파일해 뒀기 때문에 카메라를 열면 곧바로 명함을 잡았다. 카메라를 열 때
  // 비로소 10MB 엔진을 컴파일하면 폰에서 수십 초 동안 감지가 죽는다 (2026-07-26 폴드7 재보고).
  // 워커에서 돌므로 메인 스레드는 잠기지 않는다.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      prefetchOpenCv();
      void getOpenCvWorker().ready;
      prefetchQuickOcrAssets();
    }, 2_500);
    return () => window.clearTimeout(timer);
  }, []);

  // 맥락·조사 지시는 입력 즉시 저장한다 — 완료를 못 눌러도 2시간 유지 성립 (2026-07-26 실폰 결함 8).
  useEffect(() => {
    saveStickyCaptureContext({ event, relSelf, relKairen, research: researchText });
  }, [event, relKairen, relSelf, researchText]);

  // 첫 실행은 legacy처럼 이름 한 칸만 묻는다 — 주소·토큰은 개인 링크(?k=)가 자동으로 채운다.
  useEffect(() => {
    if (!config.capturer) setNameOnboardOpen(true);
  }, [config.capturer]);

  // 고른 테마를 문서에 적용하고, `시스템`을 고른 사람은 폰 설정 변경을 그대로 따라간다.
  useEffect(() => {
    applyTheme(resolveTheme(theme, osPrefersDark));
  }, [osPrefersDark, theme]);

  useEffect(() => watchSystemTheme(setOsPrefersDark), []);

  useEffect(() => {
    applyMotion(resolveMotion(motion, osPrefersReducedMotion));
  }, [motion, osPrefersReducedMotion]);

  useEffect(() => watchSystemMotion(setOsPrefersReducedMotion), []);

  // 탭 바가 스크롤 중에 오르내리지 않도록 아래 safe-area 여백을 고정한다 (INT-000016 항목 001).
  useEffect(() => holdSafeAreaInset(), []);

  // 신뢰하지 않는 연결 주소를 무시했다면 그 사실을 첫 화면에서 알린다 (FI-004).
  useEffect(() => {
    if (boot.rejectedApi) setMessage(apiRejectionMessage[boot.rejectedApi.reason]);
  }, []);

  // "어디로 보내지는가"를 사람이 읽는 형태로. 신뢰 목록은 빌드에 박혀 있어 런타임에 늘지 않는다.
  const trustedApiHost = useMemo(() => {
    try {
      return new URL(config.apiUrl).host;
    } catch {
      return '연결 주소 없음';
    }
  }, [config.apiUrl]);

  // 처리 완료 브리핑의 이름을 로컬 캡처 행에 반영한다 (legacy briefNameMap).
  const processedNames = useMemo(() => briefNameMap(briefs), [briefs]);

  // 만남 맥락: 접힌 상태에서 보여 줄 요약과, 최근에 실제로 쓴 만난 곳 chip.
  const contextValue = useMemo(() => ({ event, relKairen, relSelf, memo }), [event, memo, relKairen, relSelf]);
  const contextSummary = useMemo(() => captureContextSummary(contextValue), [contextValue]);
  const contextFilled = useMemo(() => captureContextFilled(contextValue), [contextValue]);
  const eventChips = useMemo(() => buildEventChips(event), [event]);

  // 방금 저장한 촬영 (FI-049). 다음 장을 찍기 시작하면 내려간다 — 되돌리기가 촬영 중인
  // 초안과 다투면 안 되고, 카메라가 열려 있는 동안 화면을 바꿔치기해서도 안 된다.
  const lastSavedItem = useMemo(
    () => queue.find((item) => item.captureId === lastSavedId) ?? null,
    [lastSavedId, queue],
  );
  const showLastSaved = Boolean(lastSavedItem) && !frontFrame && !backFrame && !cameraSession;
  const lastSavedUndoable = Boolean(lastSavedItem) && undoRefusalOf(lastSavedItem ?? undefined) === null;

  // 로컬 캡처 + 서버 브리핑 통합 목록 (실폰 피드백 2): 같은 captureId는 한 항목으로.
  const feed = useMemo<FeedEntry[]>(() => {
    const briefIds = new Set(briefs.map((item) => item.captureId));
    const localById = new Map(queue.map((item) => [item.captureId, item]));
    const entries: FeedEntry[] = briefs.map((item) => ({ id: item.captureId, brief: item, local: localById.get(item.captureId) }));
    queue.forEach((item) => {
      if (!briefIds.has(item.captureId)) entries.push({ id: item.captureId, local: item });
    });
    return entries.sort((a, b) => b.id.localeCompare(a.id));
  }, [briefs, queue]);

  // "언제 저절로 갱신되는지"를 화면에 그대로 보여 준다 (founder 판정 2026-07-26).
  const sinceRefresh = refreshedAt === null ? null : (clockTick - refreshedAt) / 60_000;
  const untilRefresh = refreshedAt === null
    ? refreshIntervalMs / 1000
    : Math.min(refreshIntervalMs / 1000, Math.max(0, (refreshIntervalMs - (clockTick - refreshedAt)) / 1000));
  const autoRefreshHint = refreshHint(untilRefresh, sinceRefresh);

  // 지금 올리고 있는 촬영의 표시 이름. 없으면 빈 문자열이다.
  const sendingItem = useMemo(
    () => (sendingId ? queue.find((item) => item.captureId === sendingId) ?? null : null),
    [queue, sendingId],
  );
  const sendingName = sendingItem ? queueRowName(processedNames[sendingItem.captureId], sendingItem.quickName) : '';

  /**
   * 상단 바의 한 줄 상태. 제품 이름 대신 "지금 무슨 일이 일어나는지"를 소유한다.
   *
   * 예전에는 숫자 하나가 **서로 다른 두 진실을 합산**했다: 이 폰에 있고 아직 못 보낸 촬영과,
   * 서버가 받았지만 아직 끝내지 못한 캡처. 둘은 사용자가 할 일도, 기다리는 대상도 다른데
   * `N건 처리 중`의 N이 무엇인지 알 방법이 없었다. 이제 축마다 이름을 붙인다.
   *
   * 어느 축에 넣을지는 목록이 그 항목을 어떤 행으로 그리는지(`renderFeedEntry`)와 같은 규칙을
   * 쓴다 — 미전송 로컬이 우선이다. 그래야 위의 숫자와 아래 목록이 서로 다른 말을 하지 않는다.
   */
  const awaitingSendCount = useMemo(
    () => feed.filter((entry) => entry.local && entry.local.state !== 'sent').length,
    [feed],
  );
  const serverPendingCount = useMemo(() => feed.filter((entry) => !(entry.local && entry.local.state !== 'sent')
    && entry.brief && entry.brief.status !== 'processed' && entry.brief.status !== 'skipped').length, [feed]);
  const pendingStatus = awaitingSendCount > 0 && serverPendingCount > 0
    ? `전송 대기 ${awaitingSendCount}건 · 서버에서 ${serverPendingCount}건 처리 중`
    : awaitingSendCount > 0 ? `전송 대기 ${awaitingSendCount}건`
      : serverPendingCount > 0 ? `서버에서 ${serverPendingCount}건 처리 중`
        : '';
  const headerStatus = !configured ? '연결 필요 — 개인 링크로 열어주세요'
    // 실제로 올리고 있는 촬영이 있으면 그것이 가장 구체적인 사실이다.
    : sendingId ? `${sendingName || '명함'} 전송 중…`
      : loading ? '최신 상태 확인 중…'
        : pendingStatus ? `${pendingStatus} · ${autoRefreshHint}`
          : feed.length > 0 ? `기록 ${feed.length}건 · ${autoRefreshHint}`
            : '첫 명함을 기다리고 있어요';

  const setupBannerMessage = !config.apiUrl
    ? '연결할 서버 주소가 없어요 — 받으신 개인 링크로 접속하거나 설정의 고급 항목에서 주소를 넣어주세요.'
    : !config.token
      ? '받으신 개인 링크(?k=토큰 포함)로 접속해 주세요. 토큰이 없으면 업로드가 거부됩니다.'
      : '';

  /**
   * 본문 일치의 근거를 뒤늦게 채운다 (FI-104). 결과는 이미 화면에 있고, 근거만 뒤따라온다.
   * 유계 계약: 본문 일치에만, 상한 건수까지만, 하나가 실패해도 검색 결과는 그대로 둔다.
   */
  const loadSearchEvidence = useCallback(async (items: SearchItem[], term: string, run: number) => {
    for (const id of contentLookupTargets(items)) {
      if (run !== searchRunRef.current) return;
      try {
        const response = await loadPersonDocument(config, { id });
        if (run !== searchRunRef.current) return;
        if (!response.ok || !response.markdown) continue;
        // 매칭 위치 주변만 남긴다 — 프런트매터 내부 필드·자격증명·비공개 구획은 근거에서 제외된다.
        const evidence = contentEvidence(response.markdown, term);
        setSearchEvidence((current) => ({ ...current, [id]: evidence }));
      } catch {
        // 근거를 못 읽어도 검색 결과 자체는 유지한다.
      }
    }
  }, [config]);

  const runSearch = useCallback(async (value: string) => {
    const normalized = value.trim();
    if (!normalized || !configured || !ownerCanSeeAll) return;
    const run = ++searchRunRef.current;
    setSearching(true);
    setSearchStartedAt(Date.now());
    setSearchEvidence({});
    setSearchTerm(normalized);
    try {
      const response = await searchPeople(config, normalized);
      if (!response.ok) throw new Error(response.error ?? 'search_failed');
      const items = response.items ?? [];
      setSearchResults(items);
      setRecentSearches(saveRecentSearch(normalized));
      void loadSearchEvidence(items, normalized, run);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      setMessage(code === 'owner_only' ? '소유자 토큰만 검색할 수 있어요'
        : code === 'unknown_action' ? '검색은 서버 업데이트(GAS 재배포) 후 열려요'
          : `검색 실패: ${actionErrorMessage(error)}`);
    } finally {
      setSearching(false);
    }
  }, [config, configured, ownerCanSeeAll]);

  // 자연어 회상 검색 (ISS-000103). 문장은 기기 밖으로 나가지 않는다 — 여기서 조건으로 바꿔
  // 이 기기가 이미 받아 둔 기록과 대조하고, 그래도 없을 때만 기존 검색 endpoint에 단어 하나를 넘긴다.
  const cancelRecall = useCallback(() => {
    recallRunRef.current += 1;
    setSearching(false);
    setRecallSyncing(false);
    setRecallStage('done');
  }, []);

  const runRecall = useCallback(async (value: string) => {
    const text = value.trim();
    if (!text) return;
    const run = ++recallRunRef.current;
    const startedAt = Date.now();
    const alive = () => run === recallRunRef.current;

    setRecallStartedAt(startedAt);
    setRecallFinishedMs(null);
    setRecallServerItems([]);
    setRecallFacet(null);
    setRecallLimit(15);
    setSearching(true);
    setRecallStage('parse');

    // 1단계: 이 기기가 이미 갖고 있는 기록으로 **즉시** 답한다.
    // 예전에는 여기서 먼저 서버 목록(최대 100건)을 받아 왔고, 그 왕복이 체감 지연의 전부였다.
    // founder 판정 2026-07-26: "무지막지하게 빨리 됐으면 좋겠어."
    setRecallStage('match');
    const local = runRecallSearch(briefs, text);
    if (!alive()) return;
    setRecallStage('rank');
    setRecallResult(local);
    setRecallFinishedMs(Date.now() - startedAt);
    setRecallStage('done');
    setSearching(false);
    setRecentSearches(saveRecentSearch(text));

    // 2단계: 첫 결과를 이미 보여 준 뒤에 최신 기록을 받아 다시 대조한다.
    // 문장은 여전히 나가지 않는다 — 목록을 받아 와 기기 안에서 다시 대조할 뿐이다.
    let result = local;
    if (configured) {
      setRecallSyncing(true);
      setRecallStage('match');
      try {
        // 목록 화면이 이미 더 많이 받아 뒀다면 그만큼 읽는다 — 여기서 100건으로 줄이면
        // `더 보기`로 불러 온 과거 기록이 화면에서 도로 사라진다 (FI-100).
        const response = await listBriefsUpTo(config, Math.max(listWantedRef.current, 100));
        if (!alive()) return;
        if (response.ok && response.items) {
          setBriefs(response.items);
          saveCachedBriefs(response.items);
          setHasMoreBriefs(response.hasMore === true);
          result = runRecallSearch(response.items, text);
          setRecallResult(result);
        }
      } catch {
        // 오프라인이면 기기에 캐시된 기록으로 낸 결과를 그대로 둔다.
      } finally {
        if (alive()) {
          setRecallSyncing(false);
          setRecallStage('done');
        }
      }
    }

    // 3단계: 그래도 후보가 없을 때만 기존 검색 endpoint에 단어 하나를 넘겨 전체 기록을 본다.
    const fallback = serverFallbackTerm(result.query);
    if (result.candidates.length === 0 && fallback && configured && ownerCanSeeAll) {
      try {
        const response = await searchPeople(config, fallback);
        if (alive() && response.ok) {
          const items = response.items ?? [];
          setRecallServerItems(items);
          // 전체 기록 검색 결과에도 왜 맞았는지를 붙인다 (FI-104).
          const evidenceRun = ++searchRunRef.current;
          setSearchEvidence({});
          setSearchTerm(fallback);
          void loadSearchEvidence(items, fallback, evidenceRun);
        }
      } catch {
        // 서버 보조 검색 실패는 회상 결과 자체를 막지 않는다.
      }
    }
  }, [briefs, config, configured, loadSearchEvidence, ownerCanSeeAll]);

  function submitSearch(formEvent: FormEvent) {
    formEvent.preventDefault();
    if (searchMode === 'recall') void runRecall(query);
    else void runSearch(query);
  }

  function commitSettings() {
    const saved = saveRuntimeConfig(draftConfig);
    refreshSessionRef.current += 1;
    refreshQueuedRef.current = false;
    setConfig(saved.config);
    setDraftConfig(saved.config);
    setSettingsOpen(false);
    // 거부한 주소는 조용히 무시하지 않는다 — 무엇이 왜 반영되지 않았는지 그대로 말한다.
    setMessage(saved.rejectedApi
      ? apiRejectionMessage[saved.rejectedApi.reason]
      : '기존 Card Capture 설정과 같은 local storage에 저장했어요.');
  }

  function commitOnboardName() {
    const name = nameDraft.trim();
    if (!name) return;
    const next = { ...config, capturer: name };
    refreshSessionRef.current += 1;
    refreshQueuedRef.current = false;
    setConfig(saveRuntimeConfig(next).config);
    setNameOnboardOpen(false);
  }

  // 이 기기에서 개인 링크와 사적 캐시를 끊는다 (FI-007). 대기 중인 촬영은 지우지 않는다.
  const unsentCount = useMemo(() => queue.filter((item) => item.state !== 'sent').length, [queue]);

  function commitSignOut() {
    refreshSessionRef.current += 1;
    refreshQueuedRef.current = false;
    signOutDevice();
    const next: RuntimeConfig = { apiUrl: config.apiUrl, token: '', capturer: '' };
    setConfig(next);
    setDraftConfig(next);
    setBriefs([]);
    setSearchResults([]);
    setRecentSearches([]);
    setRecallResult(null);
    setOwnerCanSeeAll(false);
    setResearchInstructionEnabled(false);
    setEvent('');
    setRelSelf('');
    setRelKairen('');
    setResearchText('');
    setLoading(false);
    setSignOutOpen(false);
    setMessage('이 기기에서 개인 링크와 저장된 기록 사본을 지웠어요.');
  }

  // ── 촬영 흐름: 모달은 촬영만, 결과는 메인 화면으로 돌아온다 ──
  const startQuickNameOcr = useCallback((frame: CapturedCameraFrame) => {
    const session = ++ocrSessionRef.current;
    // 새 앞면 사진 = 새 인식 세션. 이후 사용자가 입력하면 OCR 결과가 덮어쓰지 않는다 (legacy userEdited 가드).
    nameEditedRef.current = false;
    setQuickName(null);
    setNameText('');
    setNameLater(false);
    setOcrState(quickNameReadingCopy());
    void recognizeQuickName(frame.dataUrl, (progress) => {
      if (session === ocrSessionRef.current && !nameEditedRef.current) setOcrState(quickNameReadingCopy(progress));
    }).then((result) => {
      if (session !== ocrSessionRef.current || nameEditedRef.current) return;
      setQuickName(result);
      setNameText(result?.name ?? '');
      // 못 읽은 것은 실패가 아니라 "지금은 모른다"는 결과다 (FI-067).
      setOcrState(result?.name ? QUICK_NAME_STATUS_COPY.read : QUICK_NAME_STATUS_COPY.unreadable);
    }).catch(() => {
      if (session === ocrSessionRef.current && !nameEditedRef.current) setOcrState(QUICK_NAME_STATUS_COPY.unreadable);
    });
  }, []);

  const editQuickName = useCallback((value: string) => {
    const name = value.trim().slice(0, 80);
    nameEditedRef.current = true;
    setNameLater(false);
    setNameText(value.slice(0, 80));
    setQuickName(name ? {
      name,
      source: 'user_corrected',
      confidence: quickName?.confidence ?? 0,
      confirmed: true,
      recognizedAt: quickName?.recognizedAt ?? new Date().toISOString(),
    } : null);
    // 지운 칸을 "입력하라"고 하지 않는다 — 이름 없이 저장하는 것도 정상 결과다 (FI-067).
    setOcrState(name ? QUICK_NAME_STATUS_COPY.confirmed : QUICK_NAME_STATUS_COPY.blank);
  }, [quickName]);

  /**
   * `모름 / 나중에` (FI-067). 잘못 읽힌 후보를 지우고, 이 촬영은 이름 없이 저장한다.
   * 진행 중인 인식 세션도 무효화해 나중에 도착한 OCR 결과가 이 선택을 덮어쓰지 않게 한다.
   */
  const markNameLater = useCallback(() => {
    ocrSessionRef.current += 1;
    nameEditedRef.current = true;
    setQuickName(null);
    setNameText('');
    setNameLater(true);
    setOcrState(QUICK_NAME_STATUS_COPY.later);
  }, []);

  const resetQuickName = useCallback(() => {
    ocrSessionRef.current += 1;
    nameEditedRef.current = false;
    setQuickName(null);
    setNameText('');
    setNameLater(false);
    setOcrState(QUICK_NAME_STATUS_COPY.idle);
  }, []);

  // 캡처 수정 화면의 재촬영도 앱 카메라를 쓴다 — 예전에는 OS 기본 카메라를 열어 갤러리에 사본이 생겼다.
  const applyRetakeFrame = useCallback(async (frame: CapturedCameraFrame) => {
    const dataB64 = frame.dataUrl.slice(frame.dataUrl.indexOf(',') + 1);
    const image = { name: queueRetakeSide, mime: 'image/jpeg' as const, dataB64 };
    const thumb = queueRetakeSide === 'front.jpg' ? await thumbnailOf(frame.dataUrl) : null;
    setQueueEdit((current) => current ? {
      ...current,
      ...(thumb !== null ? { thumb } : {}),
      images: [...current.images.filter((candidate) => candidate.name !== queueRetakeSide), image]
        .sort((a, b) => a.name.localeCompare(b.name)),
    } : null);
  }, [queueRetakeSide]);

  const handleCaptured = useCallback((side: CardSide, frame: CapturedCameraFrame, meta: CapturedSideMeta) => {
    if (retakeMode) {
      void applyRetakeFrame(frame);
      setMessage(`${queueRetakeSide === 'front.jpg' ? '앞면' : '뒷면'} 사진을 바꿨어요 — 저장하면 다시 보냅니다`);
      return;
    }
    if (side === 'front') {
      setFrontFrame(frame);
      startQuickNameOcr(frame);
    } else {
      setBackFrame(frame);
    }
    setMessage(captureToast(side, meta));
  }, [applyRetakeFrame, queueRetakeSide, retakeMode, startQuickNameOcr]);

  const closeCameraSession = useCallback(() => {
    setCameraSession(null);
    setRetakeMode(false);
  }, []);

  const completeCapture = useCallback(async () => {
    if (!frontFrame || queueing) return;
    setQueueing(true);
    try {
      const item = buildQueuedCapture(frontFrame, {
        backFrame,
        event,
        relSelf,
        relKairen,
        memo,
        researchInstruction: researchInstructionEnabled ? buildResearchInstruction(researchText) : null,
        quickName,
      });
      // 전송 후 원본이 정리돼도 목록에 남을 104px 썸네일 (legacy thumbOf).
      item.thumb = await thumbnailOf(frontFrame.dataUrl);
      // 저장했다고 말하기 전에 다시 읽어 사진이 온전한지 확인한다 (FI-032).
      // 이 확인을 통과하기 전에는 촬영 화면을 비우지 않는다 — 비우면 사진이 사라진다.
      await putQueueItemVerified(item);
      setQueue((current) => [item, ...current].sort((a, b) => b.captureId.localeCompare(a.captureId)));
      // 방금 저장한 이 촬영을 즉시 되돌리거나 다시 열 수 있게 기억한다 (FI-049).
      setLastSavedId(item.captureId);
      // 즉시 초기화해서 다음 명함을 바로 찍을 수 있게 — 만난 곳·관계·조사 지시는 2시간 유지, 메모만 비운다.
      // 메모는 이 사람 한 명에 대한 사실이므로 다음 사람에게 새어 나가면 안 된다 (FI-046).
      setFrontFrame(null);
      setBackFrame(null);
      setMemo('');
      resetQuickName();
      // 기기 저장이 확인된 시점의 사실만 말한다. 서버 접수는 아직 일어나지 않았다 (FI-031).
      setMessage(configured
        ? '이 폰에 저장했어요 — 이제 폰을 넣어도 됩니다. 전송은 알아서 이어갑니다.'
        : '이 폰에 저장했어요 — 이제 폰을 넣어도 됩니다. 연결되면 자동으로 전송합니다.');
      void contentRef.current?.scrollToTop(300);
      if (configured) void flushPendingQueue();
    } catch (error) {
      // 실패했을 때 촬영 화면은 그대로 남아 있다 — 다시 누르면 같은 사진으로 재시도된다.
      setMessage(error instanceof QueueWriteError
        ? queueWriteMessage[error.failure]
        : queueWriteMessage.unknown);
    } finally {
      setQueueing(false);
    }
  }, [backFrame, configured, event, flushPendingQueue, frontFrame, memo, queueing, quickName, relKairen, relSelf, researchInstructionEnabled, researchText, resetQuickName]);

  /**
   * 방금 찍은 촬영을 대기열에서 빼서 촬영 화면으로 되돌린다 (FI-049).
   *
   * 지우고 끝내지 않는다 — 사진·메모·이름 후보를 촬영 초안으로 그대로 되살려서, 다시 찍든
   * 그대로 다시 저장하든 사용자가 고를 수 있게 한다. 되돌리기가 성립하는지의 판정은
   * `takeBackQueueItem`이 전송 잠금 안에서 다시 읽어 결정한다.
   */
  const undoLastCapture = useCallback(async () => {
    // 다음 장을 이미 찍어 둔 상태에서는 되돌리지 않는다 — 되돌린 사진이 그 장을 덮어쓴다.
    if (!lastSavedId || undoing || frontFrame || cameraSession) return;
    setUndoing(true);
    try {
      const outcome = await takeBackQueueItem(lastSavedId);
      if (!outcome.item) {
        setMessage(undoRefusalMessage[outcome.refusal ?? 'missing']);
        await refresh(true).catch(() => undefined);
        return;
      }
      const draft = restoredDraftOf(outcome.item);
      setQueue((current) => current.filter((item) => item.captureId !== outcome.item?.captureId));
      setLastSavedId('');
      setFrontFrame(draft.front ? await storedCameraFrame(draft.front) : null);
      setBackFrame(draft.back ? await storedCameraFrame(draft.back) : null);
      setMemo(draft.memo);
      // 세션 공통 값은 지금 비어 있을 때만 되살린다 — 그 뒤에 새로 적은 값을 덮어쓰지 않는다.
      setEvent((value) => value || draft.event);
      setRelSelf((value) => value || draft.relSelf);
      setRelKairen((value) => value || draft.relKairen);
      if (draft.quickName?.name) {
        ocrSessionRef.current += 1;
        nameEditedRef.current = true;
        setQuickName(draft.quickName);
        setNameText(draft.quickName.name);
        setNameLater(false);
        setOcrState(QUICK_NAME_STATUS_COPY.confirmed);
      } else {
        resetQuickName();
      }
      setMessage('촬영 화면으로 되돌렸어요 — 지금은 이 폰에도 저장돼 있지 않으니, 남기려면 완료를 다시 눌러 주세요.');
    } catch (error) {
      setMessage(`되돌리지 못했어요: ${actionErrorMessage(error)}`);
    } finally {
      setUndoing(false);
    }
  }, [cameraSession, frontFrame, lastSavedId, refresh, resetQuickName, undoing]);

  // 누른 뒤 기기 저장·전송 시작까지 아무 반응이 없으면 사용자는 눌렸는지조차 알 수 없다.
  const retryQueueItem = useCallback(async (item: CaptureQueueItem) => {
    if (retryingId) return;
    setRetryingId(item.captureId);
    try {
      await putQueueItem({ ...item, state: 'queued', err: undefined });
      setQueue((current) => current.map((candidate) => candidate.captureId === item.captureId
        ? { ...candidate, state: 'queued', err: undefined }
        : candidate));
      if (configured) void flushPendingQueue(true);
      else setMessage('연결 설정을 저장하면 이 캡처를 자동으로 다시 보냅니다.');
    } catch (error) {
      setMessage(`다시 보내지 못했어요: ${actionErrorMessage(error)}`);
    } finally {
      setRetryingId('');
    }
  }, [configured, flushPendingQueue, retryingId]);

  const startRetake = useCallback((side: 'front.jpg' | 'back.jpg') => {
    setQueueRetakeSide(side);
    setRetakeMode(true);
    setCameraSession({ side: side === 'front.jpg' ? 'front' : 'back', withChoice: false });
  }, []);

  const saveQueueEdit = useCallback(async () => {
    if (!queueEdit || savingQueueEdit || !queueEdit.images.some((image) => image.dataB64)) return;
    const editRelSelf = queueEdit.relSelf?.trim() ?? '';
    const editRelKairen = queueEdit.relKairen?.trim() ?? '';
    const editMemo = queueEdit.memo?.trim() ?? '';
    const next: CaptureQueueItem = {
      ...queueEdit,
      event: queueEdit.event?.trim() ?? '',
      relSelf: editRelSelf,
      relKairen: editRelKairen,
      memo: editMemo,
      note: buildLegacyNote(editRelSelf, editRelKairen, editMemo),
      disp: editMemo || editRelSelf || editRelKairen,
      state: 'queued',
      err: undefined,
    };
    // 과거 캡처 편집은 현재 스티키 맥락을 건드리지 않는다 (legacy 동작).
    setSavingQueueEdit(true);
    try {
      await putQueueItem(next);
      setQueueEdit(null);
      await refresh(true).catch(() => undefined);
      if (configured) void flushPendingQueue(true);
      else setMessage('변경을 같은 captureId에 저장했습니다. 연결되면 다시 전송합니다.');
    } catch (error) {
      setMessage(error instanceof QueueWriteError ? queueWriteMessage[error.failure] : queueWriteMessage.unknown);
    } finally {
      setSavingQueueEdit(false);
    }
  }, [configured, flushPendingQueue, queueEdit, refresh, savingQueueEdit]);

  const toggleBrief = useCallback((captureId: string) => {
    setExpandedBriefs((current) => {
      const next = new Set(current);
      if (next.has(captureId)) next.delete(captureId);
      else next.add(captureId);
      return next;
    });
  }, []);

  const toggleRecords = useCallback(() => {
    setRecordsCollapsed((current) => {
      saveSectionCollapsed('briefs', !current);
      return !current;
    });
  }, []);

  const toggleContext = useCallback(() => {
    setContextCollapsed((current) => {
      saveSectionCollapsed('context', !current);
      return !current;
    });
  }, []);

  // 예시 chip은 입력을 지우지 않고 덧붙인다 — 이미 쓴 문장을 날리면 안 된다.
  const appendResearchExample = useCallback((value: string) => {
    setResearchText((current) => {
      const trimmed = current.trim();
      if (!trimmed) return value;
      if (trimmed.includes(value)) return current;
      return `${trimmed}, ${value}`;
    });
  }, []);

  const openDocument = useCallback(async (title: string, target: { id?: string; captureId?: string }, noteTarget: PersonTarget | null) => {
    if (!configured) return;
    setDocumentTitle(title);
    setDocumentBody('');
    setDocumentError('');
    setDocumentNoteTarget(noteTarget);
    setDocumentLoading(true);
    setDocumentOpen(true);
    try {
      const response = await loadPersonDocument(config, target);
      if (!response.ok) throw new Error(response.error ?? 'document_failed');
      setDocumentBody(response.markdown ?? '');
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      setDocumentError(code === 'owner_only' ? '소유자 토큰만 볼 수 있어요'
        : code === 'unknown_action' ? '서버 업데이트(GAS 재배포) 후 열려요'
          : `프로필을 불러오지 못했어요: ${actionErrorMessage(error)}`);
    } finally {
      setDocumentLoading(false);
    }
  }, [config, configured]);

  const runPersonAction = useCallback(async (request: Promise<{ ok: boolean; error?: string; receiptId?: string }>, success: string): Promise<boolean> => {
    try {
      const response = await request;
      if (!response.ok) throw new Error(response.error ?? 'request_failed');
      setMessage(response.receiptId ? `${success} · receipt ${response.receiptId}` : success);
      await refresh(true).catch(() => undefined);
      return true;
    } catch (error) {
      setMessage(`접수 실패: ${actionErrorMessage(error)}`);
      return false;
    }
  }, [refresh]);

  const promptNote = useCallback((target: PersonTarget) => {
    setPersonActionText('');
    setPersonActionComposer({ kind: 'note', target });
  }, []);

  const promptResearch = useCallback((target: PersonTarget) => {
    setPersonActionText('');
    setPersonActionComposer({ kind: 'research', target });
  }, []);

  const promptCorrection = useCallback((captureId: string) => {
    setPersonActionText('');
    setPersonActionComposer({ kind: 'correction', captureId });
  }, []);

  const closePersonActionComposer = useCallback(() => {
    if (personActionSubmitting) return;
    setPersonActionComposer(null);
    setPersonActionText('');
  }, [personActionSubmitting]);

  const submitPersonAction = useCallback(async () => {
    if (!personActionComposer || !personActionText.trim() || personActionSubmitting) return;
    setPersonActionSubmitting(true);
    let success = false;
    if (personActionComposer.kind === 'note') {
      success = await runPersonAction(addPersonNote(config, personActionComposer.target, personActionText.trim()), '메모를 저장했어요 — 잠시 후 인물 기록에 반영됩니다');
    } else if (personActionComposer.kind === 'research') {
      const submission = buildResearchInstruction(personActionText);
      if (!submission) {
        setMessage('조사할 내용을 조금 더 구체적으로 적어주세요');
      } else {
        success = await runPersonAction(submitResearchInstruction(config, personActionComposer.target, submission.raw), '조사 요청을 접수했어요');
      }
    } else {
      success = await runPersonAction(requestCorrection(config, personActionComposer.captureId, personActionText.trim()), '수정 요청을 보냈어요 — 다음 처리에서 확인합니다');
    }
    setPersonActionSubmitting(false);
    if (success) {
      setPersonActionComposer(null);
      setPersonActionText('');
    }
  }, [config, personActionComposer, personActionSubmitting, personActionText, runPersonAction]);

  const retryProcessing = useCallback(async (captureId: string) => {
    if (requeueingId) return;
    setRequeueingId(captureId);
    try {
      const response = await requeueCapture(config, captureId);
      if (!response.ok) throw new Error(response.error ?? 'requeue_failed');
      setMessage(response.alreadyTerminal
        ? (response.status === 'skipped' ? '이미 건너뜀으로 마감됐어요' : '이미 처리가 끝났어요 — 최신 상태로 바꿀게요')
        : response.deduped ? '이미 다시 처리 중이에요' : '다시 처리를 요청했어요 — 몇 분 안에 처리돼요');
      await refresh(true).catch(() => undefined);
    } catch (error) {
      setMessage(`재처리 실패: ${actionErrorMessage(error)}`);
    } finally {
      setRequeueingId('');
    }
  }, [config, refresh, requeueingId]);

  function renderQueueRow(item: CaptureQueueItem) {
    const imageSource = queueImageSource(item);
    const processedName = processedNames[item.captureId];
    // 이 행이 지금 회선을 타고 있는가 / 사용자가 방금 다시 보내기를 눌렀는가.
    const isSending = item.captureId === sendingId;
    const retrying = retryingId === item.captureId;
    // 이름을 모르는 것은 정상 결과다 — 끝난 인식을 `대기`로 적으면 거짓말이 된다 (FI-067).
    const displayName = queueRowName(processedName, item.quickName);
    const contextLine = queueContextLine(item);
    // 뒷면이 실제로 담겼는지 목록에서 바로 보이게 한다 — 예전에는 편집 화면을 열어야만 확인됐다.
    const sideLabel = queueNamedImageSource(item, 'back.jpg') ? '앞·뒷면' : '앞면';
    return (
      <article className="queue-row" key={item.captureId}>
        <button className="queue-row-main" type="button" onClick={() => setQueueEdit(normalizedQueueItem(structuredClone(item)))}>
          {imageSource ? <img src={imageSource} alt="명함 앞면 미리보기" /> : <span className="queue-placeholder"><Camera aria-hidden="true" size={18} /></span>}
          <div className="row-copy">
            <strong>{displayName}</strong>
            <span>{contextLine || formatMoment(item.capturedAt)} · {sideLabel} · {queueProgressOf(item).headline}</span>
            {/* 위 줄은 "이 촬영이 4단계 중 몇 번째에 있는가"라는 자리 표시다. 지금 실제로 회선을
                타고 있는 촬영은 이 줄이 따로 말한다 — 둘을 섞으면 다시 거짓 진행이 된다. */}
            {isSending && <small className="row-sending" role="status">지금 이 명함을 보내는 중…</small>}
            {item.err && !isSending && <small>{actionErrorMessage(item.err)}</small>}
          </div>
          <ChevronRight aria-hidden="true" size={16} />
        </button>
        {processedName && item.state !== 'failed' && (
          <button className="note-action" type="button" onClick={() => promptNote({ captureId: item.captureId })}><Plus aria-hidden="true" size={13} />메모</button>
        )}
        {item.state === 'failed' && (
          <button
            className="retry-action"
            type="button"
            aria-label="다시 보내기"
            aria-busy={retrying}
            disabled={retrying}
            onClick={() => void retryQueueItem(item)}
          >{retrying ? '보내는 중…' : '다시 보내기'}</button>
        )}
      </article>
    );
  }

  function renderBriefCard(item: BriefItem, local: CaptureQueueItem | null) {
    const expanded = expandedBriefs.has(item.captureId);
    const minutes = elapsedMinutesOf(item);
    const progress = captureProgress({ brief: item, queue: local, elapsedMinutes: minutes });
    const title = briefTitle(item);
    // 목록에는 "이름 — 한 줄 요약"을 보여 준다 (founder 판정 2026-07-26: 전부 "이런 분이에요"라 구분이 안 됨).
    const listTitle = briefListTitle(item);
    const contact = contactCardFromBrief(item, title.split(' — ')[0]);
    const briefBody = item.brief ? item.brief.split('\n').slice(1).join('\n') : '';
    const actionable = item.status === 'processed' && item.type !== 'note' && item.type !== 'research_instruction';
    const localContext = local ? queueContextLine(local) : '';
    return (
      <article className="brief-card" key={item.captureId}>
        <button className="brief-summary" type="button" onClick={() => toggleBrief(item.captureId)} aria-expanded={expanded}>
          <div className="avatar" aria-hidden="true">{listTitle.slice(0, 1)}</div>
          <div className="row-copy">
            <strong>{listTitle}</strong>
            <span>{formatMoment(item.receivedAt || item.capturedAt)}{item.event ? ` · ${item.event}` : ''}{item.capturer ? ` · 촬영 ${item.capturer}` : ''}</span>
          </div>
          <StatusBadge status={item.status} />
          <ChevronRight className={expanded ? 'expanded' : ''} aria-hidden="true" size={17} />
        </button>
        {!progress.done && (
          <div className={`stage-track ${progress.late ? 'late' : ''} ${progress.failed ? 'failed' : ''}`}>
            <div className="stage-head">
              <strong>{progress.headline}</strong>
              <span>{progress.detail}</span>
            </div>
            <ol className="stage-dots" aria-label={progress.headline}>
              {progress.stages.map((stage) => (
                <li key={stage.key} className={`stage-${stage.state}`}>
                  <i aria-hidden="true" />
                  <span>{stage.label}</span>
                </li>
              ))}
            </ol>
            {progress.late && (
              <div className="stage-actions">
                {/* 접근 이름은 고정한다 — 보이는 글자가 진행에 따라 바뀌어도 낭독기·자동화가 같은 버튼을 계속 가리킨다. */}
                <button
                  type="button"
                  aria-label="다시 처리 요청"
                  aria-busy={requeueingId === item.captureId}
                  disabled={requeueingId === item.captureId}
                  onClick={() => void retryProcessing(item.captureId)}
                ><RotateCcw aria-hidden="true" size={13} />{requeueingId === item.captureId ? '요청하는 중…' : '다시 처리 요청'}</button>
                <a href={`mailto:guecom90@gmail.com?subject=${encodeURIComponent(`[명함] 처리 지연 문의 ${item.captureId}`)}`}><Mail aria-hidden="true" size={13} />문의하기</a>
              </div>
            )}
          </div>
        )}
        {expanded && (
          <div className="brief-detail">
            {localContext && <p className="local-context">내 기록: {localContext}</p>}
            {briefBody ? <MarkdownLite text={briefBody} /> : <p>아직 브리핑 본문이 도착하지 않았습니다.</p>}
            {actionable && <ContactActions contact={contact} />}
            {actionable && item.person && (
              <ActionSection label="기록" className="record-actions">
                <button type="button" onClick={() => promptNote({ captureId: item.captureId })}><Plus aria-hidden="true" size={16} />메모 추가</button>
                {researchInstructionEnabled && <button className="ai-action" type="button" onClick={() => promptResearch({ captureId: item.captureId })}><Sparkles aria-hidden="true" size={16} />AI 조사 요청</button>}
              </ActionSection>
            )}
            {(item.person || actionable || local) && (
              <ActionSection label="관리" className="manage-actions">
                {item.person && ownerCanSeeAll && <button type="button" onClick={() => void openDocument(title.split(' — ')[0], { captureId: item.captureId }, { captureId: item.captureId })}><FileText aria-hidden="true" size={16} />전체 프로필</button>}
                {actionable && <button type="button" onClick={() => promptCorrection(item.captureId)}><MessageCircle aria-hidden="true" size={16} />수정 요청</button>}
                {local && <button type="button" onClick={() => setQueueEdit(normalizedQueueItem(structuredClone(local)))}><PenLine aria-hidden="true" size={16} />캡처 수정</button>}
              </ActionSection>
            )}
          </div>
        )}
      </article>
    );
  }

  function renderFeedEntry(entry: FeedEntry) {
    // 아직 전송 안 된(대기·실패) 로컬 항목은 대기 행으로 — 서버 브리핑이 있어도 재전송 중이면 로컬 상태가 우선.
    if (entry.local && entry.local.state !== 'sent') return renderQueueRow(entry.local);
    if (entry.brief) return renderBriefCard(entry.brief, entry.local ?? null);
    if (entry.local) return renderQueueRow(entry.local);
    return null;
  }

  function renderFeedBody() {
    const visible = feed.slice(0, feedLimit);
    return (
      <>
        {loading && feed.length === 0 && configured && <div className="center-state"><IonSpinner name="crescent" /><span>최신 상태 확인 중</span></div>}
        {feed.length === 0 && !(loading && configured) && <p className="section-empty">아직 명함 기록이 없어요. 명함을 찍으면 여기에 쌓여요.</p>}
        {visible.map(renderFeedEntry)}
        {(feed.length > feedLimit || hasMoreBriefs) && (
          <button
            className="load-more"
            type="button"
            ref={loadMoreRef}
            aria-busy={loadingMore}
            onClick={() => void loadMoreBriefs()}
          >
            {loadingMore ? '예전 기록 더 보기 — 불러오는 중…' : '예전 기록 더 보기'}
          </button>
        )}
        {/* 더 보기 결과를 낭독기에 알리고, 버튼이 사라질 때 포커스를 받아 준다. */}
        <p className="feed-more-status" role="status" tabIndex={-1} ref={feedStatusRef}>{feedMoreStatus}</p>
      </>
    );
  }

  // ── 캡처 탭: legacy 작업 화면 — 촬영·맥락·완료·명함 기록(통합)이 한 스크롤 ──
  function renderCapture() {
    return (
      <div className="cc-stack">
        {setupBannerMessage && (
          <section className="setup-banner" role="alert">
            <strong>링크 설정이 필요해요</strong>
            <p>{setupBannerMessage}</p>
          </section>
        )}

        <section className="surface-card capture-card">
          <div className="capture-head">
            <span className="capture-kicker">빠른 등록</span>
            <span className="capture-sub">사진 한 장이면 끝 — 정리·브리핑은 시스템이 해요</span>
          </div>

          {frontFrame ? (
            <button className="shot-main filled" type="button" onClick={() => setCameraSession({ side: 'front', withChoice: true })}>
              <img src={frontFrame.dataUrl} alt="앞면 미리보기" />
            </button>
          ) : (
            <button className="shot-main" type="button" onClick={() => setCameraSession({ side: 'front', withChoice: true })}>
              <span className="shot-icon" aria-hidden="true"><Camera size={24} /></span>
              <span>명함 앞면 촬영</span>
            </button>
          )}

          {frontFrame && (
            <section className="quick-name-panel inline" aria-live="polite">
              <div className="quick-name-top"><label htmlFor="quick-name-input">이름 먼저 확인</label><span role="status">{ocrState}</span></div>
              <IonInput id="quick-name-input" aria-label="이름 후보" value={nameText} placeholder="인식된 이름" onIonInput={(inputEvent) => editQuickName(String(inputEvent.detail.value ?? ''))} />
              {/* 모르는 것을 고를 수 있어야 정상 결과가 된다 — 빈칸을 숙제로 남겨 두지 않는다 (FI-067). */}
              <div className="quick-name-actions">
                <button type="button" className={nameLater ? 'on' : ''} aria-pressed={nameLater} onClick={markNameLater}>{QUICK_NAME_LATER_LABEL}</button>
              </div>
              <small>기기 안에서 먼저 읽어요. 틀리면 여기서 고치고, 모르면 비워 둬도 괜찮아요 — 사진과 만남 맥락으로 이어서 정리합니다.</small>
            </section>
          )}

          {frontFrame && (
            <div className="row2">
              <button className="shot-sub" type="button" onClick={() => setCameraSession({ side: 'back', withChoice: false })}>
                {backFrame ? <img src={backFrame.dataUrl} alt="뒷면 미리보기" /> : <span>뒷면 추가 <small>(선택)</small></span>}
              </button>
              <button className="shot-sub" type="button" onClick={() => setCameraSession({ side: 'front', withChoice: true })}><span>앞면 다시 찍기</span></button>
            </div>
          )}

          {/* 만남 맥락: 안내는 영역 위에 한 번만, 자주 쓰는 답은 chip으로, 입력이 생기면 한 줄로 접는다
              (INT-000015 Feedback item 001 — "시인성이 많이 떨어져서 아쉽다"). */}
          <section className="context-block">
            <button className="context-toggle" type="button" aria-expanded={!contextCollapsed} onClick={toggleContext}>
              <span className="context-toggle-copy">
                <span className="context-title-row">
                  <strong>만남 맥락</strong>
                  {/* 음성 입력은 실제로 가장 빠른 입력 수단인데 메모 placeholder 안에 묻혀 있었다
                      (founder 지시 2026-07-27: 처음에 잘 볼 수 있도록). */}
                  <span className="context-mic"><Mic aria-hidden="true" size={11} />키보드 마이크로 말해도 돼요</span>
                </span>
                <small>{contextSummary || '나중에 이 사람을 떠올릴 단서예요'}</small>
              </span>
              {contextFilled > 0 && <span className="context-count">{contextFilled}개</span>}
              <ChevronRight className={contextCollapsed ? '' : 'expanded'} aria-hidden="true" size={16} />
            </button>
            {!contextCollapsed && (
              <div className="capture-context-fields plain">
                <p className="context-note">만난 곳·관계·AI 조사 요청은 2시간 동안 그대로 남아요. 메모는 명함마다 새로 씁니다.</p>
                {/* Ionic의 stacked label은 입력 박스와 같은 회색조라 "여기가 쓰는 칸"이 안 읽혔다.
                    라벨을 밖으로 꺼내고 입력 박스에 흰 배경·테두리를 줘 글쓰기 칸임을 분명히 한다
                    (founder 판정 2026-07-27: "글쓰기 박스인지 구별이 안돼는 등 총체적 난국"). */}
                <div className="context-field">
                  <span className="context-label">어디서 만났나요?</span>
                  <IonInput aria-label="어디서 만났나요?" placeholder="예: 2026 스마트팩토리전 부스" value={event} onIonInput={(inputEvent) => setEvent(String(inputEvent.detail.value ?? ''))} />
                  <div className="context-chips" role="group" aria-label="만난 상황 예시">
                    {eventChips.map((chip) => (
                      <button key={chip} type="button" className={event === chip ? 'on' : ''} onClick={() => setEvent(toggleChipValue(event, chip))}>{chip}</button>
                    ))}
                  </div>
                </div>
                <div className="context-field">
                  <span className="context-label">Kairen과의 관계</span>
                  <IonInput aria-label="Kairen과의 관계" placeholder="예: 부품 공급사 담당자" value={relKairen} onIonInput={(inputEvent) => setRelKairen(String(inputEvent.detail.value ?? ''))} />
                  <div className="context-chips" role="group" aria-label="Kairen과의 관계 예시">
                    {KAIREN_RELATION_CHIPS.map((chip) => (
                      <button key={chip} type="button" className={relKairen === chip ? 'on' : ''} onClick={() => setRelKairen(toggleChipValue(relKairen, chip))}>{chip}</button>
                    ))}
                  </div>
                </div>
                <div className="context-field">
                  <span className="context-label">나와의 관계</span>
                  <IonInput aria-label="나와의 관계" placeholder="예: 대학 선배" value={relSelf} onIonInput={(inputEvent) => setRelSelf(String(inputEvent.detail.value ?? ''))} />
                  <div className="context-chips" role="group" aria-label="나와의 관계 예시">
                    {SELF_RELATION_CHIPS.map((chip) => (
                      <button key={chip} type="button" className={relSelf === chip ? 'on' : ''} onClick={() => setRelSelf(toggleChipValue(relSelf, chip))}>{chip}</button>
                    ))}
                  </div>
                </div>
                <div className="context-field">
                  <span className="context-label">메모</span>
                  <IonTextarea aria-label="메모" placeholder="예: 공장장님, 우리 부품에 관심 많으심" autoGrow value={memo} onIonInput={(inputEvent) => setMemo(String(inputEvent.detail.value ?? ''))} />
                </div>
              </div>
            )}
          </section>

          {/* 조사 지시는 메모가 아니라 AI에게 맡기는 일이다 — 표면·표식·단계를 그렇게 보이게 한다
              (INT-000015 Feedback item 002). 권한은 기존 owner-only public-research-v1 그대로다. */}
          {researchInstructionEnabled && (
            <AiSurface className="research-request" state={queueing ? 'active' : 'idle'}>
              <AiSurfaceHead title="AI 조사 요청" badge="소유자 전용" helper="묻기 껄끄럽지만 알아야 하는 것까지 맡기세요. 공개된 근거로 판단하고 확신도를 함께 적습니다." />
              <IonTextarea
                aria-label="AI 조사 요청"
                maxlength={2000}
                autoGrow
                placeholder={RESEARCH_PLACEHOLDER}
                value={researchText}
                onIonInput={(inputEvent) => setResearchText(String(inputEvent.detail.value ?? ''))}
              />
              <AiExampleChips examples={RESEARCH_EXAMPLE_CHIPS} onPick={appendResearchExample} label="조사 요청 예시" />
              <AiStageRail stages={researchStages('draft')} label="AI 조사 요청 진행 단계" />
              <AiScopeNote>{RESEARCH_SCOPE_DOES}</AiScopeNote>
              <AiScopeNote limit>{RESEARCH_SCOPE_LIMITS}</AiScopeNote>
            </AiSurface>
          )}

          <IonButton className="primary-action" expand="block" disabled={!frontFrame || queueing} onClick={() => void completeCapture()}>{queueing ? '저장 중…' : '완료'}</IonButton>
          <p className="hint">전파가 약해도 기기에 저장했다가 자동으로 다시 보내요.</p>

          {/* 방금 찍은 것을 즉시 되돌리거나 다시 열기 (FI-049). 서버가 이미 받은 촬영에는
              되돌리기를 내밀지 않는다 — 로컬에서 지워도 서버의 캡처는 사라지지 않는다. */}
          {showLastSaved && lastSavedItem && (
            <section className="last-saved" aria-label="방금 저장한 촬영">
              <div className="last-saved-copy">
                <strong>방금 저장 · {queueRowName(processedNames[lastSavedItem.captureId], lastSavedItem.quickName)}</strong>
                <small>{lastSavedUndoable
                  ? '아직 이 폰에만 있어요. 잘못 찍었으면 지금 되돌릴 수 있어요.'
                  : '서버가 이미 받아서 되돌릴 수 없어요. 내용은 다시 열어 고칠 수 있어요.'}</small>
              </div>
              <div className="last-saved-actions">
                {lastSavedUndoable && (
                  <button type="button" disabled={undoing} onClick={() => void undoLastCapture()}>
                    <RotateCcw aria-hidden="true" size={13} />{undoing ? '되돌리는 중…' : '되돌리기'}
                  </button>
                )}
                <button type="button" onClick={() => setQueueEdit(normalizedQueueItem(structuredClone(lastSavedItem)))}>
                  <PenLine aria-hidden="true" size={13} />다시 열기
                </button>
              </div>
            </section>
          )}
        </section>

        <div className="section-toggle-row">
          <button className="section-toggle" type="button" aria-expanded={!recordsCollapsed} onClick={toggleRecords}>
            <span className="caret" aria-hidden="true">{recordsCollapsed ? '▸' : '▾'}</span> 명함 기록
          </button>
          {/* 이 구획의 진실만 쓴다. 지금 올리는 촬영이 있을 때만, 그리고 그것이 무엇인지 이름을 붙여서. */}
          {sendingId && <span className="sending-note" role="status">{sendingName || '명함'} 전송 중…</span>}
          <span className="refresh-hint" role="status">{autoRefreshHint}</span>
        </div>
        {!recordsCollapsed && <div className="records-feed">{renderFeedBody()}</div>}
      </div>
    );
  }

  function renderActivity() {
    return (
      <div className="cc-stack">
        {!configured && <EmptyState title="연결 설정이 필요해요" body="받으신 개인 링크(?k=토큰 포함)로 접속하면 같은 진행 상태를 읽습니다." action="설정 열기" onAction={() => { setDraftConfig(config); setSettingsOpen(true); }} />}
        {/* FI-025: 손상 항목을 조용히 지우지도, 큐 전체를 막게 두지도 않는다. */}
        {damagedQueue.length > 0 && (
          <section className="surface-card damaged-card" role="status">
            <strong>보낼 수 없는 촬영 {damagedQueue.length}건</strong>
            <p>기기에 저장된 기록이 온전하지 않아 전송에서 제외했어요. <b>지우지 않고 그대로 두었습니다.</b> 나머지 촬영은 정상으로 전송됩니다.</p>
            <ul>
              {damagedQueue.slice(0, 5).map((entry) => (
                <li key={entry.captureId}><code>{entry.captureId}</code> <span>{entry.damage.map((reason) => damageLabels[reason]).join(' · ')}</span></li>
              ))}
            </ul>
            {damagedQueue.length > 5 && <small>외 {damagedQueue.length - 5}건</small>}
          </section>
        )}
        <div className="records-feed">{renderFeedBody()}</div>
      </div>
    );
  }

  // 근거 스니펫의 하이라이트. 이어 붙이면 원래 스니펫과 정확히 같다 — 글자를 더하거나 빼지 않는다.
  function renderEvidenceText(evidence: SearchEvidence) {
    return evidenceSegments(evidence).map((segment, index) => (
      segment.marked
        ? <mark key={`${index}-mark`}>{segment.text}</mark>
        : <span key={`${index}-plain`} className="evidence-plain">{segment.text}</span>
    ));
  }

  // 검색 결과 한 줄. "왜 이 사람이 나왔는지"를 함께 보여 준다 (FI-104).
  // 제목 일치는 이름 안의 맞은 구간을 그대로 표시하고, 본문 일치는 매칭 주변 짧은 스니펫을 붙인다.
  function renderPersonSearchRow(item: SearchItem) {
    const personId = (/PER-\d{6}/.exec(item.title) ?? [null])[0];
    const displayName = item.title.replace(/^PER-\d+\s*/, '');
    const nameEvidence = item.via === 'content' ? null : titleEvidence(displayName, searchTerm);
    const bodyEvidence = item.via === 'content' ? searchEvidence[item.id] ?? null : null;
    const looked = item.via === 'content' && Object.prototype.hasOwnProperty.call(searchEvidence, item.id);
    return (
      <button className="person-row" type="button" key={item.id} onClick={() => void openDocument(displayName, { id: item.id }, personId ? { person: personId } : null)}>
        <div className="avatar" aria-hidden="true">{displayName.slice(0, 1)}</div>
        <div className="row-copy">
          <strong>{nameEvidence ? renderEvidenceText(nameEvidence) : displayName}</strong>
          <span>{item.title.split(' ')[0]}{item.via === 'content' ? ' · 본문 일치' : ''}</span>
          {bodyEvidence && (
            <span className="search-evidence">
              {bodyEvidence.leadingGap ? '…' : ''}{renderEvidenceText(bodyEvidence)}{bodyEvidence.trailingGap ? '…' : ''}
            </span>
          )}
          {item.via === 'content' && !bodyEvidence && (
            <span className="search-evidence-note">
              {looked ? '근거로 보여 줄 수 있는 구간이 없어요 — 열어서 확인해 주세요' : '왜 맞았는지 확인하는 중…'}
            </span>
          )}
        </div>
        <ChevronRight aria-hidden="true" size={18} />
      </button>
    );
  }

  function renderRecallCard(candidate: RecallResult['candidates'][number]) {
    const name = briefTitle(candidate.item).split(' — ')[0];
    const met = formatMoment(candidate.item.receivedAt || candidate.item.capturedAt);
    const belongs = [candidate.item.contact?.title, candidate.item.contact?.organization].filter(Boolean).join(' · ');
    return (
      <article className={`recall-card${candidate.partial ? ' partial' : ''}`} key={candidate.item.captureId}>
        <button type="button" onClick={() => void openDocument(name, { captureId: candidate.item.captureId }, { captureId: candidate.item.captureId })}>
          <div className="avatar" aria-hidden="true">{name.slice(0, 1)}</div>
          <div className="row-copy">
            <strong>{name}</strong>
            <span>{belongs || met}{belongs ? ` · ${met}` : ''}</span>
          </div>
          <ChevronRight aria-hidden="true" size={18} />
        </button>
        <ul className="recall-evidence">
          {candidate.evidence.slice(0, 3).map((entry) => <li key={entry.label} data-kind={entry.kind}>{entry.label}</li>)}
        </ul>
      </article>
    );
  }

  // 회상 검색 결과: 후보마다 "왜 이 사람인지"를 근거로 붙인다. 근거 없는 추측은 만들지 않는다.
  // 결과는 정답 한 명이 아니라 근거 있는 후보 묶음이다 (INT-000015 Feedback item 004).
  function renderRecall() {
    const searchingNow = searching || recallSyncing;
    const progress = searchingNow && (
      // 진행 표면도 `AI 조사 요청`과 같은 문법을 쓴다 — 처리 중에는 움직임이 분명해진다 (INT-000016 항목 002).
      <AiSurface className="recall-progress" state="active">
        <AiStageRail stages={recallStages(recallStage, briefs.length)} label="AI 사람 찾기 진행 단계" />
        <div className="recall-progress-foot">
          <span>{recallStartedAt === null ? '' : `${elapsedLabel(clockTick - recallStartedAt)} 경과`}</span>
          {recallSyncing && <span className="recall-sync">최신 기록 확인 중</span>}
          <button type="button" onClick={cancelRecall}>중단</button>
        </div>
      </AiSurface>
    );

    if (!recallResult) {
      return (
        <>
          {progress}
          {!searchingNow && (
            <EmptyState
              title="기억나는 대로 말해 보세요"
              body="예: 지난주쯤 만난 한화 다니던 구매팀장 / 로보월드에서 만난 로봇 회사 대표. 문장은 이 기기 안에서만 대조하고 밖으로 보내지 않아요."
            />
          )}
        </>
      );
    }

    const { query: parsed, candidates, unmatchedTerms, searchedCount } = recallResult;
    const clues = appliedClueChips(parsed);
    const facets = candidates.length >= 3 ? recallFacets(candidates) : [];
    const shown = candidates.filter((candidate) => matchesFacet(candidate, recallFacet));
    const groups = groupRecallCandidates(shown.slice(0, recallLimit));
    return (
      <>
        {progress}
        <section className="recall-readback">
          <div className="recall-count">
            <strong>{candidates.length > 0 ? `후보 ${candidates.length}명` : '후보 없음'}</strong>
            <small>
              기록 {searchedCount}건 대조
              {recallFinishedMs === null ? '' : ` · ${elapsedLabel(recallFinishedMs)}`}
              {recallSyncing ? ' · 최신 기록 확인 중' : ''}
            </small>
          </div>
          {clues.length > 0 && (
            <div className="recall-clues" aria-label="적용된 단서">
              {clues.map((clue) => <span key={clue}>{clue}</span>)}
            </div>
          )}
          <p>{describeRecallQuery(parsed)}</p>
          {parsed.ignored.length > 0 && (
            <ul className="recall-ignored">
              {parsed.ignored.map((entry) => <li key={entry.text}>{entry.reason}</li>)}
            </ul>
          )}
          {unmatchedTerms.length > 0 && <small>{unmatchedTerms.map((term) => `'${term}'`).join(', ')}은(는) 어느 기록에서도 찾지 못했어요.</small>}
          <AiScopeNote>{RECALL_SCOPE_NOTE}</AiScopeNote>
        </section>
        {facets.length > 0 && (
          <div className="recall-facets" role="group" aria-label="후보 좁히기">
            <button type="button" className={recallFacet ? '' : 'on'} onClick={() => setRecallFacet(null)}>전체 {candidates.length}</button>
            {facets.map((facet) => (
              <button
                key={`${facet.kind}:${facet.value}`}
                type="button"
                className={recallFacet?.kind === facet.kind && recallFacet.value === facet.value ? 'on' : ''}
                onClick={() => setRecallFacet((current) => (current?.kind === facet.kind && current.value === facet.value ? null : facet))}
              >
                {facet.value} {facet.count}
              </button>
            ))}
          </div>
        )}
        {candidates.length === 0 && (
          <EmptyState
            title={searchedCount === 0 ? '이 기기에 아직 기록이 없어요' : '조건에 맞는 기록이 없어요'}
            body={searchedCount === 0
              ? '명함을 처리한 기록이 이 기기에 내려와야 대조할 수 있어요. 위 새로고침으로 기록을 먼저 받아 주세요.'
              : recallServerItems.length > 0
                ? '기기 기록에서는 못 찾아 전체 기록도 찾아봤어요. 아래 결과에는 만난 시점 정보가 없어요.'
                : '기억나는 다른 단서(회사·만난 곳·직함)를 덧붙이거나, 빠른 검색으로 이름을 직접 찾아보세요.'}
          />
        )}
        {groups.map((group) => (
          <section className="recall-group" key={group.tier}>
            <span className="recall-group-label">{group.label} {group.candidates.length}명</span>
            {group.candidates.map(renderRecallCard)}
          </section>
        ))}
        {shown.length > recallLimit && (
          <button className="load-more" type="button" onClick={() => setRecallLimit((current) => current + 15)}>
            후보 더 보기 ({shown.length - recallLimit}명)
          </button>
        )}
        {recallServerItems.length > 0 && (
          <section className="recall-fallback">
            <span>전체 기록 검색 결과 · 만난 시점 정보 없음</span>
            {recallServerItems.map(renderPersonSearchRow)}
          </section>
        )}
      </>
    );
  }

  function renderPeople() {
    const recall = searchMode === 'recall';
    const searchForm = (
      <form className="search-shell" onSubmit={submitSearch}>
        <Search aria-hidden="true" size={19} />
        <input
          value={query}
          onChange={(changeEvent) => setQuery(changeEvent.target.value)}
          placeholder={recall ? '예: 지난주쯤 만난 한화 다니던 사람' : '이름·회사·만난 곳으로 검색'}
          aria-label={recall ? '기억나는 대로 문장으로 찾기' : '이름·회사·만난 곳으로 검색'}
        />
        <button type="submit" disabled={!configured || !ownerCanSeeAll || searching}>{searching ? '찾는 중' : '찾기'}</button>
      </form>
    );
    return (
      <div className="cc-stack">
        <div className="mode-switch" role="tablist" aria-label="검색 방식">
          <button type="button" role="tab" aria-selected={!recall} className={recall ? '' : 'active'} onClick={() => setSearchMode('quick')}><Search aria-hidden="true" size={14} />빠른 검색</button>
          <button type="button" role="tab" aria-selected={recall} className={recall ? 'active' : ''} onClick={() => setSearchMode('recall')}><Sparkles aria-hidden="true" size={14} />AI 사람 찾기</button>
        </div>
        {/* AI 사람 찾기는 조사 요청과 같은 AI 표면 문법을 쓴다. 실제로 찾는 중이 아니어도 표면은
            은은하게 살아 있고, 찾는 동안 그 움직임이 분명해진다 (INT-000016 항목 002). */}
        {recall ? (
          <AiSurface className="recall-request" state={searching || recallSyncing ? 'active' : 'idle'}>
            <AiSurfaceHead title="AI 사람 찾기" badge="기기 안에서 대조" helper="이름이 기억나지 않아도 괜찮아요. 언제·어디서·어떤 사람이었는지 문장으로 적어 주세요." />
            {searchForm}
          </AiSurface>
        ) : searchForm}
        {recentSearches.length > 0 && (
          <div className="recent-searches" aria-label="최근 검색">
            {recentSearches.map((value) => (
              <button key={value} type="button" onClick={() => { setQuery(value); void (recall ? runRecall(value) : runSearch(value)); }}><Search aria-hidden="true" size={12} />{value}</button>
            ))}
          </div>
        )}
        {(!configured || !ownerCanSeeAll) && <EmptyState title="소유자 연결이 필요해요" body="Person 검색은 기존과 동일하게 owner token에서만 동작합니다." action="설정 열기" onAction={() => { setDraftConfig(config); setSettingsOpen(true); }} />}
        {/* 빠른 검색도 왕복이 있는 일이다. 버튼 글자만 바뀌면 결과 자리는 예전 화면 그대로라
            "눌린 건가?"가 남는다. 여기서 진행을 결과 자리에 둔다 — 진행률은 알 수 없으므로
            지어내지 않고, 무엇을 찾는 중인지와 얼마나 지났는지만 말한다. */}
        {configured && ownerCanSeeAll && !recall && searching && (
          <section className="search-progress" role="status">
            <IonSpinner name="crescent" />
            <div>
              <strong>‘{searchTerm}’ 를 기록 전체에서 찾는 중</strong>
              <small>
                {searchStartedAt === null ? '' : `${elapsedLabel(clockTick - searchStartedAt)} 경과 · `}
                이름·회사·만난 곳과 기록 본문을 함께 봅니다
              </small>
            </div>
          </section>
        )}
        {configured && ownerCanSeeAll && !recall && searchResults.length === 0 && !searching && <EmptyState title="찾을 사람을 입력하세요" body="미팅 전 10초 회상 — 이름·회사·만난 곳으로 기존 기록을 찾습니다." />}
        {configured && ownerCanSeeAll && !recall && searchResults.map(renderPersonSearchRow)}
        {configured && ownerCanSeeAll && recall && renderRecall()}
      </div>
    );
  }

  function renderSettings() {
    return (
      <div className="cc-stack">
        <section className="surface-card settings-summary">
          <div><span>사용자</span><strong>{config.capturer || '이름을 입력해 주세요'}</strong></div>
          <div><span>명함 연결</span><strong>{configured ? '연결됨' : (config.token ? '연결 주소 확인 필요' : '개인 링크로 접속해 주세요')}</strong></div>
          <div><span>개인 링크</span><strong>{config.token ? '이 기기에 저장됨' : '아직 저장되지 않음'}</strong></div>
          <IonButton fill="outline" expand="block" onClick={() => { setDraftConfig(config); setAdvancedOpen(false); setSettingsOpen(true); }}>사용자·연결 정보 편집</IonButton>
        </section>
        {/* INT-000016 항목 003: 시스템 자동 추종만으로는 부족하다 — 직접 고르고, 고른 값은 이 기기에 남는다. */}
        <section className="surface-card theme-card">
          <div className="theme-head"><SunMoon aria-hidden="true" size={17} /><strong>화면 테마</strong></div>
          <p>어두운 곳에서는 다크로 바꿔 보세요. 고른 값은 이 기기에 저장돼요.</p>
          <div className="theme-choice" role="radiogroup" aria-label="화면 테마">
            {THEME_CHOICES.map((choice) => (
              <button
                key={choice.value}
                type="button"
                role="radio"
                aria-checked={theme === choice.value}
                className={theme === choice.value ? 'on' : ''}
                onClick={() => { setTheme(choice.value); saveThemePreference(choice.value); }}
              >
                <strong>{choice.label}</strong>
                <small>{choice.hint}</small>
              </button>
            ))}
          </div>
          <small className="theme-foot">
            지금 보이는 화면은 <b>{resolvedTheme === 'dark' ? '다크' : '라이트'}</b>예요{theme === 'system' ? ' — 폰 설정을 따라갑니다.' : '.'}
          </small>
        </section>
        {/* founder 판정 2026-07-28: "여전히 하이라이팅이 안 나옴".
            폰이 `움직임 최소화`를 켜고 있으면 AI 표면의 빛은 한 픽셀도 그려지지 않는다(실측 확인).
            그건 존중이지만 **말없이 사라지면 고장으로 읽힌다** — 지금 상태를 적고, 직접 켤 수 있게 한다. */}
        <section className="surface-card theme-card">
          <div className="theme-head"><Waves aria-hidden="true" size={17} /><strong>화면 움직임</strong></div>
          <p>AI가 맡은 자리(<b>AI 조사 요청</b>·<b>AI 사람 찾기</b>)는 평소에도 은은한 빛이 지나갑니다. 고른 값은 이 기기에 저장돼요.</p>
          <div className="theme-choice" role="radiogroup" aria-label="화면 움직임">
            {MOTION_CHOICES.map((choice) => (
              <button
                key={choice.value}
                type="button"
                role="radio"
                aria-checked={motion === choice.value}
                className={motion === choice.value ? 'on' : ''}
                onClick={() => { setMotion(choice.value); saveMotionPreference(choice.value); }}
              >
                <strong>{choice.label}</strong>
                <small>{choice.hint}</small>
              </button>
            ))}
          </div>
          <small className="theme-foot">
            지금은 <b>{resolvedMotion === 'on' ? '움직이는 중' : '멈춰 있음'}</b>이에요
            {motion === 'system'
              ? (osPrefersReducedMotion
                ? ' — 이 폰이 움직임 최소화를 켜 두어서 빛이 멈춰 있습니다. 여기서 켜기를 고르면 앱에서만 다시 움직여요.'
                : ' — 폰 설정을 따라갑니다.')
              : '.'}
          </small>
        </section>
        {/* ISS-000102: 갤러리 사본은 OS 기본 카메라 앱만 만든다. 지울 수 없는 것을 지운다고 말하지 않는다. */}
        <section className="surface-card gallery-card">
          <div className="gallery-head"><ImageOff aria-hidden="true" size={17} /><strong>명함 사진과 갤러리</strong></div>
          <p>카이렌 카메라로 찍은 명함은 <b>휴대폰 갤러리에 저장되지 않아요.</b> 앱 안에만 두었다가 전송이 확인되면 10분 뒤 원본을 지우고 목록용 작은 썸네일만 남깁니다.</p>
          <label className="gallery-toggle">
            <input
              type="checkbox"
              checked={galleryFree}
              onChange={(changeEvent) => { const next = changeEvent.target.checked; setGalleryFree(next); saveGalleryFree(next); }}
            />
            <span>
              <strong>기본 카메라 앱 쓰지 않기</strong>
              <small>{galleryFree
                ? '켜짐 — 촬영 화면에서 기본 카메라 앱 버튼을 숨깁니다. 카메라가 열리지 않는 기기에서는 예외로 보여 줘요.'
                : '꺼짐 — 기본 카메라 앱으로도 찍을 수 있어요. 그 사진은 갤러리에 남고 카이렌이 지울 수 없습니다.'}</small>
            </span>
          </label>
          <small className="gallery-foot">이미 갤러리에 쌓인 사진은 앱이 지울 수 없어요 — 휴대폰 갤러리에서 직접 지워 주세요.</small>
        </section>
        <section className="boundary-note">
          <ShieldCheck aria-hidden="true" size={20} />
          <div>
            <strong>개인 링크 정보는 이 기기에만 저장돼요.</strong>
            <p>연결 정보는 저장소나 로그에 넣지 않습니다. 연결에 문제가 있을 때만 고급 설정에서 직접 확인하세요.</p>
            {/* FI-004·005: 어디로 보내지는지와, 주소창에서 코드를 지웠다는 사실을 그대로 말한다. */}
            <p className="boundary-origin">명함과 개인 링크 코드는 <b>{trustedApiHost}</b> 로만 전송돼요. 다른 주소를 붙인 링크는 무시합니다.</p>
            <p className="boundary-origin">개인 링크로 열면 주소창의 코드를 <b>즉시 지웁니다</b> — 방문 기록·화면 공유에 남지 않아요.</p>
          </div>
        </section>
        {/* FI-007: 폰을 넘기거나 링크를 회수할 때 이 기기의 사본을 끊는 경로. */}
        <section className="surface-card signout-card">
          <div className="signout-head"><strong>이 기기에서 연결 해제</strong></div>
          <p>개인 링크 코드와 이 기기에 저장된 브리핑 사본·검색 기록·만남 맥락을 지웁니다. <b>전송을 기다리는 촬영은 지우지 않아요.</b></p>
          <IonButton fill="outline" color="danger" expand="block" disabled={!config.token} onClick={() => setSignOutOpen(true)}>연결 해제</IonButton>
        </section>
        <a className="legacy-link" href="../legacy.html">문제가 있을 때 이전 앱 열기 <ArrowUpRight aria-hidden="true" size={16} /></a>
        {/* 두 값은 서로 다른 일을 한다. 버전은 사람이 말하기 위한 것이고(“2.12.0 쓰고 있어요”),
            소스 식별자는 그 화면이 정확히 어느 소스에서 나왔는지 저장소에서 다시 계산해 대조하기
            위한 것이다. 하나만으로는 문제를 알릴 수도, 확인할 수도 없다. */}
        <p className="build-line">버전 {APP_VERSION} · 빌드 {__CARD_CAPTURE_BUILD_ID__}</p>
        <p className="build-note">문제를 알리실 때 이 두 줄을 함께 알려 주세요. 버전은 이 앱이 나온 릴리즈 이름이고, 빌드는 그 화면을 만든 소스를 가리킵니다.</p>
      </div>
    );
  }

  return (
    <IonApp>
      <IonPage>
        <IonHeader translucent>
          <IonToolbar>
            <div className="app-header">
              <span className="brand-mark" aria-hidden="true">K</span>
              <span className="app-header-copy">
                <b>{screenTitles[tab]}</b>
                <small role="status">{headerStatus}</small>
              </span>
              {tab !== 'settings' && (
                <button className="header-refresh" type="button" aria-label="최신 상태 확인" aria-busy={loading} onClick={() => void manualRefresh()}>
                  <RefreshCw className={loading ? 'spinning' : ''} aria-hidden="true" size={17} />
                </button>
              )}
            </div>
          </IonToolbar>
        </IonHeader>
        <IonContent ref={contentRef} fullscreen>
          <main id="kairen-ui" className="candidate-shell">
            {tab === 'capture' && renderCapture()}
            {tab === 'activity' && renderActivity()}
            {tab === 'people' && renderPeople()}
            {tab === 'settings' && renderSettings()}
          </main>
        </IonContent>
        <IonFooter className="tab-footer">
          <IonToolbar>
            <nav className="tab-bar" aria-label="주요 화면">
              {tabs.map((item) => {
                const Icon = item.icon;
                return <button key={item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}><Icon aria-hidden="true" size={20} /><span>{item.label}</span></button>;
              })}
            </nav>
          </IonToolbar>
        </IonFooter>

        {/* 첫 실행 온보딩: legacy처럼 이름만 묻는다 — 토큰은 개인 링크가 자동 저장 (ISS-000091 항목 17) */}
        <IonModal className="name-onboard-modal" isOpen={nameOnboardOpen} backdropDismiss={false} onDidDismiss={() => setNameOnboardOpen(false)}>
          <IonContent className="ion-padding">
            <div className="name-onboard">
              <h3>처음 오셨네요 👋</h3>
              <p>캡처한 명함에 "누가 찍었는지"를 남기기 위해 이름이 필요해요. 한 번만 입력하면 기억합니다.</p>
              <IonInput aria-label="이름" placeholder="이름" autocomplete="name" value={nameDraft} onIonInput={(inputEvent) => setNameDraft(String(inputEvent.detail.value ?? ''))} />
              <IonButton expand="block" disabled={!nameDraft.trim()} onClick={commitOnboardName}>시작하기</IonButton>
            </div>
          </IonContent>
        </IonModal>

        {/* FI-007: 되돌릴 수 없는 정리 전에 무엇이 지워지고 무엇이 남는지 정확히 보여 준다. */}
        <IonModal className="signout-modal" isOpen={signOutOpen} onDidDismiss={() => setSignOutOpen(false)} initialBreakpoint={0.55} breakpoints={[0, 0.55]}>
          <IonHeader><IonToolbar><IonTitle>이 기기에서 연결 해제</IonTitle><IonButton slot="end" fill="clear" onClick={() => setSignOutOpen(false)}>취소</IonButton></IonToolbar></IonHeader>
          <IonContent className="ion-padding">
            <div className="signout-confirm">
              <p><b>지웁니다</b> — 개인 링크 코드, 촬영자 이름, 이 기기에 저장된 브리핑 사본, 최근 검색어, 만남 맥락.</p>
              <p><b>남깁니다</b> — 전송을 기다리는 촬영 원본. 서버에 이미 접수된 기록.</p>
              {unsentCount > 0 && (
                <p className="signout-warning" role="alert">
                  아직 전송되지 않은 촬영이 <b>{unsentCount}건</b> 있어요. 연결을 해제하면 이 기기에서 전송할 수 없으니, 먼저 전송을 끝내는 걸 권합니다.
                </p>
              )}
              <IonButton expand="block" color="danger" onClick={commitSignOut}>연결 해제하기</IonButton>
              <IonButton expand="block" fill="clear" onClick={() => setSignOutOpen(false)}>그대로 두기</IonButton>
            </div>
          </IonContent>
        </IonModal>

        <IonModal isOpen={settingsOpen} onDidDismiss={() => setSettingsOpen(false)} initialBreakpoint={0.78} breakpoints={[0, 0.78, 1]}>
          <IonHeader><IonToolbar><IonTitle>사용자·연결 정보</IonTitle><IonButton slot="end" fill="clear" onClick={() => setSettingsOpen(false)}>닫기</IonButton></IonToolbar></IonHeader>
          <IonContent className="ion-padding">
            <IonList inset>
              <IonItem><IonInput label="촬영자 이름" labelPlacement="stacked" value={draftConfig.capturer} onIonInput={(inputEvent) => setDraftConfig((value) => ({ ...value, capturer: String(inputEvent.detail.value ?? '') }))} /></IonItem>
            </IonList>
            <p className="modal-copy">개인 링크로 접속하면 연결 정보가 자동으로 입력됩니다. 평소에는 사용자 이름만 바꾸면 됩니다.</p>
            <button className="advanced-toggle" type="button" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((value) => !value)}>{advancedOpen ? '▾' : '▸'} 고급 설정</button>
            {advancedOpen && (
              <IonList inset>
                {apiEndpointEditable ? (
                  <IonItem><IonInput label="연결 주소 (GAS API)" labelPlacement="stacked" type="url" value={draftConfig.apiUrl} onIonInput={(inputEvent) => setDraftConfig((value) => ({ ...value, apiUrl: String(inputEvent.detail.value ?? '') }))} /></IonItem>
                ) : (
                  // 배포본에서는 읽기 전용이다 — 숨기지는 않는다. "지금 어디에 연결돼 있는가"는
                  // 사용자가 알 권리다 (Kairen-Ref: TSK-000302).
                  // `IonInput`(한 줄 <input>)이 아니라 `IonTextarea`를 쓰는 이유: Apps Script 배포본
                  // 주소는 100자가 넘어 한 줄 칸에는 앞 1/3만 보이고, 읽기 전용 칸에서 나머지를
                  // 확인하려면 폰에서 칸 안을 문질러 스크롤해야 한다. 그러면 "계속 보여 준다"가 거짓이 된다.
                  // `readonly` + `helperText`는 두 컴포넌트가 같은 방식으로 처리한다 — 낭독기는 읽기 전용
                  // 상태를 읽고, `helperText`는 Ionic이 `aria-describedby`로 이어 준다.
                  <IonItem className="api-endpoint-locked"><IonTextarea label="연결 주소 (GAS API)" labelPlacement="stacked" readonly autoGrow rows={1} value={draftConfig.apiUrl} helperText={API_ENDPOINT_LOCK_NOTE} /></IonItem>
                )}
                <IonItem><IonInput label="개인 링크 코드 (?k= 값)" labelPlacement="stacked" type="password" value={draftConfig.token} onIonInput={(inputEvent) => setDraftConfig((value) => ({ ...value, token: String(inputEvent.detail.value ?? '') }))} /></IonItem>
              </IonList>
            )}
            <IonButton expand="block" disabled={!draftConfig.capturer.trim()} onClick={commitSettings}>설정 저장</IonButton>
          </IonContent>
        </IonModal>
        <IonModal className="person-action-modal" isOpen={Boolean(personActionComposer)} onDidDismiss={closePersonActionComposer} initialBreakpoint={personActionComposer?.kind === 'research' ? 0.92 : 0.62} breakpoints={[0, 0.62, 0.92]}>
          {personActionComposer && (
            <>
              <IonHeader><IonToolbar><IonTitle>{personActionCopy[personActionComposer.kind].title}</IonTitle><IonButton slot="end" fill="clear" disabled={personActionSubmitting} onClick={closePersonActionComposer}>취소</IonButton></IonToolbar></IonHeader>
              <IonContent className="ion-padding">
                <div className="person-action-composer">
                  {personActionComposer.kind === 'research' ? (
                    // 같은 AI 표면·표식·단계를 캡처 화면과 인물 카드에서 그대로 쓴다 (INT-000015 항목 002).
                    <AiSurface className="research-request" state={personActionSubmitting ? 'active' : 'idle'}>
                      <AiSurfaceHead title="AI 조사 요청" badge="소유자 전용" helper={personActionCopy.research.helper} />
                      <IonTextarea aria-label="AI 조사 요청" autofocus autoGrow maxlength={2000} placeholder={personActionCopy.research.placeholder} value={personActionText} onIonInput={(inputEvent) => setPersonActionText(String(inputEvent.detail.value ?? ''))} />
                      <AiExampleChips examples={RESEARCH_EXAMPLE_CHIPS} onPick={(value) => setPersonActionText((current) => (current.trim() ? (current.includes(value) ? current : `${current.trim()}, ${value}`) : value))} label="조사 요청 예시" />
                      <AiStageRail stages={researchStages(personActionSubmitting ? 'received' : 'draft')} label="AI 조사 요청 진행 단계" />
                      <AiScopeNote>{RESEARCH_SCOPE_DOES}</AiScopeNote>
                      <AiScopeNote limit>{RESEARCH_SCOPE_LIMITS}</AiScopeNote>
                    </AiSurface>
                  ) : (
                    <>
                      <span className="eyebrow">{personActionCopy[personActionComposer.kind].eyebrow}</span>
                      <p>{personActionCopy[personActionComposer.kind].helper}</p>
                      <IonTextarea aria-label={personActionCopy[personActionComposer.kind].title} autofocus autoGrow maxlength={2000} label={personActionCopy[personActionComposer.kind].title} labelPlacement="stacked" placeholder={personActionCopy[personActionComposer.kind].placeholder} value={personActionText} onIonInput={(inputEvent) => setPersonActionText(String(inputEvent.detail.value ?? ''))} />
                    </>
                  )}
                  {/* 접수 버튼은 시트 아래에 고정한다 — 예시 chip이 늘어나도 화면 밖으로 밀리면 안 된다. */}
                  <div className="person-action-submit">
                    <small>{personActionText.length.toLocaleString()} / 2,000</small>
                    <IonButton expand="block" disabled={!personActionText.trim() || personActionSubmitting} onClick={() => void submitPersonAction()}>{personActionSubmitting ? '접수 중…' : personActionCopy[personActionComposer.kind].submit}</IonButton>
                  </div>
                </div>
              </IonContent>
            </>
          )}
        </IonModal>
        <IonModal isOpen={documentOpen} onDidDismiss={() => setDocumentOpen(false)}>
          <IonHeader><IonToolbar><IonTitle>{documentTitle}</IonTitle><IonButton slot="end" fill="clear" onClick={() => setDocumentOpen(false)}>닫기</IonButton></IonToolbar></IonHeader>
          <IonContent className="ion-padding profile-document">
            {documentLoading && <div className="center-state"><IonSpinner name="crescent" /><span>프로필 불러오는 중</span></div>}
            {!documentLoading && documentError && <p className="document-error">{documentError}</p>}
            {!documentLoading && !documentError && (
              <PersonDocument
                markdown={documentBody}
                fallbackName={documentTitle}
                noteTarget={documentNoteTarget}
                canResearch={researchInstructionEnabled}
                onNote={promptNote}
                onResearch={promptResearch}
              />
            )}
          </IonContent>
        </IonModal>
        <IonModal isOpen={Boolean(queueEdit)} onDidDismiss={() => setQueueEdit(null)}>
          <IonHeader><IonToolbar><IonTitle>캡처 상세</IonTitle><IonButton slot="end" fill="clear" onClick={() => setQueueEdit(null)}>닫기</IonButton></IonToolbar></IonHeader>
          <IonContent className="ion-padding queue-edit-modal">
            {queueEdit && (
              <>
                <div className="queue-edit-images">
                  <div>{queueNamedImageSource(queueEdit, 'front.jpg') ? <img src={queueNamedImageSource(queueEdit, 'front.jpg')} alt="편집할 명함 앞면" /> : <span>앞면 원본 없음</span>}<button type="button" onClick={() => startRetake('front.jpg')}>앞면 다시 찍기</button></div>
                  <div>{queueNamedImageSource(queueEdit, 'back.jpg') ? <img src={queueNamedImageSource(queueEdit, 'back.jpg')} alt="편집할 명함 뒷면" /> : <span>뒷면 없음</span>}<button type="button" onClick={() => startRetake('back.jpg')}>{queueNamedImageSource(queueEdit, 'back.jpg') ? '뒷면 다시 찍기' : '뒷면 추가'}</button></div>
                </div>
                <section className="capture-context-fields light">
                  <IonInput label="어디서 만났는지" labelPlacement="stacked" value={queueEdit.event ?? ''} onIonInput={(inputEvent) => setQueueEdit((current) => current ? { ...current, event: String(inputEvent.detail.value ?? '') } : null)} />
                  <IonInput label="나와 이 사람과의 관계" labelPlacement="stacked" value={queueEdit.relSelf ?? ''} onIonInput={(inputEvent) => setQueueEdit((current) => current ? { ...current, relSelf: String(inputEvent.detail.value ?? '') } : null)} />
                  <IonInput label="Kairen과 이 사람과의 관계" labelPlacement="stacked" value={queueEdit.relKairen ?? ''} onIonInput={(inputEvent) => setQueueEdit((current) => current ? { ...current, relKairen: String(inputEvent.detail.value ?? '') } : null)} />
                  <IonTextarea label="메모" labelPlacement="stacked" autoGrow value={queueEdit.memo ?? ''} onIonInput={(inputEvent) => setQueueEdit((current) => current ? { ...current, memo: String(inputEvent.detail.value ?? '') } : null)} />
                </section>
                {!queueEdit.images.some((image) => image.dataB64) && <p className="modal-copy">오래된 전송 완료 캡처라 원본 사진이 정리됐습니다. 앞면을 다시 찍으면 같은 captureId로 재전송할 수 있습니다.</p>}
                <IonButton expand="block" disabled={savingQueueEdit || !queueEdit.images.some((image) => image.dataB64)} onClick={() => void saveQueueEdit()}>{savingQueueEdit ? '저장하는 중…' : '저장하고 다시 보내기'}</IonButton>
              </>
            )}
          </IonContent>
        </IonModal>
        <IonToast isOpen={Boolean(message)} message={message} duration={2600} position="top" onDidDismiss={() => setMessage('')} />
        <CameraCaptureModal
          isOpen={Boolean(cameraSession)}
          initialSide={cameraSession?.side ?? 'front'}
          withBackChoice={cameraSession?.withChoice ?? false}
          galleryFree={galleryFree}
          onDismiss={closeCameraSession}
          onCaptured={handleCaptured}
          onFinished={closeCameraSession}
        />
      </IonPage>
    </IonApp>
  );
}

function EmptyState({ title, body, action, onAction }: { title: string; body: string; action?: string; onAction?: () => void }) {
  return <section className="empty-state"><span className="empty-icon"><ShieldCheck aria-hidden="true" size={23} /></span><h2>{title}</h2><p>{body}</p>{action && onAction && <button onClick={onAction}>{action}</button>}</section>;
}

export default App;
