/**
 * StrategyRouter v1 (DS006 "Routing rules", DS010): chooses the engine of a wire-level question when the caller names none.
 *
 *   explicit request   a strategy id (`sql-sqlite`, `datalog-souffle`, `asp-clingo`, `datalog-e10`, `prolog-tabling`, or the oracle's
 *                      `reference`/`js-reference`/`js-oracle`) runs exactly that engine. Never substituted (AGENTS.md rule 8): an engine
 *                      that is not installed is `unsupported/backend_unavailable`, a circuit it cannot express is `unsupported/not_expressible`,
 *                      both naming the requested engine in `route.backend` with `fallback: null`.
 *   `auto` (default)   rules, in order, each reported as `route.rule`:
 *     R1 proof_or_mode_of_work   explain, why_not, plan, abduce, constraints, norms, methods, host query forms: the oracle (the product
 *                                route; only it gives the proof and the modes of work). A question that sets its own budget
 *                                (R1b `caller_budget`: a policy wire or a budget argument) also stays on the oracle, which defines the budget keys.
 *     R2 small                   fewer facts than the threshold of the circuit class: the oracle (exact, with provenance, no process start).
 *     R3 scale                   the first eligible, installed engine of the class order: linear recursion `sql-sqlite`, `datalog-souffle`,
 *                                `asp-clingo`; everything else (nonlinear recursion, joins, negation, aggregates) `datalog-souffle`,
 *                                `sql-sqlite` (also time, any size), `asp-clingo` (inside its wire limit). Soufflé has no time.
 *     R4 oracle                  nothing eligible: the oracle (it answers or reports its budget honestly).
 *   The oracle stays the verifier: a routed answer is re-checked by the oracle (always up to `verify.always_facts`, else a
 *   deterministic sample of `verify.sample` of the questions, with a bounded budget); a disagreement returns the ORACLE's answer and reports
 *   the discrepancy in `route.verification`. An engine that throws `not_expressible` for an `auto` question falls back to the oracle (the
 *   caller named no engine, so this is routing, not substitution) and says so in `route.reason`.
 *
 * Every answer carries `route: {requested, chosen, rule, reason, features, alternatives, fallback: null, verification}`.
 */
import {parse} from '../../sop/knowledge/index.mjs';
import {digest} from '../../lib/util.mjs';
import {ProgramError, NotExpressibleError} from '../strategies/js-reference/values.mjs';
import {circuitFeatures, sensitivityFor} from './features.mjs';
import {ENGINES, ORACLE, ORACLE_IDS, eligibility} from './engines.mjs';
import {verifyAnswer} from '../strategies/js-reference/index.mjs';
import {CEILINGS} from '../strategies/js-reference/budget.mjs';
import {ORDER_SAMPLING, ORDER_SAMPLING_MODES} from '../../sop/enums.mjs';
import {sampleAnswers} from '../sample.mjs';

export {circuitFeatures};

/**
 * Defaults, from the measured table `eval/reports/current/router/timing.json` (tools/eval/engines/router-timing.mjs, DS010): the oracle is
 * faster or equal below these sizes and exhausts its budget above them (recursion: a transitive closure grows quadratically).
 */
export const ROUTER_DEFAULTS = Object.freeze({
  small_facts: {nonlinear: 100, recursion: 300, other: 10000},
  // the first installed, qualified engine that expresses the circuit wins; linear recursion with a bound argument is a recursive CTE in SQLite
  // (ring 10^5: 262 ms against 406, selective 10^5: 247 ms against 1504), everything else bulk is Soufflé (dense nonlinear 200 nodes: 471 ms
  // against 4744; aggregates 10^5: 324 against 562)
  engine_order: {linear_recursion: ['sql-sqlite', 'datalog-souffle', 'asp-clingo'], default: ['datalog-souffle', 'sql-sqlite', 'asp-clingo']},
  verify: {always_facts: 20000, sample: 0.125, budget: {timeoutMs: 3000, maxJoins: 3_000_000}},
});

const merge = (a, b) => ({...a, ...b, small_facts: {...a.small_facts, ...b?.small_facts}, engine_order: {...a.engine_order, ...b?.engine_order}, verify: {...a.verify, ...b?.verify, budget: {...a.verify.budget, ...b?.verify?.budget}}});

