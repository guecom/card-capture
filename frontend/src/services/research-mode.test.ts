// 조사 깊이 계약 (TSK-000542).
//
// 이 파일이 지키는 것은 두 가지다.
//  A. 사용자가 고르는 값과 내부 라우팅이 **서로 다른 표**로 남아 있는가 — 사용자 문구 안에
//     binding 식별자나 공급자 이름이 한 글자도 섞이지 않았는가.
//  B. 라우팅이 버전 붙은 설정으로 **통째로 교체 가능한가**, 그리고 못 갈 때 어디로 내려가는가.
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_RESEARCH_DEPTH } from '../contracts/int30';
import {
  RESEARCH_DEPTHS,
  RESEARCH_ROUTE_R1,
  RESEARCH_WAIT_STEPS,
  type ResearchRouteConfig,
  normalizeResearchDepth,
  researchDepthOption,
  researchDepthSummary,
  researchRouteConfig,
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

/** 사용자가 실제로 읽는 문자열만 모은다 — 키 이름(`depth`)은 화면에 나가지 않으므로 뺀다. */
function userFacingCopy(): string[] {
  return RESEARCH_DEPTHS.flatMap((option) => [option.label, option.short, option.detail])
    .concat(RESEARCH_DEPTHS.map((option) => researchDepthSummary(option.depth)));
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
