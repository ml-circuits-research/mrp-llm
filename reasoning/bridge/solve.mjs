/**
 * Backend dispatch of the runtime's two decision problems. `backend auto|js` is the oracle; an external backend is the strategy
 * that supersedes the retired adapter (external.mjs). The dispatch never substitutes: an unavailable explicit backend is
 * `unsupported`, a profile mismatch is an assertion.
 */
import {assert} from '../../lib/util.mjs';
import {reason} from './reason.mjs';
import {hornProlog, constraintZ3, optimizeZ3} from './external.mjs';
import {validateConstraint, enumerateConstraint, optimizeConstraint} from '../strategies/js-reference/constraint-ast.mjs';

/** Horn question over `memory = {facts, rules, complete, probes}`; assumptions are admitted by the shared rule. */
export function solveHorn(q, memory, {backend = 'auto', assumptions = [], ...limits} = {}) {
  if (backend === 'auto') backend = 'js';
  assert(['js', 'prolog'].includes(backend), 'Horn query requires JS or Prolog backend');
  if (backend === 'js') return {...reason(q, memory, {assumptions, ...limits}), backend: 'js'};
  return hornProlog(q, memory, {assumptions, ...limits});
}

/** Integer constraint problem (`task prove|possible`; optimization goes through `optimize`). */
export function solveConstraint(problem, {backend = 'auto', ...options} = {}) {
  validateConstraint(problem);
  if (backend === 'auto') backend = 'js';  // never chosen by problem size: Z3 runs only when it is requested (rule 8)
  assert(['js', 'z3'].includes(backend), 'Constraint problem cannot be dispatched to this backend');
  return backend === 'js' ? enumerateConstraint(problem, options) : constraintZ3(problem, options);
}

export function optimize(problem, {backend = 'js', ...options} = {}) {
  assert(['js', 'z3'].includes(backend), 'Constraint problem cannot be dispatched to this backend');
  return backend === 'js' ? optimizeConstraint(problem, options) : optimizeZ3(problem, options);
}
