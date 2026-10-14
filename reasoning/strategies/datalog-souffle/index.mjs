/**
 * datalog-souffle: the desugared core lowered to Soufflé 2.5 (interpreter by default, compile mode with a cache), a fast exact engine
 * for the Horn-plus-negation-as-failure fragment (proposal 5.1, 7.1; implementation brief, datalog-agent).
 *
 *   facts          `.facts` TSV files in a temporary directory; two relations per predicate (positive and negative evidence);
 *   rules          clauses with stratified `!` for `absent`, arithmetic and guards; recursion is Soufflé's semi-naive evaluation;
 *   aggregates     count, sum, min, max over the set of distinct bindings (set semantics); `collect` is not lowered;
 *   queries        select, exists and count are pushed into the program (only answer rows are read back); every reads the closure
 *                  of the query predicates and is evaluated by the oracle's own query reader;
 *   budget         a wall-clock timeout (`timeoutMs`, ceiling 120 s here) kills the subprocess: `budget_exhausted`, reason `wall`;
 *                  a 32-bit overflow flagged by the guards is `budget_exhausted`, reason `numeric_range`; `maxFacts` is checked before the run.
 *
 * Not provided, declared: `used`, `proof` and `explain` (Soufflé's provenance, `-t explain`, is an interactive explorer over an
 * instrumented build and is not wired; the host computes `used` by deletion and verified replay), time, plan, abduction, why_not,
 * methods and norms. Integers are 32-bit (`limits.integer_range`). A circuit that needs any of these is `not_expressible`.
 */
import {askWith, prepare, NotExpressibleError} from '../datalog-common/front.mjs';
import {update as updateHandle} from '../js-reference/index.mjs';
import {lowerProgram} from './lower.mjs';
import {pushdownPlan, outcomeFromRows} from './pushdown.mjs';
import {runSouffle, probeSouffle} from './runner.mjs';
import {planFixedPoint, scaleProgram, scaleQuery, decodeTables, inexactError, INEXACT} from '../solver-common/fixed-point.mjs';

export {NotExpressibleError};

const FEATURES = ['facts', 'select', 'open_world', 'classical_negation', 'conflict', 'rules', 'recursion', 'conjunction', 'exists', 'every', 'count',
  'whatif', 'epistemic_status', 'naf', 'closed_world', 'closed_derived', 'compare_in_rules', 'compute_in_rules', 'exact_arithmetic', 'aggregate', 'default', 'overrides',
  'strict_contrary', 'integrity', 'versions', 'zero_arity', 'retrieval'];
const NOT_EXPRESSIBLE = ['used', 'explain', 'why_not', 'temporal', 'interval', 'throughout', 'snapshot_derived', 'time_vars', 'plan', 'abduce', 'constraint', 'optimize',
  'method', 'htn_choice', 'on_failure', 'norms_hard', 'norms_soft', 'temporal_norms', 'procedures', 'procedure_render', 'amendment', 'check_plan', 'blocked_info', 'abduce_waive'];

export const capabilities = {
  id: 'datalog-souffle',
  features: FEATURES,
  notExpressible: NOT_EXPRESSIBLE,
  delivery: 'slice',
  limits: {max_wires: 10_000_000, max_arity: 6, integer_range: [-(2 ** 31), 2 ** 31 - 1]},
  guarantee: 'exact',
  exact: {kind: 'fixed_point', max_scale: 12},
  provides: [],
  providesNote: 'used: false (no provenance wiring; the host computes used by deletion and replay), proof: false, explain: false',
  budgetKeys: ['timeoutMs', 'maxFacts'],
  determinism: 'deterministic',
  isolation: true,
  modes: ['interpret', 'compile']
};

/** Ceilings of this strategy (the oracle's are sized for a naive evaluator). */
const CEILINGS = {maxFacts: 20_000_000, timeoutMs: 120_000};
const DEFAULTS = {maxFacts: 20_000_000, timeoutMs: 60_000};

/**
 * Soufflé's magic-set transformation (`-m '*'`) restricts the evaluation to what the query's constants demand. It is applied when the program has
 * no negation, aggregate or arithmetic over derived relations, the fragment in which the transformation is the textbook one; with `absent`,
 * aggregates and `compute` the program is run without it (E10 makes the same choice: `stratified-negation-fallback`).
 */
function magicSafe(program) {
  if (program.aggregates.length) return false;
  return program.rules.every(r => r.alts.every(alt => alt.leaves.every(l => l.kind === 'atom' ? l.mode !== 'absent' : l.kind === 'compare')));
}

