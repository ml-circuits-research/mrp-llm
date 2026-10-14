/**
 * z3-smt-bounded: Z3 as a finite-domain engine for NON-recursive programs (proposal section 7.1, Z3 column). Z3 4.15.8 runs as a
 * subprocess with a hard time limit. Separate from the existing `z3-lia` strategy, which stays what it is.
 *
 * Two Booleans per ground atom (one per polarity), completion of the non-recursive rules, bounded aggregates, arithmetic constraints
 * and optimisation, abduction and why_not as cardinality-minimal choices over fresh Boolean literals, bounded planning as
 * satisfiability with norms as violation Booleans (plan.mjs). RECURSION is declared unsupported (`not_expressible`): completion over a
 * cycle characterises the supported models, not the least model (case 04b, probes/z3-04b-completion-recursion.smt2).
 * A bounded encoding never says `no_plan` or `optimal` it cannot prove: a horizon cut is `budget_exhausted` with `reason horizon`, a
 * grounded domain that overflows is `reason domain`, a time stop is `reason wall`.
 */
import {askWith} from '../solver-common/frontend.mjs';
import {z3Version, z3Command} from './z3.mjs';
import {z3Closure} from './closure.mjs';
import {z3Constraint} from './constraint.mjs';
import {z3Abduce, z3WhyNot} from './abduce.mjs';
import {z3Plan} from './plan.mjs';
import {NotExpressibleError} from '../js-reference/values.mjs';

export const FEATURES = ['facts', 'select', 'open_world', 'classical_negation', 'conflict', 'rules', 'conjunction', 'exists', 'every', 'count',
  'zero_arity', 'naf', 'closed_world', 'closed_derived', 'compute_in_rules', 'compare_in_rules', 'aggregate', 'default', 'overrides', 'strict_contrary',
  'integrity', 'versions', 'whatif', 'epistemic_status', 'exact_arithmetic', 'temporal', 'interval', 'throughout', 'snapshot_derived', 'used',
  'constraint', 'optimize', 'plan', 'abduce', 'why_not', 'norms_hard', 'norms_soft', 'temporal_norms', 'blocked_info', 'abduce_waive', 'binding_advisory', 'norm_conflict'];

/** Declared unsupported (a circuit that needs one is `not_expressible`, never weakened). */
export const NOT_EXPRESSIBLE = ['recursion', 'explain', 'time_vars', 'budget', 'budget_probes', 'method', 'htn_choice', 'on_failure', 'procedures', 'procedure_render',
  'amendment', 'check_plan', 'conform_asof', 'conform_deviation', 'collect', 'time_ordering'];

export const capabilities = {
  id: 'z3-smt-bounded',
  features: FEATURES,
  notExpressible: NOT_EXPRESSIBLE,
  delivery: 'slice',
  limits: {max_wires: 2000, max_arity: 6, integer_range: [-(2 ** 53), 2 ** 53 - 1]},
  guarantee: 'bounded',
  exact: {kind: 'rational'},
  provides: [],
  budgetKeys: ['timeoutMs', 'maxDepth', 'maxHypotheses', 'maxCandidates'],
  determinism: 'deterministic',
  isolation: true
};

export async function available() {
  const version = z3Version();
  return version ? {ok: true, version, path: z3Command()} : {ok: false, reason: 'z3 not available (Z3_BIN or tools/.solvers/z3/bin/z3)'};
}

/** A recursive slice is refused before any encoding: completion would admit models that are not the least model. */
function check(program) {
  if (program.strata.some(s => s.recursive)) throw new NotExpressibleError(['recursion'], 'recursion is declared unsupported by z3-smt-bounded (completion over a cycle is unsound, case 04b)');
}

const engine = {
  id: 'z3-smt-bounded',
  allowed: ['norms_hard', 'abduce_waive'],
  check,
  closure: z3Closure,
  constraint: z3Constraint,
  abduce: z3Abduce,
  whyNot: z3WhyNot,
  plan: z3Plan
};

/** ask({theory | handle, query}, budget, options) -> the packet of 5.3. */
export function ask(problem, budget = {}, options = {}) { return askWith(engine, problem, budget, options); }

export const z3SmtBounded = {...capabilities, capabilities, available, ask};
export default z3SmtBounded;
