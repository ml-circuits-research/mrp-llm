/**
 * The finite-domain encoding of a NON-recursive program for Z3 (proposal 7.1, Z3 column).
 *
 * Two Booleans per ground atom, one for each polarity (`p_pos(a)` and `p_neg(a)`, the atom key carries the polarity), so a theory that
 * holds both `p a` and `not p a` stays satisfiable and `both` is just the two true together. The atoms of the encoding are the
 * POSSIBLE ones: a rule is instantiated by joining its positive body over the atoms already possible (the grounding gringo does),
 * so the domain is finite by construction and the encoding is exactly the Clark COMPLETION of the ground non-recursive program:
 *
 *   atom <-> (instance_1 or instance_2 or ...)           a fact is a constant true; `absent p x` is `not p_pos(x)`
 *
 * Completion characterises the supported models, which are the least model only without positive cycles; a recursive stratum is
 * therefore refused (`not_expressible`, case 04b and probes/z3-04b-completion-recursion.smt2), never encoded.
 *
 * Aggregates are bounded sums over the members of a group (`(+ (ite member value 0) ...)`, SET semantics over the `over` variables).
 * A group's value is an integer that later strata read as a constant, so the program is decided stratum by stratum at an aggregate:
 * everything below it is solved (completion plus `get-value`), becomes constant, and the sums are evaluated by Z3. `compare` and
 * `compute` over constants are evaluated while grounding (integer division truncates toward zero, an undefined operation drops the
 * instance); a value that Z3 computes outside the grounded domain simply becomes a new constant of the next stratum.
 */
import {unify} from '../js-reference/join.mjs';
import {groundArgs, termIn, compareValues, argsKey, NotExpressibleError, ProgramError} from '../js-reference/values.mjs';
import {exactCompute as compute, realOf, smtReal} from '../solver-common/exact-rational.mjs';
import {runZ3, valuesOf, intOf, smtInt, SolverStop} from './z3.mjs';

/** min or max of constants as a chain of `let` bindings (linear size: a nested ite that repeats its operand would be exponential). */
function extremum(fn, values) {
  if (values.length === 1) return values[0];
  const cmp = fn === 'min' ? '<' : '>';
  const lets = [];
  let prev = values[0];
  for (let i = 1; i < values.length; i++) {
    lets.push(`(m${i} (ite (${cmp} ${prev} ${values[i]}) ${prev} ${values[i]}))`);
    prev = `m${i}`;
  }
  return lets.reduceRight((body, l) => `(let (${l}) ${body})`, prev);
}

const keyOf = (neg, p, args) => `${neg ? 'n' : 'p'}|${p}|${argsKey(args)}`;
const relOf = (neg, p) => `${neg ? 'n' : 'p'}|${p}`;

export class Grounder {
  constructor(program, facts, {timeoutMs = 30000, free = false, notes = new Set()} = {}) {
    this.program = program; this.facts = facts; this.timeoutMs = timeoutMs; this.free = free; this.notes = notes;
    this.atoms = new Map(); this.rels = new Map(); this.open = []; this.next = 0; this.extraDecls = [];
  }

  atom(neg, p, args) {
    const k = keyOf(neg, p, args);
    let a = this.atoms.get(k);
    if (!a) {
      a = {key: k, neg, p, args, id: this.next++, defs: new Set(), fixed: null};
      a.v = 'a' + a.id;
      this.atoms.set(k, a);
      const r = relOf(neg, p);
      if (!this.rels.has(r)) this.rels.set(r, new Map());
      this.rels.get(r).set(argsKey(args), a);
      this.open.push(a);
    }
    return a;
  }

  find(neg, p, args) { return this.rels.get(relOf(neg, p))?.get(argsKey(args)); }
  list(neg, p) { return [...(this.rels.get(relOf(neg, p))?.values() ?? [])]; }
  lit = a => (a.fixed === true ? 'true' : a.fixed === false ? 'false' : a.v);

