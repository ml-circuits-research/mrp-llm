/**
 * Lowering of the desugared core to ASP (proposal 7.1, ASP column).
 *
 *   fact `p a`         pos_p(a).            fact `not p a`    neg_p(a).        (polarity as TWO relations: a conflict stays a model,
 *                                                                              strong negation `-p` would leave no stable model)
 *   rule               one normal rule per alternative of the body (disjunctive normal form)
 *   `absent p x`       not pos_p(x)         `not p x` in a body   neg_p(x)
 *   compare / compute  arithmetic in the body (integer division truncates toward zero, an undefined operation drops the instance)
 *   aggregate          #count / #sum / #min / #max over a row relation, SET semantics over ALL the variables of the `over` group
 *
 * A body is already ordered by the oracle's `orderLeaves`, so every variable is bound before it is used. `time` is the name of the
 * time variable of a planning encoding (every atom then carries it as its last argument), or null.
 */
import {NotExpressibleError, isVarTerm} from '../js-reference/values.mjs';
import {parseAtom} from './clingo.mjs';

export const enc = v => (typeof v === 'number' ? String(v) : JSON.stringify(v));
export const aspVar = v => 'V_' + v.slice(1);
export const term = t => (isVarTerm(t) ? aspVar(t.var) : enc(t));
const argList = (args, time) => [...args.map(term), ...(time ? [time] : [])];
export const rel = (neg, p, args, time = null) => {
  const a = argList(args, time);
  return `${neg ? 'neg_' : 'pos_'}${p}${a.length ? `(${a.join(',')})` : ''}`;
};

const CMP = {equal: '==', not_equal: '!=', above: '>', below: '<', at_least: '>=', at_most: '<='};
const OPS = {plus: '+', minus: '-', times: '*', whole_divided_by: '/'};
const ORDERING = new Set(['above', 'below', 'at_least', 'at_most']);

function ordinal(t) {
  if (isVarTerm(t)) return `${aspVar(t.var)}+0`; // an operation on a string is undefined in gringo: the instance is dropped, as the oracle's false
  if (typeof t === 'number') return String(t);
  throw new NotExpressibleError(['time_ordering'], `ordering comparisons over the constant ${JSON.stringify(t)} (dates, text) are not lowered`);
}

/** One body leaf as ASP text. */
export function lowerLeaf(l, time = null) {
  switch (l.kind) {
    case 'atom': return l.mode === 'absent' ? `not ${rel(false, l.p, l.args, time)}` : rel(l.mode === 'not', l.p, l.args, time);
    case 'compare': return ORDERING.has(l.word) ? `${ordinal(l.left)} ${CMP[l.word]} ${ordinal(l.right)}` : `${term(l.left)} ${CMP[l.word]} ${term(l.right)}`;
    case 'compute':
      if (!OPS[l.word]) throw new NotExpressibleError(['exact_arithmetic'], `compute ${l.word} has no lowering in this engine (the fixed-point rewriting of solver-common/fixed-point.mjs expands it before)`);
      return `${aspVar(l.out)} = ${term(l.left)} ${OPS[l.word]} ${term(l.right)}`;
    default: throw new NotExpressibleError([l.kind === 'timeof' ? 'time_vars' : l.kind], `${l.kind} leaves are not lowered`);
  }
}

export const lowerBody = (leaves, time = null) => leaves.map(l => lowerLeaf(l, time));

/** Atoms with arities of the relations a program defines, for `#show` (the aggregate helpers stay hidden). */
export class Shown {
  constructor() { this.set = new Map(); this.rows = []; }
  add(neg, p, arity, time) { this.set.set(`${neg ? 'neg_' : 'pos_'}${p}`, arity + (time ? 1 : 0)); }
  /** The row relation of a sum aggregate stays visible: the host checks the 32-bit range of the sum after the call. */
  addRows(name, arity) { this.rows.push([name, arity]); }
  lines() { return ['#show.', '#show ovf_arith/0.', ...[...this.set].map(([name, n]) => `#show ${name}/${n}.`), ...this.rows.map(([name, n]) => `#show ${name}/${n}.`)]; }
}

export function lowerFact(f, time0 = null) {
  return `${rel(f.neg, f.p, f.args.map(a => a), time0)}.`;
}

/**
 * gringo's integers are 32 bits and WRAP SILENTLY, so every `compute` gets a witness rule that derives `ovf_arith` when the operation overflows
 * (the strategy then answers `budget_exhausted` with `reason numeric_range`, never a wrapped number).
 */
function overflowWitnesses(leaves, time) {
  const out = [];
  leaves.forEach((l, i) => {
    if (l.kind !== 'compute') return;
    const prefix = lowerBody(leaves.slice(0, i + 1), time);
    const A = term(l.left), B = term(l.right), V = aspVar(l.out);
    const conds = {
      plus: [`${A} > 0, ${B} > 0, ${V} < 0`, `${A} < 0, ${B} < 0, ${V} >= 0`],
      minus: [`${A} >= 0, ${B} < 0, ${V} < 0`, `${A} < 0, ${B} > 0, ${V} >= 0`],
      times: [`${A} != 0, ${V} / ${A} != ${B}`],
      whole_divided_by: []
    }[l.word];
    for (const c of conds) out.push(`ovf_arith :- ${prefix.join(', ')}, ${c}.`);
  });
  return out;
}

/** The rules of one rule wire (one per alternative), each with `time` appended when given, and the overflow witnesses of its arithmetic. */
export function lowerRule(rule, shown, time = null) {
  shown.add(rule.head.neg, rule.head.p, rule.head.args.length, time);
  return rule.alts.flatMap(alt => {
    const body = lowerBody(alt.leaves, time);
    return [`${rel(rule.head.neg, rule.head.p, rule.head.args, time)}${body.length ? ' :- ' + body.join(', ') : ''}.`, ...overflowWitnesses(alt.leaves, time)];
  });
}

