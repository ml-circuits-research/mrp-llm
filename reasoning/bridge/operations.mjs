/**
 * The shared half of the runtime's reasoning operations that search over hypotheses, actions and interventions (`abduce` and `diagnose`
 * in reasoning/abduction.mjs, `plan` and `simulate` in reasoning/worlds.mjs): the lowering of the typed objects of the runtime (facts,
 * rules, hypotheses, actions; lib/types.mjs and reasoning/lower.mjs shapes) to the knowledge wires the oracle reads
 * (reasoning/strategies/js-reference), and the one question to the oracle. Every operation answers in the oracle's packet (packet.mjs).
 */
import {ask, NotExpressibleError} from '../strategies/js-reference/index.mjs';
import {factWire, ruleWire} from './lower.mjs';
import {conditionAtoms} from '../../lib/conditions.mjs';

const field = (key, value) => ({key, value, line: 0, block: []});
export const FOREVER = {from: -Infinity, until: Infinity};

/** The lowered world of one question: the facts that hold at the instant asked as timeless wires, the rules, and the extra wires. */
export function lowerWorld(lowering, facts, rules, extra = []) {
  const taken = new Set([...rules.map(r => r.id), ...extra.map(w => w.id)]);
  let prefix = 'zf';
  while ([...taken].some(id => id.startsWith(prefix))) prefix += 'x';
  return [...facts.map((f, i) => factWire(lowering, prefix + i, {...f, valid: FOREVER}, 'observed')), ...rules.map(r => ruleWire(lowering, r)), ...extra];
}

export const hypothesisWire = (lowering, h) => ({id: h.id, type: 'hypothesis', line: 0, fields: [...h.assumptions.map(a => field('holds', lowering.atom(a))), field('cost', String(h.cost ?? 1))]});

export const actionWire = (lowering, a) => ({
  id: a.id, type: 'action', line: 0,
  fields: [field('params', a.params.map(v => lowering.variable(v)).join(' ')), ...a.requires.map(x => field('requires', lowering.atom(x))), ...a.adds.map(x => field('adds', lowering.atom(x))),
    ...a.removes.map(x => field('removes', lowering.atom(x))), field('cost', String(a.cost ?? 1))]
});

/** One question to the oracle over lowered wires; a circuit the oracle cannot express is the packet `not_expressible`, never a guess. */
export function askOracle(wires, query, budget) {
  try {
    return ask({handle: {kind: 'js-reference-handle', knowledge: '', wires}, queryWires: [query], conditional: false}, budget.limits);
  } catch (e) {
    if (e instanceof NotExpressibleError) return {status: 'not_expressible', complete: false, features: e.features, reason: e.message, budget: budget.snapshot(), used: [], notes: [], guarantee: 'exact', strategy: 'js-reference'};
    throw e;
  }
}

export const groundTarget = where => conditionAtoms(where).every(a => a.a.every(v => !(typeof v === 'string' && v.startsWith('?'))));
