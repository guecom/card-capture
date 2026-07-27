// 검색 결과 근거 (FI-104) — "왜 이 사람이 나왔는지"를, 사적 정보를 흘리지 않고 보여 준다.
//
// 서버 검색(`searchPersons_`)은 `{id, title, via}`만 준다. `via: 'content'`는 "본문 어딘가가
// 맞았다"는 사실만 말하고 어디가 맞았는지는 말하지 않는다. 서버는 이번에 못 고치므로 근거를
// 클라이언트에서 만든다 — 제목 일치는 제목 안의 매칭 구간 자체가 근거이고, 본문 일치는
// 기존 문서 조회 경로로 문서를 읽어 매칭 위치 주변만 잘라 쓴다.
//
// 누출 방지가 이 기능의 조건이다. Person 전문에는 프런트매터 내부 필드와 Private 섹션이 있을 수
// 있다(Code.gs `searchPersons_` 주석). 근거를 못 만드는 것이 사적 정보를 흘리는 것보다 낫다 —
// 읽어도 되는 부분에서 매칭을 찾지 못하면 근거 없음(null)이다.
import type { SearchItem } from '../contracts/capture';

/** 근거 스니펫 최대 길이. 문서 전문을 붙이지 않기 위한 상한이다. */
export const SNIPPET_MAX = 160;

/** 한 번의 검색에서 문서를 추가로 읽어 올 최대 건수. 유계 요청 계약. */
export const MAX_CONTENT_LOOKUPS = 4;

export interface EvidenceMark {
  start: number;
  end: number;
}

export interface SearchEvidence {
  kind: 'title' | 'content';
  /** 화면에 그대로 보여 줄 짧은 구간 */
  snippet: string;
  /** `snippet` 안에서 매칭된 구간 (하이라이트용) */
  marks: EvidenceMark[];
  /** 앞이 잘렸는가 — 잘렸다면 온전한 문장인 척하지 않는다 */
  leadingGap: boolean;
  /** 뒤가 잘렸는가 */
  trailingGap: boolean;
}

export interface EvidenceSegment {
  text: string;
  marked: boolean;
}

/** 스니펫에 절대 실리면 안 되는 프런트매터 키. 값 자체가 내부 식별자·자격증명이다. */
const PRIVATE_KEY = /^\s*[-*]?\s*[A-Za-z_][A-Za-z0-9_ -]*(id|key|token|secret|password|credential|folder|url|path|status|typeid)\s*:/i;

