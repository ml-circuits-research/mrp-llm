/**
 * Column types for the Soufflé lowering. Soufflé is typed (`symbol`, `number`); the circuits are not, so the type of every
 * relation column is inferred from the constants of the facts and rules, from arithmetic and from the variables that link columns
 * (union-find over relation columns and rule variables). A column that would have to be both a number and a symbol, or an ordering
 * comparison over symbols (Soufflé orders symbols lexically, the oracle does not order text), makes the program `not_expressible`.
 *
 * Soufflé's `number` is 32-bit signed here (the private build has a 32-bit RamDomain): an integer outside that range is refused,
 * and arithmetic is guarded against overflow by the lowering (see lower.mjs).
 */
import {isVarTerm} from '../js-reference/values.mjs';
import {NotExpressibleError} from '../js-reference/values.mjs';

export const INT_MIN = -(2 ** 31), INT_MAX = 2 ** 31 - 1;

class Classes {
  constructor() { this.parent = new Map(); this.kind = new Map(); }

  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r);
    for (let c = x; c !== r;) { const n = this.parent.get(c); this.parent.set(c, r); c = n; }
    return r;
  }

  mark(x, kind) {
    const r = this.find(x);
    const old = this.kind.get(r);
    if (old && old !== kind) throw new NotExpressibleError(['mixed_types'], 'a column or variable holds both numbers and text: not expressible in Soufflé');
    this.kind.set(r, kind);
  }

  union(a, b) {
    const ra = this.find(a), rb = this.find(b);
    if (ra === rb) return;
    const ka = this.kind.get(ra), kb = this.kind.get(rb);
    if (ka && kb && ka !== kb) throw new NotExpressibleError(['mixed_types'], 'a column or variable holds both numbers and text: not expressible in Soufflé');
    this.parent.set(ra, rb);
    if (ka && !kb) this.kind.set(rb, ka);
  }

  typeOf(x) { return this.kind.get(this.find(x)) ?? 'symbol'; }
}

const colKey = (p, i) => `col|${p}|${i}`;

/**
 * Infer the types of a lowered unit. `atoms` is a list of {p, args, scope} with the scope naming the rule, aggregate or query part
 * that owns the variables; `constraints` are {kind, scope, ...} for compare, compute and aggregates.
 * Returns {arity: Map(p -> n), typeOfColumn(p, i), typeOfVar(scope, v)}.
 */
export function inferTypes({atoms, constraints}) {
  const cl = new Classes();
  const arity = new Map();
  const termNode = (scope, t) => (isVarTerm(t) ? `var|${scope}|${t.var}` : null);
  const bind = (node, t) => {
    if (typeof t === 'number') {
      if (!Number.isSafeInteger(t) || t < INT_MIN || t > INT_MAX) throw new NotExpressibleError(['integer_range'], `integer ${t} is outside the 32-bit range of the Soufflé build`);
      cl.mark(node, 'number');
    } else cl.mark(node, 'symbol');
  };
  for (const a of atoms) {
    if (arity.has(a.p) && arity.get(a.p) !== a.args.length) throw new NotExpressibleError(['arity_clash'], `predicate ${a.p} is used with two arities`);
    arity.set(a.p, a.args.length);
    a.args.forEach((t, i) => {
      const c = colKey(a.p, i);
      cl.find(c);
      if (isVarTerm(t)) cl.union(c, termNode(a.scope, t)); else bind(c, t);
    });
  }
  const operand = (scope, t) => {
    if (isVarTerm(t)) return termNode(scope, t);
    const n = `const|${scope}|${Math.random()}`;
    bind(n, t);
    return n;
  };
  for (const c of constraints) {
    if (c.kind === 'compare') {
      const l = operand(c.scope, c.left), r = operand(c.scope, c.right);
      cl.union(l, r);
      if (!['equal', 'not_equal'].includes(c.word)) cl.mark(l, 'number');
    } else if (c.kind === 'compute') {
      const out = `var|${c.scope}|${c.out}`;
      cl.mark(out, 'number');
      cl.mark(operand(c.scope, c.left), 'number');
      cl.mark(operand(c.scope, c.right), 'number');
    } else if (c.kind === 'aggregate') {
      cl.mark(`var|${c.scope}|${c.out}`, 'number');
      if (c.field) cl.mark(`var|${c.scope}|${c.field}`, 'number');
    }
  }
  return {
    arity,
    typeOfColumn: (p, i) => cl.typeOf(colKey(p, i)),
    typeOfVar: (scope, v) => cl.typeOf(`var|${scope}|${v}`)
  };
}
