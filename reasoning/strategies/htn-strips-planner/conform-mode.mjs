/**
 * `mode conform` and `check(plan)`: judge a performed trace (or a given plan) against the norms and methods in force.
 *
 * Each step is judged against the versions in force at ITS time (`at DATE`, else the query's `asof`, else now): a hard reset done in
 * January meets the January prohibition (case 37c). The run is replayed on the world (effects applied whatever the preconditions: a
 * trace is a record), the norms are evaluated over it (../modes/run-eval.mjs) and the methods in force are checked for deviation
 * (../modes/deviation.mjs). A hard STRICT violation or a deviation from a STRICT method makes the trace `non_compliant`; a violated
 * hard ADVISORY norm is reported as relaxed and a deviation from an ADVISORY method only listed; a soft violation costs.
 * `check(plan)` adds that every step must be applicable in the state it is performed in and, when a goal is given, that it is reached.
 */
import {ProgramError} from '../js-reference/values.mjs';
import {evaluateRun} from '../modes/run-eval.mjs';
import {checkMethods} from '../modes/deviation.mjs';
import {timeline} from '../modes/timeline.mjs';
import {World} from '../modes/world.mjs';
import {compileForce} from '../modes/theory.mjs';

/**
 * Everything a conformance verdict needs, as plain data (also used by the shadow test against the core lowering). The rules in force
 * at the time of each step close that step's state; the actions come from the wires in force at any step of the trace.
 */
export function judgeRun(ctx, steps, {check = false, goal = null} = {}) {
  const tl = timeline(ctx, steps);
  const {norms, methods, edges, inForceAt, days} = tl;
  const world = new World(compileForce(tl.unionWires, ctx.queryWires), ctx.budget);
  const worlds = new Map();
  const worldAt = i => { const t = tl.timeOf(i), k = t ?? ''; if (!worlds.has(k)) worlds.set(k, new World(compileForce(ctx.force(t), ctx.queryWires), ctx.budget)); return worlds.get(k); };

  let lits = world.initial();
  let ev = worldAt(1).close(lits).ev;
  const states = [{ev, lits}];
  const infeasible = [];
  const run = [];
  steps.forEach((s, k) => {
    const inst = world.instance(s.action, s.args, ev);
    if (!inst) throw new ProgramError('unknown_action', `the trace step ~${s.action} names no action (or with another number of arguments)`);
    if (!inst.applicable) infeasible.push({step: k + 1, text: '~' + [s.action, ...s.args].join(' '), requirement: world.unmetRequirement(inst.action, s.args, ev)});
    lits = world.effect(lits, inst.action, inst.env);
    ev = worldAt(k + 1).close(lits).ev;
    states.push({ev, lits});
    run.push({action: s.action, args: s.args, version: inst.action.source.version, cost: inst.action.cost});
  });
  const ev1 = evaluateRun({world, norms, edges, run: {states, steps: run}, final: true, inForce: inForceAt, days, goalConsts: new Set()});
  const dev = checkMethods({world, methods, steps: run, states, inForceAt});
  const strictV = ev1.violations.filter(v => v.severity === 'hard' && v.binding === 'strict');
  const relaxedV = ev1.violations.filter(v => v.severity === 'hard' && v.binding !== 'strict');
  const soft = ev1.violations.filter(v => v.severity === 'soft');
  const strictDev = dev.deviations.filter(d => d.binding === 'strict');
  const goalMissed = check && goal && !goal.holds(states.at(-1).ev);
  const compliant = !strictV.length && !strictDev.length && !(check && (infeasible.length || goalMissed));
  const uniq = xs => [...new Set(xs)];
  const used = [];
  const add = x => { if (!used.some(u => u.id === x.id && u.version === x.version)) used.push({id: x.id, version: x.version}); };
  for (const e of dev.engaged) add(e.method);
  for (const n of norms) if (ev1.used.has(n.id) || ev1.triggered.some(t => t.id === n.id)) add(n);
  for (const s of run) add({id: s.action, version: s.version});
  const stepCost = run.reduce((c, s) => c + s.cost, 0);
  return {
    compliant, infeasible, goalMissed, used,
    compliance: {
      hard: strictV.length ? 'violated' : relaxedV.length ? 'relaxed' : 'ok', violated: uniq(strictV.map(v => v.id)),
      ...(relaxedV.length ? {relaxed: uniq(relaxedV.map(v => v.id))} : {}),
      soft_violations: soft.map(v => ({id: v.id, cost: v.cost})), deviations: uniq(dev.deviations.map(d => d.id)), total_cost: stepCost + soft.reduce((c, v) => c + v.cost, 0)
    },
    violations: ev1.violations.map(v => ({id: v.id, version: v.version, kind: v.severity, binding: v.binding, instance: v.inst, step: v.step, cost: v.cost, why: v.why})),
    deviations: dev.deviations.map(d => ({id: d.id, version: d.version, binding: d.binding, instance: d.instance})),
    triggered: ev1.triggered.map(t => t.key), unscoped: ev1.unscoped, norms, states
  };
}
