/**
 * What the modes-of-work strategies do before they reason (the host side of proposal 8.2 and 8.3): read the circuits, find the
 * assumptions of a query (supposed or reported facts and the wires an `if` supposes, an amendment included), select the wires in
 * force (governance, `asof`, a contested wire binds and is flagged), apply the scope and procedure filters, and compile the rules,
 * actions and facts with the oracle's compiler. A strategy then builds its own world on the result.
 */
import {parse, tokens} from '../../../sop/knowledge/lexical.mjs';
import {selectInForce, supposedWireIds, contestedIds, GOVERNED} from '../../../sop/knowledge/governance.mjs';
import {desugar} from '../js-reference/desugar.mjs';
import {compileProgram} from '../js-reference/program.mjs';
import {CEILINGS} from '../js-reference/budget.mjs';
import {ProgramError, NotExpressibleError} from '../js-reference/values.mjs';
import {parseNorm, parseMethod, overrideEdges, f1, fAll} from './model.mjs';

const one = (w, k) => f1(w, k)?.value.trim() ?? null;
const ASSUMED = ['supposed', 'hedged', 'reported'];

export function readWires(text, what) {
  const {wires, errors} = parse(text ?? '');
  if (errors.length) throw new ProgramError(errors[0].code, `${what}: ${errors[0].message} (line ${errors[0].line})`);
  return wires;
}

/** The assumptions of a query, as written: assumed facts of the circuits and every `if` target (a fact, a governed wire or an amendment). */
export function assumptionIds(knowledge, queryWires) {
  const ids = [];
  for (const w of [...knowledge, ...queryWires]) if (w.type === 'fact' && ASSUMED.includes(one(w, 'status'))) ids.push(w.id);
  for (const q of queryWires.filter(w => w.type === 'query')) for (const f of fAll(q, 'if')) ids.push(f.value.trim().replace(/^\$/, ''));
  return [...new Set(ids)];
}

/** Remove the excluded assumptions: their facts, and the `if` fields that name them. */
export function withoutAssumptions(knowledge, queryWires, excluded) {
  const keep = ws => ws.filter(w => !(w.type === 'fact' && excluded.has(w.id))).map(w => (w.type === 'query' ? {...w, fields: w.fields.filter(f => !(f.key === 'if' && excluded.has(f.value.trim().replace(/^\$/, ''))))} : w));
  return {knowledge: keep(knowledge), queryWires: keep(queryWires)};
}

/** The policy wire the query names (or the only one): budget limits, procedures, scope tags, objective, binding. */
export function readPolicy(wires, queryWire) {
  const id = queryWire ? one(queryWire, 'policy')?.replace(/^\$/, '') : null;
  const w = wires.find(x => x.type === 'policy' && (queryWire ? x.id === id : true));
  const out = {limits: {}, effort: 'normal', partial: 'allow', procedures: [], scope: [], objective: 'cost', binding: null};
  if (!w) return out;
  for (const f of w.fields) if (f.key in CEILINGS) out.limits[f.key] = Number(f.value);
  out.effort = one(w, 'effort') ?? 'normal';
  out.partial = one(w, 'partial') ?? 'allow';
  out.procedures = fAll(w, 'procedures').flatMap(f => tokens(f.value).map(t => t.replace(/^\$/, '')));
  out.scope = fAll(w, 'scope').flatMap(f => tokens(f.value).flatMap(t => JSON.parse(t.startsWith('"') ? t : JSON.stringify(t)).split(',').map(s => s.trim()).filter(Boolean)));
  out.objective = one(w, 'objective') ?? 'cost';
  out.binding = one(w, 'binding');
  return out;
}

/** Query fields the modes of work read. */
export function readModeQuery(wire) {
  const v = k => one(wire, k);
  // `candidate` (Q-LANG-10) runs wires that are not in force elsewhere: the oracle's alone, never a plan's hypothesis
  if (fAll(wire, 'candidate').length) throw new NotExpressibleError(['candidate'], 'query field candidate is answered by the oracle (mode effect, abduce over candidates)');
  const toks = k => (v(k) ? tokens(v(k)) : null);
  return {
    mode: v('mode') ?? 'select', asof: v('asof'), trace: v('trace')?.replace(/^\$/, '') ?? null, via: toks('via'),
    ifs: fAll(wire, 'if').map(f => f.value.trim().replace(/^\$/, '')), limit: v('limit') ? Number(v('limit')) : Infinity
  };
}

/** Wires in force for a query: `{inForce, supposed, contested}`; `times` lets a trace ask per instant (see `forceAt`). */
export function selectWires(knowledge, queryWires, {asof = null, excluded = new Set()} = {}) {
  const {knowledge: kn, queryWires: qw} = withoutAssumptions(knowledge, queryWires, excluded);
  const q = qw.find(w => w.type === 'query');
  const supposed = (q ? supposedWireIds([q], kn) : []).filter(id => !excluded.has(id));
  // an amendment the query supposes may also REMOVE wires (`removes $id`): they do not bind in that what-if
  const amendments = q ? fAll(q, 'if').map(f => kn.find(w => w.id === f.value.trim().replace(/^\$/, '') && w.type === 'amendment')).filter(Boolean) : [];
  const removed = new Set(amendments.flatMap(a => fAll(a, 'removes').flatMap(f => tokens(f.value).map(t => t.replace(/^\$/, '')))));
  return {knowledge: kn, queryWires: qw, supposed, removed, force: when => selectInForce(kn, {asof: when ?? asof, include: supposed}).filter(w => !removed.has(w.id))};
}

/** Does a scoped wire bind in the context? An unscoped wire always binds; with no context scope a scoped one binds and the packet says so. */
export function scopeBinds(w, contextScope, flags) {
  const s = one(w, 'scope');
  if (!s) return true;
  if (!contextScope.length) { flags.scopeUnknown = true; return true; }
  const tags = s.replace(/^"|"$/g, '').split(',').map(x => x.trim());
  return tags.some(t => contextScope.includes(t));
}

/** Compile the program (rules, actions, facts, closed predicates) of a set of wires in force, with the query's own facts. */
export function compileForce(inForce, queryWires) {
  const {wires, origin} = desugar([...inForce, ...queryWires.filter(w => w.type === 'fact')]);
  return compileProgram(wires, {origin});
}

/** Norms and methods of a set of wires in force, filtered by scope and (for methods) by the procedures the policy names. */
export function modesOf(inForce, policy, flags) {
  const procMembers = new Set();
  for (const id of policy.procedures) {
    const p = inForce.find(w => w.type === 'procedure' && w.id === id);
    if (p) for (const t of tokens(one(p, 'members') ?? '')) procMembers.add(t.replace(/^\$/, ''));
  }
  const norms = inForce.filter(w => w.type === 'norm' && scopeBinds(w, policy.scope, flags)).map(w => parseNorm(w, {policyBinding: policy.binding}));
  const methods = inForce.filter(w => w.type === 'method' && scopeBinds(w, policy.scope, flags) && (!policy.procedures.length || procMembers.has(w.id))).map(w => parseMethod(w, {policyBinding: policy.binding}));
  return {norms, methods, edges: overrideEdges(norms)};
}

export {contestedIds, GOVERNED};
