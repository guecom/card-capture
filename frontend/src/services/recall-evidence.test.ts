import { describe, expect, it } from 'vitest';
import type { SearchItem } from '../contracts/capture';
import {
  SNIPPET_MAX,
  MAX_CONTENT_LOOKUPS,
  contentEvidence,
  contentLookupTargets,
  evidenceSegments,
  snippetSource,
  titleEvidence,
} from './recall-evidence';

// 합성 문서만 쓴다. 실명함·실토큰·개인정보는 이 파일에 없다.
const SYNTHETIC_DOC = [
  '---',
  'typeID: PER-909001',
  'reviewStatus: agent_checked',
  'internal_api_key: kx9Q2mSyntheticFakeTokenValue00000000',
  'drive_folder_id: 1SyntheticFakeFolderIdValue0000000000',
  'aliases:',
  '  - 합성인물-검색',
  '---',
  '',
  '# 합성인물-검색 — 이런 분이에요',
  '',
  '합성 자동화 설비 회사의 합성 담당자입니다. 2026년 합성 산업전 로보월드합성 부스에서 처음 인사했고,',
  '사내 검사 공정 자동화를 검토 중이라고 했습니다. 자세한 내용은 [합성 자료](https://drive.example.test/d/1SyntheticFakeFolderIdValue0000000000) 참고.',
  '',
  '## 대화 포인트',
  '- 합성 항목 A',
  '- 합성 항목 B',
  '',
  '## Private',
  '개인 연락처 메모: 합성비공개내용, 로보월드합성 관련 사적인 이야기.',
].join('\n');

describe('title matches carry their own evidence — the matched span itself', () => {
  it('marks where the term matched inside the title', () => {
    const evidence = titleEvidence('PER-909002 합성인물-로보월드합성', '로보월드합성');
    expect(evidence?.kind).toBe('title');
    expect(evidence?.marks).toEqual([{ start: evidence!.snippet.indexOf('로보월드합성'), end: evidence!.snippet.indexOf('로보월드합성') + 6 }]);
    expect(evidence!.snippet.slice(evidence!.marks[0].start, evidence!.marks[0].end)).toBe('로보월드합성');
  });

  it('matches without caring about letter case', () => {
    const evidence = titleEvidence('PER-909003 Synthetic Robotics', 'synthetic');
    expect(evidence!.snippet.slice(evidence!.marks[0].start, evidence!.marks[0].end)).toBe('Synthetic');
  });

  it('claims no evidence when the term is not actually in the title', () => {
    expect(titleEvidence('PER-909004 합성인물-다른사람', '로보월드합성')).toBeNull();
  });

  it('does not invent evidence from an empty term', () => {
    expect(titleEvidence('PER-909005 합성인물', '   ')).toBeNull();
  });
});

describe('content matches get a bounded snippet around the match', () => {
  it('shows the matched sentence, not the document', () => {
    const evidence = contentEvidence(SYNTHETIC_DOC, '로보월드합성');
    expect(evidence?.kind).toBe('content');
    expect(evidence!.snippet).toContain('로보월드합성');
    expect(evidence!.snippet).toContain('부스에서');
    expect(evidence!.snippet.length, '스니펫이 상한을 넘었다').toBeLessThanOrEqual(SNIPPET_MAX);
    expect(evidence!.snippet.length, '문서 전문을 붙이면 안 된다').toBeLessThan(SYNTHETIC_DOC.length / 2);
  });

  it('points the highlight at the matched span inside the snippet it returns', () => {
    const evidence = contentEvidence(SYNTHETIC_DOC, '로보월드합성')!;
    expect(evidence.marks.length).toBeGreaterThan(0);
    for (const mark of evidence.marks) {
      expect(evidence.snippet.slice(mark.start, mark.end).toLowerCase()).toBe('로보월드합성');
    }
  });

  it('says the snippet is clipped instead of pretending it is a whole sentence', () => {
    const long = `${'합성 문장 채우기. '.repeat(30)}로보월드합성 부스.${' 뒤쪽 합성 문장.'.repeat(30)}`;
    const evidence = contentEvidence(long, '로보월드합성')!;
    expect(evidence.snippet.length).toBeLessThanOrEqual(SNIPPET_MAX);
    expect(evidence.leadingGap).toBe(true);
    expect(evidence.trailingGap).toBe(true);
  });

  it('claims no evidence when the term is nowhere in the readable body', () => {
    expect(contentEvidence(SYNTHETIC_DOC, '존재하지않는합성어')).toBeNull();
  });

  // 상한을 채우려고 옆 줄을 긁어오면 짧은 문서에서는 사실상 문서 전문이 붙는다.
  it('stays inside the matched line instead of padding with neighbouring lines', () => {
    const doc = ['# 합성인물', '', '로보월드합성 부스.', '옆줄합성내용은 매칭과 무관하다.'].join('\n');
    const evidence = contentEvidence(doc, '로보월드합성')!;
    expect(evidence.snippet).toBe('로보월드합성 부스.');
    expect(evidence.snippet, '매칭과 무관한 옆 줄을 끌어오면 안 된다').not.toContain('옆줄합성내용');
  });
});

