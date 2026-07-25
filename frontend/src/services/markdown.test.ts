import { describe, expect, it } from 'vitest';
import { inlineMarkdown, labelImageEmbeds, parseMarkdownBlocks, parsePersonFrontmatter } from './markdown';

describe('inlineMarkdown', () => {
  it('resolves obsidian links, aliases, bold and code markers', () => {
    expect(inlineMarkdown('**[[PER-000001 홍길동|홍길동]]**의 `직함`')).toBe('홍길동의 직함');
    expect(inlineMarkdown('[[ORG-000003 RLWRLD]] 소속')).toBe('ORG-000003 RLWRLD 소속');
  });
});

describe('parseMarkdownBlocks', () => {
  it('parses headings, bullets, hr, arrow and paragraphs like legacy mdLite', () => {
    const blocks = parseMarkdownBlocks('# 제목\n## 소제목\n### 소소제목\n- 항목\n---\n→ 다음 액션\n\n본문');
    expect(blocks.map((block) => block.kind)).toEqual(['h1', 'h2', 'h3', 'bullet', 'hr', 'arrow', 'blank', 'p']);
  });

  it('parses table blocks and skips separator rows', () => {
    const blocks = parseMarkdownBlocks('| 기간 | 소속 |\n| --- | --- |\n| 2019 | 로보텍 |');
    expect(blocks).toHaveLength(1);
    const table = blocks[0];
    if (table.kind !== 'table') throw new Error('expected table');
    expect(table.rows).toEqual([['기간', '소속'], ['2019', '로보텍']]);
  });

  it('keeps escaped pipes inside table cells', () => {
    const blocks = parseMarkdownBlocks('| 링크 | 값 |\n| [[A\\|가]] | 1\\|2 |');
    const table = blocks[0];
    if (table.kind !== 'table') throw new Error('expected table');
    expect(table.rows[1]).toEqual(['가', '1|2']);
  });
});

describe('parsePersonFrontmatter', () => {
  const markdown = [
    '---',
    'name: 홍길동',
    'title: "CTO"',
    'organization: "[[ORG-000003 로보텍]]"',
    'last_contacted: 2026-07-20',
    'emails:',
    '  - gildong@robotech.kr',
    'phones:',
    '  - "010-1234-5678"',
    '---',
    '',
    '# 본문',
  ].join('\n');

  it('separates values, lists and body like legacy parseFm', () => {
    const parsed = parsePersonFrontmatter(markdown);
    expect(parsed.vals.name).toBe('홍길동');
    expect(parsed.vals.title).toBe('CTO');
    expect(parsed.vals.organization).toBe('ORG-000003 로보텍');
    expect(parsed.lists.emails).toEqual(['gildong@robotech.kr']);
    expect(parsed.lists.phones).toEqual(['010-1234-5678']);
    expect(parsed.raw).toContain('name: 홍길동');
    expect(parsed.body).toContain('# 본문');
  });

  it('returns whole text as body when there is no frontmatter', () => {
    const parsed = parsePersonFrontmatter('# 제목만');
    expect(parsed.raw).toBeNull();
    expect(parsed.body).toBe('# 제목만');
  });
});

describe('labelImageEmbeds', () => {
  it('replaces image embeds with labels', () => {
    expect(labelImageEmbeds('앞면 ![[PER-000001_front.jpg]]')).toBe('앞면 (이미지: PER-000001_front.jpg)');
  });
});
