/**
 * asp-clingo: the stable-model strategy (proposal section 7.1, ASP column). clingo 5.8.2 runs as a subprocess with `--time-limit`.
 *
 * The desugared core is lowered to ASP (lower.mjs): polarity as two relations (`pos_p`, `neg_p`), `absent` as `not`, `compare` and
 * `compute` as arithmetic, aggregates as `#count`/`#sum`/`#min`/`#max` with set semantics over the `over` variables, defaults through
 * the desugaring (its result is the normative semantics, so the strategy agrees with the oracle by construction on stratified programs).
 * Abduction is a choice rule plus `#minimize` with an iteration over all inclusion-minimal sets; why_not is the same over fresh EDB atoms;
 * planning is a horizon encoding with norms as violation atoms (plan.mjs).
 *
 * Status mapping: a stratified program has ONE stable model, so brave and cautious reasoning coincide (closure.mjs documents how several
 * models would map). A bounded encoding never says `no_plan` or `optimal` it cannot prove: a horizon cut is `budget_exhausted` with
 * `reason horizon`; a time stop is `budget_exhausted` with `reason wall`.
 */
import {askWith} from '../solver-common/frontend.mjs';
import {clingoVersion, clingoCommand} from './clingo.mjs';
import {aspClosure} from './closure.mjs';
import {aspConstraint} from './constraint.mjs';
import {aspAbduce, aspWhyNot} from './abduce.mjs';
import {aspPlan} from './plan.mjs';

export const FEATURES = ['facts', 'select', 'open_world', 'classical_negation', 'conflict', 'rules', 'recursion', 'conjunction', 'exists', 'every', 'count',
  'zero_arity', 'naf', 'closed_world', 'closed_derived', 'compute_in_rules', 'compare_in_rules', 'exact_arithmetic', 'aggregate', 'default', 'overrides', 'strict_contrary',
  'integrity', 'versions', 'whatif', 'epistemic_status', 'temporal', 'interval', 'throughout', 'snapshot_derived', 'used',
  'constraint', 'optimize', 'plan', 'abduce', 'why_not', 'norms_hard', 'norms_soft', 'temporal_norms', 'blocked_info', 'abduce_waive', 'binding_advisory', 'norm_conflict'];

/** Declared unsupported (a circuit that needs one is `not_expressible`, never weakened). */
export const NOT_EXPRESSIBLE = ['explain', 'time_vars', 'budget', 'budget_probes', 'method', 'htn_choice', 'on_failure', 'procedures', 'procedure_render', 'amendment',
  'check_plan', 'conform_asof', 'conform_deviation', 'collect', 'time_ordering'];

export const capabilities = {
  id: 'asp-clingo',
  features: FEATURES,
  notExpressible: NOT_EXPRESSIBLE,
  delivery: 'slice',
  limits: {max_wires: 5000, max_arity: 6, integer_range: [-(2 ** 31), 2 ** 31 - 1]},
  guarantee: 'exact',
  exact: {kind: 'fixed_point', max_scale: 12},
  provides: [],
  budgetKeys: ['timeoutMs', 'maxDepth', 'maxHypotheses'],
  determinism: 'deterministic',
  isolation: true
};

export async function available() {
  const version = clingoVersion();
  return version ? {ok: true, version, path: clingoCommand()} : {ok: false, reason: 'clingo not available (CLINGO_BIN or tools/.solvers/clingo/bin/clingo)'};
}

const engine = {
  id: 'asp-clingo',
  allowed: ['norms_hard', 'abduce_waive'],
  closure: aspClosure,
  constraint: aspConstraint,
  abduce: aspAbduce,
  whyNot: aspWhyNot,
  plan: aspPlan
};

/** ask({theory | handle, query}, budget, options) -> the packet of 5.3. */
export function ask(problem, budget = {}, options = {}) { return askWith(engine, problem, budget, options); }

export const aspClingo = {...capabilities, capabilities, available, ask};
export default aspClingo;
