/**
 * One solve of a query circuit, independent of where the facts live. A BACKEND says how a session is opened and filled:
 *
 *   memory   a fresh in-memory database per part of the time partition, the facts of the view loaded into tables (index.mjs);
 *   bank     a read-only SQLite memory bank (DS018): base relations are TEMP views over the bank's own `atoms` table, so joins and
 *            constants use the bank's indexes; only derived relations are written, to TEMP tables (bank.mjs).
 *
 * backend = {id, codec, temp, kinds(program), open(budget), setup(session, {rels, program, view, kinds, instant, asof}), refFor?(session, neg, p, args)}
 */
import {planQuery, combineParts} from '../js-reference/query.mjs';
import {sliceProgram, conditionAlts} from '../js-reference/program.mjs';
import {timeParts, viewAt} from '../js-reference/timeview.mjs';
import {BudgetStop} from '../js-reference/budget.mjs';
import {ProgramError, NotExpressibleError} from '../js-reference/values.mjs';
import {readQuery, readPolicy, mergeLimits, buildProgram} from './front.mjs';
import {SqlBudget} from './budget.mjs';
import {collectRelations} from './schema.mjs';
import {Closure} from './closure.mjs';
import {Answerer} from './answer.mjs';
import {queryDemand} from './demand.mjs';
import {supportOf} from './provenance.mjs';
import {planFixedPoint, scaleProgram, scaleQuery, fromScaled, toScaled, inexactError, INEXACT} from '../solver-common/fixed-point.mjs';
import {tbl} from './schema.mjs';

/** The codec of a fixed-point run: values leave the database divided by 10^S and enter it multiplied (text and symbols pass through). */
function fixedCodec(codec, fx) {
  return {
    ...codec,
    decode: value => fromScaled(codec.decode(value), fx.scale)
  };
}

/** The provenance replays decoded rows against the tables: a value bound back into a statement is scaled again. */
const rebinding = (codec, fx) => ({...codec, bind: value => codec.bind(typeof value === 'number' ? toScaled(value, fx.scale) : value)});

/** Predicates a partial retrieval must have complete for the answer to be valid (same judgement as the oracle, on the desugared program). */
export function sensitivityOf({program: sp}, qp) {
  const strict = sp.edges.filter(e => e.strict && sp.slice.has(e.to));
  const over = [...new Set([...strict.map(e => e.from), ...(qp && (['count', 'every'].includes(qp.mode) || qp.forms?.rank) ? qp.alts.flatMap(a => a.leaves.filter(l => l.kind === 'atom').map(l => l.p)) : [])])];
  const defaults = [...sp.slice].filter(p => /^x_.+_blocked$/.test(p)).map(p => p.slice(2, -8));
  const absentInQuery = qp ? qp.alts.some(a => a.leaves.some(l => l.kind === 'atom' && l.mode === 'absent')) : false;
  const monotone = !strict.length && !absentInQuery && !(qp && (['count', 'every'].includes(qp.mode) || qp.forms?.rank));
  return {monotone, over, defaults, aggregates: sp.aggregates.map(a => a.id)};
}

const baseInfo = (extra = {}) => ({strategy: 'sql-sqlite', guarantee: 'exact', ...extra});

function packetOf({qp, sliced, outcome, exhausted, policy, budget, notes, viewSize, support, ran, backend}) {
  const sensitivity = sensitivityOf(sliced, qp);
  const common = {
    budget: budget.snapshot(Boolean(exhausted)), sensitivity, ignored: sliced.ignored, notes: [...notes],
    retrieval: {complete: true, truncated: false, keyed: false, steps: 0, wires: viewSize, probes: 0}, sql: {backend: backend.id, ...ran}
  };
  if (exhausted) {
    const partialOk = sensitivity.monotone && policy.partial !== 'forbid' && ['select', 'exists', 'explain'].includes(qp.mode) && outcome?.rows.length && ['supported', 'both'].includes(outcome.status);
    if (!partialOk) return baseInfo({status: 'budget_exhausted', complete: false, reason: exhausted.reason, ...common});
    return baseInfo({status: outcome.status, complete: false, reason: exhausted.reason, ...(qp.mode === 'select' ? {rows: outcome.rows.map(r => r.row)} : {}), ...common, used: []});
  }
  const packet = {status: outcome.status, complete: true, ...common};
  if (outcome.reason) packet.reason = outcome.reason;
  // `mode every` with `select` answers the groups where the universal holds (the oracle's grouped every)
  if (qp.mode === 'select' || (qp.mode === 'every' && qp.select.length)) packet.rows = outcome.rows.map(r => r.row);
  if (qp.mode === 'select' && qp.forms && packet.rows.length > qp.forms.limit) {
    packet.rows = packet.rows.slice(0, qp.forms.limit);
    packet.truncated = true;
  }
  if (qp.mode === 'count') { packet.count = outcome.count; if (outcome.bound) packet.bound = outcome.bound; }
  Object.assign(packet, support ?? {});
  return baseInfo(packet);
}

