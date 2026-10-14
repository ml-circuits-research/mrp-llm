/**
 * The result of one formalization path of ChatSOPAdapter (the same shape for every path):
 *   {path, status, answers: [{kind, value}], values, circuits: [sop], packets, proofs, ms, tier, calls, cached, detail}
 * `status`: ok (the path ran and answered), no_answer (it ran, nothing was answered), rejected (the model's formalization was refused
 * by its admission or static analysis), unavailable (the tier did not answer), no_numbers (a compute path without registry numbers),
 * error. `values` are the answered values, flat (a list answer gives its items), never null; an empty list answer ("nothing is")
 * makes the path answered with no values.
 */
export function pathResult(path, fields = {}) {
  const answers = fields.answers ?? [];
  const values = answers.flatMap(a => (Array.isArray(a.value) ? a.value.flat(Infinity) : [a.value])).filter(v => v !== null && v !== undefined);
  // An empty list (`which` answered "nothing is") is an answer; a null is not.
  const answered = answers.some(a => a.value !== null && a.value !== undefined);
  const status = fields.status === 'ok' && !answered ? 'no_answer' : fields.status ?? 'error';
  return {path, status, answers, values, circuits: fields.circuits ?? [], packets: fields.packets ?? [], proofs: (fields.packets ?? []).map(p => p?.proof ?? null).filter(Boolean),
    ms: fields.ms ?? 0, tier: fields.tier ?? null, calls: fields.calls ?? 0, cached: fields.cached ?? null, detail: fields.detail ?? {}};
}

/** The serializable part of a path result (no packets). */
export const pathSummary = r => (r ? {path: r.path, status: r.status, values: r.values, answers: r.answers, circuits: r.circuits, proofs: r.proofs, ms: r.ms, tier: r.tier, calls: r.calls, cached: r.cached, detail: r.detail} : null);
