/**
 * Host front end shared by the three Datalog strategies (`datalog-souffle`, `datalog-e10`, `datalog-soplab`).
 *
 * The three engines differ in how they close the program over the facts; everything around the closure is the same host work and
 * is done here once, on the same modules as the oracle (`js-reference`), so that a disagreement between a Datalog strategy and the
 * oracle can only come from the engine or its lowering, never from a second reading of the wires:
 *
 *   wires -> governance (wires in force, supposed wires) -> desugaring (default, integrity) -> compileProgram (safety, stratification)
 *         -> dependency slice of the query -> ENGINE (closure of the slice, or a pushed-down query) -> evidence tables
 *         -> the oracle's query evaluation over those tables -> packet (statuses, rows, count, bound, budget, route).
 *
 * An engine is `{id, ceilings?, modes?, closure, pushdown?, explain?, special?}`:
 *   closure   ({program, facts, qp, q, budget, wanted}) returns {tables: Map('p|name' | 'n|name' -> array of argument arrays),
 *             exhausted: null | {reason}, notes?, state?} for the wanted relations (a cut closure holds only sound conclusions);
 *   pushdown  optional, ({program, facts, qp, q, budget}): answers a select/exists/count query inside the engine and returns an outcome
 *             (the shape of the oracle's `evaluatePart`, plus `exhausted` and `timings`) or null when the query is not of the pushable kind;
 *   explain   optional, ({state, qp, outcome}): the `explain` field of an `explain` query;
 *   special   optional, ({program, q, qp, budget}): answers `plan` and `abduce` from the compiled program (actions, hypotheses);
 *   modes     the query modes the engine runs (default `READ_MODES`); ceilings: key -> {max, default} of the budget keys it honours.
 * What none of them does, and what is therefore `not_expressible` and never weakened: time words, `start_of`/`end_of`, `order`,
 * why_not, constraints and the modes of work; `explain`, `plan` and `abduce` only where an engine declares the mode.
 */
import {parse, tokens, selectInForce, supposedWireIds, desugar} from '../../../sop/knowledge/index.mjs';
import {compileProgram, sliceProgram, conditionAlts} from '../js-reference/program.mjs';
import {planQuery, evaluatePart, READ_BUDGET} from '../js-reference/query.mjs';
import {Evidence} from '../js-reference/evidence.mjs';
import {Budget, CEILINGS} from '../js-reference/budget.mjs';
import {withConditional} from '../js-reference/conditional.mjs';
import {ProgramError, NotExpressibleError} from '../js-reference/values.mjs';
import {prepare, assumptionIds} from '../js-reference/index.mjs';

export {ProgramError, NotExpressibleError, prepare};

/** The query modes of the closure reader; an engine may declare more in `engine.modes` (`explain`, `plan`, `abduce`) and answer them itself. */
export const READ_MODES = ['select', 'exists', 'count', 'every'];
const SPECIAL_MODES = ['plan', 'abduce'];

const f1 = (w, k) => w.fields.find(f => f.key === k);
const LINKS_OTHER_THAN_IF = ['because', 'so', 'unless', 'although', 'so_that', 'before', 'after', 'when', 'while'];
/** `candidate` (Q-LANG-10) asks for runs with wires that are not in force elsewhere: the oracle's alone. */
const NOT_RUN_BY_AN_ENGINE = ['compare', 'order', 'rank', 'filter', 'quantifier', 'except', 'measure', ...LINKS_OTHER_THAN_IF, 'limit', 'via', 'trace', 'candidate'];

function readWires(text, what) {
  const {wires, errors} = parse(text ?? '');
  if (errors.length) throw new ProgramError(errors[0].code, `${what}: ${errors[0].message} (line ${errors[0].line})`);
  return wires;
}

/** Read the query wire; a circuit that needs more than a Datalog closure is `not_expressible`, never weakened. */
export function readQuery(wire, excluded, engine) {
  const strategyId = engine.id;
  const one = k => f1(wire, k)?.value.trim() ?? null;
  const q = {
    wire, mode: one('mode') ?? 'select', select: tokens(one('select') ?? ''), policy: one('policy')?.replace(/^\$/, '') ?? null,
    limit: one('limit') ? Number(one('limit')) : Infinity,
    ifs: wire.fields.filter(f => f.key === 'if').map(f => f.value.trim().slice(1)).filter(id => !excluded.has(id))
  };
  const modes = engine.modes ?? READ_MODES;
  if (!modes.includes(q.mode)) throw new NotExpressibleError(['mode_' + q.mode], `mode ${q.mode} is not run by ${strategyId} (${modes.join(', ')} are)`);
  for (const k of ['at', 'during', 'overlaps']) if (one(k)) throw new NotExpressibleError(['temporal'], `${strategyId} declares time unsupported (query word ${k})`);
  const other = NOT_RUN_BY_AN_ENGINE.find(k => f1(wire, k) && !(k === 'limit' && q.mode === 'abduce'));
  if (other) throw new NotExpressibleError(['query_' + other], `query field "${other}" is linked by the host, not run by ${strategyId}`);
  return q;
}

