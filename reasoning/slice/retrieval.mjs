/**
 * The slice of a memory that one question needs (DS005 "Closedness and completeness for the knowledge wires", proposal section 11).
 *
 * `SliceRetrieval` pulls facts from a source through keyed lookups driven by the demand of the question and of the rules it can reach
 * (`demand.mjs`), never by scanning a predicate when a constant can key the lookup. It is incremental: `expand` runs the demand to its
 * fixpoint within a budget of lookups, and `widen` raises the budgets that stopped it (the cap of a truncated lookup, the number of
 * lookups, the number of facts) and continues without repeating a lookup.
 *
 * What it reports (R-P5) is the slice: its size, its predicates, the bounds in force, whether it is COMPLETE and, when it is not, why.
 * A slice is COMPLETE when the demand reached its fixpoint, no lookup was truncated, the rule closure is complete and no budget stopped it;
 * it is SETTLED when it is also EXACT, every lookup having been answered by an exact view (R-P3: an associative candidate list never
 * closes a predicate). Only a settled slice supports a count or a universal answer. A read here never writes
 * (AGENTS.md rule 7): the source is asked to recall, and nothing is reinforced by retrieval.
 *
 * The source is any object with `lookup(pattern, {cap, probes}) -> {rows, complete, exact, probes}`; `rows` are typed facts
 * `{id, atom, valid, ...}`. `RepositorySource` (`source.mjs`) is the product's source over the memory strategies.
 */
import {Demand} from './demand.mjs';
import {stable} from '../../lib/util.mjs';
import {emitAtom} from '../../sop/parser.mjs';

export const SLICE_DEFAULTS = Object.freeze({
  firstCap: 256, firstLookups: 128, growth: 4, maxFacts: 10000, maxProbes: 50000, maxLookups: 20000,
  // wall-clock bound of one expansion; a retrieval that cannot finish in it is incomplete, never silently longer
  retrievalMs: 10000,
  // a join that would look up this many values of one relation tries to read the whole relation instead, when it is at most `probeFactor` times as large
  probeAt: 48, probeFactor: 12
});

const RECURSIVE_DEFAULTS = Object.freeze({maxFacts: 100000, maxProbes: 500000, maxLookups: 200000, retrievalMs: 60000});

/** A cycle in the rule dependency graph, including mutually recursive rules, needs the larger bounded retrieval class. */
function retrievalClass(rules) {
  const heads = new Set(rules.map(r => `${r.then.p}/${r.then.a.length}`));
  const edges = new Map([...heads].map(head => [head, new Set()]));
  for (const rule of rules) {
    const from = `${rule.then.p}/${rule.then.a.length}`;
    for (const atom of rule.if) {
      const to = `${atom.p}/${atom.a.length}`;
      if (heads.has(to)) edges.get(from).add(to);
    }
  }
  const visited = new Set(), active = new Set();
  const cyclic = node => {
    if (active.has(node)) return true;
    if (visited.has(node)) return false;
    visited.add(node);
    active.add(node);
    for (const next of edges.get(node)) if (cyclic(next)) return true;
    active.delete(node);
    return false;
  };
  return [...heads].some(cyclic) ? 'recursive' : 'ordinary';
}

const placeholder = i => '?k' + i;

/** The pattern of a keyed lookup (value `value` at position `i` of a predicate of arity `n`) or of a scan (`i` null). */
export function lookupPattern(p, n, i, value, neg) {
  return {p, a: Array.from({length: n}, (_, k) => (k === i ? value : placeholder(k))), neg};
}

