import '../styles/int29-settings.css';
import '../styles/int30-settings.css';
import { Bell, Camera, ChevronDown, Info, LifeBuoy, Link2, Mail, RefreshCw, ShieldCheck, Sparkles, SunMoon, TriangleAlert, Unplug } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RuntimeConfig } from '../contracts/capture';
import type { PushState } from '../services/push';
import type { ThemePreference } from '../services/storage';
import { THEME_CHOICES } from '../services/theme';
import { buildBugReportText, bugReportMailto, collectBugReportFacts } from '../services/bug-report';
import { type SettingsGroupId, settingsGroup } from '../services/settings-ia';

/* 설정 화면 (ISS-000217 · DEC-000093 · DEC-000105 — Kairen-Ref: TSK-000532 / TSK-000544)
   ======================================================================================
   DEC-000093이 뎁스와 부정형 토글을 없앤 뒤 founder가 다시 말한 것:

     "설정 페이지는 전반적으로 세련되지 않은 느낌이야. ... 유저가 설정 페이지에 처음 혹은
      자주 들어올 만한 이유들, 그리고 반드시 써야 될 것들을 중심으로 다시 잘 구성되었으면 좋겠어.
      순서나 뭐 이런 것들도 이제 해서 말이야."

   '세련되지 않음'은 개별 styling이 아니라 **정보구조**였다. 이전 판의 여섯 묶음
   (계정·연결 / 촬영 / 알림 / 화면 / 데이터·개인정보 / 버전·문제 알리기)은 코드가 나뉜 모양이지
   사람이 설정에 들어오는 이유가 아니다. 그래서 이 화면은 세 가지를 바꾼다:

   1. **순서를 방문 job으로 다시 놓는다.** 묶음 순서는 `services/settings-ia.ts`가 선언하고
      이 파일은 그것을 읽어 그린다 — 순서가 JSX에 숨으면 기계가 판정할 수 없다.
   2. **세 위계를 눈으로 구분한다.** 지속 선택(조작처럼 보임) · 읽기 전용 상태(조작처럼 보이지
      않음) · 되돌릴 수 없는 정리(마지막 위험 영역). 이 셋이 같은 카드·같은 버튼 모양으로
      섞여 있던 것이 '허접함'의 실체였다.
   3. **막혔을 때의 길을 접어서 남긴다.** 진단·제보는 평소 화면을 차지하지 않되 막힌 사람이
      반드시 발견해야 한다. 접힌 자리이지 사라진 자리가 아니다.

   ── 지키는 경계 (DEC-000093에서 그대로) ──
   - 연결 주소 칸은 개발 호스트에서만 편집 가능하다 (`canEditApiEndpoint`). 배포본에서는 보이되
     읽기 전용이고, 왜 바꿀 수 없는지를 그 칸의 설명으로 연결한다. **화면은 방어선이 아니다** —
     실제 판정은 `services/api-origin.ts`가 한다.
   - 알림 `끄기`는 차단·오프라인에서도 반드시 닿을 수 있어야 한다 (ISS-000045).
   - 버그 리포트 본문에는 개인 링크 코드·연결 주소·사람 정보가 들어가지 않는다
     (`services/bug-report.ts`의 허용 목록 + 부정 게이트). **앱은 아무것도 보내지 않는다.**
   - `화면 움직임` preference는 되살리지 않는다. 은퇴한 선택지이고 움직임은 언제나 폰의
     접근성 설정을 따른다 (`surface-polish.spec.ts`가 되살아남을 잡는다).

   ── 글자 크기 ──
   `<small>`을 쓰지 않는다. Ionic 전역 `small { font-size: 75% }` 가 이 화면을 읽을 수 없게 만든
   원인이었다. 크기는 전부 CSS가 명시하고 가독성 스윕이 매번 다시 잰다. */

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
  /** 아직 서버로 나가지 못한 촬영 건수. 연결 해제의 실제 영향을 말하기 위해 필요하다. */
  unsentCount: number;
  /** 이 연결에서 AI 조사 요청을 쓸 수 있는가 (서버가 준 owner 게이트). */
  researchAvailable: boolean;
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

/**
 * 묶음 하나. 제목 id는 등록소가 소유한다 — 낭독기는 묶음 제목 → 항목 → 상태 순으로 읽는다.
 */
