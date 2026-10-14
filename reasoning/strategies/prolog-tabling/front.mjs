/**
 * The front end shared by the Prolog strategies: reading the query and policy wires, compiling the circuits in force into the
 * program the code generator consumes, and the sensitivity block.
 *
 * ADAPTED from `reasoning/strategies/js-reference/index.mjs` (the oracle keeps these helpers private, and the oracle's code is not
 * changed by other strategies): the same parser, governance filter, desugarer and compiler are imported from js-reference; only
 * the small readers below are copies. They differ in one place, which modes are `not_expressible` here.
 */
import {parse, tokens} from '../js-reference/wires.mjs';
import {selectInForce, supposedWireIds} from '../js-reference/governance.mjs';
import {desugar} from '../js-reference/desugar.mjs';
import {compileProgram} from '../js-reference/program.mjs';
import {CEILINGS} from '../js-reference/budget.mjs';
import {ProgramError, NotExpressibleError} from '../js-reference/values.mjs';

export {ProgramError, NotExpressibleError};

export const f1 = (w, k) => w.fields.find(f => f.key === k);
export const ASSUMED = ['supposed', 'hedged', 'reported'];
const LINKS_OTHER_THAN_IF = ['because', 'so', 'unless', 'although', 'so_that', 'before', 'after', 'when', 'while'];

export function readWires(text, what) {
  const {wires, errors} = parse(text ?? '');
  if (errors.length) throw new ProgramError(errors[0].code, `${what}: ${errors[0].message} (line ${errors[0].line})`);
  return wires;
}

/**
 * Read a query wire. `modes` are the query modes the calling strategy runs; any other mode, and every field the host links
 * instead of an engine, is `not_expressible` (the strategy never runs a weaker question).
 */
export function readQuery(wire, excluded, {modes, id}) {
  const one = k => f1(wire, k)?.value.trim() ?? null;
  const span = k => (one(k) ? tokens(one(k)) : null);
  const q = {
    wire, mode: one('mode') ?? 'select', select: tokens(one('select') ?? ''), at: one('at'), during: span('during'), overlaps: span('overlaps'),
    asof: one('asof'), policy: one('policy')?.replace(/^\$/, '') ?? null, limit: one('limit') ? Number(one('limit')) : Infinity,
    ifs: wire.fields.filter(f => f.key === 'if').map(f => f.value.trim().slice(1)).filter(x => !excluded.has(x)),
    via: one('via'), trace: one('trace')
  };
  const all = ['select', 'exists', 'count', 'explain', 'every', 'why_not', 'plan', 'abduce', 'conform', 'procedure', 'effect'];
  if (!all.includes(q.mode)) throw new ProgramError('bad_enum', `mode must be one of ${all.join(', ')}`, wire.id);
  const other = [];
  // `candidate` (Q-LANG-10) runs wires that are not in force elsewhere: the oracle's alone
  for (const k of ['compare', 'order', 'rank', 'filter', 'quantifier', 'except', 'measure', 'candidate', ...LINKS_OTHER_THAN_IF]) if (f1(wire, k)) other.push(k);
  if (f1(wire, 'limit') && !['abduce', 'why_not'].includes(q.mode)) other.push('limit');
  if (other.length) throw new NotExpressibleError(['query_' + other[0]], `query field "${other[0]}" is linked by the host, not run by ${id}`);
  // the universal per group of the selected variables (feature every_grouped) is the oracle's; this strategy decides only the whole-domain universal
  if (q.mode === 'every' && q.select.length) throw new NotExpressibleError(['every_grouped'], `mode every with select (a universal per group) is not expressible by ${id}`);
  if (!modes.includes(q.mode) || q.via || q.trace) {
    const needs = {plan: ['plan'], conform: ['check_plan'], procedure: ['procedure_render', 'method']}[q.mode] ?? ['plan'];
    throw new NotExpressibleError(needs, `mode ${q.mode}${q.via ? ' with via' : ''} is not expressible by ${id}`);
  }
  return q;
}

/** The policy wire in force: ceilings (only tightening), effort, partial, procedures. */
export function readPolicy(wires, q) {
  const w = wires.find(x => x.type === 'policy' && (!q || x.id === q.policy));
  if (!w) return {limits: {}, effort: 'normal', partial: 'allow', procedures: false};
  const limits = {};
  for (const f of w.fields) if (f.key in CEILINGS) limits[f.key] = Number(f.value);
  return {limits, effort: f1(w, 'effort')?.value.trim() ?? 'normal', partial: f1(w, 'partial')?.value.trim() ?? 'allow', procedures: Boolean(f1(w, 'procedures'))};
}

/** Requested limits only tighten: the smaller of the caller's `budget` argument and the policy wire. */
export function mergeLimits(a, b) {
  const out = {...a};
  for (const [k, v] of Object.entries(b)) out[k] = k in out ? Math.min(out[k], v) : v;
  return out;
}

export function assumptionIds(handle, queryText) {
  const qw = readWires(queryText, 'query');
  const ids = [];
  for (const w of [...handle.wires, ...qw]) if (w.type === 'fact' && ASSUMED.includes(f1(w, 'status')?.value.trim())) ids.push(w.id);
  const q = qw.find(w => w.type === 'query');
  if (q) ids.push(...supposedWireIds([q], handle.wires));
  return [...new Set(ids)];
}

/** Compile the circuits in force (governance, supposed wires, sugar) for one set of excluded assumptions. */
export function buildProgram(handle, qWires, q, excluded) {
  const supposed = supposedWireIds(q ? [{...q.wire, fields: q.wire.fields.filter(f => !(f.key === 'if' && excluded.has(f.value.trim().slice(1))))}] : [], handle.wires).filter(id => !excluded.has(id));
  const inForce = selectInForce(handle.wires, {asof: q?.asof ?? null, include: supposed}).filter(w => !(w.type === 'fact' && excluded.has(w.id)));
  const {wires, origin} = desugar([...inForce, ...qWires.filter(w => w.type === 'fact')]);
  return compileProgram(wires, {origin});
}

/** The predicates a partial retrieval must have complete for the answer to be valid (judged on the DESUGARED program). */
export function sensitivityOf(sp, qp) {
  const slice = sp.slice;
  const strict = sp.edges.filter(e => e.strict && slice.has(e.to));
  const over = [...new Set([...strict.map(e => e.from), ...(qp && ['count', 'every'].includes(qp.mode) ? qp.alts.flatMap(a => a.leaves.filter(l => l.kind === 'atom').map(l => l.p)) : [])])];
  const defaults = [...slice].filter(p => /^x_.+_blocked$/.test(p)).map(p => p.slice(2, -8));
  const absentInQuery = qp ? qp.alts.some(a => a.leaves.some(l => l.kind === 'atom' && l.mode === 'absent')) : false;
  const monotone = !strict.length && !absentInQuery && !(qp && ['count', 'every'].includes(qp.mode));
  return {monotone, over, defaults, aggregates: sp.aggregates.map(a => a.id)};
}
