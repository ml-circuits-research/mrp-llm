/**
 * `abduce` and `diagnose` over the oracle (reasoning/bridge/operations.mjs lowers the typed facts, rules and hypotheses to knowledge wires
 * and asks the oracle's `abduce`). The packet is the oracle's (reasoning/bridge/packet.mjs). Host work before the question: the observed
 * target is removed from the premises ("true because observed" is never an explanation), a candidate that repeats the target or
 * contradicts an observed fact is rejected and reported, and missing-condition candidates are generated from the retrieved rules
 * (abducibles.mjs) when none are supplied. Nothing is asserted.
 */
import {Lowering, queryWire } from './bridge/lower.mjs';
import {lowerWorld, hypothesisWire, askOracle, groundTarget} from './bridge/operations.mjs';
import {operationBudget} from './bridge/packet.mjs';
import {generateAbducibles} from './abducibles.mjs';
import {atomKey} from '../lib/types.mjs';
import {conditionAtoms} from '../lib/conditions.mjs';
import {flat,asFact,opposite,partitions} from './common.mjs';

/**
 * `abduce`: every inclusion-minimal set of candidate hypotheses that, added to the facts, makes the observation hold. The packet is the
 * oracle's: `status hypotheses|unknown|budget_exhausted`, `hypotheses` (atom texts of each explanation), `explanations`
 * (`{hypotheses: ids, atoms, cost}`, cheapest first), plus `candidates` (how many were tried), `rejected` and `generator`.
 */
export function abduce({query, data, memory, candidates = [], schema, ...options}) {
  const budget = operationBudget(options), k = partitions(data, memory, query);
  if (!query || !groundTarget(query.where)) throw Error('Abduction requires a ground observed target');
  let given = flat(candidates).length ? flat(candidates) : k.hypotheses;
  if (given.some(h => h.kind !== 'hypothesis')) throw Error('Abducibles must be hypothesis declarations');
  const targets = new Set(conditionAtoms(query.where).map(atomKey)), base = k.facts.filter(f => !targets.has(atomKey(f.atom))), baseKeys = new Set(base.map(f => atomKey(f.atom)));
  let generated = null;
  if (!given.length) { generated = generateAbducibles(query, base, k.rules, budget.child(), schema); given = generated.candidates; }
  const rejected = [], usable = [];
  for (const h of given) {
    const reason = h.status === 'rejected' ? 'status_rejected' : h.assumptions.some(a => targets.has(atomKey(a))) ? 'repeats_the_observation' : h.assumptions.some(a => baseKeys.has(atomKey(opposite(a)))) ? 'contradicts_an_observed_fact' : null;
    (reason ? rejected : usable).push(reason ? {id: h.id, reason} : h);
  }
  const lowering = new Lowering();
  const wires = lowerWorld(lowering, base, k.rules, usable.map(h => hypothesisWire(lowering, h)));
  const out = askOracle(wires, queryWire(lowering, {where: query.where, mode: 'abduce'}), budget);
  const complete = out.complete !== false && k.complete && generated?.complete !== false;
  return {...out, complete, candidate_count: usable.length, rejected, ...(generated ? {generator: {...generated, candidates: undefined}} : {}),
    ignored: [...(out.ignored ?? []), ...k.patterns.map(p => ({id: p.id, kind: 'pattern', reason: 'not-admitted-as-deductive-evidence'}))]};
}

/**
 * `diagnose`: the explanations of `abduce` plus, for each supplied ground test, how many pairs of explanations it separates (the
 * oracle answers the test under each explanation). `tests` is ordered by that count, `next_test` is the first that separates any pair;
 * a test is never executed.
 */
export function diagnose(args) {
  const result = abduce(args), budget = operationBudget(args), k = partitions(args.data, args.memory, args.query);
  const targets = new Set(conditionAtoms(args.query.where).map(atomKey)), base = k.facts.filter(f => !targets.has(atomKey(f.atom)));
  const explanations = result.explanations ?? [], byId = new Map(flat(args.candidates).concat(k.hypotheses).map(h => [h.id, h]));
  let complete = result.complete;
  const ranked = [];
  for (const test of flat(args.tests)) {
    if (test.kind !== 'query' || !groundTarget(test.where)) throw Error('Diagnostic tests must be ground queries');
    const predictions = [];
    for (const e of explanations) {
      const atoms = e.hypotheses.flatMap(id => byId.get(id)?.assumptions ?? []);
      const lowering = new Lowering();
      const out = askOracle(lowerWorld(lowering, [...base, ...atoms.map((a, i) => asFact(a, 'h_' + i))], k.rules), queryWire(lowering, {where: test.where, mode: 'exists'}), budget);
      complete &&= out.complete !== false;
      predictions.push({explanation: e.hypotheses.join('+'), status: out.status});
    }
    let separated = 0;
    for (let i = 0; i < predictions.length; i++) for (let j = i + 1; j < predictions.length; j++) if (predictions[i].status !== predictions[j].status) separated++;
    ranked.push({query: test, separated_pairs: separated, predictions});
  }
  ranked.sort((a, b) => b.separated_pairs - a.separated_pairs);
  return {...result, complete, tests: ranked, next_test: ranked.find(t => t.separated_pairs > 0) ?? null, executed_tests: false,
    notes: [...(result.notes ?? []), 'test ranking is a pair-separation count, not expected information gain; no test is executed']};
}