export class SliceRetrieval {
  /**
   * @param source   lookup source
   * @param query    the typed question (only its atoms are read here)
   * @param conjunctions  the question's atoms, one array per alternative (`alternatives` of its conditions)
   * @param rules    the typed rules of the closure
   * @param localFacts  facts supplied with the question (complete by construction, already time-filtered)
   * @param schema   optional predicate schema: a predicate it does not know is not looked up and makes the slice incomplete
   * @param rulesComplete  whether the rule closure itself is complete
   */
  constructor({source, conjunctions, rules = [], localFacts = [], schema = null, rulesComplete = true, limits = {}, strategy = null}) {
    this.source = source;
    this.rules = rules;
    this.schema = schema;
    this.rulesComplete = rulesComplete;
    this.strategy = strategy;
    this.demand = new Demand({conjunctions, rules, estimate: source?.estimate ? pattern => source.estimate(pattern) : null});
    this.class = retrievalClass(rules);
    const defaults = this.class === 'recursive' ? RECURSIVE_DEFAULTS : SLICE_DEFAULTS;
    this.max = {facts: limits.maxFacts ?? defaults.maxFacts, probes: limits.maxProbes ?? defaults.maxProbes, lookups: limits.maxLookups ?? defaults.maxLookups, ms: limits.retrievalMs ?? defaults.retrievalMs};
    this.probed = new Map();
    this.cap = Math.min(SLICE_DEFAULTS.firstCap, this.max.facts);
    this.budget = Math.min(SLICE_DEFAULTS.firstLookups, this.max.lookups);
    this.facts = new Map();
    this.done = new Map();      // obligation key -> {cap, truncated, rows, complete}
    this.scans = new Map();     // "p/n" -> {cap, truncated, rows}
    this.local = new Map();
    this.lookups = 0;
    this.probes = 0;
    this.steps = 0;
    this.inexact = new Set();
    this.unknownPredicates = new Set();
    this.stoppedBy = null;
    this.fixpoint = false;
    this.log = [];
    for (const f of localFacts) { this.facts.set(f.id, f); this.local.set(f.id, f); this.demand.feed(f); }
  }

  known(p) { return !this.schema || Object.hasOwn(this.schema, p); }

  /** Adds retrieved facts to the slice (within the fact budget) and lets them enlarge the demand. */
  admit(rows) {
    let added = 0, overflow = false;
    for (const f of rows) {
      if (this.facts.has(f.id)) continue;
      if (this.facts.size >= this.max.facts) { this.stoppedBy ??= 'fact_budget'; overflow = true; continue; }
      this.facts.set(f.id, f);
      this.demand.feed(f);
      added++;
    }
    return {rows: added, overflow};
  }

  /**
   * Reads a whole relation in one go when a join would otherwise look it up value by value: the rows are kept only if the relation fits in
   * `cap` (both polarities), so a relation that is too large costs one bounded read and leaves the slice untouched.
   */
  probe(p, n, cap) {
    const got = [];
    for (const neg of [false, true]) {
      const left = this.max.probes - this.probes;
      if (left <= 0) return false;
      const r = this.source.lookup(lookupPattern(p, n, null, null, neg), {cap, probes: left});
      this.lookups++;
      this.probes += r.probes ?? r.rows.length;
      if (!r.complete || r.rows.length >= cap || r.exact === false) return false;
      for (const row of r.rows) got.push(row);
    }
    // A speculative scan is atomic: overflow must leave room for the keyed reads that can still find decisive evidence.
    const unseen = new Set();
    for (const row of got) if (!this.facts.has(row.id)) unseen.add(row.id);
    if (unseen.size > this.max.facts - this.facts.size) return false;
    const admitted = this.admit(got);
    this.scans.set(`${p}/${n}`, {cap, truncated: false, capped: false, complete: true, rows: admitted.rows, exact: true, probed: true});
    return true;
  }

  /** One keyed or unkeyed lookup of both polarities; returns whether it was truncated. */
  pull(p, n, i, value, cap) {
    let truncated = false, capped = false, exact = true, complete = true, rows = 0, lookupStopped = false;
    for (const neg of [false, true]) {
      const left = this.max.probes - this.probes;
      if (left <= 0) { this.stoppedBy ??= 'probe_budget'; truncated = true; complete = false; break; }
      if (this.lookups >= this.budget) { this.stoppedBy ??= 'lookup_budget'; lookupStopped = true; truncated = true; complete = false; break; }
      const r = this.source.lookup(lookupPattern(p, n, i, value, neg), {cap, probes: left});
      this.lookups++;
      this.probes += r.probes ?? r.rows.length;
      exact &&= r.exact !== false;
      if (!r.complete || r.rows.length >= cap) { truncated = true; complete = false; if (r.rows.length >= cap) capped = true; }
      const added = this.admit(r.rows);
      rows += added.rows;
      if (added.overflow) { truncated = true; complete = false; }
    }
    if (!exact) this.inexact.add(p);
    return {truncated, capped, complete, rows, exact, lookupStopped};
  }

