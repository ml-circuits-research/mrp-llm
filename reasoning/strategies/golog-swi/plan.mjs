/**
 * The planning answers of golog-swi, from the runs the interpreter enumerated (golog.pl): every legal execution of the candidate
 * methods, each already judged by the norms. Selection is here, in JavaScript, over data: the cheapest run that no hard norm rules
 * out (the objective of the policy), ties broken by search order (the order of the program: the first run found wins).
 *
 * Staging follows the proposal (8.2, `on_failure`): the methods that are not a declared fallback are tried first; a method with no
 * legal run hands over to its `on_failure` method; `replan` and an advisory method with no fallback would need blind search and are
 * `not_expressible` here. When no run is legal the answer first tries to RELAX advisory hard norms (smallest set, then cheapest run;
 * they are listed in `relaxed`); then it names the hard norms whose waiver would unblock a run (`blocked_by`, inclusion-minimal
 * sets), or the method that has no legal run.
 */
import {NotExpressibleError, atomText, showValue} from '../js-reference/values.mjs';
import {instanceName} from '../modes/model.mjs';

function* combinations(items, k, start = 0, chosen = []) {
  if (chosen.length === k) { yield chosen; return; }
  for (let i = start; i < items.length; i++) yield* combinations(items, k, i + 1, [...chosen, items[i]]);
}

const sameArg = (a, b) => String(a) === String(b);

/** Does a run perform the `via` step (action and ground arguments; a variable is a wildcard)? */
const throughVia = (run, via) => !via || run.steps.some(s => s.action === via.action && s.args.length === via.terms.length && via.terms.every((t, i) => (typeof t === 'object' && t !== null) || sameArg(t, s.args[i])));

/** The violations of a run that count under a set of waived norms. */
const counted = (run, waived) => run.eval.violations.filter(v => !waived.has(v.id));
const hardOf = (run, waived) => counted(run, waived).filter(v => v.severity === 'hard');
const softCost = (run, waived) => counted(run, waived).filter(v => v.severity === 'soft').reduce((c, v) => c + v.cost, 0);

/** Objective of a run (lower is better): cost = plan cost plus soft costs; violations = their number; lexicographic = both, violations first. */
function score(run, waived, objective) {
  const cost = run.cost + softCost(run, waived);
  const n = counted(run, waived).length;
  return objective === 'violations' ? [n, cost] : objective === 'lexicographic' ? [n, cost] : [cost, n];
}
const better = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

/**
 * Solve the goal under a set of waived norms. Returns {run, stage, stats} with run = the chosen run (or null) and `stats` what the
 * attempt learned (the runs that violated, the methods tried, a cap).
 */
export function solve(ctx, data, via, waived = new Set()) {
  const stats = {tried: [], violating: [], executable: false, capped: null, aborted: false, replan: false};
  const byId = new Map(data.per_method.map(m => [m.method, m]));
  for (const m of data.per_method) if (m.capped && !stats.capped) stats.capped = m.capped;
  const cands = data.candidates.filter(id => !waived.has(id)).map(id => ctx.methods.find(m => m.id === id)).filter(Boolean);
  const fallbackIds = new Set(ctx.methods.flatMap(m => (m.onFailure?.method ? [m.onFailure.method] : [])));
  let stage = cands.filter(m => !fallbackIds.has(m.id));
  if (!stage.length) stage = cands;
  const tried = new Set();
  while (stage.length) {
    stage.forEach(m => { tried.add(m.id); stats.tried.push(m.id); });
    const runs = stage.flatMap(m => (byId.get(m.id)?.runs ?? []).map(r => ({...r, method: m.id}))).filter(r => throughVia(r, via));
    if (runs.length) stats.executable = true;
    let best = null;
    for (const r of runs) {
      if (hardOf(r, waived).length) { stats.violating.push(r); continue; }
      const s = score(r, waived, ctx.policy.objective);
      if (!best || better(s, best.s)) best = {run: r, s};
    }
    if (best) return {run: best.run, stageRuns: runs, stats};
    const next = [];
    for (const m of stage) {
      const of = m.onFailure;
      if (of?.method) { for (const t of cands.filter(x => x.id === of.method && !tried.has(x.id))) if (!next.includes(t)) next.push(t); }
      else if (of === 'replan') stats.replan = true;
      else if (of === 'abort') stats.aborted = true;
      else if (m.binding === 'advisory') stats.replan = true;
    }
    stage = next;
  }
  return {run: null, stageRuns: [], stats};
}

