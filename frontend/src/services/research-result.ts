import type {
  ResearchEvidenceGraph,
  ResearchEvidenceLink,
  ResearchEvidenceClaim,
  ResearchGraphEdge,
  ResearchGraphNode,
} from '../contracts/capture';

type ValidationResult = { ok: true; graph: ResearchEvidenceGraph } | { ok: false; errors: string[] };

export type ResearchEvidenceView =
  | { kind: 'none' }
  | { kind: 'ready'; graph: ResearchEvidenceGraph }
  | { kind: 'invalid'; errors: string[] };

const CLAIM_STATES = new Set(['fact', 'conflict', 'unknown', 'hypothesis']);
const CONFIDENCE_LEVELS = new Set(['low', 'medium', 'high']);
const PURPOSE_ORDER = ['meeting_preparation', 'expertise_execution', 'authority_interests', 'reputation_risk'] as const;
const PURPOSES = new Set(PURPOSE_ORDER);
const STOP_REASONS = new Set(['purpose_satisfied', 'source_exhausted', 'irrelevant_branch', 'time_cap', 'branch_cap']);
const NODE_TYPES = new Set(['person', 'organization', 'project', 'event', 'claim', 'source']);
const EDGE_RELATIONS = new Set([
  'supports', 'counterevidence', 'affiliated_with', 'leads', 'member_of',
  'worked_on', 'participated_in', 'occurred_at', 'involves', 'related_to',
]);
const GRAPH_ID = /^[A-Za-z][A-Za-z0-9._:-]{0,79}$/;
const PUBLIC_URL = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:[/?#][^\s]*)?$/i;

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string' || !value || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : null;
}

function safeId(value: unknown): string | null {
  const id = safeText(value, 80);
  return id && GRAPH_ID.test(id) ? id : null;
}