const unsupported = (requested, code, detail, extra = {}) => ({
  strategy: requested, status: 'unsupported', complete: false, code, detail, ...extra,
  route: {requested, chosen: null, backend: requested, fallback: null, reason: detail},
});

/** The decision for a circuit: chosen engine, the rule that chose it, and every engine considered with why it was or was not eligible. */
export function decide(features, {config = ROUTER_DEFAULTS} = {}) {
  const alternatives = [];
  const oracle = (rule, reason) => ({chosen: ORACLE, rule, reason, alternatives});
  const consider = id => { const e = eligibility(id, features); const available = ENGINES[id].available(); const row = {id, eligible: e.eligible && available, why: !available ? 'not installed' : e.why || 'eligible'}; alternatives.push(row); return row; };
  const order = features.recursion && !features.nonlinear ? config.engine_order.linear_recursion : config.engine_order.default;
  const candidates = order.map(consider);
  if (features.invalid) return oracle('oracle', 'the circuit does not compile; the oracle reports the error: ' + features.invalid);
  if (features.mode_of_work || features.proof || features.constraint) {
    return oracle('proof_or_mode_of_work', 'the question needs ' + (features.proof ? 'a proof' : 'a mode of work or a constraint') + ', which only the oracle provides');
  }
  if (features.budgeted) return oracle('caller_budget', 'the question sets its own budget (a policy wire or a budget argument); the budget keys and the partial answers under them are defined by the oracle');
  const klass = features.nonlinear ? 'nonlinear' : features.recursion ? 'recursion' : 'other';
  const threshold = config.small_facts[klass];
  if (features.facts < threshold) return oracle('small', `${features.facts} facts is below ${threshold} (${klass} circuit): the oracle answers exactly and with provenance`);
  const pick = candidates.find(c => c.eligible);
  if (pick) return {chosen: pick.id, rule: 'scale', reason: `${features.facts} facts (${[features.recursion && 'recursion', features.naf && 'negation', features.aggregate && 'aggregates', features.temporal && 'time'].filter(Boolean).join(', ') || 'joins'}) at or above ${threshold}: ${pick.id} is the first installed engine that expresses it`, alternatives};
  return oracle('oracle', 'no routable engine is installed and able to express this circuit: ' + candidates.map(c => `${c.id} ${c.why}`).join('; '));
}

/** The comparison of two packets of the same question: status, completeness and the rows or the count. */
export function samePacket(a, b) {
  const key = r => JSON.stringify(Object.entries(r).sort(([x], [y]) => (x < y ? -1 : 1)));
  const rows = p => (p.rows ? p.rows.map(key).sort() : null);
  return a.status === b.status && (a.complete !== false) === (b.complete !== false) && JSON.stringify(rows(a)) === JSON.stringify(rows(b)) && (a.count ?? null) === (b.count ?? null) && (a.bound ?? null) === (b.bound ?? null) && Boolean(a.truncated) === Boolean(b.truncated);
}

/** The oracle's answer; a circuit even the oracle declares not expressible is reported `unsupported`, with the missing features. */
function oracleAnswer(run, route) {
  try { return {...run(ORACLE), route}; } catch (e) {
    if (e instanceof NotExpressibleError) return {...unsupported('auto', 'not_expressible', e.message, {features: e.features}), route: {...route, chosen: ORACLE, backend: null, reason: e.message}};
    throw e;
  }
}

const sampled = (seed, rate) => rate >= 1 || (rate > 0 && parseInt(digest(seed).slice(0, 8), 16) / 0x100000000 < rate);

/**
 * Answer a wire-level question.
 * @param handle      {wires}
 * @param query       the query circuit text
 * @param requested   'auto' (default) or an engine id (rule 8)
 * @param verify      'auto' (default: the policy above), 'always', 'never', or 'offline' (defer replay for the report pass)
 * @param verifyBudget independent trusted oracle-replay limits; never changes execution routing
 * @param seed        the seed of `order random` (the turn time or an explicit seed); reported in the packet's `sample`
 */
