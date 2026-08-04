// 설정 화면의 정보구조 등록소 (INT-000030 항목 004 · DEC-000105 — Kairen-Ref: TSK-000544)
// =========================================================================================
// founder: "설정 페이지는 전반적으로 세련되지 않은 느낌이야. ... 유저가 설정 페이지에 처음 혹은
// 자주 들어올 만한 이유들, 반드시 써야 될 것들을 중심으로 다시 잘 구성되었으면 좋겠어."
//
// 진단은 styling이 아니었다. **화면이 사용자의 반복 job 대신 내부 구현 항목을 나열하고 있었다.**
// `계정·연결 / 촬영 / 알림 / 화면 / 데이터·개인정보 / 버전·문제 알리기`는 코드가 나뉜 모양이지
// 사람이 설정에 들어오는 이유가 아니다. `화면`이 통째로 한 묶음을 차지하는 반면, 처음 온 사람이
// 반드시 해야 하는 **연결**은 다른 다섯 개와 같은 무게로 놓여 있었다.
//
// 그래서 순서와 위계를 데이터로 선언하고, 화면이 이 선언을 읽어 그린다. 이 파일이 없으면
// 순서는 JSX를 읽어야만 알 수 있고, "무엇이 빠졌는가"를 기계가 판정할 수 없다.
//
// ── 이 등록소가 소유하는 세 가지 ──
//  1. **묶음 순서** — 방문 job 순서다. 처음 오는 이유(연결) → 자주 오는 이유(캡처 취향·상태 확인)
//     → 가끔 오는 이유(알림) → 드물고 위험한 일(데이터) → 막혔을 때(지원).
//  2. **위계(kind)** — 지속 선택 / 읽기 전용 상태 / 되돌릴 수 있는 행동 / 되돌릴 수 없는 정리 /
//     접힌 지원 진입. 이 셋이 같은 모양으로 보이던 것이 "세련되지 않음"의 실체였다.
//  3. **누락 판정** — 재구성에서 조용히 사라진 Product behavior가 없다는 것을 `droppedLegacyItems()`가
//     증명한다. 재배치의 가장 큰 위험은 미학이 아니라 **분실**이다.

/** 화면에 보이는 다섯 묶음. 이 순서가 계약이다. */
export type SettingsGroupId = 'account' | 'capture' | 'notify' | 'data' | 'about';

/**
 * 그 묶음에 들어오는 방문의 성격.
 * - `first`  최초 1회. 하지 않으면 제품이 아예 동작하지 않는다.
 * - `repeat` 쓰면서 다시 오는 이유. 상태 확인과 취향 조정.
 * - `rare`   드물게 오지만 왔을 때 중요하다. 위험하거나, 막혔을 때다.
 */
export type SettingsVisit = 'first' | 'repeat' | 'rare';

/**
 * 항목의 위계. **이것이 시각 규칙을 결정한다.**
 * - `choice`  사용자가 바꾸는 지속 선택. 저장되고 다음에도 그대로다.
 * - `status`  읽기 전용 상태·진단. 누를 수 없고, 누를 수 있는 것처럼 보여서도 안 된다.
 * - `action`  되돌릴 수 있는 즉시 행동.
 * - `danger`  되돌릴 수 없는 정리. 영향과 취소 불가 범위를 말한 뒤에만 누를 수 있다.
 * - `support` 평소에는 접혀 있는 지원 진입.
 */
export type SettingsKind = 'choice' | 'status' | 'action' | 'danger' | 'support';

/** 잘못 눌렀을 때의 대가. `danger` 위계와 1:1이며 화면 색·자리·문구가 여기서 갈린다. */
export type SettingsRisk = 'none' | 'reversible' | 'destructive';

export interface SettingsGroup {
  id: SettingsGroupId;
  /** 화면에 그대로 적히는 제목. */
  label: string;
  /** `<section aria-labelledby>`가 가리키는 제목 id. 낭독기가 묶음 → 항목 → 상태 순으로 읽는다. */
  headingId: string;
  visit: SettingsVisit;
  /** 왜 이 자리인가. 순서를 나중에 바꾸려는 사람이 읽어야 하는 근거다. */
  why: string;
}

