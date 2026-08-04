// 조사 깊이 계약 (TSK-000542).
//
// 이 파일이 지키는 것은 두 가지다.
//  A. 사용자가 고르는 값과 내부 라우팅이 **서로 다른 표**로 남아 있는가 — 사용자 문구 안에
//     binding 식별자나 공급자 이름이 한 글자도 섞이지 않았는가.
//  B. 라우팅이 버전 붙은 설정으로 **통째로 교체 가능한가**, 그리고 못 갈 때 어디로 내려가는가.
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_RESEARCH_DEPTH } from '../contracts/int30';
import {
  DEFAULT_RESEARCH_DEEP_STATE,
  RESEARCH_DEEP_CLOSED,
  RESEARCH_DEEP_MIN_SCOPES,
  RESEARCH_DELAY_WORDS,
  RESEARCH_DEPTHS,
  RESEARCH_ROUTE_R1,
  RESEARCH_WAIT_STEPS,
  type ResearchDeepState,
  type ResearchRouteConfig,
  evaluateResearchSubmit,
  normalizeResearchDeepState,
  normalizeResearchDepth,
  researchDelayWordsIn,
  researchDepthOption,
  researchDepthSummary,
  researchRouteConfig,
  researchSubmitLabel,
  resetResearchRouteConfig,
  resolveResearchRoute,
  setResearchRouteConfig,
} from './research-mode';

/** 사용자에게 절대 보이면 안 되는 말. 내부 식별자 + 흔한 공급자·모델 이름. */
const FORBIDDEN_LATIN = [
  ...Object.values(RESEARCH_ROUTE_R1.bindings),
  ...Object.values(RESEARCH_ROUTE_R1.fallbacks ?? {}),
  'gpt', 'claude', 'gemini', 'llama', 'mistral', 'opus', 'sonnet', 'haiku', 'anthropic', 'openai',
];
const FORBIDDEN_KOREAN = ['모델', '엔진', '공급자'];

/** 닫힘 상태를 설명하는 문구 전부. 지연 낱말 검사는 **이 목록에만** 건다. */
function deepClosedCopy(): string[] {
  const closed = evaluateResearchSubmit({ depth: 'deep', scopeCount: 1, hasText: true, deepState: 'closed' });
  return [
    RESEARCH_DEEP_CLOSED.short,
    RESEARCH_DEEP_CLOSED.detail,
    RESEARCH_DEEP_CLOSED.title,
    RESEARCH_DEEP_CLOSED.body,
    closed.notice!.title,
    closed.notice!.reason,
    closed.notice!.fix,
  ];
}

/** 사용자가 실제로 읽는 문자열만 모은다 — 키 이름(`depth`)은 화면에 나가지 않으므로 뺀다. */
function userFacingCopy(): string[] {
  const blocked = evaluateResearchSubmit({ depth: 'deep', scopeCount: 0, hasText: true, deepState: 'open' });
  // 깊은 조사가 닫혔을 때의 안내도 사용자가 읽는 말이다. 서버 설정 이름·오류 코드가 새기 가장 쉬운 자리다.
  const closed = evaluateResearchSubmit({ depth: 'deep', scopeCount: 1, hasText: true, deepState: 'closed' });
  return RESEARCH_DEPTHS.flatMap((option) => [option.label, option.short, option.detail])
    .concat(RESEARCH_DEPTHS.map((option) => researchDepthSummary(option.depth)))
    // 막힘 안내도 사용자가 읽는 말이다. 새로 생긴 문장이 이름 유출 검사 밖에 있으면 안 된다.
    .concat([blocked.notice!.title, blocked.notice!.reason, blocked.notice!.fix])
    .concat([closed.notice!.title, closed.notice!.reason, closed.notice!.fix])
    .concat(deepClosedCopy())
    .concat([researchSubmitLabel('완료', blocked), researchSubmitLabel('완료', closed)]);
}

