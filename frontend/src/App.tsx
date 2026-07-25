import {
  IonApp,
  IonButton,
  IonContent,
  IonFooter,
  IonHeader,
  IonInput,
  IonItem,
  IonLabel,
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
import { ArrowUpRight, Camera, ChevronRight, FileText, Mail, MessageCircle, Phone, Plus, RefreshCw, RotateCcw, Search, Settings2, ShieldCheck, UserPlus, Waves } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BriefItem, CaptureQueueItem, PersonTarget, RuntimeConfig, SearchItem } from './contracts/capture';
import { CameraPreviewModal, type CandidateCaptureDraft } from './components/CameraPreviewModal';
import { StatusBadge } from './components/StatusBadge';
import { addPersonNote, listBriefs, loadPersonDocument, requeueCapture, requestCorrection, searchPeople, submitResearchInstruction, uploadCapture } from './services/api';
import { fileToCameraFrame } from './services/camera';
import { buildLegacyNote, buildQueuedCapture } from './services/capture-item';
import { flushQueue, pruneSentQueue, putQueueItem, readQueue } from './services/queue';
import { buildResearchInstruction } from './services/research';
import { loadCachedBriefs, loadRecentSearches, loadRuntimeConfig, saveCachedBriefs, saveRecentSearch, saveRuntimeConfig, saveStickyCaptureContext } from './services/storage';

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

function titleFromBrief(item: BriefItem): string {
  const firstLine = item.brief?.split('\n')[0] ?? '';
  const parsed = firstLine.startsWith('# ')
    ? firstLine.slice(2).replace(/이런\s*분이에요/g, '').replace(/^[\s—\-–:·]+|[\s—\-–:·]+$/g, '').trim()
    : '';
  return parsed || item.contact?.name || item.quickName?.name || item.person || '이름 확인 중';
}

