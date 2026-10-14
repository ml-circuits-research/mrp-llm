/**
 * The closure of typed facts under typed rules, computed by the oracle (`closeFacts`), for the bounded controllers that search over
 * states (abduction, diagnosis, planning, simulation, reasoning/*.mjs). The result keeps the controllers' shapes: the input facts as
 * given, then the derived facts with `rule`, `from` and the intersection of the validities of their premises.
 *
 * Validity is not filtered: the controllers hand over facts that already hold at the instant they ask about (`partitions`), so one
 * closure of the whole list is the closure at that instant. The interval question of the runtime goes through `reason`.
 */
import {atomKey} from '../../lib/types.mjs';
import {stable} from '../../lib/util.mjs';
import {closeFacts} from '../strategies/js-reference/index.mjs';
import {Program, evaluate as evaluateOver} from './reason.mjs';

const factKey = f => stable([atomKey(f.atom), f.valid.from === -Infinity ? 'beginning' : f.valid.from, f.valid.until === Infinity ? 'open' : f.valid.until]);

/** `closure(facts, rules, {maxRounds, maxFacts, maxJoins, blockedHeads})`: `blockedHeads` are atom keys that are never derived. */
export function closure(input, rules, {maxRounds = 32, maxFacts = 10000, maxJoins = 30000, blockedHeads = new Set()} = {}) {
  const table = new Map();
  for (const f of input) { const k = factKey(f); if (!table.has(k)) table.set(k, f); }
  const base = [...table.values()];
  const prog = new Program(base, rules);
  const blocked = [...blockedHeads].map(k => { const a = JSON.parse(k); return {neg: a.neg, p: prog.lowering.predicate(a.p), args: a.a}; });
  const {ev, exhausted, budget} = closeFacts({wires: [...prog.factWires, ...prog.ruleWires], budget: {maxRounds, maxFacts, maxJoins}, blocked});
  const derived = [];
  for (const side of [ev.pos, ev.neg]) for (const t of side.values()) for (const n of t.list) if (n.kind !== 'fact') derived.push(prog.fact(n));
  return {facts: [...base, ...derived], complete: !exhausted, rounds: budget.used.maxRounds};
}

/** `evaluate(query, facts, {complete, maxJoins})` over already closed facts (derived facts are read as facts and keep their links). */
export function evaluate(q, facts, {complete = true, maxJoins = 30000} = {}) {
  return evaluateOver(q, facts, {complete, limits: {maxJoins}});
}
