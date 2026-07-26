import { describe, expect, it } from 'vitest';
import { nameFromOcrWords, type OcrWord } from './quickname-picker';

function word(text: string, heightRatio: number, overrides: Partial<OcrWord> = {}): OcrWord {
  return { text, confidence: 0.9, heightRatio, centerRatio: 0.4, ...overrides };
}

describe('nameFromOcrWords', () => {
  it('picks the largest-font hangul line as the name (typical korean card)', () => {
    const picked = nameFromOcrWords([
      word('카이렌 로보틱스', 0.06),
      word('김진우', 0.12),
      word('대표이사', 0.05),
      word('서울시 강남구 테헤란로 12', 0.03, { centerRatio: 0.9 }),
    ]);
    expect(picked?.name).toBe('김진우');
  });

  it('extracts the name token when the title shares the line', () => {
    const picked = nameFromOcrWords([
      word('홍길동 대표이사', 0.11),
      word('로보텍 주식회사', 0.07),
    ]);
    expect(picked?.name).toBe('홍길동');
  });

  it('never picks company, titles, or contact lines', () => {
    const picked = nameFromOcrWords([
      word('주식회사 한빛로보틱스', 0.1),
      word('수석 매니저', 0.08),
      word('010-1234-5678', 0.06),
      word('gildong@robotech.kr', 0.06),
    ]);
    expect(picked).toBeNull();
  });

  it('font size beats reading order — name lower on the card still wins', () => {
    const picked = nameFromOcrWords([
      word('Kairen Robotics', 0.05, { centerRatio: 0.15 }),
      word('박민준', 0.13, { centerRatio: 0.6 }),
    ]);
    expect(picked?.name).toBe('박민준');
  });

  it('accepts english full names when no hangul name exists', () => {
    const picked = nameFromOcrWords([
      word('Jane Kim', 0.11),
      word('Chief Executive Officer', 0.05),
    ]);
    expect(picked?.name).toBe('Jane Kim');
  });

  it('drops low-confidence lines and reports confidence 0..100', () => {
    expect(nameFromOcrWords([word('김서연', 0.12, { confidence: 0.2 })])).toBeNull();
    const picked = nameFromOcrWords([word('김서연', 0.12, { confidence: 0.87 })]);
    expect(picked?.confidence).toBe(87);
  });

  // ── 로고를 크게 넣는 명함: v1은 여기서 회사명을 이름으로 뽑았다 (founder 판정 2026-07-26) ──

  it('does not pick the big all-caps logo over the smaller person name', () => {
    const picked = nameFromOcrWords([
      word('NOVARO', 0.16, { centerRatio: 0.18 }),      // 로고 — 카드에서 가장 큰 글자
      word('강수민', 0.09, { centerRatio: 0.45 }),
      word('Founder', 0.05, { centerRatio: 0.55 }),
      word('sumin@novaro.io', 0.04, { centerRatio: 0.72 }),
    ]);
    expect(picked?.name).toBe('강수민');
  });

  it('rejects a hangul company word that is not a person name', () => {
    // 카이렌·로보틱스는 2~4자 한글이지만 성씨로 시작하지 않거나 회사 어휘다.
    const picked = nameFromOcrWords([
      word('카이렌', 0.15, { centerRatio: 0.2 }),
      word('로보틱스', 0.12, { centerRatio: 0.3 }),
      word('윤도현', 0.08, { centerRatio: 0.5 }),
    ]);
    expect(picked?.name).toBe('윤도현');
  });

  it('returns null rather than guessing when only company text is present', () => {
    expect(nameFromOcrWords([
      word('NOVARO', 0.16),
      word('로보틱스', 0.12),
      word('스마트팩토리 솔루션', 0.06),
    ])).toBeNull();
  });

  it('uses the title on the neighbouring line to confirm an unusual surname', () => {
    const picked = nameFromOcrWords([
      word('두베르', 0.1, { centerRatio: 0.4 }),   // 성씨 목록에 없는 이름
      word('연구소장', 0.05, { centerRatio: 0.5 }),
    ]);
    expect(picked?.name).toBe('두베르');
  });

  it('accepts an all-caps english name when the email backs it up', () => {
    const picked = nameFromOcrWords([
      word('JANE KIM', 0.12, { centerRatio: 0.3 }),
      word('jane.kim@novaro.io', 0.04, { centerRatio: 0.8 }),
    ]);
    expect(picked?.name).toBe('JANE KIM');
  });

  it('prefers the email-corroborated english name over a larger brand line', () => {
    const picked = nameFromOcrWords([
      word('Novaro Systems', 0.14, { centerRatio: 0.2 }),
      word('Daniel Park', 0.09, { centerRatio: 0.45 }),
      word('daniel@novaro.io', 0.04, { centerRatio: 0.75 }),
    ]);
    expect(picked?.name).toBe('Daniel Park');
  });
});

