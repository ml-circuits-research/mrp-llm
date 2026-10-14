/**
 * htn-strips-planner: forward state-space search over polarity-explicit states with method decomposition, hard norms that prune and
 * soft norms that cost (proposal 7, 8 and 8.7). Modes: `plan` (the cheapest legal run), `why_not` (with `via`), `abduce` (with `waive`
 * hypotheses), `procedure` (render without search) and `conform` (judge a trace); `check(plan)` is the strategy call of 5.2.
 *
 * Interface (5.1 to 5.3), same shape as the oracle (`../js-reference/`):
 *   capabilities          the feature declaration; a circuit that needs another feature throws NotExpressibleError, never weakened;
 *   prepare(theory)       parse the knowledge circuits once -> handle;
 *   ask(problem, budget)  problem = {theory | handle, query}; returns the packet (5.3) with the additions of 8.4:
 *                         plan, used (with versions), compliance, choices, applied, violations, blocked / blocked_by, relaxed,
 *                         obligations_triggered, contested, scope_unknown;
 *   check(plan, problem)  judge a given plan (or a trace) against the methods and norms in force: {status compliant|non_compliant, compliance}.
 *
 * Honest limits: plan length is capped by `maxDepth` (horizon: `budget_exhausted`, never `no_plan`); `until ... max N` reaching its
 * cap is `budget_exhausted` (depth); relational modes (select, exists, count, every, explain) and a relational why_not or abduce are
 * `not_expressible` here (use the oracle). `triggered_by` events are parsed but not acted on.
 */
import {readWires, assumptionIds} from '../modes/theory.mjs';
import {parseHypotheses} from '../modes/model.mjs';
import {withConditional} from '../js-reference/conditional.mjs';
import {CEILINGS, BudgetStop} from '../js-reference/budget.mjs';
import {ProgramError, NotExpressibleError, atomText} from '../js-reference/values.mjs';
import {buildContext, buildGoal, readVia, worldOf} from '../modes/context.mjs';
import {makeSearch, solveAll, relaxAdvisory, noPlanAnswer} from './plan-mode.mjs';
import {planFields, hostFlags} from './packet.mjs';
import {judgeRun} from './conform-mode.mjs';
import {conformPacket} from '../modes/verdict.mjs';
import {procedureAnswer} from './procedure.mjs';

export {ProgramError, NotExpressibleError};

export const id = 'htn-strips-planner';
export const available = async () => ({ok: true});

const FEATURES = ['plan', 'facts', 'rules', 'budget', 'versions', 'used', 'compare_in_rules', 'zero_arity', 'naf', 'closed_world', 'whatif', 'why_not', 'abduce', 'method', 'htn_choice', 'on_failure', 'norms_hard', 'norms_soft', 'temporal_norms', 'procedures', 'procedure_render', 'amendment', 'check_plan', 'blocked_info', 'abduce_waive', 'overrides', 'binding_advisory', 'norm_conflict', 'conform_asof', 'conform_deviation'];

export const capabilities = {
  id: 'htn-strips-planner',
  features: FEATURES,
  notExpressible: ['select', 'exists', 'count', 'every', 'explain', 'aggregate', 'default', 'integrity', 'interval', 'temporal', 'optimize'],
  delivery: 'slice',
  limits: {max_wires: Infinity, max_arity: 6, integer_range: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER], plan_horizon: CEILINGS.maxDepth},
  guarantee: 'bounded',
  provides: ['used', 'plan', 'compliance'],
  budgetKeys: ['maxNodes', 'maxDepth', 'maxRounds', 'maxFacts', 'maxJoins', 'maxFanout', 'timeoutMs'],
  determinism: 'deterministic',
  isolation: false
};

export function prepare(theory) {
  const knowledge = typeof theory === 'string' ? theory : theory?.knowledge ?? '';
  return {kind: 'htn-strips-planner-handle', knowledge, wires: theory?.wires ?? readWires(knowledge, 'knowledge')};
}

