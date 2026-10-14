// VENDORED: copied verbatim from soplab-v0.4.0.zip src/engine/materialize.mjs
import { bindingSignature, isGroundAtom, substituteAtom, substituteTerm } from '../model.mjs';
import { solveBody } from './evaluator.mjs';
import { stratifyRules } from '../stratify.mjs';

function proofFor(rule, sol) {
  return {
    kind: 'rule',
    ruleId: rule.id,
    premises: sol.evidence,
    bindings: Object.fromEntries(Object.entries(sol.bindings).map(([k, v]) => [k, substituteTerm(v, sol.bindings)])),
  };
}

function fireRule(reasoner, rule, context, seenFirings, newKeys, { maxFacts }) {
  let added = 0;
  for (const sol of solveBody(reasoner, rule.body, {}, [], context)) {
    const sig = `${rule.id}|${bindingSignature(sol.bindings)}`;
    if (seenFirings?.has(sig)) continue;
    seenFirings?.add(sig);
    context.metrics?.inc('ruleFirings');
    const head = substituteAtom(rule.head, sol.bindings);
    if (!isGroundAtom(head)) { context.metrics?.inc('nongroundHeadsSkipped'); continue; }
    const { isNew, record } = reasoner.store.add(head, proofFor(rule, sol));
    if (isNew) {
      added++;
      newKeys?.add(record.key);
      context.metrics?.inc('factsDerived');
      if (reasoner.store.size() > maxFacts) throw new Error(`Fact limit exceeded: ${maxFacts}`);
    }
  }
  return added;
}

function deltaEligible(expr, atoms = []) {
  if (Array.isArray(expr)) return expr.every((x) => deltaEligible(x, atoms));
  if (!expr) return true;
  if (expr.pred) { atoms.push(expr); return true; }
  if (expr.builtin) return true;
  if (expr.op === 'all') return expr.items.every((x) => deltaEligible(x, atoms));
  return false;
}

export function materializeNaive(reasoner, {
  rules = reasoner.rules,
  maxRounds = 1000,
  maxFacts = 1_000_000,
  metrics = reasoner.metrics,
} = {}) {
  let rounds = 0;
  let addedTotal = 0;
  const seenFirings = new Set();
  while (rounds < maxRounds) {
    rounds++;
    metrics?.inc('rounds');
    let addedThisRound = 0;
    for (const r of rules) addedThisRound += fireRule(reasoner, r, { metrics }, seenFirings, null, { maxFacts });
    addedTotal += addedThisRound;
    if (!addedThisRound) return { strategy: 'naive', rounds, added: addedTotal, facts: reasoner.store.size(), converged: true };
  }
  return { strategy: 'naive', rounds, added: addedTotal, facts: reasoner.store.size(), converged: false };
}

export function materializeDelta(reasoner, {
  rules = reasoner.rules,
  maxRounds = 1000,
  maxFacts = 1_000_000,
  metrics = reasoner.metrics,
} = {}) {
  let rounds = 0;
  let addedTotal = 0;
  let deltaKeys = new Set(reasoner.store.values().map((r) => r.key));
  const fallbackSeen = new Set();

  while (rounds < maxRounds) {
    rounds++;
    metrics?.inc('rounds');
    metrics?.set('lastDeltaSize', deltaKeys.size);
    const newKeys = new Set();
    let addedThisRound = 0;

    for (const r of rules) {
      const atoms = [];
      if (deltaEligible(r.body, atoms) && atoms.length) {
        const seenThisRuleRound = new Set();
        for (const deltaNode of atoms) {
          addedThisRound += fireRule(
            reasoner, r,
            { metrics, deltaNode, deltaKeys },
            seenThisRuleRound, newKeys, { maxFacts },
          );
        }
      } else {
        addedThisRound += fireRule(reasoner, r, { metrics }, fallbackSeen, newKeys, { maxFacts });
      }
    }

    addedTotal += addedThisRound;
    if (!newKeys.size) return { strategy: 'delta', rounds, added: addedTotal, facts: reasoner.store.size(), converged: true };
    deltaKeys = newKeys;
  }
  return { strategy: 'delta', rounds, added: addedTotal, facts: reasoner.store.size(), converged: false };
}

export function materialize(reasoner, options = {}) {
  const strategy = options.strategy ?? 'delta';
  const rules = options.rules ?? reasoner.rules;
  const stratified = options.stratified !== false;
  const run = reasoner.materializers?.get(strategy) ?? (strategy === 'naive' ? materializeNaive : strategy === 'delta' ? materializeDelta : null);
  if (!run) throw new Error(`Unknown materialization strategy: ${strategy}`);
  if (!stratified || !rules.length) return run(reasoner, { ...options, rules });

  const plan = stratifyRules(reasoner, rules);
  let totalRounds = 0, totalAdded = 0, converged = true;
  const strata = [];
  for (const group of plan.groups) {
    const res = run(reasoner, { ...options, rules: group.rules });
    totalRounds += res.rounds;
    totalAdded += res.added;
    converged &&= res.converged;
    strata.push({ stratum: group.stratum, rules: group.rules.map((r) => r.id), result: res });
  }
  return { strategy, stratified: true, rounds: totalRounds, added: totalAdded, facts: reasoner.store.size(), converged, strata };
}
