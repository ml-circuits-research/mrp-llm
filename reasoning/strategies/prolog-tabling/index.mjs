/**
 * prolog-tabling: SLG resolution (SWI-Prolog tabling) over the desugared core of the reasoning wires.
 *
 * WHAT IT IS. The circuits in force (governance applied, `default` and `integrity` desugared by the js-reference front end) are
 * compiled to one SWI-Prolog program (codegen.mjs): two tabled predicates per relation for the two polarities, tabled recursion
 * (left recursion and cycles terminate), `tnot` for `absent`, arithmetic for `compare` / `compute`, findall-and-fold aggregates
 * with set semantics. A query is a goal-directed tabled call (taskgen.mjs): only what the query depends on is evaluated.
 *
 * WHAT IT COVERS (capabilities below). Horn rules with recursion, explicit negation as evidence (two relations), stratified
 * negation as failure over closed relations, compare and compute in rules, aggregates, defaults and integrity by the shared
 * desugaring, count / every / explain / select / exists, snapshot time and intervals (the host partition: one run per part), what-if
 * and epistemic status (the host two-run lowering, run natively as in the oracle), `used` and proofs from the answer tables
 * (a tabled derivation-height predicate picks the cheapest derivation), why_not by an abductive meta-interpreter over a
 * non-tabled copy of the rules, all-minimal abduction by subset search, budgets.
 *
 * WHAT IT DOES NOT COVER (`not_expressible`, never weakened): plan, method, norms, procedures, conform (golog-swi and the planner
 * cover those), `constraint` wires, query fields the host links, `call` leaves.
 *
 * WELL-FOUNDED NEGATION. On the stratified programs the validator admits, the well-founded model equals the perfect model, so
 * every `tnot` is decided. A program that is not stratified is rejected before this strategy runs (`not_stratifiable`, by the
 * shared compiler). The runtime keeps the mapping for an `undefined` WFS atom anyway (runtime.pl notes it as `wfs_undefined`):
 * an undefined atom is neither a row nor a refutation, the answer is `unknown` with reason `well_founded_undefined`, never
 * `supported`, `refuted` or `both`.
 *
 * BUDGETS (proposal 5.5, 6). `timeoutMs` is a hard kill of the process by the host (`budget_exhausted`, reason `wall`): the proposal
 * names `call_with_time_limit` plus `abolish_all_tables`, but the alarm thread of library(time) deadlocks the private SWI 9.0.4 at
 * `halt` about once in 1700 runs (measured, runtime.pl), and a killed process leaves no incomplete table behind anyway.
 * Incomplete tables left by an inference-limit cut or an error are abolished in Prolog before anything else runs.
 * `maxJoins` is `call_with_inference_limit` (reason `probes`). `maxRounds` is honoured by derivation heights (codegen.mjs):
 * the round ceiling keeps exactly the atoms of rounds 1..N, and the run stops with reason `rounds` when a round N+1 exists.
 * `call_with_depth_limit` is not used: it is meaningless on tabled predicates. The other ceilings are not honoured and are
 * reported in `notes` as `budget_key_ignored:<key>`.
 */
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import {conditionAlts, sliceProgram, planQuery} from './reexports.mjs';
import {timeParts, viewAt, combineParts, proofOf, usedOf, explainOf, withConditional, Budget, CEILINGS, atomText} from './reexports.mjs';
import {ProgramError, NotExpressibleError, readWires, readQuery, readPolicy, mergeLimits, assumptionIds, buildProgram, sensitivityOf, f1} from './front.mjs';
import {registry, goals, programText, q as quote} from './codegen.mjs';
import {proofVariantText} from './proofs.mjs';
import {relationalTask, everyTaskText, whyNotTask, abduceTask, exceedsClause} from './taskgen.mjs';
import {buildNodes, relationalOutcome, everyOutcome} from './outcome.mjs';
import {probeSwipl, runSwipl} from './swipl.mjs';

export {ProgramError, NotExpressibleError};

const here = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.join(here, 'runtime.pl');
const ID = 'prolog-tabling';

