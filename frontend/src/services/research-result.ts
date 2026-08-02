import type { ResearchEvidenceGraph } from '../contracts/capture';

export function validateResearchEvidenceGraph(value: unknown): { ok: true; graph: ResearchEvidenceGraph } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!value || typeof value !== 'object') return { ok: false, errors: ['graph_not_object'] };
  const graph = value as ResearchEvidenceGraph;
  if (graph.version !== 'deep-research-evidence-v1') errors.push('bad_version');
  if (!Array.isArray(graph.claims)) errors.push('claims_missing');
  if (!Array.isArray(graph.timeline)) errors.push('timeline_missing');
  if (!Array.isArray(graph.openQuestions)) errors.push('open_questions_missing');
  const ids = new Set<string>();
  for (const claim of Array.isArray(graph.claims) ? graph.claims : []) {
    if (!claim.id || ids.has(claim.id)) errors.push('duplicate_or_missing_claim_id');
    ids.add(claim.id);
    if (!['fact', 'conflict', 'unknown', 'hypothesis'].includes(claim.state)) errors.push(`bad_claim_state:${claim.id}`);
    if (!claim.summary?.trim()) errors.push(`claim_summary_missing:${claim.id}`);
    if (!Array.isArray(claim.evidenceFor) || !Array.isArray(claim.evidenceAgainst)) errors.push(`evidence_arrays_missing:${claim.id}`);
    if (claim.state === 'fact' && !claim.evidenceFor?.length) errors.push(`unsupported_fact:${claim.id}`);
    if (claim.state === 'hypothesis' && (!claim.evidenceFor?.length || !claim.evidenceAgainst?.length || !claim.alternativeExplanation?.trim() || !claim.confidence)) {
      errors.push(`one_sided_hypothesis:${claim.id}`);
    }
  }
  for (const event of Array.isArray(graph.timeline) ? graph.timeline : []) {
    for (const claimId of event.claimIds || []) if (!ids.has(claimId)) errors.push(`timeline_unknown_claim:${claimId}`);
  }
  if (!graph.stop || !['purpose_satisfied', 'source_exhausted', 'irrelevant_branch', 'time_cap', 'branch_cap'].includes(graph.stop.reason) || !graph.stop.summary?.trim()) {
    errors.push('bad_stop');
  }
  return errors.length ? { ok: false, errors } : { ok: true, graph };
}
