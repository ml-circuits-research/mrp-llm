/**
 * FOL (the LFM's output, parsed by ./parse.mjs) → SOP-IR, deterministically (owner decision 2026-10-03: the models write what they
 * were built for; WE translate). The IR is what SOP Lang can execute: ground facts, rules with conditions that are literals,
 * comparisons and closed-world negations, named numeric values (also defined by rules), numeric constraints over unknowns, and queries.
 * What has no sound reading is rejected with a reason, never approximated (owner, 2026-10-03: repair the FOL path; a wrong circuit is
 * worse than an honest unknown).
 *
 * Statements (classical clausification, structural)
 *   A ∧ B                     both, separately
 *   ∀x̄ (B → H)                one rule per head literal and per disjunct of B (B in disjunctive normal form; an existential in B
 *                             is a rule variable, renamed apart)
 *   heads                     a conjunction (one rule each); a nested implication (curried into the body); a universal (lifted);
 *                             A ↔ B (both directions); a disjunction L1 ∨ … ∨ Ln of literals: one rule per Li whose extra conditions
 *                             are the EXPLICIT negations of the other disjuncts (modus tollendo ponens; sound), and the predicates of
 *                             the Li become open (the closed world must not refute them); A ⊕ B (the disjunction plus A → ¬B and
 *                             B → ¬A); ¬(…) pushed inward; an existential ∃y φ under a universal (no Skolem function in a function-free
 *                             language): the conjuncts of φ without y are kept and the predicates of the dropped ones become open; a
 *                             comparison C: its contrapositive (¬C and the other conditions → the explicit negation of the last literal)
 *   conditions                literals (a negated one is a closed-world negation, `absent`); comparisons; Value(q, t) (binds a variable
 *                             or tests a value); ∀z φ and ¬(compound): an auxiliary predicate aux(x̄) := ¬φ (resp. the compound), the
 *                             condition being `absent aux(x̄)`, its variables bound by the rule's other conditions or by the problem's
 *                             own domain (the things it names: the problem is its own closed world); A → B as ¬A ∨ B; A ↔ B by cases
 *   ¬∃x̄ (L1 ∧ … ∧ Ln)          the constraint L1 ∧ … ∧ Ln-1 → ¬Ln (one literal: the domain → ¬L1)
 *   ∃x̄ φ (outside any ∀)      φ with a fresh constant per variable (Skolem constant `sk1`, …)
 *   a ground literal          a fact; a literal with variables and no condition is rejected (an unrestricted universal)
 *   an unsafe rule (a head or negated variable no positive condition binds) is rejected
 *   a free one-letter variable (no quantifier) in a statement that is purely numeric (Value, comparisons, Integer, Ask) is the
 *   quantity of that name ("x must be at least 81")
 *
 * The agreed extension (only where FOL cannot say it; §5 of the proposal), by exact reserved names:
 *   Value(q, t)        the quantity q is the term t; t: a number, another quantity, or add/sub/mul/div/mod/pow/min/max/ceil/floor/
 *                      round/abs of terms. As the conclusion of a rule it defines q under the rule's conditions (a value rule); as
 *                      a condition it binds a variable to q or tests q. A non-numeric constant as t is a named choice (a fact).
 *   Lt/Le/Gt/Ge/Eq/Ne(a, b)  a comparison of numeric terms; stated, it is a condition of the problem: when it involves a quantity no
 *                      Value defines (an unknown), the problem is a constraint search solved by the constraint engine
 *   Integer(q)         the unknown q is a whole number (the domain of a constraint search)
 *   Maximize(t), Minimize(t)   the objective of a constraint search
 *   Ask(q)             (in a question) the value of q is asked
 *   Before(a, b), After(a, b)   order of events: ordinary facts, with transitivity and After(a, b) ≡ Before(b, a) added by ./to-sop.mjs
 * Questions (an input unit that ends with `?`, structure): a ground literal → yes/no; a conjunction of ground literals → yes/no;
 * ∃x (φ) → which x (alternatives allowed); ¬∃x φ → yes/no "is there none"; ∀x (A → B) → universal over the known members of A;
 * Ask / comparisons (and their conjunctions) → value and compare; anything else is rejected as a question.
 * fol-v3 (2026-10-03; the line forms of ./parse.mjs): `SUPPOSE id: φ` is an option (`ir.options`: {id, part, kind fact|rule, fact|rule,
 * source}; one candidate per fact or rule φ yields, several under one label; never a fact of the problem); `ASSUME φ` an assumption
 * of the formalizer (`ir.assumed`: {kind, fact|rule, source}); Effect, Explain, Missing, Why and Change over a claim are queries
 * {kind, claim: [literals], given?} (a claim is a ground literal, a conjunction of them, or a rule ∀x̄ (A → B) asked of an arbitrary
 * instance: the constants `arb<n>` for x̄, A `given`, B the claim); `Assumed` is the query {kind: 'assumed'}. ./to-sop.mjs lowers them.
 */
