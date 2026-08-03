import { useId, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import type { ResearchEvidenceGraph, ResearchEvidenceLink } from '../contracts/capture';
import { claimConfidenceText } from '../services/research-vocabulary';

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

const TABS = [
  { id: 'core', label: '핵심' },
  { id: 'timeline', label: '시간축' },
  { id: 'evidence', label: '근거망' },
] as const;

type TabId = typeof TABS[number]['id'];

/**
 * 출처는 글자 조각이 아니라 누르는 자리다 — 링크를 브라우저 기본값(파란 밑줄 16px)으로 두지 않는다.
 * `url`은 `research-result.ts`의 검증을 통과한 공개 주소만 여기까지 온다.
 */
function SourceLinks({ sources, emptyText }: { sources: ResearchEvidenceLink[]; emptyText: string }) {
  if (!sources.length) return <span className="research-evidence-empty">{emptyText}</span>;
  return (
    <div className="research-source-links">
      {sources.map((source) => (
        <a
          className="research-source-link"
          key={`${source.sourceId}-${source.url}`}
          href={source.url}
          target="_blank"
          rel="noopener noreferrer external"
        >
          <span className="research-source-title">{source.title}</span>
          <ArrowUpRight aria-hidden="true" size={13} />
        </a>
      ))}
    </div>
  );
}

export function ResearchEvidencePanel({ graph }: { graph: ResearchEvidenceGraph }) {
  const [tab, setTab] = useState<TabId>('core');
  const panelId = useId();
  const counts = Object.keys(STATE_LABELS).map((state) => ({
    state: state as keyof typeof STATE_LABELS,
    count: graph.claims.filter((claim) => claim.state === state).length,
  }));

  return (
    <section className="research-evidence" aria-label="Deep Research 근거 결과">
      <header>
        <div><span className="eyebrow">Deep Research</span><h4>근거를 따라 확인한 결과</h4></div>
      </header>

      {/* 왜 여기서 멈췄는가 + 어디까지 봤는가. 헤더 구석에 46% 폭으로 접히던 조각을 한 블록으로 모은다. */}
      <div className="research-stop">
        <span className="research-stop-label">여기서 멈춘 이유</span>
        <strong className="research-stop-reason">{STOP_LABELS[graph.stop.reason]}</strong>
        <p className="research-stop-summary">{graph.stop.summary}</p>
        <small className="research-stop-scope">
          공개 출처 {graph.metrics.sourceCount}곳 · 탐색 가지 {graph.metrics.branchCount}개 · 걸린 시간 {graph.metrics.elapsedMinutes}분
        </small>
      </div>

      {/* 숫자만 있는 네 상자는 무엇의 숫자인지 말하지 않는다 — 값과 이름을 같은 조각으로 묶는다. */}
      <div className="research-counts" role="list" aria-label="주장 상태별 개수">
        {counts.map((item) => (
          <span className={`research-count is-${item.state}`} key={item.state} role="listitem">
            <b className="research-count-value">{item.count}</b>
            <small className="research-count-label">{STATE_LABELS[item.state]}</small>
          </span>
        ))}
      </div>

      <div className="research-result-tabs" role="tablist" aria-label="조사 결과 보기">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            id={`${panelId}-tab-${id}`}
            type="button"
            role="tab"
            aria-selected={tab === id}
            aria-controls={`${panelId}-panel-${id}`}
            className={tab === id ? 'on' : ''}
            onClick={() => setTab(id)}
          >{label}</button>
        ))}
      </div>

      {tab === 'core' && (
        <div className="research-claims" role="tabpanel" id={`${panelId}-panel-core`} aria-labelledby={`${panelId}-tab-core`}>
          {graph.claims.map((claim) => {
            const confidence = claimConfidenceText(claim.confidence);
            return (
              <article key={claim.id} className={`research-claim is-${claim.state}`}>
                {/* `확신 medium`이 그대로 나가던 자리. 서버 enum은 등록소 하나에서만 옮긴다. */}
                <span className="research-claim-state">{STATE_LABELS[claim.state]}{confidence ? ` · ${confidence}` : ''}</span>
                <strong className="research-claim-summary">{claim.summary}</strong>
                {claim.state === 'hypothesis' && (
                  <p className="research-claim-alt">다른 설명: {claim.alternativeExplanation || '아직 정리되지 않음'}</p>
                )}
              </article>
            );
          })}
          {!graph.claims.length && (
            <p className="research-empty">아직 근거로 확인된 주장이 없어요. 공개 자료에서 확인된 것이 나오면 여기에 쌓입니다.</p>
          )}
          {graph.openQuestions.length > 0 && (
            <div className="research-open">
              <strong>아직 답하지 못한 질문</strong>
              <ul>{graph.openQuestions.map((question) => <li key={question}>{question}</li>)}</ul>
            </div>
          )}
        </div>
      )}

      {tab === 'timeline' && (
        <ol className="research-timeline" role="tabpanel" id={`${panelId}-panel-timeline`} aria-labelledby={`${panelId}-tab-timeline`}>
          {graph.timeline.map((event) => (
            <li key={`${event.date}-${event.label}`}>
              <time>{event.date}</time>
              <strong>{event.label}</strong>
              <small>연결된 주장 {event.claimIds.length}개</small>
            </li>
          ))}
          {!graph.timeline.length && <li><strong>확인 가능한 시간축이 아직 없어요</strong></li>}
        </ol>
      )}

      {tab === 'evidence' && (
        <div className="research-evidence-list" role="tabpanel" id={`${panelId}-panel-evidence`} aria-labelledby={`${panelId}-tab-evidence`}>
          {graph.claims.map((claim) => (
            <article key={claim.id}>
              <strong className="research-claim-summary">{claim.summary}</strong>
              <div className="research-evidence-side">
                <b>찬성 근거</b>
                <SourceLinks sources={claim.evidenceFor} emptyText="확인된 찬성 근거 없음" />
              </div>
              <div className="research-evidence-side">
                <b>반대 근거</b>
                <SourceLinks sources={claim.evidenceAgainst} emptyText="확인된 반대 근거 없음" />
              </div>
            </article>
          ))}
          {!graph.claims.length && (
            <p className="research-empty">근거망에 넣을 주장이 아직 없어요.</p>
          )}
        </div>
      )}
    </section>
  );
}