function readPolicy(wires, q) {
  const w = wires.find(x => x.type === 'policy' && (!q || x.id === q.policy));
  if (!w) return {limits: {}, effort: 'normal', partial: 'allow', procedures: false};
  const limits = {};
  for (const f of w.fields) if (f.key in CEILINGS) limits[f.key] = Number(f.value);
  return {limits, effort: f1(w, 'effort')?.value.trim() ?? 'normal', partial: f1(w, 'partial')?.value.trim() ?? 'allow', procedures: Boolean(f1(w, 'procedures'))};
}

/** Requested limits only tighten: the smaller of the caller's `budget` argument and the policy wire. */
function mergeLimits(a, b) {
  const out = {...a};
  for (const [k, v] of Object.entries(b)) out[k] = k in out ? Math.min(out[k], v) : v;
  return out;
}

/** The oracle's budget, with the ceilings and defaults the engine declares for itself (`engine.ceilings`: key -> {max, default}). */
function makeBudget(engine, requested, effort) {
  const budget = new Budget(requested, {effort});
  for (const [k, c] of Object.entries(engine.ceilings ?? {})) {
    const asked = Number(requested[k]);
    budget.limits[k] = Number.isSafeInteger(asked) && asked > 0 ? Math.min(asked, c.max) : c.default;
  }
  return budget;
}

/** Compile the circuits in force for one set of excluded assumptions (the same pipeline as the oracle). */
function buildProgram(handle, qWires, q, excluded) {
  const supposed = supposedWireIds(q ? [{...q.wire, fields: q.wire.fields.filter(f => !(f.key === 'if' && excluded.has(f.value.trim().slice(1))))}] : [], handle.wires).filter(id => !excluded.has(id));
  const inForce = selectInForce(handle.wires, {asof: f1(q.wire, 'asof')?.value.trim() ?? null, include: supposed}).filter(w => !(w.type === 'fact' && excluded.has(w.id)));
  const {wires, origin} = desugar([...inForce, ...qWires.filter(w => w.type === 'fact')]);
  return compileProgram(wires, {origin});
}

/** Predicates a partial retrieval must have complete (judged on the desugared program); only `monotone` matters here. */
function isMonotone(sp, qp) {
  const strict = sp.edges.filter(e => e.strict && sp.slice.has(e.to));
  const absentInQuery = qp.alts.some(a => a.leaves.some(l => l.kind === 'atom' && l.mode === 'absent'));
  return !strict.length && !absentInQuery && !['count', 'every'].includes(qp.mode);
}

/** The relations of the query's predicates, both polarities: what the oracle's evaluation reads. */
export function wantedRelations(qp) {
  const preds = new Set();
  for (const alt of [...qp.alts, ...qp.scopeAlts]) for (const l of alt.leaves) if (l.kind === 'atom') preds.add(l.p);
  return new Set([...preds].flatMap(p => [`p|${p}`, `n|${p}`]));
}

/** Evidence tables (the oracle's `Evidence`) from the rows an engine read back. */
export function evidenceFromTables(tables) {
  const ev = new Evidence();
  for (const [key, rows] of tables) {
    const neg = key.startsWith('n|'), p = key.slice(2);
    for (const args of rows) ev.add({neg, p, args, kind: 'fact', ref: {id: 'engine', version: 1}, premises: []});
  }
  return ev;
}

const unsupportedLeaves = program => {
  const bad = [];
  for (const r of program.rules) for (const alt of r.alts) for (const l of alt.leaves) if (['timeof', 'order'].includes(l.kind)) bad.push(l.kind);
  for (const a of program.aggregates) if (a.fn === 'collect') bad.push('collect');
  return [...new Set(bad)];
};

function packetFrom({engine, qp, sp, ignored, outcome, exhausted, policy, budget, notes}) {
  const common = {
    strategy: engine.id, guarantee: 'exact', budget: budget.snapshot(Boolean(exhausted)), ignored, notes: [...notes],
    retrieval: {complete: true, truncated: false, keyed: false, steps: 0, wires: sp.facts.length, probes: 0}
  };
  if (exhausted) {
    const partialOk = isMonotone(sp, qp) && policy.partial !== 'forbid' && ['select', 'exists'].includes(qp.mode) && outcome?.rows.length && ['supported', 'both'].includes(outcome.status);
    if (!partialOk) return {...common, status: 'budget_exhausted', complete: false, reason: exhausted.reason};
    return {...common, status: outcome.status, complete: false, reason: exhausted.reason, ...(qp.mode === 'select' ? {rows: outcome.rows.map(r => r.row)} : {})};
  }
  const packet = {...common, status: outcome.status, complete: true};
  if (outcome.reason) packet.reason = outcome.reason;
  // `mode every` with `select` answers the groups where the universal holds (the oracle's grouped every)
  if (qp.mode === 'select' || (qp.mode === 'every' && qp.select.length)) packet.rows = outcome.rows.map(r => r.row);
  if (qp.mode === 'count') { packet.count = outcome.count; if (outcome.bound) packet.bound = outcome.bound; }
  return packet;
}