// 누출 방지가 이 기능의 조건이다 — 근거를 못 만드는 것이 사적 정보를 흘리는 것보다 낫다.
describe('a snippet never carries frontmatter internals, credentials, or private sections', () => {
  const leaks = [
    'kx9Q2mSyntheticFakeTokenValue00000000',
    '1SyntheticFakeFolderIdValue0000000000',
    'internal_api_key',
    'drive_folder_id',
    'typeID',
    'reviewStatus',
    '합성비공개내용',
  ];

  it('drops the frontmatter block, the Private section, and URLs from the snippet source', () => {
    const source = snippetSource(SYNTHETIC_DOC);
    for (const leak of leaks) expect(source, `'${leak}' 가 스니펫 원본에 남아 있다`).not.toContain(leak);
    expect(source, '읽어도 되는 본문까지 지우면 근거를 만들 수 없다').toContain('로보월드합성 부스에서');
  });

  it('keeps every returned snippet free of those strings whatever the term is', () => {
    for (const term of ['합성', '로보월드합성', 'Synthetic', 'PER', '메모', '자료']) {
      const evidence = contentEvidence(SYNTHETIC_DOC, term);
      if (!evidence) continue;
      for (const leak of leaks) expect(evidence.snippet, `'${term}' 검색이 '${leak}' 를 노출했다`).not.toContain(leak);
    }
  });

  it('reports no evidence rather than quoting a Private-only match', () => {
    const privateOnly = ['# 합성인물', '', '평범한 합성 본문.', '', '## Private', '비밀합성단어가 여기에만 있다.'].join('\n');
    expect(contentEvidence(privateOnly, '비밀합성단어'), 'Private 섹션만 맞았는데 근거를 만들면 누출이다').toBeNull();
  });

  it('reports no evidence rather than quoting a frontmatter-only match', () => {
    const frontOnly = ['---', 'internal_note: 프런트매터합성값', '---', '', '# 합성인물', '평범한 합성 본문.'].join('\n');
    expect(contentEvidence(frontOnly, '프런트매터합성값')).toBeNull();
  });

  it('drops any line carrying a token-shaped value even outside frontmatter', () => {
    const inline = ['# 합성인물', '', '접속 코드는 k=AbcDef0123456789Xyz987654 입니다.', '', '로보월드합성 부스에서 만났다.'].join('\n');
    const source = snippetSource(inline);
    expect(source).not.toContain('AbcDef0123456789Xyz987654');
    expect(source).toContain('로보월드합성');
  });
});

describe('content lookups stay bounded', () => {
  const hits: SearchItem[] = [
    { id: 'f-1', title: 'PER-909001 합성 1', via: 'title' },
    { id: 'f-2', title: 'PER-909002 합성 2', via: 'content' },
    { id: 'f-3', title: 'PER-909003 합성 3', via: 'content' },
    { id: 'f-4', title: 'PER-909004 합성 4', via: 'content' },
    { id: 'f-5', title: 'PER-909005 합성 5', via: 'content' },
    { id: 'f-6', title: 'PER-909006 합성 6', via: 'content' },
    { id: 'f-7', title: 'PER-909007 합성 7', via: 'content' },
  ];

  it('only fetches documents for content matches, and only up to the request cap', () => {
    const targets = contentLookupTargets(hits);
    expect(targets).toEqual(['f-2', 'f-3', 'f-4', 'f-5'].slice(0, MAX_CONTENT_LOOKUPS));
    expect(targets.length).toBeLessThanOrEqual(MAX_CONTENT_LOOKUPS);
    expect(targets).not.toContain('f-1');
  });

  it('fetches nothing when a title match already explains itself', () => {
    expect(contentLookupTargets([{ id: 'f-1', title: 'PER-909001 합성 1', via: 'title' }])).toEqual([]);
  });
});

describe('rendering split keeps highlight offsets honest', () => {
  it('splits a snippet into plain and marked segments that rebuild the original', () => {
    const evidence = titleEvidence('PER-909002 합성인물-로보월드합성', '로보월드합성')!;
    const segments = evidenceSegments(evidence);
    expect(segments.map((segment) => segment.text).join('')).toBe(evidence.snippet);
    expect(segments.filter((segment) => segment.marked).map((segment) => segment.text)).toEqual(['로보월드합성']);
  });

  it('returns one plain segment when nothing is marked', () => {
    expect(evidenceSegments({ kind: 'content', snippet: '합성 근거', marks: [], leadingGap: false, trailingGap: false }))
      .toEqual([{ text: '합성 근거', marked: false }]);
  });
});
