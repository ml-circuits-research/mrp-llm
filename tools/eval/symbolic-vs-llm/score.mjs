import {compare} from '../../../eval/smoke-reasoning/lib/compare.mjs';

const NON_ANSWERS = new Set(['unknown', 'incomplete', 'clarify', 'unclear', 'not_computable', 'not_expressible', 'budget_exhausted', 'parse_unavailable', 'unsupported']);
const FAILED = new Set(['error', 'failed', 'parse_failed', 'parser_failed']);
const ANSWER_FIELDS = ['status', 'complete', 'rows', 'count', 'bound', 'reason', 'witness', 'objective', 'conditional', 'nonmonotone'];

/** Compare entire tuples as sets, preserving conflict, open-domain bounds and epistemic status. */
export function score(expected, packet, {author = null, error = null} = {}) {
  if (author?.status === 'invalid') return {outcome: 'invalid', why: ['validator rejected circuit']};
  if (error || author?.status === 'failed' || !packet || FAILED.has(packet.status)) return {outcome: 'failed', why: [error ?? author?.reason ?? packet?.reason ?? 'no packet']};
  const semantic = Object.fromEntries(ANSWER_FIELDS.filter(k => expected[k] !== undefined).map(k => [k, expected[k]]));
  const result = compare(semantic, packet);
  if (packet.complete === false && expected.complete !== false) return {outcome: 'unknown', why: result.why.length ? result.why : ['incomplete result cannot establish the complete answer']};
  if (result.ok) return {outcome: 'correct', why: []};
  if (author?.unclear || NON_ANSWERS.has(packet.status)) return {outcome: 'unknown', why: result.why};
  return {outcome: 'wrong', why: result.why};
}

export function equivalent(a, b) {
  const expected = Object.fromEntries(ANSWER_FIELDS.filter(k => a[k] !== undefined).map(k => [k, a[k]]));
  return compare(expected, b).ok && compare(Object.fromEntries(ANSWER_FIELDS.filter(k => b[k] !== undefined).map(k => [k, b[k]])), a).ok;
}

/** First failing pipeline layer; direct answer errors never pass through the symbolic engine. */
export function failureLayer({outcome, arm, author, linking, packet, oracleEquivalent, rendered, error, parseOk}) {
  if (outcome === 'correct') return null;
  if (['A', "A'", 'D'].includes(arm)) {
    if (error) return 'transport';
    if (parseOk === false || packet?.reason === 'malformed_output' || rendered === null || rendered === '') return 'rendering';
    return 'reasoning';
  }
  const problems = [...(author?.validation?.problems ?? []), ...(author?.unlinked ?? [])];
  if (problems.some(p => ['unknown_predicate', 'entity_id_not_listed'].includes(p.code)) || linking?.plan?.issues?.length || linking?.issue) return 'linking';
  if (author && (author.status !== 'validated' || author.unclear || oracleEquivalent === false)) return 'authoring';
  // An unbound authored projection is an invalid circuit, not a solver discrepancy.
  if (author && error?.startsWith('select_unbound:')) return 'authoring';
  if (packet?.retrieval?.complete === false || packet?.status === 'incomplete' || packet?.reason === 'partial_retrieval') return 'retrieval';
  if (packet?.status === 'budget_exhausted' || packet?.reason === 'discrepancy' || packet?.route?.verification?.outcome === 'discrepancy') return 'engine';
  if (rendered === null || packet?.reason === 'malformed_output' || error?.startsWith('rendering:')) return 'rendering';
  return 'engine';
}

export function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = k / n, d = 1 + z * z / n, center = p + z * z / (2 * n);
  const margin = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(center - margin) / d, (center + margin) / d];
}