export const ARITH = Object.freeze({add: '+', sub: '-', mul: '*', div: '/', mod: '%'});
export const MATH = Object.freeze(['min', 'max', 'ceil', 'floor', 'round', 'abs', 'pow']);
export const COMPARE = Object.freeze({Lt: '<', Le: '<=', Gt: '>', Ge: '>=', Eq: '==', Ne: '!='});
export const NEGATE = Object.freeze({Lt: 'Ge', Le: 'Gt', Gt: 'Le', Ge: 'Lt', Eq: 'Ne', Ne: 'Eq'});
export const RESERVED = Object.freeze({value: 'Value', ask: 'Ask', before: 'Before', after: 'After', integer: 'Integer', maximize: 'Maximize', minimize: 'Minimize'});
/** The domain predicate: the things the problem names (its own closed world). */
export const DOMAIN = '__thing';
const NUMERIC = new Set([...Object.keys(COMPARE), RESERVED.value, RESERVED.ask, RESERVED.integer, RESERVED.maximize, RESERVED.minimize]);

class Reject extends Error {}
const no = why => { throw new Reject(why); };
const isLit = n => n.type === 'atom' || (n.type === 'not' && n.a.type === 'atom');
const isCompare = a => a.type === 'atom' && Object.hasOwn(COMPARE, a.pred) && a.args.length === 2;
const termVars = t => (t.var ? [t.var] : t.fn ? t.args.flatMap(termVars) : []);
export const varsOf = l => (l.args ?? []).flatMap(termVars);
const itemVars = c => (c.cmp ? [...termVars(c.a), ...termVars(c.b)] : c.value ? termVars(c.term) : varsOf(c));
const and = (a, b) => (!a ? b : !b ? a : {type: 'and', a, b});
const not = a => ({type: 'not', a});
const strong = a => ({type: 'strong', a});
const hasFn = l => l.args.some(t => t.fn);

function substitute(node, v, term) {
  const t = x => (x.var === v ? term : x.fn ? {fn: x.fn, args: x.args.map(t)} : x);
  switch (node.type) {
    case 'atom': return {...node, args: node.args.map(t)};
    case 'not': case 'strong': return {type: node.type, a: substitute(node.a, v, term)};
    case 'forall': case 'exists': return node.v === v ? node : {...node, a: substitute(node.a, v, term)};
    default: return {type: node.type, a: substitute(node.a, v, term), b: substitute(node.b, v, term)};
  }
}

function freeVars(node, bound = new Set(), out = new Set()) {
  switch (node.type) {
    case 'atom': for (const v of varsOf(node)) if (!bound.has(v)) out.add(v); return out;
    case 'not': case 'strong': return freeVars(node.a, bound, out);
    case 'forall': case 'exists': return freeVars(node.a, new Set([...bound, node.v]), out);
    case 'domain': for (const v of node.vars) if (!bound.has(v)) out.add(v); return out;
    default: freeVars(node.a, bound, out); return freeVars(node.b, bound, out);
  }
}

const predsOf = (node, out = new Set()) => {
  if (!node) return out;
  if (node.type === 'atom') { if (!NUMERIC.has(node.pred)) out.add(node.pred); return out; }
  if (node.a) predsOf(node.a, out);
  if (node.b) predsOf(node.b, out);
  return out;
};

/** Every atom of a numeric-only formula is a reserved numeric predicate. */
const numericOnly = n => (n.type === 'atom' ? NUMERIC.has(n.pred) : n.type === 'not' || n.type === 'forall' || n.type === 'exists' ? numericOnly(n.a) : numericOnly(n.a) && numericOnly(n.b));

