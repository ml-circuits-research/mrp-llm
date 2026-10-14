/**
 * Host front end shared by the two solver strategies (`asp-clingo`, `z3-smt-bounded`).
 *
 * Everything around the solver call is the same host work for both and is done once, on the modules of the oracle
 * (`js-reference`) and of the grammar (`sop/knowledge`), so that a disagreement between a solver strategy and the oracle can only
 * come from the lowering or the solver, never from a second reading of the wires:
 *
 *   wires -> governance (wires in force, supposed wires) -> desugaring (default, integrity) -> compileProgram (safety, stratification)
 *         -> dependency slice of the query -> SOLVER (the lowering is the engine's own) -> atoms of the model
 *         -> the oracle's query reading over those atoms -> packet (statuses, rows, count, bound, budget, route).
 *
 * An engine is `{id, allowed, closure, constraint, abduce, whyNot, plan, check?}`; every hook is synchronous (the solvers run as
 * subprocesses with a time limit) and returns a packet fragment or throws `NotExpressibleError`:
 *
 *   closure({program, facts, budget, notes})   the atoms of the unique model of the slice at one view of the facts:
 *                                              {atoms: [{neg, p, args}], exhausted: null | {reason}};
 *   constraint(parsed, budget)                 a `constraint` wire (finite or numeric arithmetic, optimisation);
 *   abduce({program, facts, goalAlts, hypotheses, budget, limit})   all minimal explanations;
 *   whyNot({program, facts, goalAlts, budget, limit})                minimal sets of EDB atoms whose addition derives the goal;
 *   plan({program, facts, goalAlts, norms, via, budget, mode})       bounded planning with norms (a horizon encoding).
 *
 * Nothing here is a solver: a circuit that needs a feature the engine does not declare is `not_expressible`, never weakened.
 */
import {parse, tokens, selectInForce, supposedWireIds, desugar, contestedIds} from '../../../sop/knowledge/index.mjs';
import {compileProgram, sliceProgram, conditionAlts, hypothesisReach} from '../js-reference/program.mjs';
import {contradictions} from '../js-reference/abduce.mjs';
import {atomText} from '../js-reference/values.mjs';
import {planQuery, evaluatePart, combineParts, READ_BUDGET} from '../js-reference/query.mjs';
import {timeParts, viewAt} from '../js-reference/timeview.mjs';
import {Evidence} from '../js-reference/evidence.mjs';
import {whyNot as scanBlockers} from '../js-reference/whynot.mjs';
import {Budget, CEILINGS} from '../js-reference/budget.mjs';
import {withConditional} from '../js-reference/conditional.mjs';
import {parseConstraint} from '../js-reference/constraint.mjs';
import {ProgramError, NotExpressibleError} from '../js-reference/values.mjs';
import {prepare, assumptionIds} from '../js-reference/index.mjs';
import {parseNorms, parseWaivers} from './norms.mjs';
import {usedByDeletion} from './used.mjs';

export {ProgramError, NotExpressibleError, prepare, Evidence};

const f1 = (w, k) => w.fields.find(f => f.key === k);
const LINKS_OTHER_THAN_IF = ['because', 'so', 'unless', 'although', 'so_that', 'before', 'after', 'when', 'while'];
/** `candidate` (Q-LANG-10) asks for runs with wires that are not in force elsewhere: the oracle's alone. */
const NOT_RUN_BY_AN_ENGINE = ['compare', 'order', 'rank', 'filter', 'quantifier', 'except', 'measure', ...LINKS_OTHER_THAN_IF, 'trace', 'candidate'];
export const MODES = ['select', 'exists', 'count', 'every', 'why_not', 'plan', 'abduce'];

export function readWires(text, what) {
  const {wires, errors} = parse(text ?? '');
  if (errors.length) throw new ProgramError(errors[0].code, `${what}: ${errors[0].message} (line ${errors[0].line})`);
  return wires;
}

