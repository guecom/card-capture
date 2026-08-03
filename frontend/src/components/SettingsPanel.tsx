import '../styles/int29-settings.css';
import { Bell, Camera, Info, Mail, RefreshCw, ShieldCheck, SunMoon, Unplug } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RuntimeConfig } from '../contracts/capture';
import type { PushState } from '../services/push';
import type { ThemePreference } from '../services/storage';
import { THEME_CHOICES } from '../services/theme';
import { buildBugReportText, bugReportMailto, collectBugReportFacts } from '../services/bug-report';

/* 설정 화면 (ISS-000217 · DEC-000093 — Kairen-Ref: TSK-000532)
   ================================================================
   founder가 이 화면을 두고 말한 것 다섯 가지를 그대로 구현한다:

   1. "사용자 연결 정보 편집을 눌러서 뭔가 한 뎁스가 더 들어가는데, 이렇게 뎁스가 굳이 있어야 할까"
      → 시트도 `고급 설정` 접기도 없앤다. 이름·연결 주소·개인 링크 코드가 **여기 한 자리**에 있다.
   2. "알림 설정하는 부분이 뭐 글귀나 버튼 같은 거라든가 전반적으로 좀 많이 어색해"
      → 내부 사정 서술을 끊는다. 지금 상태 한 줄 · 다음 행동 하나 · 알림이 오는 경우.
   3. "기본 카메라 앱 쓰지 않기를 결국에 껐다 켰다 하는 거잖아 ... 뭔가 좀 이상하고"
      → 부정형 토글을 없애고 **고르는 두 가지 촬영 방법**과 각각의 결과를 적는다.
   4. "이 도움말이 뭔가 사람들이 읽을까 싶어? 차라리 없는 게 낫지 않을까? 그러고 버전 같은 거는
      좀 크게 잘 보이게" → 도움말 접기를 없애고 버전을 크게 보여 준다.
   5. "버그 리포트 기능도 있으면 좋겠어" → 메일 초안을 채워 열어 준다. **보내기는 사람이 누른다.**

   ── 지키는 경계 ──
   - 연결 주소 칸은 개발 호스트에서만 편집 가능하다 (`canEditApiEndpoint`). 배포본에서는 보이되
     읽기 전용이고, 왜 바꿀 수 없는지를 그 칸의 설명으로 연결한다. **화면은 방어선이 아니다** —
     실제 판정은 `services/api-origin.ts`가 하고, 이 화면은 거짓 선택지를 없앨 뿐이다.
   - 알림 `끄기`는 차단·오프라인에서도 반드시 닿을 수 있어야 한다 (ISS-000045).
   - 버그 리포트 본문에는 개인 링크 코드·연결 주소·사람 정보가 들어가지 않는다
     (`services/bug-report.ts`의 허용 목록 + 부정 게이트).

   ── 글자 크기 ──
   `<small>`을 쓰지 않는다. Ionic 전역 `small { font-size: 75% }` 가 이 화면을 읽을 수 없게 만든
   원인이었다. 크기는 전부 `int29-settings.css`가 명시하고 가독성 스윕이 매번 다시 잰다. */

export interface SettingsPanelProps {
  config: RuntimeConfig;
  /** 연결 주소와 개인 링크 코드가 모두 있는가. */
  configured: boolean;
  /** 개발 호스트에서만 참. 배포본에서는 연결 주소 칸이 읽기 전용이다. */
  apiEndpointEditable: boolean;
  apiEndpointLockNote: string;
  /** 명함과 개인 링크 코드가 나가는 호스트 (사람이 읽는 형태). */
  trustedApiHost: string;
  onSaveConfig: (next: RuntimeConfig) => void;
  galleryFree: boolean;
  onGalleryFreeChange: (next: boolean) => void;
  theme: ThemePreference;
  resolvedTheme: 'light' | 'dark';
  onThemeChange: (next: ThemePreference) => void;
  pushState: PushState;
  pushBusy: boolean;
  onPushToggle: () => void;
  onPushRefresh: () => void;
  onSignOut: () => void;
  /** 지금 화면 이름. 버그 리포트 진단에 그대로 실린다. */
  currentScreen: string;
  appVersion: string;
  buildId: string;
}

