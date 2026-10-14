/**
 * Demand analysis of a slice (experiments/proposal/reasoning-wires-proposal.md section 11.2 to 11.5, DS005 "Closedness and
 * completeness for the knowledge wires").
 *
 * Which stored facts can matter for a question? The question (one conjunction of atoms per alternative of its `any` groups) and the
 * rules it can reach (one conjunction per rule body) are CALL atoms. A fact matters when it matches a call atom. This module plans, before
 * any lookup, how every call atom is reached, the way a magic-set rewriting does:
 *
 *   - each conjunction is ordered greedily by sideways information passing: the atom with the most positions that are already bound (a
 *     constant, a variable of an earlier atom, a head variable seeded by the caller) comes first;
 *   - each reachable rule is specialized by its caller's lookup position, with directed input and output domains, so converse and
 *     recursive calls preserve their retrieval direction instead of requiring every call site to bind the same head position;
 *   - a call atom with at least one bound position is KEYED: the facts that can match it are found by looking up the values of the
 *     variable (or the constant) at one bound position; a call atom with no bound position is SCANNED: its predicate is looked up without
 *     a key, and the constants of what it returns key the atoms joined with it.
 *
 * At run time the module keeps the values each variable class can take (`dom`), fed by every retrieved fact, and says which keyed
 * lookups are still owed (`obligations`) and which predicates still need a scan (`nextScan`). When none is owed the demand is at a
 * FIXPOINT: every fact a bottom-up reasoner could use for these atoms has been requested. Completeness holds by induction on the join
 * order: a bound position takes values that an earlier, fully requested atom (or the caller, or a constant) already contributed, so the
 * domain of its class contains every value of every solution.
 *
 * Domains deliberately overapproximate joins: projected premise values flow to rule outputs without evaluating a rule. They never merge
 * recursive input and output positions. Indexed cached rows are revisited when new input keys arrive, until the domain fixpoint.
 *
 * The module is pure (no memory access); `retrieval.mjs` runs the lookups.
 */
import {variable} from '../../lib/types.mjs';
import {stable} from '../../lib/util.mjs';

const MAX_ALTERNATIVES = 32;
// Stored counts omit derived fanout. Preserve the written order unless the base estimate offers a substantial advantage.
const DERIVED_ESTIMATE_MARGIN = 8;

/** The conjunctions of a question's conditions: `any` groups are alternatives. Null when there are too many (the caller falls back). */
export function alternatives(conditions, cap = MAX_ALTERNATIVES) {
  const product = (lists) => {
    let acc = [[]];
    for (const list of lists) {
      const next = [];
      for (const a of acc) for (const b of list) { next.push([...a, ...b]); if (next.length > cap) return null; }
      acc = next;
    }
    return acc;
  };
  const expand = c => {
    if (c.kind === 'any') {
      const out = [];
      for (const child of c.children) { const sub = expand(child); if (!sub) return null; out.push(...sub); if (out.length > cap) return null; }
      return out;
    }
    if (c.kind === 'all') { const parts = c.children.map(expand); return parts.includes(null) ? null : product(parts); }
    return [[c]];
  };
  const lists = [];
  for (const c of conditions ?? []) { const sub = expand(c); if (!sub) return null; lists.push(sub); }
  return product(lists);
}

/**
 * The variables a question's comparisons fix to constants: `compare ?x equal c` and `compare any` of such lines ("Which is bigger,
 * Canada or Brazil?"). `compares` are trees of {kind: all|any, children} and {left, op, right}. Returns [{variable, values}].
 * Retrieval uses them as bindings (a comparison keeps the rows afterwards; it only tells which facts can matter), so the question
 * "which of A or B was born first" asks for the facts of A and B, not for the birth year of every person.
 */
