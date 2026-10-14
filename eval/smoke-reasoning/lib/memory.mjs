/**
 * A reference in-memory wire store with the two indexes the proposal needs (predicate and predicate-plus-constant for
 * facts, head predicate for rules), a seeded generator of distractor wires, and a symbol-driven relevance slice.
 * It is a model of the retrieval contract, not a memory engine: the product memory strategies (DS016 to DS021) would
 * answer the same calls. Probes are counted so retrieval cost can be compared, in this store's own unit.
 */
import {parse, tokens, parseCondition, leaves} from '../validator.mjs';
import {wireText} from './desugar.mjs';

const isVar = t => t.startsWith('?');

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

export class MemoryStore {
  constructor() {
    this.facts = [];
    this.rules = [];
    this.other = [];
    this.byPred = new Map();
    this.byPredConst = new Map();
    this.byHead = new Map();
    this.probes = 0;
  }
  size() { return this.facts.length + this.rules.length; }
  addFact(f) {
    this.facts.push(f);
    (this.byPred.get(f.p) ?? this.byPred.set(f.p, []).get(f.p)).push(f);
    for (const t of new Set(f.terms)) { const k = f.p + '|' + t; (this.byPredConst.get(k) ?? this.byPredConst.set(k, []).get(k)).push(f); }
  }
  addRule(r) { this.rules.push(r); (this.byHead.get(r.head.p) ?? this.byHead.set(r.head.p, []).get(r.head.p)).push(r); }
  /** Load parsed wires. Keeps the wire text so a slice can be re-emitted as circuits. */
  addWires(wires, {tag = 'k'} = {}) {
    for (const w of wires) {
      if (w.type === 'fact') {
        const t = tokens(w.fields.find(f => f.key === 'holds').value);
        const neg = t[0] === 'not';
        const rest = neg ? t.slice(1) : t;
        this.addFact({id: w.id, p: rest[0], terms: rest.slice(1), neg, text: wireText(w), tag});
      } else if (w.type === 'rule') {
        const body = [];
        for (const f of w.fields.filter(x => x.key === 'when')) for (const l of leaves(parseCondition(f, []))) if (l.kind === 'atom') body.push({p: l.p, neg: l.neg, terms: l.terms});
        const h = tokens(w.fields.find(f => f.key === 'then').value);
        const hneg = h[0] === 'not';
        this.addRule({id: w.id, head: {p: (hneg ? h[1] : h[0]), neg: hneg}, body, text: wireText(w), tag});
      } else if (w.type === 'default') {
        // round 3: a default is retrieved like a rule by its head predicate; its `except` atoms are body predicates for relevance, and the
        // head predicate (the strict contrary lives there) and the exception predicates are COMPLETENESS-SENSITIVE (see widen.mjs)
        const body = [], except = [];
        for (const f of w.fields.filter(x => x.key === 'when')) for (const l of leaves(parseCondition(f, []))) if (l.kind === 'atom') body.push({p: l.p, neg: l.neg, terms: l.terms});
        for (const f of w.fields.filter(x => x.key === 'except')) for (const l of leaves(parseCondition(f, []))) if (l.kind === 'atom') { body.push({p: l.p, neg: l.neg, terms: l.terms}); except.push(l.p); }
        const h = tokens(w.fields.find(f => f.key === 'then').value);
        const hneg = h[0] === 'not';
        this.addRule({id: w.id, head: {p: (hneg ? h[1] : h[0]), neg: hneg}, body, isDefault: true, except, text: wireText(w), tag});
      } else this.other.push({id: w.id, type: w.type, text: wireText(w), tag});
    }
    return this;
  }
  lookupPred(p, cap) {
    const rows = this.byPred.get(p) ?? [];
    this.probes += 1 + Math.min(rows.length, cap);
    return {rows: rows.slice(0, cap), truncated: rows.length > cap};
  }
  lookupPredConst(p, c, cap) {
    const rows = this.byPredConst.get(p + '|' + c) ?? [];
    this.probes += 1 + Math.min(rows.length, cap);
    return {rows: rows.slice(0, cap), truncated: rows.length > cap};
  }
  rulesFor(p) { this.probes += 1; return this.byHead.get(p) ?? []; }
}

/** Seeded distractor wires: irrelevant predicates, irrelevant rules, and "hard" facts over relevant predicates about other entities. */
export function addDistractors(store, spec) {
  const r = rng(spec.seed ?? 1);
  const pick = n => Math.floor(r() * n);
  const entities = spec.entities ?? Math.max(200, Math.floor(spec.facts / 3));
  let i = 0;
  for (const [pred, h] of Object.entries(spec.hard ?? {})) {
    for (let k = 0; k < h.n; k++) {
      const terms = Array.from({length: h.arity ?? 2}, () => 'd' + pick(entities));
      // `neg: true` (round 3) makes the hard distractors NEGATIVE facts (`not p dN`): look-alikes of a strict contrary that are not answers
      store.addFact({id: 'dh' + i++, p: pred, terms, neg: Boolean(h.neg), text: `@dh${i}x fact\n  holds ${h.neg ? 'not ' : ''}${pred} ${terms.join(' ')}`, tag: 'distractor'});
    }
  }
  const preds = Array.from({length: spec.predicates ?? 30}, (_, k) => 'q' + k);
  for (let k = 0; k < (spec.facts ?? 0); k++) {
    const p = preds[pick(preds.length)];
    const a = 'd' + pick(entities), b = 'd' + pick(entities);
    store.addFact({id: 'df' + i++, p, terms: [a, b], neg: false, text: `@df${i}x fact\n  holds ${p} ${a} ${b}`, tag: 'distractor'});
  }
  for (let k = 0; k < (spec.rules ?? 0); k++) {
    const h = preds[pick(preds.length)], b1 = preds[pick(preds.length)], b2 = preds[pick(preds.length)];
    store.addRule({id: 'dr' + i++, head: {p: h, neg: false}, body: [{p: b1, neg: 'none', terms: ['?x', '?z']}, {p: b2, neg: 'none', terms: ['?z', '?y']}],
      text: `@dr${i}x rule\n  when ${b1} ?x ?z\n  when ${b2} ?z ?y\n  then ${h} ?x ?y`, tag: 'distractor'});
  }
  return store;
}