/** 자격증명처럼 보이는 값. 길고 대소문자·숫자가 섞인 연속 문자열은 사람이 읽는 문장이 아니다. */
const TOKEN_SHAPED = /(?=[A-Za-z0-9_-]{20,})(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/;

/** 비공개 구획. 제목이 이렇게 시작하면 다음 같은 급 이상 제목까지 통째로 버린다. */
const PRIVATE_HEADING = /^\s{0,3}(#{1,6})\s*(private|비공개|사적|개인\s*정보|비밀)/i;

const HEADING = /^\s{0,3}(#{1,6})\s/;

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 근거로 인용해도 되는 부분만 남긴다.
 *
 * 버리는 것: 앞머리 프런트매터 블록, Private 계열 섹션, 내부 필드 줄, 자격증명 형태 값이 있는 줄,
 * URL(드라이브 폴더 ID 같은 내부 식별자가 그대로 들어 있다).
 */
export function snippetSource(markdown: string): string {
  const text = String(markdown ?? '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');

  // 앞머리 프런트매터(`---` ... `---`)는 통째로 버린다.
  let start = 0;
  while (start < lines.length && lines[start].trim() === '') start += 1;
  if (lines[start]?.trim() === '---') {
    const close = lines.findIndex((line, index) => index > start && line.trim() === '---');
    start = close === -1 ? lines.length : close + 1;
  }

  const kept: string[] = [];
  let privateDepth = 0;
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = HEADING.exec(line);
    if (heading) {
      const depth = heading[1].length;
      if (PRIVATE_HEADING.test(line)) { privateDepth = depth; continue; }
      // 같은 급 이상의 다음 제목에서 비공개 구획이 끝난다.
      if (privateDepth > 0 && depth <= privateDepth) privateDepth = 0;
    }
    if (privateDepth > 0) continue;
    if (PRIVATE_KEY.test(line)) continue;
    if (TOKEN_SHAPED.test(line)) continue;
    // 링크는 표시 문구만 남기고 주소는 버린다. 주소에 내부 식별자가 들어 있다.
    const cleaned = line
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<?https?:\/\/\S+>?/g, '')
      .replace(/^\s{0,3}#{1,6}\s*/, '')
      .replace(/[*_`>]/g, '');
    if (TOKEN_SHAPED.test(cleaned)) continue;
    kept.push(cleaned);
  }

  return kept.join('\n');
}

function markAll(haystack: string, term: string): EvidenceMark[] {
  const needle = term.trim();
  if (!needle) return [];
  const marks: EvidenceMark[] = [];
  const pattern = new RegExp(escapeForRegExp(needle), 'gi');
  for (let match = pattern.exec(haystack); match !== null; match = pattern.exec(haystack)) {
    marks.push({ start: match.index, end: match.index + match[0].length });
    if (match[0].length === 0) break;
  }
  return marks;
}

/** 제목 일치의 근거는 제목 안의 매칭 구간 자체다 — 문서를 더 읽을 필요가 없다. */
export function titleEvidence(title: string, term: string): SearchEvidence | null {
  const text = String(title ?? '');
  const marks = markAll(text, String(term ?? ''));
  if (marks.length === 0) return null;
  return { kind: 'title', snippet: text, marks, leadingGap: false, trailingGap: false };
}

/**
 * 본문 일치의 근거: 매칭된 **줄 안에서만** 잘라 낸다.
 * 읽어도 되는 부분에서 매칭을 못 찾으면 `null` — 없는 근거를 지어내지 않는다.
 *
 * 옆 줄까지 끌어오지 않는 이유: 매칭과 무관한 인접 내용을 함께 노출하지 않기 위해서다.
 * 짧은 문서에서 상한까지 채우려고 주변을 긁어모으면 사실상 문서 전문이 붙는다.
 */
export function contentEvidence(markdown: string, term: string, max = SNIPPET_MAX): SearchEvidence | null {
  const needle = String(term ?? '').trim();
  if (!needle) return null;
  const lines = snippetSource(markdown)
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);

  const source = lines.find((line) => markAll(line, needle).length > 0) ?? '';
  if (!source) return null;

  const first = markAll(source, needle)[0];
  if (!first) return null;

  const width = Math.max(Math.trunc(max) || SNIPPET_MAX, needle.length);
  const matchLength = first.end - first.start;
  const pad = Math.max(Math.floor((width - matchLength) / 2), 0);
  let from = Math.max(first.start - pad, 0);
  let to = Math.min(from + width, source.length);
  from = Math.max(Math.min(from, to - width), 0);

  // 잘린 쪽은 공백에서 끊어 낱말을 반토막 내지 않는다.
  if (from > 0) {
    const space = source.indexOf(' ', from);
    if (space !== -1 && space < first.start && space - from <= 12) from = space + 1;
  }
  if (to < source.length) {
    const space = source.lastIndexOf(' ', to);
    if (space !== -1 && space > first.end && to - space <= 12) to = space;
  }

  const snippet = source.slice(from, to).replace(/\n/g, ' ').trim();
  const marks = markAll(snippet, needle);
  if (marks.length === 0) return null;

  return {
    kind: 'content',
    snippet,
    marks,
    leadingGap: from > 0,
    trailingGap: to < source.length,
  };
}

/** 문서를 더 읽어야 하는 검색 결과만, 상한까지. 제목 일치는 이미 스스로를 설명한다. */
export function contentLookupTargets(items: SearchItem[], max = MAX_CONTENT_LOOKUPS): string[] {
  return (items ?? [])
    .filter((item) => item.via === 'content' && Boolean(item.id))
    .slice(0, Math.max(Math.trunc(max) || 0, 0))
    .map((item) => item.id);
}

/** 하이라이트를 그리기 위한 분할. 이어 붙이면 원래 스니펫과 정확히 같아야 한다. */
export function evidenceSegments(evidence: SearchEvidence): EvidenceSegment[] {
  const segments: EvidenceSegment[] = [];
  let cursor = 0;
  [...evidence.marks].sort((left, right) => left.start - right.start).forEach((mark) => {
    if (mark.start < cursor) return;
    if (mark.start > cursor) segments.push({ text: evidence.snippet.slice(cursor, mark.start), marked: false });
    segments.push({ text: evidence.snippet.slice(mark.start, mark.end), marked: true });
    cursor = mark.end;
  });
  if (cursor < evidence.snippet.length) segments.push({ text: evidence.snippet.slice(cursor), marked: false });
  return segments.length ? segments : [{ text: evidence.snippet, marked: false }];
}
