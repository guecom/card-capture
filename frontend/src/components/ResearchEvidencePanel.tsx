import { useState } from 'react';
import type { ResearchEvidenceGraph } from '../contracts/capture';

const STATE_LABELS = {
  fact: '확인된 사실',
  conflict: '출처 충돌',
  unknown: '아직 모름',
  hypothesis: '가설',
} as const;

const STOP_LABELS = {
  purpose_satisfied: '목적에 필요한 근거를 확보함',
  source_exhausted: '확인 가능한 공개 출처를 모두 살펴봄',
  irrelevant_branch: '목적과 무관한 탐색 가지를 중단함',
  time_cap: '정해진 시간 상한에 도달함',
  branch_cap: '정해진 탐색 가지 상한에 도달함',
} as const;

export function ResearchEvidencePanel({ graph }: { graph: ResearchEvidenceGraph }) {
  const [tab, setTab] = useState<'core' | 'timeline' | 'evidence'>('core');
  const counts = Object.keys(STATE_LABELS).map((state) => ({
    state: state as keyof typeof STATE_LABELS,
    count: graph.claims.filter((claim) => claim.state === state).length,
  }));

  return (
    <section className="research-evidence" aria-label="Deep Research 근거 결과">
      <header>
        <div><span className="eyebrow">Deep Research</span><h4>근거를 따라 확인한 결과</h4></div>
        <span className="research-stop">{STOP_LABELS[graph.stop.reason]}</span>
      </header>
      <div className="research-counts">
        {counts.map((item) => <span key={item.state} className={`is-${item.state}`}><b>{item.count}</b>{STATE_LABELS[item.state]}</span>)}
      </div>
      <div className="research-result-tabs" role="tablist" aria-label="조사 결과 보기">
        {([['core', '핵심'], ['timeline', '시간축'], ['evidence', '근거망']] as const).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      {tab === 'core' && (
        <div className="research-claims" role="tabpanel">
          {graph.claims.map((claim) => (
            <article key={claim.id} className={`research-claim is-${claim.state}`}>
              <span>{STATE_LABELS[claim.state]}{claim.confidence ? ` · 확신 ${claim.confidence}` : ''}</span>
              <strong>{claim.summary}</strong>
              {claim.state === 'hypothesis' && <p>다른 설명: {claim.alternativeExplanation || '아직 정리되지 않음'}</p>}
            </article>
          ))}
          {graph.openQuestions.length > 0 && <div className="research-open"><strong>아직 답하지 못한 질문</strong><ul>{graph.openQuestions.map((question) => <li key={question}>{question}</li>)}</ul></div>}
        </div>
      )}
      {tab === 'timeline' && (
        <ol className="research-timeline" role="tabpanel">
          {graph.timeline.map((event) => <li key={`${event.date}-${event.label}`}><time>{event.date}</time><strong>{event.label}</strong><small>연결된 주장 {event.claimIds.length}개</small></li>)}
          {!graph.timeline.length && <li><strong>확인 가능한 시간축이 아직 없어요</strong></li>}
        </ol>
      )}
      {tab === 'evidence' && (
        <div className="research-evidence-list" role="tabpanel">
          {graph.claims.map((claim) => (
            <article key={claim.id}>
              <strong>{claim.summary}</strong>
              <div><b>찬성 근거</b>{claim.evidenceFor.length ? claim.evidenceFor.map((source) => source.url ? <a key={`${claim.id}-for-${source.title}`} href={source.url} target="_blank" rel="noreferrer">{source.title}</a> : <span key={`${claim.id}-for-${source.title}`}>{source.title}</span>) : <span>없음</span>}</div>
              <div><b>반대 근거</b>{claim.evidenceAgainst.length ? claim.evidenceAgainst.map((source) => source.url ? <a key={`${claim.id}-against-${source.title}`} href={source.url} target="_blank" rel="noreferrer">{source.title}</a> : <span key={`${claim.id}-against-${source.title}`}>{source.title}</span>) : <span>없음</span>}</div>
            </article>
          ))}
        </div>
      )}
      <footer>{graph.stop.summary}</footer>
    </section>
  );
}
