import { describe, expect, it } from 'vitest';
import {
  QUICK_NAME_LATER_LABEL,
  QUICK_NAME_STATUS_COPY,
  queueRowName,
  quickNameReadingCopy,
  UNKNOWN_NAME_LABEL,
} from './capture-name';

// FI-067: 이름을 모르는 것은 정상 결과다. 문구가 빈칸을 숙제나 실패로 만들면 안 된다.
describe('an unknown name is a normal outcome (FI-067)', () => {
  it('never tells the user a blank name is theirs to finish', () => {
    const settled = [
      QUICK_NAME_STATUS_COPY.unreadable,
      QUICK_NAME_STATUS_COPY.blank,
      QUICK_NAME_STATUS_COPY.later,
    ];
    settled.forEach((copy) => {
      expect(copy, `숙제를 지우는 문구: ${copy}`).not.toMatch(/직접 확인해 주세요|이름을 입력해 주세요/);
      expect(copy, `실패로 읽히는 문구: ${copy}`).not.toMatch(/실패|오류|필수/);
    });
    // 못 읽은 결과와 나중에 하겠다는 선택 모두 "나중에 해도 된다"는 사실을 말한다.
    expect(QUICK_NAME_STATUS_COPY.unreadable).toMatch(/나중에/);
    expect(QUICK_NAME_STATUS_COPY.later).toMatch(/나중에/);
  });

  it('keeps the recognised-name copy that the existing surface gate pins', () => {
    // offline-shell.spec.ts가 이 문구를 정확히 기대한다 — 이름을 읽어낸 경우의 계약은 그대로다.
    expect(QUICK_NAME_STATUS_COPY.read).toBe('인식 완료 · 확인해 주세요');
    expect(QUICK_NAME_STATUS_COPY.confirmed).toBe('직접 확인됨');
  });

  it('offers an explicit way to say the name is unknown', () => {
    expect(QUICK_NAME_LATER_LABEL).toBe('모름 / 나중에');
  });

  it('reports recognition progress only while it is actually running', () => {
    expect(quickNameReadingCopy()).toBe('이름 읽는 중…');
    expect(quickNameReadingCopy(42)).toBe('이름 읽는 중 42%');
    // 끝난 뒤의 문구에는 `대기`도 `읽는 중`도 남지 않는다.
    expect(QUICK_NAME_STATUS_COPY.unreadable).not.toMatch(/대기|읽는 중/);
    expect(QUICK_NAME_STATUS_COPY.later).not.toMatch(/대기|읽는 중/);
  });

  it('labels a nameless capture as undecided, never as still waiting for recognition', () => {
    expect(UNKNOWN_NAME_LABEL).toBe('이름 미정');
    expect(queueRowName(undefined, null)).toBe('이름 미정');
    expect(queueRowName(undefined, null)).not.toMatch(/대기/);
    expect(queueRowName('', { name: '   ', source: 'ppocr', confidence: 10, confirmed: false, recognizedAt: '' })).toBe('이름 미정');
  });

  it('prefers the processed name, then the name confirmed while shooting', () => {
    const quick = { name: '김민서', source: 'user_corrected', confidence: 0, confirmed: true, recognizedAt: '' };
    expect(queueRowName('박지훈', quick)).toBe('박지훈');
    expect(queueRowName(undefined, quick)).toBe('김민서');
    expect(queueRowName('  ', quick)).toBe('김민서');
  });
});