  /** Join an ordered body over the possible atoms; yields {env, lits} (the literals that are not constant true). */
  * walk(leaves, i, env, lits) {
    if (i === leaves.length) { yield {env, lits}; return; }
    const l = leaves[i];
    switch (l.kind) {
      case 'atom': {
        const g = groundArgs(l.args, env);
        if (l.mode === 'absent') {
          const a = this.find(false, l.p, g);
          if (!a || a.fixed === false) yield* this.walk(leaves, i + 1, env, lits);
          else if (a.fixed !== true) yield* this.walk(leaves, i + 1, env, [...lits, `(not ${a.v})`]);
          return;
        }
        const neg = l.mode === 'not';
        if (g) {
          const a = this.find(neg, l.p, g);
          if (a && a.fixed !== false) yield* this.walk(leaves, i + 1, env, a.fixed === true ? lits : [...lits, a.v]);
          return;
        }
        for (const a of this.list(neg, l.p)) {
          if (a.fixed === false) continue;
          const e2 = unify(l.args, a.args, env);
          if (e2) yield* this.walk(leaves, i + 1, e2, a.fixed === true ? lits : [...lits, a.v]);
        }
        return;
      }
      case 'compare':
        if (compareValues(l.word, termIn(l.left, env), termIn(l.right, env))) yield* this.walk(leaves, i + 1, env, lits);
        return;
      case 'compute': {
        const v = compute(l.word, termIn(l.left, env), termIn(l.right, env));
        if (v === undefined) { this.notes.add('arithmetic_undefined'); return; }
        if (l.out in env) { if (env[l.out] === v) yield* this.walk(leaves, i + 1, env, lits); return; }
        yield* this.walk(leaves, i + 1, {...env, [l.out]: v}, lits);
        return;
      }
      default: throw new NotExpressibleError([l.kind === 'timeof' ? 'time_vars' : l.kind], `${l.kind} leaves are not lowered by z3-smt-bounded`);
    }
  }

  static conj(lits) { return lits.length === 0 ? 'true' : lits.length === 1 ? lits[0] : `(and ${lits.join(' ')})`; }
  static disj(parts) { return parts.length === 0 ? 'false' : parts.length === 1 ? parts[0] : `(or ${parts.join(' ')})`; }

  /** A fixed constant true atom (a fact). */
  addFact(f) { this.atom(f.neg, f.p, f.args).fixed = true; }

  /** An atom that is true exactly when the Boolean `variable` is (a hypothesis or a candidate addition). */
  addChoice(neg, p, args, variable) {
    const a = this.atom(neg, p, args);
    if (a.fixed !== true) a.defs.add(variable);
    return a;
  }

  rule(r) {
    for (const alt of r.alts) {
      for (const {env, lits} of this.walk(alt.leaves, 0, {}, [])) {
        const a = this.atom(r.head.neg, r.head.p, groundArgs(r.head.args, env));
        if (a.fixed !== true) a.defs.add(Grounder.conj(lits));
      }
    }
  }

  run() {
    for (const f of this.facts) this.addFact(f);
    for (const st of this.program.strata) {
      if (st.recursive) throw new NotExpressibleError(['recursion'], 'completion over a cycle admits models that are not the least model (case 04b); recursion is not lowered');
      for (const r of st.rules) this.rule(r);
      for (const a of st.aggregates) this.aggregate(a);
    }
  }

  declarations() { return this.open.filter(a => a.fixed === null).map(a => `(declare-const ${a.v} Bool)`); }

  assertions() {
    return this.open.filter(a => a.fixed === null).map(a => `(assert (= ${a.v} ${Grounder.disj([...a.defs])}))`);
  }

  /** Decide everything grounded so far: the open atoms become constants (their value in the unique model). */
  stage() {
    const open = this.open.filter(a => a.fixed === null);
    this.open = [];
    if (!open.length) return;
    const text = [...this.extraDecls, ...open.map(a => `(declare-const ${a.v} Bool)`), ...open.map(a => `(assert (= ${a.v} ${Grounder.disj([...a.defs])}))`), '(check-sat)', `(get-value (${open.map(a => a.v).join(' ')}))`].join('\n') + '\n';
    const r = runZ3(text, {timeoutMs: this.timeoutMs});
    if (r.interrupted) throw new SolverStop('wall');
    if (r.results[0] !== 'sat') throw new ProgramError('no_model', `the completion of a non-recursive stratified program has a model; z3 said ${r.results[0]}`);
    const values = valuesOf(r.results[1]);
    for (const a of open) {
      a.fixed = values.get(a.v) === 'true';
      if (!a.fixed) this.rels.get(relOf(a.neg, a.p))?.delete(argsKey(a.args));
    }
  }

