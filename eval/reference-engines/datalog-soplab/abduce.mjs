/**
 * All inclusion-minimal explanations of an observation, computed on soplab's closure.
 *
 * soplab's own `abduct()` (vendored, search/abduction.mjs) is a best-first search that RETURNS THE FIRST, cheapest explanation and stops: with
 * two equally cheap explanations (rain or sprinkler) it reports one of them. That is a finding of the smoke case `14a`, kept as a test
 * (tests/engines/strategy-datalog-soplab.test.mjs). The proposal's `mode abduce` asks for ALL inclusion-minimal explanations, so the strategy
 * enumerates them itself: subsets of the hypothesis wires by increasing size, a superset of an explanation already found is skipped, and
 * a subset holds when the query's `where` part is derivable from the facts plus the subset's atoms (closure by soplab, answer read by the oracle's reader).
 * More hypotheses than `maxHypotheses` is `budget_exhausted` (reason `hypotheses`), never a silently shortened search.
 */
import {atomText} from '../../../reasoning/strategies/js-reference/values.mjs';
import {BudgetStop} from '../../../reasoning/strategies/js-reference/budget.mjs';

function* subsetsOfSize(n, k, start = 0, chosen = []) {
  if (chosen.length === k) { yield chosen; return; }
  for (let i = start; i < n; i++) yield* subsetsOfSize(n, k, i + 1, [...chosen, i]);
}

/** `holdsWith(extraFacts)` runs soplab on the facts plus the extra ones and returns whether the observation holds. */
export function abduceAll({hypotheses, budget, limit = Infinity, holdsWith}) {
  if (hypotheses.length > budget.limits.maxHypotheses) return {status: 'budget_exhausted', complete: false, reason: 'hypotheses'};
  const found = [];
  try {
    for (let k = 0; k <= hypotheses.length; k++) {
      for (const subset of subsetsOfSize(hypotheses.length, k)) {
        budget.count('maxCandidates');
        if (found.some(f => f.every(i => subset.includes(i)))) continue;
        const extra = subset.flatMap(i => hypotheses[i].atoms.map(a => ({neg: a.neg, p: a.p, args: a.args})));
        if (holdsWith(extra)) found.push(subset);
      }
      if (k === 0 && found.length) break;
    }
  } catch (e) {
    if (e instanceof BudgetStop) return {status: 'budget_exhausted', complete: false, reason: e.reason};
    throw e;
  }
  const explanations = found.map(s => ({hypotheses: s.map(i => hypotheses[i].id), atoms: s.flatMap(i => hypotheses[i].atoms.map(a => atomText(a.neg, a.p, a.args))), cost: s.reduce((c, i) => c + hypotheses[i].cost, 0)}))
    .sort((a, b) => a.cost - b.cost || a.atoms.length - b.atoms.length || (a.atoms.join() < b.atoms.join() ? -1 : 1));
  if (!explanations.length) return {status: 'unknown', complete: true, reason: 'no_explanation', hypotheses: [], explanations: []};
  const shown = explanations.slice(0, limit);
  return {status: 'hypotheses', complete: shown.length === explanations.length, hypotheses: shown.map(e => e.atoms), explanations: shown, ...(shown.length < explanations.length ? {truncated: true} : {})};
}