function Group(props: { id: SettingsGroupId; children: ReactNode }) {
  const group = settingsGroup(props.id);
  return (
    <section className="int29-group int30-group" aria-labelledby={group.headingId} data-settings-group={group.id}>
      <h2 className="int29-group-label" id={group.headingId}>{group.label}</h2>
      {props.children}
    </section>
  );
}

/**
 * 읽기 전용 사실 목록.
 *
 * **조작처럼 보이면 안 된다.** 이 화면의 이전 판은 상태·진단·선택이 전부 같은 카드 안에 같은
 * 무게로 있었고, 그래서 사용자는 무엇을 누를 수 있는지 매번 시험해 봐야 했다. 여기서는
 * 버튼 모양(둥근 모서리·채운 배경·포커스 가능)을 전부 뺀 행으로 그린다.
 */
function Facts(props: { rows: Array<{ label: string; value: string; tone?: 'plain' | 'warn' }> }) {
  return (
    <dl className="int30-facts">
      {props.rows.map((row) => (
        <div className="int30-fact" key={row.label}>
          <dt>{row.label}</dt>
          <dd className={row.tone === 'warn' ? 'is-warn' : ''}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
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
    unsentCount,
    researchAvailable,
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
  // 지원 진입은 접혀서 시작한다. 평소 화면을 차지하지 않되 막힌 사람이 한 번에 열 수 있어야 한다.
  const [supportOpen, setSupportOpen] = useState(false);
  const tokenRef = useRef<HTMLInputElement>(null);

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

  /* 화면에 보이는 진단은 메일 본문과 **같은 값에서** 만든다.
     따로 모으면 한쪽에만 비밀이 새는 길이 생긴다 — `collectBugReportFacts`의 허용 목록을
     통과한 값만 여기까지 온다. */
  const diagnosticRows = useMemo(() => [
    { label: '버전', value: reportFacts.version },
    { label: '빌드', value: reportFacts.buildId },
    { label: '보던 화면', value: reportFacts.tab },
    { label: '연결', value: reportFacts.connection },
    { label: '알림', value: reportFacts.notifications },
    { label: '테마', value: reportFacts.theme },
    { label: '네트워크', value: reportFacts.online ? '온라인' : '오프라인' },
    { label: '화면 크기', value: reportFacts.viewport },
    { label: '언어', value: reportFacts.language },
    { label: '브라우저', value: reportFacts.userAgent },
  ], [reportFacts]);

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
    <div className="cc-stack int29-settings int30-settings">
      {/* ══ 1. 계정·연결 ══ 처음 온 사람이 반드시 해야 하는 단 하나가 화면 맨 위에 있다. */}
      <Group id="account">
        {/* 연결되지 않은 기기에서는 "무엇을 해야 하는가"가 다른 무엇보다 먼저다.
            연결된 기기에서는 이 블록이 사라진다 — 끝난 일을 계속 보여 주면 화면이 잔소리가 된다. */}
        {!configured && (
          <section className="int30-next" data-settings-item="connect-next-step" aria-labelledby="settings-next-step">
            <span className="int30-next-eyebrow">지금 할 일</span>
            <strong id="settings-next-step">이 기기를 개인 링크로 연결하세요</strong>
            <p>
              받으신 <b>개인 링크</b>로 이 앱을 한 번 열면 연결 주소와 개인 링크 코드가 자동으로 채워져요.
              링크가 없으면 관리자에게 요청해 주세요. 연결 전에는 촬영은 되지만 접수되지 않고 이 기기에 쌓입니다.
            </p>
            <button
              className="int29-action is-primary"
              type="button"
              onClick={() => {
                const field = tokenRef.current;
                field?.scrollIntoView({ block: 'center' });
                field?.focus();
              }}
            >
              <Link2 aria-hidden="true" size={16} />코드를 직접 입력할게요
            </button>
          </section>
        )}

        {/* 다시 오는 이유 1: "지금 잘 되고 있나". 읽는 블록이므로 조작을 섞지 않는다. */}
        <section className="int29-card" data-settings-item="connection-state">
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
              아직 이 기기가 연결되지 않았어요. 아래 칸은 개인 링크로 열면 자동으로 채워집니다.
            </p>
          )}
          <div data-settings-item="now-facts">
            <Facts rows={[
              { label: '접수 이름', value: config.capturer || '아직 없음' },
              { label: '알림', value: view.short },
              { label: '전송 대기', value: unsentCount > 0 ? `${unsentCount}건` : '없음', tone: unsentCount > 0 ? 'warn' : 'plain' },
              { label: '네트워크', value: online ? '온라인' : '오프라인', tone: online ? 'plain' : 'warn' },
            ]} />
          </div>
        </section>

        {/* 고치는 자리. 한 뎁스 없이 여기서 전부 보이고 전부 고쳐진다 (DEC-000093). */}
        <section className="int29-card">
          <div className="int29-card-head">
            <strong>연결 정보</strong>
          </div>
          <div className="int29-fields">
            <div className="int29-field" data-settings-item="capturer-name">
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

            <div className="int29-field" data-settings-item="api-endpoint">
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

            <div className="int29-field" data-settings-item="personal-token">
              <label htmlFor="settings-token">개인 링크 코드</label>
              <input
                id="settings-token"
                ref={tokenRef}
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

          <div className="int29-save-row" data-settings-item="save-config">
            {dirty && <p className="int29-dirty" role="status">아직 저장하지 않은 변경이 있어요.</p>}
            <button className="int29-action is-primary" type="button" disabled={nameMissing} onClick={() => onSaveConfig(draft)}>
              설정 저장
            </button>
            {nameMissing && <p className="int29-note">이름을 입력해야 저장할 수 있어요.</p>}
          </div>
        </section>
      </Group>

      {/* ══ 2. 캡처·조사 ══ 쓰는 동안 다시 오는 이유. 촬영 방법 → 보이는 방식 → 쓸 수 있는 범위.
          `화면` 묶음을 따로 두지 않는다 — 테마는 그 자체가 목적이 아니라 **어두운 곳에서 명함을
          찍고 결과를 읽기 위한** 설정이고, 사용자는 그 job으로 들어온다. */}
      <Group id="capture">
        <section className="int29-card" data-settings-item="capture-method">
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
          <p className="int29-note" data-settings-item="gallery-note">
            이미 갤러리에 쌓인 사진도 이 앱이 지울 수 없어요 — 휴대폰 갤러리에서 직접 지워 주세요.
          </p>
        </section>

        <section className="int29-card" data-settings-item="theme">
          <div className="int29-card-head">
            <SunMoon aria-hidden="true" size={18} />
            <strong>화면 테마</strong>
          </div>
          <p className="int29-lede">어두운 곳에서 명함을 찍고 결과를 읽을 때 눈이 편한 쪽으로 고르세요. 이 기기에 저장돼요.</p>
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
          {/* 움직임은 사용자 toggle로 덮어쓰지 않는다. 폰의 접근성 설정이 언제나 이긴다 —
              `화면 움직임` preference는 은퇴했고 되살리지 않는다. */}
          <p className="int29-note" data-settings-item="motion-note">
            지금 보이는 화면은 <b>{resolvedTheme === 'dark' ? '다크' : '라이트'}</b>예요{theme === 'system' ? ' — 폰 설정을 따라갑니다.' : '.'}
            {' '}화면의 움직임은 여기서 고르지 않고 휴대폰의 <b>움직임 줄이기</b> 설정을 항상 따릅니다.
          </p>
        </section>

        {/* 조사는 사용자가 켜고 끄는 값이 아니라 연결에 딸려 오는 권한이다. 그래서 선택이 아니라
            **읽기 전용 사실**로 적는다 — 못 쓰는 이유를 말하지 않으면 사용자는 설정에서 찾는다. */}
        <section className="int29-card" data-settings-item="research-availability">
          <div className="int29-card-head">
            <Sparkles aria-hidden="true" size={18} />
            <strong>AI 조사 요청</strong>
            <span className={`int29-pill ${researchAvailable ? 'is-on' : ''}`}>{researchAvailable ? '쓸 수 있어요' : '이 연결에서는 없음'}</span>
          </div>
          <p className="int29-note">
            {researchAvailable
              ? '명함 기록과 사람 카드에서 요청할 수 있어요. 무엇을 조사할지는 요청할 때 고릅니다 — 여기서 미리 정해 두지 않아요.'
              : '이 개인 링크에는 조사 권한이 없어요. 켜고 끄는 설정이 아니라 관리자가 링크에 부여하는 권한입니다.'}
          </p>
        </section>
      </Group>

      {/* ══ 3. 알림 ══ 상태 한 줄 · 행동 하나 · 오는 경우. 그 밖의 내부 사정은 적지 않는다. */}
      <Group id="notify">
        <section className="int29-card">
          <div className="int29-card-head">
            <Bell aria-hidden="true" size={18} />
            <strong>앱을 닫았을 때 알림</strong>
            <span className={`int29-pill ${view.tone === 'on' ? 'is-on' : view.tone === 'blocked' ? 'is-warn' : ''}`}>{view.short}</span>
          </div>

          <div className="int29-state" data-settings-item="notify-state" role="status" aria-live="polite" aria-busy={view.tone === 'wait'}>
            <strong>{view.state}</strong>
            {view.fix && (
              <ul className="int29-fix">
                {view.fix.map((step) => <li key={step}>{step}</li>)}
              </ul>
            )}
          </div>

          <div className="int29-action-row" data-settings-item="notify-action">
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
          <div data-settings-item="notify-scope">
            <p className="int29-scope-label" id="settings-notify-scope">알림이 오는 경우</p>
            <ul className="int29-scope" aria-labelledby="settings-notify-scope">
              <li><strong>최종 결과</strong><span>처리가 끝나 결과를 볼 수 있을 때</span></li>
              <li><strong>내용 확인</strong><span>사진·이름 등 사람의 보완이 필요할 때</span></li>
              <li><strong>복구 필요</strong><span>문제를 확인하고 다시 이어가야 할 때</span></li>
            </ul>
            <p className="int29-note">이 세 가지 외에는 알리지 않아요. 알림에 이름·회사·메모는 담기지 않습니다.</p>
          </div>
        </section>
      </Group>

      {/* ══ 4. 데이터·개인정보 ══ 읽는 것이 먼저, 되돌릴 수 없는 것이 맨 마지막. */}
      <Group id="data">
        <section className="int29-boundary" data-settings-item="privacy-boundary">
          <ShieldCheck aria-hidden="true" size={22} />
          <div className="int29-boundary-copy">
            <strong>개인 링크 정보는 이 기기에만 저장돼요.</strong>
            <p>연결 정보는 저장소나 로그에 넣지 않습니다.</p>
            <p>명함과 개인 링크 코드는 <b>{trustedApiHost}</b> 로만 전송돼요. 다른 주소를 붙인 링크는 무시합니다.</p>
            <p>개인 링크로 열면 주소창의 코드를 <b>즉시 지웁니다</b> — 방문 기록·화면 공유에 남지 않아요.</p>
          </div>
        </section>

        {/* 위험 영역. 카드가 아니라 **다른 종류의 자리**로 보여야 한다 —
            여기까지 스크롤한 사람은 "이 아래는 되돌릴 수 없다"를 읽기 전에 색으로 먼저 안다. */}
        <section className="int30-danger" data-settings-item="disconnect" data-settings-risk="destructive" aria-labelledby="settings-danger-title">
          <div className="int30-danger-head">
            <TriangleAlert aria-hidden="true" size={18} />
            <strong id="settings-danger-title">되돌릴 수 없는 정리</strong>
          </div>
          <div className="int30-danger-body">
            <div className="int29-card-head">
              <Unplug aria-hidden="true" size={18} />
              <strong>이 기기에서 연결 해제</strong>
            </div>
            <p className="int29-lede">폰을 바꾸거나 이 기기를 남에게 넘길 때 쓰세요.</p>
            <ul className="int30-impact">
              <li className="is-remove">
                <span>지웁니다</span>
                <span>개인 링크 코드 · 촬영자 이름 · 이 기기에 저장된 브리핑 사본 · 최근 검색어 · 만남 맥락</span>
              </li>
              <li className="is-keep">
                <span>남깁니다</span>
                <span>전송을 기다리는 촬영 원본 · 서버에 이미 접수된 기록</span>
              </li>
            </ul>
            <p className="int30-danger-note">
              <b>이 기기에서는 되돌릴 수 없어요.</b> 다시 쓰려면 개인 링크를 새로 받아 열어야 하고,
              이 기기에 저장된 사본은 복구되지 않습니다.
            </p>
            {unsentCount > 0 && (
              <p className="int30-danger-note is-alert" role="alert">
                아직 전송되지 않은 촬영이 <b>{unsentCount}건</b> 있어요. 지우지는 않지만 연결을 해제하면
                이 기기에서 보낼 수 없어요 — 먼저 전송을 끝내는 걸 권합니다.
              </p>
            )}
            <button className="int29-action is-danger" type="button" disabled={!config.token} onClick={onSignOut}>
              연결 해제
            </button>
            {!config.token && <p className="int29-note">지금은 이 기기에 지울 연결 정보가 없어요.</p>}
          </div>
        </section>
      </Group>

      {/* ══ 5. 앱 정보·지원 ══ 버전은 늘 보이고(통화하며 읽는 값), 진단·제보는 접혀 있다.
          접는 이유는 감추기 위해서가 아니라, **막히지 않은 날에는 필요 없는 것**이기 때문이다. */}
      <Group id="about">
        <section className="int29-card" data-settings-item="version">
          {/* 두 값은 서로 다른 일을 한다. 버전은 사람이 말하기 위한 것이고("2.23.0 쓰고 있어요"),
              빌드는 그 화면이 정확히 어느 소스에서 나왔는지 저장소에서 다시 계산해 대조하기 위한 것이다. */}
          <div className="int29-version">
            <span className="int29-version-eyebrow">지금 쓰고 있는 버전</span>
            <strong className="int29-version-number">{appVersion}</strong>
            <span className="int29-version-build">빌드 <code>{buildId}</code></span>
          </div>
          <p className="int29-note">문제를 알리실 때 이 두 줄을 그대로 읽어 주시면 됩니다.</p>
        </section>

        <section className="int30-support" data-settings-item="support-entry">
          <button
            className="int30-support-toggle"
            type="button"
            aria-expanded={supportOpen}
            aria-controls="settings-support-body"
            onClick={() => setSupportOpen((open) => !open)}
          >
            <LifeBuoy aria-hidden="true" size={18} />
            <span className="int30-support-toggle-copy">
              <strong>문제가 생겼을 때</strong>
              <span>진단 정보 보기 · 버그 리포트 메일 초안 열기</span>
            </span>
            <ChevronDown className={`int30-support-chevron ${supportOpen ? 'is-open' : ''}`} aria-hidden="true" size={18} />
          </button>

          <div className="int30-support-body" id="settings-support-body" hidden={!supportOpen}>
            <div data-settings-item="diagnostics">
              <p className="int29-scope-label" id="settings-diagnostics-label">진단 정보</p>
              {/* 화면에 보이는 값과 메일 본문에 실리는 값이 같은 출처다. 여기 없는 것은 메일에도 없다. */}
              <Facts rows={diagnosticRows} />
              <p className="int29-note">
                이름·연락처·개인 링크 코드·연결 주소는 여기에도 메일에도 담기지 않아요.
                이 화면은 <b>아무것도 자동으로 보내지 않습니다.</b>
              </p>
            </div>

            <div className="int29-action-row" data-settings-item="bug-report">
              {/* `mailto:`는 메일 앱의 **초안**을 열 뿐이다. 보내기는 사람이 직접 누른다 —
                  앱이 대신 보내면 무엇이 나갔는지 사용자가 볼 수도, 지울 수도 없다. */}
              <a className="int29-action is-primary" href={reportMailto}>
                <Mail aria-hidden="true" size={16} />버그 리포트 보내기
              </a>
            </div>
            <div className="int29-action-row" data-settings-item="report-copy">
              <button className="int29-action" type="button" onClick={() => void copyReport()}>
                메일 앱이 없어요 · 내용 복사하기
              </button>
            </div>
            <p className="int29-note">
              메일 앱에 제목과 내용이 채워진 초안이 열려요. <b>보내기는 직접 누르셔야 합니다.</b>
            </p>
            <p className="int29-status" role="status">{copyStatusMessage}</p>
            {copyState === 'manual' && (
              <div className="int29-field">
                <label htmlFor="settings-report-text">버그 리포트 내용</label>
                <textarea id="settings-report-text" className="int29-report-text" readOnly value={reportText} />
              </div>
            )}
          </div>
        </section>
      </Group>
    </div>
  );
}
