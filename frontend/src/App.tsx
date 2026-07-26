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
import { ArrowUpRight, Camera, ChevronRight, FileText, Mail, MessageCircle, PenLine, Plus, RefreshCw, RotateCcw, Search, Settings2, ShieldCheck, Waves } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BriefItem, CaptureQueueItem, PersonTarget, QuickName, RuntimeConfig, SearchItem } from './contracts/capture';
import { CameraCaptureModal, type CapturedSideMeta, type CardSide } from './components/CameraPreviewModal';
import { StatusBadge } from './components/StatusBadge';
import { MarkdownLite } from './components/MarkdownLite';
import { ContactActions, PersonDocument } from './components/PersonDocument';
import { addPersonNote, listBriefs, loadPersonDocument, requeueCapture, requestCorrection, searchPeople, submitResearchInstruction, uploadCapture } from './services/api';
import { type CapturedCameraFrame, fileToCameraFrame, thumbnailOf } from './services/camera';
import { buildLegacyNote, buildQueuedCapture, parseLegacyNote } from './services/capture-item';
import { actionErrorMessage, briefNameMap, briefTitle, elapsedMinutesOf, pendingProgress } from './services/brief-view';
import { contactCardFromBrief } from './services/contacts';
import { getOpenCvWorker, prefetchOpenCv } from './services/opencv';
import { prefetchQuickOcrAssets } from './services/paddle-quickname';
import { flushQueue, pruneSentQueue, putQueueItem, readQueue } from './services/queue';
import { buildResearchInstruction } from './services/research';
import { recognizeQuickName } from './services/vision';
import {
  loadCachedBriefs,
  loadOwnerFlags,
  loadRecentSearches,
  loadRuntimeConfig,
  loadSectionCollapsed,
  loadStickyCaptureContext,
  saveCachedBriefs,
  saveOwnerFlags,
  saveRecentSearch,
  saveRuntimeConfig,
  saveSectionCollapsed,
  saveStickyCaptureContext,
} from './services/storage';

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
  if (meta.source === 'native') text = `${label} 준비 완료`;
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