/** Planning and abduction: the engine answers from the compiled program itself (actions, hypotheses), as the oracle does. */
function solveSpecial(engine, {q, program, seeds, budget}) {
  if (program.unsupported.length) throw new NotExpressibleError(program.unsupported);
  const planPreds = q.mode === 'plan' ? program.actions.flatMap(a => [...a.requires, ...a.adds, ...a.removes].map(x => x.p)) : [];
  const sliced = sliceProgram(program, [...seeds, ...planPreds]);
  const started = performance.now();
  const qp = q.mode === 'abduce' ? planQuery(q.wire, program.closed, {mode: 'select', select: q.select}) : null;
  const out = engine.special({program: sliced.program, q, qp, budget});
  return {
    strategy: engine.id, guarantee: 'exact', ...out, budget: budget.snapshot(), ignored: sliced.ignored, notes: out.notes ?? [],
    retrieval: {complete: true, truncated: false, keyed: false, steps: 0, wires: sliced.program.facts.length, probes: 0},
    timings: {ask: Math.round(performance.now() - started)}
  };
}

/** One complete solve with some assumptions removed. Returns a packet without `conditional`. */
export function solveOnce(engine, handle, qWires, excluded, budgetArg) {
  const live = qWires.filter(w => !(w.type === 'fact' && excluded.has(w.id)));
  const queryWire = live.find(w => w.type === 'query');
  if (live.some(w => w.type === 'constraint') && !queryWire) throw new NotExpressibleError(['constraint'], `numeric constraints are not run by ${engine.id}`);
  if (!queryWire) throw new ProgramError('no_query', 'the query circuit holds no query');
  const q = readQuery(queryWire, excluded, engine);
  const policy = readPolicy(live, q);
  if (policy.procedures) throw new NotExpressibleError(['procedures'], 'policy procedures selects modes of work, which are not expressible');
  const budget = makeBudget(engine, mergeLimits(budgetArg, policy.limits), policy.effort);
  const program = buildProgram(handle, live, q, excluded);
  const seeds = conditionAlts(q.wire.fields.filter(f => ['where', 'scope'].includes(f.key)), q.wire.id).flatMap(alt => alt.filter(l => l.kind === 'atom' || l.kind === 'timeof').map(l => l.p));
  if (SPECIAL_MODES.includes(q.mode)) return solveSpecial(engine, {q, program, seeds, budget});
  const sliced = sliceProgram(program, seeds);
  const bad = unsupportedLeaves(sliced.program);
  if (bad.length) throw new NotExpressibleError(bad, `${engine.id} does not run: ${bad.join(', ')}`);
  const qp = planQuery(q.wire, program.closed, {mode: q.mode, select: q.select});
  if (qp.alts.some(a => a.leaves.some(l => l.kind !== 'atom' && l.kind !== 'compare'))) throw new NotExpressibleError(['query_leaf'], 'query condition not run by the engines');
  engine.check?.(sliced.program, qp, q);
  const started = performance.now();
  const sp = sliced.program;
  const job = {program: sp, facts: sp.facts, qp, q, budget};
  const notes = new Set();
  let outcome = engine.pushdown?.(job) ?? null, exhausted = null, state = null;
  if (!outcome) {
    const closure = engine.closure({...job, wanted: wantedRelations(qp)});
    exhausted = closure.exhausted ?? null;
    state = closure.state ?? null;
    for (const n of closure.notes ?? []) notes.add(n);
    const ev = evidenceFromTables(closure.tables);
    outcome = evaluatePart(qp, ev, {ev, stored: new Map(), budget: READ_BUDGET, notes});
  } else for (const n of outcome.notes ?? []) notes.add(n);
  if (outcome.exhausted) exhausted = outcome.exhausted;
  const packet = packetFrom({engine, qp, sp, ignored: sliced.ignored, outcome, exhausted, policy, budget, notes});
  packet.timings = {ask: Math.round(performance.now() - started), ...(outcome.timings ?? {})};
  if (q.mode === 'explain' && !exhausted && engine.explain && outcome.rows.length) packet.explain = engine.explain({state, qp, outcome});
  return packet;
}

/**
 * Answer a problem {theory | handle, query, requested?} with an engine. `options.conditional: false` leaves the per-row `conditional`
 * list to the caller (the smoke harness applies the same host rule around every strategy).
 */
export function askWith(engine, problem, budgetArg = {}, options = {}) {
  const t0 = performance.now();
  const handle = problem.handle ?? prepare(problem.theory ?? '');
  const qWires = readWires(problem.query, 'query');
  const solve = excluded => solveOnce(engine, handle, qWires, excluded, budgetArg);
  const packet = options.conditional === false ? solve(new Set()) : withConditional(assumptionIds(handle, problem.query), solve);
  const requested = problem.requested ?? null;
  return {
    ...packet,
    route: {requested, chosen: engine.id, reason: requested ? 'explicit request' : 'direct call to the strategy', fallback: null},
    timings: {...(packet.timings ?? {}), total: Math.round(performance.now() - t0)}
  };
}
