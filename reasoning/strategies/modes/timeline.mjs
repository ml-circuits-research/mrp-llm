/**
 * The time of a trace (proposal 8.4, rule 1): a step carrying `at DATE` is judged against the wires in force at that date, a step
 * without it against the query's `asof` (default now). `timeline(ctx, steps)` gives, for a trace, the norms and methods that are in
 * force at ANY of its steps (parsed once), the test "is this wire in force at step i" (state 0 takes the time of step 1), and the day
 * number of each step when the whole trace is timestamped (the unit of `within N` then is a day).
 */
import {modesOf} from './theory.mjs';

const dayOf = at => Math.floor(Date.parse(at.length === 10 ? at + 'T00:00:00Z' : at) / 86400000);

export function timeline(ctx, steps) {
  const timeOf = i => steps[Math.max(i, 1) - 1]?.at ?? ctx.mq.asof ?? null;
  const sets = new Map();
  const idsAt = t => { const k = t ?? ''; if (!sets.has(k)) sets.set(k, new Set(ctx.force(t).map(w => w.id))); return sets.get(k); };
  const times = steps.length ? steps.map((_, k) => timeOf(k + 1)) : [ctx.mq.asof ?? null];
  const union = new Set();
  for (const t of times) for (const id of idsAt(t)) union.add(id);
  const unionWires = ctx.wires.filter(w => union.has(w.id));
  const {norms, methods, edges} = modesOf(unionWires, ctx.policy, ctx.flags);
  const timed = steps.length > 0 && steps.every(s => s.at);
  return {
    timeOf, idsAt, unionWires, norms, methods, edges,
    inForceAt: (x, i) => idsAt(timeOf(i)).has(x.id),
    idInForceAt: (id, i) => idsAt(timeOf(i)).has(id),
    days: timed ? [dayOf(steps[0].at), ...steps.map(s => dayOf(s.at))] : null
  };
}