export function routedAsk({query, queryWires = null, seed = Date.now(), ...rest}) {
  if (!queryWires) {
    const parsed = parse(query ?? '');
    if (parsed.errors.length) throw new ProgramError(parsed.errors[0].code, `query: ${parsed.errors[0].message} (line ${parsed.errors[0].line})`);
    queryWires = parsed.wires;
  }
  // `order random` (DS004 "Sampling") is applied here, once, after whichever route answers: the engine computes the full answer set of
  // the query without the option and without its limit, then the rows are shuffled with the request's seed and cut by the limit.
  const sampling = readSampling(queryWires);
  if (!sampling) return routeOnce({...rest, query, queryWires});
  const packet = routeOnce({...rest, query: sampling.query(query ?? ''), queryWires: sampling.queryWires});
  if (!Array.isArray(packet.rows)) return packet;
  const drawn = sampleAnswers(packet.rows, {limit: sampling.limit, seed});
  return {...packet, rows: drawn.items, sample: drawn.sample, ...(drawn.truncated || packet.truncated ? {truncated: true} : {})};
}

/**
 * The `order random` line of a parsed query circuit: null without one; otherwise its limit and the query text and wires without the
 * line and without the limit (the full answer set). More than one line, or a mode other than ORDER_SAMPLING_MODES, is a ProgramError.
 */
export function readSampling(queryWires) {
  const query = queryWires.find(w => w.type === 'query');
  const lines = query ? query.fields.filter(f => f.key === 'order' && ORDER_SAMPLING.includes(f.value.trim())) : [];
  if (!lines.length) return null;
  if (lines.length > 1) throw new ProgramError('order_random_repeated', 'a query takes at most one order random line', query.id);
  const mode = query.fields.find(f => f.key === 'mode')?.value.trim() ?? 'select';
  if (!ORDER_SAMPLING_MODES.includes(mode)) throw new ProgramError('order_random_mode', `order random samples the answers of mode ${ORDER_SAMPLING_MODES.join('|')}, not mode ${mode}`, query.id);
  const limitField = query.fields.find(f => f.key === 'limit');
  const dropped = new Set([lines[0], ...(limitField ? [limitField] : [])]);
  const dropLines = new Set([...dropped].map(f => f.line));
  return {
    limit: limitField ? Number(limitField.value) : Infinity,
    queryWires: queryWires.map(w => (w === query ? {...w, fields: w.fields.filter(f => !dropped.has(f))} : w)),
    query: text => text.split('\n').filter((_, i) => !dropLines.has(i + 1)).join('\n'),
  };
}

