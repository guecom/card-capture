import { describe, expect, it } from 'vitest';
import type { CaptureMethodCard } from '../contracts/int30';
import {
  CAPTURE_METHOD_ACTION,
  CAPTURE_METHOD_FALLBACK_OUTCOME,
  CAPTURE_METHOD_ORDER,
  CAPTURE_RECOVERY_FALLBACK_LABEL,
  CAPTURE_UNAVAILABLE_FALLBACK_REASON,
  CONTEXT_EXAMPLE_LABEL,
  CONTEXT_FIELD_TOTAL,
  captureCardAnatomy,
  captureMethodColumns,
  contextWeight,
  isCalmInvite,
  orderCaptureMethods,
} from './capture-entry';

function card(patch: Partial<CaptureMethodCard> & Pick<CaptureMethodCard, 'id'>): CaptureMethodCard {
  return { title: '제목', description: '한 줄 설명', available: true, ...patch };
}

describe('orderCaptureMethods', () => {
  it('명함 촬영과 직접 입력을 첫 두 자리에 붙여 둔다', () => {
    // 생산자가 어떤 순서로 주든 화면 순서는 하나다 — 두 입구의 인접성이 founder 결정(DEC-000103)이다.
    const ordered = orderCaptureMethods([card({ id: 'upload' }), card({ id: 'manual' }), card({ id: 'camera' })]);
    expect(ordered.map((entry) => entry.id)).toEqual(['camera', 'manual', 'upload']);
  });

  it('일부만 있어도 남은 것끼리의 순서를 지킨다', () => {
    expect(orderCaptureMethods([card({ id: 'manual' }), card({ id: 'camera' })]).map((entry) => entry.id))
      .toEqual(['camera', 'manual']);
    expect(orderCaptureMethods([card({ id: 'upload' }), card({ id: 'camera' })]).map((entry) => entry.id))
      .toEqual(['camera', 'upload']);
  });

  it('같은 입구가 두 번 오면 하나만 남긴다', () => {
    // 중복 카드는 grid 칸 수를 바꿔 "두 입구가 같은 줄"이라는 계약을 조용히 깬다.
    const ordered = orderCaptureMethods([
      card({ id: 'camera', title: '첫 번째' }),
      card({ id: 'camera', title: '두 번째' }),
      card({ id: 'manual' }),
    ]);
    expect(ordered).toHaveLength(2);
    expect(ordered[0].title).toBe('첫 번째');
  });

  it('모르는 입구도 버리지 않고 맨 뒤에 남긴다', () => {
    // 조용히 사라진 입구는 "이유 없이 없는 버튼"이 된다.
    const future = { id: 'nfc', title: '태그', description: '설명', available: true } as unknown as CaptureMethodCard;
    const ordered = orderCaptureMethods([future, card({ id: 'camera' })]);
    expect(ordered.map((entry) => entry.id)).toEqual(['camera', 'nfc']);
  });

  it('빈 목록에도 터지지 않는다', () => {
    expect(orderCaptureMethods([])).toEqual([]);
  });
});

describe('captureCardAnatomy', () => {
  it('모든 카드가 제목·outcome·action을 빠짐없이 갖는다', () => {
    for (const id of CAPTURE_METHOD_ORDER) {
      const anatomy = captureCardAnatomy(card({ id }));
      expect(anatomy.title, `${id} 제목이 비었다`).not.toBe('');
      expect(anatomy.outcome, `${id} 설명이 비었다`).not.toBe('');
      expect(anatomy.action, `${id} 행동 문구가 비었다`).not.toBe('');
      expect(anatomy.action).toBe(CAPTURE_METHOD_ACTION[id]);
    }
  });

  it('설명이 비어 와도 빈 줄을 남기지 않는다', () => {
    // 정확히 이 상태가 founder가 본 "하나는 설명이 있고 하나는 없고"다.
    const anatomy = captureCardAnatomy(card({ id: 'manual', description: '   ' }));
    expect(anatomy.outcome).toBe(CAPTURE_METHOD_FALLBACK_OUTCOME.manual);
  });

  it('상태 뱃지는 설명 자리를 빼앗지 않는다', () => {
    const anatomy = captureCardAnatomy(card({ id: 'manual' }), { status: '이어서 쓰기' });
    expect(anatomy.status).toBe('이어서 쓰기');
    expect(anatomy.outcome).toBe('한 줄 설명');
  });

  it('쓸 수 있는 카드에는 이유도 회복 버튼도 남지 않는다', () => {
    const anatomy = captureCardAnatomy(card({
      id: 'camera',
      available: true,
      unavailableReason: '예전에 거절했어요',
      recovery: { kind: 'permission', label: '다시 요청' },
    }));
    expect(anatomy.reason).toBe('');
    expect(anatomy.recovery).toBeNull();
  });

  it('못 쓰는 카드는 이유와 행동을 함께 갖는다', () => {
    const anatomy = captureCardAnatomy(card({
      id: 'camera',
      available: false,
      unavailableReason: '카메라 권한이 꺼져 있어요',
      recovery: { kind: 'permission', label: '권한 다시 요청' },
    }));
    expect(anatomy.reason).toBe('카메라 권한이 꺼져 있어요');
    expect(anatomy.recovery).toEqual({ kind: 'permission', label: '권한 다시 요청' });
  });

  it('이유가 비어 와도 카드가 말없이 흐려지지 않는다', () => {
    const anatomy = captureCardAnatomy(card({ id: 'camera', available: false, unavailableReason: '' }));
    expect(anatomy.reason).toBe(CAPTURE_UNAVAILABLE_FALLBACK_REASON);
  });

  it('회복 버튼 문구가 비어 와도 누를 것이 남는다', () => {
    for (const kind of ['permission', 'setup', 'help'] as const) {
      const anatomy = captureCardAnatomy(card({
        id: 'camera',
        available: false,
        unavailableReason: '이유',
        recovery: { kind, label: '  ' },
      }));
      expect(anatomy.recovery?.label).toBe(CAPTURE_RECOVERY_FALLBACK_LABEL[kind]);
    }
  });
});

