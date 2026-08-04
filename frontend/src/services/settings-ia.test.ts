import { describe, expect, it } from 'vitest';
import {
  PRE_INT30_ITEMS,
  SETTINGS_GROUPS,
  SETTINGS_ITEMS,
  addedItems,
  destructiveItems,
  droppedLegacyItems,
  expectedItemOrder,
  movedItems,
  persistentChoices,
  readOnlyFacts,
  settingsGroupOrder,
  settingsItem,
  settingsItemIndex,
  settingsItemsOf,
} from './settings-ia';

describe('묶음 순서 = 방문 job 순서', () => {
  it('founder가 요구한 순서 그대로다', () => {
    // 처음 오는 이유 → 자주 오는 이유 → 상태 확인 → 드물고 위험한 일 → 막혔을 때.
    expect(SETTINGS_GROUPS.map((group) => group.label)).toEqual([
      '계정·연결',
      '캡처·조사',
      '알림',
      '데이터·개인정보',
      '앱 정보·지원',
    ]);
    expect(settingsGroupOrder()).toEqual(['account', 'capture', 'notify', 'data', 'about']);
  });

  it('처음 방문 job이 맨 앞이고 드문 방문이 뒤에 온다', () => {
    expect(SETTINGS_GROUPS[0].visit).toBe('first');
    // `first`는 하나뿐이어야 한다 — 반드시 해야 하는 일이 둘이면 무엇부터인지가 다시 사라진다.
    expect(SETTINGS_GROUPS.filter((group) => group.visit === 'first')).toHaveLength(1);
    const rareStartsAt = SETTINGS_GROUPS.findIndex((group) => group.visit === 'rare');
    expect(SETTINGS_GROUPS.slice(rareStartsAt).every((group) => group.visit === 'rare')).toBe(true);
  });

  it('묶음마다 낭독기가 읽을 제목 id가 서로 다르다', () => {
    const ids = SETTINGS_GROUPS.map((group) => group.headingId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith('settings-job-'))).toBe(true);
  });
});

describe('항목 누락 0건', () => {
  // 재배치의 가장 큰 위험은 미학이 아니라 분실이다.
  it('이전 판의 항목이 하나도 사라지지 않았다', () => {
    expect(droppedLegacyItems()).toEqual([]);
  });

  it('이전 판 항목 전부가 새 묶음 중 하나에 자리를 갖는다', () => {
    for (const legacy of PRE_INT30_ITEMS) {
      const item = settingsItem(legacy.id);
      expect(item, `${legacy.id}(${legacy.label})가 새 정보구조에서 사라졌다`).toBeDefined();
      expect(settingsGroupOrder()).toContain(item!.group);
    }
  });

  it('옮긴 항목은 어디에서 어디로 갔는지 말할 수 있다', () => {
    // `화면` 묶음을 없애고 그 안의 둘을 `캡처·조사`로 넣은 것이 이번 재구성의 핵심 이동이다.
    expect(movedItems()).toEqual([
      { id: 'theme', from: 'display', to: 'capture' },
      { id: 'motion-note', from: 'display', to: 'capture' },
    ]);
  });

  it('새로 생긴 항목은 이 제품이 실제로 소유한 것뿐이다', () => {
    // team·billing·integration 같은 개수 맞추기용 SaaS 설정을 넣지 않는다.
    expect(addedItems().map((item) => item.id).sort()).toEqual([
      'connect-next-step',
      'diagnostics',
      'now-facts',
      'research-availability',
      'support-entry',
    ]);
  });

  it('id가 중복되지 않고 모든 항목이 실재하는 묶음에 속한다', () => {
    const ids = SETTINGS_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of SETTINGS_ITEMS) expect(settingsGroupOrder()).toContain(item.group);
  });
});

describe('위험도 분류', () => {
  it('되돌릴 수 없는 항목은 연결 해제 하나뿐이다', () => {
    expect(destructiveItems().map((item) => item.id)).toEqual(['disconnect']);
  });

  it('위계와 위험도가 어긋나지 않는다', () => {
    for (const item of SETTINGS_ITEMS) {
      if (item.kind === 'danger') expect(item.risk, `${item.id}`).toBe('destructive');
      else expect(item.risk, `${item.id}`).not.toBe('destructive');
      // 읽기 전용은 어떤 대가도 만들지 않는다 — 만든다면 그것은 읽기 전용이 아니다.
      if (item.kind === 'status') expect(item.risk, `${item.id}`).toBe('none');
      else expect(item.risk, `${item.id}`).not.toBe('none');
    }
  });

  it('되돌릴 수 없는 항목은 자기 묶음의 맨 마지막이다', () => {
    for (const item of destructiveItems()) {
      const siblings = settingsItemsOf(item.group);
      expect(siblings[siblings.length - 1].id, `${item.id}가 묶음의 마지막이 아니다`).toBe(item.id);
    }
  });

  it('되돌릴 수 없는 항목 앞에 모든 지속 선택이 온다', () => {
    // 위험한 것을 먼저 만나는 화면은 사용자가 스크롤을 멈추게 만든다.
    const dangerAt = settingsItemIndex('disconnect');
    for (const choice of persistentChoices()) {
      expect(settingsItemIndex(choice.id), `${choice.id}가 위험 영역 뒤에 있다`).toBeLessThan(dangerAt);
    }
  });

  it('접히는 것은 지원 진입 안쪽뿐이다', () => {
    for (const item of SETTINGS_ITEMS.filter((candidate) => candidate.collapsed)) {
      expect(item.group, `${item.id}가 지원 밖에서 접혀 있다`).toBe('about');
    }
    // 지속 선택은 절대 접지 않는다 — 접힌 선택은 없는 선택이다.
    expect(persistentChoices().every((item) => !item.collapsed)).toBe(true);
    // 위험한 것도 접지 않는다. 숨긴 위험은 발견됐을 때 더 나쁘다.
    expect(destructiveItems().every((item) => !item.collapsed)).toBe(true);
  });

  it('읽기 전용과 지속 선택이 겹치지 않는다', () => {
    const facts = new Set(readOnlyFacts().map((item) => item.id));
    for (const choice of persistentChoices()) expect(facts.has(choice.id)).toBe(false);
    expect(readOnlyFacts().length).toBeGreaterThan(0);
    expect(persistentChoices().length).toBeGreaterThan(0);
  });
});

describe('화면 순서 기대값', () => {
  it('조건부 항목이 없어도 남은 항목의 순서를 판정할 수 있다', () => {
    const withoutNextStep = SETTINGS_ITEMS.filter((item) => item.id !== 'connect-next-step').map((item) => item.id);
    expect(expectedItemOrder(withoutNextStep)).toEqual(withoutNextStep);
    // 순서가 뒤섞인 입력을 줘도 등록소 순서로 되돌린다 — DOM 비교의 기준이 되는 성질이다.
    expect(expectedItemOrder(['version', 'theme', 'capturer-name'])).toEqual(['capturer-name', 'theme', 'version']);
  });

  it('묶음별 항목은 전체 순서와 어긋나지 않는다', () => {
    let cursor = -1;
    for (const group of settingsGroupOrder()) {
      for (const item of settingsItemsOf(group)) {
        const at = settingsItemIndex(item.id);
        expect(at, `${item.id}의 자리가 묶음 순서와 어긋난다`).toBeGreaterThan(cursor);
        cursor = at;
      }
    }
    expect(cursor).toBe(SETTINGS_ITEMS.length - 1);
  });
});