/** Read the query wire; a circuit that needs more than the engine runs is `not_expressible`, never weakened. */
export function readQuery(wire, excluded, id) {
  const one = k => f1(wire, k)?.value.trim() ?? null;
  const span = k => (one(k) ? tokens(one(k)) : null);
  const q = {
    wire, mode: one('mode') ?? 'select', select: tokens(one('select') ?? ''), at: one('at'), during: span('during'), overlaps: span('overlaps'),
    asof: one('asof'), policy: one('policy')?.replace(/^\$/, '') ?? null, limit: one('limit') ? Number(one('limit')) : Infinity,
    via: wire.fields.filter(f => f.key === 'via').map(f => f.value.trim()),
    ifs: wire.fields.filter(f => f.key === 'if').map(f => f.value.trim().slice(1)).filter(i => !excluded.has(i))
  };
  if (!MODES.includes(q.mode)) throw new NotExpressibleError(['mode_' + q.mode], `mode ${q.mode} is not run by ${id}`);
  const other = NOT_RUN_BY_AN_ENGINE.find(k => f1(wire, k));
  if (other) throw new NotExpressibleError(['query_' + other], `query field "${other}" is linked by the host, not run by ${id}`);
  if (f1(wire, 'limit') && !['abduce', 'why_not'].includes(q.mode)) throw new NotExpressibleError(['query_limit'], 'limit is linked by the host');
  return q;
}

export function readPolicy(wires, q) {
  const w = wires.find(x => x.type === 'policy' && (!q || x.id === q.policy));
  if (!w) return {limits: {}, effort: 'normal', partial: 'allow', procedures: false};
  const limits = {};
  for (const f of w.fields) if (f.key in CEILINGS) limits[f.key] = Number(f.value);
  return {limits, effort: f1(w, 'effort')?.value.trim() ?? 'normal', partial: f1(w, 'partial')?.value.trim() ?? 'allow', procedures: Boolean(f1(w, 'procedures'))};
}

/** Requested limits only tighten: the smaller of the caller's `budget` argument and the policy wire. */
export function mergeLimits(a, b) {
  const out = {...a};
  for (const [k, v] of Object.entries(b)) out[k] = k in out ? Math.min(out[k], v) : v;
  return out;
}

/** Compile the circuits in force for one set of excluded assumptions (the same pipeline as the oracle). */
export function buildProgram(handle, qWires, q, excluded) {
  const supposed = supposedWireIds(q ? [{...q.wire, fields: q.wire.fields.filter(f => !(f.key === 'if' && excluded.has(f.value.trim().slice(1))))}] : [], handle.wires).filter(id => !excluded.has(id));
  const inForce = selectInForce(handle.wires, {asof: q?.asof ?? null, include: supposed}).filter(w => !(w.type === 'fact' && excluded.has(w.id)));
  const {wires, origin} = desugar([...inForce, ...qWires.filter(w => w.type === 'fact')]);
  return {program: compileProgram(wires, {origin}), inForce};
}

/** Evidence tables (the oracle's `Evidence`) from the atoms a solver returned. */
export function evidenceFromAtoms(atoms) {
  const ev = new Evidence();
  for (const a of atoms) ev.add({neg: a.neg, p: a.p, args: a.args, kind: 'fact', ref: {id: 'model', version: 1}, premises: []});
  return ev;
}

const baseInfo = (id, extra) => ({strategy: id, guarantee: 'exact', ...extra});

/** Leaves the closure lowering of both engines cannot state. */
function unsupportedLeaves(program) {
  const bad = [];
  for (const r of program.rules) for (const alt of r.alts) for (const l of alt.leaves) if (['timeof', 'order'].includes(l.kind)) bad.push(l.kind === 'timeof' ? 'time_vars' : 'order');
  for (const a of program.aggregates) {
    if (a.fn === 'collect') bad.push('collect');
    for (const alt of a.alts) for (const l of alt.leaves) if (['timeof', 'order'].includes(l.kind)) bad.push('time_vars');
  }
  return [...new Set(bad)];
}