function safePublicUrl(value: unknown): string | null {
  const text = safeText(value, 2048);
  if (!text || !PUBLIC_URL.test(text) || /[\\\s]/.test(text) || /^https?:\/\/[^/?#]*@/i.test(text)) return null;
  try {
    const url = new URL(text);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? text : null;
  } catch {
    return null;
  }
}

function boundedMetric(value: unknown, cap: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= cap;
}

function evidenceKey(sourceId: string, claimId: string, relation: 'supports' | 'counterevidence'): string {
  return `${sourceId}\n${claimId}\n${relation}`;
}

function validateEvidenceList(
  value: unknown,
  path: string,
  claimId: string,
  relation: 'supports' | 'counterevidence',
  nodes: Map<string, ResearchGraphNode>,
  expectedEdges: Set<string>,
  errors: string[],
): ResearchEvidenceLink[] | null {
  if (!Array.isArray(value) || value.length > 100) {
    errors.push(`${path}_missing`);
    return null;
  }
  const result: ResearchEvidenceLink[] = [];
  value.forEach((candidate, index) => {
    const evidence = recordOf(candidate);
    if (!evidence) {
      errors.push(`${path}_item_not_object:${index}`);
      return;
    }
    const sourceId = safeId(evidence.sourceId);
    const title = safeText(evidence.title, 500);
    const url = safePublicUrl(evidence.url);
    if (!sourceId) errors.push(`${path}_source_id_invalid:${index}`);
    if (!title) errors.push(`${path}_title_missing:${index}`);
    if (!url) errors.push(`${path}_url_invalid:${index}`);
    const source = sourceId ? nodes.get(sourceId) : undefined;
    if (!source || source.type !== 'source') errors.push(`${path}_source_missing:${index}`);
    if (source && title && source.label !== title) errors.push(`${path}_source_label_mismatch:${index}`);
    if (source && url && source.url !== url) errors.push(`${path}_source_url_mismatch:${index}`);
    const publishedAt = evidence.publishedAt === undefined ? undefined : safeText(evidence.publishedAt, 40);
    if (evidence.publishedAt !== undefined && !publishedAt) errors.push(`${path}_published_at_invalid:${index}`);
    if (!sourceId || !title || !url || !source || source.type !== 'source'
        || source.label !== title || source.url !== url || (evidence.publishedAt !== undefined && !publishedAt)) return;
    const key = evidenceKey(sourceId, claimId, relation);
    if (expectedEdges.has(key)) {
      errors.push(`${path}_duplicate_source:${index}`);
      return;
    }
    expectedEdges.add(key);
    result.push({ sourceId, title, url, ...(publishedAt ? { publishedAt } : {}) });
  });
  return result;
}

/**
 * Treat research-result.json as untrusted and rebuild a known-safe graph before render.
 * A malformed nested item invalidates the whole result instead of crashing the activity feed.
 */
export function validateResearchEvidenceGraph(value: unknown): ValidationResult {
  const errors: string[] = [];
  const graph = recordOf(value);
  if (!graph) return { ok: false, errors: ['graph_not_object'] };
  if (graph.version !== 'deep-research-evidence-v1') errors.push('bad_version');

  const purposeValues = Array.isArray(graph.purposes) ? graph.purposes : [];
  if (!purposeValues.length || purposeValues.length > PURPOSE_ORDER.length) {
    errors.push('purposes_missing');
  }
  const purposeSet = new Set<string>();
  purposeValues.forEach((purpose, index) => {
    if (typeof purpose !== 'string' || !PURPOSES.has(purpose as typeof PURPOSE_ORDER[number]) || purposeSet.has(purpose)) {
      errors.push(`bad_purpose:${index}`);
    } else {
      purposeSet.add(purpose);
    }
  });
  const purposes = PURPOSE_ORDER.filter((purpose) => purposeSet.has(purpose));

  const nodeMap = new Map<string, ResearchGraphNode>();
  const nodes: ResearchGraphNode[] = [];
  let sourceNodeCount = 0;
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0 || graph.nodes.length > 500) {
    errors.push('nodes_missing');
  } else {
    graph.nodes.forEach((candidate, index) => {
      const node = recordOf(candidate);
      if (!node) {
        errors.push(`node_not_object:${index}`);
        return;
      }
      const id = safeId(node.id);
      const type = typeof node.type === 'string' && NODE_TYPES.has(node.type) ? node.type as ResearchGraphNode['type'] : null;
      const label = safeText(node.label, 500);
      const url = node.url === undefined ? undefined : safePublicUrl(node.url);
      if (!id || (id && nodeMap.has(id))) errors.push(`node_id_invalid:${index}`);
      if (!type) errors.push(`node_type_invalid:${index}`);
      if (!label) errors.push(`node_label_invalid:${index}`);
      if (node.url !== undefined && !url) errors.push(`node_url_invalid:${index}`);
      if (type === 'source' && !url) errors.push(`source_url_missing:${id || index}`);
      if (!id || nodeMap.has(id) || !type || !label || (node.url !== undefined && !url) || (type === 'source' && !url)) return;
      const safeNode: ResearchGraphNode = { id, type, label, ...(url ? { url } : {}) };
      nodeMap.set(id, safeNode);
      nodes.push(safeNode);
      if (type === 'source') sourceNodeCount += 1;
    });
  }

  const claimIds = new Set<string>();
  const claims: ResearchEvidenceClaim[] = [];
  const expectedEvidenceEdges = new Set<string>();
  if (!Array.isArray(graph.claims) || graph.claims.length > 200) {
    errors.push('claims_missing');
  } else {
    graph.claims.forEach((candidate, index) => {
      const claim = recordOf(candidate);
      if (!claim) {
        errors.push(`claim_not_object:${index}`);
        return;
      }
      const id = safeId(claim.id);
      const state = typeof claim.state === 'string' && CLAIM_STATES.has(claim.state) ? claim.state as ResearchEvidenceClaim['state'] : null;
      const summary = safeText(claim.summary, 2000);
      if (!id || (id && claimIds.has(id))) errors.push('duplicate_or_missing_claim_id');
      if (!state) errors.push(`bad_claim_state:${id || index}`);
      if (!summary) errors.push(`claim_summary_missing:${id || index}`);
      const claimNode = id ? nodeMap.get(id) : undefined;
      if (!claimNode || claimNode.type !== 'claim' || (summary && claimNode.label !== summary)) errors.push(`claim_node_mismatch:${id || index}`);
      if (id) claimIds.add(id);
      const evidenceFor = validateEvidenceList(claim.evidenceFor, `evidence_for:${id || index}`, id || String(index), 'supports', nodeMap, expectedEvidenceEdges, errors);
      const evidenceAgainst = validateEvidenceList(claim.evidenceAgainst, `evidence_against:${id || index}`, id || String(index), 'counterevidence', nodeMap, expectedEvidenceEdges, errors);
      const confidence = claim.confidence === undefined ? undefined
        : typeof claim.confidence === 'string' && CONFIDENCE_LEVELS.has(claim.confidence)
          ? claim.confidence as ResearchEvidenceClaim['confidence'] : null;
      if (claim.confidence !== undefined && !confidence) errors.push(`bad_claim_confidence:${id || index}`);
      const alternative = claim.alternativeExplanation === undefined ? undefined : safeText(claim.alternativeExplanation, 2000);
      if (claim.alternativeExplanation !== undefined && !alternative) errors.push(`alternative_invalid:${id || index}`);
      if (state === 'fact' && evidenceFor?.length === 0) errors.push(`unsupported_fact:${id || index}`);
      if (state === 'conflict' && (!evidenceFor?.length || !evidenceAgainst?.length)) errors.push(`one_sided_conflict:${id || index}`);
      if (state === 'hypothesis' && (!evidenceFor?.length || !evidenceAgainst?.length || !alternative || !confidence)) {
        errors.push(`one_sided_hypothesis:${id || index}`);
      }
      if (!id || !state || !summary || !claimNode || claimNode.type !== 'claim' || claimNode.label !== summary
          || !evidenceFor || !evidenceAgainst || confidence === null || alternative === null) return;
      claims.push({
        id,
        state,
        summary,
        evidenceFor,
        evidenceAgainst,
        ...(confidence ? { confidence } : {}),
        ...(alternative ? { alternativeExplanation: alternative } : {}),
      });
    });
  }
  nodeMap.forEach((node) => {
    if (node.type === 'claim' && !claimIds.has(node.id)) errors.push(`orphan_claim_node:${node.id}`);
  });

  const edges: ResearchGraphEdge[] = [];
  const edgeIds = new Set<string>();
  const edgeTuples = new Set<string>();
  const matchedEvidenceEdges = new Set<string>();
  if (!Array.isArray(graph.edges) || graph.edges.length > 1000) {
    errors.push('edges_missing');
  } else {
    graph.edges.forEach((candidate, index) => {
      const edge = recordOf(candidate);
      if (!edge) {
        errors.push(`edge_not_object:${index}`);
        return;
      }
      const id = safeId(edge.id);
      const sourceId = safeId(edge.sourceId);
      const targetId = safeId(edge.targetId);
      const relation = typeof edge.relation === 'string' && EDGE_RELATIONS.has(edge.relation) ? edge.relation as ResearchGraphEdge['relation'] : null;
      const label = safeText(edge.label, 200);
      if (!id || (id && edgeIds.has(id))) errors.push(`edge_id_invalid:${index}`);
      if (!sourceId || !targetId || !nodeMap.has(sourceId) || !nodeMap.has(targetId)) errors.push(`edge_endpoint_invalid:${index}`);
      if (sourceId && targetId && sourceId === targetId) errors.push(`edge_self_reference:${index}`);
      if (!relation) errors.push(`edge_relation_invalid:${index}`);
      if (!label) errors.push(`edge_label_invalid:${index}`);
      const tuple = sourceId && targetId && relation ? `${sourceId}\n${targetId}\n${relation}` : '';
      if (tuple && edgeTuples.has(tuple)) errors.push(`edge_duplicate:${index}`);
      const source = sourceId ? nodeMap.get(sourceId) : undefined;
      const target = targetId ? nodeMap.get(targetId) : undefined;
      if (relation === 'supports' || relation === 'counterevidence') {
        if (!source || source.type !== 'source' || !target || target.type !== 'claim' || !expectedEvidenceEdges.has(tuple)) {
          errors.push(`evidence_edge_mismatch:${index}`);
        } else if (matchedEvidenceEdges.has(tuple)) {
          errors.push(`evidence_edge_duplicate:${index}`);
        } else {
          matchedEvidenceEdges.add(tuple);
        }
      } else if (source?.type === 'source' && target?.type === 'claim') {
        errors.push(`source_claim_relation_invalid:${index}`);
      }
      if (!id || edgeIds.has(id) || !sourceId || !targetId || !source || !target || sourceId === targetId
          || !relation || !label || edgeTuples.has(tuple)) return;
      edgeIds.add(id);
      edgeTuples.add(tuple);
      edges.push({ id, sourceId, targetId, relation, label });
    });
  }
  expectedEvidenceEdges.forEach((key) => {
    if (!matchedEvidenceEdges.has(key)) errors.push(`evidence_edge_missing:${key.replace(/\n/g, ':')}`);
  });

  const timeline: ResearchEvidenceGraph['timeline'] = [];
  if (!Array.isArray(graph.timeline) || graph.timeline.length > 500) {
    errors.push('timeline_missing');
  } else {
    graph.timeline.forEach((candidate, index) => {
      const event = recordOf(candidate);
      if (!event) {
        errors.push(`timeline_item_not_object:${index}`);
        return;
      }
      const date = safeText(event.date, 40);
      const label = safeText(event.label, 1000);
      if (!date) errors.push(`timeline_date_missing:${index}`);
      if (!label) errors.push(`timeline_label_missing:${index}`);
      if (!Array.isArray(event.claimIds) || event.claimIds.length > 200) {
        errors.push(`timeline_claim_ids_missing:${index}`);
        return;
      }
      const timelineClaimIds: string[] = [];
      event.claimIds.forEach((claimId) => {
        if (!safeId(claimId) || !claimIds.has(String(claimId)) || timelineClaimIds.includes(String(claimId))) {
          errors.push(`timeline_unknown_claim:${String(claimId)}`);
        } else {
          timelineClaimIds.push(String(claimId));
        }
      });
      if (date && label && timelineClaimIds.length === event.claimIds.length) timeline.push({ date, label, claimIds: timelineClaimIds });
    });
  }

  const openQuestions: string[] = [];
  if (!Array.isArray(graph.openQuestions) || graph.openQuestions.length > 100) {
    errors.push('open_questions_missing');
  } else {
    graph.openQuestions.forEach((question, index) => {
      const text = safeText(question, 1000);
      if (!text || openQuestions.includes(text)) errors.push(`open_question_invalid:${index}`);
      else openQuestions.push(text);
    });
  }

  const stop = recordOf(graph.stop);
  const stopReason = stop && typeof stop.reason === 'string' && STOP_REASONS.has(stop.reason)
    ? stop.reason as ResearchEvidenceGraph['stop']['reason'] : null;
  const stopSummary = stop ? safeText(stop.summary, 2000) : null;
  if (!stopReason || !stopSummary) errors.push('bad_stop');

  const metrics = recordOf(graph.metrics);
  const metricsValid = Boolean(metrics
    && Number.isInteger(metrics.branchCount) && boundedMetric(metrics.branchCount, 24)
    && Number.isInteger(metrics.sourceCount) && boundedMetric(metrics.sourceCount, 144)
    && boundedMetric(metrics.elapsedMinutes, 90)
    && Number(metrics.sourceCount) >= sourceNodeCount);
  if (!metricsValid) {
    errors.push('bad_metrics');
  } else if (stopReason) {
    const atBranchCap = metrics!.branchCount === 24;
    const atTimeCap = metrics!.elapsedMinutes === 90;
    if ((stopReason === 'branch_cap' && !atBranchCap) || (stopReason === 'time_cap' && !atTimeCap)
        || (atBranchCap && !atTimeCap && stopReason !== 'branch_cap')
        || (atTimeCap && !atBranchCap && stopReason !== 'time_cap')
        || (atBranchCap && atTimeCap && stopReason !== 'branch_cap' && stopReason !== 'time_cap')) {
      errors.push('stop_budget_mismatch');
    }
  }

  if (errors.length || !stopReason || !stopSummary || !metrics || !metricsValid) return { ok: false, errors };
  return {
    ok: true,
    graph: {
      version: 'deep-research-evidence-v1',
      purposes: purposes as ResearchEvidenceGraph['purposes'],
      nodes,
      edges,
      claims,
      timeline,
      openQuestions,
      metrics: {
        branchCount: metrics.branchCount as number,
        sourceCount: metrics.sourceCount as number,
        elapsedMinutes: metrics.elapsedMinutes as number,
      },
      stop: { reason: stopReason, summary: stopSummary },
    },
  };
}

export function researchEvidenceView(value: unknown): ResearchEvidenceView {
  if (value === undefined || value === null) return { kind: 'none' };
  const validation = validateResearchEvidenceGraph(value);
  return validation.ok
    ? { kind: 'ready', graph: validation.graph }
    : { kind: 'invalid', errors: validation.errors };
}