export function equalityDomains(compares) {
  const out = [];
  const leafValues = node => (node.kind ? null : node.op === 'equal' && variable(node.left) && !variable(String(node.right)) && node.right !== undefined ? {variable: node.left, values: [node.right]} : null);
  const visit = node => {
    if (!node) return;
    if (!node.kind) { const d = leafValues(node); if (d) out.push(d); return; }
    if (node.kind === 'all') { node.children.forEach(visit); return; }
    const options = node.children.map(leafValues);
    if (options.length && options.every(Boolean) && options.every(o => o.variable === options[0].variable)) out.push({variable: options[0].variable, values: options.flatMap(o => o.values)});
  };
  (compares ?? []).forEach(visit);
  return out;
}

/** The conjunctions with each fixed variable replaced by each of its constants (one conjunction per constant); unchanged without domains or beyond the cap. */
export function bindDomains(conjunctions, domains, cap = 4 * MAX_ALTERNATIVES) {
  let current = conjunctions;
  for (const {variable: v, values} of domains) {
    const next = [];
    for (const atoms of current) {
      if (!atoms.some(a => a.a.includes(v))) { next.push(atoms); continue; }
      for (const value of values) next.push(atoms.map(a => ({...a, a: a.a.map(t => (t === v ? value : t))})));
    }
    if (next.length > cap) return conjunctions;
    current = next;
  }
  return current;
}

export const slot = (p, n) => `${p}/${n}`;

export class Demand {
  /**
   * @param conjunctions  arrays of the question's atoms, one array per alternative
   * @param rules         typed rules ({id, if: [atom], then: atom}) of the closure
   */
  constructor({conjunctions, rules = [], estimate = null}) {
    this.dom = new Map();
    this.edges = new Map();
    this.facts = new Map();
    this.readers = new Map();
    this.pending = [];
    this.atoms = [];
    this.owners = [];
    this.heads = new Map();
    for (const r of rules) {
      const key = slot(r.then.p, r.then.a.length);
      if (!this.heads.has(key)) this.heads.set(key, []);
      this.heads.get(key).push(r);
    }
    conjunctions.forEach((atoms, j) => {
      const owner = {id: 'query' + j, atoms: this.register('query' + j, atoms, 'query')};
      for (const call of owner.atoms) call.estimate = estimate && call.terms.some(t => t.cls === undefined)
        ? estimate({p: call.p, a: call.terms.map(t => t.cls ? t.name : t.value), neg: call.neg}) : Infinity;
      this.owners.push(owner);
      this.order(owner, []);
    });
    this.plan();
    for (const call of this.atoms) {
      const cls = call.key === null ? null : call.terms[call.key].cls;
      if (!cls) continue;
      if (!this.readers.has(cls)) this.readers.set(cls, []);
      this.readers.get(cls).push(call);
      for (const key of this.dom.get(cls)?.keys() ?? []) this.pending.push({call, key});
    }
  }

  term(owner, t) { return variable(t) ? {cls: owner + '|' + t, name: t} : {value: t}; }

  register(owner, atoms, origin) {
    return atoms.map(atom => {
      const call = {id: this.atoms.length, owner, origin, p: atom.p, n: atom.a.length, neg: atom.neg === true, terms: atom.a.map(t => this.term(owner, t)), bound: [], key: null};
      this.atoms.push(call);
      return call;
    });
  }

  headOf(owner, atom) { return {owner, p: atom.p, n: atom.a.length, terms: atom.a.map(t => this.term(owner, t))}; }

  /** Input domains flow into rule instances; outputs flow back, never merging recursive input and output positions. */
  connect(from, to) {
    if (!this.edges.has(from)) this.edges.set(from, new Set());
    this.edges.get(from).add(to);
    for (const [key, entry] of this.dom.get(from) ?? []) this.add(to, entry.value, 'seed', key);
  }