/**
 * 묶음 순서 = 방문 job 순서. `typeID`·파일 순서·구현 순서가 아니다.
 *
 * `about`이 마지막인 이유는 중요하지 않아서가 아니라 **찾아오는 시점이 마지막**이기 때문이다 —
 * 버전과 진단은 이미 막힌 뒤에 찾는다. 반대로 `account`가 처음인 이유는 연결하지 않으면
 * 나머지 넷이 전부 무의미하기 때문이다.
 */
export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    id: 'account',
    label: '계정·연결',
    headingId: 'settings-job-account',
    visit: 'first',
    why: '처음 온 사람이 반드시 해야 하는 단 하나. 연결되지 않으면 아래 넷이 모두 무의미하다.',
  },
  {
    id: 'capture',
    label: '캡처·조사',
    headingId: 'settings-job-capture',
    visit: 'repeat',
    why: '이 제품을 실제로 쓰는 동안 다시 오는 이유. 촬영 방법과 보이는 방식을 자기 취향에 맞춘다.',
  },
  {
    id: 'notify',
    label: '알림',
    headingId: 'settings-job-notify',
    visit: 'repeat',
    why: '켜고 끄는 일은 드물지만 "왜 안 오지"는 자주 온다. 상태를 확인하러 오는 자리다.',
  },
  {
    id: 'data',
    label: '데이터·개인정보',
    headingId: 'settings-job-data',
    visit: 'rare',
    why: '폰을 바꾸거나 남에게 빌려줄 때만 온다. 드물지만 잘못 누르면 되돌릴 수 없다.',
  },
  {
    id: 'about',
    label: '앱 정보·지원',
    headingId: 'settings-job-about',
    visit: 'rare',
    why: '이미 막힌 뒤에 찾아온다. 평소 화면을 차지하지 않되 막혔을 때 반드시 발견돼야 한다.',
  },
] as const;

/** DEC-000093 판(INT-000030 이전) 설정 화면의 묶음. 이동 흔적을 남기기 위해 이름을 보존한다. */
export type LegacyGroupId = 'account' | 'capture' | 'notify' | 'display' | 'data' | 'about';

export interface SettingsItem {
  /** DOM의 `data-settings-item` 값과 같다. 화면과 등록소를 잇는 유일한 열쇠다. */
  id: string;
  group: SettingsGroupId;
  /** 사람이 이 항목을 부르는 말. 화면 문구와 같을 필요는 없다(설명용). */
  label: string;
  kind: SettingsKind;
  risk: SettingsRisk;
  /** 접힌 지원 진입 안에서만 보이는가. */
  collapsed?: boolean;
  /** 연결 상태 등에 따라 없을 수 있는가. 순서 검증은 "있는 것들의 순서"를 본다. */
  conditional?: boolean;
  /** 이전 판에서 이 항목이 있던 묶음. `null`이면 이번에 새로 생긴 항목이다. */
  from: LegacyGroupId | null;
}

/**
 * 화면에 나타나는 순서 그대로. **배열 순서가 DOM 순서이고, 게이트가 그것을 다시 잰다.**
 *
 * 묶음 안의 순서 기준은 "얼마나 자주 필요한가 × 틀렸을 때의 대가"다:
 *   자주 필요하고 안전한 것 → 자주 필요하고 되돌릴 수 있는 것 → 드물고 되돌릴 수 없는 것.
 */
