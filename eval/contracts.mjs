import assert from 'node:assert/strict';

/** Runtime packet statuses -> vision vocabulary. These are projections, not new inferences. */
export const STATUS_DECISIONS = Object.freeze({
  supported: 'ENTAILED', refuted: 'CONTRADICTED', both: 'CONFLICT', unknown: 'UNKNOWN',
  possible: 'POSSIBLE', entailed: 'ENTAILED', impossible: 'CONTRADICTED',
  hypotheses: 'PLAUSIBLE', approximate: 'PLAUSIBLE', budget_exhausted: 'UNKNOWN', not_expressible: 'UNSUPPORTED',
  clarify: 'AMBIGUOUS', unsupported: 'UNSUPPORTED', blocked: 'BLOCKED',
  inconsistent: 'CONFLICT', optimal: 'ENTAILED', feasible_bound: 'POSSIBLE',
  plan_found: 'POSSIBLE', no_plan: 'UNKNOWN',
  stored: 'STORED', context_updated: 'CONTEXT_UPDATED',
  unclear: 'UNCLEAR', not_computable: 'NOT_COMPUTABLE',
});

/** Preserve conflicts, conditionality and incomplete search independently of truth. */
export function epistemicResult(packet) {
  assert(packet && typeof packet.status === 'string', 'A result requires a runtime status');
  return {
    status: packet.status === 'both' || packet.status === 'inconsistent' || (packet.conflictedAnswers?.length ?? 0) > 0
      ? 'CONFLICT'
      : packet.hypothetical === true && ['supported', 'entailed'].includes(packet.status)
        ? 'PLAUSIBLE'
        : Object.hasOwn(STATUS_DECISIONS, packet.status) ? STATUS_DECISIONS[packet.status] : 'UNSUPPORTED',
    runtime_status: packet.status,
    complete: packet.complete ?? null,
    hypothetical: packet.hypothetical === true,
    guarantee: packet.guarantee ?? null,
  };
}

export function fraction(numerator, denominator) {
  return { numerator, denominator, value: denominator ? numerator / denominator : null };
}

export function distribution(values) {
  if (!values.length) return { count: 0, p50: null, p95: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = percentile => sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)];
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted.at(-1) };
}