function App() {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [config, setConfig] = useState<RuntimeConfig>(() => loadRuntimeConfig());
  const [draftConfig, setDraftConfig] = useState<RuntimeConfig>(config);
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
  const [queueEdit, setQueueEdit] = useState<CaptureQueueItem | null>(null);
  const [queueRetakeSide, setQueueRetakeSide] = useState<'front.jpg' | 'back.jpg'>('front.jpg');
  const queueRetakeInputRef = useRef<HTMLInputElement>(null);
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
  const [queueing, setQueueing] = useState(false);
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
    const interval = window.setInterval(() => silentRefresh(), 20_000);
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.clearInterval(interval);
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

  // 처리 완료 브리핑의 이름을 로컬 캡처 행에 반영한다 (legacy briefNameMap).
  const processedNames = useMemo(() => briefNameMap(briefs), [briefs]);

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

  function submitSearch(formEvent: FormEvent) {
    formEvent.preventDefault();
    void runSearch(query);
  }

  function commitSettings() {
    saveRuntimeConfig(draftConfig);
    setConfig({
      apiUrl: draftConfig.apiUrl.trim(),
      token: draftConfig.token.trim(),
      capturer: draftConfig.capturer.trim(),
    });
    setSettingsOpen(false);
    setMessage('기존 Card Capture 설정과 같은 local storage에 저장했어요.');
  }

  function commitOnboardName() {
    const name = nameDraft.trim();
    if (!name) return;
    const next = { ...config, capturer: name };
    saveRuntimeConfig(next);
    setConfig(next);
    setNameOnboardOpen(false);
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

  const handleCaptured = useCallback((side: CardSide, frame: CapturedCameraFrame, meta: CapturedSideMeta) => {
    if (side === 'front') {
      setFrontFrame(frame);
      startQuickNameOcr(frame);
    } else {
      setBackFrame(frame);
    }
    setMessage(captureToast(side, meta));
  }, [startQuickNameOcr]);

  const closeCameraSession = useCallback(() => setCameraSession(null), []);

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

  const replaceQueueImage = useCallback(async (file: File | undefined) => {
    if (!file || !queueEdit) return;
    try {
      const frame = await fileToCameraFrame(file);
      const dataB64 = frame.dataUrl.slice(frame.dataUrl.indexOf(',') + 1);
      const image = { name: queueRetakeSide, mime: 'image/jpeg' as const, dataB64 };
      const thumb = queueRetakeSide === 'front.jpg' ? await thumbnailOf(frame.dataUrl) : null;
      setQueueEdit((current) => current ? {
        ...current,
        ...(thumb !== null ? { thumb } : {}),
        images: [...current.images.filter((candidate) => candidate.name !== queueRetakeSide), image]
          .sort((a, b) => a.name.localeCompare(b.name)),
      } : null);
    } catch {
      setMessage('사진을 읽지 못했습니다. 다시 시도해 주세요.');
    }
  }, [queueEdit, queueRetakeSide]);

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

  const runPersonAction = useCallback(async (request: Promise<{ ok: boolean; error?: string; receiptId?: string }>, success: string) => {
    try {
      const response = await request;
      if (!response.ok) throw new Error(response.error ?? 'request_failed');
      setMessage(response.receiptId ? `${success} · receipt ${response.receiptId}` : success);
      await refresh().catch(() => undefined);
    } catch (error) {
      setMessage(`접수 실패: ${actionErrorMessage(error)}`);
    }
  }, [refresh]);

  const promptNote = useCallback((target: PersonTarget) => {
    const text = window.prompt('이 분에 대한 메모를 남겨주세요.\n다음 처리 때 인물 기록에 병합돼요.\n예: 회의에서 3분기 협력 논의, 다음주 자료 보내기로 함', '');
    if (text?.trim()) void runPersonAction(addPersonNote(config, target, text), '메모를 접수했어요 — 잠시 후 인물 기록에 병합돼요');
  }, [config, runPersonAction]);

  const promptResearch = useCallback((target: PersonTarget) => {
    const text = window.prompt('공개 자료에서 확인할 내용과 깊이를 적어주세요.\n공개·합법 출처만 조사하고, 원문·요청자·대상·시간을 receipt로 남깁니다.', '');
    const submission = buildResearchInstruction(text ?? '');
    if (submission) void runPersonAction(submitResearchInstruction(config, target, submission.raw), '조사 지시를 접수했어요');
  }, [config, runPersonAction]);

  const promptCorrection = useCallback((captureId: string) => {
    const text = window.prompt('무엇이 틀렸는지 적어주세요.\n예: 직함이 CTO가 아니라 CPO / 이름 표기가 달라요', '');
    if (text?.trim()) void runPersonAction(requestCorrection(config, captureId, text), '수정 요청을 보냈어요 — 다음 처리 때 반영돼요');
  }, [config, runPersonAction]);

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
    return (
      <article className="queue-row" key={item.captureId}>
        <button className="queue-row-main" type="button" onClick={() => setQueueEdit(normalizedQueueItem(structuredClone(item)))}>
          {imageSource ? <img src={imageSource} alt="명함 앞면 미리보기" /> : <span className="queue-placeholder"><Camera aria-hidden="true" size={18} /></span>}
          <div className="row-copy">
            <strong>{displayName}</strong>
            <span>{contextLine || formatMoment(item.capturedAt)} · {queueStateCopy(item)}</span>
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
    const progress = pendingProgress(item, minutes);
    const title = briefTitle(item);
    const contact = contactCardFromBrief(item, title.split(' — ')[0]);
    const briefBody = item.brief ? item.brief.split('\n').slice(1).join('\n') : '';
    const actionable = item.status === 'processed' && item.type !== 'note' && item.type !== 'research_instruction';
    const localContext = local ? queueContextLine(local) : '';
    return (
      <article className="brief-card" key={item.captureId}>
        <button className="brief-summary" type="button" onClick={() => toggleBrief(item.captureId)} aria-expanded={expanded}>
          <div className="avatar" aria-hidden="true">{title.slice(0, 1)}</div>
          <div className="row-copy">
            <strong>{title}</strong>
            <span>{formatMoment(item.receivedAt || item.capturedAt)}{item.event ? ` · ${item.event}` : ''}{item.capturer ? ` · 촬영 ${item.capturer}` : ''}</span>
          </div>
          <StatusBadge status={item.status} />
          <ChevronRight className={expanded ? 'expanded' : ''} aria-hidden="true" size={17} />
        </button>
        {progress && (
          <div className={`processing-line ${progress.late ? 'late' : ''}`}>
            <span>{progress.text}</span>
            {progress.late && (
              <div>
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
            <div className="action-grid">
              {item.person && ownerCanSeeAll && <button type="button" onClick={() => void openDocument(title.split(' — ')[0], { captureId: item.captureId }, { captureId: item.captureId })}><FileText aria-hidden="true" size={15} />전체 프로필</button>}
              {actionable && (
                <>
                  {item.person && <button className="primary" type="button" onClick={() => promptNote({ captureId: item.captureId })}><Plus aria-hidden="true" size={15} />메모 추가</button>}
                  {item.person && researchInstructionEnabled && <button type="button" onClick={() => promptResearch({ captureId: item.captureId })}><Search aria-hidden="true" size={15} />조사 지시</button>}
                  <button type="button" onClick={() => promptCorrection(item.captureId)}><MessageCircle aria-hidden="true" size={15} />수정 요청</button>
                </>
              )}
              {local && <button type="button" onClick={() => setQueueEdit(normalizedQueueItem(structuredClone(local)))}><PenLine aria-hidden="true" size={15} />캡처 수정</button>}
            </div>
            {actionable && <ContactActions contact={contact} />}
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

          <div className="context-head">기억할 맥락 <span>선택 입력 · 2시간 유지</span></div>
          <div className="capture-context-fields plain">
            <IonInput label="어디서 만났는지 (선택, 2시간 유지)" labelPlacement="stacked" placeholder="예: 2026 로보월드 전시회" value={event} onIonInput={(inputEvent) => setEvent(String(inputEvent.detail.value ?? ''))} />
            <IonInput label="Kairen과 이 사람과의 관계 (선택, 2시간 유지)" labelPlacement="stacked" placeholder="예: 잠재 고객 / 부품 공급사 담당자" value={relKairen} onIonInput={(inputEvent) => setRelKairen(String(inputEvent.detail.value ?? ''))} />
            <IonInput label="나와 이 사람과의 관계 (선택, 2시간 유지)" labelPlacement="stacked" placeholder="예: 대학 선배 / 오늘 처음 인사" value={relSelf} onIonInput={(inputEvent) => setRelSelf(String(inputEvent.detail.value ?? ''))} />
            <IonTextarea label="메모 (선택 — 키보드 마이크로 말해도 돼요)" labelPlacement="stacked" placeholder="예: 공장장님, 우리 부품에 관심 많으심" autoGrow value={memo} onIonInput={(inputEvent) => setMemo(String(inputEvent.detail.value ?? ''))} />
            {researchInstructionEnabled && <IonTextarea label="조사 지시 (소유자 전용 · 2시간 유지)" labelPlacement="stacked" maxlength={2000} autoGrow placeholder="예: 최근 경력·이직 이력, 회사 투자·최근 뉴스, 인터뷰·발표, 저와의 공통 접점 위주로 깊게 조사해줘" value={researchText} onIonInput={(inputEvent) => setResearchText(String(inputEvent.detail.value ?? ''))} />}
          </div>

          <IonButton className="primary-action" expand="block" disabled={!frontFrame || queueing} onClick={() => void completeCapture()}>{queueing ? '저장 중…' : '완료'}</IonButton>
          <p className="hint">전파가 약해도 기기에 저장했다가 자동으로 다시 보내요.</p>
        </section>

        <div className="section-toggle-row">
          <button className="section-toggle" type="button" aria-expanded={!recordsCollapsed} onClick={toggleRecords}>
            <span className="caret" aria-hidden="true">{recordsCollapsed ? '▸' : '▾'}</span> 명함 기록
          </button>
          {sending && <span className="sending-note">전송 중…</span>}
          <button className="refresh-chip" type="button" onClick={() => void manualRefresh()}>새로고침</button>
        </div>
        {!recordsCollapsed && <div className="records-feed">{renderFeedBody()}</div>}
      </div>
    );
  }

  function renderActivity() {
    return (
      <div className="cc-stack">
        <div className="section-heading top-heading">
          <div><span className="eyebrow">Live contract</span><h1>처리 진행</h1></div>
          <button className="icon-action" onClick={() => void manualRefresh()} aria-label="새로고침"><RefreshCw aria-hidden="true" size={19} /></button>
        </div>
        {!configured && <EmptyState title="연결 설정이 필요해요" body="받으신 개인 링크(?k=토큰 포함)로 접속하면 같은 진행 상태를 읽습니다." action="설정 열기" onAction={() => { setDraftConfig(config); setSettingsOpen(true); }} />}
        <div className="records-feed">{renderFeedBody()}</div>
      </div>
    );
  }

  function renderPeople() {
    return (
      <div className="cc-stack">
        <div className="section-heading top-heading"><div><span className="eyebrow">Owner recall</span><h1>사람 찾기</h1></div></div>
        <form className="search-shell" onSubmit={submitSearch}>
          <Search aria-hidden="true" size={19} />
          <input value={query} onChange={(changeEvent) => setQuery(changeEvent.target.value)} placeholder="이름·회사·만난 곳으로 검색" aria-label="이름·회사·만난 곳으로 검색" />
          <button type="submit" disabled={!configured || !ownerCanSeeAll || searching}>{searching ? '검색 중' : '검색'}</button>
        </form>
        {recentSearches.length > 0 && (
          <div className="recent-searches" aria-label="최근 검색">
            {recentSearches.map((value) => (
              <button key={value} type="button" onClick={() => { setQuery(value); void runSearch(value); }}><Search aria-hidden="true" size={12} />{value}</button>
            ))}
          </div>
        )}
        {(!configured || !ownerCanSeeAll) && <EmptyState title="소유자 연결이 필요해요" body="Person 검색은 기존과 동일하게 owner token에서만 동작합니다." action="설정 열기" onAction={() => { setDraftConfig(config); setSettingsOpen(true); }} />}
        {configured && ownerCanSeeAll && searchResults.length === 0 && !searching && <EmptyState title="찾을 사람을 입력하세요" body="미팅 전 10초 회상 — 이름·회사·만난 곳으로 기존 기록을 찾습니다." />}
        {searchResults.map((item) => {
          const personId = (/PER-\d{6}/.exec(item.title) ?? [null])[0];
          const displayName = item.title.replace(/^PER-\d+\s*/, '');
          return (
            <button className="person-row" type="button" key={item.id} onClick={() => void openDocument(displayName, { id: item.id }, personId ? { person: personId } : null)}>
              <div className="avatar" aria-hidden="true">{displayName.slice(0, 1)}</div>
              <div className="row-copy"><strong>{displayName}</strong><span>{item.title.split(' ')[0]}{item.via === 'content' ? ' · 본문 일치' : ''}</span></div>
              <ChevronRight aria-hidden="true" size={18} />
            </button>
          );
        })}
      </div>
    );
  }

  function renderSettings() {
    return (
      <div className="cc-stack">
        <div className="section-heading top-heading"><div><span className="eyebrow">Same origin</span><h1>연결과 경계</h1></div></div>
        <section className="surface-card settings-summary">
          <div><span>촬영자</span><strong>{config.capturer || '미설정'}</strong></div>
          <div><span>연결</span><strong>{configured ? '개인 링크로 연결됨' : (config.token ? '주소 확인 필요' : '개인 링크 필요')}</strong></div>
          <div><span>토큰</span><strong>{config.token ? '이 기기에 저장됨 (개인 링크가 자동 저장)' : '미설정 — 개인 링크(?k=)로 접속'}</strong></div>
          <IonButton fill="outline" expand="block" onClick={() => { setDraftConfig(config); setAdvancedOpen(false); setSettingsOpen(true); }}>이름·연결 설정 편집</IonButton>
        </section>
        <section className="boundary-note">
          <ShieldCheck aria-hidden="true" size={20} />
          <div><strong>새 credential을 만들지 않습니다.</strong><p>현재 앱은 이전 앱과 같은 origin·local storage·IndexedDB를 사용합니다. token은 repository나 log에 포함하지 않습니다.</p></div>
        </section>
        <a className="legacy-link" href="../legacy.html">이전 앱 열기 · 복구용 <ArrowUpRight aria-hidden="true" size={16} /></a>
        <p className="build-line">빌드 {__CARD_CAPTURE_BUILD_ID__}</p>
      </div>
    );
  }

  return (
    <IonApp>
      <IonPage>
        <IonHeader translucent>
          <IonToolbar>
            <div className="brand-lockup" slot="start"><span className="brand-mark">K</span><span>Kairen <b>Card Capture</b><small>Mobile memory</small></span></div>
            <IonButton slot="end" fill="clear" onClick={() => void manualRefresh()} aria-label="상태 새로고침"><RefreshCw aria-hidden="true" size={18} /></IonButton>
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

        <IonModal isOpen={settingsOpen} onDidDismiss={() => setSettingsOpen(false)} initialBreakpoint={0.78} breakpoints={[0, 0.78, 1]}>
          <IonHeader><IonToolbar><IonTitle>이름·연결 설정</IonTitle><IonButton slot="end" fill="clear" onClick={() => setSettingsOpen(false)}>닫기</IonButton></IonToolbar></IonHeader>
          <IonContent className="ion-padding">
            <IonList inset>
              <IonItem><IonInput label="촬영자 이름" labelPlacement="stacked" value={draftConfig.capturer} onIonInput={(inputEvent) => setDraftConfig((value) => ({ ...value, capturer: String(inputEvent.detail.value ?? '') }))} /></IonItem>
            </IonList>
            <p className="modal-copy">주소와 토큰은 받으신 개인 링크(<code>?k=</code>)로 열면 자동 저장됩니다. 링크를 잃어버렸을 때만 아래에서 직접 입력하세요.</p>
            <button className="advanced-toggle" type="button" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((value) => !value)}>{advancedOpen ? '▾' : '▸'} 고급 — 직접 연결 설정</button>
            {advancedOpen && (
              <IonList inset>
                <IonItem><IonInput label="GAS API 주소" labelPlacement="stacked" type="url" value={draftConfig.apiUrl} onIonInput={(inputEvent) => setDraftConfig((value) => ({ ...value, apiUrl: String(inputEvent.detail.value ?? '') }))} /></IonItem>
                <IonItem><IonInput label="개인 링크 토큰 (?k= 값)" labelPlacement="stacked" type="password" value={draftConfig.token} onIonInput={(inputEvent) => setDraftConfig((value) => ({ ...value, token: String(inputEvent.detail.value ?? '') }))} /></IonItem>
              </IonList>
            )}
            <IonButton expand="block" disabled={!draftConfig.capturer.trim()} onClick={commitSettings}>이 기기에 저장</IonButton>
          </IonContent>
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
                  <div>{queueNamedImageSource(queueEdit, 'front.jpg') ? <img src={queueNamedImageSource(queueEdit, 'front.jpg')} alt="편집할 명함 앞면" /> : <span>앞면 원본 없음</span>}<button type="button" onClick={() => { setQueueRetakeSide('front.jpg'); queueRetakeInputRef.current?.click(); }}>앞면 다시 찍기</button></div>
                  <div>{queueNamedImageSource(queueEdit, 'back.jpg') ? <img src={queueNamedImageSource(queueEdit, 'back.jpg')} alt="편집할 명함 뒷면" /> : <span>뒷면 없음</span>}<button type="button" onClick={() => { setQueueRetakeSide('back.jpg'); queueRetakeInputRef.current?.click(); }}>{queueNamedImageSource(queueEdit, 'back.jpg') ? '뒷면 다시 찍기' : '뒷면 추가'}</button></div>
                </div>
                <section className="capture-context-fields light">
                  <IonInput label="어디서 만났는지" labelPlacement="stacked" value={queueEdit.event ?? ''} onIonInput={(inputEvent) => setQueueEdit((current) => current ? { ...current, event: String(inputEvent.detail.value ?? '') } : null)} />
                  <IonInput label="나와 이 사람과의 관계" labelPlacement="stacked" value={queueEdit.relSelf ?? ''} onIonInput={(inputEvent) => setQueueEdit((current) => current ? { ...current, relSelf: String(inputEvent.detail.value ?? '') } : null)} />
                  <IonInput label="Kairen과 이 사람과의 관계" labelPlacement="stacked" value={queueEdit.relKairen ?? ''} onIonInput={(inputEvent) => setQueueEdit((current) => current ? { ...current, relKairen: String(inputEvent.detail.value ?? '') } : null)} />
                  <IonTextarea label="메모" labelPlacement="stacked" autoGrow value={queueEdit.memo ?? ''} onIonInput={(inputEvent) => setQueueEdit((current) => current ? { ...current, memo: String(inputEvent.detail.value ?? '') } : null)} />
                </section>
                {!queueEdit.images.some((image) => image.dataB64) && <p className="modal-copy">오래된 전송 완료 캡처라 원본 사진이 정리됐습니다. 앞면을 다시 찍으면 같은 captureId로 재전송할 수 있습니다.</p>}
                <IonButton expand="block" disabled={!queueEdit.images.some((image) => image.dataB64)} onClick={() => void saveQueueEdit()}>저장하고 다시 보내기</IonButton>
                <input ref={queueRetakeInputRef} className="native-camera-input" type="file" accept="image/*" capture="environment" onChange={(inputEvent) => { void replaceQueueImage(inputEvent.target.files?.[0]); inputEvent.target.value = ''; }} />
              </>
            )}
          </IonContent>
        </IonModal>
        <IonToast isOpen={Boolean(message)} message={message} duration={2600} position="top" onDidDismiss={() => setMessage('')} />
        <CameraCaptureModal
          isOpen={Boolean(cameraSession)}
          initialSide={cameraSession?.side ?? 'front'}
          withBackChoice={cameraSession?.withChoice ?? false}
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
