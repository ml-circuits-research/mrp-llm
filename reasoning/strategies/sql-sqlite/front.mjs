/**
 * The host front end of sql-sqlite: the same modules as the oracle (`js-reference`), so that a disagreement with the oracle can only come
 * from the SQL lowering and never from a second reading of the wires:
 *
 *   wires -> governance (wires in force, supposed wires) -> desugaring (default, integrity) -> compileProgram (safety, stratification)
 *         -> dependency slice of the query -> SQL (tables, closure, query) -> packet.
 *
 * What this strategy does not run is `not_expressible`, never weakened: why_not, plan, abduce, numeric constraints, the modes of work.
 */
import {parse, tokens, selectInForce, supposedWireIds, desugar} from '../../../sop/knowledge/index.mjs';
import {compileProgram} from '../js-reference/program.mjs';
import {ProgramError, NotExpressibleError} from '../js-reference/values.mjs';
import {CEILINGS} from './budget.mjs';
import {readForms} from '../js-reference/forms.mjs';

export {ProgramError, NotExpressibleError};

export const READ_MODES = ['select', 'exists', 'count', 'explain', 'every'];
const MODE_FEATURE = {why_not: 'why_not', plan: 'plan', abduce: 'abduce', conform: 'check_plan', procedure: 'procedure_render', effect: 'effect'};
const LINKS_OTHER_THAN_IF = ['because', 'so', 'unless', 'although', 'so_that', 'before', 'after', 'when', 'while'];
const NOT_RUN = ['order', 'quantifier', 'measure', ...LINKS_OTHER_THAN_IF, 'via', 'trace', 'candidate'];

export const f1 = (w, k) => w.fields.find(f => f.key === k);

export function readWires(text, what) {
  const {wires, errors} = parse(text ?? '');
  if (errors.length) throw new ProgramError(errors[0].code, `${what}: ${errors[0].message} (line ${errors[0].line})`);
  return wires;
}

export function readQuery(wire, excluded) {
  const one = k => f1(wire, k)?.value.trim() ?? null;
  const span = k => (one(k) ? tokens(one(k)) : null);
  const q = {
    wire, mode: one('mode') ?? 'select', select: tokens(one('select') ?? ''), at: one('at'), during: span('during'), overlaps: span('overlaps'),
    asof: one('asof'), policy: one('policy')?.replace(/^\$/, '') ?? null,
    ifs: wire.fields.filter(f => f.key === 'if').map(f => f.value.trim().slice(1)).filter(id => !excluded.has(id))
  };
  q.forms = ['compare', 'rank', 'filter', 'except', 'limit'].some(k => f1(wire, k)) ? readForms(wire) : null;
  if (MODE_FEATURE[q.mode]) throw new NotExpressibleError([MODE_FEATURE[q.mode]], `mode ${q.mode} is not run by sql-sqlite`);
  if (!READ_MODES.includes(q.mode)) throw new ProgramError('bad_enum', `mode must be one of ${[...READ_MODES, ...Object.keys(MODE_FEATURE)].join(', ')}`, wire.id);
  const other = NOT_RUN.find(k => f1(wire, k));
  if (other) throw new NotExpressibleError(['query_' + other], `query field "${other}" is linked by the host, not run by sql-sqlite`);
  return q;
}

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

/** Compile the circuits in force for one set of excluded assumptions (the same pipeline as the oracle). */
export function buildProgram(handle, qWires, q, excluded) {
  const supposed = supposedWireIds(q ? [{...q.wire, fields: q.wire.fields.filter(f => !(f.key === 'if' && excluded.has(f.value.trim().slice(1))))}] : [], handle.wires).filter(id => !excluded.has(id));
  const inForce = selectInForce(handle.wires, {asof: q?.asof ?? null, include: supposed}).filter(w => !(w.type === 'fact' && excluded.has(w.id)));
  const {wires, origin} = desugar([...inForce, ...qWires.filter(w => w.type === 'fact')]);
  return compileProgram(wires, {origin});
}