/** The goal of a planning, why_not or abduction question: the `where` part, with `not` over a closed fluent meaning absence. */
export function goalAlternatives(wire, closed) {
  return conditionAlts(wire.fields.filter(f => f.key === 'where'), wire.id)
    .map(alt => alt.map(l => (l.kind === 'atom' && l.mode === 'not' && closed.has(l.p) ? {...l, mode: 'absent'} : l)));
}

function relationalPacket({id, q, qp, parts, how, budget, notes, viewSize, ignored}) {
  const outcome = combineParts(qp, parts, how);
  const packet = {
    status: outcome.status, complete: true, budget: budget.snapshot(false), ignored, notes: [...notes],
    retrieval: {complete: true, truncated: false, keyed: false, steps: 0, wires: viewSize, probes: 0}
  };
  if (outcome.reason) packet.reason = outcome.reason;
  // `mode every` with `select` answers the groups where the universal holds (the oracle's grouped every)
  if (qp.mode === 'select' || (qp.mode === 'every' && qp.select.length)) packet.rows = outcome.rows.map(r => r.row);
  if (qp.mode === 'count') { packet.count = outcome.count; if (outcome.bound) packet.bound = outcome.bound; }
  return baseInfo(id, packet);
}

const exhaustedPacket = (id, budget, reason, extra = {}) => baseInfo(id, {status: 'budget_exhausted', complete: false, reason, budget: {...budget.snapshot(false), exhausted: true, reason}, ...extra});

