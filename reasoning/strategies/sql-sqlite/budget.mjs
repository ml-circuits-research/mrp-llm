/**
 * Budgets of the sql-sqlite strategy (proposal section 6). The keys it honours:
 *   maxRounds   fixpoint rounds of an iterative (semi-naive) stratum; a recursive CTE has no round counter, so a tightened `maxRounds`
 *               makes the strategy run that stratum as a loop instead (see closure.mjs);
 *   maxFacts    derived tuples written to the relation tables (a recursive CTE stops through a LIMIT);
 *   maxJoins    joined candidate tuples visited by the `tick()` function of every join statement (the unit of this strategy,
 *               never compared with another strategy's probes);
 *   timeoutMs   wall time, checked inside statements by `tick()` and between statements.
 * A cut statement is rolled back by SQLite as a whole, so what remains is a sound partial closure. Requested limits only TIGHTEN the
 * ceilings below. `maxNodes`, `maxFanout` and the planning keys are not honoured here.
 */
import {BudgetStop} from '../js-reference/budget.mjs';

export const CEILINGS = {maxRounds: 100_000, maxFacts: 20_000_000, maxJoins: 2_000_000_000, timeoutMs: 30_000};
export const HONOURED = Object.keys(CEILINGS);

const EFFORT = {quick: 0.1, normal: 1, deep: 1};

export class SqlBudget {
  constructor(requested = {}, {effort = 'normal', ceilings = CEILINGS} = {}) {
    this.limits = {};
    for (const [k, ceiling] of Object.entries(ceilings)) {
      const asked = Number(requested[k]);
      this.limits[k] = Number.isSafeInteger(asked) && asked > 0 ? Math.min(asked, ceiling) : Math.max(1, Math.floor(ceiling * (EFFORT[effort] ?? 1)));
    }
    this.used = {maxRounds: 0, maxFacts: 0, maxJoins: 0};
    this.started = performance.now();
    this.stop = null;
  }

  /** One joined tuple visited (called from SQL for every row that reaches the innermost loop of a join). */
  tick() {
    if (++this.used.maxJoins > this.limits.maxJoins) this.fail('maxJoins');
    if ((this.used.maxJoins & 255) === 0) this.checkTime();
  }

  facts(n) {
    this.used.maxFacts += n;
    if (this.used.maxFacts > this.limits.maxFacts) this.fail('maxFacts');
  }

  /** Remaining room for derived tuples, to bound a statement with LIMIT. */
  factRoom() { return Math.max(0, this.limits.maxFacts - this.used.maxFacts); }

  /** A round that still derived something new: the round beyond the limit is not run. */
  round(r) {
    this.used.maxRounds = r;
    if (r > this.limits.maxRounds) this.fail('maxRounds');
  }

  checkTime() {
    if (performance.now() - this.started > this.limits.timeoutMs) this.fail('timeoutMs');
  }

  fail(key) {
    this.stop = this.stop ?? new BudgetStop(key);
    throw this.stop;
  }

  /** A budget with fresh counters, the same limits and the same clock (one closure per part of an interval query). */
  child() {
    const b = new SqlBudget({});
    b.limits = this.limits;
    b.started = this.started;
    return b;
  }

  snapshot(partial = false) {
    return {
      limit: this.limits, used: {...this.used, ms: Math.round(performance.now() - this.started)},
      exhausted: this.stop !== null, reason: this.stop?.reason ?? null, partial: this.stop !== null && partial
    };
  }
}
