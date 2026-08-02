// Retired standalone renderer의 mdLite/mdTable/parseFm 동작 계약을 현재 앱에 포팅.
// 파싱은 여기(순수 함수), JSX 변환은 components/MarkdownLite.tsx가 소유한다.

export interface TableBlock {
  kind: 'table';
  rows: string[][];
}

export interface TextBlock {
  kind: 'h1' | 'h2' | 'h3' | 'bullet' | 'arrow' | 'p';
  text: string;
}

export interface InlineSegment {
  text: string;
  href?: string;
}

export interface HrBlock {
  kind: 'hr';
}

export interface BlankBlock {
  kind: 'blank';
}

export type MarkdownBlock = TableBlock | TextBlock | HrBlock | BlankBlock;

const ESCAPED_PIPE = '\u0001';

function normalizedInlineSource(value: string): string {
  return String(value ?? '')
    .replace(/\[\[([^\]|]+)(\|([^\]]+))?\]\]/g, (_match, target: string, _alias, aliasText: string) => aliasText || target)
    .replace(/\*\*/g, '')
    .replace(/`/g, '');
}

export function safeExternalUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

// Person 문서에는 Markdown 링크와 bare URL이 섞여 있다. 외부 이동은 명시적인 http(s)만 허용한다.
export function parseInlineMarkdown(value: string): InlineSegment[] {
  const source = normalizedInlineSource(value);
  const segments: InlineSegment[] = [];
  const matcher = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<]+)/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(source)) !== null) {
    if (match.index > cursor) segments.push({ text: source.slice(cursor, match.index) });
    const markdownLabel = match[1];
    const matchedUrl = match[2] ?? match[3] ?? '';
    const trailing = match[3] ? /[.,;!?]+$/.exec(matchedUrl)?.[0] ?? '' : '';
    const rawUrl = trailing ? matchedUrl.slice(0, -trailing.length) : matchedUrl;
    const href = safeExternalUrl(rawUrl);
    if (href) segments.push({ text: markdownLabel || rawUrl, href });
    else segments.push({ text: match[0] });
    if (trailing) segments.push({ text: trailing });
    cursor = matcher.lastIndex;
  }
  if (cursor < source.length) segments.push({ text: source.slice(cursor) });
  return segments.length ? segments : [{ text: source }];
}

export function inlineMarkdown(value: string): string {
  return parseInlineMarkdown(value).map((segment) => segment.text).join('');
}

// escaped pipe(\|)는 셀 구분자가 아니다 — legacy와 동일하게 placeholder로 보호한다.
function tableRow(line: string): string[] | null {
  const cells = line
    .split('\\|').join(ESCAPED_PIPE)
    .replace(/^\s*\||\|\s*$/g, '')
    .split('|')
    .map((cell) => cell.split(ESCAPED_PIPE).join('|').trim());
  if (cells.every((cell) => /^:?-{2,}:?$/.test(inlineMarkdown(cell)) || cell === '')) return null;
  return cells;
}

export function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = String(text ?? '').split('\n');
  let index = 0;
  while (index < lines.length) {
    if (/^\s*\|/.test(lines[index])) {
      const rows: string[][] = [];
      while (index < lines.length && /^\s*\|/.test(lines[index])) {
        const row = tableRow(lines[index]);
        if (row) rows.push(row);
        index += 1;
      }
      if (rows.length) blocks.push({ kind: 'table', rows });
      continue;
    }
    const line = lines[index];
    if (line.startsWith('### ')) blocks.push({ kind: 'h3', text: line.slice(4) });
    else if (line.startsWith('## ')) blocks.push({ kind: 'h2', text: line.slice(3) });
    else if (line.startsWith('# ')) blocks.push({ kind: 'h1', text: line.slice(2) });
    else if (line.startsWith('- ')) blocks.push({ kind: 'bullet', text: line.slice(2) });
    else if (/^-{3,}$/.test(line.trim())) blocks.push({ kind: 'hr' });
    else if (line.startsWith('→')) blocks.push({ kind: 'arrow', text: line });
    else if (!line.trim()) blocks.push({ kind: 'blank' });
    else blocks.push({ kind: 'p', text: line });
    index += 1;
  }
  return blocks;
}

export interface PersonFrontmatter {
  vals: Record<string, string>;
  lists: Record<string, string[]>;
  body: string;
  raw: string | null;
}

export function splitFrontmatter(markdown: string): { raw: string | null; body: string } {
  const text = String(markdown ?? '');
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    if (end > 0) return { raw: text.slice(4, end).trim(), body: text.slice(end + 4) };
  }
  return { raw: null, body: text };
}

function stripLinkQuotes(value: string): string {
  return value.replace(/^"|"$/g, '').replace(/^\[\[|\]\]$/g, '');
}

export function parsePersonFrontmatter(markdown: string): PersonFrontmatter {
  const { raw, body } = splitFrontmatter(markdown);
  const vals: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  if (raw) {
    let current: string | null = null;
    raw.split('\n').forEach((line) => {
      const listItem = /^\s+-\s*(.+)$/.exec(line);
      if (listItem && current) {
        (lists[current] = lists[current] ?? []).push(stripLinkQuotes(listItem[1]));
        return;
      }
      const keyed = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
      if (keyed) {
        current = keyed[1];
        const value = keyed[2].trim().replace(/^"|"$/g, '');
        if (value) vals[current] = stripLinkQuotes(value);
      }
    });
  }
  return { vals, lists, body, raw };
}

export function labelImageEmbeds(text: string): string {
  return String(text ?? '').replace(/!\[\[([^\]]+)\]\]/g, '(이미지: $1)');
}
