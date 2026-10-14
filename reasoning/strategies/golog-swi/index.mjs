/**
 * FROZEN (owner decision of 2026-10-01, in chat): kept as code and tests, no longer a default smoke column and not a routing candidate.
 * Reason: it overlaps `htn-strips-planner` (plans and methods) and `conform` (conformance of a trace), which cover the same cases
 * with fewer moving parts (a subprocess per run). Run it only on request: `node eval/smoke-reasoning/run.mjs --with-frozen` or
 * `--adapter golog-swi`; `tests/engines/strategy-golog-swi.test.mjs` keeps it honest.
 *
 * golog-swi: a small Golog interpreter in SWI-Prolog for the strict procedures (methods) of the modes of work.
 *
 * WHAT IT IS. A method of the circuits is a Golog program: sequence, nondeterministic choice (`choose`), optional steps, `any_order`,
 * tests (`if`), bounded loops (`until ... max N`), `pick`, primitive steps (an action: its preconditions are TESTS on the state, its
 * effects change it) and sub-tasks (a call of another method). The interpreter (golog.pl) chooses only at the choice points and
 * enumerates every legal run. The NORMS are tests on the primitive actions of a run (the definitions of proposal 8.2, evaluated over
 * the whole run), so a plan and a recorded trace are judged by one function. The derived relations of the circuits (rules, `absent`)
 * are the tabled program of prolog-tabling over the CURRENT state.
 *
 * WHAT IT COVERS (capabilities). Modes: `plan` for a goal that is one task atom some approved method achieves (the cheapest legal run
 * of the program under the objective, ties by search order; `on_failure $method` fallbacks; advisory hard norms relaxed and listed;
 * `blocked` with `blocked_by` when the hard norms rule every run out), `why_not` with `via`, `abduce` over `waive` hypotheses,
 * `procedure` (render the approved method as of `asof`), `conform` (a recorded trace judged against the norms in force at the time
 * of each step and against the strict methods: a deviation is non-compliance) and `check(plan)`. Wires: action, method (all step
 * forms but `achieve`), norm (forbid / oblige / permit with the qualifiers always, before, after, at_most_once, sometime, within,
 * severity hard and soft, binding strict and advisory, priority and overrides), procedure, amendment and `if` what-ifs (the shared
 * governance), versions and `asof`.
 *
 * WHAT IT DOES NOT COVER (`not_expressible`, never weakened): blind planning (a goal that no approved method achieves, an `achieve`
 * step, `replan`: the htn-strips-planner), relational modes (select, exists, count, every, explain, a relational why_not or abduce:
 * the oracle and the other engines), abduction over atom hypotheses, a norm conflict of equal strength, `triggered_by` events,
 * rule versions that differ between the steps of a trace, constraints.
 *
 * The planner (`../htn-strips-planner/`) decides the same cases; the two implement the same definitions independently (this one in
 * Prolog, over complete runs; the planner by search with monitors) and the shadow runs compare them.
 */
import {buildContext} from '../modes/context.mjs';
import {readWires, assumptionIds, compileForce} from '../modes/theory.mjs';
import {parseHypotheses, stepLines, instanceName} from '../modes/model.mjs';
import {goalLeaves} from '../modes/world.mjs';
import {timeline} from '../modes/timeline.mjs';
import {withConditional} from '../js-reference/conditional.mjs';
import {conditionAlts} from '../js-reference/program.mjs';
import {CEILINGS} from '../js-reference/budget.mjs';
import {unify} from '../js-reference/join.mjs';
import {ProgramError, NotExpressibleError, atomText, isVarTerm, toTerm} from '../js-reference/values.mjs';
import {probeSwipl} from '../prolog-tabling/swipl.mjs';
import {q as quote, termText} from '../prolog-tabling/codegen.mjs';
import {worldText, hasForm} from './emit.mjs';
import {runGolog} from './run.mjs';
import {solve, relaxAdvisory, planPacket, noPlanAnswer} from './plan.mjs';

export {ProgramError, NotExpressibleError};

const ID = 'golog-swi';
const FEATURES = ['plan', 'method', 'htn_choice', 'on_failure', 'norms_hard', 'norms_soft', 'temporal_norms', 'procedures', 'procedure_render', 'check_plan', 'blocked_info', 'why_not', 'abduce', 'abduce_waive', 'versions', 'used', 'zero_arity', 'whatif', 'amendment', 'naf', 'closed_world', 'conform_asof', 'conform_deviation', 'overrides', 'binding_advisory', 'budget', 'compare_in_rules'];