/** A free one-letter variable of a purely numeric formula is a quantity name ("x must be at least 81"). */
function quantityNames(n) {
  while (n.type === 'forall' && n.implicit && numericOnly(n.a)) n = substitute(n.a, n.v, {const: n.v});
  return n;
}

/** A literal (positive, negated, or explicitly negated) as an IR literal; a comparison or a Value as a condition item. */
function item(n) {
  const neg = n.type === 'not' || n.type === 'strong', a = neg ? n.a : n;
  if (isCompare(a)) return {cmp: neg ? NEGATE[a.pred] : a.pred, a: a.args[0], b: a.args[1]};
  if (a.pred === RESERVED.value && a.args.length === 2) return neg ? {cmp: 'Ne', a: a.args[0], b: a.args[1]} : {value: a.args[0], term: a.args[1]};
  if (NUMERIC.has(a.pred)) no(`${a.pred} is not a condition`);
  if (hasFn(a)) no('a function term in a logic literal');
  return {pred: a.pred, args: a.args, negated: neg, ...(n.type === 'strong' ? {strong: true} : {})};
}

class Converter {
  constructor() {
    this.ir = {facts: [], rules: [], values: [], valueRules: [], constraints: [], integer: [], objectives: [], open: [], queries: [], rejected: [], notes: [], options: [], assumed: []};
    this.skolem = 0; this.fresh = 0; this.aux = 0; this.usesDomain = false;
  }

  /** Disjunctive normal form of a condition: [[item | {pending: formula}]] (a pending item becomes `absent aux` at rule time). */
  dnf(n) {
    switch (n.type) {
      case 'atom': if (n.pred === RESERVED.integer) return [[]]; return [[item(n)]];
      case 'strong': return [[item(n)]];
      case 'domain': return [[{domainMark: true}]];
      case 'and': { const out = []; for (const x of this.dnf(n.a)) for (const y of this.dnf(n.b)) out.push([...x, ...y]); if (out.length > 16) no('the condition has too many cases'); return out; }
      case 'or': return [...this.dnf(n.a), ...this.dnf(n.b)];
      case 'xor': return this.dnf({type: 'or', a: and(n.a, not(n.b)), b: and(not(n.a), n.b)});
      case 'implies': return this.dnf({type: 'or', a: not(n.a), b: n.b});
      case 'iff': return this.dnf({type: 'or', a: and(n.a, n.b), b: and(not(n.a), not(n.b))});
      case 'exists': { const v = `${n.v}_${++this.fresh}`; return this.dnf(substitute(n.a, n.v, {var: v})); }
      case 'forall': return [[{pending: {type: 'exists', v: n.v, a: not(n.a)}}]];
      case 'not': {
        const a = n.a;
        if (a.type === 'atom') return [[item(n)]];
        if (a.type === 'not') return this.dnf(a.a);
        if (a.type === 'or') return this.dnf(and(not(a.a), not(a.b)));
        if (a.type === 'implies') return this.dnf(and(a.a, not(a.b)));
        if (a.type === 'forall') return this.dnf({type: 'exists', v: a.v, a: not(a.a)});
        return [[{pending: a}]];
      }
      default: return no(`a condition with ${n.type.toUpperCase()} has no reading`);
    }
  }

  /** A rule from one DNF branch and a head: pending negations become auxiliary predicates; safety is checked. */
  makeRule(branch, head, {domain = false} = {}) {
    const when = [], pending = [];
    for (const c of branch) { if (c.domainMark) domain = true; else (c.pending ? pending : when).push(c); }
    const positives = () => when.filter(c => c.pred && !c.negated);
    const bound = () => new Set([...positives().flatMap(varsOf), ...when.filter(c => c.value && c.term.var).map(c => c.term.var)]);
    for (const p of pending) {
      const fv = [...freeVars(p.pending)];
      const id = `__aux${++this.aux}`;
      // The auxiliary's own rules: its conditions, plus the outer conditions that bind its variables.
      const binders = positives().filter(c => varsOf(c).some(v => fv.includes(v)));
      for (const b of this.dnf(p.pending)) this.makeRule([...binders, ...b], {pred: id, args: fv.map(v => ({var: v})), negated: false}, {domain: true});
      when.push({pred: id, args: fv.map(v => ({var: v})), negated: true});
    }
    const needed = h => [...(h.value ? termVars(h.term) : varsOf(h)), ...when.filter(c => c.negated || c.cmp || (c.value && !c.term.var)).flatMap(itemVars)];
    let loose = [...new Set(needed(head))].filter(v => !bound().has(v));
    if (loose.length && (domain || pending.length || head.domain)) {
      for (const v of loose) when.unshift({pred: DOMAIN, args: [{var: v}], negated: false});
      this.usesDomain = true;
      loose = [];
    }
    if (loose.length) no(`unsafe rule: variable ${loose[0]} is bound by no positive condition`);
    if (!when.length) no('a rule without a condition');
    if (head.value) this.ir.valueRules.push({name: head.value, term: head.term, when});
    else this.ir.rules.push({when, then: {pred: head.pred, args: head.args, negated: head.negated}});
  }