type PushAction = 'toggle' | 'retry' | 'none';

interface PushView {
  /** 지금 무엇이 사실인가. 한 문장. */
  state: string;
  tone: 'on' | 'off' | 'blocked' | 'wait';
  action: PushAction;
  /** 버튼에 적히는 말. 누르면 무슨 일이 일어나는지 그대로 적는다. */
  actionLabel: string;
  /** 앱 밖에서만 풀 수 있는 상태일 때의 실제 절차. */
  fix?: string[];
  /** 진단에 실리는 짧은 상태 이름. */
  short: string;
}

/**
 * 알림 상태 → 화면.
 *
 * `local_subscription`은 서버에 닿지 못했어도 이 기기에는 구독이 남아 있다는 뜻이다.
 * 차단·오프라인이라도 **끄기는 반드시 닿을 수 있어야 한다** — 끌 방법이 없는 알림은 사용자가
 * 통제권을 잃었다고 느끼는 지점이다 (ISS-000045). 그래서 이 갈래를 상태보다 먼저 본다.
 */
export function pushView(push: PushState, busy: boolean): PushView {
  const hasLocal = push.detail === 'local_subscription';
  if (busy) return { state: '방금 고른 대로 안전하게 반영하고 있어요.', tone: 'wait', action: 'none', actionLabel: '반영 중…', short: '반영 중' };
  if (push.status === 'checking') return { state: '알림 상태를 확인하고 있어요.', tone: 'wait', action: 'none', actionLabel: '확인 중…', short: '확인 중' };

  if (hasLocal) {
    return {
      state: '이 기기에 알림 구독이 남아 있어요.',
      tone: 'blocked',
      action: 'toggle',
      actionLabel: '이 기기 알림 끄기',
      short: '이 기기 구독 남음',
    };
  }

  switch (push.status) {
    case 'disconnected':
      return {
        state: '개인 링크를 연결하면 알림을 켤 수 있어요.',
        tone: 'off',
        action: 'none',
        actionLabel: '개인 링크 연결이 먼저예요',
        fix: ['위 계정·연결 칸에서 받으신 개인 링크로 이 기기를 연결해 주세요.'],
        short: '연결 필요',
      };
    case 'unsupported':
      return {
        state: '이 브라우저는 앱을 닫은 뒤의 알림을 지원하지 않아요.',
        tone: 'blocked',
        action: 'none',
        actionLabel: '이 브라우저에서는 켤 수 없어요',
        fix: [
          'iPhone이면 Safari에서 공유 → 홈 화면에 추가 를 하고, 그 아이콘으로 열어 주세요.',
          '안드로이드면 Chrome 최신 버전에서 열어 주세요.',
          '알림 없이도 진행 화면을 열면 최신 상태를 그대로 볼 수 있어요.',
        ],
        short: '미지원',
      };
    case 'denied':
      // "차단됨"만 말하면 사용자는 앱 안에서 방법을 찾다 포기한다. 차단은 앱이 아니라 OS·브라우저가
      // 쥐고 있으므로 **앱 밖의 절차**를 적는다.
      return {
        state: '이 기기가 알림을 차단해 두었어요. 앱에서는 풀 수 없어요.',
        tone: 'blocked',
        action: 'retry',
        actionLabel: '허용한 뒤 다시 확인',
        fix: [
          'Android Chrome: 주소창 왼쪽 자물쇠 → 권한 → 알림 → 허용',
          'iPhone: 설정 앱 → 알림 → 이 앱 → 알림 허용',
          '바꾸신 뒤 아래 버튼을 눌러 주세요.',
        ],
        short: '차단됨',
      };
    case 'offline':
      return {
        state: '오프라인이라 알림 설정을 확인할 수 없어요.',
        tone: 'off',
        action: 'retry',
        actionLabel: '연결되면 다시 확인',
        fix: ['캡처와 전송 대기는 그대로예요. 연결이 돌아오면 이어서 확인합니다.'],
        short: '오프라인',
      };
    case 'server_disabled':
      return {
        state: '안전한 전송 준비가 아직 끝나지 않았어요.',
        tone: 'off',
        action: 'none',
        actionLabel: '아직 켤 수 없어요',
        fix: ['준비가 끝나기 전에는 진행 화면이 정확한 기준이에요.'],
        short: '준비 중',
      };
    case 'capable':
      return { state: '앱을 닫아도 알림을 받을 수 있어요.', tone: 'off', action: 'toggle', actionLabel: '알림 켜기', short: '꺼짐' };
    case 'off':
      return { state: '알림이 꺼져 있어요.', tone: 'off', action: 'toggle', actionLabel: '알림 켜기', short: '꺼짐' };
    case 'subscribed':
      return { state: '알림이 켜져 있어요.', tone: 'on', action: 'toggle', actionLabel: '알림 끄기', short: '켜짐' };
    case 'stale':
      return push.detail === 'cleanup_pending'
        ? { state: '이 기기 구독을 아직 정리하지 못했어요.', tone: 'blocked', action: 'toggle', actionLabel: '이 기기 알림 끄기', short: '정리 필요' }
        : { state: '알림 연결을 새로 해야 해요.', tone: 'blocked', action: 'toggle', actionLabel: '다시 연결하기', short: '재연결 필요' };
    case 'error':
    default:
      return {
        state: '알림 상태를 확인하지 못했어요.',
        tone: 'blocked',
        action: 'retry',
        actionLabel: '상태 다시 확인',
        fix: ['캡처와 처리는 그대로예요. 알림만 확인되지 않았습니다.'],
        short: '확인 실패',
      };
  }
}

