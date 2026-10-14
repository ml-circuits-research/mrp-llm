/**
 * `plan` and `simulate` over the oracle. `plan` lowers the typed facts, rules, actions and goal to knowledge wires and asks the oracle's
 * uniform-cost search over polarity-explicit states (reasoning/bridge/operations.mjs); `simulate` closes and reads the intervened world
 * with the oracle's closure. The packet is the oracle's (reasoning/bridge/packet.mjs). No hypothetical branch writes to the repository.
 */
import {closure, evaluate} from './bridge/closure.mjs';
import {Lowering, queryWire} from './bridge/lower.mjs';
import {lowerWorld, actionWire, askOracle, FOREVER} from './bridge/operations.mjs';
import {operationBudget, operationPacket, stoppedPacket, atomOf, usedOfTyped, BudgetStop} from './bridge/packet.mjs';
import {atomKey} from '../lib/types.mjs';
import {contains} from '../lib/time.mjs';
import {unify} from '../lib/unify.mjs';
import {flat,asFact,opposite,ground,partitions,queryFor,conflicts} from './common.mjs';

/** `plan`: the cheapest plan to the goal over polarity-explicit states (the oracle's `plan_found`, `no_plan` or `budget_exhausted` with reason horizon or nodes). */
export function plan({data, memory, actions = [], goal, ...options}) {
  if (!goal || goal.kind !== 'goal') throw Error('plan needs a goal declaration');
  const budget = operationBudget(options), at = options.now ?? Date.now(), q = queryFor(goal.where, {at}), k = partitions(data, memory, q);
  const given = flat(actions).length ? flat(actions) : k.actions;
  if (given.some(a => a.kind !== 'action')) throw Error('plan actions must be action declarations');
  const inForce = given.filter(a => contains(a.valid ?? FOREVER, at));
  const lowering = new Lowering();
  const wires = lowerWorld(lowering, k.facts, k.rules, inForce.map(a => actionWire(lowering, a)));
  const out = askOracle(wires, queryWire(lowering, {where: goal.where, mode: 'plan'}), budget);
  const left = given.filter(a => !inForce.includes(a)).map(a => ({id: a.id, kind: 'action', reason: 'not-valid-at-the-instant-asked'}));
  return {...out, complete: out.complete !== false && k.complete, ignored: [...(out.ignored ?? []), ...left]};
}

/**
 * `simulate`: the question asked in a world where the intervention holds. `whatif` replaces the intervened facts and re-derives;
 * `counterfactual` also cuts every rule that concludes an intervened atom and recomputes the downstream facts from the exogenous ones
 * (a deterministic causal Horn model: only all-`causal` rule sets are accepted). The answer is the relational packet of the question
 * over the world (answers, proof) with the native fields, and `whatif` names the mode, the intervention and the factual status.
 */
export function simulate({query, data, memory, intervention, mode = 'whatif', ...options}) {
  if (!['whatif', 'counterfactual'].includes(mode)) throw Error('simulate mode must be whatif or counterfactual');
  const budget = operationBudget(options), k = partitions(data, memory, query);
  const assumptions = flat(intervention).flatMap(h => {
    if (h.kind === 'hypothesis') return h.assumptions;
    if (h.kind === 'fact') return [h.atom];
    throw Error('Intervention requires hypothesis/fact declarations');
  });
  if (!assumptions.every(ground)) throw Error('Ground interventions required');
  const whatif = extra => ({mode, intervention: assumptions.map(atomOf), ...extra});
  if (mode === 'counterfactual' && k.rules.some(r => r.mode !== 'causal')) {
    return operationPacket(budget, {status: 'not_expressible', complete: false, reason: 'causal_model_required', features: ['causal_model'], hypothetical: true, whatif: whatif(),
      notes: ['counterfactual mode needs an explicit all-causal rule module; ordinary correlations are never reinterpreted as causes']});
  }
  if (conflicts(assumptions.map((a, i) => asFact(a, 'i' + i))).length) {
    return operationPacket(budget, {status: 'inconsistent', complete: true, hypothetical: true, whatif: whatif(), notes: ['the intervention assigns both polarities']});
  }
  try {
    budget.node();
    const original = closure(k.facts, k.rules, budget.limits);
    const factual = evaluate(query, original.facts, {complete: k.complete && original.complete, maxJoins: budget.limits.maxJoins});
    // Recompute endogenous values from exogenous inputs: a deterministic causal Horn model, not a stochastic structural causal model.
    const state = intervened(counterfactualBase(k, mode), assumptions);
    const blockedHeads = mode === 'counterfactual' ? new Set(assumptions.flatMap(a => [atomKey(a), atomKey(opposite(a))])) : new Set();
    const cl = closure(state, k.rules, {...budget.limits, blockedHeads});
    const result = evaluate(query, cl.facts, {complete: k.complete && cl.complete, maxJoins: budget.limits.maxJoins});
    return operationPacket(budget, {...result, complete: result.complete, hypothetical: true, used: usedOfTyped(result.proof), whatif: whatif({factual_status: factual.status, source_memory_modified: false}),
      notes: [mode === 'counterfactual' ? 'deterministic causal Horn intervention' : 'fact replacement and re-derivation']});
  } catch (e) {
    if (e instanceof BudgetStop) return stoppedPacket(budget, e, {hypothetical: true, whatif: whatif()});
    throw e;
  }
}

/** The facts an intervention is applied to: all of them, or (counterfactual) only the exogenous ones, those no rule concludes. */
function counterfactualBase(k, mode) {
  if (mode !== 'counterfactual') return k.facts;
  return k.facts.filter(f => !k.rules.some(r => unify(r.then, f.atom) || unify({...r.then, neg: !r.then.neg}, f.atom)));
}

/** The facts with the intervened atoms set (and their opposites removed). */
function intervened(facts, adds) {
  const removed = new Set(adds.flatMap(a => [atomKey(a), atomKey(opposite(a))]));
  const table = new Map(facts.filter(f => !removed.has(atomKey(f.atom))).map(f => [atomKey(f.atom), f]));
  for (const [i, a] of adds.entries()) table.set(atomKey(a), asFact(a, 'state_' + i + '_' + atomKey(a), 'assumed'));
  return [...table.values()];
}