  /** Orders one conjunction by sideways information passing; records on each atom the positions that are bound when it is reached. */
  order(owner, seeded, later = []) {
    const bound = new Set();
    if (owner.head) owner.head.terms.forEach((t, k) => { if (t.cls && seeded[k]) bound.add(t.cls); });
    // Positions the caller fixes beyond the key (`later`) are WEAKLY bound: they never make an atom come earlier and key an atom only
    // when nothing else binds it, so they key a later atom (the second person of a self-join, the other person of a rule over two named
    // entities) instead of a scan, but never become the first retrieval key (a hub such as "france" in located_in ?y france).
    const weak = new Set(owner.head ? owner.head.terms.filter((t, k) => t.cls && later[k] && !bound.has(t.cls)).map(t => t.cls) : []);
    const todo = owner.atoms.slice();
    owner.sequence = [];
    while (todo.length) {
      const score = a => a.terms.filter(t => t.cls === undefined || bound.has(t.cls)).length;
      const joined = a => a.terms.filter(t => t.cls !== undefined && bound.has(t.cls)).length;
      let best = 0;
      todo.forEach((a, i) => {
        const previous = todo[best];
        const margin = this.heads.has(slot(a.p, a.n)) || this.heads.has(slot(previous.p, previous.n)) ? DERIVED_ESTIMATE_MARGIN : 1;
        if (score(a) > score(previous) || (score(a) === score(previous) && (
          joined(a) > joined(previous) || (joined(a) === joined(previous) &&
          Math.max(1, a.estimate ?? Infinity) * margin < Math.max(1, previous.estimate ?? Infinity))))) best = i;
      });
      const [atom] = todo.splice(best, 1);
      atom.bound = atom.terms.map((t, i) => (t.cls === undefined || bound.has(t.cls) || weak.has(t.cls) ? i : -1)).filter(i => i >= 0);
      // key by a bound variable (its values come from an earlier, fully requested atom), then by a weakly bound one (the caller's
      // complete domain), before a written constant (possibly a hub)
      atom.key = atom.bound.find(i => bound.has(atom.terms[i].cls)) ?? atom.bound.find(i => weak.has(atom.terms[i].cls)) ?? atom.bound[0] ?? null;
      for (const t of atom.terms) if (t.cls) { bound.add(t.cls); weak.delete(t.cls); }
      owner.sequence.push(atom);
    }
  }

  /**
   * Specialize each reachable rule by the single position actually used for retrieval. Converse and mutually recursive rules can
   * therefore pass a key through an entire dependency cycle without requiring unrelated call sites to bind the same position.
   * Each rule has at most arity + 1 instances (one per key position and one scan).
   */
  plan() {
    const instances = new Map();
    for (let j = 0; j < this.atoms.length; j++) {
      const call = this.atoms[j];
      // Positions besides the key that the caller fixes with a written constant are seeded too ("is Newton older than Einstein": both
      // persons), in an instance of their own, so a self-join (born_on ?a ?x, born_on ?b ?y) keys both atoms instead of scanning one; callers
      // that leave such a position open use another instance, whose domains stay complete for them.
      // The same holds for a position bound by a variable of the caller ("lived_before ?a ?b" in the body of a rule instance whose head
      // has both persons): its complete domain flows into the instance as an input. A rule over several named entities therefore keys
      // every atom on one of them instead of scanning a predicate for the second. The extra positions are only weakly bound in the
      // instance (`order`), so a hub constant next to a variable key ("inside ?x europe") still never becomes the first retrieval key.
      const fixed = call.key === null ? [] : call.bound.filter(i => i !== call.key);
      for (const rule of this.heads.get(slot(call.p, call.n)) ?? []) {
        const usable = fixed.filter(i => rule.then.a[i] !== undefined && variable(rule.then.a[i]));
        const id = `rule:${rule.id}@${call.key ?? 'scan'}${usable.length ? '+' + usable.join('+') : ''}`;
        let owner = instances.get(id);
        if (!owner) {
          owner = {id, atoms: this.register(id, rule.if, 'rule'), head: this.headOf(id, rule.then)};
          instances.set(id, owner);
          this.owners.push(owner);
          this.order(owner, owner.head.terms.map((_, i) => i === call.key), owner.head.terms.map((_, i) => usable.includes(i)));
        }
        for (let k = 0; k < call.n; k++) {
          const c = call.terms[k], h = owner.head.terms[k];
          if (k === call.key && h.cls) {
            if (c.cls) this.connect(c.cls, h.cls);
            else this.add(h.cls, c.value, 'seed');
          } else if (usable.includes(k) && h.cls) {
            if (c.cls) this.connect(c.cls, h.cls);
            else this.add(h.cls, c.value, 'seed');
          } else if (c.cls) {
            if (h.cls) this.connect(h.cls, c.cls);
            else this.add(c.cls, h.value, 'seed');
          }
        }
      }
    }
  }

