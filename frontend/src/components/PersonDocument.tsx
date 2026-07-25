import { useMemo } from 'react';
import { Mail, MessageCircle, Phone, Plus, Search, UserPlus } from 'lucide-react';
import type { PersonTarget } from '../contracts/capture';
import { labelImageEmbeds, parsePersonFrontmatter } from '../services/markdown';
import { type ContactCard, buildVCard, contactCardFromFrontmatter, hasContactActions } from '../services/contacts';
import { MarkdownLite } from './MarkdownLite';

export function downloadContactVCard(contact: ContactCard): void {
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(new Blob([buildVCard(contact)], { type: 'text/vcard;charset=utf-8' }));
  anchor.download = `${contact.name || 'contact'}.vcf`;
  document.body.appendChild(anchor);
  anchor.click();
  window.setTimeout(() => { URL.revokeObjectURL(anchor.href); anchor.remove(); }, 1_500);
}

// 브리핑·프로필 공용 연락 실행 줄: 전화·문자·메일·연락처 저장 (legacy contactRow).
export function ContactActions({ contact }: { contact: ContactCard | null }) {
  if (!hasContactActions(contact) || !contact) return null;
  return (
    <div className="action-grid" onClick={(event) => event.stopPropagation()}>
      {contact.phones[0] && <a href={`tel:${contact.phones[0]}`}><Phone aria-hidden="true" size={15} />전화</a>}
      {contact.phones[0] && <a href={`sms:${contact.phones[0]}`}><MessageCircle aria-hidden="true" size={15} />문자</a>}
      {contact.emails[0] && <a href={`mailto:${contact.emails[0]}`}><Mail aria-hidden="true" size={15} />메일</a>}
      <button type="button" onClick={() => downloadContactVCard(contact)}><UserPlus aria-hidden="true" size={15} />연락처 저장</button>
    </div>
  );
}

// 미팅 프렙 카드 + frontmatter 요약 박스 + 본문 렌더링 (legacy prepCardOf + renderPersonMd).
export function PersonDocument({
  markdown,
  fallbackName,
  noteTarget,
  canResearch,
  onNote,
  onResearch,
}: {
  markdown: string;
  fallbackName: string;
  noteTarget: PersonTarget | null;
  canResearch: boolean;
  onNote: (target: PersonTarget) => void;
  onResearch: (target: PersonTarget) => void;
}) {
  const parsed = useMemo(() => parsePersonFrontmatter(markdown), [markdown]);
  const contact = useMemo(() => contactCardFromFrontmatter(parsed, fallbackName), [fallbackName, parsed]);
  const body = useMemo(() => labelImageEmbeds(parsed.body), [parsed.body]);
  return (
    <div className="person-document">
      <section className="prep-card">
        <strong>{contact.name}{contact.title ? ` · ${contact.title}` : ''}</strong>
        {contact.organization && <span>{contact.organization}</span>}
        {parsed.vals.last_contacted && <span>마지막 확인 {parsed.vals.last_contacted}</span>}
        <ContactActions contact={contact} />
        {noteTarget && (
          <div className="action-grid">
            <button className="primary" type="button" onClick={() => onNote(noteTarget)}><Plus aria-hidden="true" size={15} />메모 추가</button>
            {canResearch && <button type="button" onClick={() => onResearch(noteTarget)}><Search aria-hidden="true" size={15} />조사 지시</button>}
          </div>
        )}
      </section>
      {parsed.raw && <pre className="md-frontmatter">{parsed.raw}</pre>}
      <MarkdownLite text={body} />
    </div>
  );
}
