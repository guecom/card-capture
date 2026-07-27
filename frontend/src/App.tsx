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
import { ArrowUpRight, Camera, ChevronRight, FileText, ImageOff, Mail, MessageCircle, Mic, PenLine, Plus, RefreshCw, RotateCcw, Search, Settings2, ShieldCheck, Sparkles, Waves } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BriefItem, CaptureQueueItem, PersonTarget, QuickName, RuntimeConfig, SearchItem } from './contracts/capture';
import { CameraCaptureModal, type CapturedSideMeta, type CardSide } from './components/CameraPreviewModal';
import { StatusBadge } from './components/StatusBadge';
import { MarkdownLite } from './components/MarkdownLite';
import { ActionSection, ContactActions, PersonDocument } from './components/PersonDocument';
import { AiExampleChips, AiScopeNote, AiStageRail, AiSurface, AiSurfaceHead } from './components/AiTaskSurface';
import { addPersonNote, listBriefs, loadPersonDocument, requeueCapture, requestCorrection, searchPeople, submitResearchInstruction, uploadCapture } from './services/api';
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
import { type CapturedCameraFrame, thumbnailOf } from './services/camera';
import {
  captureContextFilled,
  captureContextSummary,
  eventChips as buildEventChips,
  KAIREN_RELATION_CHIPS,
  SELF_RELATION_CHIPS,
  toggleChipValue,
} from './services/capture-context';
import { buildLegacyNote, buildQueuedCapture, parseLegacyNote } from './services/capture-item';
import { actionErrorMessage, briefListTitle, briefNameMap, briefTitle, elapsedMinutesOf } from './services/brief-view';
import { captureProgress, refreshHint } from './services/capture-progress';
import { contactCardFromBrief } from './services/contacts';
import { getOpenCvWorker, prefetchOpenCv } from './services/opencv';
import { prefetchQuickOcrAssets } from './services/paddle-quickname';
import { flushQueue, pruneSentQueue, putQueueItem, readQueue } from './services/queue';
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
  saveCachedBriefs,
  saveGalleryFree,
  saveOwnerFlags,
  saveRecentSearch,
  saveRuntimeConfig,
  saveSectionCollapsed,
  saveStickyCaptureContext,
  signOutDevice,
} from './services/storage';
import { apiRejectionMessage } from './services/api-origin';
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

// 자동 새로고침 주기. 화면에 남은 시간을 그대로 보여 주므로 사용자가 주기를 알 수 있다.
const AUTO_REFRESH_MS = 20_000;

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

// boot에서 딱 한 번: 신뢰 판정 → subject namespace 결정 → 주소창 정리 (FI-004·005·006).
// 사적 캐시를 읽는 useState 초기값보다 반드시 먼저 끝나야 한다.
const boot = loadRuntimeConfigDetailed();
if (boot.scrubUrl) scrubCredentialParams();

