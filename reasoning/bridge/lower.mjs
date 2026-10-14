/**
 * Lowering of the runtime's typed objects (facts, rules, conditions; lib/types.mjs shapes) to the knowledge wires the oracle reads
 * (sop/knowledge, DS004 "Knowledge wires"). Pure and reversible: the Lowering remembers how predicates and variables were spelled
 * so a result can be mapped back.
 *
 * A term is a number, a JSON-quoted string (a string that is a plain symbol is written bare; the two are the same value), or a
 * ?variable. A predicate that the knowledge grammar reserves (`order`, `match`, a name starting `x_`, ...) and a variable that is not
 * lower-case are renamed here and renamed back by `Lowering.predicate` and `Lowering.variable`.
 */
import {variable} from '../../lib/types.mjs';
import {formatTime} from '../../lib/time.mjs';

const SYMBOL = /^[a-z][a-z0-9_]*$/;
const SAFE_VAR = /^\?[a-z][a-z0-9_]*$/;
const RESERVED = new Set(['not', 'absent', 'compare', 'compute', 'order', 'start_of', 'end_of', 'all', 'any', 'end', 'match', 'else']);

export class Lowering {
  constructor() {
    this.predOut = new Map();
    this.predBack = new Map();
    this.varOut = new Map();
    this.varBack = new Map();
  }

  /** The spelling of a predicate in the lowered program. */
  predicate(p) {
    if (!this.predOut.has(p)) {
      let out = p;
      if (RESERVED.has(out) || out.startsWith('x_')) out = 'p_' + out;
      while (this.predBack.has(out) && this.predBack.get(out) !== p) out += '_p';
      this.predOut.set(p, out);
      this.predBack.set(out, p);
    }
    return this.predOut.get(p);
  }

  unpredicate(p) { return this.predBack.get(p) ?? p; }

  variable(v) {
    if (SAFE_VAR.test(v)) return v;
    if (!this.varOut.has(v)) {
      let out = '?v_' + Buffer.from(v).toString('hex').toLowerCase();
      this.varOut.set(v, out);
      this.varBack.set(out, v);
    }
    return this.varOut.get(v);
  }

  unvariable(v) { return this.varBack.get(v) ?? v; }

  term(t) {
    if (typeof t === 'number') return String(t);
    if (variable(t)) return this.variable(t);
    return SYMBOL.test(t) ? t : JSON.stringify(t);
  }

  atom(a) { return [a.neg === 'absent' ? 'absent' : a.neg ? 'not' : null, this.predicate(a.p), ...a.a.map(t => this.term(t))].filter(x => x !== null).join(' '); }

  /** Map a binding of the lowered program back to the runtime's variable spelling. */
  binding(env) { return Object.fromEntries(Object.entries(env).map(([k, v]) => [this.unvariable(k), v])); }
}

const field = (key, value, block = []) => ({key, value, line: 0, block});
const instantText = t => (t === -Infinity ? 'beginning' : t === Infinity ? 'open' : formatTime(t));
export const isTimeless = valid => !valid || (valid.from === -Infinity && valid.until === Infinity);

/** A `fact` wire for one typed fact `{atom, valid}`; `status` supposed marks an assumption (never plain evidence). */
export function factWire(lowering, id, f, status = 'observed') {
  const fields = [field('holds', lowering.atom(f.atom))];
  if (!isTimeless(f.valid)) fields.push(field('valid', instantText(f.valid.from) + ' ' + instantText(f.valid.until)));
  if (status !== 'observed') fields.push(field('status', status));
  return {id, type: 'fact', line: 0, fields};
}

/** A `rule` wire for one typed rule `{id, if: [atoms], then}`. */
export const ruleWire = (lowering, r) => ({id: r.id, type: 'rule', line: 0, fields: [...r.if.map(a => field('when', lowering.atom(a))), ...(r.extra ?? []).map(text => field('when', text)), field('then', lowering.atom(r.then))]});

/** A condition tree (typed atoms in `all`/`any` groups) as a condition field: a bare atom, or the group opener with its block. */
export function conditionField(lowering, key, condition) {
  if (condition.kind !== 'all' && condition.kind !== 'any') return field(key, lowering.atom(condition));
  const block = [];
  const emit = node => {
    if (node.kind === 'all' || node.kind === 'any') {
      block.push({text: node.kind, line: 0, indent: 0});
      node.children.forEach(emit);
      block.push({text: 'end', line: 0, indent: 0});
    } else block.push({text: lowering.atom(node), line: 0, indent: 0});
  };
  condition.children.forEach(emit);
  block.push({text: 'end', line: 0, indent: 0});
  return field(key, condition.kind, block);
}

/** The opposite of a conjunction of conditions: not ALL is ANY opposite, not ANY is ALL opposite, a literal flips its polarity. */
export function oppositeConditions(conditions) {
  const opposite = c => (c.kind === 'all' || c.kind === 'any' ? {kind: c.kind === 'all' ? 'any' : 'all', children: c.children.map(opposite)} : {...c, neg: !c.neg});
  return [{kind: 'any', children: conditions.map(opposite)}];
}

/** A query wire over lowered conditions: `where` fields, optional `scope` fields, an instant and the variables to select. */
export function queryWire(lowering, {where, scope = [], select = [], at = null, mode = 'select'}) {
  const fields = [field('mode', mode)];
  if (select.length) fields.push(field('select', select.map(v => lowering.variable(v)).join(' ')));
  for (const c of where) fields.push(conditionField(lowering, 'where', c));
  for (const c of scope) fields.push(conditionField(lowering, 'scope', c));
  if (at !== null) fields.push(field('at', at === -Infinity ? 'beginning' : formatTime(at)));
  return {id: 'q', type: 'query', line: 0, fields};
}

/** Rename the variables of the typed forms (compare tree, rank, filter ASTs) to the lowered spelling. */
export function lowerForms(lowering, q, {quantifier = q.quantifier ?? null} = {}) {
  const cmp = n => (n.kind ? {kind: n.kind, children: n.children.map(cmp)} : {left: lowering.variable(n.left), op: n.op, right: variable(n.right) ? lowering.variable(n.right) : n.right});
  const ast = n => {
    if (!n || typeof n !== 'object') return n;
    if (Array.isArray(n)) return n.map(ast);
    if (n.type === 'var') return {...n, value: lowering.variable(n.value)};
    return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, ast(v)]));
  };
  return {
    compares: (q.compares ?? []).map(cmp), filters: (q.filters ?? []).map(ast),
    rank: q.rank ? {direction: q.rank.direction, variable: lowering.variable(q.rank.variable), ...(q.rank.cut ? {cut: q.rank.cut, n: q.rank.n} : {})} : null,
    quantifier, limit: Infinity
  };
}