  /** Rules for `body → head` (body a formula or null). */
  clauses(body, head) {
    const make = h => { for (const b of body ? this.dnf(body) : [[]]) this.makeRule(b, h); };
    switch (head.type) {
      case 'atom': case 'not': case 'strong': {
        const neg = head.type !== 'atom', a = neg ? head.a : head;
        if (a.type !== 'atom') return this.clauses(body, this.pushNot(a));
        if (isCompare(a)) return this.contrapositive(body, neg ? {cmp: NEGATE[a.pred], a: a.args[0], b: a.args[1]} : {cmp: a.pred, a: a.args[0], b: a.args[1]});
        if (a.pred === RESERVED.value && !neg) {
          if (a.args.length !== 2 || !a.args[0].const) no('Value needs a quantity name and a term');
          // Conditions that only bind variables to quantities (FORALLx (Value(q, x) → Value(r, f(x)))) define r unconditionally.
          const branches = body ? this.dnf(body) : [[]];
          if (branches.length === 1 && branches[0].every(c => c.value && c.term.var && c.value.const)) {
            let t = a.args[1];
            for (const c of branches[0]) t = substituteTerm(t, c.term.var, c.value);
            this.ir.values.push({name: a.args[0].const, term: t});
            return;
          }
          return make({value: a.args[0].const, term: a.args[1]});
        }
        // Integer(x) concluded about a thing restates a type; it has nothing to derive.
        if (a.pred === RESERVED.integer && !neg) { this.ir.notes.push({why: 'Integer as a conclusion is a type, not a fact'}); return; }
        if (NUMERIC.has(a.pred)) no(`${a.pred} is not a conclusion`);
        if (hasFn(a)) no('a function term in a logic literal');
        return make({pred: a.pred, args: a.args, negated: neg});
      }
      case 'and': this.clauses(body, head.a); this.clauses(body, head.b); return;
      case 'implies': return this.clauses(and(body, head.a), head.b);
      case 'forall': return this.clauses(body, head.a);
      case 'iff': this.clauses(and(body, head.a), head.b); this.clauses(and(body, head.b), head.a); return;
      case 'or': case 'xor': {
        const ds = [];
        const flat = n => (n.type === 'or' ? (flat(n.a), flat(n.b)) : ds.push(n));
        flat(head.type === 'xor' ? {type: 'or', a: head.a, b: head.b} : head);
        if (!ds.every(d => isLit(d) && !NUMERIC.has((d.a ?? d).pred))) no('a conclusion with OR of compound formulas has no reading');
        // One rule per disjunct: the other disjuncts explicitly false (classical, so sound); the disjuncts are open predicates.
        ds.forEach((d, i) => this.clauses(ds.filter((_, j) => j !== i).map(o => (o.type === 'not' ? o.a : strong(o))).reduce((x, y) => and(x, y), body), d));
        for (const d of ds) this.open(d.a ?? d);
        if (head.type === 'xor') { this.clauses(and(body, head.a), not(head.b)); this.clauses(and(body, head.b), not(head.a)); }
        return;
      }
      case 'exists': {
        // No Skolem function: keep what does not mention the new thing; what does mention it is unknown (open), never refuted.
        let f = head;
        const vs = [];
        while (f.type === 'exists') { vs.push(f.v); f = f.a; }
        const parts = [];
        const flat = n => (n.type === 'and' ? (flat(n.a), flat(n.b)) : parts.push(n));
        flat(f);
        const kept = parts.filter(p => ![...freeVars(p)].some(v => vs.includes(v)));
        for (const p of parts.filter(x => !kept.includes(x))) for (const pred of predsOf(p)) this.ir.open.push(pred);
        if (!kept.length) no('a conclusion with an existential and no part without it (needs a Skolem function)');
        this.ir.notes.push({why: 'an existential conclusion: only its part without the new thing is used'});
        for (const k of kept) this.clauses(body, k);
        return;
      }
      default: return no(`a conclusion with ${head.type.toUpperCase()} has no reading`);
    }
  }