describe('captureMethodColumns', () => {
  it('혼자 남은 카드는 반만 그리지 않는다', () => {
    expect(captureMethodColumns(1)).toBe(1);
  });

  it('둘 이상은 언제나 두 칸이다 — 첫 줄의 두 입구가 칸 수보다 먼저다', () => {
    expect(captureMethodColumns(2)).toBe(2);
    expect(captureMethodColumns(3)).toBe(2);
    expect(captureMethodColumns(4)).toBe(2);
  });

  it('카드가 없어도 0으로 무너지지 않는다', () => {
    expect(captureMethodColumns(0)).toBe(1);
  });
});

describe('contextWeight', () => {
  it('rail 칸 수는 채운 개수와 무관하게 언제나 같다', () => {
    // 폭이 흔들리면 "진행"이 아니라 화면이 움직이는 것으로 읽힌다.
    for (let filled = 0; filled <= CONTEXT_FIELD_TOTAL; filled += 1) {
      expect(contextWeight(filled).segments).toHaveLength(CONTEXT_FIELD_TOTAL);
    }
  });

  it('채운 만큼 앞에서부터 켜진다', () => {
    expect(contextWeight(2).segments).toEqual([true, true, false, false]);
  });

  it('두 칸이면 충분하다 — 네 칸을 다 요구하면 그 순간 필수가 된다', () => {
    expect(contextWeight(0).tone).toBe('empty');
    expect(contextWeight(1).tone).toBe('started');
    expect(contextWeight(2).tone).toBe('rich');
    expect(contextWeight(4).tone).toBe('rich');
  });

  it('범위를 벗어난 값이 와도 rail이 깨지지 않는다', () => {
    expect(contextWeight(-3).filled).toBe(0);
    expect(contextWeight(9).filled).toBe(CONTEXT_FIELD_TOTAL);
    expect(contextWeight(9).segments).toEqual([true, true, true, true]);
  });
});

describe('isCalmInvite', () => {
  it('강제하는 말과 필수 표식을 걸러 낸다', () => {
    expect(isCalmInvite('필수 항목이에요')).toBe(false);
    expect(isCalmInvite('반드시 적어 주세요')).toBe(false);
    expect(isCalmInvite('만난 곳 *')).toBe(false);
    expect(isCalmInvite('Required')).toBe(false);
  });

  it('초대하는 말은 통과시킨다', () => {
    expect(isCalmInvite('나중에 이 사람을 떠올릴 단서예요')).toBe(true);
    expect(isCalmInvite('')).toBe(true);
  });

  it('이 화면이 실제로 쓰는 문구가 강제하지 않는다', () => {
    // 문구 상수가 나중에 바뀌어도 이 규칙은 같이 따라온다.
    const copy = [
      CONTEXT_EXAMPLE_LABEL,
      ...Object.values(CAPTURE_METHOD_ACTION),
      ...Object.values(CAPTURE_METHOD_FALLBACK_OUTCOME),
      CAPTURE_UNAVAILABLE_FALLBACK_REASON,
    ];
    for (const text of copy) expect(isCalmInvite(text), `강제하는 문구: ${text}`).toBe(true);
  });
});