const base = (extra = {}) => ({strategy: 'htn-strips-planner', guarantee: 'exact', ...extra});

function planMode(ctx, via) {
  const world = worldOf(ctx);
  const goal = buildGoal(world, ctx.q);
  const search = makeSearch(ctx, world, goal, via);
  const solve = waived => solveAll(ctx, world, search, goal, {waived});
  const first = solve(new Set());
  const found = (r, relaxed) => ({status: 'plan_found', complete: true, ...planFields(ctx, world, goal, r.plan, relaxed), ...(r.stats.cut ? {guarantee: 'bounded', notes: ['optimality_bounded_by_horizon']} : {}), ...(r.stats.fellBack ? {notes: ['method_fallback_to_primitives']} : {})});
  if (first.plan) return found(first, []);
  if (!first.stats.cut && !first.stats.capHit) {
    const rel = relaxAdvisory(ctx, solve);
    if (rel) return found({plan: rel.plan, stats: rel.stats}, rel.waived);
  }
  const answer = noPlanAnswer(ctx, solve, first.stats, goal.text);
  if (via && answer.blocked) answer.blocked.step = via.text;
  return answer;
}

function* subsets(items, k, start = 0, chosen = []) {
  if (chosen.length === k) { yield chosen; return; }
  for (let i = start; i < items.length; i++) yield* subsets(items, k, i + 1, [...chosen, items[i]]);
}

/** Abduction over `waive` (and ordinary) hypotheses: the inclusion-minimal sets under which a legal plan (through `via`) exists. */
function abduceMode(ctx, via) {
  const cands = parseHypotheses(ctx.wires);
  if (!cands.length || (!via && !cands.some(h => h.waive.length))) throw new NotExpressibleError(['abduce'], 'planning abduction needs a `via` step or a waive hypothesis; a relational abduction (hypotheses that make an atom hold) is answered by the oracle');
  if (cands.length > ctx.budget.limits.maxHypotheses) return {status: 'budget_exhausted', complete: false, reason: 'hypotheses'};
  const world = worldOf(ctx);
  const goal = buildGoal(world, ctx.q);
  const search = makeSearch(ctx, world, goal, via);
  const found = [];
  let cut = false;
  for (let k = 0; k <= cands.length; k++) {
    for (const subset of subsets(cands, k)) {
      ctx.budget.count('maxCandidates');
      if (found.some(f => f.every(h => subset.includes(h)))) continue;
      const waived = new Set(subset.flatMap(h => h.waive));
      const extra = new Map();
      for (const h of subset) for (const a of h.atoms) extra.set(`${a.neg ? '-' : '+'}${a.p}|${JSON.stringify(a.args)}`, {neg: a.neg, p: a.p, args: a.args});
      const r = solveAll(ctx, world, search, goal, {waived, extraLits: extra.size ? extra : null});
      cut ||= r.stats.cut || Boolean(r.stats.capHit);
      if (r.plan) found.push(subset);
    }
    if (k === 0 && found.length) break;
  }
  const text = h => [...h.waive.map(id => `waive ${id}`), ...h.atoms.map(a => atomText(a.neg, a.p, a.args))].join(', ');
  const explanations = found.map(s => ({hypotheses: s.map(h => h.id), atoms: s.map(text), cost: s.reduce((c, h) => c + h.cost, 0)}))
    .sort((a, b) => a.cost - b.cost || a.atoms.length - b.atoms.length || (a.atoms.join() < b.atoms.join() ? -1 : 1));
  if (!explanations.length) return cut ? {status: 'budget_exhausted', complete: false, reason: 'horizon'} : {status: 'unknown', complete: true, reason: 'no_explanation', hypotheses: [], explanations: []};
  const shown = explanations.slice(0, ctx.mq.limit);
  return {status: 'hypotheses', complete: shown.length === explanations.length && !cut, hypotheses: shown.map(e => e.atoms), explanations: shown, ...(shown.length < explanations.length ? {truncated: true} : {})};
}

