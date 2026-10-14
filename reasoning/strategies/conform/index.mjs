/**
 * conform-core: the `conform` capability of the oracle path, through the lowering to core rules (./lower.mjs). A query with
 * `mode conform` and a `trace` is lowered to a core program and answered by the oracle (`../js-reference/`, wrapped, not rewritten);
 * every other query is delegated to the oracle unchanged. The strategy declares the oracle's features plus the conformance ones, so the
 * smoke harness runs the 37a-37d family on it and the shadow test compares it with the planner's own monitors.
 *
 * The answer carries what the planner's `conform` carries: status compliant | non_compliant, compliance {hard, violated, relaxed?,
 * soft_violations, deviations, total_cost}, used (versions), violations, deviations, obligations_triggered.
 *
 * Limits (NotExpressible, never weakened): `achieve` and sub-task steps of a method and `if`/`until`/`pick` on variables the method
 * does not bind first are not checked; at most four variables per method; `at_most_once` and `before`/`after` over a state atom;
 * aggregates and start_of/end_of in the cone of a norm or method condition; an effect on a derived predicate.
 */
import {readWires, assumptionIds} from '../modes/theory.mjs';
import {buildContext} from '../modes/context.mjs';
import {instanceName} from '../modes/model.mjs';
import {conformPacket} from '../modes/verdict.mjs';
import {jsReference, NotExpressibleError, ProgramError} from '../js-reference/index.mjs';
import {withConditional} from '../js-reference/conditional.mjs';
import {lowerTrace} from './lower.mjs';

export {NotExpressibleError, ProgramError};

export const id = 'conform-core';
export const available = async () => ({ok: true});

const CONFORM_FEATURES = ['check_plan', 'conform_asof', 'conform_deviation', 'norms_hard', 'norms_soft', 'temporal_norms', 'method', 'versions', 'used', 'binding_advisory', 'overrides', 'zero_arity'];

export const capabilities = {
  ...jsReference.capabilities,
  id: 'conform-core',
  features: [...new Set([...jsReference.capabilities.features, ...CONFORM_FEATURES])],
  notExpressible: ['plan', 'blocked_info', 'htn_choice', 'on_failure', 'procedures', 'procedure_render', 'amendment', 'abduce_waive'],
  provides: ['explain', 'used', 'proof', 'compliance'],
  lowering: 'conform: trace + norms + methods in force -> step-indexed core rules (x_c_*) run on the oracle'
};

export const prepare = jsReference.prepare;
export const update = jsReference.update;

/** Read the rows of one relation of the lowered program from the oracle. */
function rowsOf(oracle, handle, rel, arity) {
  const vars = Array.from({length: arity}, (_, i) => `?c_o${i}`);
  const q = `@q query\n  mode select\n  where ${[rel, ...vars].join(' ')}\n${arity ? `  select ${vars.join(' ')}\n` : ''}`;
  const r = oracle.ask({handle, query: q});
  if (r.status === 'budget_exhausted') throw new ProgramError('budget_exhausted', `the lowered program of the conformance check ran out of budget (${r.reason})`);
  return (r.rows ?? []).map(row => vars.map((_, i) => row[`c_o${i}`]));
}

/** The verdict of a trace by the lowered program: the same plain data as the planner's judgeRun. */
export function judgeByLowering(ctx, steps, {oracle = jsReference} = {}) {
  const low = lowerTrace({ctx, steps});
  const handle = oracle.prepare({knowledge: low.text});
  const {meta, tl, world} = low;
  const compliant = oracle.ask({handle, query: '@q query\n  mode exists\n  where x_c_compliant\n'}).status === 'supported';
  const violations = [];
  for (const v of meta.viol) {
    const rows = rowsOf(oracle, handle, v.rel, v.arity);
    const best = new Map();
    for (const [step, ...vals] of rows) { const k = JSON.stringify(vals); if (!best.has(k) || step < best.get(k).step) best.set(k, {step, vals}); }
    for (const {step, vals} of best.values()) {
      const N = v.norm;
      violations.push({id: N.id, version: N.version, kind: N.severity, binding: N.binding, instance: instanceName(N.id, vals), step, cost: N.severity === 'soft' ? N.cost : 0, why: 'derived by the lowered program'});
    }
  }
  const used = new Set(), usedIds = [];
  const add = x => { if (!usedIds.some(u => u.id === x.id && u.version === x.version)) usedIds.push({id: x.id, version: x.version}); };
  const triggered = [];
  for (const t of meta.trig) for (const [, ...vals] of rowsOf(oracle, handle, t.rel, t.arity)) { triggered.push(instanceName(t.norm.id, vals)); used.add(t.norm.id); }
  for (const m of meta.match) if (rowsOf(oracle, handle, m.rel, 1 + m.norm.patVars.length).length) used.add(m.norm.id);
  for (const o of meta.override) if (rowsOf(oracle, handle, o.rel, 1 + o.target.patVars.length).length) used.add(o.over.id);
  const deviations = [];
  for (const d of meta.dev) {
    const applied = rowsOf(oracle, handle, d.apply, d.arity);
    if (applied.length) add(d.method);
    for (const vals of rowsOf(oracle, handle, d.rel, d.arity)) deviations.push({id: d.method.id, version: d.method.version, binding: d.method.binding, instance: [d.method.id, ...vals].join(' ')});
  }
  for (const n of tl.norms) if (used.has(n.id)) add(n);
  const run = steps.map(s => world.actions.get(s.action));
  for (const a of run) add({id: a.id, version: a.source.version});
  const uniq = xs => [...new Set(xs)];
  const strictV = violations.filter(v => v.kind === 'hard' && v.binding === 'strict');
  const relaxedV = violations.filter(v => v.kind === 'hard' && v.binding !== 'strict');
  const soft = violations.filter(v => v.kind === 'soft');
  return {
    compliant, infeasible: [], goalMissed: false, used: usedIds,
    compliance: {
      hard: strictV.length ? 'violated' : relaxedV.length ? 'relaxed' : 'ok', violated: uniq(strictV.map(v => v.id)),
      ...(relaxedV.length ? {relaxed: uniq(relaxedV.map(v => v.id))} : {}),
      soft_violations: soft.map(v => ({id: v.id, cost: v.cost})), deviations: uniq(deviations.map(d => d.id)),
      total_cost: run.reduce((c, a) => c + a.cost, 0) + soft.reduce((c, v) => c + v.cost, 0)
    },
    violations, deviations, triggered: uniq(triggered), unscoped: [], program: low.text
  };
}

