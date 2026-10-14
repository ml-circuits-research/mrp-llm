/**
 * The widening loop: ask the reasoner over the slice, let the guard judge the answer, and widen the retrieval until the answer is
 * accepted or nothing more can be retrieved (proposal section 11.5). The host, not a strategy, widens, so every strategy gets the same
 * guard. Every answer carries the `retrieval` report of the slice it rests on (R-P5).
 */
import {judge} from './guard.mjs';

export const MAX_WIDENING_STEPS = 10;

/** The packet field R-P5 asks for, plus what the slice was and why it is or is not complete. */
export function retrievalReport(memory, trail, verdict) {
  const slice = memory.slice;
  return {
    complete: slice.complete,
    truncated: slice.truncated,
    keyed: slice.keyed,
    steps: trail.length,
    wires: slice.facts + slice.rules,
    probes: slice.probes,
    facts: slice.facts,
    rules: slice.rules,
    predicates: slice.predicates,
    class: slice.class,
    bound: slice.bound,
    exact: slice.exact,
    lookups: slice.lookups,
    scans: slice.scans,
    reasons: slice.reasons,
    guard: verdict.rule,
    trail,
  };
}

/**
 * @param memory   a retrieval result with a `slice` report (and, when it can be widened, a non-enumerable `widen()` returning the next one)
 * @param query    the typed question
 * @param solve    memory -> the reasoner's packet
 * @param policy   {closedWorld}
 * @param closed   predicate -> boolean, the declared closedness (only read under `closedWorld: "declared"`)
 * @param decide   the guard: `judge` for the typed runtime, `judgeWire` for the oracle's own packets
 */
export function answerOverSlice({memory, query, solve, policy = {}, closed = null, maxSteps = MAX_WIDENING_STEPS, decide = judge}) {
  const trail = [];
  let mem = memory;
  for (let step = 1; ; step++) {
    const output = solve(mem);
    const verdict = decide({query, output, slice: mem.slice, closedWorld: policy.closedWorld ?? 'view', closed});
    trail.push({step, facts: mem.slice.facts, rules: mem.slice.rules, lookups: mem.slice.lookups, probes: mem.slice.probes, complete: mem.slice.complete, status: output.status, accepted: verdict.accept});
    const next = !verdict.accept && step < maxSteps && typeof mem.widen === 'function' ? mem.widen() : null;
    if (verdict.accept || !next) return {...verdict.output, retrieval: retrievalReport(mem, trail, verdict), ...(mem.linkPlan ? {linkPlan: mem.linkPlan} : {})};
    mem = next;
  }
}