const SUPPORTED = ['facts', 'select', 'open_world', 'classical_negation', 'conflict', 'rules', 'recursion', 'conjunction', 'exists', 'every', 'count', 'explain', 'used', 'why_not', 'temporal', 'interval', 'throughout', 'snapshot_derived', 'whatif', 'epistemic_status', 'naf', 'closed_world', 'closed_derived', 'compare_in_rules', 'compute_in_rules', 'aggregate', 'default', 'overrides', 'strict_contrary', 'integrity', 'abduce', 'zero_arity', 'budget', 'budget_probes', 'retrieval', 'versions', 'time_vars', 'exact_arithmetic'];
const UNSUPPORTED = ['constraint', 'optimize', 'plan', 'blocked_info', 'method', 'htn_choice', 'on_failure', 'norms_hard', 'norms_soft', 'temporal_norms', 'procedures', 'procedure_render', 'amendment', 'check_plan', 'abduce_waive'];
const MODES = ['select', 'exists', 'count', 'explain', 'every', 'why_not', 'abduce'];
const HONOURED = ['timeoutMs', 'maxJoins', 'maxRounds', 'maxHypotheses'];

export const capabilities = {
  id: ID,
  features: SUPPORTED,
  notExpressible: UNSUPPORTED,
  delivery: 'slice',
  limits: {max_wires: Infinity, max_arity: 6, integer_range: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]},
  guarantee: 'exact',
  exact: {kind: 'rational'},
  provides: ['explain', 'used', 'proof', 'why_not'],
  budgetKeys: HONOURED,
  determinism: 'deterministic',
  isolation: true
};

/** The private swipl must be present; the strategy is `unavailable` (never a silent fallback) otherwise. */
export function available() { return probeSwipl(); }

export function prepare(theory) {
  const knowledge = typeof theory === 'string' ? theory : theory?.knowledge ?? '';
  const wires = theory?.wires ?? readWires(knowledge, 'knowledge');
  return {kind: 'prolog-tabling-handle', knowledge, wires};
}

export function update(handle, delta = {}) {
  const removed = new Set(delta.remove ?? []);
  const wires = [...handle.wires.filter(w => !removed.has(w.id)), ...(delta.add ? readWires(delta.add, 'delta') : [])];
  return {...handle, wires, knowledge: undefined};
}

const baseInfo = (extra = {}) => ({strategy: ID, guarantee: 'exact', ...extra});

// ------------------------------------------------------------------------------------------------------- one Prolog run

/** Limits of one run: wall milliseconds (the host kills the process), inferences (call_with_inference_limit), round ceiling (heights). */
function runLimits(budget) {
  const L = budget.limits;
  return {
    wallMs: L.timeoutMs,
    infer: L.maxJoins < CEILINGS.maxJoins ? L.maxJoins : 1e12,
    rounds: L.maxRounds < CEILINGS.maxRounds ? L.maxRounds : null
  };
}

function execute({program, view, qp, taskOf, limits, heights, extraAtoms = [], proofs = false}) {
  const reg = registry(program, extraAtoms);
  const g = goals(reg, heights);
  const text = [
    programText({program, view, reg, heights}),
    proofs ? proofVariantText({program, view, reg}) : '',
    heights !== null ? `rt_bound(${heights}).\n${exceedsClause(reg, g, heights)}` : '',
    taskOf(g)
  ].join('\n') + '\n';
  if (process.env.PROLOG_TABLING_DUMP) fs.writeFileSync(process.env.PROLOG_TABLING_DUMP, text); // the generated program is inspectable
  const goal = `rt_run(${(limits.wallMs / 1000).toFixed(3)}, ${Math.floor(limits.infer)})`;
  const r = runSwipl({text, goal, files: [RUNTIME], wallMs: limits.wallMs + 300});
  if (r.timedOut) return {exhausted: 'wall', notes: []};
  if (!r.ok) throw new ProgramError('prolog_failed', `swipl: ${r.stderr}`);
  const {status, result, notes = []} = r.json;
  if (status === 'wall' || status === 'probes') return {exhausted: status, notes};
  if (status !== 'done') throw new ProgramError('prolog_failed', `swipl returned ${status}: ${r.stderr}`);
  return {data: result, notes};
}