/** An aggregate wire: a row relation per alternative (set semantics), then one rule that groups and applies the function. */
export function lowerAggregate(agg, shown, time = null) {
  const rv = agg.rowVars.map(v => aspVar('?' + v.replace(/^\?/, '')));
  const rowName = `agg_${agg.id}`;
  const rowAtom = `${rowName}(${[...rv, ...(time ? [time] : [])].join(',')})`;
  const lines = agg.alts.flatMap(alt => [`${rowAtom} :- ${lowerBody(alt.leaves, time).join(', ')}.`, ...overflowWitnesses(alt.leaves, time)]);
  if (agg.fn === 'sum') shown.addRows(rowName, rv.length + (time ? 1 : 0));
  const group = agg.group.map(v => aspVar(v));
  const keyName = `aggkey_${agg.id}`;
  const keyAtom = `${keyName}(${[...group, ...(time ? [time] : [])].join(',')})`;
  lines.push(`${keyAtom} :- ${rowAtom}.`);
  const tuple = rv.join(',');
  // a fixed-point program carries every number multiplied by 10^S: a count is the sum of P per distinct row
  const weight = agg.fn === 'count' ? String(agg.scaleCount ?? 1) : aspVar(agg.field ?? '?_');
  if (agg.fn !== 'count' && !agg.field) throw new NotExpressibleError(['aggregate_field'], `${agg.fn} needs a field`);
  const fn = {count: agg.scaleCount ? '#sum' : '#count', sum: '#sum', min: '#min', max: '#max'}[agg.fn];
  if (!fn) throw new NotExpressibleError(['collect'], 'collect aggregates are not lowered');
  const element = agg.fn === 'count' && !agg.scaleCount ? `${tuple}` : `${weight},${tuple}`;
  const head = {neg: false, p: agg.yields.p, args: agg.yields.args};
  shown.add(false, head.p, head.args.length, time);
  const env = `${aspVar(agg.out)} = ${fn} { ${element} : ${rowAtom} }`;
  lines.push(`${rel(false, head.p, head.args, time)} :- ${keyAtom}, ${env}.`);
  return lines;
}

const INT32 = 2 ** 31 - 1;

/** Integer constants outside the 32-bit range of gringo are refused (`not_expressible`), never wrapped. */
export function assertIntegerRange(program, facts, extraLeaves = []) {
  const bad = v => typeof v === 'number' && Math.abs(v) > INT32;
  const check = ts => { for (const t of ts) if (bad(t)) throw new NotExpressibleError(['integer_range'], `the integer ${t} is outside the 32-bit range of clingo`); };
  const leaves = ls => { for (const l of ls) { if (l.kind === 'atom') check(l.args); if (l.kind === 'compare' || l.kind === 'compute') check([l.left, l.right]); } };
  for (const f of facts) check(f.args);
  for (const r of program.rules) { check(r.head.args); r.alts.forEach(a => leaves(a.leaves)); }
  for (const a of program.aggregates) { check(a.yields.args); a.alts.forEach(x => leaves(x.leaves)); }
  leaves(extraLeaves);
}

const TIMEISH = /^(\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z)?|beginning|open)$/;

/**
 * The oracle compares time texts by their instant (`equal` of two spellings, every ordering); gringo compares terms. A program that holds a
 * time text as a value AND compares values is therefore not lowered (a date in a `valid` interval is not a value and is fine).
 */
export function assertNoTimeValues(program, facts, extraLeaves = []) {
  const isTime = v => typeof v === 'string' && TIMEISH.test(v);
  const compares = [];
  const values = [];
  const leaves = ls => { for (const l of ls) { if (l.kind === 'compare') compares.push(l); if (l.kind === 'atom') values.push(...l.args); if (l.kind === 'compare' || l.kind === 'compute') values.push(l.left, l.right); } };
  for (const f of facts) values.push(...f.args);
  for (const r of program.rules) { values.push(...r.head.args); r.alts.forEach(a => leaves(a.leaves)); }
  for (const a of program.aggregates) a.alts.forEach(x => leaves(x.leaves));
  leaves(extraLeaves);
  if (compares.length && values.some(isTime)) throw new NotExpressibleError(['time_values'], 'a program that compares values and holds time texts as values is not lowered (the oracle compares them by instant)');
}

/** After the call: a sum whose rows could exceed 32 bits is not an answer. Returns true when the range is safe. */
export function sumsInRange(program, atoms) {
  for (const a of program.aggregates.filter(x => x.fn === 'sum')) {
    const rows = atoms.map(parseRow).filter(x => x && x.name === `agg_${a.id}`);
    const field = a.rowVars.indexOf(a.field);
    const biggest = rows.reduce((m, r) => Math.max(m, Math.abs(Number(r.args[field]) || 0)), 0);
    if (rows.length * biggest > INT32) return false;
  }
  return true;
}
const parseRow = text => { try { return parseAtom(text); } catch { return null; } };

/** The whole closure program of a slice at one view of the facts. */
export function closureProgram(program, facts) {
  assertIntegerRange(program, facts);
  assertNoTimeValues(program, facts);
  const shown = new Shown();
  const lines = [];
  for (const f of facts) { lines.push(lowerFact(f)); shown.add(f.neg, f.p, f.args.length, null); }
  for (const r of program.rules) lines.push(...lowerRule(r, shown));
  for (const a of program.aggregates) lines.push(...lowerAggregate(a, shown));
  return {lines, shown};
}