function formatMoment(value?: string): string {
  if (!value) return '시간 정보 없음';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function queueImageSource(item: CaptureQueueItem): string {
  if (item.thumb) return item.thumb;
  return queueNamedImageSource(item, 'front.jpg');
}

function queueNamedImageSource(item: CaptureQueueItem, name: 'front.jpg' | 'back.jpg'): string {
  const image = item.images.find((candidate) => candidate.name === name && candidate.dataB64);
  return image?.dataB64 ? `data:${image.mime ?? 'image/jpeg'};base64,${image.dataB64}` : '';
}

function queueStateCopy(item: CaptureQueueItem): string {
  if (item.state === 'sent') return '전송됨';
  if (item.state === 'failed') return `재시도 필요${item.tries ? ` · ${item.tries}회` : ''}`;
  return '전송 대기';
}

function elapsedMinutes(item: BriefItem): number | null {
  const timestamp = Date.parse(item.receivedAt || item.capturedAt || '');
  if (!Number.isFinite(timestamp)) return null;
  const minutes = Math.round((Date.now() - timestamp) / 60_000);
  return minutes >= 0 && minutes < 60 * 24 * 30 ? minutes : null;
}

function contactValues(item: BriefItem): { phones: string[]; emails: string[] } {
  const phones = [...(item.contact?.phones ?? []), item.contact?.phone ?? ''].filter(Boolean);
  const emails = [...(item.contact?.emails ?? []), item.contact?.email ?? ''].filter(Boolean);
  return { phones: [...new Set(phones)], emails: [...new Set(emails)] };
}

function downloadVCard(item: BriefItem): void {
  const name = titleFromBrief(item);
  const contact = contactValues(item);
  const organization = item.contact?.company || item.contact?.organization || '';
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${name}`, `N:${name};;;;`];
  if (organization) lines.push(`ORG:${organization}`);
  if (item.contact?.title) lines.push(`TITLE:${item.contact.title}`);
  contact.phones.forEach((phone) => lines.push(`TEL;TYPE=CELL:${phone}`));
  contact.emails.forEach((email) => lines.push(`EMAIL:${email}`));
  lines.push('NOTE:Kairen Card Capture', 'END:VCARD');
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/vcard;charset=utf-8' }));
  anchor.download = `${name || 'contact'}.vcf`;
  document.body.appendChild(anchor);
  anchor.click();
  window.setTimeout(() => { URL.revokeObjectURL(anchor.href); anchor.remove(); }, 1_500);
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
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchItem[]>([]);
  const [recentSearches, setRecentSearches] = useState<string[]>(loadRecentSearches);
  const [cameraPreviewOpen, setCameraPreviewOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [researchInstructionEnabled, setResearchInstructionEnabled] = useState(false);
  const [ownerCanSeeAll, setOwnerCanSeeAll] = useState(false);
  const [listLimit, setListLimit] = useState(30);
  const [hasMoreBriefs, setHasMoreBriefs] = useState(false);
  const [expandedBriefs, setExpandedBriefs] = useState<Set<string>>(() => new Set());
  const [documentOpen, setDocumentOpen] = useState(false);
  const [documentTitle, setDocumentTitle] = useState('프로필');
  const [documentBody, setDocumentBody] = useState('');
  const [documentLoading, setDocumentLoading] = useState(false);
  const [queueEdit, setQueueEdit] = useState<CaptureQueueItem | null>(null);
  const [queueRetakeSide, setQueueRetakeSide] = useState<'front.jpg' | 'back.jpg'>('front.jpg');
  const queueRetakeInputRef = useRef<HTMLInputElement>(null);
  const flushingRef = useRef(false);

  const configured = Boolean(config.apiUrl && config.token);

  const refresh = useCallback(async () => {
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
      setOwnerCanSeeAll(response.seeAll === true);
      setResearchInstructionEnabled(response.seeAll === true && response.researchInstructionEnabled === true);
      setHasMoreBriefs(response.hasMore === true);
    } catch (error) {
      setMessage(`새로고침 실패: ${error instanceof Error ? error.message : 'unknown_error'}`);
    } finally {
      setLoading(false);
    }
  }, [config, configured, listLimit]);

  const flushPendingQueue = useCallback(async (announce = false) => {
    if (!configured || flushingRef.current) return;
    flushingRef.current = true;
    setSending(true);
    try {
      const result = await flushQueue((item) => uploadCapture(config, item));
      await refresh();
      if (announce && result.attempted > 0) {
        setMessage(result.failed > 0
          ? `${result.sent}건 전송, ${result.failed}건은 다음 연결 때 다시 시도합니다.`
          : `${result.sent}건을 기존 처리 대기열로 보냈습니다.`);
      }
    } catch (error) {
      if (announce) setMessage(`전송 재시도 실패: ${error instanceof Error ? error.message : 'unknown_error'}`);
    } finally {
      flushingRef.current = false;
      setSending(false);
    }
  }, [config, configured, refresh]);

  useEffect(() => {
    void refresh();
    void flushPendingQueue();
    const handleOnline = () => void flushPendingQueue(true);
    const handleVisibility = () => {
      if (!document.hidden) void flushPendingQueue();
    };
    const interval = window.setInterval(() => void refresh(), 20_000);
    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [flushPendingQueue, refresh]);

  useEffect(() => {
    if (!config.capturer) setSettingsOpen(true);
  }, [config.capturer]);

  const pending = useMemo(() => queue.filter((item) => item.state !== 'sent').length, [queue]);

  async function submitSearch(event: FormEvent) {
    event.preventDefault();
    const normalized = query.trim();
    if (!normalized || !configured || !ownerCanSeeAll) return;
    setSearching(true);
    try {
      const response = await searchPeople(config, normalized);
      if (!response.ok) throw new Error(response.error ?? 'search_failed');
      setSearchResults(response.items ?? []);
      setRecentSearches(saveRecentSearch(normalized));
    } catch (error) {
      setMessage(`검색 실패: ${error instanceof Error ? error.message : 'unknown_error'}`);
    } finally {
      setSearching(false);
    }
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

  const queueCandidateCapture = useCallback(async (draft: CandidateCaptureDraft) => {
    const item = buildQueuedCapture(draft.frontFrame, {
      backFrame: draft.backFrame,
      event: draft.event,
      relSelf: draft.relSelf,
      relKairen: draft.relKairen,
      memo: draft.memo,
      researchInstruction: draft.researchInstruction,
      quickName: draft.quickName,
    });
    await putQueueItem(item);
    saveStickyCaptureContext({ event: item.event ?? '', relSelf: item.relSelf ?? '', relKairen: item.relKairen ?? '' });
    setQueue((current) => [item, ...current].sort((a, b) => b.captureId.localeCompare(a.captureId)));
    setCameraPreviewOpen(false);
    setMessage(configured
      ? '사진을 로컬 대기열에 보관했고 기존 처리 경로로 전송을 시작합니다.'
      : '사진을 로컬 대기열에 보관했습니다. 연결 설정 뒤 자동으로 전송합니다.');
    if (configured) void flushPendingQueue(true);
  }, [configured, flushPendingQueue]);

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
      setQueueEdit((current) => current ? {
        ...current,
        images: [...current.images.filter((candidate) => candidate.name !== queueRetakeSide), image]
          .sort((a, b) => a.name.localeCompare(b.name)),
      } : null);
    } catch {
      setMessage('사진을 읽지 못했습니다. 다시 시도해 주세요.');
    }
  }, [queueEdit, queueRetakeSide]);

  const saveQueueEdit = useCallback(async () => {
    if (!queueEdit || !queueEdit.images.some((image) => image.dataB64)) return;
    const relSelf = queueEdit.relSelf?.trim() ?? '';
    const relKairen = queueEdit.relKairen?.trim() ?? '';
    const memo = queueEdit.memo?.trim() ?? '';
    const next: CaptureQueueItem = {
      ...queueEdit,
      event: queueEdit.event?.trim() ?? '',
      relSelf,
      relKairen,
      memo,
      note: buildLegacyNote(relSelf, relKairen, memo),
      disp: memo || relSelf || relKairen,
      state: 'queued',
      err: undefined,
    };
    await putQueueItem(next);
    saveStickyCaptureContext({ event: next.event ?? '', relSelf, relKairen });
    setQueueEdit(null);
    await refresh();
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

  const openDocument = useCallback(async (title: string, target: { id?: string; captureId?: string }) => {
    if (!configured) return;
    setDocumentTitle(title);
    setDocumentBody('');
    setDocumentLoading(true);
    setDocumentOpen(true);
    try {
      const response = await loadPersonDocument(config, target);
      if (!response.ok) throw new Error(response.error ?? 'document_failed');
      setDocumentBody(response.markdown ?? '프로필 내용이 없습니다.');
    } catch (error) {
      setDocumentBody(`프로필을 불러오지 못했습니다: ${error instanceof Error ? error.message : 'unknown_error'}`);
    } finally {
      setDocumentLoading(false);
    }
  }, [config, configured]);

  const runPersonAction = useCallback(async (request: Promise<{ ok: boolean; error?: string; receiptId?: string }>, success: string) => {
    try {
      const response = await request;
      if (!response.ok) throw new Error(response.error ?? 'request_failed');
      setMessage(response.receiptId ? `${success} · receipt ${response.receiptId}` : success);
      await refresh();
    } catch (error) {
      setMessage(`요청 실패: ${error instanceof Error ? error.message : 'unknown_error'}`);
    }
  }, [refresh]);

  const promptNote = useCallback((target: PersonTarget) => {
    const text = window.prompt('이 분에 대한 메모를 남겨주세요. 다음 처리 때 인물 기록에 병합됩니다.', '');
    if (text?.trim()) void runPersonAction(addPersonNote(config, target, text), '메모를 접수했습니다.');
  }, [config, runPersonAction]);

  const promptResearch = useCallback((target: PersonTarget) => {
    const text = window.prompt('공개 자료에서 확인할 내용과 깊이를 적어주세요.', '');
    const submission = buildResearchInstruction(text ?? '');
    if (submission) void runPersonAction(submitResearchInstruction(config, target, submission.raw), '조사 지시를 접수했습니다.');
  }, [config, runPersonAction]);

  const promptCorrection = useCallback((captureId: string) => {
    const text = window.prompt('무엇이 틀렸는지 적어주세요.', '');
    if (text?.trim()) void runPersonAction(requestCorrection(config, captureId, text), '수정 요청을 보냈습니다.');
  }, [config, runPersonAction]);

  const retryProcessing = useCallback(async (captureId: string) => {
    try {
      const response = await requeueCapture(config, captureId);
      if (!response.ok) throw new Error(response.error ?? 'requeue_failed');
      setMessage(response.alreadyTerminal ? '이미 처리가 끝난 항목입니다.' : response.deduped ? '이미 다시 처리 중입니다.' : '다시 처리를 요청했습니다.');
      await refresh();
    } catch (error) {
      setMessage(`재처리 실패: ${error instanceof Error ? error.message : 'unknown_error'}`);
    }
  }, [config, refresh]);

  function renderCapture() {
    return (
      <div className="cc-stack">
        <section className="hero-card">
          <div className="eyebrow"><ShieldCheck aria-hidden="true" size={14} /> Contract-safe migration</div>
          <h1>명함은 지금처럼 찍고,<br />새 셸은 옆에서 검증합니다.</h1>
          <p>검증된 legacy 촬영은 계속 유지합니다. 후보 카메라는 기기 내에서 이름 후보를 먼저 읽고, 선택한 사진을 기존 로컬 대기열에 보관한 뒤 연결되면 같은 처리 경로로 전송합니다.</p>
          <div className="capture-actions">
            <IonButton className="primary-action" expand="block" href="../index.html">
              <Camera aria-hidden="true" slot="start" size={20} />
              검증된 카메라 열기
            </IonButton>
            <IonButton className="secondary-action" fill="outline" expand="block" onClick={() => setCameraPreviewOpen(true)}>
              후보 카메라 시험
            </IonButton>
          </div>
        </section>

        <section className="signal-grid" aria-label="현재 상태">
          <article><span>{sending ? '전송 중' : '로컬 대기'}</span><strong>{pending}</strong><small>IndexedDB 동일 queue</small></article>
          <article><span>서버 기록</span><strong>{briefs.length}</strong><small>GAS list contract</small></article>
        </section>

        <button className="search-shortcut" type="button" onClick={() => setTab('people')}>
          <span className="search-shortcut-icon"><Search aria-hidden="true" size={20} /></span>
          <span className="search-shortcut-copy"><strong>사람 검색</strong><small>이름 또는 회사로 기존 기록 찾기</small></span>
          <ChevronRight aria-hidden="true" size={19} />
        </button>

        <section className="surface-card">
          <div className="section-heading">
            <div><span className="eyebrow">Migration gate</span><h2>현재 전환 범위</h2></div>
          </div>
          <ol className="migration-list">
            <li className="done"><span>1</span><div><strong>Shell·contract</strong><small>Ionic shell과 typed adapter</small></div></li>
            <li className="active"><span>2</span><div><strong>Read surfaces</strong><small>진행·검색·설정 병렬 검증</small></div></li>
            <li className="done"><span>3</span><div><strong>Offline·API</strong><small>queue·server-off 계약 검증</small></div></li>
            <li className="active"><span>4</span><div><strong>Camera·OCR</strong><small>typed preview 뒤 actual phone gate</small></div></li>
          </ol>
        </section>
      </div>
    );
  }

  function renderActivity() {
    return (
      <div className="cc-stack">
        <div className="section-heading top-heading">
          <div><span className="eyebrow">Live contract</span><h1>처리 진행</h1></div>
          <button className="icon-action" onClick={() => void refresh()} aria-label="새로고침"><RefreshCw aria-hidden="true" size={19} /></button>
        </div>
        {!configured && <EmptyState title="연결 설정이 필요해요" body="기존 앱에서 사용하던 API와 token을 설정하면 같은 진행 상태를 읽습니다." action="설정 열기" onAction={() => setSettingsOpen(true)} />}
        {configured && loading && <div className="center-state"><IonSpinner name="crescent" /><span>최신 상태 확인 중</span></div>}
        {configured && !loading && briefs.length === 0 && <EmptyState title="아직 도착한 브리핑이 없어요" body="명함을 찍으면 접수·처리·완료 상태가 여기에 나타납니다." />}
        {queue.length > 0 && (
          <section className="surface-card queue-surface">
            <div className="section-heading"><div><span className="eyebrow">Local queue</span><h2>최근 캡처</h2></div></div>
            <div className="queue-list">
              {queue.slice(0, 30).map((item) => {
                const imageSource = queueImageSource(item);
                return (
                  <article className="queue-row" key={item.captureId}>
                    <button className="queue-row-main" type="button" onClick={() => setQueueEdit(structuredClone(item))}>
                      {imageSource ? <img src={imageSource} alt="명함 앞면 미리보기" /> : <span className="queue-placeholder"><Camera aria-hidden="true" size={18} /></span>}
                      <div className="row-copy"><strong>{item.quickName?.name || '이름 인식 대기'}</strong><span>{formatMoment(item.capturedAt)} · {queueStateCopy(item)}</span>{item.err && <small>{item.err}</small>}</div>
                      <ChevronRight aria-hidden="true" size={16} />
                    </button>
                    {item.state === 'failed' && <button className="retry-action" type="button" onClick={() => void retryQueueItem(item)}>다시 보내기</button>}
                  </article>
                );
              })}
            </div>
          </section>
        )}
        {briefs.map((item) => {
          const expanded = expandedBriefs.has(item.captureId);
          const minutes = elapsedMinutes(item);
          const pendingItem = item.status !== 'processed' && item.status !== 'skipped';
          const named = Boolean(item.contact?.name || item.quickName?.name);
          const contact = contactValues(item);
          const title = titleFromBrief(item);
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
              {pendingItem && minutes !== null && (
                <div className={`processing-line ${minutes > 30 ? 'late' : ''}`}>
                  <span>{named ? '2/3단계 웹 조사·정리 중' : '1/3단계 이름 인식 중'} · {minutes}분 경과</span>
                  {minutes > 30 && <div><button type="button" onClick={() => void retryProcessing(item.captureId)}><RotateCcw aria-hidden="true" size={13} />다시 처리</button><a href={`mailto:guecom90@gmail.com?subject=${encodeURIComponent(`[명함] 처리 지연 문의 ${item.captureId}`)}`}><Mail aria-hidden="true" size={13} />문의</a></div>}
                </div>
              )}
              {expanded && (
                <div className="brief-detail">
                  {item.brief ? <pre>{item.brief.replace(/^# .*\n?/, '')}</pre> : <p>아직 브리핑 본문이 도착하지 않았습니다.</p>}
                  <div className="action-grid">
                    {item.person && ownerCanSeeAll && <button type="button" onClick={() => void openDocument(title, { captureId: item.captureId })}><FileText aria-hidden="true" size={15} />전체 프로필</button>}
                    {item.status === 'processed' && item.type !== 'note' && item.type !== 'research_instruction' && <button className="primary" type="button" onClick={() => promptNote({ captureId: item.captureId })}><Plus aria-hidden="true" size={15} />메모 추가</button>}
                    {item.status === 'processed' && researchInstructionEnabled && item.type !== 'note' && item.type !== 'research_instruction' && <button type="button" onClick={() => promptResearch({ captureId: item.captureId })}><Search aria-hidden="true" size={15} />조사 지시</button>}
                    {item.status === 'processed' && <button type="button" onClick={() => promptCorrection(item.captureId)}><MessageCircle aria-hidden="true" size={15} />수정 요청</button>}
                    {contact.phones[0] && <a href={`tel:${contact.phones[0]}`}><Phone aria-hidden="true" size={15} />전화</a>}
                    {contact.phones[0] && <a href={`sms:${contact.phones[0]}`}><MessageCircle aria-hidden="true" size={15} />문자</a>}
                    {contact.emails[0] && <a href={`mailto:${contact.emails[0]}`}><Mail aria-hidden="true" size={15} />메일</a>}
                    {(contact.phones[0] || contact.emails[0]) && <button type="button" onClick={() => downloadVCard(item)}><UserPlus aria-hidden="true" size={15} />연락처 저장</button>}
                  </div>
                </div>
              )}
            </article>
          );
        })}
        {hasMoreBriefs && <button className="load-more" type="button" onClick={() => setListLimit((current) => Math.min(current + 30, 100))}>예전 브리핑 더 보기</button>}
      </div>
    );
  }

  function renderPeople() {
    return (
      <div className="cc-stack">
        <div className="section-heading top-heading"><div><span className="eyebrow">Owner recall</span><h1>사람 찾기</h1></div></div>
        <form className="search-shell" onSubmit={submitSearch}>
          <Search aria-hidden="true" size={19} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="이름 또는 회사" aria-label="이름 또는 회사 검색" />
          <button type="submit" disabled={!configured || !ownerCanSeeAll || searching}>{searching ? '검색 중' : '검색'}</button>
        </form>
        {recentSearches.length > 0 && <div className="recent-searches" aria-label="최근 검색">{recentSearches.map((value) => <button key={value} type="button" onClick={() => { setQuery(value); }}><Search aria-hidden="true" size={12} />{value}</button>)}</div>}
        {(!configured || !ownerCanSeeAll) && <EmptyState title="소유자 연결이 필요해요" body="Person 검색은 기존과 동일하게 owner token에서만 동작합니다." action="설정 열기" onAction={() => setSettingsOpen(true)} />}
        {configured && ownerCanSeeAll && searchResults.length === 0 && !searching && <EmptyState title="찾을 사람을 입력하세요" body="검색 결과는 새 데이터베이스가 아니라 기존 GAS search contract에서 읽습니다." />}
        {searchResults.map((item) => (
          <button className="person-row" type="button" key={item.id} onClick={() => void openDocument(item.title.replace(/^PER-\d+\s*/, ''), { id: item.id })}>
            <div className="avatar" aria-hidden="true">{item.title.replace(/^PER-\d+\s*/, '').slice(0, 1)}</div>
            <div className="row-copy"><strong>{item.title.replace(/^PER-\d+\s*/, '')}</strong><span>{item.id}{item.via === 'content' ? ' · 본문 일치' : ''}</span></div>
            <ChevronRight aria-hidden="true" size={18} />
          </button>
        ))}
      </div>
    );
  }

  function renderSettings() {
    return (
      <div className="cc-stack">
        <div className="section-heading top-heading"><div><span className="eyebrow">Same origin</span><h1>연결과 경계</h1></div></div>
        <section className="surface-card settings-summary">
          <div><span>촬영자</span><strong>{config.capturer || '미설정'}</strong></div>
          <div><span>API</span><strong>{config.apiUrl ? '연결 주소 있음' : '미설정'}</strong></div>
          <div><span>Token</span><strong>{config.token ? '이 기기에 저장됨' : '미설정'}</strong></div>
          <IonButton fill="outline" expand="block" onClick={() => { setDraftConfig(config); setSettingsOpen(true); }}>연결 설정 편집</IonButton>
        </section>
        <section className="boundary-note">
          <ShieldCheck aria-hidden="true" size={20} />
          <div><strong>새 credential을 만들지 않습니다.</strong><p>후보는 기존 앱과 같은 origin·local storage·IndexedDB를 사용합니다. token은 repository나 log에 포함하지 않습니다.</p></div>
        </section>
        <a className="legacy-link" href="../index.html">Legacy 앱으로 돌아가기 <ArrowUpRight aria-hidden="true" size={16} /></a>
      </div>
    );
  }

  return (
    <IonApp>
      <IonPage>
        <IonHeader translucent>
          <IonToolbar>
            <div className="brand-lockup" slot="start"><span className="brand-mark">K</span><span>Kairen <b>Card Capture</b><small>Migration candidate</small></span></div>
            <IonButton slot="end" fill="clear" onClick={() => void refresh()} aria-label="상태 새로고침"><RefreshCw aria-hidden="true" size={18} /></IonButton>
          </IonToolbar>
        </IonHeader>
        <IonContent fullscreen>
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

        <IonModal isOpen={settingsOpen} onDidDismiss={() => setSettingsOpen(false)} initialBreakpoint={0.78} breakpoints={[0, 0.78, 1]}>
          <IonHeader><IonToolbar><IonTitle>연결 설정</IonTitle><IonButton slot="end" fill="clear" onClick={() => setSettingsOpen(false)}>닫기</IonButton></IonToolbar></IonHeader>
          <IonContent className="ion-padding">
            <p className="modal-copy">기존 앱과 같은 local storage key를 사용합니다. token은 이 기기 밖으로 보내거나 log에 남기지 않습니다.</p>
            <IonList inset>
              <IonItem><IonInput label="촬영자 이름" labelPlacement="stacked" value={draftConfig.capturer} onIonInput={(event) => setDraftConfig((value) => ({ ...value, capturer: String(event.detail.value ?? '') }))} /></IonItem>
              <IonItem><IonInput label="GAS API URL" labelPlacement="stacked" type="url" value={draftConfig.apiUrl} onIonInput={(event) => setDraftConfig((value) => ({ ...value, apiUrl: String(event.detail.value ?? '') }))} /></IonItem>
              <IonItem><IonInput label="Bearer token" labelPlacement="stacked" type="password" value={draftConfig.token} onIonInput={(event) => setDraftConfig((value) => ({ ...value, token: String(event.detail.value ?? '') }))} /></IonItem>
            </IonList>
            <IonButton expand="block" disabled={!draftConfig.capturer.trim()} onClick={commitSettings}>이 기기에 저장</IonButton>
          </IonContent>
        </IonModal>
        <IonModal isOpen={documentOpen} onDidDismiss={() => setDocumentOpen(false)}>
          <IonHeader><IonToolbar><IonTitle>{documentTitle}</IonTitle><IonButton slot="end" fill="clear" onClick={() => setDocumentOpen(false)}>닫기</IonButton></IonToolbar></IonHeader>
          <IonContent className="ion-padding profile-document">
            {documentLoading ? <div className="center-state"><IonSpinner name="crescent" /><span>프로필 불러오는 중</span></div> : <pre>{documentBody}</pre>}
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
        <CameraPreviewModal
          isOpen={cameraPreviewOpen}
          researchInstructionEnabled={researchInstructionEnabled}
          onDismiss={() => setCameraPreviewOpen(false)}
          onQueueCapture={queueCandidateCapture}
        />
      </IonPage>
    </IonApp>
  );
}

function EmptyState({ title, body, action, onAction }: { title: string; body: string; action?: string; onAction?: () => void }) {
  return <section className="empty-state"><span className="empty-icon"><ShieldCheck aria-hidden="true" size={23} /></span><h2>{title}</h2><p>{body}</p>{action && onAction && <button onClick={onAction}>{action}</button>}</section>;
}

export default App;
