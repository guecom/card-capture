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
  IonTitle,
  IonToast,
  IonToolbar,
  setupIonicReact,
} from '@ionic/react';
import { ArrowUpRight, Camera, ChevronRight, ContactRound, RefreshCw, Search, Settings2, ShieldCheck, Waves } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import type { BriefItem, CaptureQueueItem, QuickName, RuntimeConfig, SearchItem } from './contracts/capture';
import { CameraPreviewModal } from './components/CameraPreviewModal';
import { StatusBadge } from './components/StatusBadge';
import { listBriefs, searchPeople } from './services/api';
import type { CapturedCameraFrame } from './services/camera';
import { buildQueuedCapture } from './services/capture-item';
import { putQueueItem, readQueue } from './services/queue';
import { loadRuntimeConfig, saveRuntimeConfig } from './services/storage';

setupIonicReact({ mode: 'ios' });

type Tab = 'capture' | 'activity' | 'people' | 'settings';

const tabs: Array<{ id: Tab; label: string; icon: LucideIcon }> = [
  { id: 'capture', label: '캡처', icon: Camera },
  { id: 'activity', label: '진행', icon: Waves },
  { id: 'people', label: '사람', icon: ContactRound },
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

function App() {
  const [tab, setTab] = useState<Tab>('capture');
  const [config, setConfig] = useState<RuntimeConfig>(() => loadRuntimeConfig());
  const [draftConfig, setDraftConfig] = useState<RuntimeConfig>(config);
  const [briefs, setBriefs] = useState<BriefItem[]>([]);
  const [queue, setQueue] = useState<CaptureQueueItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchItem[]>([]);
  const [cameraPreviewOpen, setCameraPreviewOpen] = useState(false);

  const configured = Boolean(config.apiUrl && config.token);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const localQueue = await readQueue();
      setQueue(localQueue.sort((a, b) => b.captureId.localeCompare(a.captureId)));
      if (!configured) return;
      const response = await listBriefs(config);
      if (!response.ok) throw new Error(response.error ?? 'list_failed');
      setBriefs(response.items ?? []);
    } catch (error) {
      setMessage(`새로고침 실패: ${error instanceof Error ? error.message : 'unknown_error'}`);
    } finally {
      setLoading(false);
    }
  }, [config, configured]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pending = useMemo(() => queue.filter((item) => item.state !== 'sent').length, [queue]);

  async function submitSearch(event: FormEvent) {
    event.preventDefault();
    const normalized = query.trim();
    if (!normalized || !configured) return;
    setSearching(true);
    try {
      const response = await searchPeople(config, normalized);
      if (!response.ok) throw new Error(response.error ?? 'search_failed');
      setSearchResults(response.items ?? []);
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

  const queueCandidateFrame = useCallback(async (frame: CapturedCameraFrame, quickName: QuickName | null) => {
    const item = buildQueuedCapture(frame, { quickName });
    await putQueueItem(item);
    setQueue((current) => [item, ...current].sort((a, b) => b.captureId.localeCompare(a.captureId)));
    setCameraPreviewOpen(false);
    setMessage('사진을 기존 로컬 대기열에 보관했습니다. 후보에서는 자동 전송하지 않습니다.');
  }, []);

  function renderCapture() {
    return (
      <div className="cc-stack">
        <section className="hero-card">
          <div className="eyebrow"><ShieldCheck aria-hidden="true" size={14} /> Contract-safe migration</div>
          <h1>명함은 지금처럼 찍고,<br />새 셸은 옆에서 검증합니다.</h1>
          <p>검증된 legacy 촬영은 계속 유지합니다. 후보 카메라는 기기 내에서 이름 후보를 먼저 읽고, 선택한 사진만 기존 로컬 대기열에 보관하며 자동 전송은 하지 않습니다.</p>
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
          <article><span>로컬 대기</span><strong>{pending}</strong><small>IndexedDB 동일 queue</small></article>
          <article><span>서버 기록</span><strong>{briefs.length}</strong><small>GAS list contract</small></article>
        </section>

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
        {briefs.map((item) => (
          <article className="person-row" key={item.captureId}>
            <div className="avatar" aria-hidden="true">{titleFromBrief(item).slice(0, 1)}</div>
            <div className="row-copy">
              <strong>{titleFromBrief(item)}</strong>
              <span>{item.contact?.company || item.event || formatMoment(item.receivedAt || item.capturedAt)}</span>
            </div>
            <StatusBadge status={item.status} />
          </article>
        ))}
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
          <button type="submit" disabled={!configured || searching}>{searching ? '검색 중' : '검색'}</button>
        </form>
        {!configured && <EmptyState title="소유자 연결이 필요해요" body="Person 검색은 기존과 동일하게 owner token에서만 동작합니다." action="설정 열기" onAction={() => setSettingsOpen(true)} />}
        {configured && searchResults.length === 0 && !searching && <EmptyState title="찾을 사람을 입력하세요" body="검색 결과는 새 데이터베이스가 아니라 기존 GAS search contract에서 읽습니다." />}
        {searchResults.map((item) => (
          <article className="person-row" key={item.id}>
            <div className="avatar" aria-hidden="true">{item.title.replace(/^PER-\d+\s*/, '').slice(0, 1)}</div>
            <div className="row-copy"><strong>{item.title.replace(/^PER-\d+\s*/, '')}</strong><span>{item.id}{item.via === 'content' ? ' · 본문 일치' : ''}</span></div>
            <ChevronRight aria-hidden="true" size={18} />
          </article>
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
            <IonButton expand="block" onClick={commitSettings}>이 기기에 저장</IonButton>
          </IonContent>
        </IonModal>
        <IonToast isOpen={Boolean(message)} message={message} duration={2600} position="top" onDidDismiss={() => setMessage('')} />
        <CameraPreviewModal isOpen={cameraPreviewOpen} onDismiss={() => setCameraPreviewOpen(false)} onQueueFrame={queueCandidateFrame} />
      </IonPage>
    </IonApp>
  );
}

function EmptyState({ title, body, action, onAction }: { title: string; body: string; action?: string; onAction?: () => void }) {
  return <section className="empty-state"><span className="empty-icon"><ShieldCheck aria-hidden="true" size={23} /></span><h2>{title}</h2><p>{body}</p>{action && onAction && <button onClick={onAction}>{action}</button>}</section>;
}

export default App;