const queryAtoms = qp => [...qp.alts, ...qp.scopeAlts].flatMap(a => a.leaves.filter(l => l.kind === 'atom' || l.kind === 'timeof'));

// ------------------------------------------------------------------------------------------------------- relational

function supportFields(outcome, complete) {
  if (!complete || !['supported', 'refuted', 'both'].includes(outcome.status)) return {used: []};
  if (outcome.truncated) return {used: [], used_incomplete: true};
  const {used, used_incomplete: incomplete} = usedOf(outcome.roots);
  return {used, ...(incomplete || outcome.supportIncomplete ? {used_incomplete: true} : {})};
}

function relationalPacket({q, qp, sliced, parts, how, exhaustedReason, policy, budget, notes, viewSize}) {
  const outcome = combineParts(qp, parts, how);
  const sensitivity = sensitivityOf(sliced.program, qp);
  const common = {
    budget: budget.snapshot(Boolean(exhaustedReason)), sensitivity, ignored: sliced.ignored, notes: [...notes],
    retrieval: {complete: true, truncated: false, keyed: false, steps: 0, wires: viewSize, probes: 0}
  };
  if (exhaustedReason) {
    const partialOk = sensitivity.monotone && policy.partial !== 'forbid' && ['select', 'exists', 'explain'].includes(qp.mode) && outcome.rows.length && ['supported', 'both'].includes(outcome.status);
    if (!partialOk) return baseInfo({status: 'budget_exhausted', complete: false, reason: exhaustedReason, ...common});
    return baseInfo({status: outcome.status, complete: false, reason: exhaustedReason, ...(qp.mode === 'select' ? {rows: outcome.rows.map(r => r.row)} : {}), ...common, ...supportFields(outcome, false)});
  }
  const packet = {status: outcome.status, complete: true, ...common};
  if (outcome.reason) packet.reason = outcome.reason;
  if (qp.mode === 'select') packet.rows = outcome.rows.map(r => r.row);
  if (qp.mode === 'count') { packet.count = outcome.count; if (outcome.bound) packet.bound = outcome.bound; }
  Object.assign(packet, supportFields(outcome, true));
  if (qp.mode === 'explain' && outcome.rows.length && !outcome.truncated) {
    const first = outcome.rows.find(r => !r.both) ?? outcome.rows[0];
    packet.explain = explainOf(first.prem);
    packet.proof = proofOf(first.prem);
  }
  return baseInfo(packet);
}

function runRelational({q, qp, sliced, instants, how, closed, policy, budget, started}) {
  const limits = runLimits(budget);
  const heights = limits.rounds;
  const parts = [], notes = new Set();
  let exhaustedReason = null, viewSize = 0;
  for (const t of instants) {
    const view = viewAt(sliced.program.facts, t);
    viewSize = Math.max(viewSize, view.length);
    const prove = heights === null;
    const exceeds = heights !== null;
    const taskOf = g => (qp.mode === 'every' ? everyTaskText(g, qp, closed, {prove, exceeds}) : relationalTask(g, qp, closed, {prove, exceeds}));
    const run = execute({program: sliced.program, view, qp, taskOf, limits, heights, extraAtoms: queryAtoms(qp), proofs: prove});
    for (const n of run.notes) notes.add(n);
    if (run.exhausted) { exhaustedReason = run.exhausted; break; }
    const nodes = buildNodes(run.data.nodes);
    parts.push(qp.mode === 'every' ? everyOutcome(qp, run.data, nodes) : relationalOutcome(qp, run.data, nodes));
    if (run.data.exceeded) { exhaustedReason = 'rounds'; break; }
  }
  if (exhaustedReason && !parts.length) parts.push({status: 'unknown', rows: [], roots: [], supportIncomplete: true});
  if (exhaustedReason === 'rounds' && parts.length > 1) exhaustedReason = 'rounds';
  const packet = relationalPacket({q, qp, sliced, parts, how, exhaustedReason, policy, budget, notes, viewSize});
  packet.timings = {ask: Math.round(performance.now() - started)};
  return packet;
}