  /** Runs the demand to its fixpoint, or until a budget stops it (then `stoppedBy` says which). */
  expand() {
    this.steps++;
    this.stoppedBy = null;
    this.fixpoint = false;
    const deadline = performance.now() + this.max.ms;
    for (;;) {
      let todo = this.demand.obligations().filter(o => !this.satisfied(o));
      if (todo.length >= SLICE_DEFAULTS.probeAt) {
        const groups = new Map();
        for (const o of todo) {
          const k = `${o.p}/${o.n}`;
          let group = groups.get(k);
          if (!group) groups.set(k, group = []);
          group.push(o);
        }
        for (const [k, list] of groups) {
          if (list.length < SLICE_DEFAULTS.probeAt || !this.known(list[0].p)) continue;
          // Already admitted facts do not consume the remaining distinct-fact budget; a complete relation may fit even when it filled it.
          const cap = Math.min(this.max.facts + 1, list.length * SLICE_DEFAULTS.probeFactor);
          const previous = this.probed.get(k) ?? 0;
          // A clipped final cap must still be tried even when it falls short of geometric growth.
          if (cap <= list.length || cap <= previous || (cap < previous * SLICE_DEFAULTS.growth && cap < this.max.facts + 1) || this.lookups + 2 > this.budget || performance.now() > deadline) continue;
          this.probed.set(k, cap);
          this.probe(list[0].p, list[0].n, cap);
        }
        todo = todo.filter(o => !this.satisfied(o));
      }
      if (todo.length) {
        for (const o of todo) {
          if (performance.now() > deadline) { this.stoppedBy ??= 'time_budget'; return; }
          if (this.lookups >= this.budget) { this.stoppedBy ??= 'lookup_budget'; return; }
          if (!this.known(o.p)) { this.unknownPredicates.add(o.p); this.done.set(o.key, {cap: this.cap, truncated: false, rows: 0, skipped: true}); continue; }
          const r = this.pull(o.p, o.n, o.i, o.value, this.cap);
          this.done.set(o.key, {cap: this.cap, ...r, o});
          this.note(o, r);
          if (this.stoppedBy) return;
        }
        continue;
      }
      const scan = this.demand.nextScan(new Set(this.scans.keys()));
      if (!scan) { this.fixpoint = true; return; }
      if (performance.now() > deadline) { this.stoppedBy ??= 'time_budget'; return; }
      if (this.lookups >= this.budget) { this.stoppedBy ??= 'lookup_budget'; return; }
      const key = `${scan.p}/${scan.n}`;
      if (!this.known(scan.p)) { this.unknownPredicates.add(scan.p); this.scans.set(key, {cap: this.cap, truncated: false, rows: 0, skipped: true}); continue; }
      const r = this.pull(scan.p, scan.n, null, null, this.cap);
      this.scans.set(key, {cap: this.cap, ...r});
      this.note({p: scan.p, n: scan.n, i: null, value: null, via: 'scan'}, r);
      if (this.stoppedBy) return;
    }
  }

  /** An obligation is satisfied by its own lookup, or by a complete scan of its predicate. */
  satisfied(o) {
    if (this.done.has(o.key)) return true;
    const scan = this.scans.get(`${o.p}/${o.n}`);
    return Boolean(scan && !scan.truncated);
  }

  note(o, r) {
    if (this.log.length < 64) this.log.push({p: o.p, position: o.i, value: o.value, via: o.via, rows: r.rows, complete: r.complete, exact: r.exact});
  }

  /** The lookups that did not return everything (stopped at a cap, or the source said so), as {predicate, position, value}. */
  truncatedLookups() {
    const out = [];
    for (const d of this.done.values()) if (d.truncated && d.o && this.scans.get(`${d.o.p}/${d.o.n}`)?.complete !== true) {
      out.push({predicate: d.o.p, position: d.o.i, value: d.o.value, cap: d.cap});
    }
    for (const [k, s] of this.scans) if (s.truncated) out.push({predicate: k.split('/')[0], position: null, value: null, cap: s.cap});
    return out;
  }

