/**
 * Budgets of the js-reference strategy. A strategy may stop early; it never answers as if it had finished (section 6): every
 * ceiling that is hit throws BudgetStop, the caller turns it into `budget_exhausted` with a `reason`, or into a partial
 * positive answer where the rules of section 6 allow one. Requested limits (a `policy` wire, the `budget` argument of `ask`) only
 * TIGHTEN the host ceilings below.
 */
export const CEILINGS = {
  maxRounds: 1000, maxJoins: 2_000_000, maxFacts: 200_000, maxNodes: 200_000, maxDepth: 20, maxHypotheses: 12,
  maxCandidates: 4096, maxAssignments: 2_000_000, maxFanout: 100_000, maxPlans: 1, timeoutMs: 30_000
};

/** Trusted report replay only; ordinary asks and policy wires retain CEILINGS. */
export const VERIFY_CEILINGS = Object.freeze({
  ...CEILINGS, maxRounds: 10_000, maxJoins: 200_000_000, maxFacts: 2_000_000, maxFanout: 2_000_000, timeoutMs: 120_000
});

const REASONS = {
  maxRounds: 'rounds', maxJoins: 'probes', maxFacts: 'facts', maxNodes: 'nodes', maxDepth: 'horizon', maxHypotheses: 'hypotheses',
  maxCandidates: 'candidates', maxAssignments: 'domain', maxFanout: 'fanout', timeoutMs: 'wall'
};

export class BudgetStop extends Error {
  constructor(key) {
    super(`budget exhausted: ${key}`);
    this.key = key;
    this.reason = REASONS[key] ?? key;
  }
}

const EFFORT = {quick: 0.1, normal: 1, deep: 1};
/** Effort scales the work ceilings; the planning horizon, the candidate cap and the plan count are not work. */
const SCALED = ['maxRounds', 'maxJoins', 'maxFacts', 'maxNodes', 'maxCandidates', 'maxAssignments', 'maxFanout', 'timeoutMs'];

export class Budget {
  /** Requested limits tighten the selected profile; only trusted verification replay selects VERIFY_CEILINGS. */
  constructor(requested = {}, {effort = 'normal', verification = false} = {}) {
    const ceilings = verification ? VERIFY_CEILINGS : CEILINGS;
    this.limits = {};
    for (const [k, ceiling] of Object.entries(ceilings)) {
      const base = SCALED.includes(k) ? Math.max(1, Math.floor(ceiling * (EFFORT[effort] ?? 1))) : ceiling;
      const asked = Number(requested[k]);
      this.limits[k] = Number.isSafeInteger(asked) && asked > 0 ? Math.min(asked, ceiling) : base;
    }
    this.used = {maxRounds: 0, maxJoins: 0, maxFacts: 0, maxNodes: 0, maxFanout: 0, maxAssignments: 0, maxHypotheses: 0, maxCandidates: 0};
    this.started = performance.now();
    this.stop = null;
  }

  count(key, n = 1) {
    this.used[key] = (this.used[key] ?? 0) + n;
    if (this.used[key] > this.limits[key]) this.fail(key);
    if (key === 'maxJoins' || key === 'maxNodes' || key === 'maxAssignments') this.checkTime();
  }

  probe(n = 1) { this.count('maxJoins', n); }
  fact() { this.count('maxFacts'); }
  node() { this.count('maxNodes'); }

  /** Fixpoint rounds that still derive something new: the round beyond the limit is not run. */
  round(r) {
    this.used.maxRounds = r;
    if (r > this.limits.maxRounds) this.fail('maxRounds');
  }

  /** A budget with fresh counters, the same limits and the same clock (one closure per planning state or abduction candidate). */
  child() {
    const b = new Budget({});
    b.limits = this.limits;
    b.started = this.started;
    return b;
  }

  checkTime() {
    if (performance.now() - this.started > this.limits.timeoutMs) this.fail('timeoutMs');
  }

  fail(key) {
    this.stop = this.stop ?? new BudgetStop(key);
    throw this.stop;
  }

  /** The `budget` block of the result packet. */
  snapshot(partial = false) {
    return {
      limit: this.limits, used: {...this.used, ms: Math.round(performance.now() - this.started)},
      exhausted: this.stop !== null, reason: this.stop?.reason ?? null, partial: this.stop !== null && partial
    };
  }
}