/**
 * Symbol-driven relevance slice.
 *  radius: how many levels of the rule dependency graph (head -> body predicates) to follow from the query predicates;
 *  hops:   how many rounds of constant expansion to fetch facts (facts that mention a query constant, then constants
 *          of those facts, ...); Infinity fetches whole relevant predicates;
 *  cap:    maximum facts fetched per predicate (a retrieval budget); a hit marks the predicate truncated.
 * `complete` is true only when the rule levels and the constant expansion both reached a fixpoint and nothing was
 * truncated: then the slice contains every wire a bottom-up engine could use for this query over the stored memory.
 */
export function relevantSlice(store, queryAtoms, {radius = 1, hops = 1, cap = 1000, extraPreds = [], seedConsts = [], keyed = new Set(), ruleCap = Infinity, uncappedRules = new Set()} = {}) {
  const startProbes = store.probes;
  const preds = new Set([...queryAtoms.map(a => a.p), ...extraPreds]);
  const rules = new Map(), ruleTruncated = new Set();
  let frontier = new Set(preds), rulesComplete = false;
  for (let level = 0; level < radius || radius === Infinity; level++) {
    const next = new Set();
    for (const p of frontier) for (const rule of (() => { const all = store.rulesFor(p), take = uncappedRules.has(p) ? all : all.slice(0, ruleCap); if (take.length < all.length) ruleTruncated.add(p); return take; })()) {
      if (rules.has(rule.id)) continue;
      rules.set(rule.id, rule);
      for (const b of rule.body) if (!preds.has(b.p)) { preds.add(b.p); next.add(b.p); }
    }
    if (!next.size) { rulesComplete = true; break; }
    frontier = next;
  }
  if (!rulesComplete) { rulesComplete = ![...frontier].some(p => store.byHead.has(p) && store.byHead.get(p).some(r => !rules.has(r.id))); }
  const consts = new Set([...seedConsts, ...queryAtoms.flatMap(a => a.terms.filter(t => !isVar(t) && !t.startsWith('$')))]);
  for (const r of rules.values()) for (const b of r.body) for (const t of b.terms) if (!isVar(t)) consts.add(t);
  const facts = new Map(), truncated = new Set(), perPred = new Map();
  const take = (p, res) => {
    for (const f of res.rows) { const n = perPred.get(p) ?? 0; if (!facts.has(f.id)) { facts.set(f.id, f); perPred.set(p, n + 1); } }
    if (res.truncated) truncated.add(p);
  };
  let fixpoint = false;
  const expanded = new Set();
  if (hops === Infinity || !consts.size) {
    for (const p of preds) if (!keyed.has(p)) take(p, store.lookupPred(p, cap));
    fixpoint = true;
    if (keyed.size) {
      // keyed predicates are fetched per known key (constant) instead of as a whole: complete for those keys only
      for (const f of facts.values()) for (const t of f.terms) consts.add(t);
      for (const p of keyed) if (preds.has(p)) for (const c of consts) take(p, store.lookupPredConst(p, c, cap));
    }
  } else {
    for (let h = 0; h < hops; h++) {
      const todo = [...consts].filter(c => !expanded.has(c));
      if (!todo.length) { fixpoint = true; break; }
      for (const c of todo) { expanded.add(c); for (const p of preds) take(p, store.lookupPredConst(p, c, cap)); }
      for (const f of facts.values()) for (const t of f.terms) consts.add(t);
      if (![...consts].some(c => !expanded.has(c))) { fixpoint = true; break; }
    }
    if (!fixpoint) fixpoint = ![...consts].some(c => !expanded.has(c));
  }
  if (ruleTruncated.size) rulesComplete = false;
  return {facts: [...facts.values()], rules: [...rules.values()], preds, truncated, ruleTruncated, complete: rulesComplete && fixpoint && truncated.size === 0, rulesComplete, fixpoint, probes: store.probes - startProbes};
}

export const sliceText = (slice, store) => [...store.other.map(o => o.text), ...slice.rules.map(r => r.text), ...slice.facts.map(f => f.text)].join('\n\n') + '\n';

/** Parse the where atoms of a query circuit. */
export function queryAtoms(queryText) {
  const out = [];
  for (const w of parse(queryText).wires.filter(w => w.type === 'query')) for (const f of w.fields.filter(x => ['where', 'scope'].includes(x.key))) for (const l of leaves(parseCondition(f, []))) if (l.kind === 'atom') out.push({p: l.p, terms: l.terms, neg: l.neg});
  return out;
}
