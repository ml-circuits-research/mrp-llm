/**
 * The planning modes over one context: `plan`, `why_not` (with `via`) and `abduce` (with `waive` hypotheses).
 *
 * How a goal is solved (`solveAll`): when the goal is one atom and approved methods apply to it, the engine decomposes by those
 * methods and may not plan from primitives while a STRICT one applies (binding strict); a method that has no legal run hands over
 * to its declared `on_failure` (another method, `replan`, or `abort`); an advisory method with no fallback may fall back to
 * primitives. With no applicable method the search is blind (STRIPS) under the norms. `waived` norms are not enforced at all.
 *
 * What an answer says when there is no plan: first the relaxation of ADVISORY hard norms is tried (smallest set, then cheapest
 * plan; they are listed in `relaxed`); then the strict ones are named: `blocked` with `blocked_by`, the union of the inclusion-minimal
 * sets of hard norms whose waiver unblocks the plan, plus the partner of an equal-strength conflict (a forbid and a hard obligation of
 * the same step, no override between them). A strict method that has no legal run and no fallback is `blocked` with the step and
 * the unmet requirement; only an exhausted search with nothing to name is `no_plan`; a search cut by the plan-length horizon is
 * `budget_exhausted` (horizon), a loop that reached its `max` is `budget_exhausted` (depth), never a negative answer.
 */
import {groundArgs} from '../js-reference/values.mjs';
import {PlanSearch} from './search.mjs';
import {Decomposer} from './decompose.mjs';

function* combinations(items, k, start = 0, chosen = []) {
  if (chosen.length === k) { yield chosen; return; }
  for (let i = start; i < items.length; i++) yield* combinations(items, k, i + 1, [...chosen, items[i]]);
}

const mergeStats = (into, s) => {
  into.cut ||= s.cut;
  into.capHit ??= s.capHit;
  into.untilCap ??= s.untilCap;
  for (const [k, v] of s.pruned) if (!into.pruned.has(k)) into.pruned.set(k, v);
  for (const c of s.conflicts) if (!into.conflicts.some(x => x.forbid === c.forbid && x.oblige === c.oblige)) into.conflicts.push(c);
  if (s.deepest && (!into.deepest || s.deepest.depth > into.deepest.depth)) into.deepest = s.deepest;
  into.verifyFailed ??= s.verifyFailed;
  into.noMethod ??= s.noMethod;
  into.expanded += s.expanded;
};

export const newStats = () => ({cut: false, capHit: null, untilCap: null, pruned: new Map(), conflicts: [], deepest: null, verifyFailed: null, noMethod: null, expanded: 0, attempts: [], aborted: false});

export function makeSearch(ctx, world, goal, via) {
  return new PlanSearch({world, goal, methods: ctx.methods, norms: ctx.norms, edges: ctx.edges, via, objective: ctx.policy.objective, budget: ctx.budget});
}

/** Solve the goal under a set of waived norms (and extra supposed literals). Returns {plan: result|null, stats}. */
export function solveAll(ctx, world, search, goal, {waived = new Set(), extraLits = null} = {}) {
  const stats = newStats();
  const lits0 = extraLits ? new Map([...world.initial(), ...extraLits]) : world.initial();
  const ev0 = world.close(lits0).ev;
  const dec = new Decomposer({world, methods: ctx.methods, goal, stats: newStats()});
  const task = goal.text;
  const args = goal.single ? groundArgs(goal.single.args, {}) : null;
  const cands = goal.single && args ? dec.applicableMethods(goal.single.p, args, ev0).filter(c => !waived.has(c.method.id)) : [];
  const attempt = top => {
    const r = search.run({waived, top: {...top, task}, extraLits});
    mergeStats(stats, r.stats);
    return r;
  };
  if (!cands.length) {
    const r = attempt({blind: true});
    return {plan: r.kind === 'plan' ? r : null, stats};
  }
  const fallbackIds = new Set(ctx.methods.flatMap(m => (m.onFailure?.method ? [m.onFailure.method] : [])));
  let stage = cands.filter(c => !fallbackIds.has(c.method.id));
  if (!stage.length) stage = cands;
  const tried = new Set();
  let replan = false;
  while (stage.length) {
    for (const c of stage) { tried.add(c.method.id); stats.attempts.push(c.method.id); }
    const r = attempt({methods: stage});
    if (r.kind === 'plan') return {plan: r, stats};
    const next = [];
    for (const c of stage) {
      const of = c.method.onFailure;
      if (of?.method) { for (const t of cands.filter(x => x.method.id === of.method && !tried.has(x.method.id))) if (!next.includes(t)) next.push(t); }
      else if (of === 'replan') replan = true;
      else if (of === 'abort') stats.aborted = true;
      else if (c.method.binding === 'advisory') replan = true;
    }
    stage = next;
  }
  if (replan && !stats.aborted) {
    const r = attempt({blind: true});
    if (r.kind === 'plan') { stats.fellBack = true; return {plan: r, stats}; }
  }
  return {plan: null, stats};
}