describe('research depth — 사용자가 고르는 것', () => {
  it('세 갈래이고 순서는 얕은 것부터 깊은 것까지다', () => {
    expect(RESEARCH_DEPTHS.map((option) => option.depth)).toEqual(['quick', 'standard', 'deep']);
    expect(RESEARCH_DEPTHS.map((option) => option.wait)).toEqual([1, 2, 3]);
    expect(RESEARCH_DEPTHS.every((option) => option.wait <= RESEARCH_WAIT_STEPS)).toBe(true);
  });

  it('신규 요청 기본값은 일반 조사다', () => {
    expect(DEFAULT_RESEARCH_DEPTH).toBe('standard');
    expect(researchDepthOption(DEFAULT_RESEARCH_DEPTH).label).toBe('일반 조사');
  });

  it('세 이름은 founder가 말한 그대로다', () => {
    expect(RESEARCH_DEPTHS.map((option) => option.label)).toEqual(['빠른 조사', '일반 조사', '깊은 조사']);
  });

  it.each([undefined, null, '', 'turbo', 'DEEP', 42, {}])('알 수 없는 값(%s)은 기본 깊이로 되돌린다', (value) => {
    expect(normalizeResearchDepth(value)).toBe(DEFAULT_RESEARCH_DEPTH);
  });

  it('고른 깊이 한 줄 설명에는 이름과 결과·기다림이 함께 있다', () => {
    const summary = researchDepthSummary('deep');
    expect(summary).toContain('깊은 조사');
    expect(summary).toContain('기다리는 시간');
  });

  it('문구는 분·초를 약속하지 않는다', () => {
    // 못 지킬 숫자를 적으면 그 자체가 결함이다. 대기는 순서(눈금)로만 말한다.
    for (const text of userFacingCopy()) {
      expect(text, `대기 시간을 숫자로 약속한다: ${text}`).not.toMatch(/\d+\s*(초|분|시간|sec|min)/);
    }
  });
});

describe('research depth — 무엇이 연결되는지는 사용자에게 없다', () => {
  it('사용자 문구 어디에도 내부 식별자나 공급자 이름이 없다', () => {
    const found: string[] = [];
    for (const text of userFacingCopy()) {
      const lower = text.toLowerCase();
      for (const needle of FORBIDDEN_LATIN) {
        if (new RegExp(`\\b${needle}\\b`, 'i').test(lower)) found.push(`${needle} ← ${text}`);
      }
      for (const needle of FORBIDDEN_KOREAN) {
        if (text.includes(needle)) found.push(`${needle} ← ${text}`);
      }
    }
    expect(found, `사용자 문구에 내부 이름이 새어 나간다: ${found.join(' / ')}`).toEqual([]);
  });

  it('검사가 실제로 잡는다 — 일부러 섞으면 걸린다', () => {
    // 통과만 하는 검사는 검사가 아니다. 같은 판정을 오염된 문자열에 걸어 본다.
    const polluted = '깊은 조사 — sol 엔진으로 확인해요';
    const trapped = FORBIDDEN_LATIN.some((needle) => new RegExp(`\\b${needle}\\b`, 'i').test(polluted))
      || FORBIDDEN_KOREAN.some((needle) => polluted.includes(needle));
    expect(trapped).toBe(true);
  });

  it('깊이 표에는 binding 필드 자체가 없다', () => {
    for (const option of RESEARCH_DEPTHS) {
      expect(Object.keys(option).sort()).toEqual(['depth', 'detail', 'label', 'short', 'wait']);
    }
  });
});