function solveOnce(handle, qWires, excluded, budgetArg) {
  const ctx = buildContext({knowledge: handle.wires, queryWires: qWires, excluded, budgetArg});
  if (ctx.mq.mode !== 'conform' || !ctx.trace) throw new NotExpressibleError(['check_plan'], 'conform-core answers mode conform with a trace');
  const verdict = judgeByLowering(ctx, ctx.trace);
  const flags = {};
  if (ctx.contested.length) flags.contested = ctx.contested;
  const {program, ...rest} = verdict;
  return {strategy: 'conform-core', guarantee: 'exact', budget: ctx.budget.snapshot(false), notes: ['lowered to core rules'], ...flags, ...conformPacket(ctx, rest)};
}

const wantsConform = text => /^\s+mode\s+conform\s*$/m.test(text ?? '');

/** Answer a problem: conformance by the lowering, everything else by the oracle. */
export function ask(problem, budgetArg = {}) {
  if (!wantsConform(problem.query)) {
    // the oracle answers the core; a theory that holds modes-of-work wires (norm, method, procedure, amendment, trace) needs a planner or the conform mode
    const handle = problem.handle ?? prepare(problem.theory ?? '');
    const modes = handle.wires.filter(w => ['norm', 'method', 'procedure', 'amendment', 'trace'].includes(w.type));
    if (modes.length || /^@\S+\s+trace\s*$/m.test(problem.query ?? '')) throw new NotExpressibleError(['norms_hard'], `conform-core answers the core and mode conform; the theory holds ${modes.length ? modes[0].type : 'a trace'} wires that only a planner or the conform mode runs`);
    return jsReference.ask({...problem, handle}, budgetArg);
  }
  const t0 = performance.now();
  const handle = problem.handle ?? prepare(problem.theory ?? '');
  const qWires = readWires(problem.query, 'query');
  const ids = assumptionIds(handle.wires, qWires);
  const packet = withConditional(ids, excluded => solveOnce(handle, qWires, excluded, budgetArg));
  const requested = problem.requested ?? null;
  return {...packet, route: {requested, chosen: 'conform-core', reason: requested ? 'explicit request' : 'conformance lowered to core rules', fallback: null}, timings: {total: Math.round(performance.now() - t0)}};
}

/** check(plan, problem): judge a plan or a trace ({steps: [{action, args, at?}]}) by the lowering; `problem` = {theory | handle, asof?}. */
export function check(plan, problem, budgetArg = {}) {
  const handle = problem.handle ?? prepare(problem.theory ?? '');
  const q = readWires(`@q query\n  mode conform\n${problem.asof ? '  asof ' + problem.asof + '\n' : ''}`, 'query');
  const ctx = buildContext({knowledge: handle.wires, queryWires: q, budgetArg});
  const {program, ...verdict} = judgeByLowering(ctx, plan.steps.map(s => ({action: s.action, args: s.args, at: s.at ?? null})));
  return {strategy: 'conform-core', guarantee: 'exact', budget: ctx.budget.snapshot(false), notes: ['lowered to core rules'], ...conformPacket(ctx, verdict), route: {requested: null, chosen: 'conform-core', reason: 'check', fallback: null}};
}

export const conformCore = {...capabilities, capabilities, available, prepare, ask, update, check};
export default conformCore;
