import { describe, expect, it } from 'vitest';
import { buildVCard, contactCardFromBrief, contactCardFromFrontmatter, contactsFromText } from './contacts';
import { parsePersonFrontmatter } from './markdown';

describe('contactsFromText', () => {
  it('extracts deduplicated emails and korean mobile numbers with limits', () => {
    const text = '연락처: gildong@robotech.kr / gildong@robotech.kr / 010-1234-5678, +82 10-1234-5678, 01099998888, third@x.io, second@y.io';
    const extracted = contactsFromText(text);
    expect(extracted.emails).toEqual(['gildong@robotech.kr', 'third@x.io']);
    expect(extracted.phones.length).toBe(2);
    expect(extracted.phones[0]).toBe('010-1234-5678');
  });
});

describe('contactCardFromBrief', () => {
  it('prefers the server contact summary', () => {
    const card = contactCardFromBrief({
      captureId: 'c1',
      status: 'processed',
      contact: { name: '홍길동', phones: ['010-1111-2222'] },
      brief: '# 홍길동 — 이런 분이에요\n010-9999-8888',
    }, '홍길동');
    expect(card?.phones).toEqual(['010-1111-2222']);
  });

  it('falls back to text extraction when the summary is missing', () => {
    const card = contactCardFromBrief({
      captureId: 'c2',
      status: 'processed',
      brief: '# 홍길동 — 이런 분이에요\n연락: gildong@robotech.kr',
    }, '홍길동');
    expect(card?.emails).toEqual(['gildong@robotech.kr']);
    expect(card?.name).toBe('홍길동');
  });

  it('returns null when nothing is reachable', () => {
    expect(contactCardFromBrief({ captureId: 'c3', status: 'received' }, '아무개')).toBeNull();
  });
});

describe('contactCardFromFrontmatter', () => {
  it('reads name, org, title and contact lists like the legacy prep card', () => {
    const frontmatter = parsePersonFrontmatter([
      '---',
      'name: 홍길동',
      'title: CTO',
      'organization: "[[ORG-000003 로보텍]]"',
      'emails:',
      '  - gildong@robotech.kr',
      'phones:',
      '  - 010-1234-5678',
      '---',
      '본문',
    ].join('\n'));
    const card = contactCardFromFrontmatter(frontmatter, '폴백');
    expect(card.name).toBe('홍길동');
    expect(card.organization).toBe('로보텍');
    expect(card.title).toBe('CTO');
    expect(card.phones).toEqual(['010-1234-5678']);
  });

  it('falls back to organization_mentions and fallback name', () => {
    const frontmatter = parsePersonFrontmatter([
      '---',
      'organization_mentions:',
      '  - 한빛로보틱스',
      '---',
      '본문',
    ].join('\n'));
    const card = contactCardFromFrontmatter(frontmatter, '김서연');
    expect(card.name).toBe('김서연');
    expect(card.organization).toBe('한빛로보틱스');
  });
});

describe('buildVCard', () => {
  it('builds the legacy vCard shape', () => {
    const vcard = buildVCard({ name: '홍길동', organization: '로보텍', title: 'CTO', emails: ['a@b.c'], phones: ['010-1234-5678'] });
    expect(vcard.split('\r\n')).toEqual([
      'BEGIN:VCARD',
      'VERSION:3.0',
      'FN:홍길동',
      'N:홍길동;;;;',
      'ORG:로보텍',
      'TITLE:CTO',
      'TEL;TYPE=CELL:010-1234-5678',
      'EMAIL:a@b.c',
      'NOTE:Kairen Card Capture',
      'END:VCARD',
    ]);
  });
});
