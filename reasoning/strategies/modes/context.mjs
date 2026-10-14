/**
 * One query, read once: the wires in force (governance, `asof`, the wires an `if` supposes), the compiled program, the norms and
 * methods that bind (scope and procedure filters, a contested wire binding but flagged), the policy and the budget. Everything the
 * modes (plan, why_not, abduce, procedure, conform) need, so each mode is a small function of this context.
 */
import {Budget} from '../js-reference/budget.mjs';
import {conditionAlts} from '../js-reference/program.mjs';
import {NotExpressibleError, toTerm, isVarTerm} from '../js-reference/values.mjs';
import {readModeQuery, readPolicy, selectWires, compileForce, modesOf, contestedIds} from './theory.mjs';
import {parseTrace, fAll} from './model.mjs';
import {World, goalLeaves} from './world.mjs';

/** Requested limits only tighten: the smaller of the caller's `budget` argument and the policy wire. */
export function mergeLimits(a, b) {
  const out = {...a};
  for (const [k, v] of Object.entries(b)) out[k] = k in out ? Math.min(out[k], v) : v;
  return out;
}

/** The goal of a planning query: its `where` as ordered alternatives, a test over a closure, the constants it mentions, and the single positive atom (a task) when it is one. */
export function buildGoal(world, q) {
  const alts = conditionAlts(fAll(q, 'where'), q.id);
  const leaves = goalLeaves(alts, world.closed, q.id);
  const consts = new Set(alts.flatMap(a => a.flatMap(l => (l.kind === 'atom' ? l.args.filter(t => !isVarTerm(t)) : []))));
  const only = alts.length === 1 && alts[0].length === 1 && alts[0][0].kind === 'atom' && alts[0][0].mode === 'pos' ? alts[0][0] : null;
  const negPreds = alts.flatMap(a => a.flatMap(l => (l.kind === 'atom' && l.mode === 'not' ? [l.p] : [])));
  return {negPreds, consts, single: only ? {p: only.p, args: only.args} : null, holds: ev => leaves.some(ls => !world.solve(ls, ev).next().done), text: fAll(q, 'where').map(f => f.value.trim()).join(' ')};
}

/** `via ~action term...` of a why_not or abduce query. */
export function readVia(mq) {
  if (!mq.via) return null;
  if (!mq.via[0]?.startsWith('~')) throw new NotExpressibleError(['blocked_info'], 'via names a step: ~action term...');
  return {action: mq.via[0].slice(1), terms: mq.via.slice(1).map(toTerm), text: mq.via.join(' ')};
}

/** Context of one solve (one set of excluded assumptions). `knowledge` and `queryWires` are parsed wires. */
export function buildContext({knowledge, queryWires, excluded = new Set(), budgetArg = {}}) {
  const q = queryWires.find(w => w.type === 'query');
  if (!q) throw new NotExpressibleError(['plan'], 'the query circuit holds no query wire');
  const mq = readModeQuery(q);
  const sel = selectWires(knowledge, queryWires, {asof: mq.asof, excluded});
  const wires = [...sel.knowledge, ...sel.queryWires];
  const policy = readPolicy(wires, q);
  const traceWire = mq.trace ? wires.find(w => w.type === 'trace' && w.id === mq.trace) : null;
  if (mq.trace && !traceWire) throw new NotExpressibleError(['check_plan'], `the trace ${mq.trace} is not in the circuits`);
  const trace = traceWire ? parseTrace(traceWire) : null;
  // the program (rules, actions, facts) is compiled for one reference time: the asked asof, else the first step of a trace that carries a date, else now
  const refTime = mq.asof ?? trace?.find(s => s.at)?.at ?? null;
  const inForce = sel.force(refTime);
  const flags = {scopeUnknown: false};
  const program = compileForce(inForce, sel.queryWires);
  const modes = modesOf(inForce, policy, flags);
  const budget = new Budget(mergeLimits(budgetArg, policy.limits), {effort: policy.effort});
  const contested = contestedIds(inForce).filter(id => inForce.find(w => w.id === id && ['norm', 'method', 'rule', 'default', 'action'].includes(w.type)));
  return {q, mq, policy, wires, knowledge: sel.knowledge, queryWires: sel.queryWires, supposed: sel.supposed, force: sel.force, inForce, program, ...modes, flags, budget, contested, trace, refTime};
}

export const worldOf = ctx => new World(ctx.program, ctx.budget);