  evalTerms(terms) {
    if (!terms.length) return [];
    const r = runZ3(`(assert true)\n(check-sat)\n(get-value (${terms.join(' ')}))\n`, {timeoutMs: this.timeoutMs});
    if (r.interrupted) throw new SolverStop('wall');
    return [...r.results[1]].map(pair => intOf(pair[1]));
  }

  /** Terms of the Real sort (decimals): the exact rational Z3 answers, rendered as a decimal number. */
  evalReals(terms) {
    if (!terms.length) return [];
    const r = runZ3(`(assert true)\n(check-sat)\n(get-value (${terms.join(" ")}))\n`, {timeoutMs: this.timeoutMs});
    if (r.interrupted) throw new SolverStop('wall');
    return [...r.results[1]].map(pair => realOf(pair[1]).toNumber());
  }

  aggregate(agg) {
    if (!this.free) this.stage();
    const rows = new Map();
    for (const alt of agg.alts) {
      for (const {env, lits} of this.walk(alt.leaves, 0, {}, [])) {
        if (lits.length) throw new NotExpressibleError(['aggregate_open'], 'an aggregate over atoms that are still undecided (abduction) is not lowered');
        const rv = Object.fromEntries(agg.rowVars.filter(v => v in env).map(v => [v, env[v]]));
        rows.set(JSON.stringify(rv), rv);
      }
    }
    const groups = new Map();
    for (const row of rows.values()) {
      const gv = agg.group.map(v => row[v]);
      const k = argsKey(gv);
      if (!groups.has(k)) groups.set(k, {gv, rows: []});
      groups.get(k).rows.push(row);
    }
    const pending = [];
    for (const {gv, rows: members} of groups.values()) {
      const values = agg.field ? members.map(r => r[agg.field]) : [];
      const nums = values.filter(Number.isFinite);
      const real = nums.some(x => !Number.isInteger(x));
      if (agg.fn !== 'count' && nums.length !== values.length) this.notes.add('aggregate_non_integer_ignored');
      if (agg.fn !== 'count' && !nums.length) continue;
      if (!['count', 'sum', 'min', 'max'].includes(agg.fn)) throw new NotExpressibleError(['collect'], 'collect aggregates are not lowered');
      // decimals use the Real sort (exact rationals); whole numbers stay in Int
      const lit = real ? smtReal : smtInt;
      const term = agg.fn === 'count' ? `(+ ${members.map(() => '1').join(' ')})`
        : agg.fn === 'sum' ? `(+ ${real ? '0.0' : '0'} ${nums.map(lit).join(' ')})`
          : extremum(agg.fn, nums.map(lit));
      pending.push({gv, term, real: real && agg.fn !== 'count'});
    }
    const sums = pending.map(() => null);
    for (const kind of [false, true]) {
      const idx = pending.map((p, i) => i).filter(i => pending[i].real === kind);
      const got = kind ? this.evalReals(idx.map(i => pending[i].term)) : this.evalTerms(idx.map(i => pending[i].term));
      idx.forEach((i, j) => { sums[i] = got[j]; });
    }
    pending.forEach((p, i) => {
      const env = {...Object.fromEntries(agg.group.map((v, j) => [v, p.gv[j]])), [agg.out]: sums[i]};
      const args = groundArgs(agg.yields.args, env);
      if (!args) throw new ProgramError('unsafe_head', `the yields of ${agg.id} uses a variable that is neither grouped nor the output`, agg.id);
      this.atom(false, agg.yields.p, args).fixed = true;
    });
  }

  /** The disjunction, over the alternatives of a goal, of the conjunction of the literals of each instance. */
  goalFormula(alts) {
    const parts = [];
    for (const alt of alts) for (const {lits} of this.walk(alt.leaves ?? alt, 0, {}, [])) parts.push(Grounder.conj(lits));
    return [...new Set(parts)].length ? Grounder.disj([...new Set(parts)]) : 'false';
  }

  trueAtoms() { return [...this.atoms.values()].filter(a => a.fixed === true).map(a => ({neg: a.neg, p: a.p, args: a.args})); }
}
