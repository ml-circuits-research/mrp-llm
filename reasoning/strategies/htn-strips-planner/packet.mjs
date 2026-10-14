/**
 * The result packet of a plan or a conformance check (proposal 5.3 and 8.4): the plan, `used` with versions (the methods, norms
 * and actions that took part), `compliance` (hard ok|relaxed|violated, soft violations with costs, deviations, total cost), the
 * packet additions of the modes of work (`applied`, `choices`, `violations`, `blocked`, `relaxed`), the obligation instances
 * triggered and the host flags (`contested`, `scope_unknown`).
 *
 * `used` for a plan names every norm that SHAPED it: one whose pattern matched a step the engine could have taken at some state of
 * the plan (so the prohibition that pruned the cheaper alternative is used, 30a) or an obligation instance it triggered; a permission
 * is used when it overrode a prohibition. A norm whose `when` never held is not used.
 */
import {evaluateRun} from '../modes/run-eval.mjs';

const pushUnique = (list, x, key = e => e.id + '@' + e.version) => { if (!list.some(e => key(e) === key(x))) list.push(x); };
const versionList = (norms, ids) => norms.filter(n => ids.has(n.id)).map(n => ({id: n.id, version: n.version}));

/** Evaluate every applicable step of the plan's states as if it were taken (the pruning analysis behind `used` and `choices`). */
export function trialSteps(ctx, world, run, goalConsts) {
  const used = new Set();
  const trials = [];
  for (let s = 0; s < run.steps.length; s++) {
    for (const inst of world.applicable(run.states[s].ev)) {
      const lits = world.effect(run.states[s].lits, inst.action, inst.env);
      const clo = world.close(lits);
      const step = {action: inst.action.id, args: inst.params};
      const r = evaluateRun({world, norms: ctx.norms, edges: ctx.edges, run: {states: [...run.states.slice(0, s + 1), {ev: clo.ev, lits}], steps: [...run.steps.slice(0, s), step]}, goalConsts, final: false});
      for (const id of r.used) used.add(id);
      trials.push({at: s + 1, step, violated: r.violations.filter(v => v.severity === 'hard' && v.step === s + 1).map(v => v.id)});
    }
  }
  return {used, trials};
}

/** `choices`: what the engine optimised at each choice point, with the reason (why the alternatives lost). */
export function choicesOf(decisions, trials) {
  const out = [];
  for (const d of decisions.filter(x => ['choose', 'optional', 'any_order'].includes(x.kind))) {
    const forbidden = new Set(), inapplicable = [];
    for (const a of d.alts ?? []) {
      if (a.n.kind !== 'prim') continue;
      const args = a.n.terms.map(t => (typeof t === 'object' && t !== null ? a.env[t.var] : t));
      if (args.some(x => x === undefined)) continue;
      const hit = trials.filter(t => t.at === d.at && t.step.action === a.n.action && JSON.stringify(t.step.args) === JSON.stringify(args));
      if (!hit.length) inapplicable.push(`~${a.n.action} is not applicable`);
      for (const t of hit) t.violated.forEach(id => forbidden.add(id));
    }
    const all = d.alts?.length ?? 0, blockedAlts = forbidden.size + inapplicable.length;
    const why = [...inapplicable, ...(forbidden.size ? [`ruled out by ${[...forbidden].join(', ')}`] : [])].join('; ');
    const reason = d.kind === 'optional' ? (d.chosen === 'skip' ? 'skipped: it costs more than it helps' : 'needed by a later step')
      : blockedAlts && blockedAlts >= all ? `the only legal alternative (${why})` : blockedAlts ? `cheapest legal run (${why})` : 'cheapest legal run';
    out.push({step: d.at, kind: d.kind, chosen: d.chosen, alternatives: d.alternatives, reason});
  }
  return out;
}

/** The packet fields of a found plan. `relaxedIds` are the advisory norms the engine had to waive. */
export function planFields(ctx, world, goal, result, relaxedIds) {
  const node = result.node;
  const run = {states: node.states, steps: node.steps};
  const all = evaluateRun({world, norms: ctx.norms, edges: ctx.edges, run, goalConsts: goal.consts, final: true});
  const strict = all.violations.filter(v => v.severity === 'hard' && v.binding === 'strict');
  const relaxedV = all.violations.filter(v => v.severity === 'hard' && v.binding !== 'strict');
  const soft = all.violations.filter(v => v.severity === 'soft');
  const planCost = node.cost + node.state.extra;
  const softCost = soft.reduce((s, v) => s + v.cost, 0);
  const {used: trialUsed, trials} = trialSteps(ctx, world, run, goal.consts);
  const normIds = new Set([...all.used, ...trialUsed, ...all.triggered.map(t => t.id)]);
  const used = [];
  for (const d of node.state.decisions.filter(x => x.kind === 'method')) pushUnique(used, {id: d.id, version: d.version});
  for (const n of versionList(ctx.norms, normIds)) pushUnique(used, n);
  for (const s of node.steps) pushUnique(used, {id: s.action, version: s.version});
  const relaxed = [...new Set([...relaxedIds, ...relaxedV.map(v => v.id)])];
  const record = v => ({id: v.id, version: v.version, kind: v.severity, binding: v.binding, instance: v.inst, step: v.step, cost: v.cost, why: v.why});
  const out = {
    plan: {steps: node.steps.length, cost: planCost, names: node.steps.map(s => s.action), sequence: node.steps.map(s => ({action: s.action, args: s.args.map(String), text: s.text}))},
    used,
    compliance: {hard: strict.length ? 'violated' : relaxed.length ? 'relaxed' : 'ok', soft_violations: soft.map(v => ({id: v.id, cost: v.cost})), total_cost: planCost + softCost},
    choices: choicesOf(node.state.decisions, trials),
    violations: all.violations.map(record),
    applied: [
      ...node.state.decisions.filter(d => d.kind === 'method').map(d => ({id: d.id, version: d.version, kind: 'method', effect: `decomposed ${d.task}`})),
      ...ctx.norms.filter(n => normIds.has(n.id)).map(n => ({id: n.id, version: n.version, kind: 'norm', effect: n.modality + (all.triggered.some(t => t.id === n.id) ? ' (obligation triggered)' : '')}))
    ]
  };
  if (relaxed.length) out.relaxed = relaxed;
  if (strict.length) out.compliance.violated = [...new Set(strict.map(v => v.id))];
  if (all.triggered.length) out.obligations_triggered = all.triggered.map(t => t.key);
  if (all.unscoped.length) { out.obligation_unscoped = all.unscoped; out.notes = all.unscoped.map(id => `obligation_unscoped ${id}`); }
  return out;
}

/** Host flags every packet of the modes of work carries when they apply. */
export function hostFlags(ctx) {
  const out = {};
  if (ctx.contested.length) out.contested = ctx.contested;
  if (ctx.flags.scopeUnknown) out.scope_unknown = true;
  return out;
}

