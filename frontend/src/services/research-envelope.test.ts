// 조사 요청 봉투의 **서버 대조** 게이트 (INT-000030 / TSK-000542).
//
// 이 파일이 있는 이유는 하나다: 클라이언트가 서버에 없는 값을 보내는 결함이 **실제로 일어났고,
// 화면을 보는 어떤 검사도 그것을 잡지 못했다.** 세 깊이 버튼은 눌리고, 선택 상태는 남고, 화면
// 테스트는 전부 통과했는데, 서버로 나간 것은 `Code.gs`가 읽지도 않는 `depth` 한 칸이었다.
//
// 그래서 여기서는 화면을 보지 않는다. `Code.gs`를 **원문 그대로 읽어** allowlist를 뽑고,
// 클라이언트 등록소(`research-envelope.ts`)가 그 부분집합인지 검사한다. 한쪽만 바뀌면 깨진다.
import { describe, expect, it } from 'vitest';
// 서버 원문을 **그대로** 읽는다 (`api-origin.test.ts`와 같은 방법). 서버 값을 여기 옮겨 적으면
// 그 사본이 또 하나의 drift 원본이 된다 — 대조의 뜻이 사라진다.
import serverSource from '../../../Code.gs?raw';
import {
  RESEARCH_FOCUS_IDS,
  RESEARCH_MODES,
  RESEARCH_MODE_BY_DEPTH,
  RESEARCH_PURPOSES,
  RESEARCH_RAW_EXTRA_PREFIX,
  RESEARCH_SCOPE_WIRE,
  composeResearchRaw,
  downgradeQuickMode,
  quickModeRejected,
  researchFocusIds,
  researchModeOf,
  researchPurposes,
  researchRawExtraLabels,
  researchScopeWireGaps,
  sanitizeResearchRequestId,
} from './research-envelope';
import { DEFAULT_RESEARCH_DEPTH, RESEARCH_DEPTHS } from './research-mode';
import { RESEARCH_SCOPES } from './research-scope';