  complete() { return this.why().length === 0; }

  /** True when the retained view that answered every lookup is exact (R-P3); false once an associative candidate list took part. */
  exact() { return this.inexact.size === 0; }

  /** Complete and exact: the slice can support a count, a universal answer or any other closed-world claim (R-P2, R-P3). */
  settled() { return this.complete() && this.exact(); }

  /** The reasons the slice cannot be proven complete (empty: it is complete). */
  why() {
    const reasons = [];
    if (!this.rulesComplete) reasons.push('rules_incomplete');
    if (!this.fixpoint) reasons.push(this.stoppedBy ?? 'demand_not_exhausted');
    for (const t of this.truncatedLookups()) reasons.push(`truncated:${t.predicate}${t.position === null ? '' : `[${t.position}=${stable(t.value)}]`}`);
    for (const p of this.unknownPredicates) reasons.push('unknown_predicate:' + p);
    return [...new Set(reasons)];
  }

  /**
   * Raises what stopped the last expansion (the cap of the lookups that were truncated, the number of lookups) and continues. Returns
   * false when nothing can be raised, so the caller stops widening: a fact, probe or time budget is a hard bound, never raised.
   */
  widen() {
    if (['fact_budget', 'probe_budget', 'time_budget'].includes(this.stoppedBy)) return false;
    const g = SLICE_DEFAULTS.growth;
    let raised = false;
    const capped = [...this.done.values(), ...this.scans.values()].some(d => d.capped);
    if (capped && this.cap < this.max.facts) {
      this.cap = Math.min(this.cap * g, this.max.facts);
      for (const [k, d] of [...this.done]) if (d.capped) this.done.delete(k);
      for (const [k, s] of [...this.scans]) if (s.capped) this.scans.delete(k);
      raised = true;
    }
    if (this.stoppedBy === 'lookup_budget' && this.budget < this.max.lookups) {
      this.budget = Math.min(this.budget * g, this.max.lookups);
      // A lookup interrupted between polarities must be retried after its allowance grows.
      for (const [k, d] of this.done) if (d.lookupStopped) this.done.delete(k);
      for (const [k, s] of this.scans) if (s.lookupStopped) this.scans.delete(k);
      raised = true;
    }
    if (!raised) return false;
    this.expand();
    return true;
  }

  /** The retrieval result in the shape the reasoner takes (`kind: "retrieval"`), with the slice report. */
  result({query, strategy = this.strategy, goals = [], steps = []} = {}) {
    const facts = [...this.facts.values()];
    const complete = this.complete();
    const reasons = this.why();
    const report = this.report({complete, reasons});
    const out = {
      kind: 'retrieval', query, facts, rules: this.rules, complete, probes: this.probes, shardsVisited: 0,
      needed: [...new Set(this.demand.atoms.map(c => c.p))],
      slice: report,
      linkPlan: {
        strategy, coverage: report.exact ? 'retained-exact-records' : 'provider-defined', goals, steps, retrievals: this.log.slice(),
        lookups: this.lookups, note: 'Completeness refers to this retrieval view and budgets, never to all facts in the world.'
      }
    };
    return out;
  }

  report({complete = this.complete(), reasons = this.why()} = {}) {
    const keyed = this.done.size > 0;
    return {
      complete, settled: complete && this.exact(), reasons, class: this.class,
      truncated: this.truncatedLookups().length > 0,
      keyed, exact: this.exact(), inexact_predicates: [...this.inexact],
      steps: this.steps, lookups: this.lookups, scans: [...this.scans.keys()], probes: this.probes,
      facts: this.facts.size, local_facts: this.local.size, rules: this.rules.length,
      predicates: this.demand.predicates(),
      bound: {facts: this.max.facts, probes: this.max.probes, lookups: this.max.lookups, cap: this.cap, ms: this.max.ms},
    };
  }
}

export {emitAtom};