// ------------------------------------------------------------------------------------------------------- why_not

function runWhyNot({q, qp, sliced, view, closed, budget, started}) {
  const limits = runLimits(budget);
  const run = execute({program: sliced.program, view, qp, taskOf: g => whyNotTask(g, qp, closed), limits, heights: null, extraAtoms: queryAtoms(qp), proofs: true});
  const common = {sensitivity: sensitivityOf(sliced.program, qp), ignored: sliced.ignored, notes: [...run.notes], timings: {ask: Math.round(performance.now() - started)}};
  if (run.exhausted) return baseInfo({status: 'budget_exhausted', complete: false, reason: run.exhausted, budget: budget.snapshot(false), ...common});
  const nodes = buildNodes(run.data.nodes);
  const claim = relationalOutcome({...qp, mode: 'exists'}, run.data, nodes);
  const text = lit => atomText(lit.neg, lit.p, lit.args);
  const sets = run.data.sets.map(s => [...new Set(s.map(text))].sort());
  const unique = [...new Map(sets.map(s => [s.join('\u0000'), s])).values()];
  const minimal = unique.filter(s => !unique.some(o => o !== s && o.length < s.length && o.every(x => s.includes(x))))
    .sort((a, b) => a.length - b.length || (a.join() < b.join() ? -1 : 1));
  const limit = q.limit;
  const blockers = run.data.blockers.map(b => {
    const node = nodes.get(`${b.lit.neg}|${b.lit.p}|${JSON.stringify(b.lit.args)}`);
    return {atom: text(b.lit), why: b.why, support: node ? explainOf([node]).uses : []};
  });
  return baseInfo({
    status: claim.status, complete: !(minimal.length > limit), missing: claim.rows.length ? [] : minimal.slice(0, limit), blockers,
    budget: budget.snapshot(false), ...common, ...(minimal.length > limit ? {truncated: true} : {})
  });
}

// ------------------------------------------------------------------------------------------------------- abduce

function runAbduce({q, qp, sliced, view, closed, budget, started}) {
  const cands = sliced.program.hypotheses;
  if (cands.length > budget.limits.maxHypotheses) return baseInfo({status: 'budget_exhausted', complete: false, reason: 'hypotheses', budget: budget.snapshot(false)});
  const limits = runLimits(budget);
  const run = execute({program: sliced.program, view, qp, taskOf: g => abduceTask(g, qp, closed, cands.map(c => c.id)), limits, heights: null, extraAtoms: queryAtoms(qp)});
  const base = {budget: budget.snapshot(false), notes: [], sensitivity: sensitivityOf(sliced.program, qp), timings: {ask: Math.round(performance.now() - started)}};
  if (run.exhausted) return baseInfo({status: 'budget_exhausted', complete: false, reason: run.exhausted, ...base, budget: budget.snapshot(false)});
  const byId = new Map(cands.map((c, i) => [c.id, i]));
  const explanations = run.data.found.map(ids => {
    const idx = ids.map(id => byId.get(id));
    return {hypotheses: ids, atoms: idx.flatMap(i => cands[i].atoms.map(a => atomText(a.neg, a.p, a.args))), cost: idx.reduce((c, i) => c + cands[i].cost, 0)};
  }).sort((a, b) => a.cost - b.cost || a.atoms.length - b.atoms.length || (a.atoms.join() < b.atoms.join() ? -1 : 1));
  if (!explanations.length) return baseInfo({status: 'unknown', complete: true, reason: 'no_explanation', hypotheses: [], explanations: [], ...base});
  const shown = explanations.slice(0, q.limit);
  return baseInfo({status: 'hypotheses', complete: shown.length === explanations.length, hypotheses: shown.map(e => e.atoms), explanations: shown, ...(shown.length < explanations.length ? {truncated: true} : {}), ...base});
}

// -------------------------------------------------------------------------------------------------------- one solve