  /** ¬(compound) as a conclusion, pushed inward. */
  pushNot(a) {
    switch (a.type) {
      case 'and': return {type: 'or', a: not(a.a), b: not(a.b)};
      case 'or': return and(not(a.a), not(a.b));
      case 'not': return a.a;
      case 'implies': return and(a.a, not(a.b));
      case 'forall': return {type: 'exists', v: a.v, a: not(a.a)};
      case 'exists': {
        // ¬∃x̄ (L1 ∧ … ∧ Ln): L1 ∧ … ∧ Ln-1 → ¬Ln.
        let b = a;
        while (b.type === 'exists') b = b.a;
        const parts = [];
        const flat = n => (n.type === 'and' ? (flat(n.a), flat(n.b)) : parts.push(n));
        flat(b);
        if (!parts.every(isLit)) no('a negated existential that is not a conjunction of literals');
        const last = parts.at(-1);
        return {type: 'implies', a: parts.slice(0, -1).reduce((x, y) => and(x, y), null) ?? {type: 'domain', vars: varsOf(last.a ?? last)}, b: last.type === 'not' ? last.a : not(last)};
      }
      default: return no(`NOT over ${a.type.toUpperCase()} has no reading`);
    }
  }

  /** B → C with C a comparison: ¬C ∧ (B without its last literal) → ¬(last literal); C alone is a condition of the problem. */
  contrapositive(body, c) {
    if (!body) { this.ir.constraints.push(c); return; }
    for (const b of this.dnf(body)) {
      const k = b.findLastIndex(x => x.pred && !x.negated);
      if (k < 0) no('a comparison concluded from comparisons only has no reading');
      const last = b[k];
      this.makeRule([...b.filter((_, j) => j !== k), {cmp: NEGATE[c.cmp], a: c.a, b: c.b}], {pred: last.pred, args: last.args, negated: !last.negated});
    }
  }

  open(atom) { this.ir.open.push(atom.pred); }

  /** One formula (an AST of a statement). */
  statement(n, univ = false) {
    n = quantityNames(n);
    switch (n.type) {
      case 'forall': return this.statement(n.a, true);
      case 'exists':
        if (univ) return this.clauses(null, n);
        return this.statement(substitute(n.a, n.v, {const: `sk${++this.skolem}`}), univ);
      case 'and': this.statement(n.a, univ); this.statement(n.b, univ); return;
      case 'implies': return this.clauses(n.a, n.b);
      case 'iff': this.clauses(n.a, n.b); this.clauses(n.b, n.a); return;
      case 'or': case 'xor': return this.clauses(null, n);
      case 'not':
        if (n.a.type === 'not') return this.statement(n.a.a, univ);
        if (n.a.type !== 'atom') {
          const p = this.pushNot(n.a);
          if (p.type === 'implies' && p.a.type === 'domain') {
            // ¬∃x P(x): every thing of the problem is explicitly not P.
            const lit = p.b.type === 'not' ? p.b.a : p.b;
            if (hasFn(lit)) no('a function term in a logic literal');
            return this.makeRule([], {pred: lit.pred, args: lit.args, negated: p.b.type === 'not', domain: true});
          }
          return !univ && ['and', 'exists'].includes(p.type) ? this.statement(p, univ) : this.clauses(null, p);
        }
      // falls through: a negated atom
      case 'atom': {
        const neg = n.type === 'not', a = neg ? n.a : n;
        if (isCompare(a) && varsOf(a).length) no('a comparison about every thing without a condition');
        if (isCompare(a)) { this.ir.constraints.push({cmp: neg ? NEGATE[a.pred] : a.pred, a: a.args[0], b: a.args[1]}); return; }
        if (a.pred === RESERVED.value && !neg) {
          if (a.args.length !== 2 || !a.args[0].const) no('Value needs a quantity name and a term');
          if (termVars(a.args[1]).length) no('a Value with a variable and no condition');
          // Value(q, q) only names q as an unknown.
          if (a.args[1].const !== a.args[0].const) this.ir.values.push({name: a.args[0].const, term: a.args[1]});
          return;
        }
        if (a.pred === RESERVED.integer && !neg) { if (a.args.length !== 1 || !a.args[0].const) no('Integer needs a quantity name'); this.ir.integer.push(a.args[0].const); return; }
        if ((a.pred === RESERVED.maximize || a.pred === RESERVED.minimize) && !neg) { if (a.args.length !== 1) no(`${a.pred} needs one term`); this.ir.objectives.push({direction: a.pred === RESERVED.maximize ? 'max' : 'min', term: a.args[0]}); return; }
        if (NUMERIC.has(a.pred)) no(`${a.pred} is not a statement`);
        if (varsOf(a).length) no('a statement about every thing without a condition');
        if (hasFn(a)) no('a function term in a logic literal');
        this.ir.facts.push({pred: a.pred, args: a.args, negated: neg});
        return;
      }
      default: return no(`${n.type.toUpperCase()} at the top of a statement has no reading`);
    }
  }