/** `var NAME_ = ['a', 'b'];` 한 줄에서 값만 뽑는다. 없으면 빈 배열이 아니라 실패다. */
function serverAllowlist(name: string): string[] {
  const match = new RegExp(`var\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(serverSource);
  if (!match) throw new Error(`Code.gs에 ${name}이(가) 없다`);
  return match[1].split(',').map((value) => value.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

describe('wire allowlist — 클라이언트가 서버에 없는 값을 보내지 않는가', () => {
  it('보내는 mode는 서버 allowlist 안에 있다', () => {
    const server = serverAllowlist('RESEARCH_MODES_');
    // 부분집합이면 충분하다 — 서버가 더 받는 것은 결함이 아니다. 반대는 결함이다.
    expect(RESEARCH_MODES.filter((mode) => !server.includes(mode)), '서버가 모르는 mode를 보낸다').toEqual([]);
  });

  it('세 깊이가 모두 서버가 아는 mode로 옮겨진다 — 하나라도 빠지면 그 선택은 요청이 되지 못한다', () => {
    const server = serverAllowlist('RESEARCH_MODES_');
    const unmapped = RESEARCH_DEPTHS
      .map((option) => ({ depth: option.depth, mode: RESEARCH_MODE_BY_DEPTH[option.depth] }))
      .filter((pair) => !server.includes(pair.mode));
    expect(unmapped, `서버가 모르는 깊이: ${JSON.stringify(unmapped)}`).toEqual([]);
    // 세 깊이가 서로 다른 mode로 가야 한다. 같은 값으로 뭉치면 선택이 뜻을 잃는다 — 그것이 결함이었다.
    expect(new Set(Object.values(RESEARCH_MODE_BY_DEPTH)).size).toBe(RESEARCH_DEPTHS.length);
  });

  it('보내는 focusId는 서버 allowlist와 정확히 같은 목록·순서다', () => {
    expect([...RESEARCH_FOCUS_IDS]).toEqual(serverAllowlist('RESEARCH_FOCUS_IDS_'));
  });

  it('보내는 purpose는 서버 allowlist와 정확히 같은 목록·순서다', () => {
    expect([...RESEARCH_PURPOSES]).toEqual(serverAllowlist('RESEARCH_PURPOSES_'));
  });

  it('만드는 requestId는 서버 `sanitizeRequestId_`가 받는 모양이다', () => {
    const match = /sanitizeRequestId_[\s\S]{0,200}?return\s+(\/\^[^/]+\/)\.test/.exec(serverSource);
    expect(match, 'Code.gs의 requestId 모양 검사를 찾지 못했다').not.toBeNull();
    // 서버 정규식을 그대로 되살려 클라이언트 판정과 대조한다 — 두 벌을 손으로 맞추지 않는다.
    const serverShape = new RegExp(match![1].slice(1, -1));
    for (const candidate of ['rr-abcdefghij', 'request-00000001', 'A-1234567']) {
      expect(serverShape.test(candidate)).toBe(true);
      expect(sanitizeResearchRequestId(candidate)).toBe(candidate);
    }
    for (const candidate of ['short', 'has space', '한글아이디입니다', 'x'.repeat(65)]) {
      expect(serverShape.test(candidate)).toBe(false);
      expect(sanitizeResearchRequestId(candidate)).toBe('');
    }
  });
});

describe('9개 화면 항목 ↔ 8개 서버 focusId 화해', () => {
  it('화면의 모든 범위가 표에 자리를 갖는다 — 새 항목이 조용히 사라지지 않는다', () => {
    expect(researchScopeWireGaps()).toEqual([]);
    expect(Object.keys(RESEARCH_SCOPE_WIRE).sort()).toEqual(RESEARCH_SCOPES.map((scope) => scope.key).sort());
  });

  it('여덟 개 서버 자리가 하나씩 정확히 쓰인다 — 두 항목이 한 자리를 나눠 쓰지 않는다', () => {
    const mapped = RESEARCH_SCOPES.map((scope) => RESEARCH_SCOPE_WIRE[scope.key].focusId).filter(Boolean);
    expect(new Set(mapped).size, '같은 focusId에 두 항목이 매핑됐다').toBe(mapped.length);
    expect([...mapped].sort()).toEqual([...RESEARCH_FOCUS_IDS].sort());
  });

  it('전부 고르면 서버 여덟 자리가 모두 채워진다', () => {
    const all = RESEARCH_SCOPES.map((scope) => scope.key);
    expect(researchFocusIds(all)).toEqual([...RESEARCH_FOCUS_IDS]);
  });

  it('자리가 없는 항목은 버리지 않고 자유 입력으로 넘어간다', () => {
    // `대화 시작점`은 서버 여덟 자리 중 어디에도 해당하지 않는다.
    expect(researchRawExtraLabels(['opener'])).toEqual(['대화 시작점']);
    expect(researchFocusIds(['opener'])).toEqual([]);
    expect(composeResearchRaw('공개 경력 확인', ['opener']))
      .toBe(`공개 경력 확인\n${RESEARCH_RAW_EXTRA_PREFIX}대화 시작점`);
    // 적은 글이 없어도 잃지 않는다 — 이 줄이 없으면 서버는 빈 요청으로 읽고 거절한다.
    expect(composeResearchRaw('', ['opener'])).toBe(`${RESEARCH_RAW_EXTRA_PREFIX}대화 시작점`);
  });

  it('제 칸이 있는 항목은 자유 입력에 다시 쓰지 않는다 — 구조화된 값을 글에 숨기지 않는다', () => {
    const all = RESEARCH_SCOPES.map((scope) => scope.key);
    const raw = composeResearchRaw('공개 경력 확인', all);
    for (const scope of RESEARCH_SCOPES) {
      const hasSlot = Boolean(RESEARCH_SCOPE_WIRE[scope.key].focusId);
      expect(raw.includes(scope.label), `${scope.key}: 자유 입력 포함 여부가 잘못됐다`).toBe(!hasSlot);
    }
    // 예전 형식(`조사 항목: …`)은 더 이상 나가지 않는다.
    expect(raw.startsWith('조사 항목: ')).toBe(false);
  });

  it('범위를 하나라도 고르면 목적이 하나 이상 나온다 — 화면 조건과 서버 조건이 같은 뜻이 된다', () => {
    for (const scope of RESEARCH_SCOPES) {
      expect(researchPurposes([scope.key]).length, `${scope.key}에 목적이 없다`).toBeGreaterThanOrEqual(1);
    }
  });

  it('목적과 focusId는 계약 순서로 정렬된다 — 같은 선택이면 언제나 같은 요청이다', () => {
    const shuffled = ['opener', 'authority', 'capability', 'authority'];
    expect(researchFocusIds(shuffled)).toEqual(['authority', 'outcomes']);
    expect(researchPurposes(shuffled)).toEqual(['meeting_preparation', 'expertise_execution', 'authority_interests']);
  });
});

describe('배포 창 되돌림 — 진짜 실패를 감추지 않는가', () => {
  const quick = { mode: 'quick' as const };

  it('`quick`이 mode 때문에 거절된 경우에만 참이다', () => {
    expect(quickModeRejected(quick, 'bad_research_request')).toBe(true);
  });

  it('다른 거절 사유는 되돌리지 않는다', () => {
    for (const error of ['daily_limit', 'owner_only', 'feature_disabled', 'target_mismatch', 'deep_feature_disabled', '', undefined]) {
      expect(quickModeRejected(quick, error), `${String(error)}를 mode 문제로 오인했다`).toBe(false);
    }
  });

  it('`quick`이 아니었던 요청은 절대 되돌리지 않는다 — 깊은 조사를 몰래 얕게 만들지 않는다', () => {
    expect(quickModeRejected({ mode: 'standard' }, 'bad_research_request')).toBe(false);
    expect(quickModeRejected({ mode: 'deep_evidence_graph' }, 'bad_research_request')).toBe(false);
    expect(quickModeRejected(null, 'bad_research_request')).toBe(false);
    expect(quickModeRejected(undefined, 'bad_research_request')).toBe(false);
  });

  it('되돌린 봉투는 mode 한 칸만 다르다 — 같은 요청이므로 멱등 키도 그대로다', () => {
    const envelope = { raw: '확인', mode: 'quick' as const, purposes: [], focusIds: ['career'], requestId: 'rr-abcdefghij' };
    expect(downgradeQuickMode(envelope)).toEqual({ ...envelope, mode: 'standard' });
  });

  it('깊이를 들고 있으면 깊이도 함께 내려간다 — 없는 상태를 기록으로 남기지 않는다', () => {
    // 깊이는 이제 서버 envelope에 남아 **처리 모델을 고르는 값**이다 (DEC-000110).
    // `mode`만 내리고 `depth: 'quick'`을 남기면 "표준으로 처리하면서 빠른 조사의 모델을 쓴 요청"이
    // 기록되는데, 그런 요청은 실재하지 않는다.
    const envelope = { raw: '확인', depth: 'quick' as const, mode: 'quick' as const, purposes: [], focusIds: ['career'], requestId: 'rr-abcdefghij' };
    expect(downgradeQuickMode(envelope)).toEqual({ ...envelope, depth: 'standard', mode: 'standard' });
  });

  it('깊이 칸이 없는 옛 봉투에는 깊이를 만들어 넣지 않는다', () => {
    expect('depth' in downgradeQuickMode({ mode: 'quick' as const })).toBe(false);
  });
});

// ── 깊이 자체가 서버로 나가는가 (DEC-000110 / TSK-000565) ─────────────────────
//
// founder: "빠른 조사, 일반 조사, 깊은 조사는 … 오직 모델만 차이가 있는 거야."
// 그 말이 참이려면 깊이가 **처리기까지** 살아서 도착해야 한다. 클라이언트가 보내도 서버가
// 모르는 값이면 그 자리에서 사라지므로, 여기서도 `Code.gs` 원문을 읽어 대조한다.
describe('depth wire — 서버가 깊이를 아는가', () => {
  it('보내는 세 깊이가 서버 allowlist 안에 있다', () => {
    const server = serverAllowlist('RESEARCH_DEPTHS_');
    const unknown = RESEARCH_DEPTHS.map((option) => option.depth).filter((depth) => !server.includes(depth));
    expect(unknown, `서버가 모르는 깊이를 보낸다: ${unknown.join(', ')}`).toEqual([]);
  });

  it('서버가 깊이를 capture envelope에 남긴다 — 읽고 버리면 처리기가 볼 수 없다', () => {
    // 문자열 대조는 무딘 도구지만, 이 한 칸이 조용히 빠지는 것이 정확히 예전에 일어난 일이다.
    expect(/depth:\s*request\.depth/.test(serverSource), 'researchEnvelope_가 깊이를 남기지 않는다').toBe(true);
  });

  it('서버 기본 깊이가 계약 기본값과 같다', () => {
    const match = /var\s+RESEARCH_DEFAULT_DEPTH_\s*=\s*'([a-z_]+)'/.exec(serverSource);
    expect(match, 'Code.gs에 기본 깊이가 없다').not.toBeNull();
    expect(match![1]).toBe(DEFAULT_RESEARCH_DEPTH);
  });
});

describe('깊이 → mode', () => {
  it('세 깊이가 계약의 세 mode로 간다', () => {
    expect(researchModeOf('quick')).toBe('quick');
    expect(researchModeOf('standard')).toBe('standard');
    expect(researchModeOf('deep')).toBe('deep_evidence_graph');
  });

  it('알 수 없는 값은 계약 기본값인 standard로 간다', () => {
    for (const value of ['turbo', '', null, undefined, 42]) expect(researchModeOf(value)).toBe('standard');
  });
});