export const capabilities = {
  id: ID,
  features: FEATURES,
  notExpressible: ['select', 'exists', 'count', 'every', 'explain', 'aggregate', 'default', 'integrity', 'interval', 'temporal', 'constraint', 'optimize', 'norm_conflict'],
  delivery: 'slice',
  limits: {max_wires: Infinity, max_arity: 6, integer_range: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]},
  guarantee: 'exact',
  provides: ['used', 'plan', 'compliance'],
  budgetKeys: ['timeoutMs', 'maxJoins', 'maxNodes'],
  determinism: 'deterministic',
  isolation: true
};

export function available() { return probeSwipl(); }

export function prepare(theory) {
  const knowledge = typeof theory === 'string' ? theory : theory?.knowledge ?? '';
  return {kind: 'golog-swi-handle', knowledge, wires: theory?.wires ?? readWires(knowledge, 'knowledge')};
}

const base = (extra = {}) => ({strategy: ID, guarantee: 'exact', ...extra});
const f1 = (w, k) => w.fields.find(f => f.key === k);
const fAll = (w, k) => w.fields.filter(f => f.key === k);

function limitsOf(budget) {
  const L = budget.limits;
  return {wallMs: L.timeoutMs, infer: L.maxJoins < CEILINGS.maxJoins ? L.maxJoins : 1e12, nodes: L.maxNodes};
}

/** The goal of a planning query: ordered leaf alternatives, the constants it mentions, the single positive atom (a task) when it is one. */
function goalOf(ctx) {
  const q = ctx.q;
  const alts = conditionAlts(fAll(q, 'where'), q.id);
  const leaves = goalLeaves(alts, ctx.program.closed, q.id);
  const consts = new Set(alts.flatMap(a => a.flatMap(l => (l.kind === 'atom' ? l.args.filter(t => !isVarTerm(t)) : []))));
  const only = alts.length === 1 && alts[0].length === 1 && alts[0][0].kind === 'atom' && alts[0][0].mode === 'pos' ? alts[0][0] : null;
  return {alts: leaves, consts, single: only ? {p: only.p, args: only.args} : null, text: fAll(q, 'where').map(f => f.value.trim()).join(' ')};
}

function readVia(mq) {
  if (!mq.via) return null;
  if (!mq.via[0]?.startsWith('~')) throw new NotExpressibleError(['blocked_info'], 'via names a step: ~action term...');
  return {action: mq.via[0].slice(1), terms: mq.via.slice(1).map(toTerm), text: mq.via.join(' ')};
}

/** Enumerate the runs of the candidate methods for a goal. */
function enumerate(ctx, goal, extraNotes = []) {
  for (const m of ctx.methods) if (hasForm(m.steps, 'achieve')) throw new NotExpressibleError(['plan'], `method ${m.id} has an achieve step (blind search), which golog-swi does not do`);
  if (!goal.single) throw new NotExpressibleError(['plan'], 'golog-swi answers a goal that is one task atom; a conjunction is planned by the htn-strips-planner');
  const limits = limitsOf(ctx.budget);
  const args = `[${goal.single.args.map(termText).join(',')}]`;
  const text = worldText(ctx, goal);
  const run = runGolog({text, taskGoal: `gl_plan_task(${quote(goal.single.p)}, ${args}, ${limits.nodes}, D), gl_emit(D)`, limits});
  void extraNotes;
  return run;
}

/** The norms matched by a step the engine could have taken at some state of the chosen run (second Prolog run, on the same world). */
function trialNorms(ctx, goal, run) {
  const trace = `[${run.steps.map(s => `t(${quote(s.action)},[${s.args.map(termText).join(',')}])`).join(',')}]`;
  const consts = `[${[...goal.consts].map(termText).join(',')}]`;
  const out = runGolog({text: worldText(ctx, goal), taskGoal: `gl_trial_task(${trace}, ${consts}, D), gl_emit(D)`, limits: limitsOf(ctx.budget)});
  return out.data?.used ?? [];
}