/** One complete solve of the circuits with some assumptions removed. Returns a packet without `conditional`. */
export function solveOnce(backend, handle, qWires, excluded, budgetArg, options = {}) {
  const live = qWires.filter(w => !(w.type === 'fact' && excluded.has(w.id)));
  const queryWire = live.find(w => w.type === 'query');
  if (live.some(w => w.type === 'constraint') && !queryWire) throw new NotExpressibleError(['constraint'], 'numeric constraints are not run by sql-sqlite');
  if (!queryWire) throw new ProgramError('no_query', 'the query circuit holds no query');
  const q = readQuery(queryWire, excluded);
  const policy = readPolicy(live, q);
  if (policy.procedures) throw new NotExpressibleError(['procedures'], 'policy procedures selects modes of work, which are not expressible');
  if (backend.id === 'bank' && (q.during || q.overlaps)) throw new NotExpressibleError(['interval'], 'the bank mode answers a point in time (at, asof), not an interval');
  const budget = new SqlBudget(mergeLimits(budgetArg, policy.limits), {effort: policy.effort});
  const program = buildProgram(handle, live, q, excluded);
  const seeds = conditionAlts(q.wire.fields.filter(f => ['where', 'scope'].includes(f.key)), q.wire.id).flatMap(alt => alt.filter(l => l.kind === 'atom' || l.kind === 'timeof').map(l => l.p));
  const sliced = sliceProgram(program, seeds);
  const planned = planQuery(q.wire, program.closed, {mode: q.mode, select: q.select, forms: q.forms});
  // exact decimals: integer arithmetic over values scaled by 10^S (solver-common/fixed-point.mjs); the codec divides them back
  const fx = planFixedPoint(sliced.program, planned.alts.concat(planned.scopeAlts));
  if (fx && backend.id === 'bank') throw new NotExpressibleError(['exact_arithmetic'], 'the bank mode compares the stored JSON text of numbers; decimals need the in-memory mode');
  const sp = fx ? scaleProgram(sliced.program, fx) : sliced.program;
  const qp = fx ? scaleQuery(planned, fx) : planned;
  if (backend.id === 'bank' && [...sp.rules.flatMap(r => r.alts), ...sp.aggregates.flatMap(a => a.alts), ...qp.alts, ...qp.scopeAlts].some(a => a.leaves.some(l => l.kind === 'timeof'))) {
    throw new NotExpressibleError(['time_vars'], 'start_of and end_of need stored validity text, which the bank mode does not read');
  }
  const started = performance.now();
  const notes = new Set();
  const {how, instants} = timeParts(sp.facts, q);
  const rels = collectRelations(sp, qp);
  const parts = [];
  let exhausted = null, viewSize = 0, ran = null, support = null;
  for (let i = 0; i < instants.length && !exhausted; i++) {
    const view = viewAt(sp.facts, instants[i]);
    viewSize = Math.max(viewSize, view.length);
    const partBudget = i === 0 ? budget : budget.child();
    const session = backend.open(partBudget);
    if (fx) session.codec = fixedCodec(session.codec, fx);
    try {
      const kinds = backend.kinds(sp);
      backend.setup(session, {rels, program: sp, view, kinds, instant: instants[i], asof: q.asof});
      const closure = new Closure({session, program: sp, rels, kinds, budget: partBudget, notes, temp: backend.temp});
      exhausted = closure.run({recursion: options.recursion ?? 'auto', demand: options.demand === false ? null : queryDemand(sp, qp)});
      if (fx?.flag && !exhausted && session.get(`SELECT 1 AS x FROM ${tbl(INEXACT, 0, false)} LIMIT 1`)) throw inexactError(fx);
      ran = {strata: closure.strategyOf, statements: closure.stats.statements, rounds: closure.stats.rounds, ...(closure.demanded.length ? {demand: closure.demanded} : {})};
      // the closure is read without the budget it just spent (the oracle's READ_BUDGET); a stop while reading is a budget_exhausted answer
      if (exhausted) session.budget = new SqlBudget({timeoutMs: 5000}, {});
      const answerer = new Answerer({session, qp, program: sp, kinds, notes});
      let outcome = null;
      try { outcome = answerer.evaluate({needRows: instants.length > 1}); } catch (e) {
        if (!(e instanceof BudgetStop)) throw e;
        exhausted = exhausted ?? {reason: e.reason, key: e.key};
      }
      if (outcome) parts.push(outcome);
      if (outcome && !exhausted && options.provenance !== false && instants.length === 1) {
        if (fx) session.codec = rebinding(session.codec, fx);
        support = supportOf({session, program: sp, qp, kinds, outcome, facts: view, maxNodes: options.provenanceNodes, refFor: backend.refFor, fx}).fields;
      }
    } finally {
      session.close();
    }
  }
  const outcome = parts.length ? (parts.length === 1 ? parts[0] : combineParts(qp, parts, how)) : null;
  if (fx) notes.add(`fixed_point_scale_${fx.scale}`);
  const packet = packetOf({qp, sliced, outcome, exhausted, policy, budget, notes, viewSize, support, ran, backend});
  packet.timings = {ask: Math.round(performance.now() - started)};
  return packet;
}