const planCost = node => node.cost + node.state.extra;

/** Phase 2: relax advisory hard norms (smallest set, then cheapest plan). Returns {plan, waived} or null. */
export function relaxAdvisory(ctx, solve) {
  const advisory = ctx.norms.filter(n => n.severity === 'hard' && n.binding === 'advisory').map(n => n.id);
  for (let k = 1; k <= Math.min(advisory.length, 3); k++) {
    let best = null;
    for (const subset of combinations(advisory, k)) {
      const r = solve(new Set(subset));
      if (r.plan && (!best || planCost(r.plan.node) < planCost(best.plan.node))) best = {plan: r.plan, waived: subset, stats: r.stats};
    }
    if (best) return best;
  }
  return null;
}

/** Inclusion-minimal sets of hard norms whose waiver gives a plan: [{ids, plan}]. */
export function minimalWaivers(ctx, solve, candidates, maxSize = 3) {
  const found = [];
  for (let k = 1; k <= Math.min(candidates.length, maxSize); k++) {
    for (const subset of combinations(candidates, k)) {
      if (found.some(f => f.ids.every(x => subset.includes(x)))) continue;
      const r = solve(new Set(subset));
      if (r.plan) found.push({ids: subset, plan: r.plan, stats: r.stats});
    }
  }
  return found;
}

/** Candidates for a waiver: the hard norms that pruned something, the partners of a conflict, else every hard norm (capped). */
export function waiveCandidates(ctx, stats) {
  const hard = ctx.norms.filter(n => n.severity === 'hard').map(n => n.id);
  const named = new Set([...stats.pruned.keys(), ...stats.conflicts.flatMap(c => [c.forbid, c.oblige])]);
  const pick = hard.filter(id => named.has(id));
  return (pick.length ? pick : hard).slice(0, 8);
}

/** The answer of a search that found no plan: budget cut, blocked by norms, blocked by a method, or no_plan. */
export function noPlanAnswer(ctx, solve, stats, goalText) {
  if (stats.capHit) return {status: 'budget_exhausted', complete: false, reason: stats.capHit === 'until' ? 'depth' : 'depth', notes: stats.capHit === 'until' ? [`until_max_reached ${stats.untilCap.step}`] : ['method_nesting_cap']};
  if (stats.cut) return {status: 'budget_exhausted', complete: false, reason: 'horizon', notes: ['plan_length_horizon']};
  const waivers = minimalWaivers(ctx, solve, waiveCandidates(ctx, stats));
  if (waivers.length) {
    const ids = [...new Set(waivers.flatMap(w => w.ids))];
    for (const id of [...ids]) for (const c of stats.conflicts) { if (c.forbid === id && !ids.includes(c.oblige)) ids.push(c.oblige); if (c.oblige === id && !ids.includes(c.forbid)) ids.push(c.forbid); }
    const first = stats.pruned.get(ids.find(i => stats.pruned.has(i)));
    return {status: 'blocked', complete: true, blocked_by: ids, blocked: {step: first?.step ?? null, requirement: first?.message ?? (first ? `${first.why} (${first.id})` : null), norm: first?.id ?? ids[0]}, notes: stats.conflicts.length ? ['norm_conflict'] : []};
  }
  // no small set unblocks the plan: if waiving every hard norm does, name the norms that pruned something (not claimed minimal)
  const everyHard = ctx.norms.filter(n => n.severity === 'hard').map(n => n.id);
  if (everyHard.length && solve(new Set(everyHard)).plan) {
    const ids = everyHard.filter(id => stats.pruned.has(id));
    const first = stats.pruned.get(ids[0]);
    return {status: 'blocked', complete: true, blocked_by: ids.length ? ids : everyHard, blocked: {step: first?.step ?? null, requirement: first?.message ?? (first ? `${first.why} (${first.id})` : null), norm: first?.id ?? everyHard[0]}, notes: ['blocked_by_not_minimal']};
  }
  if (stats.attempts.length) {
    const d = stats.deepest;
    return {status: 'blocked', complete: true, blocked_by: [], blocked: {step: d?.step ?? stats.noMethod ?? stats.verifyFailed ?? stats.attempts[0], requirement: d?.requirement ?? (stats.noMethod ? 'no method for the sub-task' : stats.verifyFailed ? 'the goal does not hold when the steps are done' : 'no legal run'), norm: null}, notes: [stats.aborted ? 'method_aborted' : 'method_without_legal_run'].concat(d?.method ? [`method ${d.method}`] : [])};
  }
  return {status: 'no_plan', complete: true, notes: []};
}

