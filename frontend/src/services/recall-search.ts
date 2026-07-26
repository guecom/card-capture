// 자연어 회상 검색 (UI 이름 `AI 사람 찾기`) — ISS-000103.
//
// 계약: 기기 안에서만 돈다. 문장을 밖으로 보내지 않고, 외부 모델도 호출하지 않는다.
// 이미 이 기기가 받아 둔 브리핑(내 기록)만 대조하고, 후보마다 "왜 이 사람인지"를 근거로 붙인다.
// 기록에 없는 속성(성별·외모·나이)은 추정하지 않고 "쓰지 않은 조건"으로 되돌려 말한다.
import type { BriefItem } from '../contracts/capture';
import { briefDisplayName, elapsedMinutesOf } from './brief-view';

export interface RecallWindow {
  from: number;
  to: number;
  label: string;
}

export type RecallTermKind = 'org' | 'event' | 'role' | 'name' | 'free';

export interface RecallTerm {
  text: string;
  kind: RecallTermKind;
}

export interface IgnoredCondition {
  text: string;
  reason: string;
}

export interface RecallQuery {
  raw: string;
  window: RecallWindow | null;
  fuzzy: boolean;
  terms: RecallTerm[];
  ignored: IgnoredCondition[];
}

export type RecallEvidenceKind = 'time' | 'org' | 'event' | 'role' | 'name' | 'text';

export interface RecallEvidence {
  kind: RecallEvidenceKind;
  label: string;
}

export interface RecallCandidate {
  item: BriefItem;
  score: number;
  evidence: RecallEvidence[];
  /** 시점 조건에서 살짝 벗어났지만 `쯤` 같은 흐린 표현이라 남겨 둔 후보 */
  partial: boolean;
}

export interface RecallResult {
  query: RecallQuery;
  candidates: RecallCandidate[];
  unmatchedTerms: string[];
  searchedCount: number;
}

const DAY = 24 * 60 * 60 * 1000;

// 기록하지 않는 속성. 이름·사진에서 추정해 검색 근거로 쓰면 안 된다 (ISS-000103 해결 조건).
const UNSTORED_ATTRIBUTES: Array<{ pattern: RegExp; text: string; reason: string }> = [
  { pattern: /여자|여성분|여성|아주머니|누나|언니/, text: '성별', reason: '성별은 명함 기록에 남기지 않아 조건으로 쓰지 않았어요' },
  { pattern: /남자|남성분|남성|아저씨|형님|오빠/, text: '성별', reason: '성별은 명함 기록에 남기지 않아 조건으로 쓰지 않았어요' },
  { pattern: /안경|수염|머리\s*(긴|짧)|키가?\s*(큰|작)|덩치|인상|외모|옷/, text: '외모', reason: '외모는 기록하지 않아 조건으로 쓰지 않았어요' },
  { pattern: /(\d{2}\s*대|나이|젊은|연세|또래)/, text: '나이', reason: '나이는 기록하지 않아 조건으로 쓰지 않았어요' },
  { pattern: /목소리|말투|사투리/, text: '말투', reason: '목소리·말투는 기록하지 않아 조건으로 쓰지 않았어요' },
];

const ROLE_WORDS = ['대표이사', '대표', '사장', '부사장', '전무', '상무', '이사', '본부장', '실장', '팀장', '부장', '차장', '과장', '대리', '주임', '교수', '박사', '연구원', '연구소장', '개발자', '디자이너', '구매', '영업', '기획', '마케팅', 'CEO', 'CTO', 'COO', 'CFO', 'CPO', 'VP', 'PM'];
const EVENT_WORDS = ['전시회', '박람회', '컨퍼런스', '콘퍼런스', '세미나', '밋업', '포럼', '행사', '워크숍', '워크샵', '데모데이', '오픈하우스', '설명회', '학회'];
const STOPWORDS = new Set([
  '사람', '분', '그', '저', '이', '누구', '누구지', '누구였', '만난', '만났', '만났던', '만났었', '봤던', '본', '인데', '였어', '이었어', '같아', '같은', '정도', '아마', '기억', '기억나', '찾아', '찾아줘', '찾기', '알려줘', '보여줘', '그때', '거기', '어디', '언제', '무슨', '어떤', '했던', '하던', '있던', '있었', '거', '것', '좀', '뭐', '음', '아',
  // 소속·만남을 알려 주는 신호어 자체는 검색어가 아니다 ("한화 다니던" → '한화'만 남긴다).
  '다니', '다니던', '다니는', '근무', '근무하', '소속', '재직', '일하', '계시던', '인사', '명함',
]);
const PARTICLES = /(이었는데|였는데|인데|는데|던데|이에요|예요|입니다|이었어|였어|이야|이랑|랑|하고|이었던|였던|이던|던|이라는|라는|이라고|라고|에서|에게|한테|께서|들이|들의|들|에|의|를|을|은|는|이|가|와|과|도|만|로|으로|께)$/;

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