/** One complete solve with some assumptions removed. Returns a packet without `conditional` and without `used`. */
export function solveOnce(engine, handle, qWires, excluded, budgetArg) {
  const id = engine.id;
  const live = qWires.filter(w => !(w.type === 'fact' && excluded.has(w.id)));
  const queryWire = live.find(w => w.type === 'query');
  const constraintWire = live.find(w => w.type === 'constraint');
  const q = queryWire ? readQuery(queryWire, excluded, id) : null;
  const policy = readPolicy(live, q);
  const budget = new Budget(mergeLimits(budgetArg, policy.limits), {effort: policy.effort});
  if (constraintWire && !queryWire) return baseInfo(id, {...engine.constraint(parseConstraint(constraintWire), budget), budget: budget.snapshot(false), used: [], notes: []});
  if (!q) throw new ProgramError('no_query', 'the query circuit holds neither a query nor a constraint');
  if (policy.procedures) throw new NotExpressibleError(['procedures'], 'policy procedures selects modes of work, which are not expressible');

  const {program, inForce} = buildProgram(handle, live, q, excluded);
  const planning = q.mode === 'plan' || (['why_not', 'abduce'].includes(q.mode) && (q.via.length || (program.actions.length && inForce.some(w => w.type === 'norm'))));
  const blockers = program.unsupported.filter(u => !(engine.allowed ?? []).includes(u));
  if (blockers.length && ['plan', 'why_not', 'abduce'].includes(q.mode)) throw new NotExpressibleError(blockers);
  if (q.via.length && !planning) throw new NotExpressibleError(['via'], 'via names steps of a plan');
  const goalAlts = ['plan', 'why_not', 'abduce'].includes(q.mode) ? goalAlternatives(q.wire, program.closed) : null;
  const seeds = conditionAlts(q.wire.fields.filter(f => ['where', 'scope'].includes(f.key)), q.wire.id).flatMap(alt => alt.filter(l => l.kind === 'atom' || l.kind === 'timeof').map(l => l.p));
  const planPreds = planning ? program.actions.flatMap(a => [...a.requires, ...a.adds, ...a.removes].map(x => x.p)) : [];
  const normPreds = planning ? parseNorms(inForce, program).flatMap(n => n.predicates) : [];
  const sliced = sliceProgram(program, [...seeds, ...planPreds, ...normPreds, ...(q.mode === 'abduce' && !planning ? hypothesisReach(program) : [])]);
  const sp = sliced.program;
  const bad = unsupportedLeaves(sp);
  if (bad.length) throw new NotExpressibleError(bad, `${id} does not lower: ${bad.join(', ')}`);
  engine.check?.(sp);
  const started = performance.now();
  const notes = new Set();
  // a contested wire keeps binding and is flagged until the host rules on the contest (8.2)
  const contested = contestedIds(inForce);
  const finish = (packet, extra = {}) => ({...packet, ignored: sliced.ignored, notes: [...(packet.notes ?? []), ...notes], timings: {ask: Math.round(performance.now() - started)}, ...(contested.length ? {contested} : {}), ...extra});

  if (planning) {
    const norms = parseNorms(inForce, program);
    const out = engine.plan({program: sp, facts: sp.facts, goalAlts, norms, via: q.via, mode: q.mode, budget, limit: q.limit, waivers: parseWaivers(inForce), inForce});
    return finish(baseInfo(id, {...out, budget: out.budget ?? budget.snapshot(false)}));
  }
  const qp = planQuery(q.wire, program.closed, {mode: q.mode === 'why_not' || q.mode === 'abduce' ? 'select' : q.mode, select: q.select});
  qp.mode = q.mode === 'why_not' || q.mode === 'abduce' ? q.mode : qp.mode;

  // why_not and abduce read ONE state, the one at the query's instant (as the oracle does; capability battery 2026-10-02: the time of the
  // query was ignored and an observation false at that instant was explained); an interval has no single state and is refused.
  if ((q.mode === 'abduce' || q.mode === 'why_not') && (q.during || q.overlaps)) throw new NotExpressibleError(['interval'], `${q.mode} asks about one state; ask with at, not during or overlaps`);
  if (q.mode === 'abduce') {
    const state = {...sp, facts: viewAt(sp.facts, timeParts(sp.facts, q).instants[0])};
    const out = engine.abduce({program: state, facts: state.facts, goalAlts: qp.alts, hypotheses: sp.hypotheses, budget, limit: q.limit});
    return finish(baseInfo(id, {...consistentOnly(engine, state, out, budget, notes), budget: out.budget ?? budget.snapshot(false)}));
  }
  const {how, instants} = timeParts(sp.facts, q);
  const parts = [], closures = [];
  let exhausted = null, viewSize = 0;
  for (const t of instants) {
    if (exhausted) break;
    const view = viewAt(sp.facts, t);
    viewSize = Math.max(viewSize, view.length);
    const out = engine.closure({program: sp, facts: view, budget, notes});
    exhausted = out.exhausted;
    if (exhausted) break;
    const ev = evidenceFromAtoms(out.atoms);
    closures.push({ev, atoms: out.atoms, view});
    if (q.mode !== 'why_not') parts.push(evaluatePart(qp, ev, {ev, stored: new Map(), budget: READ_BUDGET, notes}));
  }
  if (exhausted) return finish(exhaustedPacket(id, budget, exhausted.reason));
  if (q.mode === 'why_not') {
    const ev = closures[0].ev;
    const claim = evaluatePart({...qp, mode: 'exists'}, ev, {ev, stored: new Map(), budget: READ_BUDGET, notes});
    const out = engine.whyNot({program: {...sp, facts: closures[0].view}, facts: closures[0].view, goalAlts: qp.alts, budget, limit: q.limit});
    if (out.status === 'budget_exhausted') return finish(baseInfo(id, out));
    return finish(baseInfo(id, {status: claim.status, complete: out.complete ?? true, missing: claim.rows.length ? [] : out.missing, blockers: out.blockers?.length ? out.blockers : blockersOf(sp, ev, qp, budget), budget: budget.snapshot(false)}));
  }
  return finish(relationalPacket({id, q, qp, parts, how, budget, notes, viewSize, ignored: []}));
}

