import { type ReactNode, useMemo } from 'react';
import { ArrowUpRight, Link2, Mail, MessageCircle, Phone, Plus, Search, Sparkles, UserPlus } from 'lucide-react';
import type { PersonTarget } from '../contracts/capture';
import { buildHighlights, highlightLabel } from '../services/highlights';
import { labelImageEmbeds, type PersonFrontmatter, parsePersonFrontmatter, safeExternalUrl } from '../services/markdown';
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

export function ActionSection({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <section className={`person-action-section ${className}`.trim()}>
      <span className="person-action-label">{label}</span>
      <div className="action-grid">{children}</div>
    </section>
  );
}

interface ProfileLink {
  href: string;
  label: string;
}

function profileLinksFromFrontmatter(parsed: PersonFrontmatter): ProfileLink[] {
  const candidates = [
    ...(parsed.lists.urls ?? []),
    ...(parsed.lists.source_refs ?? []),
    parsed.vals.source ?? '',
  ];
  const seen = new Set<string>();
  return candidates.flatMap((candidate) => {
    const match = /https?:\/\/[^\s"']+/.exec(candidate);
    if (!match) return [];
    const rawUrl = match[0].replace(/[.,;!?]+$/, '');
    const href = safeExternalUrl(rawUrl);
    if (!href || seen.has(href)) return [];
    seen.add(href);
    const prefix = candidate.slice(0, match.index).replace(/[:\s-]+$/, '').trim();
    const hostname = new URL(href).hostname.replace(/^www\./, '');
    return [{ href, label: prefix || hostname }];
  }).slice(0, 6);
}

// 브리핑·프로필 공용 연락 실행 줄: 전화·문자·메일·연락처 저장 (legacy contactRow).
export function ContactActions({ contact }: { contact: ContactCard | null }) {
  if (!hasContactActions(contact) || !contact) return null;
  return (
    <div onClick={(event) => event.stopPropagation()}>
      <ActionSection label="연락" className="contact-actions">
        {contact.phones[0] && <a href={`tel:${contact.phones[0]}`}><Phone aria-hidden="true" size={16} />전화</a>}
        {contact.phones[0] && <a href={`sms:${contact.phones[0]}`}><MessageCircle aria-hidden="true" size={16} />문자</a>}
        {contact.emails[0] && <a href={`mailto:${contact.emails[0]}`}><Mail aria-hidden="true" size={16} />메일</a>}
        <button type="button" onClick={() => downloadContactVCard(contact)}><UserPlus aria-hidden="true" size={16} />연락처 저장</button>
      </ActionSection>
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
  const profileLinks = useMemo(() => profileLinksFromFrontmatter(parsed), [parsed]);
  const highlights = useMemo(() => buildHighlights(markdown), [markdown]);
  return (
    <div className="person-document">
      {/* 전문을 읽기 전에 지금 쓸 만한 사실 1~3줄. 기록에 있는 문장만 인용하고 출처 섹션을 함께 보여 준다. */}
      {highlights.items.length > 0 && (
        <section className="now-card" aria-label="지금 알아둘 것">
          <span className="now-head"><Sparkles aria-hidden="true" size={13} />지금 알아둘 것</span>
          <ul>
            {highlights.items.map((highlight) => (
              <li key={highlight.text}>
                <strong>{highlightLabel(highlight.kind)}</strong>
                <p>{highlight.text}</p>
                <small>기록의 “{highlight.sourceSection}”에서 그대로 가져왔어요</small>
              </li>
            ))}
          </ul>
          <small className="now-foot">{highlights.checkedAt ? `${highlights.checkedAt} 기준 기록이에요 — 만나기 전에 최신 여부만 확인하세요.` : '확인 시점이 기록에 없어요 — 최신 여부는 직접 확인하세요.'}</small>
        </section>
      )}
      <section className="prep-card">
        <strong>{contact.name}{contact.title ? ` · ${contact.title}` : ''}</strong>
        {contact.organization && <span>{contact.organization}</span>}
        {parsed.vals.last_contacted && <span>마지막 확인 {parsed.vals.last_contacted}</span>}
        {profileLinks.length > 0 && (
          <div className="profile-links" aria-label="프로필 바로가기">
            <span><Link2 aria-hidden="true" size={13} />바로가기</span>
            <div>{profileLinks.map((link) => <a href={link.href} key={link.href} target="_blank" rel="noopener noreferrer external">{link.label}<ArrowUpRight aria-hidden="true" size={11} /></a>)}</div>
          </div>
        )}
        <ContactActions contact={contact} />
        {noteTarget && (
          <ActionSection label="기록" className="record-actions">
            <button type="button" onClick={() => onNote(noteTarget)}><Plus aria-hidden="true" size={16} />메모 추가</button>
            {canResearch && <button type="button" onClick={() => onResearch(noteTarget)}><Search aria-hidden="true" size={16} />조사 지시</button>}
          </ActionSection>
        )}
      </section>
      {parsed.raw && <details className="profile-metadata"><summary>기록 정보 보기</summary><pre className="md-frontmatter">{parsed.raw}</pre></details>}
      <MarkdownLite text={body} />
    </div>
  );
}