// 계약 (`63_Research_Instruction_Contract.md` §Product Behavior):
//   "깊은 조사는 목적을 하나 이상 골라야 접수된다."
// 이 규칙이 화면이 아니라 여기 있어야 두 제출 자리가 같은 판정을 쓴다.
describe('research submit — 깊은 조사의 접수 조건', () => {
  const gate = (depth: unknown, scopeCount: number, hasText: boolean, deepState: ResearchDeepState = 'open') =>
    evaluateResearchSubmit({ depth, scopeCount, hasText, deepState });

  it('계약의 `하나 이상`이 실제로 1이다', () => {
    expect(RESEARCH_DEEP_MIN_SCOPES).toBe(1);
    expect(gate('deep', RESEARCH_DEEP_MIN_SCOPES, false).blocked).toBe(false);
    expect(gate('deep', RESEARCH_DEEP_MIN_SCOPES - 1, true).blocked).toBe(true);
  });

  it('깊은 조사 + 범위 0개 + 적은 내용 있음 → 막는다', () => {
    const result = gate('deep', 0, true);
    expect(result.state).toBe('blocked');
    expect(result.notice?.block).toBe('deep_requires_scope');
  });

  it('막을 때 깊이를 몰래 낮추지도, 범위를 대신 고르지도 않는다', () => {
    const result = gate('deep', 0, true);
    // 판정 결과에는 "고쳐 놓은 값"이 아예 없다. 고치는 것은 언제나 사람의 손이다.
    expect(Object.keys(result).sort()).toEqual(['blocked', 'notice', 'state']);
  });

  it('아직 아무것도 없으면 막지 않는다 — 촬영 저장까지 인질로 잡지 않는다', () => {
    const result = gate('deep', 0, false);
    expect(result.blocked).toBe(false);
    // 그래도 조건은 미리 말해 준다. 긴 글을 다 적은 뒤에 처음 알게 되면 늦다.
    expect(result.notice?.block).toBe('deep_requires_scope');
  });

  it('범위를 하나라도 고르면 즉시 풀리고 설명도 사라진다', () => {
    expect(gate('deep', 1, false)).toEqual({ state: 'ready', blocked: false, notice: null });
  });

  it.each(['quick', 'standard', 'turbo', undefined, null])('%s는 범위 0개여도 조이지 않는다', (depth) => {
    expect(gate(depth, 0, true)).toEqual({ state: 'ready', blocked: false, notice: null });
    expect(gate(depth, 0, false)).toEqual({ state: 'empty', blocked: false, notice: null });
  });

  it('이상한 숫자가 와도 규칙이 느슨해지지 않는다', () => {
    for (const count of [Number.NaN, -3, 0.4]) {
      expect(gate('deep', count, true).blocked, `범위 수 ${count}에서 규칙이 풀린다`).toBe(true);
    }
  });

  it('막힌 제출 버튼은 이름 자체로 이유와 회복 방법을 말한다', () => {
    // Ionic이 안쪽 버튼에 옮겨 주는 것은 `aria-label`뿐이라 이유가 **이름에** 실려야 도착한다.
    const label = researchSubmitLabel('완료', gate('deep', 0, true));
    expect(label).toContain('완료');
    expect(label).toContain('보낼 수 없어요');
    expect(label).toContain('일반 조사');
  });

  it('풀리면 이름이 원래대로 돌아온다 — 빈 값이 아니라 원래 글자로', () => {
    // `undefined`를 돌려주면 `ion-button`이 물려받은 옛 이름을 그대로 기억한 채 계속 읽는다.
    // 그 결함을 `e2e/int30-conformance.spec.ts`가 실제로 잡았으므로 여기서 형태로 못 박는다.
    expect(researchSubmitLabel('완료', gate('deep', 2, true))).toBe('완료');
    expect(researchSubmitLabel('완료', gate('standard', 0, true))).toBe('완료');
    expect(researchSubmitLabel('완료', gate('deep', 0, false))).toBe('완료');
  });
});

