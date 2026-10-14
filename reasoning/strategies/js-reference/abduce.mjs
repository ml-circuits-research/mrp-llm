/**
 * Abduction: ALL inclusion-minimal explanations of an observation (not only the cheapest).
 *
 * A candidate is a `hypothesis` wire (its `holds`/`assume` atoms). An explanation is a set of candidates whose atoms, added to the
 * facts, make the observation (the query's `where`) hold. Subsets are tried by increasing size; a superset of an explanation already
 * found is skipped, so every returned set is minimal under inclusion. Explanations are hypotheses, never facts. More than
 * `maxHypotheses` candidates is `budget_exhausted` (reason `hypotheses`), never a silently shortened search.
 *
 * Consistency is part of the definition: a set whose closure holds an atom and its negation that the closure of the admitted facts
 * alone does not hold contradicts what is admitted (it predicts `tool_marks` against the fact `not tool_marks`). Such a set is not an
 * explanation; it is reported under `inconsistent` with the literals it contradicts (only the minimal such sets are listed), and a
 * search whose explaining sets are all inconsistent is `unknown` with reason `no_consistent_explanation`.
 *
 * Over the query's own candidates (Q-LANG-10, `candidate $id` with mode abduce) the candidates are supposed facts and rules or defaults
 * instead of `hypothesis` wires: `candidates` lists them ({id, kind, atoms, cost 1}) and `closeWith(ids)` returns the closure with exactly
 * those candidates in force. The answer adds `necessary`: the candidates present in every explanation (what the argument assumes).
 */
import {saturate} from './engine.mjs';
import {evaluatePart, readBudget} from './query.mjs';
import {atomText, argsKey} from './values.mjs';
import {BudgetStop} from './budget.mjs';

function* subsetsOfSize(n, k, start = 0, chosen = []) {
  if (chosen.length === k) { yield chosen; return; }
  for (let i = start; i < n; i++) yield* subsetsOfSize(n, k, i + 1, [...chosen, i]);
}

/** The ground atoms that hold with both polarities in a closure, keyed `p|args`, each with the negative literal's text. */
export function contradictions(ev) {
  const out = new Map();
  for (const [p, table] of ev.neg) for (const node of table.list) if (ev.get(false, p, node.args)) out.set(p + '|' + argsKey(node.args), {p, args: node.args});
  return out;
}

export function abduce({program, facts, qp, budget, limit = Infinity, candidates = null, closeWith = null}) {
  const cands = candidates ?? program.hypotheses;
  if (cands.length > budget.limits.maxHypotheses) return {status: 'budget_exhausted', complete: false, reason: 'hypotheses'};
  const ctx = (ev, notes) => ({ev, stored: new Map(), budget: readBudget(budget), notes});
  const close = closeWith ? subset => closeWith(subset.map(i => cands[i].id)) : subset => {
    const extra = subset.flatMap(i => cands[i].atoms.map(a => ({neg: a.neg, p: a.p, args: a.args, claim: {id: cands[i].id, version: 1}, status: 'supposed', speaker: null, valid: null})));
    const closure = saturate(program, [...facts, ...extra], budget.child());
    if (closure.exhausted) throw new BudgetStop(closure.exhausted.key);
    return closure.ev;
  };
  const found = [], inconsistent = [];
  try {
    // The contradictions the admitted facts already hold are not the hypotheses' doing (they are reported by `both` elsewhere).
    const baseEv = close([]), base = contradictions(baseEv);
    const test = subset => {
      const ev = close(subset);
      const out = evaluatePart(qp, ev, ctx(ev, new Set()));
      if (!(out.rows.length > 0 && ['supported', 'both'].includes(out.status))) return {explains: false};
      const fresh = [...contradictions(ev)].filter(([key]) => !base.has(key)).map(([, a]) => a);
      // The admitted side of each contradiction is the literal the facts alone derive; when neither side is admitted, the positive atom is named.
      const contradicts = fresh.map(a => baseEv.get(true, a.p, a.args) ? atomText(true, a.p, a.args) : atomText(false, a.p, a.args));
      return {explains: true, contradicts};
    };
    for (let k = 0; k <= cands.length; k++) {
      for (const subset of subsetsOfSize(cands.length, k)) {
        budget.count('maxCandidates');
        if (found.some(f => f.every(i => subset.includes(i)))) continue;
        const r = test(subset);
        if (!r.explains) continue;
        if (!r.contradicts.length) found.push(subset);
        else if (!inconsistent.some(x => x.subset.every(i => subset.includes(i)))) inconsistent.push({subset, contradicts: r.contradicts});
      }
      if (k === 0 && found.length) break; // already true without any hypothesis
    }
  } catch (e) {
    if (e instanceof BudgetStop) return {status: 'budget_exhausted', complete: false, reason: e.reason};
    throw e;
  }
  const describe = s => ({hypotheses: s.map(i => cands[i].id), atoms: s.flatMap(i => cands[i].atoms.map(a => atomText(a.neg, a.p, a.args))), cost: s.reduce((c, i) => c + cands[i].cost, 0)});
  const text = e => e.atoms.join() + '|' + e.hypotheses.join();
  const order = (a, b) => a.cost - b.cost || a.atoms.length - b.atoms.length || a.hypotheses.length - b.hypotheses.length || (text(a) < text(b) ? -1 : text(a) > text(b) ? 1 : 0);
  const explanations = found.map(describe).sort(order);
  const rejected = inconsistent.map(x => ({...describe(x.subset), contradicts: x.contradicts})).sort(order);
  const reported = rejected.length ? {inconsistent: rejected} : {};
  // over candidates: the candidates every explanation needs (computed over all explanations, not only the shown ones)
  const necessary = candidates ? {necessary: explanations.length ? explanations[0].hypotheses.filter(id => explanations.every(e => e.hypotheses.includes(id))) : []} : {};
  if (!explanations.length) return {status: 'unknown', complete: true, reason: rejected.length ? 'no_consistent_explanation' : 'no_explanation', hypotheses: [], explanations: [], ...reported, ...necessary};
  const shown = explanations.slice(0, limit);
  return {status: 'hypotheses', complete: shown.length === explanations.length, hypotheses: shown.map(e => e.atoms), explanations: shown, ...reported, ...necessary, ...(shown.length < explanations.length ? {truncated: true} : {})};
}