  /** A question formula → a query. */
  question(n) {
    let f = quantityNames(n);
    const numericTree = x => (isCompare(x) ? {cmp: x.pred, a: x.args[0], b: x.args[1]} : x.type === 'not' && isCompare(x.a) ? {cmp: NEGATE[x.a.pred], a: x.a.args[0], b: x.a.args[1]}
      : (x.type === 'and' || x.type === 'or') && numericOnly(x) ? {op: x.type, a: numericTree(x.a), b: numericTree(x.b)} : no('a question mixing comparisons and other formulas'));
    // A conjunction of asked values is several value questions.
    const conj = [];
    const flatAnd = x => (x.type === 'and' ? (flatAnd(x.a), flatAnd(x.b)) : conj.push(x));
    flatAnd(f);
    if (conj.length > 1 && conj.every(x => x.type === 'atom' && x.pred === RESERVED.ask && x.args.length === 1 && x.args[0].const)) return conj.map(x => ({kind: 'value', name: x.args[0].const}));
    // An objective written as a question is the problem's objective (the asked value is asked apart).
    if (f.type === 'atom' && (f.pred === RESERVED.maximize || f.pred === RESERVED.minimize)) { this.statement(f); return []; }
    if (isLit(f)) {
      const a = f.a ?? f;
      if (a.pred === RESERVED.ask && a.args.length === 1 && a.args[0].const && f.type === 'atom') return {kind: 'value', name: a.args[0].const};
      if (isCompare(a)) return {kind: 'compare', test: numericTree(f)};
      if (NUMERIC.has(a.pred)) no(`${a.pred} is not a question`);
      if (varsOf(a).length) no('a yes/no question about a literal with variables');
      if (hasFn(a)) no('a function term in a logic literal');
      return {kind: 'yesno', lit: item(f)};
    }
    if ((f.type === 'and' || f.type === 'or') && numericOnly(f)) return {kind: 'compare', test: numericTree(f)};
    if (f.type === 'and') {
      const parts = [];
      const flat = x => (x.type === 'and' ? (flat(x.a), flat(x.b)) : parts.push(x));
      flat(f);
      if (!parts.every(p => isLit(p) && !NUMERIC.has((p.a ?? p).pred) && !varsOf(p.a ?? p).length)) no('a question that is a conjunction of formulas other than ground literals');
      return {kind: 'yesno', lit: item(parts[0]), also: parts.slice(1).map(item)};
    }
    if (f.type === 'exists' || (f.type === 'not' && f.a.type === 'exists')) {
      const none = f.type === 'not';
      if (none) f = f.a;
      const vs = [];
      while (f.type === 'exists') { vs.push(f.v); f = f.a; }
      // Pending negations become auxiliary rules now (the question's own rule is built by ./to-sop.mjs).
      const alts = this.dnf(f).map(b => this.materialize(b));
      // The asked thing, and every variable of a negation or a comparison, must be bound: else by the problem's domain.
      for (const alt of alts) {
        const bound = new Set([...alt.filter(c => c.pred && !c.negated).flatMap(varsOf), ...alt.filter(c => c.value && c.term.var).map(c => c.term.var)]);
        const loose = [...new Set([vs[0], ...alt.filter(c => c.negated || c.cmp || (c.value && !c.term.var)).flatMap(itemVars)])].filter(v => !bound.has(v));
        for (const v of loose) alt.unshift({pred: DOMAIN, args: [{var: v}], negated: false});
        if (loose.length) this.usesDomain = true;
      }
      return {kind: none ? 'none' : 'which', v: vs[0], alts};
    }
    if (f.type === 'forall') {
      while (f.type === 'forall') f = f.a;
      // FORALLx (C(x) IMPLIES Ask(x)): "find x such that C": x is an unknown of the problem, C its conditions.
      if (f.type === 'implies' && f.b.type === 'atom' && f.b.pred === RESERVED.ask && f.b.args.length === 1 && f.b.args[0].var) {
        const name = `${f.b.args[0].var}_asked${++this.fresh}`;
        const cond = substitute(f.a, f.b.args[0].var, {const: name});
        if (!numericOnly(cond) || freeVars(cond).size) no('the conditions of an asked unknown are not comparisons of quantities');
        this.statement(cond);
        return {kind: 'value', name};
      }
      if (f.type !== 'implies') no('a universal question that is not of the form FORALLx (A IMPLIES B)');
      const where = this.dnf(f.a), scope = this.dnf(f.b);
      if (where.length !== 1 || scope.length !== 1) no('a universal question with alternatives');
      const plain = b => b.every(c => c.pred && !c.pending && !c.strong && !String(c.pred).startsWith("__aux"));
      if (!plain(where[0]) || !plain(scope[0])) no('a universal question whose parts are not literals');
      return {kind: 'every', where: where[0], scope: scope[0]};
    }
    return no(`a question of the form ${f.type.toUpperCase()} is not a query`);
  }