function planMode(ctx, via, goal) {
  const run = enumerate(ctx, goal);
  if (run.exhausted) return {status: 'budget_exhausted', complete: false, reason: run.exhausted};
  const data = run.data;
  const first = solve(ctx, data, via);
  if (first.run) return {status: 'plan_found', complete: true, ...planPacket(ctx, goal, first, [], trialNorms(ctx, goal, first.run))};
  if (!first.stats.capped) {
    const rel = relaxAdvisory(ctx, data, via);
    if (rel) return {status: 'plan_found', complete: true, ...planPacket(ctx, goal, rel.sol, rel.waived, trialNorms(ctx, goal, rel.sol.run))};
  }
  const answer = noPlanAnswer(ctx, data, via, first, goal);
  return answer;
}

function* subsets(items, k, start = 0, chosen = []) {
  if (chosen.length === k) { yield chosen; return; }
  for (let i = start; i < items.length; i++) yield* subsets(items, k, i + 1, [...chosen, items[i]]);
}

/** Abduction over `waive` hypotheses: the inclusion-minimal sets of norms whose waiver gives a legal run (through `via`). */
function abduceMode(ctx, via, goal) {
  const cands = parseHypotheses(ctx.wires);
  if (!cands.length || (!via && !cands.some(h => h.waive.length))) throw new NotExpressibleError(['abduce'], 'planning abduction needs a `via` step or a waive hypothesis; a relational abduction is answered by the oracle');
  if (cands.some(h => h.atoms.length)) throw new NotExpressibleError(['abduce'], 'golog-swi abduces over waive hypotheses only (atom hypotheses change the state and are the planner\'s)');
  if (cands.length > ctx.budget.limits.maxHypotheses) return {status: 'budget_exhausted', complete: false, reason: 'hypotheses'};
  const run = enumerate(ctx, goal);
  if (run.exhausted) return {status: 'budget_exhausted', complete: false, reason: run.exhausted};
  const found = [];
  for (let k = 0; k <= cands.length; k++) {
    for (const subset of subsets(cands, k)) {
      ctx.budget.count('maxCandidates');
      if (found.some(f => f.every(h => subset.includes(h)))) continue;
      const waived = new Set(subset.flatMap(h => h.waive));
      if (solve(ctx, run.data, via, waived).run) found.push(subset);
    }
    if (k === 0 && found.length) break;
  }
  const text = h => h.waive.map(id => `waive ${id}`).join(', ');
  const explanations = found.map(s => ({hypotheses: s.map(h => h.id), atoms: s.map(text), cost: s.reduce((c, h) => c + h.cost, 0)}))
    .sort((a, b) => a.cost - b.cost || a.atoms.length - b.atoms.length || (a.atoms.join() < b.atoms.join() ? -1 : 1));
  if (!explanations.length) return {status: 'unknown', complete: true, reason: 'no_explanation', hypotheses: [], explanations: []};
  const shown = explanations.slice(0, ctx.mq.limit);
  return {status: 'hypotheses', complete: shown.length === explanations.length, hypotheses: shown.map(e => e.atoms), explanations: shown, ...(shown.length < explanations.length ? {truncated: true} : {})};
}

/** `mode procedure`: render the approved method for a task as of `asof`, without running anything. */
function procedureMode(ctx, goal) {
  const task = goal.single;
  if (!task) return {status: 'unknown', complete: true, reason: 'no_task', used: [], notes: ['procedure_needs_one_task_atom']};
  const wild = task.args.some(isVarTerm);
  const matching = ctx.methods.filter(m => m.achieves.p === task.p && m.achieves.terms.length === task.args.length && (wild || unify(m.achieves.terms, task.args, {}) !== null));
  if (!matching.length) return {status: 'unknown', complete: true, reason: 'no_procedure', used: []};
  matching.sort((a, b) => b.version - a.version || (a.id < b.id ? -1 : 1));
  const m = matching[0];
  const norms = ctx.norms.map(n => ({id: n.id, version: n.version, modality: n.modality, severity: n.severity, binding: n.binding}));
  return {
    status: 'procedure_found', complete: true,
    procedure: {id: m.id, version: m.version, binding: m.binding, steps: stepLines(m.wire), ...(m.onFailure ? {on_failure: m.onFailure.method ? '$' + m.onFailure.method : m.onFailure} : {}), norms},
    ...(matching.length > 1 ? {alternatives: matching.slice(1).map(x => ({id: x.id, version: x.version}))} : {}),
    used: [{id: m.id, version: m.version}]
  };
}

// ------------------------------------------------------------------------------------------------------------ conform