  /** Adds a domain value and propagates it along input/output edges. */
  add(cls, value, from, key = stable(value)) {
    const queue = [cls];
    for (let i = 0; i < queue.length; i++) {
      const current = queue[i];
      if (!this.dom.has(current)) this.dom.set(current, new Map());
      const map = this.dom.get(current);
      if (map.has(key)) continue;
      map.set(key, {value});
      for (const call of this.readers.get(current) ?? []) this.pending.push({call, key});
      for (const next of this.edges.get(current) ?? []) queue.push(next);
    }
    return this.dom.get(cls).size;
  }

  /** Facts contribute only to calls whose input domain reaches them; a reverse call cannot flood a forward call's input. */
  feed(fact) {
    const a = fact.atom, key = slot(a.p, a.a.length), id = stable(a);
    if (!this.facts.has(key)) this.facts.set(key, {seen: new Set(), positions: a.a.map(() => new Map())});
    const facts = this.facts.get(key);
    if (facts.seen.has(id)) return;
    facts.seen.add(id);
    a.a.forEach((v, i) => {
      const key = stable(v), index = facts.positions[i];
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(a);
    });
    for (const call of this.atoms) if (call.p === a.p && call.n === a.a.length) this.feedCall(call, a);
  }

  feedCall(call, a) {
    if (call.terms.some((t, i) => t.cls === undefined && stable(t.value) !== stable(a.a[i]))) return;
    if (call.key !== null) {
      const t = call.terms[call.key];
      if (t.cls && !this.dom.get(t.cls)?.has(stable(a.a[call.key]))) return;
    }
    call.terms.forEach((t, i) => { if (t.cls !== undefined) this.add(t.cls, a.a[i], 'fact'); });
  }

  /** Revisit only the indexed rows reached by newly arrived input keys, including rows admitted before a recursive call reached them. */
  settle() {
    for (let i = 0; i < this.pending.length; i++) {
      const {call, key} = this.pending[i];
      const rows = this.facts.get(slot(call.p, call.n))?.positions[call.key].get(key) ?? [];
      for (const a of rows) this.feedCall(call, a);
    }
    this.pending.length = 0;
  }

  /** The keyed lookups owed now. */
  obligations() {
    this.settle();
    const out = new Map();
    for (const call of this.atoms) {
      if (call.key === null) continue;
      const t = call.terms[call.key];
      const values = t.cls === undefined ? [t.value] : [...(this.dom.get(t.cls)?.values() ?? [])].map(e => e.value);
      for (const value of values) {
        const key = `${slot(call.p, call.n)}#${call.key}=${stable(value)}`;
        if (!out.has(key)) out.set(key, {key, p: call.p, n: call.n, i: call.key, value});
      }
    }
    return [...out.values()];
  }

  /** The predicates (name/arity) that still need an unkeyed scan, in plan order (question atoms first). */
  scans() {
    const out = [];
    for (const call of this.atoms) if (call.key === null && !out.some(s => s.p === call.p && s.n === call.n)) out.push({p: call.p, n: call.n, origin: call.origin});
    return out.sort((x, y) => (x.origin === 'query' ? 0 : 1) - (y.origin === 'query' ? 0 : 1));
  }

  nextScan(scanned) { return this.scans().find(s => !scanned.has(slot(s.p, s.n))) ?? null; }

  /** The predicates (name/arity) of the call atoms. */
  predicates() { return [...new Set(this.atoms.map(c => slot(c.p, c.n)))]; }
}