  /**
   * SUPPOSE id: φ (an option) and ASSUME φ (an assumption): φ is converted like a statement, and what it yields is taken out of the
   * problem's facts and rules. An option is exactly one fact or one rule (its auxiliary rules stay as definitions); an assumption is any
   * number of facts and rules. Numbers are neither (a Value, a comparison, an objective).
   */
  hypothetical(n, source) {
    const before = Object.fromEntries(Object.entries(this.ir).map(([k, v]) => [k, v.length]));
    this.statement(n.a);
    for (const k of ['values', 'valueRules', 'constraints', 'integer', 'objectives', 'queries']) if (this.ir[k].length !== before[k]) no(`${n.type === 'suppose' ? 'an option' : 'an assumption'} is a fact or a rule, not a number`);
    const facts = this.ir.facts.splice(before.facts);
    const added = this.ir.rules.splice(before.rules);
    // Auxiliary predicates (universal and negated conditions) are definitions the option's rule reads: they stay in force.
    const aux = added.filter(r => /^__aux\d+$/.test(r.then.pred)), rules = added.filter(r => !aux.includes(r));
    this.ir.rules.push(...aux);
    if (n.type === 'assume') {
      for (const fact of facts) this.ir.assumed.push({kind: 'fact', fact, source});
      for (const rule of rules) this.ir.assumed.push({kind: 'rule', rule, source});
      return;
    }
    if (!facts.length && !rules.length) no(`SUPPOSE ${n.id} states nothing`);
    // An option of several facts or rules (a conjunction, an IFF, several SUPPOSE lines with one label) is several candidates under
    // one label: each is tried on its own.
    const parts = [...facts.map(fact => ({kind: 'fact', fact})), ...rules.map(rule => ({kind: 'rule', rule}))];
    const same = this.ir.options.filter(o => o.id === n.id);
    if (same.length === 1 && !same[0].part) same[0].part = 1;
    parts.forEach((x, i) => this.ir.options.push({id: n.id, part: same.length || parts.length > 1 ? same.length + i + 1 : null, ...x, source}));
  }

