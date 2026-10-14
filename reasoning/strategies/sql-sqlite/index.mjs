/**
 * sql-sqlite: the Datalog core compiled to SQL and run by the built-in `node:sqlite` (proposal sections 5 to 7.1 and 11).
 *
 *   relations       one table per predicate, arity and polarity ("+p/2" and "-p/2"); `both` is computed at query time from the two;
 *   rules           INSERT ... SELECT per stratum; linear recursion as a recursive CTE; nonlinear and mutual recursion as a semi-naive
 *                   loop in JS over prepared SQL statements (so they ARE expressible); see closure.mjs;
 *   absent          NOT EXISTS over the finished lower stratum; aggregates GROUP BY with set semantics; compare and compute as SQL
 *                   expressions with the proposal's division and rounding rules; defaults and integrity through the desugaring;
 *   time            a point-in-time view of the stored facts per instant of the partition, combined as the oracle does;
 *   budget          `tick()` inside every join statement (probe ceiling and statement timeout), fact and round caps; a cut gives
 *                   `budget_exhausted` with a reason, a partial positive answer only where the proposal allows one;
 *   bank mode       `askBank` runs the same rules directly against a SQLite memory bank file (DS018), read-only: see bank.mjs.
 *
 * The strategy takes the same problem as the oracle, `{theory | handle, query}`, and returns the packet of section 5.3. Per-row
 * `conditional` is the host's job (the smoke harness and `options.conditional` apply the oracle's own two-run rule around any strategy).
 */
import {withConditional} from '../js-reference/conditional.mjs';
import {prepare, update, assumptionIds} from '../js-reference/index.mjs';
import {ProgramError, NotExpressibleError} from '../js-reference/values.mjs';
import {readWires} from './front.mjs';
import {HONOURED} from './budget.mjs';
import {memoryBackend} from './memory-backend.mjs';
import {solveOnce, sensitivityOf} from './solve.mjs';

export {ProgramError, NotExpressibleError, prepare, update, assumptionIds, sensitivityOf};

const FEATURES = ['facts', 'select', 'open_world', 'classical_negation', 'conflict', 'rules', 'recursion', 'conjunction', 'exists', 'every', 'count', 'explain', 'used',
  'temporal', 'interval', 'throughout', 'snapshot_derived', 'time_vars', 'whatif', 'epistemic_status', 'naf', 'closed_world', 'closed_derived', 'compare_in_rules',
  'compute_in_rules', 'exact_arithmetic', 'aggregate', 'default', 'overrides', 'strict_contrary', 'integrity', 'versions', 'zero_arity', 'budget', 'budget_probes', 'retrieval',
  'query_compare', 'query_rank', 'query_except', 'query_filter', 'query_limit'];
const NOT_EXPRESSIBLE = ['constraint', 'optimize', 'plan', 'abduce', 'abduce_waive', 'why_not', 'blocked_info', 'method', 'htn_choice', 'on_failure', 'norms_hard', 'norms_soft',
  'temporal_norms', 'procedures', 'procedure_render', 'amendment', 'check_plan'];

export const capabilities = {
  id: 'sql-sqlite',
  features: FEATURES,
  notExpressible: NOT_EXPRESSIBLE,
  delivery: 'slice',
  limits: {max_wires: Infinity, max_arity: 6, integer_range: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]},
  guarantee: 'exact',
  exact: {kind: 'fixed_point', max_scale: 12},
  provides: ['explain', 'used', 'proof'],
  budgetKeys: HONOURED,
  determinism: 'deterministic',
  isolation: false,
  bank: 'askBank (opt-in, read-only, DS018 memory bank file)'
};

export async function available() {
  try {
    const {DatabaseSync} = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    const {v} = db.prepare('SELECT sqlite_version() AS v').get();
    db.close();
    return {ok: true, version: v, path: 'node:sqlite (built in)'};
  } catch (e) {
    return {ok: false, reason: 'node:sqlite is not available: ' + e.message};
  }
}

/**
 * Answer a problem {theory | handle, query, requested?}. Throws ProgramError for an invalid circuit and NotExpressibleError for a circuit that
 * needs a feature this strategy declares unsupported; budget exhaustion is a packet, never an exception.
 * `options`: `conditional` (default false: the host computes it), `recursion` 'auto' | 'cte' | 'loop', `provenance` (default true: `used`/`proof`).
 */
export function ask(problem, budgetArg = {}, options = {}) {
  const t0 = performance.now();
  const handle = problem.handle ?? prepare(problem.theory ?? '');
  const qWires = readWires(problem.query, 'query');
  const solve = excluded => solveOnce(memoryBackend, handle, qWires, excluded, budgetArg, options);
  const packet = options.conditional ? withConditional(assumptionIds(handle, problem.query), solve) : solve(new Set());
  const requested = problem.requested ?? null;
  return {
    ...packet,
    route: {requested, chosen: 'sql-sqlite', reason: requested ? 'explicit request' : 'direct call to the strategy', fallback: null},
    timings: {...(packet.timings ?? {}), total: Math.round(performance.now() - t0)}
  };
}

export const sqlSqlite = {...capabilities, capabilities, available, prepare, ask, update};
export default sqlSqlite;