describe('OCR 잡음 복원', () => {
  it('같은 줄이 여러 박스로 쪼개져도 영문 이름을 되붙인다', () => {
    // 실기기·CI 폰트 차이로 "Jane Kim"이 "Jane |" + "Kim"으로 나뉘는 일이 실제로 있었다.
    const picked = nameFromOcrWords([
      { text: 'ORBTAL', confidence: 0.9, heightRatio: 0.14, centerRatio: 0.2, leftRatio: 0.06 },
      { text: 'Jane |', confidence: 0.9, heightRatio: 0.085, centerRatio: 0.55, leftRatio: 0.06 },
      { text: 'Kim', confidence: 0.9, heightRatio: 0.085, centerRatio: 0.56, leftRatio: 0.26 },
      { text: 'jane.kim@orbital.dev', confidence: 0.9, heightRatio: 0.05, centerRatio: 0.86, leftRatio: 0.06 },
    ]);
    expect(picked?.name).toBe('Jane Kim');
  });

  // CI(windows-latest) 실측: 렌더가 흐려 'ORBITAL'이 'ORBTAL'로 읽히고 이름 줄이 두 박스로 쪼개졌다.
  // 이메일도 'jane.kim @orbital.dev'처럼 @ 앞이 띄어 읽혔다. 이 입력에서 픽커는 null을 돌려줬다.
  it('쪼개진 줄의 신뢰도가 낮아도 직함 줄이 붙어 있으면 이름을 살린다', () => {
    const picked = nameFromOcrWords([
      { text: 'ORBTAL', confidence: 0.88, heightRatio: 0.14, centerRatio: 0.2, leftRatio: 0.06 },
      { text: 'Jane |', confidence: 0.24, heightRatio: 0.085, centerRatio: 0.55, leftRatio: 0.06 },
      { text: 'Kim', confidence: 0.31, heightRatio: 0.085, centerRatio: 0.56, leftRatio: 0.26 },
      { text: 'Head of Partnerships', confidence: 0.9, heightRatio: 0.055, centerRatio: 0.68, leftRatio: 0.06 },
      { text: 'jane.kim @orbital.dev', confidence: 0.9, heightRatio: 0.05, centerRatio: 0.86, leftRatio: 0.06 },
    ]);
    expect(picked?.name).toBe('Jane Kim');
  });

  it('쪼개진 두 박스의 세로 중심이 어긋나도 이메일 아이디로 이름을 복원한다', () => {
    const picked = nameFromOcrWords([
      { text: 'ORBTAL', confidence: 0.88, heightRatio: 0.14, centerRatio: 0.2, leftRatio: 0.06 },
      { text: 'Jane |', confidence: 0.9, heightRatio: 0.07, centerRatio: 0.52, leftRatio: 0.06 },
      { text: 'Kim', confidence: 0.9, heightRatio: 0.11, centerRatio: 0.62, leftRatio: 0.26 },
      { text: 'jane.kim @orbital.dev', confidence: 0.9, heightRatio: 0.05, centerRatio: 0.86, leftRatio: 0.06 },
    ]);
    expect(picked?.name).toBe('Jane Kim');
  });

  it('이메일 아이디와 겹치지 않는 낱말은 이름으로 되붙이지 않는다', () => {
    const picked = nameFromOcrWords([
      { text: 'Smart', confidence: 0.9, heightRatio: 0.1, centerRatio: 0.3, leftRatio: 0.06 },
      { text: 'Factory', confidence: 0.9, heightRatio: 0.1, centerRatio: 0.62, leftRatio: 0.06 },
      { text: 'contact @orbital.dev', confidence: 0.9, heightRatio: 0.05, centerRatio: 0.86, leftRatio: 0.06 },
    ]);
    expect(picked).toBeNull();
  });

  it('세로획 잡음이 붙어도 한글 이름을 그대로 읽는다', () => {
    const picked = nameFromOcrWords([
      { text: '|이강규', confidence: 0.95, heightRatio: 0.1, centerRatio: 0.5, leftRatio: 0.06 },
      { text: 'Founder', confidence: 0.9, heightRatio: 0.05, centerRatio: 0.62, leftRatio: 0.06 },
    ]);
    expect(picked?.name).toBe('이강규');
  });
});