/**
 * Consistency of the engine's explanations (js-reference/abduce.mjs): an explanation whose closure, computed by the same engine, holds
 * an atom and its negation that the admitted facts alone do not is moved to `inconsistent`. The engine returns the inclusion-minimal
 * explaining sets, so the filter is exact for monotone programs; with negation as failure a consistent superset of an inconsistent
 * minimal set is not searched (the oracle searches it).
 */
function consistentOnly(engine, sp, out, budget, notes) {
  if (out.status !== 'hypotheses' || !out.explanations?.length) return out;
  const byId = new Map(sp.hypotheses.map(h => [h.id, h]));
  const close = ids => {
    const extra = ids.flatMap(id => byId.get(id)?.atoms ?? []).map(a => ({neg: a.neg, p: a.p, args: a.args, claim: {id: 'hypothesis', version: 1}, status: 'supposed', speaker: null, valid: null}));
    const c = engine.closure({program: sp, facts: [...sp.facts, ...extra], budget, notes});
    return c.exhausted ? null : evidenceFromAtoms(c.atoms);
  };
  const baseEv = close([]);
  if (!baseEv) return out;
  const base = contradictions(baseEv);
  const kept = [], inconsistent = [];
  for (const e of out.explanations) {
    const ev = close(e.hypotheses);
    const fresh = ev ? [...contradictions(ev)].filter(([key]) => !base.has(key)).map(([, a]) => a) : [];
    if (!fresh.length) kept.push(e);
    else inconsistent.push({...e, contradicts: fresh.map(a => baseEv.get(true, a.p, a.args) ? atomText(true, a.p, a.args) : atomText(false, a.p, a.args))});
  }
  if (!inconsistent.length) return out;
  if (!kept.length) return {...out, status: 'unknown', reason: 'no_consistent_explanation', hypotheses: [], explanations: [], inconsistent};
  return {...out, hypotheses: kept.map(e => e.atoms), explanations: kept, inconsistent};
}

/**
 * The blocking atoms of a why_not (those that satisfy a `not`, an `absent` or an exception and kill a route, or contradict a repair)
 * are a DIAGNOSTIC of the model, not part of the answer set: the oracle's blocker scan reads them off the atoms the solver returned.
 * The missing sets of the answer are the solver's own.
 */
function blockersOf(program, ev, qp, budget) {
  try { return scanBlockers({program, ev, goalAlts: qp.alts, budget: budget.child(), limit: Infinity}).blockers; } catch { return []; }
}

const claimVersion = (wires, id) => Number(wires.find(w => w.id === id)?.fields.find(f => f.key === 'version')?.value ?? 1);

/**
 * Answer a problem {theory | handle, query, requested?} with an engine. `options.conditional: false` leaves the per-row `conditional`
 * list to the caller (the smoke harness applies the same host rule around every strategy); `options.used: false` skips the host's
 * deletion method for `used` (it costs one solver run per claim of the slice).
 */
export function askWith(engine, problem, budgetArg = {}, options = {}) {
  const t0 = performance.now();
  const handle = problem.handle ?? prepare(problem.theory ?? '');
  const qWires = readWires(problem.query, 'query');
  const solve = excluded => solveOnce(engine, handle, qWires, excluded, budgetArg);
  let packet = options.conditional === false ? solve(new Set()) : withConditional(assumptionIds(handle, problem.query), solve);
  if (options.used !== false && packet.complete !== false && ['supported', 'refuted', 'both'].includes(packet.status) && !packet.used) {
    packet = {...packet, ...usedByDeletion({handle, qWires, solve: (h, excluded) => solveOnce(engine, h, qWires, excluded, budgetArg), packet, versionOf: id => claimVersion(handle.wires, id)})};
  }
  const requested = problem.requested ?? null;
  return {
    ...packet,
    route: {requested, chosen: engine.id, reason: requested ? 'explicit request' : 'direct call to the strategy', fallback: null},
    timings: {...(packet.timings ?? {}), total: Math.round(performance.now() - t0)}
  };
}
