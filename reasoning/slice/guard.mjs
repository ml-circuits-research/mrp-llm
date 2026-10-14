/**
 * The completeness guard (DS005 "Closedness and completeness for the knowledge wires", proposal section 11.6, rules R-P1 to R-P4).
 *
 * A partial slice makes a missing fact look false. Given the answer the reasoner produced over a slice and the slice's own report, the
 * guard decides whether the answer may be given:
 *
 *   R-P1  a positive answer found by evidence (a proof, a counterexample, an opposing fact) stays valid when more facts are retrieved, so it
 *         is accepted over a partial slice and says `complete: false`. A select over a partial slice is a subset of the rows, so it is
 *         widened first and, if the slice cannot be completed, returned as a partial answer.
 *   R-P2  a count, a universal question that no counterexample decided, a ranking, and an `unknown` obtained by failure are valid only over
 *         a complete slice. They are never accepted over a partial one: the retrieval widens, and when it cannot, the answer is
 *         `incomplete` with `reason: partial_retrieval` (a count keeps its lower bound as `at_least`).
 *   R-P3  a slice that rests on an associative candidate list is complete but never settled (`exact: false`): a select or an exists is
 *         answered as before, a count or a universal answer is withheld (`inexact_view`).
 *   R-P4  closedness is declared, never inferred. With `policy.closedWorld = "declared"` a count over a predicate that is not declared
 *         `closed` is a lower bound (`bound: at_least`) and a universal question over such a domain that finds no counterexample is
 *         `unknown` (`reason: open_domain`). With the default, `"view"`, the complete retained view is the world of the question.
 *
 * Typed queries can now carry query-only closed-predicate absence. A successful
 * absence claim is nonmonotone and needs a settled exact slice like a count.
 * Defaults and knowledge-wire absence remain judged by the oracle's `sensitivity` (`wire.mjs`).
 */

const PARTIAL = 'partial_retrieval';

/** The quantifiers whose decided outcome is monotone: more facts can only confirm a counterexample or a witness count. */
const MONOTONE_EVERY = {all: 'refuted', none: 'refuted', not_all: 'supported', at_least: 'supported'};

export function modeOf(query) { return query?.mode ?? 'select'; }

const atomsOf = conditions => {
  const out = [];
  const visit = c => { if (c.kind === 'all' || c.kind === 'any') c.children.forEach(visit); else out.push(c); };
  (conditions ?? []).forEach(visit);
  return out;
};

/** Which answers over a partial slice would be wrong, judged on the question alone. */
export function sensitivityOf(query) {
  const mode = modeOf(query);
  const quantifier = query?.quantifier?.word ?? 'all';
  const ranked = Boolean(query?.rank);
  const atoms = atomsOf([...(query?.where ?? []), ...(query?.scope ?? [])]);
  const absent = atoms.some(a => a.neg === 'absent');
  return {
    mode,
    monotone: !['count', 'every'].includes(mode) && !ranked && !absent,
    absent,
    over: [...new Set(atoms.map(a => a.p))],
    quantifier,
    ranked,
  };
}

const closedOver = (query, closed) => {
  const preds = [...new Set(atomsOf(query?.where).map(a => a.p))];
  return preds.length > 0 && preds.every(p => closed?.(p) === true);
};

/** The closed-world rule under `policy.closedWorld = "declared"`, applied to an answer over a COMPLETE slice. */
function declared(query, output, closed) {
  const mode = modeOf(query);
  if (mode === 'count' && output.status === 'supported' && !closedOver(query, closed)) return {...output, bound: 'at_least'};
  if (mode === 'every' && output.status === 'supported' && !closedOver(query, closed)) return {...output, status: 'unknown', reason: 'open_domain'};
  return output;
}

/** The answer given when a slice cannot be completed and the answer would be wrong or unproven if given as it is. A withheld answer proves nothing, so it carries no proof (nothing is reinforced on its account). */
function withheld(query, output, slice, sensitivity) {
  const mode = modeOf(query);
  const base = {reason: PARTIAL, complete: false, retrieval_reasons: slice.complete ? ['inexact_view'] : slice.reasons};
  if (sensitivity.absent) {
    const {count, at_least, bound, ...rest} = output;
    return {...rest, ...base, status: 'incomplete', answers: [], proof: []};
  }
  if (mode === 'count') {
    const {count, ...rest} = output;
    return {...rest, ...base, status: 'incomplete', answers: [], proof: [], at_least: count ?? 0, bound: 'at_least'};
  }
  if (mode === 'every') return {...output, ...base, status: 'incomplete', answers: [], proof: []};
  // a ranking names the best of ALL candidates: the best of a part proves nothing, so it is withheld (the candidates stay visible as `partial_answers`)
  if (query?.rank) return {...output, ...base, status: 'incomplete', answers: [], proof: [], partial_answers: output.answers ?? []};
  return {...output, ...base};
}

/**
 * @returns {{accept: boolean, output: object, rule: string}} `accept: false` asks the caller to widen the retrieval; `output` is the
 * answer to give if it cannot (`withheld`), or the answer itself when accepted.
 */
export function judge({query, output, slice, closedWorld = 'view', closed = null}) {
  const sensitivity = sensitivityOf(query);
  const evidence = ['supported', 'both', 'refuted', 'mixed_temporal'].includes(output.status);
  const unguarded = !['supported', 'both', 'refuted', 'mixed_temporal', 'unknown'].includes(output.status);
  const settled = slice.settled ?? (slice.complete && slice.exact !== false);
  if (settled) {
    return {accept: true, output: closedWorld === 'declared' ? declared(query, output, closed) : output, rule: 'complete_slice'};
  }
  const fallback = withheld(query, output, slice, sensitivity);
  const {mode, quantifier} = sensitivity;
  const decidedEvery = mode === 'every' && evidence && MONOTONE_EVERY[quantifier] === output.status;
  const closedWorldAnswer = mode === 'count' || (mode === 'every' && !decidedEvery) || sensitivity.ranked || sensitivity.absent;
  if (closedWorldAnswer) return {accept: false, output: fallback, rule: 'R-P2'};
  if (slice.complete) return {accept: true, output, rule: 'complete_inexact_view'};
  if (unguarded) return {accept: true, output: {...output, complete: false}, rule: 'not_a_closed_world_answer'};
  if (decidedEvery) return {accept: true, output: {...output, complete: false}, rule: 'R-P1 monotone'};
  if (mode === 'select' || output.status === 'unknown') return {accept: false, output: fallback, rule: mode === 'select' ? 'R-P1 subset' : 'R-P2'};
  return {accept: true, output: {...output, complete: false}, rule: 'R-P1 monotone'};
}