export const SETTINGS_ITEMS: readonly SettingsItem[] = [
  // ── 계정·연결 ── 처음 왔을 때 무엇을 해야 하는지가 화면 맨 위 첫 블록이다.
  { id: 'connect-next-step', group: 'account', label: '지금 할 일 — 개인 링크로 연결', kind: 'action', risk: 'reversible', conditional: true, from: null },
  { id: 'connection-state', group: 'account', label: '이 기기의 연결 상태', kind: 'status', risk: 'none', from: 'account' },
  { id: 'now-facts', group: 'account', label: '지금 상태 요약', kind: 'status', risk: 'none', from: null },
  { id: 'capturer-name', group: 'account', label: '내 이름', kind: 'choice', risk: 'reversible', from: 'account' },
  { id: 'api-endpoint', group: 'account', label: '연결 주소', kind: 'choice', risk: 'reversible', from: 'account' },
  { id: 'personal-token', group: 'account', label: '개인 링크 코드', kind: 'choice', risk: 'reversible', from: 'account' },
  { id: 'save-config', group: 'account', label: '설정 저장', kind: 'action', risk: 'reversible', from: 'account' },

  // ── 캡처·조사 ── 매번 쓰는 동안의 취향. 촬영이 먼저, 보이는 방식이 다음, 쓸 수 있는 범위가 마지막.
  { id: 'capture-method', group: 'capture', label: '촬영 방법', kind: 'choice', risk: 'reversible', from: 'capture' },
  { id: 'gallery-note', group: 'capture', label: '갤러리 사본 한계', kind: 'status', risk: 'none', from: 'capture' },
  { id: 'theme', group: 'capture', label: '화면 테마', kind: 'choice', risk: 'reversible', from: 'display' },
  { id: 'motion-note', group: 'capture', label: '움직임은 폰 설정을 따름', kind: 'status', risk: 'none', from: 'display' },
  { id: 'research-availability', group: 'capture', label: 'AI 조사 요청 가능 여부', kind: 'status', risk: 'none', from: null },

  // ── 알림 ── 상태 한 줄 · 행동 하나 · 오는 경우. 이 순서는 DEC-000093이 이미 정했다.
  { id: 'notify-state', group: 'notify', label: '지금 알림 상태', kind: 'status', risk: 'none', from: 'notify' },
  { id: 'notify-action', group: 'notify', label: '알림 켜기·끄기', kind: 'action', risk: 'reversible', from: 'notify' },
  { id: 'notify-scope', group: 'notify', label: '알림이 오는 경우', kind: 'status', risk: 'none', from: 'notify' },

  // ── 데이터·개인정보 ── 읽는 것이 먼저, 되돌릴 수 없는 것이 맨 마지막.
  { id: 'privacy-boundary', group: 'data', label: '개인정보 경계', kind: 'status', risk: 'none', from: 'data' },
  { id: 'disconnect', group: 'data', label: '이 기기에서 연결 해제', kind: 'danger', risk: 'destructive', from: 'data' },

  // ── 앱 정보·지원 ── 버전은 늘 보이고, 진단과 제보는 접혀 있다.
  { id: 'version', group: 'about', label: '버전·빌드', kind: 'status', risk: 'none', from: 'about' },
  { id: 'support-entry', group: 'about', label: '문제가 생겼을 때 (접힘)', kind: 'support', risk: 'reversible', from: null },
  { id: 'diagnostics', group: 'about', label: '진단 정보', kind: 'status', risk: 'none', collapsed: true, from: null },
  { id: 'bug-report', group: 'about', label: '버그 리포트 메일 초안', kind: 'action', risk: 'reversible', collapsed: true, from: 'about' },
  { id: 'report-copy', group: 'about', label: '리포트 내용 복사', kind: 'action', risk: 'reversible', collapsed: true, from: 'about' },
] as const;

export interface LegacyItem {
  id: string;
  group: LegacyGroupId;
  label: string;
}

/**
 * INT-000030 재구성 **직전**의 설정 화면에 실제로 있던 것 전부 (DEC-000093 판을 그대로 옮겼다).
 *
 * 이 목록의 쓸모는 하나다: 재구성이 Product behavior를 조용히 떨어뜨리지 않았다는 것을 기계가
 * 판정할 수 있게 하는 것. 다시 배치할 때 사라지는 것은 대개 화려한 조작이 아니라
 * "이미 갤러리에 쌓인 사진은 지울 수 없어요" 같은 **한 줄짜리 한계 고지**다.
 */