function solveOnce(handle, qWires, excluded, budgetArg) {
  const live = qWires.filter(w => !(w.type === 'fact' && excluded.has(w.id)));
  const queryWire = live.find(w => w.type === 'query');
  const constraintWire = live.find(w => w.type === 'constraint');
  if (constraintWire && !queryWire) throw new NotExpressibleError(['constraint'], `a constraint wire is not expressible by ${ID}`);
  const q = queryWire ? readQuery(queryWire, excluded, {modes: MODES, id: ID}) : null;
  const policy = readPolicy(live, q);
  const budget = new Budget(mergeLimits(budgetArg, policy.limits), {effort: policy.effort});
  if (!q) throw new ProgramError('no_query', 'the query circuit holds neither a query nor a constraint');
  if (policy.procedures) throw new NotExpressibleError(['procedures'], 'policy procedures selects modes of work, which are not expressible');
  const ignoredKeys = Object.keys({...budgetArg, ...policy.limits}).filter(k => !HONOURED.includes(k));

  const program = buildProgram(handle, live, q, excluded);
  const packet = solveCompiled({program, q, policy, budget, budgetArg});
  if (ignoredKeys.length) packet.notes = [...(packet.notes ?? []), ...ignoredKeys.map(k => `budget_key_ignored:${k}`)];
  return packet;
}

/**
 * Answer a query over an already compiled program (governance applied, sugar desugared). The seam the tests use to run a program
 * the compiler would refuse (a program that is not stratified, to observe the well-founded mapping).
 */
export function solveCompiled({program, q, policy, budget, budgetArg = {}}) {
  if (program.unsupported.length && ['why_not', 'abduce'].includes(q.mode)) throw new NotExpressibleError(program.unsupported);
  const seeds = conditionAlts(q.wire.fields.filter(f => ['where', 'scope'].includes(f.key)), q.wire.id).flatMap(alt => alt.filter(l => l.kind === 'atom' || l.kind === 'timeof').map(l => l.p));
  const sliced = sliceProgram(program, seeds);
  const started = performance.now();
  const mode = q.mode === 'why_not' || q.mode === 'abduce' ? 'select' : q.mode;
  const qp = planQuery(q.wire, program.closed, {mode, select: q.select});
  qp.mode = q.mode === 'why_not' || q.mode === 'abduce' ? q.mode : qp.mode;
  const {how, instants} = timeParts(sliced.program.facts, q);
  if (q.mode === 'why_not' || q.mode === 'abduce') {
    if (limitsAsk(budgetArg, policy, 'maxRounds')) throw new NotExpressibleError(['budget_rounds'], `a round ceiling is not honoured for ${q.mode} by ${ID}`);
    const view = viewAt(sliced.program.facts, instants[0]);
    return (q.mode === 'why_not' ? runWhyNot : runAbduce)({q, qp, sliced, view, closed: program.closed, budget, started});
  }
  return runRelational({q, qp, sliced, instants, how, closed: program.closed, policy, budget, started});
}

const limitsAsk = (budgetArg, policy, key) => key in budgetArg || key in policy.limits;

// -------------------------------------------------------------------------------------------------------------- ask

/**
 * Answer a problem (same contract as the oracle: `problem = {theory | handle, query, requested?}`). Throws ProgramError for an
 * invalid circuit and NotExpressibleError for a circuit that needs a feature declared unsupported; budget exhaustion is a packet
 * (`budget_exhausted` with a `reason`), never an exception and never `unknown`.
 */
export function ask(problem, budgetArg = {}) {
  const t0 = performance.now();
  const avail = probeSwipl();
  if (!avail.ok) throw new ProgramError('unavailable', avail.reason);
  const handle = problem.handle ?? prepare(problem.theory ?? '');
  const qWires = readWires(problem.query, 'query');
  const ids = assumptionIds(handle, problem.query);
  const packet = withConditional(ids, excluded => solveOnce(handle, qWires, excluded, budgetArg));
  const requested = problem.requested ?? null;
  return {
    ...packet,
    route: {requested, chosen: ID, reason: requested ? 'explicit request' : 'direct call', fallback: null},
    timings: {...(packet.timings ?? {}), total: Math.round(performance.now() - t0)}
  };
}

export const prologTabling = {...capabilities, capabilities, available, prepare, ask, update};
export default prologTabling;
export {quote};