function routeOnce({handle, query, queryWires, requested = 'auto', budget = {}, verifyBudget = {}, verify = 'auto', config = ROUTER_DEFAULTS}) {
  const cfg = merge(ROUTER_DEFAULTS, config === ROUTER_DEFAULTS ? {} : config);
  const problem = {handle, query, queryWires};
  const run = id => ENGINES[id].ask(problem, budget);

  if (requested !== 'auto') {
    const id = ORACLE_IDS.includes(requested) ? ORACLE : requested;
    if (!ENGINES[id]) return unsupported(requested, 'unknown_strategy', `No wire-level strategy is registered as ${requested}; the choices are ${[...ORACLE_IDS, ...Object.keys(ENGINES).filter(k => k !== ORACLE)].join(', ')} or auto.`);
    if (!ENGINES[id].available()) return unsupported(requested, 'backend_unavailable', `${id} is not available in this installation`);
    try {
      const packet = run(id);
      const result = {...packet, route: {requested, chosen: id, backend: id, fallback: null, reason: 'explicit request'}};
      if (id === ORACLE || verify === 'auto' || verify === 'never') return result;
      if (verify === 'offline') return deferVerification(result);
      return verifyPacket({handle, query, queryWires, packet: result, verifyBudget: {...CEILINGS, ...cfg.verify.budget, ...verifyBudget}, policy: 'always'});
    } catch (e) {
      if (e instanceof NotExpressibleError) return unsupported(requested, 'explicit_backend_not_available_for_query', e.message, {features: e.features});
      throw e;
    }
  }

  const features = circuitFeatures(handle, queryWires);
  if (Object.keys(budget).length) features.budgeted = true;
  const decision = decide(features, {config: cfg});
  const route = {requested: 'auto', chosen: decision.chosen, rule: decision.rule, reason: decision.reason, features: summary(features), alternatives: decision.alternatives, fallback: null};
  if (decision.chosen === ORACLE) return oracleAnswer(run, route);

  let packet;
  try {
    packet = run(decision.chosen);
  } catch (e) {
    if (!(e instanceof NotExpressibleError)) throw e;
    return oracleAnswer(run, {...route, chosen: ORACLE, rule: 'oracle', reason: `${decision.chosen} declared the circuit not expressible (${e.features.join(', ')}); the question named no engine, so the oracle answers`});
  }
  // a scaled decimal or a large sum can leave the 32-bit or 64-bit range of an integer engine: that is a limit of the engine, not an answer
  if (packet.status === 'budget_exhausted' && packet.reason === 'numeric_range') {
    return oracleAnswer(run, {...route, chosen: ORACLE, rule: 'oracle', reason: `${decision.chosen} left its integer range (numeric_range); the question named no engine, so the oracle answers`});
  }
  packet = {...packet, sensitivity: packet.sensitivity ?? sensitivityFor(features)};
  if (verify === 'offline') return deferVerification({...packet, route});
  const mode = verify === 'auto' ? (features.facts <= cfg.verify.always_facts ? 'always' : sampled(digest(String(handle.wires.length) + '\0' + query), cfg.verify.sample) ? 'sample' : 'skipped') : verify === 'always' ? 'always' : 'skipped';
  if (mode === 'skipped') return {...packet, route: {...route, verification: {checked: false, policy: verify === 'never' ? 'never' : 'not in the sample'}}};
  return verifyPacket({handle, query, queryWires, packet: {...packet, route}, verifyBudget: {...CEILINGS, ...cfg.verify.budget, ...verifyBudget}, policy: mode});
}

const deferVerification = packet => ({...packet, route: {...packet.route, verification: {checked: false, outcome: 'deferred', policy: 'offline'}}});
const brief = p => ({status: p.status, complete: p.complete !== false, rows: p.rows?.length ?? null, count: p.count ?? null, bound: p.bound ?? null});

/** Replay a saved engine answer over the ORIGINAL problem without rerunning the engine; reports actual oracle limits and unresolved budgets. */
export function verifyPacket({handle, query, queryWires = null, packet, verifyBudget = {}, policy = 'offline'}) {
  const route = packet.route ?? {requested: packet.strategy, chosen: packet.strategy, fallback: null};
  const t0 = performance.now();
  const check = verifyAnswer({handle, query, ...(queryWires ? {queryWires} : {})}, verifyBudget);
  const ms = Math.round(performance.now() - t0);
  const verification = {checked: check.complete !== false, policy, ms, budget: check.budget};
  if (check.complete === false) return {...packet, route: {...route, verification: {...verification, outcome: 'unverified', reason: 'oracle_budget_' + (check.budget?.reason ?? check.reason ?? 'exhausted'), oracle_status: check.status}}};
  if (samePacket(packet, check)) return {...packet, route: {...route, verification: {...verification, outcome: 'agreed'}}};
  const discrepancy = {...verification, outcome: 'discrepancy', engine: route.chosen, engine_answer: brief(packet), oracle_answer: brief(check)};
  if (route.requested !== 'auto') {
    const result = unsupported(route.requested, 'verification_discrepancy', `${route.chosen} disagreed with the oracle; the explicitly requested engine is not substituted`);
    return {...result, route: {...result.route, verification: discrepancy}};
  }
  return {...check, route: {...route, chosen: ORACLE, rule: 'discrepancy', reason: `${route.chosen} disagreed with the oracle; the oracle's answer is returned`, verification: discrepancy}};
}

const summary = f => ({mode: f.mode, facts: f.facts, rules: f.rules, aggregates: f.aggregates, defaults: f.defaults, integrity: f.integrity, recursion: f.recursion, nonlinear: f.nonlinear, negation: f.naf, aggregate: f.aggregate, count: f.count, every: f.every, temporal: f.temporal, monotone: f.monotone, required: f.required});
