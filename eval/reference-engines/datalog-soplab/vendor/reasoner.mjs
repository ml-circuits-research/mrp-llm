// VENDORED: copied verbatim from soplab-v0.4.0.zip src/reasoner.mjs
import { BuiltinRegistry } from './builtins.mjs';
import { ProviderRegistry } from './providers.mjs';
import { ClaimStore } from './store.mjs';
import { Metrics } from './metrics.mjs';
import { all } from './conditions.mjs';
import { isGroundAtom, substituteTerm } from './model.mjs';
import { solveCondition } from './engine/evaluator.mjs';
import { materialize, materializeNaive, materializeDelta } from './engine/materialize.mjs';
import { sliceRules } from './dependency.mjs';
import { defaultWireTypes } from './wire-types.mjs';

export class Reasoner {
  constructor({
    store = new ClaimStore(),
    builtins = new BuiltinRegistry(),
    providers = new ProviderRegistry(),
    metrics = new Metrics(),
    wireTypes = defaultWireTypes(),
    materializers = null,
  } = {}) {
    this.store = store;
    this.builtins = builtins;
    this.providers = providers;
    this.metrics = metrics;
    this.wireTypes = new Map(wireTypes);
    this.materializers = materializers ? new Map(materializers) : new Map([['naive', materializeNaive], ['delta', materializeDelta]]);
    this.rules = [];
    this.ruleIds = new Set();
    this.wires = new Map();
  }

  fact(atom, provenance = { kind: 'asserted' }) { this.store.add(atom, provenance); return this; }
  facts(atoms, provenance = { kind: 'asserted' }) { for (const a of atoms) this.fact(a, provenance); return this; }

  addWire(def) {
    if (!def?.id) throw new Error('Wire requires id');
    if (this.wires.has(def.id)) throw new Error(`Duplicate wire id: ${def.id}`);
    this.wires.set(def.id, def);
    return this;
  }
  addWires(defs) { for (const d of defs) this.addWire(d); return this; }

  addRule(r) {
    if (!r?.id) throw new Error('Rule requires id');
    if (this.ruleIds.has(r.id)) throw new Error(`Duplicate rule id: ${r.id}`);
    this.ruleIds.add(r.id); this.rules.push(r); return this;
  }
  addRules(rules) { for (const r of rules) this.addRule(r); return this; }

  registerProvider(name, fn) { this.providers.register(name, fn); return this; }
  registerBuiltin(name, fn) { this.builtins.register(name, fn); return this; }
  registerWireType(name, handler) { if (typeof handler !== 'function') throw new TypeError('Wire handler must be a function'); this.wireTypes.set(String(name), handler); return this; }
  registerMaterializer(name, fn) { if (typeof fn !== 'function') throw new TypeError('Materializer must be a function'); this.materializers.set(String(name), fn); return this; }

  *solve(expr, seed = {}, evidence = [], context = {}) {
    yield* solveCondition(this, expr, seed, evidence, { metrics: this.metrics, ...context });
  }

  saturate(options = {}) {
    return materialize(this, { metrics: this.metrics, ...options });
  }

  query(goals, { select = null, distinct = true } = {}) {
    const expr = Array.isArray(goals) ? all(...goals) : goals;
    const rows = [];
    const seen = new Set();
    for (const sol of this.solve(expr)) {
      let row;
      if (select) row = Object.fromEntries(select.map((v) => [v, substituteTerm(v, sol.bindings)]));
      else row = Object.fromEntries(Object.entries(sol.bindings)
        .filter(([k]) => !k.startsWith('?__'))
        .map(([k, v]) => [k, substituteTerm(v, sol.bindings)]));
      const sig = JSON.stringify(row);
      if (!distinct || !seen.has(sig)) rows.push({ bindings: row, evidence: sol.evidence });
      seen.add(sig);
    }
    this.metrics.inc('queryRows', rows.length);
    return rows;
  }

  /**
   * Side-effect-free materialize + query. `scope: sliced` materializes only
   * rules in the backwards predicate dependency slice of the goal.
   */
  evaluate(goals, {
    scope = 'sliced',
    strategy = 'delta',
    select = null,
    distinct = true,
    maxRounds = 1000,
    maxFacts = 1_000_000,
  } = {}) {
    const worker = this.clone({ includeDerived: false, resetMetrics: true });
    const expr = Array.isArray(goals) ? all(...goals) : goals;
    const slice = scope === 'sliced' ? sliceRules(worker, expr) : { rules: worker.rules, predicates: null };
    const materialization = worker.saturate({ strategy, rules: slice.rules, maxRounds, maxFacts });
    const rows = worker.query(expr, { select, distinct });
    worker.metrics.finish();
    return {
      rows,
      materialization,
      metrics: worker.metrics.snapshot(),
      selectedRules: slice.rules.map((r) => r.id),
      selectedPredicates: slice.predicates ? [...slice.predicates].sort() : null,
      reasoner: worker,
    };
  }

  ask(a) {
    if (!isGroundAtom(a)) throw new Error('ask() requires a ground atom');
    return this.store.status(a);
  }

  explain(a, { maxDepth = 16 } = {}) {
    const rec = this.store.get(a);
    if (!rec) return null;
    const visit = (record, depth, trail) => {
      if (!record) return null;
      if (depth > maxDepth || trail.has(record.key)) return { atom: record.atom, key: record.key, truncated: true };
      const nextTrail = new Set(trail).add(record.key);
      return {
        atom: record.atom,
        key: record.key,
        proofs: record.proofs.map((p) => p.kind !== 'rule' ? p : ({
          ...p,
          premisesExpanded: (p.premises ?? []).map((premise) =>
            typeof premise === 'string' ? visit(this.store.claims.get(premise), depth + 1, nextTrail) : premise),
        })),
      };
    };
    return visit(rec, 0, new Set());
  }

  explainDOT(a, { maxDepth = 16 } = {}) {
    const explanation = this.explain(a, { maxDepth });
    if (!explanation) return 'digraph Proof {\n  empty [label="no proof"];\n}\n';
    const lines = ['digraph Proof {', '  rankdir=LR;'];
    const nodes = new Set();
    const esc = (x) => String(x).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    const visit = (node) => {
      if (!node?.key || nodes.has(node.key)) return;
      nodes.add(node.key);
      lines.push(`  "${esc(node.key)}" [label="${esc(node.key)}"];`);
      for (const proof of node.proofs ?? []) {
        if (proof.kind !== 'rule') continue;
        for (const p of proof.premisesExpanded ?? []) {
          if (!p?.key) continue;
          visit(p);
          lines.push(`  "${esc(p.key)}" -> "${esc(node.key)}" [label="${esc(proof.ruleId)}"];`);
        }
      }
    };
    visit(explanation);
    lines.push('}');
    return `${lines.join('\n')}\n`;
  }

  clone({ includeDerived = true, resetMetrics = false } = {}) {
    const c = new Reasoner({
      store: ClaimStore.fromJSON(this.store.toJSON({ includeDerived })),
      builtins: this.builtins,
      providers: this.providers,
      metrics: resetMetrics ? new Metrics() : this.metrics.clone(),
      wireTypes: this.wireTypes,
      materializers: this.materializers,
    });
    c.rules = [...this.rules];
    c.ruleIds = new Set(this.ruleIds);
    c.wires = new Map(this.wires);
    return c;
  }
}