/** Do the rules in force differ between the steps of the trace? golog-swi closes every state with ONE rule set. */
function ruleSetsDiffer(ctx, tl, steps) {
  const times = [...new Set(steps.map((_, k) => tl.timeOf(k + 1) ?? ''))];
  const sig = t => ctx.force(t || null).filter(w => ['rule', 'default', 'aggregate', 'integrity', 'action'].includes(w.type)).map(w => w.id).sort().join();
  return new Set(times.map(sig)).size > 1;
}

const inForceList = (tl, x, n) => Array.from({length: n + 1}, (_, i) => i).filter(i => tl.inForceAt(x, i));

/** Judge a recorded trace (or a plan: `check`) against the norms and strict methods in force. */
function judgeTrace(ctx, steps, {check = false, goal = null} = {}) {
  const tl = timeline(ctx, steps);
  if (ruleSetsDiffer(ctx, tl, steps)) throw new NotExpressibleError(['conform_asof'], 'the rules in force differ between the steps of the trace; golog-swi judges a trace against one rule set');
  const program = compileForce(tl.unionWires, ctx.queryWires);
  const sub = {program, methods: tl.methods, norms: tl.norms, edges: tl.edges};
  for (const m of tl.methods) if (hasForm(m.steps, 'achieve')) void m; // checked lazily: only an ENGAGED method with such a step is refused
  const goalData = goal ?? null;
  const text = worldText(sub, goalData);
  const n = steps.length;
  const inf = `[${[...tl.norms, ...tl.methods].map(x => `${quote(x.id)}-[${inForceList(tl, x, n).join(',')}]`).join(',')}]`;
  const days = tl.days ? `[${tl.days.join(',')}]` : 'null';
  const trace = `[${steps.map(s => `t(${quote(s.action)},[${s.args.map(termText).join(',')}])`).join(',')}]`;
  const limits = limitsOf(ctx.budget);
  const run = runGolog({text, taskGoal: `gl_conform_task(${trace}, ${days}, ${inf}, D), gl_emit(D)`, limits});
  if (run.exhausted) return {exhausted: run.exhausted};
  const d = run.data;
  const norms = tl.norms;
  const viol = d.eval.violations.map(v => ({...v, inst: instanceName(v.id, v.values)}));
  const strictV = viol.filter(v => v.severity === 'hard' && v.binding === 'strict');
  const relaxedV = viol.filter(v => v.severity === 'hard' && v.binding !== 'strict');
  const soft = viol.filter(v => v.severity === 'soft');
  const strictDev = d.deviations.filter(x => x.binding === 'strict');
  const goalMissed = check && goal && !d.goal_ok;
  const compliant = !strictV.length && !strictDev.length && !(check && (d.infeasible.length || goalMissed));
  const uniq = xs => [...new Set(xs)];
  const used = [];
  const add = x => { if (!used.some(u => u.id === x.id && u.version === x.version)) used.push({id: x.id, version: x.version}); };
  for (const e of d.engaged) add(e);
  for (const nrm of norms) if (d.eval.used.includes(nrm.id) || d.eval.triggered.some(t => t.id === nrm.id)) add(nrm);
  for (const s of d.steps) add({id: s.action, version: s.version});
  const stepCost = d.steps.reduce((c, s) => c + s.cost, 0);
  return {
    compliant, infeasible: d.infeasible, goalMissed, used,
    compliance: {
      hard: strictV.length ? 'violated' : relaxedV.length ? 'relaxed' : 'ok', violated: uniq(strictV.map(v => v.id)),
      ...(relaxedV.length ? {relaxed: uniq(relaxedV.map(v => v.id))} : {}),
      soft_violations: soft.map(v => ({id: v.id, cost: v.cost})), deviations: uniq(d.deviations.map(x => x.id)), total_cost: stepCost + soft.reduce((c, v) => c + v.cost, 0)
    },
    violations: viol.map(v => ({id: v.id, version: v.version, kind: v.severity, binding: v.binding, instance: v.inst, step: v.step, cost: v.cost, why: v.why})),
    deviations: d.deviations.map(x => ({id: x.id, version: x.version, binding: x.binding, instance: x.instance})),
    triggered: d.eval.triggered.map(t => instanceName(t.id, t.values)), unscoped: d.eval.unscoped
  };
}