// ── 서버가 아직 말하지 않은 구간 (TSK-000560 / INT-000036) ────────────────────
//
// founder: "빠른조사, 일반조사는 그냥 선택할 수 있는데, 깊은 조사는 왜 버튼 클릭할 수 있을 때
// 까지 시간이 지나야하는지 모르겠네?" / "깊은 조사 활성화는 조건이 아니라 그냥 선택할 수 있게 해줘."
//
// 예전 판정은 `deepAvailable !== true`였다. 그 한 줄이 **못 들은 구간을 닫힘과 같게** 읽었고,
// 그래서 부팅 직후·오프라인에서 깊은 조사가 잠겨 있다가 목록 응답이 도착하는 순간 풀렸다.
// 세 값이 정말 셋으로 갈라져 있는지가 이 묶음이 잠그는 것이다.
describe('research submit — 못 들음과 닫힘은 다른 사실이다', () => {
  const gate = (deepState: ResearchDeepState, scopeCount = 3, hasText = true) =>
    evaluateResearchSubmit({ depth: 'deep', scopeCount, hasText, deepState });

  it('아무도 말해 주지 않았을 때의 기본값은 닫힘이 아니라 `unknown`이다', () => {
    expect(DEFAULT_RESEARCH_DEEP_STATE).toBe('unknown');
  });

  it('못 들은 동안에는 막지도, 경고를 그리지도 않는다', () => {
    // 안내 자체가 `null`이어야 한다 — 안내가 있으면 화면이 그것을 그리고, 사용자는 아직 아무도
    // 하지 않은 말을 읽게 된다.
    expect(gate('unknown')).toEqual({ state: 'ready', blocked: false, notice: null });
  });

  it('서버가 열었다고 말한 것과 아직 못 들은 것은 접수 판정이 같다', () => {
    // 다른 것은 **말해 줄 사실이 있는가**뿐이다. 접수를 막는 힘은 `closed` 하나만 갖는다.
    expect(gate('unknown')).toEqual(gate('open'));
  });

  it('닫혔다고 들은 경우에만 막는다', () => {
    expect(gate('closed').blocked).toBe(true);
    expect(gate('closed').notice?.block).toBe('deep_unavailable');
  });

  it('알 수 없는 값은 `unknown`으로 떨어진다 — 옛 boolean도 닫힘으로 되살아나지 않는다', () => {
    // `false`를 그대로 `closed`로 읽으면 못 들은 구간이 다시 닫힘이 되고 결함이 되돌아온다.
    for (const value of [undefined, null, '', 'true', 'false', true, false, 0, 1, {}]) {
      expect(normalizeResearchDeepState(value), `${String(value)}를 잘못 읽었다`).toBe('unknown');
    }
    expect(normalizeResearchDeepState('open')).toBe('open');
    expect(normalizeResearchDeepState('closed')).toBe('closed');
  });

  it('못 들은 동안에도 범위 규칙은 그대로 산다 — 한 조건을 풀면서 다른 조건까지 풀지 않는다', () => {
    expect(gate('unknown', 0, true).notice?.block).toBe('deep_requires_scope');
    expect(gate('unknown', 0, true).blocked).toBe(true);
  });

  it('빠른·일반은 세 값 어디서도 조여지지 않는다', () => {
    for (const deepState of ['unknown', 'open', 'closed'] as const) {
      for (const depth of ['quick', 'standard']) {
        expect(evaluateResearchSubmit({ depth, scopeCount: 0, hasText: true, deepState }))
          .toEqual({ state: 'ready', blocked: false, notice: null });
      }
    }
  });
});

// 계약 (INT-000036 승인안): "rollback flag가 deep Product surface 전체를 닫는 경우를
// per-request 지연 조건으로 가장하지 않는다."
describe('research submit — 닫힘을 지연으로 말하지 않는다', () => {
  it('닫힘 문구 어디에도 기다리면 풀린다는 낱말이 없다', () => {
    const found: string[] = [];
    for (const text of deepClosedCopy()) {
      for (const word of researchDelayWordsIn(text)) found.push(`${word} ← ${text}`);
    }
    expect(found, `닫힘을 지연처럼 말한다: ${found.join(' / ')}`).toEqual([]);
  });

  it('검사가 실제로 잡는다 — 일부러 섞으면 걸린다', () => {
    // 통과만 하는 검사는 검사가 아니다.
    expect(researchDelayWordsIn('깊은 조사는 잠시 후 다시 눌러 주세요')).toContain('잠시');
    expect(researchDelayWordsIn('연결 중이에요')).toContain('연결 중');
    expect(RESEARCH_DELAY_WORDS.length).toBeGreaterThan(5);
  });

  it('닫힘 문구는 고르는 것까지 막혔다고 말하지 않는다', () => {
    // 고를 수 있게 만들어 놓고 "못 골라요"라고 적으면 화면과 글이 서로 다른 말을 한다.
    for (const text of deepClosedCopy()) {
      expect(text, `고를 수 없다고 말한다: ${text}`).not.toContain('못 골라');
      expect(text, `고를 수 없다고 말한다: ${text}`).not.toContain('고를 수 없');
      expect(text, `고를 수 없다고 말한다: ${text}`).not.toContain('선택할 수 없');
    }
  });

  it('닫힘 문구는 무엇을 하면 되는지와 적어 둔 것이 안전하다는 사실을 말한다', () => {
    expect(RESEARCH_DEEP_CLOSED.body).toContain('일반 조사');
    // 깊이 칸의 호버·낭독기 문장도 **무엇이** 닫혔는지와 **무엇을 하면 되는지**를 스스로 말한다 —
    // 주어가 없으면 조사 요청 전체가 닫힌 것으로 읽힌다.
    expect(RESEARCH_DEEP_CLOSED.detail).toContain('깊은 조사');
    expect(RESEARCH_DEEP_CLOSED.detail).toContain('일반 조사');
    expect(`${RESEARCH_DEEP_CLOSED.body} ${RESEARCH_DEEP_CLOSED.detail}`).toContain('그대로');
  });
});

