/**
 * Condition leaves to SQL. An ordered conjunction of leaves (the oracle's `orderLeaves` output: generators as written, filters as soon
 * as their variables are bound) becomes the pieces of one SELECT:
 *
 *   positive atom    a table in FROM; constants and repeated variables become equalities, new variables are bound to its columns
 *   `not p`          the same over the negative relation "-p/n"
 *   `absent p`       NOT EXISTS over the positive relation (the predicate is closed, checked by the program compiler)
 *   compare          a plain SQL operator when both operands are provably integers (or one side is provably not a time), the `cmp`
 *                    function otherwise (exact rules of the oracle: an ordering needs integers or times)
 *   compute          a SQL expression guarded to the proposal's rules: both operands integers, a non-zero divisor, a result inside the
 *                    safe-integer range (SQLite's integer division truncates toward zero, as the proposal says; an overflow turns the
 *                    result into REAL and the guard drops the binding, so a zero divisor or an overflow makes the body false)
 *   order            `ord(a) < ord(b)` over integers and times
 *   start_of/end_of  the stored facts table "s:p/n" (validity text)
 *
 * Every join statement carries `tick(...)` over its tables, the statement timeout and probe counter of the budget (see session.mjs).
 */
import {isVarTerm, NotExpressibleError} from '../js-reference/values.mjs';
import {DATE} from '../js-reference/wires.mjs';
import {ProgramError} from '../js-reference/values.mjs';
import {tbl, storedTbl, quoteId} from './schema.mjs';

const SAFE = '9007199254740991';
const ARITH = {plus: '+', minus: '-', times: '*', whole_divided_by: '/'};
const ORDER_OPS = {above: '>', below: '<', at_least: '>=', at_most: '<='};

const kindOfLiteral = v => (typeof v === 'number' ? 'int' : DATE.test(v) ? 'any' : 'plain');

/** The pieces of a compiled conjunction. */
export class Body {
  constructor() {
    this.from = [];        // {table, alias}
    this.where = [];
    this.bind = new Map(); // ?var -> {expr (stored form), nat (native value), kind}
    this.aliasOf = new Map(); // leaf index -> alias (atom and start_of/end_of leaves)
    this.computeSteps = []; // {from, where, undef}: probes for the `arithmetic_undefined` note
    this.count = 0;
  }

  /** `force` joins in the written order (CROSS JOIN); `first` names the alias that must come first (the delta of a semi-naive round). */
  fromSql({force = false, first = null} = {}) {
    if (!this.from.length) return 'FROM (SELECT 1 AS one) AS t0';
    const items = first ? [...this.from.filter(f => f.alias === first), ...this.from.filter(f => f.alias !== first)] : this.from;
    return 'FROM ' + items.map(f => `${f.table} AS ${f.alias}`).join(force || first ? ' CROSS JOIN ' : ', ');
  }

  tickSql() { return this.from.length ? `tick(${this.from.map(f => `${f.alias}.c0`).join(', ')})` : '1'; }

  whereSql({tick = true} = {}) {
    const terms = [...(tick ? [this.tickSql()] : []), ...this.where];
    return terms.length ? 'WHERE ' + terms.join(' AND ') : '';
  }
}

/**
 * Compile `leaves`. `ctx` = {codec, kinds}. `opts`:
 *   initial   Map(?var -> binding) of variables already bound (the members of an `every` domain)
 *   tableFor  (index, leaf) -> a quoted table name to read instead of the relation (the delta of a semi-naive round, a CTE name)
 */