function conformPacket(v) {
  if (v.exhausted) return {status: 'budget_exhausted', complete: false, reason: v.exhausted};
  const out = {
    status: v.compliant ? 'compliant' : 'non_compliant', complete: true, compliance: v.compliance, used: v.used,
    violations: v.violations, deviations: v.deviations
  };
  if (v.triggered.length) out.obligations_triggered = v.triggered;
  if (v.unscoped.length) { out.obligation_unscoped = v.unscoped; out.notes = v.unscoped.map(id => `obligation_unscoped ${id}`); }
  if (v.infeasible.length) out.infeasible = v.infeasible;
  if (v.goalMissed) out.notes = [...(out.notes ?? []), 'goal_not_reached'];
  if (v.compliance.relaxed) out.relaxed = v.compliance.relaxed;
  return out;
}

function conformMode(ctx) {
  if (!ctx.trace) throw new NotExpressibleError(['check_plan'], 'mode conform needs a trace');
  return conformPacket(judgeTrace(ctx, ctx.trace));
}

// -------------------------------------------------------------------------------------------------------------- ask

function dispatch(ctx) {
  const mode = ctx.mq.mode;
  if (mode === 'conform') return conformMode(ctx);
  if (!['plan', 'why_not', 'abduce', 'procedure'].includes(mode)) throw new NotExpressibleError([mode], `mode ${mode} is a relational mode, answered by the oracle`);
  const goal = goalOf(ctx);
  const via = readVia(ctx.mq);
  if (mode === 'procedure') return procedureMode(ctx, goal);
  if (mode === 'why_not' && !via) throw new NotExpressibleError(['why_not'], 'a relational why_not is answered by the oracle; here why_not asks about a step of a plan (via ~action ...)');
  if (mode === 'abduce') return abduceMode(ctx, via, goal);
  return planMode(ctx, via, goal);
}

const hostFlags = ctx => ({...(ctx.contested.length ? {contested: ctx.contested} : {}), ...(ctx.flags.scopeUnknown ? {scope_unknown: true} : {})});

function solveOnce(handle, qWires, excluded, budgetArg) {
  const ctx = buildContext({knowledge: handle.wires, queryWires: qWires, excluded, budgetArg});
  const out = dispatch(ctx);
  return base({budget: ctx.budget.snapshot(false), retrieval: {complete: true, truncated: false, keyed: false, steps: 0, wires: ctx.program.facts.length, probes: 0}, ...hostFlags(ctx), ...out, notes: out.notes ?? []});
}

/** Answer a problem. Throws ProgramError for an invalid circuit and NotExpressibleError for a circuit this strategy does not run. */
export function ask(problem, budgetArg = {}) {
  const t0 = performance.now();
  const avail = probeSwipl();
  if (!avail.ok) throw new ProgramError('unavailable', avail.reason);
  const handle = problem.handle ?? prepare(problem.theory ?? '');
  const qWires = readWires(problem.query, 'query');
  const ids = assumptionIds(handle.wires, qWires);
  const packet = withConditional(ids, excluded => solveOnce(handle, qWires, excluded, budgetArg));
  const requested = problem.requested ?? null;
  return {...packet, route: {requested, chosen: ID, reason: requested ? 'explicit request' : 'direct call', fallback: null}, timings: {total: Math.round(performance.now() - t0)}};
}

/**
 * check(plan, problem): judge a plan or a trace against the methods and norms in force. `plan` = {steps: [{action, args, at?}]}; `problem`
 * = {theory | handle, asof?}. A plan is also required to be executable (every step applicable where it is performed).
 */
export function check(plan, problem, budgetArg = {}) {
  const handle = problem.handle ?? prepare(problem.theory ?? '');
  const q = readWires(`@q query\n  mode conform\n${problem.asof ? '  asof ' + problem.asof + '\n' : ''}`, 'query');
  const ctx = buildContext({knowledge: handle.wires, queryWires: q, budgetArg});
  const verdict = judgeTrace(ctx, plan.steps.map(s => ({action: s.action, args: s.args, at: s.at ?? null})), {check: true});
  return {...base({budget: ctx.budget.snapshot(false)}), ...conformPacket(verdict), ...hostFlags(ctx), route: {requested: null, chosen: ID, reason: 'check', fallback: null}};
}

export const gologSwi = {...capabilities, capabilities, available, prepare, ask, check};
export default gologSwi;
export {atomText};