/** The fixed-point plan of a job (null: integer arithmetic is exact), computed once and kept on the job. */
function fixedPointOf(job) {
  if (job.fx === undefined) job.fx = planFixedPoint(job.program, job.qp ? job.qp.alts.concat(job.qp.scopeAlts) : []);
  return job.fx;
}

/** Options of the engine: `mode` interpret|compile, `pushdown` (default on), `magic` (true: -m '*', 'auto': -m '*' for a pushed-down query over a program without negation as failure, aggregates and arithmetic, or a relation list). */
export function makeEngine(options = {}) {
  const mode = options.mode ?? 'interpret';
  const engine = {
    id: 'datalog-souffle',
    ceilings: {maxFacts: {max: CEILINGS.maxFacts, default: DEFAULTS.maxFacts}, timeoutMs: {max: CEILINGS.timeoutMs, default: DEFAULTS.timeoutMs}},
    lastRun: null,

    pushdown(job) {
      if (options.pushdown === false || !['select', 'exists', 'count'].includes(job.qp.mode)) return null;
      const fx = fixedPointOf(job);
      const plan = pushdownPlan(fx ? scaleQuery(job.qp, fx, {narrow: true}) : job.qp);
      return engine.run(job, {...plan, wanted: new Set()}, tables => outcomeFromRows(job.qp, tables));
    },

    closure(job) {
      const out = engine.run(job, {wanted: job.wanted}, tables => ({tables}));
      return {tables: out.tables ?? new Map(), exhausted: out.exhausted ?? null, notes: out.notes ?? []};
    },

    run(job, {wanted, extra, extraAtoms, extraConstraints}, build) {
      const {facts, budget} = job;
      // exact decimals: the program is run as integers scaled by 10^S and the tables are divided back (solver-common/fixed-point.mjs)
      const fx = fixedPointOf(job);
      const program = fx ? scaleProgram(job.program, fx, {narrow: true}) : job.program;
      if (fx?.flag) wanted = new Set([...wanted, `p|${INEXACT}`]);
      const probe = probeSouffle();
      if (!probe.ok) throw Object.assign(new Error(`datalog-souffle is unavailable: ${probe.reason}`), {code: 'unavailable'});
      if (facts.length > budget.limits.maxFacts) return {rows: [], status: 'unknown', exhausted: {reason: 'facts'}, tables: new Map()};
      const t0 = performance.now();
      const lowered = lowerProgram({program, facts, wanted, extra, extraAtoms, extraConstraints});
      const lowerMs = Math.round(performance.now() - t0);
      const remaining = Math.max(1, Math.floor(budget.limits.timeoutMs - (performance.now() - budget.started)));
      const magic = options.magic === 'auto' ? (extra && magicSafe(program) ? ['*'] : null) : options.magic === true ? ['*'] : options.magic ?? null;
      const ran = runSouffle({lowered, mode, magic, timeoutMs: remaining});
      engine.lastRun = {dl: lowered.dl, timings: {lower: lowerMs, ...ran.timings}, compiled: ran.compiled, facts: facts.length, relations: lowered.relationCount};
      const timings = {souffle: {lower: lowerMs, ...ran.timings}};
      if (ran.timedOut) return {rows: [], status: 'unknown', exhausted: {reason: 'wall'}, tables: new Map(), timings};
      if (ran.overflow) return {rows: [], status: 'unknown', exhausted: {reason: 'numeric_range'}, tables: new Map(), timings, notes: ['arithmetic_overflow_32bit']};
      if (!fx) return {...build(ran.tables), timings};
      const decoded = decodeTables(ran.tables, fx);
      if (decoded.inexact) throw inexactError(fx);
      return {...build(decoded.tables), timings, notes: [`fixed_point_scale_${fx.scale}`]};
    }
  };
  return engine;
}

const defaultEngine = makeEngine();

export const available = async () => {
  const p = probeSouffle();
  return p.ok ? {ok: true, version: p.version, path: p.path} : {ok: false, reason: p.reason};
};

/** Answer a problem {theory | handle, query, requested?} (proposal 5.2, 5.3). `options`: engine options and `conditional: false`. */
export function ask(problem, budget = {}, options = {}) {
  const engine = Object.keys(options).some(k => ['mode', 'pushdown', 'magic'].includes(k)) ? makeEngine(options) : defaultEngine;
  return askWith(engine, problem, budget, options);
}

export {prepare};
export const update = updateHandle;

export const datalogSouffle = {...capabilities, capabilities, available, prepare, ask, update};
export default datalogSouffle;