function App() {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [config, setConfig] = useState<RuntimeConfig>(boot.config);
  const [draftConfig, setDraftConfig] = useState<RuntimeConfig>(config);
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [briefs, setBriefs] = useState<BriefItem[]>(loadCachedBriefs);
  const [queue, setQueue] = useState<CaptureQueueItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [nameOnboardOpen, setNameOnboardOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchItem[]>([]);
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
  const [sending, setSending] = useState(false);
  // owner 게이트는 legacy처럼 localStorage 캐시로 시작해 서버 응답으로 갱신한다 — 오프라인에도 유지.
  const [ownerCanSeeAll, setOwnerCanSeeAll] = useState(() => loadOwnerFlags().seeAll);
  const [researchInstructionEnabled, setResearchInstructionEnabled] = useState(() => {
    const flags = loadOwnerFlags();
    return flags.seeAll && flags.researchInstructionEnabled;
  });
  const [listLimit, setListLimit] = useState(30);
  const [hasMoreBriefs, setHasMoreBriefs] = useState(false);
  const [feedLimit, setFeedLimit] = useState(30);
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
  const [ocrState, setOcrState] = useState('이름 인식 대기');
  const ocrSessionRef = useRef(0);
  const nameEditedRef = useRef(false);
  const [cameraSession, setCameraSession] = useState<{ side: CardSide; withChoice: boolean } | null>(null);

  const configured = Boolean(config.apiUrl && config.token);

  // announce=false(배경 20초 주기·앱 복귀)는 실패를 조용히 넘긴다 — 오프라인 토스트 스팸 방지 (legacy 규칙).
  const refresh = useCallback(async (announce = false) => {
    setLoading(true);
    try {
      await pruneSentQueue();
      const localQueue = await readQueue();
      setQueue(localQueue.sort((a, b) => b.captureId.localeCompare(a.captureId)));
      if (!configured) return;
      const response = await listBriefs(config, listLimit);
      if (!response.ok) throw new Error(response.error ?? 'list_failed');
      const nextBriefs = response.items ?? [];
      setBriefs(nextBriefs);
      saveCachedBriefs(nextBriefs);
      const seeAll = response.seeAll === true;
      const research = response.researchInstructionEnabled === true;
      setOwnerCanSeeAll(seeAll);
      setResearchInstructionEnabled(seeAll && research);
      saveOwnerFlags({ seeAll, researchInstructionEnabled: research });
      setHasMoreBriefs(response.hasMore === true);
      setRefreshedAt(Date.now());
    } catch (error) {
      if (announce) setMessage(`새로고침 실패: ${actionErrorMessage(error)}`);
      throw error;
    } finally {
      setLoading(false);
    }
  }, [config, configured, listLimit]);

  const silentRefresh = useCallback(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  // 수동 새로고침은 즉시 진행 토스트 → 완료/실패 토스트로 반응한다 (2026-07-26 실폰 피드백 7).
  const manualRefresh = useCallback(async () => {
    setMessage('새로고침 중…');
    try {
      await refresh(true);
      setMessage((current) => current === '' || current === '새로고침 중…' ? '새로고침 완료 — 최신 상태예요' : current);
    } catch {
      // 실패 문구는 refresh(true)가 이미 띄웠다.
    }
  }, [refresh]);

  const flushPendingQueue = useCallback(async (announce = false) => {
    if (!configured || flushingRef.current) return;
    flushingRef.current = true;
    setSending(true);
    try {
      const result = await flushQueue((item) => uploadCapture(config, item));
      await refresh().catch(() => undefined);
      if (announce && result.attempted > 0) {
        setMessage(result.failed > 0
          ? `${result.sent}건 전송, ${result.failed}건은 다음 연결 때 다시 시도합니다.`
          : `${result.sent}건을 기존 처리 대기열로 보냈습니다.`);
      }
    } catch (error) {
      if (announce) setMessage(`전송 재시도 실패: ${actionErrorMessage(error)}`);
    } finally {
      flushingRef.current = false;
      setSending(false);
    }
  }, [config, configured, refresh]);

  useEffect(() => {
    silentRefresh();
    void flushPendingQueue();
    const handleOnline = () => void flushPendingQueue(true);
    const handleVisibility = () => {
      if (document.hidden) return;
      // 앱 복귀 시 legacy처럼 전송 재시도·브리핑 갱신·스티키 복원을 함께 한다.
      void flushPendingQueue();
      silentRefresh();
      const restored = loadStickyCaptureContext();
      setEvent((value) => value || restored.event);
      setRelSelf((value) => value || restored.relSelf);
      setRelKairen((value) => value || restored.relKairen);
      setResearchText((value) => value || restored.research);
    };
    const interval = window.setInterval(() => silentRefresh(), AUTO_REFRESH_MS);
    const clock = window.setInterval(() => setClockTick(Date.now()), 1_000);
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.clearInterval(interval);
      window.clearInterval(clock);
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [flushPendingQueue, silentRefresh]);

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
    ? AUTO_REFRESH_MS / 1000
    : Math.max(0, (AUTO_REFRESH_MS - (clockTick - refreshedAt)) / 1000);
  const autoRefreshHint = refreshHint(untilRefresh, sinceRefresh);

  // 상단 바의 한 줄 상태. 제품 이름 대신 "지금 무슨 일이 일어나는지"를 소유한다.
  const pendingCount = useMemo(() => feed.filter((entry) => (entry.local && entry.local.state !== 'sent')
    || (entry.brief && entry.brief.status !== 'processed' && entry.brief.status !== 'skipped')).length, [feed]);
  const headerStatus = !configured ? '연결 필요 — 개인 링크로 열어주세요'
    : loading ? '최신 상태 확인 중…'
      : sending ? '사진 전송 중…'
        : pendingCount > 0 ? `${pendingCount}건 처리 중 · ${autoRefreshHint}`
          : feed.length > 0 ? `기록 ${feed.length}건 · ${autoRefreshHint}`
            : '첫 명함을 기다리고 있어요';

  const setupBannerMessage = !config.apiUrl
    ? '연결할 서버 주소가 없어요 — 받으신 개인 링크로 접속하거나 설정의 고급 항목에서 주소를 넣어주세요.'
    : !config.token
      ? '받으신 개인 링크(?k=토큰 포함)로 접속해 주세요. 토큰이 없으면 업로드가 거부됩니다.'
      : '';

  const runSearch = useCallback(async (value: string) => {
    const normalized = value.trim();
    if (!normalized || !configured || !ownerCanSeeAll) return;
    setSearching(true);
    try {
      const response = await searchPeople(config, normalized);
      if (!response.ok) throw new Error(response.error ?? 'search_failed');
      setSearchResults(response.items ?? []);
      setRecentSearches(saveRecentSearch(normalized));
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
        const response = await listBriefs(config, 100);
        if (!alive()) return;
        if (response.ok && response.items) {
          setBriefs(response.items);
          saveCachedBriefs(response.items);
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
        if (alive() && response.ok) setRecallServerItems(response.items ?? []);
      } catch {
        // 서버 보조 검색 실패는 회상 결과 자체를 막지 않는다.
      }
    }
  }, [briefs, config, configured, ownerCanSeeAll]);

  function submitSearch(formEvent: FormEvent) {
    formEvent.preventDefault();
    if (searchMode === 'recall') void runRecall(query);
    else void runSearch(query);
  }

  function commitSettings() {
    const saved = saveRuntimeConfig(draftConfig);
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
    setConfig(saveRuntimeConfig(next).config);
    setNameOnboardOpen(false);
  }

  // 이 기기에서 개인 링크와 사적 캐시를 끊는다 (FI-007). 대기 중인 촬영은 지우지 않는다.
  const unsentCount = useMemo(() => queue.filter((item) => item.state !== 'sent').length, [queue]);

  function commitSignOut() {
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
    setOcrState('이름 읽는 중…');
    void recognizeQuickName(frame.dataUrl, (progress) => {
      if (session === ocrSessionRef.current && !nameEditedRef.current) setOcrState(`이름 읽는 중 ${progress}%`);
    }).then((result) => {
      if (session !== ocrSessionRef.current || nameEditedRef.current) return;
      setQuickName(result);
      setNameText(result?.name ?? '');
      setOcrState(result?.name ? '인식 완료 · 확인해 주세요' : '직접 확인해 주세요');
    }).catch(() => {
      if (session === ocrSessionRef.current && !nameEditedRef.current) setOcrState('직접 확인해 주세요');
    });
  }, []);

  const editQuickName = useCallback((value: string) => {
    const name = value.trim().slice(0, 80);
    nameEditedRef.current = true;
    setNameText(value.slice(0, 80));
    setQuickName(name ? {
      name,
      source: 'user_corrected',
      confidence: quickName?.confidence ?? 0,
      confirmed: true,
      recognizedAt: quickName?.recognizedAt ?? new Date().toISOString(),
    } : null);
    setOcrState(name ? '직접 확인됨' : '이름을 입력해 주세요');
  }, [quickName]);

  const resetQuickName = useCallback(() => {
    ocrSessionRef.current += 1;
    nameEditedRef.current = false;
    setQuickName(null);
    setNameText('');
    setOcrState('이름 인식 대기');
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
      await putQueueItem(item);
      setQueue((current) => [item, ...current].sort((a, b) => b.captureId.localeCompare(a.captureId)));
      // 즉시 초기화해서 다음 명함을 바로 찍을 수 있게 — 만난 곳·관계·조사 지시는 2시간 유지, 메모만 비운다.
      setFrontFrame(null);
      setBackFrame(null);
      setMemo('');
      resetQuickName();
      setMessage(configured
        ? '업로드 시작! 다음 명함을 이어서 찍을 수 있어요'
        : '사진을 로컬 대기열에 보관했습니다. 연결 설정 뒤 자동으로 전송합니다.');
      void contentRef.current?.scrollToTop(300);
      if (configured) void flushPendingQueue();
    } catch {
      setMessage('로컬 대기열에 저장하지 못했어요 — 다시 시도해 주세요.');
    } finally {
      setQueueing(false);
    }
  }, [backFrame, configured, event, flushPendingQueue, frontFrame, memo, queueing, quickName, relKairen, relSelf, researchInstructionEnabled, researchText, resetQuickName]);

  const retryQueueItem = useCallback(async (item: CaptureQueueItem) => {
    await putQueueItem({ ...item, state: 'queued', err: undefined });
    setQueue((current) => current.map((candidate) => candidate.captureId === item.captureId
      ? { ...candidate, state: 'queued', err: undefined }
      : candidate));
    if (configured) void flushPendingQueue(true);
    else setMessage('연결 설정을 저장하면 이 캡처를 자동으로 다시 보냅니다.');
  }, [configured, flushPendingQueue]);

  const startRetake = useCallback((side: 'front.jpg' | 'back.jpg') => {
    setQueueRetakeSide(side);
    setRetakeMode(true);
    setCameraSession({ side: side === 'front.jpg' ? 'front' : 'back', withChoice: false });
  }, []);

  const saveQueueEdit = useCallback(async () => {
    if (!queueEdit || !queueEdit.images.some((image) => image.dataB64)) return;
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
    await putQueueItem(next);
    setQueueEdit(null);
    await refresh().catch(() => undefined);
    if (configured) void flushPendingQueue(true);
    else setMessage('변경을 같은 captureId에 저장했습니다. 연결되면 다시 전송합니다.');
  }, [configured, flushPendingQueue, queueEdit, refresh]);

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
      await refresh().catch(() => undefined);
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
    try {
      const response = await requeueCapture(config, captureId);
      if (!response.ok) throw new Error(response.error ?? 'requeue_failed');
      setMessage(response.alreadyTerminal
        ? (response.status === 'skipped' ? '이미 건너뜀으로 마감됐어요' : '이미 처리가 끝났어요 — 최신 상태로 바꿀게요')
        : response.deduped ? '이미 다시 처리 중이에요' : '다시 처리를 요청했어요 — 몇 분 안에 처리돼요');
      await refresh().catch(() => undefined);
    } catch (error) {
      setMessage(`재처리 실패: ${actionErrorMessage(error)}`);
    }
  }, [config, refresh]);

  function renderQueueRow(item: CaptureQueueItem) {
    const imageSource = queueImageSource(item);
    const processedName = processedNames[item.captureId];
    const displayName = processedName || item.quickName?.name || '이름 인식 대기';
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
            {item.err && <small>{actionErrorMessage(item.err)}</small>}
          </div>
          <ChevronRight aria-hidden="true" size={16} />
        </button>
        {processedName && item.state !== 'failed' && (
          <button className="note-action" type="button" onClick={() => promptNote({ captureId: item.captureId })}><Plus aria-hidden="true" size={13} />메모</button>
        )}
        {item.state === 'failed' && <button className="retry-action" type="button" onClick={() => void retryQueueItem(item)}>다시 보내기</button>}
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
                <button type="button" onClick={() => void retryProcessing(item.captureId)}><RotateCcw aria-hidden="true" size={13} />다시 처리 요청</button>
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
          <button className="load-more" type="button" onClick={() => { setFeedLimit((current) => current + 30); setListLimit((current) => Math.min(current + 30, 100)); }}>
            예전 기록 더 보기
          </button>
        )}
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
              <small>기기 안에서 먼저 읽어요. 틀리면 여기서 바로 고치면 이후 정리에 반영됩니다.</small>
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
            <AiSurface className="research-request">
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
        </section>

        <div className="section-toggle-row">
          <button className="section-toggle" type="button" aria-expanded={!recordsCollapsed} onClick={toggleRecords}>
            <span className="caret" aria-hidden="true">{recordsCollapsed ? '▸' : '▾'}</span> 명함 기록
          </button>
          {sending && <span className="sending-note">전송 중…</span>}
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
        <div className="records-feed">{renderFeedBody()}</div>
      </div>
    );
  }

  function renderPersonSearchRow(item: SearchItem) {
    const personId = (/PER-\d{6}/.exec(item.title) ?? [null])[0];
    const displayName = item.title.replace(/^PER-\d+\s*/, '');
    return (
      <button className="person-row" type="button" key={item.id} onClick={() => void openDocument(displayName, { id: item.id }, personId ? { person: personId } : null)}>
        <div className="avatar" aria-hidden="true">{displayName.slice(0, 1)}</div>
        <div className="row-copy"><strong>{displayName}</strong><span>{item.title.split(' ')[0]}{item.via === 'content' ? ' · 본문 일치' : ''}</span></div>
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
      <section className="recall-progress">
        <AiStageRail stages={recallStages(recallStage, briefs.length)} label="AI 사람 찾기 진행 단계" />
        <div className="recall-progress-foot">
          <span>{recallStartedAt === null ? '' : `${elapsedLabel(clockTick - recallStartedAt)} 경과`}</span>
          {recallSyncing && <span className="recall-sync">최신 기록 확인 중</span>}
          <button type="button" onClick={cancelRecall}>중단</button>
        </div>
      </section>
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
    return (
      <div className="cc-stack">
        <div className="mode-switch" role="tablist" aria-label="검색 방식">
          <button type="button" role="tab" aria-selected={!recall} className={recall ? '' : 'active'} onClick={() => setSearchMode('quick')}><Search aria-hidden="true" size={14} />빠른 검색</button>
          <button type="button" role="tab" aria-selected={recall} className={recall ? 'active' : ''} onClick={() => setSearchMode('recall')}><Sparkles aria-hidden="true" size={14} />AI 사람 찾기</button>
        </div>
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
        {recentSearches.length > 0 && (
          <div className="recent-searches" aria-label="최근 검색">
            {recentSearches.map((value) => (
              <button key={value} type="button" onClick={() => { setQuery(value); void (recall ? runRecall(value) : runSearch(value)); }}><Search aria-hidden="true" size={12} />{value}</button>
            ))}
          </div>
        )}
        {(!configured || !ownerCanSeeAll) && <EmptyState title="소유자 연결이 필요해요" body="Person 검색은 기존과 동일하게 owner token에서만 동작합니다." action="설정 열기" onAction={() => { setDraftConfig(config); setSettingsOpen(true); }} />}
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
        <p className="build-line">빌드 {__CARD_CAPTURE_BUILD_ID__}</p>
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
                <IonItem><IonInput label="연결 주소 (GAS API)" labelPlacement="stacked" type="url" value={draftConfig.apiUrl} onIonInput={(inputEvent) => setDraftConfig((value) => ({ ...value, apiUrl: String(inputEvent.detail.value ?? '') }))} /></IonItem>
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
                    <AiSurface className="research-request">
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
                <IonButton expand="block" disabled={!queueEdit.images.some((image) => image.dataB64)} onClick={() => void saveQueueEdit()}>저장하고 다시 보내기</IonButton>
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
