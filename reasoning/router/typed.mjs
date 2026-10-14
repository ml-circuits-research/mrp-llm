/**
 * The routing report of `reasoning auto` on the typed path (the runtime's `reason` step over a `retrieval`). Every typed answer carries its
 * proof, its validity intervals and the question forms, which only the oracle produces (DS006 "Result projection"), so the router's
 * decision here is the oracle with the features and the reason; the wire engines serve the knowledge-wire path (`askMemory`,
 * reasoning/router/index.mjs), where the answer is the status and the rows.
 */
import {ORACLE} from './engines.mjs';

export function routeTyped(request) {
  const memory = request.memory ?? {}, mode = request.mode ?? 'deduce', q = request.query ?? {};
  const features = {mode, facts: memory.facts?.length ?? 0, rules: memory.rules?.length ?? 0, query_mode: q.mode ?? 'select', forms: ['compare', 'rank', 'filter', 'quantifier', 'order', 'measure', 'span'].filter(k => q[k] !== undefined && (!Array.isArray(q[k]) || q[k].length))};
  return {
    requested: 'auto', chosen: ORACLE, rule: 'proof_or_mode_of_work',
    reason: 'a typed answer carries its proof, its validity and the question forms, which only the oracle provides; the wire engines answer the knowledge-wire path',
    features,
    alternatives: [{id: 'sql-sqlite', eligible: false, why: 'answers rows without proof or validity'}, {id: 'datalog-souffle', eligible: false, why: 'answers rows without proof or validity'}, {id: 'asp-clingo', eligible: false, why: 'answers rows without proof or validity'}],
  };
}
