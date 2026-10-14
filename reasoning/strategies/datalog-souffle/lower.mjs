/**
 * Lowering of the compiled (governed, desugared, stratified) core to Soufflé `.dl` text and `.facts` files (proposal 7.1, Datalog column).
 *
 *   predicate p, polarity    two relations: `p_<name>` (positive evidence) and `n_<name>` (explicit negative evidence); both is
 *                            a fact in each, computed by the host at query time, never an explosion;
 *   fact                     a row of a `.facts` TSV file (nullary facts are inline clauses);
 *   rule, alternative        one clause per alternative of the body; `not p` reads `n_p`, `absent p` is the stratified `!p_p`;
 *   compare, compute         constraints and arithmetic, with guards: a zero divisor makes the body false, and every `plus`,
 *                            `minus` and `times` carries a float guard that flags 32-bit overflow in `x_ovf` (reported as
 *                            `budget_exhausted`, reason `numeric_range`, never a wrapped number);
 *   aggregate                the distinct bindings of all variables of `over` form a set relation (`x_agg_<id>_rows`), the groups
 *                            are projected from it and `count`/`sum`/`min`/`max` run over exactly that set (set semantics);
 *   default, integrity       already desugared by the host; nothing to lower.
 * Not lowered (the program is `not_expressible`): `collect`, `order`, `start_of`/`end_of`, ordering over text, mixed types.
 */
import {isVarTerm, NotExpressibleError} from '../js-reference/values.mjs';
import {inferTypes} from './types.mjs';

const OPS = {equal: '=', not_equal: '!=', above: '>', below: '<', at_least: '>=', at_most: '<='};
const ARITH = {plus: '+', minus: '-', times: '*', whole_divided_by: '/'};
const FLOAT_LIMIT = '2000000000.0';

const SAFE_SYMBOL = /^[A-Za-z0-9_.:/+-]+$/;

/** Injective encoding of any text into a token that is safe in a TSV field and in a Soufflé string (no space, quote, tab, backslash). */
export const encodeSymbol = s => (SAFE_SYMBOL.test(s) ? s : '~' + Buffer.from(s, 'utf8').toString('hex'));
export const decodeSymbol = s => (s.startsWith('~') ? Buffer.from(s.slice(1), 'hex').toString('utf8') : s);

const relName = (neg, p) => `${neg ? 'n' : 'p'}_${p}`;
const varName = v => 'V_' + v.slice(1);

class Unit {
  constructor() { this.atoms = []; this.constraints = []; }
}

/** Atoms and constraints of every part of the program, for the type inference. */
function collect(program, queryAtoms) {
  const u = new Unit();
  for (const f of program.facts) u.atoms.push({p: f.p, args: f.args, scope: 'fact'});
  const leavesOf = (leaves, scope) => {
    for (const l of leaves) {
      if (l.kind === 'atom') u.atoms.push({p: l.p, args: l.args, scope});
      else if (l.kind === 'compare') u.constraints.push({kind: 'compare', scope, word: l.word, left: l.left, right: l.right});
      else if (l.kind === 'compute') u.constraints.push({kind: 'compute', scope, out: l.out, left: l.left, right: l.right});
      else throw new NotExpressibleError([l.kind], `condition ${l.kind} is not lowered to Soufflé`);
    }
  };
  for (const r of program.rules) {
    u.atoms.push({p: r.head.p, args: r.head.args, scope: 'rule|' + r.id});
    for (const alt of r.alts) leavesOf(alt.leaves, 'rule|' + r.id);
  }
  for (const a of program.aggregates) {
    if (a.fn === 'collect') throw new NotExpressibleError(['collect'], 'aggregate collect is not lowered to Soufflé');
    const scope = 'agg|' + a.id;
    for (const alt of a.alts) leavesOf(alt.leaves, scope);
    u.atoms.push({p: a.yields.p, args: a.yields.args, scope});
    u.constraints.push({kind: 'aggregate', scope, out: a.out, field: a.fn === 'count' ? null : a.field});
  }
  for (const q of queryAtoms) u.atoms.push(q);
  return u;
}

