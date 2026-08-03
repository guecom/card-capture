import { describe, expect, it } from 'vitest';
import { buildResearchInstruction } from './research';
import {
  RESEARCH_INSTRUCTION_MAX,
  RESEARCH_SCOPES,
  composeResearchInstruction,
  decomposeResearchInstruction,
  nextResearchScopeSelection,
  normalizeResearchScopeKeys,
  researchDraftFilled,
  researchSelectAllLabel,
  researchSelectAllPressed,
  researchSelectionCountLabel,
  researchSelectionState,
  researchTextBudget,
  toggleResearchScope,
} from './research-scope';

const ALL = RESEARCH_SCOPES.map((scope) => scope.key);

describe('조사 항목 목록', () => {
  it('founder가 이름을 댄 항목이 실제로 있다', () => {
    // "실력, 전문성 추정, 의사 결정 권한 등 블록으로 돼 있는 것들" (founder 2026-08-04)
    const labels = RESEARCH_SCOPES.map((scope) => scope.label);
    expect(labels).toContain('실력·역량 근거');
    expect(labels).toContain('전문 분야');
    expect(labels).toContain('의사결정 권한·직급');
    expect(labels).toContain('최근 활동·발표');
    expect(labels).toContain('소속 조직·사업 맥락');
    expect(labels).toContain('함께 아는 사람·접점');
    expect(labels).toContain('대화 시작점');
  });

  it('키와 라벨이 서로 겹치지 않는다 — 겹치면 되돌리기가 깨진다', () => {
    expect(new Set(ALL).size).toBe(RESEARCH_SCOPES.length);
    expect(new Set(RESEARCH_SCOPES.map((scope) => scope.label)).size).toBe(RESEARCH_SCOPES.length);
  });

  it('모두 고른 문장이 민감 특성 위험 표식을 하나도 켜지 않는다', () => {
    // 표면만 바꾸고 권한은 그대로다 (DEC-000035). 항목 이름이 정책 경계를 건드리면 안 된다.
    const submission = buildResearchInstruction(composeResearchInstruction({ scopeKeys: ALL, text: '' }));
    expect(submission).not.toBeNull();
    expect(submission!.riskFlags).toEqual([]);
    expect(submission!.policyVersion).toBe('public-research-v1');
  });
});

describe('composeResearchInstruction / decomposeResearchInstruction', () => {
  it('고른 항목이 없으면 자유 입력 그 자체다 — 이 기능 이전에 저장된 값이 그대로 살아난다', () => {
    expect(composeResearchInstruction({ scopeKeys: [], text: '최근 발표 확인' })).toBe('최근 발표 확인');
    expect(decomposeResearchInstruction('최근 발표 확인')).toEqual({ scopeKeys: [], text: '최근 발표 확인' });
  });

  it('항목과 자유 입력이 한 문장으로 합쳐지고, 그대로 되돌아온다', () => {
    const draft = { scopeKeys: ['authority', 'capability'], text: '특히 국내 레퍼런스 위주로' };
    const composed = composeResearchInstruction(draft);
    expect(composed).toBe('조사 항목: 실력·역량 근거, 의사결정 권한·직급\n특히 국내 레퍼런스 위주로');
    // 항목 순서는 누른 순서가 아니라 목록 순서다 — 같은 선택이면 언제나 같은 문장이다.
    expect(decomposeResearchInstruction(composed)).toEqual({
      scopeKeys: ['capability', 'authority'],
      text: '특히 국내 레퍼런스 위주로',
    });
  });

  it('자유 입력을 한 글자도 건드리지 않는다 — 타이핑 중 공백·줄바꿈까지 그대로다', () => {
    for (const text of ['', ' ', '앞뒤 공백 ', '\n첫 줄이 빈 글', '여러\n줄\n\n글', '  들여쓴 글  ']) {
      expect(decomposeResearchInstruction(composeResearchInstruction({ scopeKeys: ALL, text })).text).toBe(text);
    }
  });

  it('항목만 고르고 아무것도 안 적어도 보낼 문장이 된다', () => {
    const composed = composeResearchInstruction({ scopeKeys: ['opener'], text: '' });
    expect(composed).toBe('조사 항목: 대화 시작점');
    expect(decomposeResearchInstruction(composed)).toEqual({ scopeKeys: ['opener'], text: '' });
    expect(buildResearchInstruction(composed)?.raw).toBe('조사 항목: 대화 시작점');
  });

  it('모르는 말이 한 조각이라도 섞이면 전부 자유 입력으로 둔다', () => {
    // 사용자가 우연히 비슷하게 쓴 문장을 항목으로 삼켜 버리지 않는다.
    const typed = '조사 항목: 실력·역량 근거, 집주소';
    expect(decomposeResearchInstruction(typed)).toEqual({ scopeKeys: [], text: typed });
    expect(decomposeResearchInstruction('조사 항목: 아무거나')).toEqual({ scopeKeys: [], text: '조사 항목: 아무거나' });
    expect(decomposeResearchInstruction('조사 항목: ')).toEqual({ scopeKeys: [], text: '조사 항목: ' });
  });

  it('정확히 그 형식을 손으로 적으면 항목으로 읽히지만, 잃는 글자는 없다 (멱등)', () => {
    const typed = '조사 항목: 전문 분야';
    const draft = decomposeResearchInstruction(typed);
    expect(draft.scopeKeys).toEqual(['expertise']);
    expect(composeResearchInstruction(draft)).toBe(typed);
  });

  it('알 수 없는 키는 조용히 버린다', () => {
    expect(normalizeResearchScopeKeys(['opener', 'politics', 'opener'])).toEqual(['opener']);
    expect(composeResearchInstruction({ scopeKeys: ['politics'], text: 'x' })).toBe('x');
  });
});