// 한국식 주 시작(월요일) 기준.
function startOfWeek(timestamp: number): number {
  const day = new Date(startOfDay(timestamp)).getDay();
  return startOfDay(timestamp) - ((day + 6) % 7) * DAY;
}

function startOfMonth(timestamp: number, monthOffset = 0): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth() + monthOffset, 1).getTime();
}

function monthDayLabel(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}월 ${date.getDate()}일`;
}

function rangeLabel(prefix: string, from: number, to: number): string {
  return `${prefix} (${monthDayLabel(from)}~${monthDayLabel(to - 1)})`;
}

// 상대 시간 표현 → 절대 구간. 못 알아들으면 null이고, 그때는 시점 조건 없이 검색한다.
export function parseRecallWindow(text: string, now = Date.now()): RecallWindow | null {
  const today = startOfDay(now);
  if (/그저께|그제/.test(text)) return { from: today - 2 * DAY, to: today - DAY, label: '그저께' };
  if (/어제/.test(text)) return { from: today - DAY, to: today, label: '어제' };
  if (/오늘/.test(text)) return { from: today, to: today + DAY, label: '오늘' };

  const weeksAgo = /(\d+)\s*주\s*(전|쯤\s*전)/.exec(text);
  if (weeksAgo) {
    const from = startOfWeek(now) - Number(weeksAgo[1]) * 7 * DAY;
    return { from, to: from + 7 * DAY, label: rangeLabel(`${weeksAgo[1]}주 전`, from, from + 7 * DAY) };
  }
  const daysAgo = /(\d+)\s*일\s*(전|쯤\s*전)/.exec(text);
  if (daysAgo) {
    const from = today - Number(daysAgo[1]) * DAY;
    return { from, to: from + DAY, label: `${daysAgo[1]}일 전 (${monthDayLabel(from)})` };
  }
  const monthsAgo = /(\d+)\s*(달|개월)\s*(전|쯤\s*전)/.exec(text);
  if (monthsAgo) {
    const from = startOfMonth(now, -Number(monthsAgo[1]));
    const to = startOfMonth(now, -Number(monthsAgo[1]) + 1);
    return { from, to, label: rangeLabel(`${monthsAgo[1]}달 전`, from, to) };
  }

  if (/지지난\s*주/.test(text)) {
    const from = startOfWeek(now) - 14 * DAY;
    return { from, to: from + 7 * DAY, label: rangeLabel('지지난주', from, from + 7 * DAY) };
  }
  if (/(지난|저번|전)\s*주/.test(text)) {
    const from = startOfWeek(now) - 7 * DAY;
    return { from, to: from + 7 * DAY, label: rangeLabel('지난주', from, from + 7 * DAY) };
  }
  if (/이번\s*주|금주/.test(text)) {
    const from = startOfWeek(now);
    return { from, to: now + 1, label: rangeLabel('이번 주', from, now + 1) };
  }
  if (/(지난|저번)\s*달/.test(text)) {
    const from = startOfMonth(now, -1);
    const to = startOfMonth(now, 0);
    return { from, to, label: rangeLabel('지난달', from, to) };
  }
  if (/이번\s*달|이달/.test(text)) {
    const from = startOfMonth(now, 0);
    return { from, to: now + 1, label: rangeLabel('이번 달', from, now + 1) };
  }
  if (/작년|지난해/.test(text)) {
    const year = new Date(now).getFullYear() - 1;
    return { from: new Date(year, 0, 1).getTime(), to: new Date(year + 1, 0, 1).getTime(), label: `작년(${year}년)` };
  }
  if (/올해|금년/.test(text)) {
    const from = new Date(new Date(now).getFullYear(), 0, 1).getTime();
    return { from, to: now + 1, label: '올해' };
  }
  if (/며칠\s*전|엊그제/.test(text)) return { from: today - 6 * DAY, to: now + 1, label: rangeLabel('며칠 전', today - 6 * DAY, now + 1) };
  if (/최근|얼마\s*전|요즘|저번에/.test(text)) return { from: today - 30 * DAY, to: now + 1, label: '최근 30일' };
  return null;
}

function stripParticle(token: string): string {
  const bare = token.replace(/[.,!?'"()[\]]/g, '').trim();
  if (bare.length <= 2) return bare;
  return bare.replace(PARTICLES, '') || bare;
}

function pushTerm(terms: RecallTerm[], text: string, kind: RecallTermKind): void {
  const value = text.trim();
  if (!value || value.length < 2) return;
  if (terms.some((term) => term.text === value)) return;
  terms.push({ text: value, kind });
}

// 문장 → 검색 조건. 회사·행사·직함 단서를 먼저 건지고 남는 말은 자유 단어로 둔다.
export function parseRecallQuery(raw: string, now = Date.now()): RecallQuery {
  const text = String(raw ?? '').trim();
  const window = parseRecallWindow(text, now);
  const fuzzy = /쯤|즈음|정도|아마|같은데|였나|인가|비슷/.test(text);

  const ignored: IgnoredCondition[] = [];
  UNSTORED_ATTRIBUTES.forEach((attribute) => {
    if (!attribute.pattern.test(text)) return;
    if (ignored.some((entry) => entry.text === attribute.text)) return;
    ignored.push({ text: attribute.text, reason: attribute.reason });
  });

  const terms: RecallTerm[] = [];

  // "한화 다니던", "삼성에 있던", "네이버 근무" → 소속 조건.
  const orgPattern = /([가-힣A-Za-z0-9&.\-]{2,20})\s*(?:에)?\s*(?:다니|근무|소속|재직|일하|있던|있었|계시던)/g;
  for (const match of text.matchAll(orgPattern)) pushTerm(terms, stripParticle(match[1]), 'org');
  const orgSuffix = /([가-힣A-Za-z0-9&.\-]{2,20})\s*(?:회사|기업|법인|연구소|재단|협회|대학교|대학|병원)/g;
  for (const match of text.matchAll(orgSuffix)) pushTerm(terms, stripParticle(match[1]), 'org');

  // "로보월드에서 만난", "판교 밋업" → 만난 곳 조건.
  const eventPattern = /([가-힣A-Za-z0-9\s]{2,24}?)\s*(?:에서)\s*(?:만난|만났|본|봤|인사)/g;
  for (const match of text.matchAll(eventPattern)) pushTerm(terms, stripParticle(match[1]).trim(), 'event');
  EVENT_WORDS.forEach((word) => {
    const pattern = new RegExp(`([가-힣A-Za-z0-9]{0,16}\\s?${word})`, 'g');
    for (const match of text.matchAll(pattern)) pushTerm(terms, match[1].trim(), 'event');
  });

  // "한화 구매팀장"처럼 직함 바로 앞에 오는 말은 소속으로 읽는다.
  const orgBeforeRole = new RegExp(`([가-힣A-Za-z0-9&.\\-]{2,20})\\s*(?:의)?\\s*(?:${ROLE_WORDS.join('|')})`, 'gi');
  for (const match of text.matchAll(orgBeforeRole)) {
    const candidate = stripParticle(match[1]);
    if (ROLE_WORDS.some((word) => candidate.includes(word))) continue;
    if (STOPWORDS.has(candidate)) continue;
    pushTerm(terms, candidate, 'org');
  }

  ROLE_WORDS.forEach((word) => {
    if (new RegExp(word, 'i').test(text)) pushTerm(terms, word, 'role');
  });

  const claimed = terms.map((term) => term.text);
  text.split(/[\s,·/]+/).forEach((token) => {
    const bare = stripParticle(token);
    if (!bare || bare.length < 2) return;
    if (STOPWORDS.has(bare)) return;
    if (/^\d+$/.test(bare)) return;
    // 시간·미기록 속성 표현은 이미 처리했으므로 자유 단어로 다시 넣지 않는다.
    if (parseRecallWindow(bare, now)) return;
    if (UNSTORED_ATTRIBUTES.some((attribute) => attribute.pattern.test(bare))) return;
    if (claimed.some((value) => value.includes(bare) || bare.includes(value))) return;
    pushTerm(terms, bare, 'free');
  });

  return { raw: text, window, fuzzy, terms, ignored };
}

function itemTimestamp(item: BriefItem): number | null {
  const minutes = elapsedMinutesOf(item, Date.now());
  if (minutes !== null) return Date.now() - minutes * 60_000;
  const parsed = Date.parse(String(item.receivedAt ?? item.capturedAt ?? ''));
  return Number.isNaN(parsed) ? null : parsed;
}

function haystackOf(item: BriefItem): { org: string; event: string; name: string; title: string; body: string } {
  return {
    org: [item.contact?.organization, item.contact?.company].filter(Boolean).join(' ').toLowerCase(),
    event: String(item.event ?? '').toLowerCase(),
    name: [briefDisplayName(item), item.contact?.name, item.quickName?.name, item.person].filter(Boolean).join(' ').toLowerCase(),
    title: String(item.contact?.title ?? '').toLowerCase(),
    body: [item.brief, item.note, item.capturer].filter(Boolean).join('\n').toLowerCase(),
  };
}

const KIND_SCORE: Record<RecallTermKind, number> = { name: 4, org: 3, event: 2, role: 1, free: 1 };

// 후보 순위: 이름 > 소속 > 만난 곳 > 직함/자유 단어. 시점은 필터이자 가점이다.
export function rankRecallCandidates(items: BriefItem[], query: RecallQuery, now = Date.now()): RecallResult {
  const pool = items ?? [];
  const matchedTerms = new Set<string>();
  const candidates: RecallCandidate[] = [];
  // 흐린 표현(`지난주쯤`)은 앞뒤 이틀을 더 본다 — 대신 후보에 "시점이 조금 벗어남"을 남긴다.
  const slack = query.fuzzy ? 2 * DAY : 0;

  pool.forEach((item) => {
    const evidence: RecallEvidence[] = [];
    let score = 0;
    let partial = false;

    if (query.window) {
      const timestamp = itemTimestamp(item);
      if (timestamp === null) return;
      const inside = timestamp >= query.window.from && timestamp < query.window.to;
      const near = timestamp >= query.window.from - slack && timestamp < query.window.to + slack;
      if (!inside && !near) return;
      partial = !inside;
      score += inside ? 3 : 1;
      evidence.push({
        kind: 'time',
        label: inside
          ? `만난 시점 ${monthDayLabel(timestamp)} · '${query.window.label}' 안`
          : `만난 시점 ${monthDayLabel(timestamp)} · '${query.window.label}'에서 조금 벗어남`,
      });
    }

    const hay = haystackOf(item);
    query.terms.forEach((term) => {
      const needle = term.text.toLowerCase();
      let hit: RecallEvidence | null = null;
      if (hay.name.includes(needle)) hit = { kind: 'name', label: `이름·인물 기록에 '${term.text}'` };
      else if (hay.org.includes(needle)) hit = { kind: 'org', label: `소속 ${item.contact?.organization || item.contact?.company} · '${term.text}' 일치` };
      else if (hay.event.includes(needle)) hit = { kind: 'event', label: `만난 곳 ${item.event} · '${term.text}' 일치` };
      else if (hay.title.includes(needle)) hit = { kind: 'role', label: `직함 ${item.contact?.title} · '${term.text}' 일치` };
      else if (hay.body.includes(needle)) hit = { kind: 'text', label: `기록 본문에 '${term.text}'` };
      if (!hit) return;
      matchedTerms.add(term.text);
      score += KIND_SCORE[term.kind] + (hit.kind === 'text' ? 0 : 1);
      evidence.push(hit);
    });

    const hasTermEvidence = evidence.some((entry) => entry.kind !== 'time');
    // 조건이 시점 하나뿐이면 그 구간의 사람을 전부 보여 준다. 단어 조건이 있으면 하나는 맞아야 한다.
    if (!hasTermEvidence && (query.terms.length > 0 || !query.window)) return;
    candidates.push({ item, score, evidence, partial });
  });

  candidates.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return (itemTimestamp(right.item) ?? 0) - (itemTimestamp(left.item) ?? 0);
  });

  return {
    query,
    candidates: candidates.slice(0, 12),
    unmatchedTerms: query.terms.filter((term) => !matchedTerms.has(term.text)).map((term) => term.text),
    searchedCount: pool.length,
  };
}

export function runRecallSearch(items: BriefItem[], raw: string, now = Date.now()): RecallResult {
  return rankRecallCandidates(items, parseRecallQuery(raw, now), now);
}

// 서버 전체 기록 검색으로 넘길 단어. 자유 문장 전체를 보내면 Drive 검색이 0건을 준다.
// 직함(`팀장`)은 어느 기록에나 있어 검색어로 쓸모가 없으므로 제외한다.
export function serverFallbackTerm(query: RecallQuery): string {
  const ranked = query.terms
    .filter((term) => term.kind !== 'role')
    .sort((left, right) => KIND_SCORE[right.kind] - KIND_SCORE[left.kind] || right.text.length - left.text.length);
  return ranked[0]?.text ?? '';
}

// "지난주(7월 19일~7월 25일)에 만난 사람 중 '한화'" 처럼 무엇으로 찾았는지 되돌려 말한다.
export function describeRecallQuery(query: RecallQuery): string {
  const parts: string[] = [];
  if (query.window) parts.push(`${query.window.label}에 만난 사람`);
  const named = query.terms.filter((term) => term.kind !== 'free').map((term) => `'${term.text}'`);
  const free = query.terms.filter((term) => term.kind === 'free').map((term) => `'${term.text}'`);
  const words = [...named, ...free];
  if (words.length) parts.push(`${words.join(', ')}가 기록에 있는 사람`);
  return parts.length ? `${parts.join(' 중 ')}을 찾았어요.` : '조건을 알아듣지 못해 최근 기록을 그대로 보여 줍니다.';
}