/** Phase 2: relax advisory hard norms (smallest set, then cheapest run). Returns {sol, waived} or null. */
export function relaxAdvisory(ctx, data, via) {
  const advisory = ctx.norms.filter(n => n.severity === 'hard' && n.binding === 'advisory').map(n => n.id);
  for (let k = 1; k <= Math.min(advisory.length, 3); k++) {
    let best = null;
    for (const subset of combinations(advisory, k)) {
      const sol = solve(ctx, data, via, new Set(subset));
      if (!sol.run) continue;
      const s = score(sol.run, new Set(subset), ctx.policy.objective);
      if (!best || better(s, best.s)) best = {sol, waived: subset, s};
    }
    if (best) return best;
  }
  return null;
}

const versionList = (norms, ids) => norms.filter(n => ids.has(n.id)).map(n => ({id: n.id, version: n.version}));
const pushUnique = (list, x) => { if (!list.some(e => e.id === x.id && e.version === x.version)) list.push(x); };

const nameText = n => (typeof n === 'string' ? n : [`~${n.action}`, ...n.args.map(showValue)].join(' '));

/** `choices`: what the engine optimised at each choice point of the chosen run, with the reason (why the alternatives lost). */
function choicesOf(choices, stageRuns) {
  return choices.map(c => {
    const alts = c.alternatives.map(nameText);
    const legal = new Set(stageRuns.filter(r => !r.eval.violations.some(v => v.severity === 'hard')).flatMap(r => r.choices.filter(x => x.step === c.step && x.kind === c.kind).map(x => nameText(x.chosen))));
    const reason = c.kind === 'optional' ? (c.chosen === 'skip' ? 'skipped: it costs more than it helps' : 'needed by a later step')
      : alts.length > 1 && legal.size <= 1 ? 'the only legal alternative' : 'cheapest legal run';
    return {step: c.step, kind: c.kind, chosen: nameText(c.chosen), alternatives: alts, reason};
  });
}

/** The packet fields of a found plan. */
export function planPacket(ctx, goal, sol, relaxedIds, trialUsed = []) {
  const run = sol.run;
  const waived = new Set(relaxedIds);
  const all = run.eval;
  const violations = all.violations.filter(v => !waived.has(v.id));
  const strict = violations.filter(v => v.severity === 'hard' && v.binding === 'strict');
  const relaxedV = violations.filter(v => v.severity === 'hard' && v.binding !== 'strict');
  const soft = violations.filter(v => v.severity === 'soft');
  // the norms that SHAPED the plan: one that applied in this run, one matched by a step the engine could have taken at some state of the
  // run (a prohibition that ruled the cheaper alternative out: `trialUsed`), or an obligation instance the run triggered
  const normIds = new Set([...all.used, ...all.triggered.map(t => t.id), ...trialUsed]);
  const used = [];
  for (const d of run.decisions) pushUnique(used, {id: d.id, version: d.version});
  for (const n of versionList(ctx.norms, normIds)) pushUnique(used, n);
  for (const s of run.steps) pushUnique(used, {id: s.action, version: s.version});
  const relaxed = [...new Set([...relaxedIds, ...relaxedV.map(v => v.id)])];
  const planCost = run.cost;
  const softTotal = soft.reduce((c, v) => c + v.cost, 0);
  const record = v => ({id: v.id, version: v.version, kind: v.severity, binding: v.binding, instance: instanceName(v.id, v.values), step: v.step, cost: v.cost, why: v.why});
  const out = {
    plan: {steps: run.steps.length, cost: planCost, names: run.steps.map(s => s.action), sequence: run.steps.map(s => ({action: s.action, args: s.args.map(String), text: atomText(false, s.action, s.args)}))},
    used,
    compliance: {hard: strict.length ? 'violated' : relaxed.length ? 'relaxed' : 'ok', soft_violations: soft.map(v => ({id: v.id, cost: v.cost})), total_cost: planCost + softTotal},
    violations: violations.map(record),
    applied: [
      ...run.decisions.map(d => ({id: d.id, version: d.version, kind: 'method', effect: `decomposed ${goal.text}`})),
      ...ctx.norms.filter(n => normIds.has(n.id)).map(n => ({id: n.id, version: n.version, kind: 'norm', effect: n.modality + (all.triggered.some(t => t.id === n.id) ? ' (obligation triggered)' : '')}))
    ]
  };
  out.choices = choicesOf(run.choices, sol.stageRuns);
  if (relaxed.length) out.relaxed = relaxed;
  if (strict.length) out.compliance.violated = [...new Set(strict.map(v => v.id))];
  if (all.triggered.length) out.obligations_triggered = all.triggered.map(t => instanceName(t.id, t.values));
  if (all.unscoped.length) { out.obligation_unscoped = all.unscoped; out.notes = all.unscoped.map(id => `obligation_unscoped ${id}`); }
  return out;
}