  /** A question about support (Effect, Explain, Missing, Why, Change) over a ground claim, or about the assumptions (Assumed). */
  meta(n) {
    if (n.kind === 'assumed') return {kind: 'assumed'};
    const lits = f => {
      const out = [];
      const flat = x => (x.type === 'and' ? (flat(x.a), flat(x.b)) : out.push(x));
      flat(f);
      return out;
    };
    // A rule as the claim (FORALLx (A(x) IMPLIES B(x)): "is the direction forced", "does every A follow to be B") is asked of an
    // arbitrary instance: a new thing `arb<n>` of which only A is given; the claim is B of it (the deduction theorem; ./to-sop.mjs
    // withholds the answer when a rule it rests on reads an absence, which an arbitrary instance cannot vouch for).
    let f = quantityNames(n.a), given = [];
    const vs = [];
    while (f.type === 'forall') { vs.push(f.v); f = f.a; }
    if (f.type === 'implies') {
      if (!vs.length && freeVars(f).size) no(`the claim of ${n.kind} has variables (it must be ground)`);
      for (const v of vs) f = substitute(f, v, {const: `arb${++this.fresh}`});
      given = lits(f.a);
      if (!given.every(x => isLit(x) && !NUMERIC.has((x.a ?? x).pred) && !hasFn(x.a ?? x) && !varsOf(x.a ?? x).length)) no(`the condition of the rule asked by ${n.kind} is not a conjunction of facts`);
      f = f.b;
    } else if (vs.length) no(`the claim of ${n.kind} has variables (it must be ground)`);
    const parts = lits(f);
    for (const p of parts) {
      if (!isLit(p)) no(`the claim of ${n.kind} is a fact or a conjunction of facts`);
      const a = p.a ?? p;
      if (NUMERIC.has(a.pred)) no(`the claim of ${n.kind} is a fact, not ${a.pred}`);
      if (varsOf(a).length) no(`the claim of ${n.kind} has variables (it must be ground)`);
      if (hasFn(a)) no('a function term in a logic literal');
    }
    return {kind: n.kind, claim: parts.map(item), ...(given.length ? {given: given.map(item)} : {})};
  }

  /** A condition branch of a question with its pending negations turned into auxiliary rules. */
  materialize(branch) {
    const out = [];
    for (const c of branch) {
      if (!c.pending) { out.push(c); continue; }
      const fv = [...freeVars(c.pending)], id = `__aux${++this.aux}`;
      const binders = branch.filter(x => x.pred && !x.negated && varsOf(x).some(v => fv.includes(v)));
      for (const b of this.dnf(c.pending)) this.makeRule([...binders, ...b], {pred: id, args: fv.map(v => ({var: v})), negated: false}, {domain: true});
      out.push({pred: id, args: fv.map(v => ({var: v})), negated: true});
    }
    return out;
  }
}

const substituteTerm = (t, v, by) => (t.var === v ? by : t.fn ? {fn: t.fn, args: t.args.map(x => substituteTerm(x, v, by))} : t);

/**
 * Units [{ast, question, source}] → SOP-IR {facts, rules, values, valueRules, constraints, integer, objectives, open, queries,
 * rejected: [{source, why, preds}], notes, skolem, domain}. Every unit is converted on its own; a rejected unit is reported (with the
 * predicates it mentions, so the closed world is not trusted about them) and the rest is kept.
 */
export function folToIr(units) {
  const c = new Converter();
  for (const u of units) {
    const snapshot = Object.fromEntries(Object.entries(c.ir).map(([k, v]) => [k, v.length]));
    try {
      // A formula that did not parse: its predicates (the names written before a parenthesis) are not trusted by the closed world.
      if (u.unparsed !== undefined) no(`not parsed: ${String(u.unparsed).slice(0, 80)}`);
      if (u.ast.type === 'suppose' || u.ast.type === 'assume') {
        if (u.question) no(`${u.ast.type.toUpperCase()} is not a question`);
        c.hypothetical(u.ast, u.source);
      } else if (u.ast.type === 'meta') c.ir.queries.push({...c.meta(u.ast), source: u.source});
      else if (u.question) c.ir.queries.push(...[].concat(c.question(u.ast)).map(q => ({...q, source: u.source})));
      else c.statement(u.ast);
    } catch (error) {
      if (!(error instanceof Reject)) throw error;
      // A unit is converted whole or not at all.
      for (const [k, n] of Object.entries(snapshot)) c.ir[k].length = n;
      const preds = u.ast ? [...predsOf(u.ast)] : [...String(u.unparsed).matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map(m => m[1]).filter(x => !NUMERIC.has(x));
      c.ir.rejected.push({source: u.source, why: error.message, preds, question: Boolean(u.question)});
    }
  }
  c.ir.skolem = c.skolem;
  c.ir.domain = c.usesDomain;
  c.ir.open = [...new Set(c.ir.open)];
  return c.ir;
}