export const PRE_INT30_ITEMS: readonly LegacyItem[] = [
  { id: 'connection-state', group: 'account', label: '연결 상태와 지금 무엇이 사실인가' },
  { id: 'capturer-name', group: 'account', label: '내 이름' },
  { id: 'api-endpoint', group: 'account', label: '연결 주소 (배포본에서는 읽기 전용)' },
  { id: 'personal-token', group: 'account', label: '개인 링크 코드' },
  { id: 'save-config', group: 'account', label: '설정 저장' },
  { id: 'capture-method', group: 'capture', label: '촬영 방법 두 가지 중 하나' },
  { id: 'gallery-note', group: 'capture', label: '이미 쌓인 갤러리 사본은 앱이 지울 수 없다는 고지' },
  { id: 'notify-state', group: 'notify', label: '알림 상태 한 줄 + 앱 밖 절차' },
  { id: 'notify-action', group: 'notify', label: '알림 행동 하나' },
  { id: 'notify-scope', group: 'notify', label: '알림이 오는 세 경우' },
  { id: 'theme', group: 'display', label: '화면 테마 라이트·다크·시스템' },
  { id: 'motion-note', group: 'display', label: '움직임은 폰 설정을 따른다는 고지' },
  { id: 'privacy-boundary', group: 'data', label: '개인 링크 정보·전송 대상·주소창 정리 고지' },
  { id: 'disconnect', group: 'data', label: '이 기기에서 연결 해제' },
  { id: 'version', group: 'about', label: '버전과 빌드 식별자' },
  { id: 'bug-report', group: 'about', label: '버그 리포트 메일 초안' },
  { id: 'report-copy', group: 'about', label: '메일 앱이 없을 때 내용 복사' },
] as const;

const ITEM_BY_ID = new Map(SETTINGS_ITEMS.map((item) => [item.id, item]));

/** 묶음 순서. 화면이 이 배열을 그대로 돌면서 그린다. */
export function settingsGroupOrder(): SettingsGroupId[] {
  return SETTINGS_GROUPS.map((group) => group.id);
}

export function settingsGroup(id: SettingsGroupId): SettingsGroup {
  const group = SETTINGS_GROUPS.find((candidate) => candidate.id === id);
  if (!group) throw new Error(`unknown_settings_group:${id}`);
  return group;
}

/** 그 묶음의 항목을 화면 순서 그대로. */
export function settingsItemsOf(group: SettingsGroupId): SettingsItem[] {
  return SETTINGS_ITEMS.filter((item) => item.group === group);
}

export function settingsItem(id: string): SettingsItem | undefined {
  return ITEM_BY_ID.get(id);
}

/** 전체 화면 순서에서의 자리. 없으면 -1. */
export function settingsItemIndex(id: string): number {
  return SETTINGS_ITEMS.findIndex((item) => item.id === id);
}

/**
 * 재구성에서 **사라진** 이전 항목. 비어 있어야 한다.
 * 비어 있지 않다는 것은 화면을 다시 배치하면서 Product behavior를 떨어뜨렸다는 뜻이다.
 */
export function droppedLegacyItems(): string[] {
  return PRE_INT30_ITEMS.filter((legacy) => !ITEM_BY_ID.has(legacy.id)).map((legacy) => legacy.id);
}

export interface MovedItem {
  id: string;
  from: LegacyGroupId;
  to: SettingsGroupId;
}

/** 묶음을 옮긴 항목. 보고서에 그대로 쓰는 값이다. */
export function movedItems(): MovedItem[] {
  const moved: MovedItem[] = [];
  for (const legacy of PRE_INT30_ITEMS) {
    const item = ITEM_BY_ID.get(legacy.id);
    if (item && (item.group as string) !== (legacy.group as string)) {
      moved.push({ id: legacy.id, from: legacy.group, to: item.group });
    }
  }
  return moved;
}

/** 이번에 새로 생긴 항목. */
export function addedItems(): SettingsItem[] {
  return SETTINGS_ITEMS.filter((item) => item.from === null);
}

export function destructiveItems(): SettingsItem[] {
  return SETTINGS_ITEMS.filter((item) => item.risk === 'destructive');
}

/** 사용자가 바꾸는 지속 선택. 읽기 전용과 절대 같은 모양이면 안 되는 쪽. */
export function persistentChoices(): SettingsItem[] {
  return SETTINGS_ITEMS.filter((item) => item.kind === 'choice');
}

/** 읽기 전용 상태·진단. 조작처럼 보이면 안 되는 쪽. */
export function readOnlyFacts(): SettingsItem[] {
  return SETTINGS_ITEMS.filter((item) => item.kind === 'status');
}

/**
 * 실제로 그려진 항목 id 목록을 등록소 순서로 정렬한 기대값.
 * 게이트는 DOM에서 읽은 순서를 이 값과 비교한다 — 조건부 항목이 있어도 판정이 성립한다.
 */
export function expectedItemOrder(presentIds: readonly string[]): string[] {
  const present = new Set(presentIds);
  return SETTINGS_ITEMS.filter((item) => present.has(item.id)).map((item) => item.id);
}