/** Inclusion-minimal sets of hard norms whose waiver would give a legal run (the violations of the runs that otherwise qualify). */
function minimalWaivers(data, ctx, via) {
  const sets = [];
  for (const m of data.per_method) for (const r of m.runs) {
    if (!throughVia(r, via)) continue;
    const ids = [...new Set(r.eval.violations.filter(v => v.severity === 'hard').map(v => v.id))].sort();
    if (ids.length && !sets.some(s => s.join() === ids.join())) sets.push(ids);
  }
  return sets.filter(s => !sets.some(o => o !== s && o.length < s.length && o.every(x => s.includes(x)))).sort((a, b) => a.length - b.length || (a.join() < b.join() ? -1 : 1));
}

/** The answer of a search that found no plan: a cut, blocked by norms, blocked by a method, or no_plan. */
export function noPlanAnswer(ctx, data, via, sol, goal) {
  const stats = sol.stats;
  if (stats.capped) return {status: 'budget_exhausted', complete: false, reason: stats.capped.kind === 'until' ? 'depth' : 'nodes', notes: [stats.capped.kind === 'until' ? `until_max_reached ${stats.capped.max}` : 'run_enumeration_cap']};
  if (stats.replan) throw new NotExpressibleError(['plan'], 'a method with no legal run falls back to blind planning (replan or advisory binding), which golog-swi does not do');
  const waivers = minimalWaivers(data, ctx, via);
  if (waivers.length) {
    const ids = [...new Set(waivers.flat())];
    const norm = ctx.norms.find(n => n.id === ids[0]);
    let viol = null, stepText = null;
    for (const r of data.per_method.flatMap(m => m.runs)) {
      const v = r.eval.violations.find(x => x.id === ids[0]);
      if (v) { viol = v; const s = r.steps[v.step - 1]; stepText = s ? [`~${s.action}`, ...s.args.map(showValue)].join(' ') : null; break; }
    }
    return {status: 'blocked', complete: true, blocked_by: ids, blocked: {step: via?.text ?? stepText, requirement: viol?.message ?? (viol ? `${viol.why} (${viol.id})` : null), norm: norm?.id ?? ids[0]}, notes: []};
  }
  if (stats.tried.length) {
    // the deepest step that could not be performed names the unmet requirement
    const fails = data.per_method.filter(m => stats.tried.includes(m.method)).flatMap(m => m.fails.map(f => ({...f, method: m.method})));
    let d = null;
    for (const f of fails) if (!d || f.depth > d.depth) d = f;
    const step = d ? [`~${d.action}`, ...d.args.map(showValue)].join(' ') : null;
    const requirement = d ? (d.mode === 'pos' ? '' : d.mode + ' ') + atomText(false, d.p, d.pargs) : null;
    return {status: 'blocked', complete: true, blocked_by: [], blocked: {step: step ?? stats.tried[0], requirement: requirement ?? 'no legal run of the method', norm: null}, notes: [stats.aborted ? 'method_aborted' : 'method_without_legal_run'].concat(d ? [`method ${d.method}`] : [])};
  }
  throw new NotExpressibleError(['plan'], `no approved method achieves ${goal.text} (blind planning is the htn-strips-planner's)`);
}