/** 알림 조작이 실제로 끄기인가. `App`의 `handlePushToggle`이 쓰는 판정과 같은 식이어야 한다. */
function isTurningOff(push: PushState): boolean {
  return push.status === 'subscribed'
    || push.detail === 'local_subscription'
    || (push.status === 'stale' && push.detail === 'cleanup_pending');
}

function canToggle(push: PushState): boolean {
  return ['capable', 'off', 'subscribed'].includes(push.status)
    || push.status === 'stale'
    || push.detail === 'local_subscription';
}

/** 온라인 여부를 화면이 직접 본다. `navigator.onLine`은 브라우저가 이미 관리하는 사실이다. */
function useOnline(): boolean {
  const [online, setOnline] = useState(() => globalThis.navigator?.onLine ?? true);
  useEffect(() => {
    const update = () => setOnline(globalThis.navigator?.onLine ?? true);
    globalThis.addEventListener?.('online', update);
    globalThis.addEventListener?.('offline', update);
    return () => {
      globalThis.removeEventListener?.('online', update);
      globalThis.removeEventListener?.('offline', update);
    };
  }, []);
  return online;
}

/** 좁은 폭에서만 나는 결함을 구분하려면 제보에 실제 화면 크기가 있어야 한다. */
function useViewportLabel(): string {
  const [label, setLabel] = useState(() => `${globalThis.innerWidth ?? 0}x${globalThis.innerHeight ?? 0}`);
  useEffect(() => {
    const update = () => setLabel(`${globalThis.innerWidth ?? 0}x${globalThis.innerHeight ?? 0}`);
    update();
    globalThis.addEventListener?.('resize', update);
    return () => globalThis.removeEventListener?.('resize', update);
  }, []);
  return label;
}

