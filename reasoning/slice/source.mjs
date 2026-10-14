/**
 * The product's fact source for slice retrieval: one keyed (or unkeyed) pattern is answered by a registered retrieval strategy
 * (`memory/strategies.mjs`: sqlite, scan, hybrid, exact, recall-memory, holo-memory, or a host-registered provider) over the
 * repository session. The source only reads (AGENTS.md rule 7).
 *
 * `exact` says whether the answer comes from an exact view (R-P3): an associative strategy returns candidates, and a candidate list
 * never closes a predicate, so a slice that rests on one is never complete.
 */
import {flattenLayers} from '../../memory/temporal.mjs';
const EXACT_COVERAGE = new Set(['retained-exact-records', 'visible-exact-snapshot', 'partial-exact-snapshot']);

export const isExactCoverage = coverage => EXACT_COVERAGE.has(coverage);

export class RepositorySource {
  constructor({repo, session, registry, strategy, query, limits = {}}) {
    Object.assign(this, {repo, session, registry, strategy, query, limits});
    this.estimates = new Map();
  }

  /** Base tuple counts break ties between equally bound query atoms. Counts affect order only, never guards or answers. */
  estimate(pattern) {
    const key = JSON.stringify(pattern);
    if (this.estimates.has(key)) return this.estimates.get(key);
    const layers = flattenLayers(this.repo.visible(this.session).map(x => x.layer), pattern);
    let count = 0;
    for (const layer of layers) for (const bank of layer.banks ?? [layer.pinned, layer.normal]) {
      if (!bank || !Object.hasOwn(bank.domains, pattern.p + '/' + pattern.a.length)) continue;
      if (bank.config.engine !== 'sqlite' || typeof bank.estimate !== 'function') return Infinity;
      count += bank.estimate(pattern);
    }
    this.estimates.set(key, count);
    return count;
  }
  lookup(pattern, {cap, probes}) {
    const r = this.registry.retrieve(this.strategy, {
      repo: this.repo, session: this.session, pattern, query: this.query,
      limits: {...this.limits, maxFacts: cap, maxProbes: probes}
    });
    return {rows: r.rows, complete: r.complete, probes: r.probes, exact: isExactCoverage(r.coverage), coverage: r.coverage};
  }
}

/** A source over facts held in an array: a fixture for tests and for callers that hold their facts already. Matches like the SQLite bank. */
export class ArraySource {
  constructor(facts, {exact = true} = {}) {
    this.facts = facts;
    this.exact = exact;
    this.calls = [];
  }

  lookup(pattern, {cap}) {
    this.calls.push(pattern);
    const hits = this.facts.filter(f => {
      const a = f.atom;
      if (a.p !== pattern.p || a.a.length !== pattern.a.length || Boolean(a.neg) !== Boolean(pattern.neg)) return false;
      return pattern.a.every((t, i) => (typeof t === 'string' && t.startsWith('?')) || t === a.a[i]);
    });
    const rows = hits.slice(0, cap);
    return {rows, complete: hits.length <= cap, probes: rows.length, exact: this.exact};
  }
}
