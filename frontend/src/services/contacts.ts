// Legacy contactsFromBrief/vcardDownload/prep-card contact 동작 계약 포팅.
import type { BriefItem, ContactSummary } from '../contracts/capture';
import type { PersonFrontmatter } from './markdown';

export interface ContactCard {
  name: string;
  organization: string;
  title: string;
  emails: string[];
  phones: string[];
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

// 서버 contact 요약이 없을 때 brief 본문에서 연락처를 추출한다 (기존 캡처도 동작).
export function contactsFromText(text: string): { emails: string[]; phones: string[] } {
  const source = String(text ?? '');
  const emails = unique(source.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []).slice(0, 2);
  const phones = unique((source.match(/(?:\+82[\s-]?)?0?1[016789][\s-]?\d{3,4}[\s-]?\d{4}/g) ?? []).map((phone) => phone.trim())).slice(0, 2);
  return { emails, phones };
}

export function contactCardFromSummary(name: string, summary: ContactSummary | null | undefined): ContactCard {
  return {
    name: summary?.name || name,
    organization: summary?.company || summary?.organization || '',
    title: summary?.title || '',
    emails: unique([...(summary?.emails ?? []), summary?.email ?? '']),
    phones: unique([...(summary?.phones ?? []), summary?.phone ?? '']),
  };
}

// 브리핑 카드용: 서버 contact 우선, 없으면 brief 텍스트 추출 폴백 (legacy 규칙).
export function contactCardFromBrief(item: BriefItem, displayName: string): ContactCard | null {
  const fromSummary = contactCardFromSummary(displayName, item.contact);
  if (fromSummary.emails.length || fromSummary.phones.length) return fromSummary;
  if (!item.brief) return null;
  const extracted = contactsFromText(item.brief);
  if (!extracted.emails.length && !extracted.phones.length) return null;
  return { name: displayName, organization: '', title: '', emails: extracted.emails, phones: extracted.phones };
}

// 미팅 프렙 카드용: Person .md frontmatter에서 연락처를 만든다 (legacy prepCardOf 규칙).
export function contactCardFromFrontmatter(frontmatter: PersonFrontmatter, fallbackName: string): ContactCard {
  const name = frontmatter.vals.name || fallbackName || '';
  const organization = (frontmatter.vals.organization || '').replace(/^ORG-\d+\s*/, '')
    || (frontmatter.lists.organization_mentions ?? [])[0]
    || '';
  return {
    name,
    organization,
    title: frontmatter.vals.title || '',
    emails: unique(frontmatter.lists.emails ?? []),
    phones: unique(frontmatter.lists.phones ?? []),
  };
}

export function hasContactActions(contact: ContactCard | null): boolean {
  return Boolean(contact && (contact.phones[0] || contact.emails[0]));
}

export function buildVCard(contact: ContactCard): string {
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${contact.name || '연락처'}`, `N:${contact.name || ''};;;;`];
  if (contact.organization) lines.push(`ORG:${contact.organization}`);
  if (contact.title) lines.push(`TITLE:${contact.title}`);
  contact.phones.forEach((phone) => lines.push(`TEL;TYPE=CELL:${phone}`));
  contact.emails.forEach((email) => lines.push(`EMAIL:${email}`));
  lines.push('NOTE:Kairen Card Capture', 'END:VCARD');
  return lines.join('\r\n');
}