export function compileLeaves(leaves, ctx, {initial = null, tableFor = null} = {}) {
  const {codec, kinds} = ctx;
  const b = new Body();
  if (initial) for (const [v, x] of initial) b.bind.set(v, x);
  const term = t => {
    if (isVarTerm(t)) {
      const x = b.bind.get(t.var);
      if (!x) throw new ProgramError('unsafe_variable', `${t.var} is used before a positive atom binds it`);
      return x;
    }
    return {expr: codec.lit(t), nat: codec.natLit(t), kind: kindOfLiteral(t)};
  };
  const match = (alias, args, arity, p, conds) => {
    args.forEach((a, i) => {
      const col = `${alias}.c${i}`;
      if (!isVarTerm(a)) conds.push(`${col} = ${codec.lit(a)}`);
      else if (b.bind.has(a.var)) conds.push(`${col} = ${b.bind.get(a.var).expr}`);
      else b.bind.set(a.var, {expr: col, nat: codec.native(col), kind: kinds.of(p, arity, i)});
    });
  };
  leaves.forEach((l, idx) => {
    switch (l.kind) {
      case 'atom': {
        const arity = l.args.length;
        if (l.mode === 'absent') {
          const alias = `a${++b.count}`;
          const conds = [];
          l.args.forEach((a, i) => {
            if (isVarTerm(a) && !b.bind.has(a.var)) throw new ProgramError('unsafe_negation', `absent ${l.p} uses ${a.var} before it is bound`);
            conds.push(`${alias}.c${i} = ${term(a).expr}`);
          });
          b.where.push(`NOT EXISTS (SELECT 1 FROM ${tbl(l.p, arity, false)} AS ${alias}${conds.length ? ' WHERE ' + conds.join(' AND ') : ''})`);
          break;
        }
        const alias = `t${++b.count}`;
        const table = tableFor?.(idx, l) ?? tbl(l.p, arity, l.mode === 'not');
        b.from.push({table, alias});
        b.aliasOf.set(idx, alias);
        match(alias, l.args, arity, l.p, b.where);
        break;
      }
      case 'timeof': {
        const arity = l.args.length;
        const alias = `t${++b.count}`;
        b.from.push({table: storedTbl(l.p, arity), alias});
        b.aliasOf.set(idx, alias);
        match(alias, l.args, arity, l.p, b.where);
        const col = `${alias}.${l.which === 'start_of' ? 'vf' : 'vt'}`;
        if (b.bind.has(l.out)) b.where.push(`${col} = ${b.bind.get(l.out).expr}`);
        else b.bind.set(l.out, {expr: col, nat: col, kind: 'any'});
        break;
      }
      case 'compare': {
        const x = term(l.left), y = term(l.right);
        const ordering = l.word in ORDER_OPS;
        if (ordering) b.where.push(x.kind === 'int' && y.kind === 'int' ? `${x.nat} ${ORDER_OPS[l.word]} ${y.nat}` : `cmp('${l.word}', ${x.nat}, ${y.nat})`);
        else {
          const plain = x.kind !== 'any' || y.kind !== 'any';
          const eq = l.word === 'equal';
          b.where.push(plain ? `${x.nat} ${eq ? '=' : '<>'} ${y.nat}` : `${eq ? '' : 'NOT '}cmp('equal', ${x.nat}, ${y.nat})`);
        }
        break;
      }
      case 'compute': {
        if (!ARITH[l.word]) throw new NotExpressibleError(['exact_arithmetic'], `compute ${l.word} has no lowering in this engine (the fixed-point rewriting of solver-common/fixed-point.mjs expands it before)`);
        const x = term(l.left), y = term(l.right);
        const res = `(${x.nat} ${ARITH[l.word]} ${y.nat})`;
        const defined = [
          ...(x.kind === 'int' ? [] : [`typeof(${x.nat}) = 'integer'`]),
          ...(y.kind === 'int' ? [] : [`typeof(${y.nat}) = 'integer'`]),
          ...(l.word === 'whole_divided_by' ? [`${y.nat} <> 0`] : []),
          `typeof(${res}) = 'integer'`, ...(l.wide ? [] : [`${res} BETWEEN -${SAFE} AND ${SAFE}`])
        ].join(' AND ');
        b.computeSteps.push({from: [...b.from], where: [...b.where], undef: `NOT (${defined})`});
        b.where.push(defined);
        if (b.bind.has(l.out)) b.where.push(`${b.bind.get(l.out).nat} = ${res}`);
        else b.bind.set(l.out, {expr: codec.store(res), nat: res, kind: 'int'});
        break;
      }
      case 'order': {
        const x = b.bind.get(l.left), y = b.bind.get(l.right);
        if (!x || !y) throw new ProgramError('unsafe_variable', 'order uses an unbound variable');
        b.where.push(l.word === 'before' ? `ord(${x.nat}) < ord(${y.nat})` : l.word === 'after' ? `ord(${x.nat}) > ord(${y.nat})` : `ord(${x.nat}) = ord(${y.nat})`);
        break;
      }
      default: throw new ProgramError('unsupported_condition', `leaf ${l.kind} is not compiled to SQL`);
    }
  });
  return b;
}

/** SQL expression of a head or yields argument over the bound variables. */
export function termExpr(t, bind, codec) {
  if (!isVarTerm(t)) return codec.lit(t);
  const x = bind.get(t.var);
  if (!x) throw new ProgramError('unsafe_head', `${t.var} is not bound by the body`);
  return x.expr;
}

export {quoteId};