describe('모두 선택 3단 토글', () => {
  it('아무것도 없음 → 전부 → 없음으로 돈다', () => {
    expect(researchSelectionState([])).toBe('none');
    const all = nextResearchScopeSelection([]);
    expect(all).toEqual(ALL);
    expect(researchSelectionState(all)).toBe('all');
    expect(nextResearchScopeSelection(all)).toEqual([]);
  });

  it('일부만 골랐을 때 누르면 비우지 않고 전부를 채운다', () => {
    // founder: "비즈니스 미팅 등에서 만난 사람들을 등록할 때 보통 다 누르게 되더라고."
    const partial = ['capability', 'opener'];
    expect(researchSelectionState(partial)).toBe('partial');
    expect(nextResearchScopeSelection(partial)).toEqual(ALL);
  });

  it('버튼 글자가 지금 상태의 사실을 말한다', () => {
    expect(researchSelectAllLabel([])).toBe('모두 선택');
    expect(researchSelectAllLabel(['capability'])).toBe('모두 선택');
    expect(researchSelectAllLabel(ALL)).toBe('모두 해제');
  });

  it('일부 선택은 aria-pressed=mixed다', () => {
    expect(researchSelectAllPressed([])).toBe('false');
    expect(researchSelectAllPressed(['capability'])).toBe('mixed');
    expect(researchSelectAllPressed(ALL)).toBe('true');
  });

  it('개수를 언제나 숫자로 읽을 수 있다', () => {
    expect(researchSelectionCountLabel([])).toBe(`${ALL.length}개 중 0개 선택`);
    expect(researchSelectionCountLabel(['capability', 'opener'])).toBe(`${ALL.length}개 중 2개 선택`);
    expect(researchSelectionCountLabel(ALL)).toBe(`${ALL.length}개 중 ${ALL.length}개 선택`);
  });
});

describe('toggleResearchScope', () => {
  it('같은 항목을 다시 누르면 끈다', () => {
    expect(toggleResearchScope([], 'opener')).toEqual(['opener']);
    expect(toggleResearchScope(['opener'], 'opener')).toEqual([]);
  });

  it('끄고 켜도 순서는 언제나 목록 순서다', () => {
    expect(toggleResearchScope(['opener'], 'capability')).toEqual(['capability', 'opener']);
  });

  it('모르는 항목은 켜지 않는다', () => {
    expect(toggleResearchScope(['opener'], 'health')).toEqual(['opener']);
  });
});

describe('보낼 것이 있는가 / 글자 예산', () => {
  it('항목만 골라도, 글만 적어도 보낼 수 있다', () => {
    expect(researchDraftFilled({ scopeKeys: [], text: '' })).toBe(false);
    expect(researchDraftFilled({ scopeKeys: [], text: '   ' })).toBe(false);
    expect(researchDraftFilled({ scopeKeys: ['opener'], text: '' })).toBe(true);
    expect(researchDraftFilled({ scopeKeys: [], text: '실력 확인' })).toBe(true);
  });

  it('항목을 고를수록 자유 입력 상한이 줄어, 합쳐진 문장이 조용히 잘리지 않는다', () => {
    expect(researchTextBudget([])).toBe(RESEARCH_INSTRUCTION_MAX);
    const budget = researchTextBudget(ALL);
    expect(budget).toBeLessThan(RESEARCH_INSTRUCTION_MAX);
    const composed = composeResearchInstruction({ scopeKeys: ALL, text: 'ㄱ'.repeat(budget) });
    expect(composed).toHaveLength(RESEARCH_INSTRUCTION_MAX);
    // 정책 sanitize가 자르지 않는다 = 사용자가 적은 글이 통째로 도착한다.
    expect(buildResearchInstruction(composed)!.raw).toHaveLength(RESEARCH_INSTRUCTION_MAX);
  });
});