function conformMode(ctx) {
  if (!ctx.trace) throw new NotExpressibleError(['check_plan'], 'mode conform needs a trace');
  return conformPacket(ctx, judgeRun(ctx, ctx.trace));
}

function dispatch(ctx) {
  const mode = ctx.mq.mode;
  if (mode === 'plan') return planMode(ctx, readVia(ctx.mq));
  if (mode === 'why_not') {
    const via = readVia(ctx.mq);
    if (!via) throw new NotExpressibleError(['why_not'], 'a relational why_not is answered by the oracle; here why_not asks about a step of a plan (via ~action ...)');
    return planMode(ctx, via);
  }
  if (mode === 'abduce') return abduceMode(ctx, readVia(ctx.mq));
  if (mode === 'procedure') { const world = worldOf(ctx); return procedureAnswer(ctx, buildGoal(world, ctx.q)); }
  if (mode === 'conform') return conformMode(ctx);
  throw new NotExpressibleError([mode === 'select' ? 'select' : mode], `mode ${mode} is a relational mode, answered by the oracle`);
}

function solveOnce(handle, qWires, excluded, budgetArg) {
  const ctx = buildContext({knowledge: handle.wires, queryWires: qWires, excluded, budgetArg});
  try {
    const out = dispatch(ctx);
    return base({budget: ctx.budget.snapshot(false), retrieval: {complete: true, truncated: false, keyed: false, steps: 0, wires: ctx.program.facts.length, probes: 0}, ...hostFlags(ctx), ...out, notes: out.notes ?? []});
  } catch (e) {
    if (e instanceof BudgetStop) return base({status: 'budget_exhausted', complete: false, reason: e.reason, budget: ctx.budget.snapshot(true), used: [], notes: [], ...hostFlags(ctx)});
    throw e;
  }
}

/** Answer a problem. Throws ProgramError for an invalid circuit and NotExpressibleError for a circuit this strategy does not run. */
export function ask(problem, budgetArg = {}) {
  const t0 = performance.now();
  const handle = problem.handle ?? prepare(problem.theory ?? '');
  const qWires = readWires(problem.query, 'query');
  const ids = assumptionIds(handle.wires, qWires);
  const packet = withConditional(ids, excluded => solveOnce(handle, qWires, excluded, budgetArg));
  const requested = problem.requested ?? null;
  return {...packet, route: {requested, chosen: 'htn-strips-planner', reason: requested ? 'explicit request' : 'direct call to the planner', fallback: null}, timings: {total: Math.round(performance.now() - t0)}};
}

/**
 * check(plan, problem): judge a plan or a trace. `plan` = {steps: [{action, args, at?}], goal?: text of a `where`}; `problem` = {theory | handle,
 * asof?}. A plan is also required to be executable (every step applicable where it is performed) and to reach `goal` when given.
 */
export function check(plan, problem, budgetArg = {}) {
  const handle = problem.handle ?? prepare(problem.theory ?? '');
  const q = readWires(`@q query\n  mode conform\n${problem.asof ? '  asof ' + problem.asof + '\n' : ''}`, 'query');
  const ctx = buildContext({knowledge: handle.wires, queryWires: q, budgetArg});
  const world = worldOf(ctx);
  const goal = plan.goal ? buildGoal(world, readWires(`@qg query\n  mode plan\n  where ${plan.goal}\n`, 'goal').find(w => w.type === 'query')) : null;
  const verdict = judgeRun(ctx, plan.steps.map(s => ({action: s.action, args: s.args, at: s.at ?? null})), {check: true, goal});
  return {...base({budget: ctx.budget.snapshot(false)}), ...conformPacket(ctx, verdict), ...hostFlags(ctx), route: {requested: null, chosen: 'htn-strips-planner', reason: 'check', fallback: null}};
}

export const htnStripsPlanner = {...capabilities, capabilities, available, prepare, ask, check};
export default htnStripsPlanner;