const SOUFFLE_STRING = s => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

/**
 * Lower a (sliced) program and its facts. `wanted` is the set of 'p|name' / 'n|name' relations to output; `extra(ctx)` lets a
 * pushed-down query add its own clauses and outputs. Returns {dl, files, outputs: [{rel, key, types}], decode}.
 */
export function lowerProgram({program, facts, wanted = new Set(), extra = null, extraAtoms = [], extraConstraints = []}) {
  const unit = collect(program, extraAtoms);
  unit.constraints.push(...extraConstraints);
  const types = inferTypes(unit);
  const lines = [], decls = new Map(), withFacts = new Map(), outputs = [];
  const colTypes = p => Array.from({length: types.arity.get(p) ?? 0}, (_, i) => types.typeOfColumn(p, i));
  const declare = (neg, p) => {
    const name = relName(neg, p);
    if (!decls.has(name)) {
      if (!types.arity.has(p)) throw new Error(`no arity known for ${p}`);
      decls.set(name, {neg, p, cols: colTypes(p)});
    }
    return name;
  };
  const value = (t, scope, wrap = false) => {
    if (isVarTerm(t)) return varName(t.var);
    if (typeof t === 'number') return wrap && t < 0 ? `(${t})` : String(t);
    return SOUFFLE_STRING(encodeSymbol(t));
  };
  const atomText = (neg, p, args, scope) => `${declare(neg, p)}(${args.map(a => value(a, scope)).join(', ')})`;

  // ---- facts
  const inline = [];
  for (const f of program.facts) {
    const name = declare(f.neg, f.p);
    const cols = decls.get(name).cols;
    if (!cols.length) { inline.push(`${name}().`); continue; }
    if (!withFacts.has(name)) withFacts.set(name, []);
    withFacts.get(name).push(f.args.map((a, i) => (cols[i] === 'number' ? String(a) : encodeSymbol(String(a)))).join('\t'));
  }

  // ---- body leaves
  const bodyOf = (leaves, scope, guardSink) => {
    const out = [];
    for (const l of leaves) {
      if (l.kind === 'atom') out.push((l.mode === 'absent' ? '!' : '') + atomText(l.mode === 'not', l.p, l.args, scope));
      else if (l.kind === 'compare') out.push(`${value(l.left, scope)} ${OPS[l.word]} ${value(l.right, scope)}`);
      else if (l.kind === 'compute') {
        if (!ARITH[l.word]) throw new NotExpressibleError(['exact_arithmetic'], `compute ${l.word} has no lowering in this engine (the fixed-point rewriting of solver-common/fixed-point.mjs expands it before)`);
        const a = value(l.left, scope, true), b = value(l.right, scope, true);
        if (l.word === 'whole_divided_by') out.push(`${b} != 0`);
        else guardSink?.push({prefix: out.slice(), a, b, word: l.word});
        out.push(`${varName(l.out)} = (${a} ${ARITH[l.word]} ${b})`);
      }
    }
    return out;
  };

  // ---- rules
  const clauses = [], guards = [];
  for (const r of program.rules) {
    const scope = 'rule|' + r.id;
    const head = atomText(r.head.neg, r.head.p, r.head.args, scope);
    for (const alt of r.alts) clauses.push(`${head} :- ${bodyOf(alt.leaves, scope, guards).join(', ')}.`);
  }

  // ---- aggregates
  for (const a of program.aggregates) {
    const scope = 'agg|' + a.id, rows = `x_agg_${a.id}_rows`, grp = `x_agg_${a.id}_grp`;
    const colTypeOf = v => types.typeOfVar(scope, v);
    const sig = a.rowVars.map((v, i) => `c${i}:${colTypeOf(v)}`).join(', ');
    decls.set(rows, {raw: `.decl ${rows}(${sig})`});
    decls.set(grp, {raw: `.decl ${grp}(${a.group.map((v, i) => `c${i}:${colTypeOf(v)}`).join(', ')})`});
    for (const alt of a.alts) {
      const missing = a.rowVars.filter(v => !alt.leaves.some(l => l.kind === 'atom' && l.mode !== 'absent' && l.args.some(t => isVarTerm(t) && t.var === v)) && !alt.leaves.some(l => l.kind === 'compute' && l.out === v));
      if (missing.length) throw new NotExpressibleError(['aggregate_alternatives'], 'the alternatives of an aggregate bind different variables');
      clauses.push(`${rows}(${a.rowVars.map(varName).join(', ')}) :- ${bodyOf(alt.leaves, scope, null).join(', ')}.`);
    }
    clauses.push(`${grp}(${a.group.map(varName).join(', ')}) :- ${rows}(${a.rowVars.map(varName).join(', ')}).`);
    const inner = `${rows}(${a.rowVars.map(v => (a.group.includes(v) ? varName(v) : 'A_' + v.slice(1))).join(', ')})`;
    // a fixed-point program carries every number multiplied by 10^S: a count is the sum of P per distinct row
    const expr = a.fn === 'count' ? (a.scaleCount ? `sum ${a.scaleCount} : { ${inner} }` : `count : { ${inner} }`) : `${a.fn} A_${a.field.slice(1)} : { ${inner} }`;
    const yields = atomText(false, a.yields.p, a.yields.args, scope);
    const gAtom = `${grp}(${a.group.map(varName).join(', ')})`;
    clauses.push(`${yields} :- ${gAtom}, ${varName(a.out)} = ${expr}.`);
    if (a.fn === 'sum') {
      const f = `A_${a.field.slice(1)}`;
      for (const [cmp, lim] of [['>', FLOAT_LIMIT], ['<', '-' + FLOAT_LIMIT]]) clauses.push(`x_ovf(${SOUFFLE_STRING('aggregate ' + a.id)}) :- ${gAtom}, F = sum to_float(${f}) : { ${inner} }, F ${cmp} ${lim}.`);
    }
  }

  // ---- overflow guards of plus, minus and times
  for (const g of guards) {
    const op = ARITH[g.word];
    for (const [cmp, lim] of [['>', FLOAT_LIMIT], ['<', '-' + FLOAT_LIMIT]]) {
      clauses.push(`x_ovf(${SOUFFLE_STRING('compute ' + g.word)}) :- ${[...g.prefix, `to_float(${g.a}) ${op} to_float(${g.b}) ${cmp} ${lim}`].join(', ')}.`);
    }
  }
  const ovfRules = guards.length > 0 || program.aggregates.some(a => a.fn === 'sum');

  // ---- extra clauses of a pushed-down query
  const ctx = {declare, atomText, value, bodyOf, types, outputs, clauses, decls};
  extra?.(ctx);

  // ---- outputs of the wanted relations
  for (const key of wanted) {
    const neg = key.startsWith('n|'), p = key.slice(2);
    if (!types.arity.has(p)) continue; // the predicate occurs nowhere in the slice: no evidence at all
    const name = declare(neg, p);
    outputs.push({rel: name, key, cols: decls.get(name).cols});
  }

  const text = [];
  for (const [name, d] of decls) {
    if (d.raw) { text.push(d.raw); continue; }
    text.push(`.decl ${name}(${d.cols.map((c, i) => `c${i}:${c}`).join(', ')})`);
    if (withFacts.has(name)) text.push(`.input ${name}(IO=file, filename="${name}.facts")`);
  }
  if (ovfRules) text.push('.decl x_ovf(why:symbol)', '.output x_ovf');
  text.push(...inline, ...clauses);
  for (const o of outputs) text.push(`.output ${o.rel}`);
  const files = new Map([...withFacts].map(([name, rows]) => [`${name}.facts`, rows.join('\n') + '\n']));
  return {dl: text.join('\n') + '\n', files, outputs, overflowGuard: ovfRules, relationCount: decls.size};
}