// 계약 (§Product Behavior): "Deep mode는 `DEEP_RESEARCH_ENABLED=true`가 명시된 경우에만 열린다.
// 누락·빈 값·`false`는 모두 fail-closed이며 `RESEARCH_INSTRUCTION_ENABLED=false`와 독립이다."
//
// 서버는 이 사실을 오래전부터 응답에 실어 보냈고 앱만 읽지 않았다. 규칙이 여기 있어야 두 제출
// 자리와 작성 자리가 같은 판정을 쓴다.
describe('research submit — 깊은 조사가 닫혀 있을 때', () => {
  const gate = (scopeCount: number, hasText: boolean, deepState: ResearchDeepState = 'closed') =>
    evaluateResearchSubmit({ depth: 'deep', scopeCount, hasText, deepState });

  it('서버가 열었다고 말한 응답에서만 열린다 — 나머지는 화면 쪽에서 `closed`로 접힌다', () => {
    // 서버 응답 한 칸을 화면 상태로 옮기는 규칙(App: `deepResearchEnabled === true ? open : closed`)을
    // 여기서 값으로 재현한다. `deepResearchEnabled` 칸이 없거나 참 같은 값이면 전부 닫힘이다.
    const asState = (value: unknown): ResearchDeepState => (value === true ? 'open' : 'closed');
    for (const value of [true, false, undefined, null, '', 'true', 0, 1]) {
      expect(gate(3, true, asState(value)).blocked, `${String(value)}를 잘못 읽었다`).toBe(value !== true);
    }
  });

  it('범위를 다 골라도 열리지 않는다 — 사용자가 이 자리에서 풀 수 있는 조건이 아니다', () => {
    const result = gate(9, true);
    expect(result.state).toBe('blocked');
    expect(result.notice?.block).toBe('deep_unavailable');
  });

  it('범위 조건보다 먼저 판정한다 — 풀 수 없는 조건을 뒤에 두면 사용자가 헛수고한다', () => {
    expect(gate(0, true).notice?.block).toBe('deep_unavailable');
  });

  it('아직 아무것도 없으면 막지 않되 같은 설명을 미리 보인다', () => {
    const result = gate(0, false);
    expect(result.blocked).toBe(false);
    expect(result.notice?.block).toBe('deep_unavailable');
  });

  it('깊이를 대신 낮추지 않는다 — 판정 결과에 고쳐 놓은 값이 없다', () => {
    expect(Object.keys(gate(3, true)).sort()).toEqual(['blocked', 'notice', 'state']);
  });

  it('빠른·일반은 이 스위치와 독립이다 — 하나가 닫혔다고 전부 닫히지 않는다', () => {
    for (const depth of ['quick', 'standard']) {
      expect(evaluateResearchSubmit({ depth, scopeCount: 0, hasText: true, deepState: 'closed' }))
        .toEqual({ state: 'ready', blocked: false, notice: null });
    }
  });

  it('막힌 제출 버튼 이름이 이유와 회복 방법을 함께 말한다', () => {
    const label = researchSubmitLabel('조사 요청 접수', gate(3, true));
    expect(label).toContain('조사 요청 접수');
    expect(label).toContain('보낼 수 없어요');
    expect(label).toContain('일반 조사');
  });
});