export function SettingsPanel(props: SettingsPanelProps) {
  const {
    config,
    configured,
    apiEndpointEditable,
    apiEndpointLockNote,
    trustedApiHost,
    onSaveConfig,
    galleryFree,
    onGalleryFreeChange,
    theme,
    resolvedTheme,
    onThemeChange,
    pushState,
    pushBusy,
    onPushToggle,
    onPushRefresh,
    onSignOut,
    currentScreen,
    appVersion,
    buildId,
  } = props;

  const [draft, setDraft] = useState<RuntimeConfig>(config);
  // 밖에서 연결 정보가 바뀌면(개인 링크로 다시 열기·연결 해제·저장 결과 정규화) 화면이 따라간다.
  // 저장된 값과 화면이 갈라지면 사용자는 자기가 무엇을 보고 있는지 알 수 없다.
  useEffect(() => setDraft(config), [config]);

  const online = useOnline();
  const viewport = useViewportLabel();
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'manual'>('idle');

  const view = pushView(pushState, pushBusy);
  const pushToggleAvailable = canToggle(pushState);
  const turningOff = isTurningOff(pushState);

  const dirty = draft.capturer !== config.capturer || draft.token !== config.token || draft.apiUrl !== config.apiUrl;
  const nameMissing = !draft.capturer.trim();

  const connectionLabel = configured
    ? '연결됨'
    : config.token
      ? '연결 주소 확인 필요'
      : '개인 링크 필요';
  const themeLabel = THEME_CHOICES.find((choice) => choice.value === theme)?.label ?? '라이트';
  const copyStatusMessage = copyState === 'copied'
    ? '복사했어요. 메일이나 메신저에 붙여넣어 보내 주세요.'
    : copyState === 'manual'
      ? '이 기기에서는 자동 복사가 막혀 있어요. 아래 내용을 직접 복사해 주세요.'
      : '';

  const reportFacts = useMemo(() => collectBugReportFacts({
    version: appVersion,
    buildId,
    tab: currentScreen,
    connection: connectionLabel,
    notifications: view.short,
    theme: themeLabel,
    online,
    viewport,
    language: globalThis.navigator?.language ?? '',
    userAgent: globalThis.navigator?.userAgent ?? '',
  }), [appVersion, buildId, currentScreen, connectionLabel, view.short, themeLabel, online, viewport]);

  const reportText = useMemo(() => buildBugReportText(reportFacts), [reportFacts]);
  const reportMailto = useMemo(() => bugReportMailto(reportFacts), [reportFacts]);

  const copyReport = useCallback(async () => {
    // 클립보드는 권한·컨텍스트(비보안 origin, 사용자 조작 인정 만료)에 따라 아예 없거나 거부된다.
    // 실패를 조용히 삼키지 않고 **눈으로 보고 직접 긁어 갈 수 있는 자리**를 연다 —
    // 여기서 막히면 메일 앱이 없는 기기의 제보 경로가 통째로 끊긴다.
    const clipboard = globalThis.navigator?.clipboard;
    if (!clipboard?.writeText) {
      setCopyState('manual');
      return;
    }
    try {
      await clipboard.writeText(reportText);
      setCopyState('copied');
    } catch {
      setCopyState('manual');
    }
  }, [reportText]);

  return (
    <div className="cc-stack int29-settings">
      {/* ── 계정·연결 ── 한 뎁스 없이 여기서 전부 보이고 전부 고쳐진다. */}
      <section className="int29-group" aria-labelledby="settings-job-account">
        <h2 className="int29-group-label" id="settings-job-account">계정·연결</h2>
        <section className="int29-card">
          <div className="int29-card-head">
            <strong>이 기기의 연결</strong>
            <span className={`int29-pill ${configured ? 'is-on' : 'is-warn'}`}>{connectionLabel}</span>
          </div>
          {configured ? (
            <p className="int29-lede">
              찍은 명함은 <b>{config.capturer || '이름 없음'}</b> 이름으로 접수돼요.
              명함이 계속 접수되지 않으면 개인 링크가 만료됐을 수 있어요 — 받으신 링크로 다시 열어 주세요.
            </p>
          ) : (
            <p className="int29-lede">
              아직 이 기기가 연결되지 않았어요. 받으신 <b>개인 링크</b>로 이 앱을 한 번 열면
              연결 주소와 개인 링크 코드가 자동으로 채워집니다. 링크가 없다면 관리자에게 요청해 주세요.
            </p>
          )}

          <div className="int29-fields">
            <div className="int29-field">
              <label htmlFor="settings-capturer">내 이름</label>
              <input
                id="settings-capturer"
                type="text"
                autoComplete="name"
                aria-describedby="settings-capturer-help"
                value={draft.capturer}
                onChange={(changeEvent) => setDraft((value) => ({ ...value, capturer: changeEvent.target.value }))}
              />
              <p className="int29-field-help" id="settings-capturer-help">명함에 &lsquo;누가 찍었는지&rsquo;로 함께 기록돼요.</p>
            </div>

            <div className="int29-field">
              <label htmlFor="settings-api">연결 주소</label>
              {apiEndpointEditable ? (
                <textarea
                  id="settings-api"
                  rows={2}
                  spellCheck={false}
                  aria-describedby="settings-api-help"
                  value={draft.apiUrl}
                  onChange={(changeEvent) => setDraft((value) => ({ ...value, apiUrl: changeEvent.target.value }))}
                />
              ) : (
                // 배포본에서는 읽기 전용이다 — 숨기지는 않는다. "지금 어디에 연결돼 있는가"는
                // 사용자가 알 권리다 (Kairen-Ref: TSK-000302). 한 줄 입력 칸이 아니라 여러 줄로
                // 두는 이유: Apps Script 배포본 주소는 100자가 넘어 한 줄 칸에서는 앞 1/3만 보이고,
                // 나머지를 확인하려면 폰에서 칸 안을 문질러야 한다 — 그러면 "계속 보여 준다"가 거짓이 된다.
                //
                // `onChange`를 달지 않는 것은 의도다. React가 다시 그리지 않으므로 DOM에 값을 억지로
                // 밀어 넣어도 저장 대상(`draft.apiUrl`)은 움직이지 않는다. 실제 방어는 저장 경로의
                // 신뢰 판정이 하고, 이 칸은 거짓 선택지를 없앨 뿐이다.
                <textarea
                  id="settings-api"
                  rows={2}
                  readOnly
                  spellCheck={false}
                  aria-describedby="settings-api-lock"
                  value={draft.apiUrl}
                />
              )}
              {apiEndpointEditable ? (
                <p className="int29-field-help" id="settings-api-help">개발 환경에서만 바꿀 수 있어요.</p>
              ) : (
                <p className="int29-locked-reason" id="settings-api-lock">
                  <Info aria-hidden="true" size={15} />
                  <span>{apiEndpointLockNote}</span>
                </p>
              )}
            </div>

            <div className="int29-field">
              <label htmlFor="settings-token">개인 링크 코드</label>
              <input
                id="settings-token"
                type="password"
                autoComplete="off"
                aria-describedby="settings-token-help"
                value={draft.token}
                onChange={(changeEvent) => setDraft((value) => ({ ...value, token: changeEvent.target.value }))}
              />
              <p className="int29-field-help" id="settings-token-help">
                개인 링크로 열면 자동으로 채워져요. 보이지 않게 가려 두었고, 이 기기 밖으로 나가지 않습니다.
              </p>
            </div>
          </div>

          <div className="int29-save-row">
            {dirty && <p className="int29-dirty" role="status">아직 저장하지 않은 변경이 있어요.</p>}
            <button className="int29-action is-primary" type="button" disabled={nameMissing} onClick={() => onSaveConfig(draft)}>
              설정 저장
            </button>
            {nameMissing && <p className="int29-note">이름을 입력해야 저장할 수 있어요.</p>}
          </div>
        </section>
      </section>

      {/* ── 촬영 ── 부정형 토글 대신 고르는 두 가지 방법. 각각의 결과를 옆에 붙인다. */}
      <section className="int29-group" aria-labelledby="settings-job-capture">
        <h2 className="int29-group-label" id="settings-job-capture">촬영</h2>
        <section className="int29-card">
          <div className="int29-card-head">
            <Camera aria-hidden="true" size={18} />
            <strong>명함을 어떻게 찍을까요</strong>
          </div>
          <fieldset className="int29-choice">
            <legend>촬영 방법</legend>
            <label className={`int29-option ${galleryFree ? 'is-selected' : ''}`}>
              <input
                type="radio"
                name="capture-method"
                value="in-app"
                checked={galleryFree}
                onChange={() => onGalleryFreeChange(true)}
              />
              <span className="int29-option-copy">
                <strong>앱 안에서 촬영</strong>
                <span>휴대폰 갤러리에 사본이 남지 않아요. 촬영 화면에 기본 카메라 앱 버튼을 두지 않습니다.</span>
              </span>
            </label>
            <label className={`int29-option ${galleryFree ? '' : 'is-selected'}`}>
              <input
                type="radio"
                name="capture-method"
                value="native"
                checked={!galleryFree}
                onChange={() => onGalleryFreeChange(false)}
              />
              <span className="int29-option-copy">
                <strong>기본 카메라 앱으로도 촬영</strong>
                <span>휴대폰 갤러리에 사본이 남고, 이 앱은 그 사본을 지울 수 없어요.</span>
              </span>
            </label>
          </fieldset>
          {/* 웹 앱은 OS 갤러리의 사진을 지울 권한이 없다. 지울 수 있는 척하지 않는다. */}
          <p className="int29-note">
            이미 갤러리에 쌓인 사진도 이 앱이 지울 수 없어요 — 휴대폰 갤러리에서 직접 지워 주세요.
          </p>
        </section>
      </section>

      {/* ── 알림 ── 상태 한 줄 · 행동 하나 · 오는 경우. 그 밖의 내부 사정은 적지 않는다. */}
      <section className="int29-group" aria-labelledby="settings-job-notify">
        <h2 className="int29-group-label" id="settings-job-notify">알림</h2>
        <section className="int29-card">
          <div className="int29-card-head">
            <Bell aria-hidden="true" size={18} />
            <strong>앱을 닫았을 때 알림</strong>
            <span className={`int29-pill ${view.tone === 'on' ? 'is-on' : view.tone === 'blocked' ? 'is-warn' : ''}`}>{view.short}</span>
          </div>

          <div className="int29-state" role="status" aria-live="polite" aria-busy={view.tone === 'wait'}>
            <strong>{view.state}</strong>
            {view.fix && (
              <ul className="int29-fix">
                {view.fix.map((step) => <li key={step}>{step}</li>)}
              </ul>
            )}
          </div>

          <div className="int29-action-row">
            {view.action === 'none' && (
              <button className="int29-action" type="button" disabled aria-busy={view.tone === 'wait'}>
                {view.tone === 'wait' && <RefreshCw className="spinning" aria-hidden="true" size={16} />}
                {view.actionLabel}
              </button>
            )}
            {view.action === 'toggle' && pushToggleAvailable && (
              <button className={`int29-action ${turningOff ? '' : 'is-primary'}`} type="button" onClick={onPushToggle}>
                <Bell aria-hidden="true" size={16} />{view.actionLabel}
              </button>
            )}
            {view.action === 'retry' && (
              <button className="int29-action" type="button" onClick={onPushRefresh}>
                <RefreshCw aria-hidden="true" size={16} />{view.actionLabel}
              </button>
            )}
          </div>

          {/* 세 갈래는 화면에서 지어낸 분류가 아니라 watcher가 실제로 보내는 kind와 1:1이다
              (final_result · human_input_required · recovery_required). 네 번째를 만들지 않는다. */}
          <p className="int29-scope-label" id="settings-notify-scope">알림이 오는 경우</p>
          <ul className="int29-scope" aria-labelledby="settings-notify-scope">
            <li><strong>최종 결과</strong><span>처리가 끝나 결과를 볼 수 있을 때</span></li>
            <li><strong>내용 확인</strong><span>사진·이름 등 사람의 보완이 필요할 때</span></li>
            <li><strong>복구 필요</strong><span>문제를 확인하고 다시 이어가야 할 때</span></li>
          </ul>
          <p className="int29-note">이 세 가지 외에는 알리지 않아요. 알림에 이름·회사·메모는 담기지 않습니다.</p>
        </section>
      </section>

      {/* ── 화면 ── */}
      <section className="int29-group" aria-labelledby="settings-job-display">
        <h2 className="int29-group-label" id="settings-job-display">화면</h2>
        <section className="int29-card">
          <div className="int29-card-head">
            <SunMoon aria-hidden="true" size={18} />
            <strong>화면 테마</strong>
          </div>
          <p className="int29-lede">어두운 곳에서는 다크로 바꿔 보세요. 고른 값은 이 기기에 저장돼요.</p>
          <div className="int29-theme" role="radiogroup" aria-label="화면 테마">
            {THEME_CHOICES.map((choice) => (
              <button
                key={choice.value}
                type="button"
                role="radio"
                aria-checked={theme === choice.value}
                className={theme === choice.value ? 'on' : ''}
                onClick={() => onThemeChange(choice.value)}
              >
                <strong>{choice.label}</strong>
                <span>{choice.hint}</span>
              </button>
            ))}
          </div>
          <p className="int29-note">
            지금 보이는 화면은 <b>{resolvedTheme === 'dark' ? '다크' : '라이트'}</b>예요{theme === 'system' ? ' — 폰 설정을 따라갑니다.' : '.'}
            {' '}화면의 움직임은 휴대폰의 <b>움직임 줄이기</b> 설정을 항상 따릅니다.
          </p>
        </section>
      </section>

      {/* ── 데이터·개인정보 ── */}
      <section className="int29-group" aria-labelledby="settings-job-data">
        <h2 className="int29-group-label" id="settings-job-data">데이터·개인정보</h2>
        <section className="int29-boundary">
          <ShieldCheck aria-hidden="true" size={22} />
          <div className="int29-boundary-copy">
            <strong>개인 링크 정보는 이 기기에만 저장돼요.</strong>
            <p>연결 정보는 저장소나 로그에 넣지 않습니다.</p>
            <p>명함과 개인 링크 코드는 <b>{trustedApiHost}</b> 로만 전송돼요. 다른 주소를 붙인 링크는 무시합니다.</p>
            <p>개인 링크로 열면 주소창의 코드를 <b>즉시 지웁니다</b> — 방문 기록·화면 공유에 남지 않아요.</p>
          </div>
        </section>
        <section className="int29-card">
          <div className="int29-card-head">
            <Unplug aria-hidden="true" size={18} />
            <strong>이 기기에서 연결 해제</strong>
          </div>
          <p className="int29-lede">
            개인 링크 코드와 이 기기에 저장된 브리핑 사본·검색 기록·만남 맥락을 지웁니다.
            <b> 전송을 기다리는 촬영은 지우지 않아요.</b>
          </p>
          <button className="int29-action is-danger" type="button" disabled={!config.token} onClick={onSignOut}>
            연결 해제
          </button>
          {!config.token && <p className="int29-note">지금은 이 기기에 지울 연결 정보가 없어요.</p>}
        </section>
      </section>

      {/* ── 버전·문제 알리기 ── 도움말 접기는 없앴다. 남은 것은 말할 수 있는 값과 알릴 수 있는 경로다. */}
      <section className="int29-group" aria-labelledby="settings-job-about">
        <h2 className="int29-group-label" id="settings-job-about">버전·문제 알리기</h2>
        <section className="int29-card">
          {/* 두 값은 서로 다른 일을 한다. 버전은 사람이 말하기 위한 것이고("2.23.0 쓰고 있어요"),
              빌드는 그 화면이 정확히 어느 소스에서 나왔는지 저장소에서 다시 계산해 대조하기 위한 것이다. */}
          <div className="int29-version">
            <span className="int29-version-eyebrow">지금 쓰고 있는 버전</span>
            <strong className="int29-version-number">{appVersion}</strong>
            <span className="int29-version-build">빌드 <code>{buildId}</code></span>
          </div>
          <p className="int29-note">문제를 알리실 때 이 두 줄을 그대로 읽어 주시면 됩니다.</p>

          <div className="int29-action-row">
            {/* `mailto:`는 메일 앱의 **초안**을 열 뿐이다. 보내기는 사람이 직접 누른다 —
                앱이 대신 보내면 무엇이 나갔는지 사용자가 볼 수도, 지울 수도 없다. */}
            <a className="int29-action is-primary" href={reportMailto}>
              <Mail aria-hidden="true" size={16} />버그 리포트 보내기
            </a>
            <button className="int29-action" type="button" onClick={() => void copyReport()}>
              메일 앱이 없어요 · 내용 복사하기
            </button>
          </div>
          <p className="int29-note">
            메일 앱에 제목과 내용이 채워진 초안이 열려요. <b>보내기는 직접 누르셔야 합니다.</b>{' '}
            버전·빌드·브라우저만 담기고 이름·연락처·개인 링크 코드는 담기지 않아요.
          </p>
          <p className="int29-status" role="status">{copyStatusMessage}</p>
          {copyState === 'manual' && (
            <div className="int29-field">
              <label htmlFor="settings-report-text">버그 리포트 내용</label>
              <textarea id="settings-report-text" className="int29-report-text" readOnly value={reportText} />
            </div>
          )}
        </section>
      </section>
    </div>
  );
}
