/**
 * The relational core in Z3: the completion of the ground non-recursive program has exactly one model, and the atoms true in it are
 * the closure the oracle derives. Statuses of a query are read from the oracle's reader over those atoms.
 */
import {Grounder} from './ground.mjs';
import {SolverStop} from './z3.mjs';

export function z3Closure({program, facts, budget, notes}) {
  try {
    const g = new Grounder(program, facts, {timeoutMs: budget.limits.timeoutMs, notes});
    g.run();
    g.stage();
    return {atoms: g.trueAtoms(), exhausted: null};
  } catch (e) {
    if (e instanceof SolverStop) return {atoms: [], exhausted: {reason: e.reason}};
    throw e;
  }
}