describe('research route — 버전 붙은 내부 설정', () => {
  // 전역 판을 만지는 검사가 섞여 있다. 앞 검사가 남긴 판이 뒤 검사의 전제가 되면 안 된다.
  beforeEach(() => { resetResearchRouteConfig(); });

  it('시작 판은 r1이고 세 깊이가 각자의 자리를 갖는다', () => {
    expect(researchRouteConfig().version).toBe('r1');
    expect(resolveResearchRoute('quick').binding).toBe('luna');
    expect(resolveResearchRoute('standard').binding).toBe('terra');
    expect(resolveResearchRoute('deep').binding).toBe('sol');
    expect(resolveResearchRoute('deep')).toMatchObject({ degraded: false, version: 'r1', depth: 'deep' });
  });

  it('판을 통째로 갈아 끼우면 같은 깊이가 다른 자리로 간다', () => {
    const r2: ResearchRouteConfig = {
      version: 'r2',
      bindings: { quick: 'terra', standard: 'sol', deep: 'nova' },
    };
    try {
      setResearchRouteConfig(r2);
      expect(resolveResearchRoute('deep')).toMatchObject({ binding: 'nova', version: 'r2', degraded: false });
      expect(resolveResearchRoute('quick').binding).toBe('terra');
      // 사용자 문구는 판을 바꿔도 그대로다 — 두 표가 정말 분리돼 있다는 증거다.
      expect(RESEARCH_DEPTHS.map((option) => option.label)).toEqual(['빠른 조사', '일반 조사', '깊은 조사']);
    } finally {
      resetResearchRouteConfig();
    }
    expect(resolveResearchRoute('deep').binding).toBe('sol');
  });

  it('반쪽 판은 거절한다 — 조용히 절반만 라우팅되는 상태를 만들지 않는다', () => {
    expect(() => setResearchRouteConfig({ version: '', bindings: RESEARCH_ROUTE_R1.bindings }))
      .toThrow('research_route_version_missing');
    expect(() => setResearchRouteConfig({ version: 'r9', bindings: { quick: 'luna', standard: '', deep: 'sol' } }))
      .toThrow('research_route_binding_missing');
    // 거절된 판은 지금 판을 건드리지 않았다.
    expect(researchRouteConfig().version).toBe('r1');
  });

  it('1차 자리를 못 쓰면 fallback으로 내려가고 이유가 남는다', () => {
    const route = resolveResearchRoute('deep', RESEARCH_ROUTE_R1, (binding) => binding !== 'sol');
    expect(route).toMatchObject({ depth: 'deep', binding: 'terra', degraded: true, reason: 'binding_unavailable' });
  });

  it('fallback마저 못 쓰면 라우팅되지 않았다고 말한다', () => {
    const route = resolveResearchRoute('deep', RESEARCH_ROUTE_R1, () => false);
    expect(route).toMatchObject({ binding: null, degraded: true, reason: 'no_binding' });
  });

  it('fallback이 아예 없는 판에서도 조용히 성공하지 않는다', () => {
    const bare: ResearchRouteConfig = { version: 'r3', bindings: { quick: 'luna', standard: 'terra', deep: 'sol' } };
    expect(resolveResearchRoute('quick', bare, () => false)).toMatchObject({ binding: null, reason: 'no_binding' });
  });

  it('모르는 깊이는 기본 자리로 가되 그 사실을 잃지 않는다', () => {
    const route = resolveResearchRoute('turbo');
    expect(route).toMatchObject({ depth: 'standard', binding: 'terra', degraded: true, reason: 'unknown_depth' });
  });

  it('순수 함수다 — 인자로 준 판이 전역 판을 바꾸지 않는다', () => {
    const other: ResearchRouteConfig = { version: 'rX', bindings: { quick: 'a', standard: 'b', deep: 'c' } };
    expect(resolveResearchRoute('deep', other).binding).toBe('c');
    expect(researchRouteConfig().version).toBe('r1');
  });
});
