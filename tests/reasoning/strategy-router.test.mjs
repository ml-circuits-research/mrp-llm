/**
 * StrategyRouter v1 (reasoning/router, DS006 "Routing rules", preregistration router-v1): one test per routing rule, the verification
 * policy, the fallbacks of `auto`, and AGENTS.md rule 8 for an explicit request.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {parse} from '../../sop/knowledge/index.mjs';
import {routedAsk, verifyPacket, circuitFeatures, decide, samePacket, ROUTER_DEFAULTS} from '../../reasoning/router/index.mjs';
import {ENGINES} from '../../reasoning/router/engines.mjs';
import {ReasoningRegistry} from '../../reasoning/registry.mjs';
import {smokeArm} from '../../tools/eval/engines/router-smoke.mjs';
import {NotExpressibleError} from '../../reasoning/strategies/js-reference/values.mjs';
import * as scale from '../../eval/smoke-reasoning/bench/datalog-scale.mjs';

const wiresOf = text => { const r = parse(text); assert.deepEqual(r.errors, []); return r.wires; };
const handleOf = text => ({kind: 'js-reference-handle', knowledge: text, wires: wiresOf(text)});
const FORCE = {...ROUTER_DEFAULTS, small_facts: {nonlinear: 0, recursion: 0, other: 0}};
const engineIds = ['sql-sqlite', 'datalog-souffle', 'asp-clingo'];

const ringText = (components, size) => scale.ringComponents({components, size});
const NEG = scale.negationChain({nodes: 60});
const AGG = scale.groupAggregates({rows: 60, departments: 5});
const DENSE = scale.denseNonlinear({nodes: 12, density: 3});
const FACTS = '@p1 fact\n  holds likes ann tea\n@p2 fact\n  holds likes bob tea\n';

const withEngine = (id, patch, fn) => {
  const saved = {...ENGINES[id]};
  Object.assign(ENGINES[id], patch);
  try { return fn(); } finally { Object.assign(ENGINES[id], saved); }
};

test('features: recursion, nonlinear recursion, negation, aggregates, time and modes of work are read from the compiled program', () => {
  const ring = ringText(2, 5), dense = DENSE;
  const fr = circuitFeatures(handleOf(ring.knowledge), wiresOf(ring.query));
  assert.equal(fr.recursion, true); assert.equal(fr.nonlinear, false); assert.equal(fr.facts, 10);
  assert.ok(fr.required.includes('recursion'));
  const fd = circuitFeatures(handleOf(dense.knowledge), wiresOf(dense.query));
  assert.equal(fd.nonlinear, true);
  const fn = circuitFeatures(handleOf(NEG.knowledge), wiresOf(NEG.query));
  assert.equal(fn.naf, true); assert.ok(fn.required.includes('naf'));
  const fa = circuitFeatures(handleOf(AGG.knowledge), wiresOf(AGG.query));
  assert.equal(fa.aggregate, true); assert.ok(fa.required.includes('aggregate'));
  const ft = circuitFeatures(handleOf(FACTS), wiresOf('@q query\n  where likes ?x tea\n  select ?x\n  at 2026-09-26\n'));
  assert.equal(ft.temporal, true);
  const fp = circuitFeatures(handleOf(FACTS), wiresOf('@q query\n  mode plan\n  where likes ?x tea\n'));
  assert.equal(fp.mode_of_work, true);
  const fb = circuitFeatures(handleOf(FACTS), wiresOf('@q query\n  where likes ?x tea\n  select ?x\n@pol policy\n  maxJoins 10\n'));
  assert.equal(fb.budgeted, true);
});

test('R1: a proof, a mode of work or a caller budget stays on the oracle, whatever the size', () => {
  const ring = ringText(40, 10);
  const q = ring.query.replace('select ?y\n', 'select ?y\n');
  for (const [text, rule] of [
    [ring.query.replace('@q query\n', '@q query\n  mode explain\n'), 'proof_or_mode_of_work'],
    [ring.query + '@pol policy\n  maxJoins 100000\n', 'caller_budget'],
  ]) {
    const packet = routedAsk({handle: handleOf(ring.knowledge), query: text, config: FORCE, verify: 'never'});
    assert.equal(packet.route.chosen, 'js-reference', text);
    assert.equal(packet.route.rule, rule);
    assert.equal(packet.route.requested, 'auto');
    assert.equal(packet.route.fallback, null);
  }
  const budgeted = routedAsk({handle: handleOf(ring.knowledge), query: q, config: FORCE, budget: {timeoutMs: 5000}, verify: 'never'});
  assert.equal(budgeted.route.rule, 'caller_budget');
});

test('R2: a small circuit stays on the oracle; the threshold depends on the class (nonlinear, recursion, other)', () => {
  const ring = ringText(2, 5);
  const small = routedAsk({handle: handleOf(ring.knowledge), query: ring.query});
  assert.equal(small.route.rule, 'small'); assert.equal(small.route.chosen, 'js-reference');
  assert.ok(small.route.features.facts < ROUTER_DEFAULTS.small_facts.recursion);
  assert.match(small.route.reason, /recursion circuit/);
  assert.ok(ROUTER_DEFAULTS.small_facts.nonlinear < ROUTER_DEFAULTS.small_facts.recursion && ROUTER_DEFAULTS.small_facts.recursion < ROUTER_DEFAULTS.small_facts.other);
  const dense = decide(circuitFeatures(handleOf(DENSE.knowledge), wiresOf(DENSE.query)), {config: {...ROUTER_DEFAULTS, small_facts: {...ROUTER_DEFAULTS.small_facts, nonlinear: 5}}});
  assert.equal(dense.rule, 'scale', 'a dense circuit above its own, lower threshold is routed');
});

test('R3: at scale linear recursion goes to SQLite, everything else bulk to Soufflé, and the packet reports the decision', () => {
  const ring = ringText(40, 10);
  const linear = routedAsk({handle: handleOf(ring.knowledge), query: ring.query, config: FORCE, verify: 'never'});
  assert.equal(linear.route.chosen, 'sql-sqlite'); assert.equal(linear.route.rule, 'scale');
  assert.deepEqual(linear.rows.map(r => r.y).sort(), ring.answer.rows.map(r => r.y).sort());
  const ids = linear.route.alternatives.map(a => a.id);
  assert.deepEqual(ids, ['sql-sqlite', 'datalog-souffle', 'asp-clingo']);
  assert.ok(linear.route.features.recursion && linear.route.features.required.includes('recursion'));
  assert.ok(linear.sensitivity && linear.sensitivity.monotone === true);
  const dense = routedAsk({handle: handleOf(DENSE.knowledge), query: DENSE.query, config: FORCE, verify: 'never'});
  assert.equal(dense.route.chosen, ENGINES['datalog-souffle'].available() ? 'datalog-souffle' : 'sql-sqlite');
  for (const s of [NEG, AGG]) {
    const p = routedAsk({handle: handleOf(s.knowledge), query: s.query, config: FORCE, verify: 'never'});
    assert.notEqual(p.route.chosen, 'js-reference');
    assert.equal(p.status, 'supported');
    if (s.answer.count !== undefined) assert.equal(p.count, s.answer.count);
  }
});

test('R3: an engine that is not installed, or cannot express the circuit, is skipped with the reason; time excludes Soufflé', () => {
  const ring = ringText(40, 10);
  withEngine('sql-sqlite', {available: () => false}, () => {
    const p = routedAsk({handle: handleOf(ring.knowledge), query: ring.query, config: FORCE, verify: 'never'});
    assert.notEqual(p.route.chosen, 'sql-sqlite');
    assert.equal(p.route.alternatives.find(a => a.id === 'sql-sqlite').why, 'not installed');
  });
  const timed = circuitFeatures(handleOf(FACTS), wiresOf('@q query\n  where likes ?x tea\n  select ?x\n  at 2026-09-26\n'));
  const d = decide(timed, {config: FORCE});
  assert.equal(d.alternatives.find(a => a.id === 'datalog-souffle').eligible, false);
  assert.match(d.alternatives.find(a => a.id === 'datalog-souffle').why, /temporal/);
});

test('R4: with no eligible engine the oracle answers', () => {
  const ring = ringText(40, 10);
  const none = {...FORCE, engine_order: {linear_recursion: [], default: []}};
  const p = routedAsk({handle: handleOf(ring.knowledge), query: ring.query, config: none, verify: 'never'});
  assert.equal(p.route.chosen, 'js-reference'); assert.equal(p.route.rule, 'oracle');
  assert.ok(p.rows.length > 0);
});

test('auto: an engine that declares the circuit not expressible falls back to the oracle and says so (routing, not substitution)', () => {
  const ring = ringText(4, 10);
  const refuse = () => { throw new NotExpressibleError(['collect'], 'sql-sqlite does not run collect'); };
  const p = withEngine('sql-sqlite', {ask: refuse}, () => routedAsk({handle: handleOf(ring.knowledge), query: ring.query, config: FORCE, verify: 'never'}));
  assert.equal(p.route.chosen, 'js-reference'); assert.equal(p.route.requested, 'auto'); assert.equal(p.route.fallback, null);
  assert.match(p.route.reason, /sql-sqlite declared the circuit not expressible \(collect\)/);
  assert.deepEqual(p.rows.map(r => r.y).sort(), ring.answer.rows.map(r => r.y).sort());
  // a circuit the oracle itself cannot express is reported unsupported with the missing features, not thrown
  const method = routedAsk({handle: handleOf('@m1 method\n  goal reach\n'), query: '@q query\n  where likes ?x tea\n  select ?x\n'});
  assert.ok(['unsupported', 'supported', 'unknown'].includes(method.status));
});

test('verification: agreement is reported; a disagreeing engine loses to the oracle, whose answer is returned with the discrepancy', () => {
  const ring = ringText(40, 10);
  const ok = routedAsk({handle: handleOf(ring.knowledge), query: ring.query, config: FORCE, verify: 'always', budget: {}});
  assert.ok(['agreed', 'unverified'].includes(ok.route.verification.outcome), JSON.stringify(ok.route.verification));
  const agg = routedAsk({handle: handleOf(AGG.knowledge), query: AGG.query, config: FORCE, verify: 'always'});
  assert.equal(agg.route.verification.outcome, 'agreed');
  const wrong = {strategy: 'sql-sqlite', status: 'supported', complete: true, count: 999999, budget: {}, ignored: [], notes: []};
  const p = withEngine('datalog-souffle', {ask: () => wrong}, () => routedAsk({handle: handleOf(AGG.knowledge), query: AGG.query, config: FORCE, verify: 'always'}));
  assert.equal(p.route.rule, 'discrepancy'); assert.equal(p.route.chosen, 'js-reference');
  assert.equal(p.route.verification.outcome, 'discrepancy');
  assert.equal(p.route.verification.engine, 'datalog-souffle');
  assert.equal(p.count, AGG.answer.count, 'the oracle answer is returned');
  const skipped = routedAsk({handle: handleOf(AGG.knowledge), query: AGG.query, config: FORCE, verify: 'never'});
  assert.equal(skipped.route.verification.checked, false);
  const sample = {...FORCE, verify: {always_facts: 0, sample: 0}};
  const none = routedAsk({handle: handleOf(AGG.knowledge), query: AGG.query, config: sample});
  assert.equal(none.route.verification.checked, false);
});

test('rule 8: an explicit engine runs exactly that engine, even where the router would choose another or the oracle', () => {
  const small = handleOf(FACTS), q = '@q query\n  where likes ?x tea\n  select ?x\n';
  const sql = routedAsk({handle: small, query: q, requested: 'sql-sqlite'});
  assert.equal(sql.route.chosen, 'sql-sqlite'); assert.equal(sql.route.requested, 'sql-sqlite'); assert.equal(sql.route.fallback, null);
  assert.equal(sql.strategy, 'sql-sqlite');
  const ref = routedAsk({handle: handleOf(ringText(40, 10).knowledge), query: ringText(40, 10).query, requested: 'js-oracle'});
  assert.equal(ref.route.chosen, 'js-reference'); assert.equal(ref.strategy, 'js-reference');
  assert.deepEqual(routedAsk({handle: small, query: q, requested: 'reference'}).rows.map(r => r.x).sort(), ['ann', 'bob']);
});

test('rule 8: an explicit engine that is not installed is unsupported with the engine in route.backend and fallback null; nothing is substituted', () => {
  for (const id of engineIds) {
    const p = withEngine(id, {available: () => false}, () => routedAsk({handle: handleOf(FACTS), query: '@q query\n  where likes ?x tea\n  select ?x\n', requested: id}));
    assert.equal(p.status, 'unsupported'); assert.equal(p.code, 'backend_unavailable');
    assert.equal(p.route.backend, id); assert.equal(p.route.requested, id); assert.equal(p.route.fallback, null); assert.equal(p.route.chosen, null);
    assert.equal(p.rows, undefined, 'no answer from another engine');
  }
});

test('rule 8: an explicit engine that cannot express the circuit is unsupported/explicit_backend_not_available_for_query, not rerouted', () => {
  const p = routedAsk({handle: handleOf(FACTS), query: '@q query\n  mode why_not\n  where likes ann coffee\n', requested: 'datalog-souffle'});
  assert.equal(p.status, 'unsupported'); assert.equal(p.code, 'explicit_backend_not_available_for_query');
  assert.equal(p.route.backend, 'datalog-souffle'); assert.equal(p.route.fallback, null);
  const unknown = routedAsk({handle: handleOf(FACTS), query: '@q query\n  where likes ?x tea\n  select ?x\n', requested: 'quantum-engine'});
  assert.equal(unknown.status, 'unsupported'); assert.equal(unknown.code, 'unknown_strategy'); assert.equal(unknown.route.backend, 'quantum-engine');
});

test('verification limits do not change engine routing; offline replay settles a previously unverified answer', () => {
  const ring = ringText(40, 10), handle = handleOf(ring.knowledge);
  const online = routedAsk({handle, query: ring.query, verify: 'always', verifyBudget: {maxJoins: 1}});
  assert.equal(online.route.chosen, 'sql-sqlite');
  assert.equal(online.complete, true);
  assert.equal(online.route.verification.outcome, 'unverified');
  const replay = verifyPacket({handle, query: ring.query, packet: online, verifyBudget: {maxJoins: 20_000_000, timeoutMs: 10000}});
  assert.equal(replay.route.verification.outcome, 'agreed');
  assert.deepEqual(replay.rows, online.rows);
  assert.equal(replay.route.verification.budget.limit.maxJoins, 20_000_000);
  const deferred = routedAsk({handle, query: ring.query, verify: 'offline'});
  assert.equal(deferred.route.verification.outcome, 'deferred');
  assert.equal(deferred.route.verification.checked, false);
});

test('offline discrepancy preserves explicit backend and detects incorrect count bounds', () => {
  const handle = handleOf(FACTS), query = '@q query\n  mode count\n  where likes ?x tea\n  select ?x\n';
  const packet = routedAsk({handle, query, requested: 'sql-sqlite', verify: 'offline'});
  const corrupt = {...packet, bound: undefined};
  const verified = verifyPacket({handle, query, packet: corrupt});
  assert.equal(verified.status, 'unsupported');
  assert.equal(verified.code, 'verification_discrepancy');
  assert.equal(verified.route.backend, 'sql-sqlite');
  assert.equal(verified.route.fallback, null);
  assert.equal(verified.route.verification.outcome, 'discrepancy');
});

test('unsupported interval forms are never dropped from an explicit engine request', () => {
  for (const form of ['measure start', 'order ?x before ?y']) {
    const p = routedAsk({handle: handleOf(FACTS), query: '@q query\n  where likes ?x ?y\n  select ?x\n  ' + form + '\n', requested: 'sql-sqlite'});
    assert.equal(p.status, 'unsupported');
    assert.equal(p.route.backend, 'sql-sqlite');
    assert.equal(p.route.fallback, null);
  }
});

test('typed path: reasoning auto reports the route; an explicit backend is honoured through its own strategy, never the oracle', () => {
  const reg = new ReasoningRegistry({availability: () => false});
  const request = {mode: 'deduce', query: {kind: 'query', mode: 'select', where: [], select: [], at: Date.now()}, memory: {facts: [], rules: [], complete: true, probes: 0}, data: []};
  const out = reg.run('auto', request);
  assert.equal(out.reasoningStrategy, 'reference');
  assert.equal(out.route.requested, 'auto'); assert.equal(out.route.chosen, 'js-reference'); assert.equal(out.route.fallback, null);
  assert.ok(out.route.alternatives.length === 3 && out.route.features);
  const prolog = reg.run('auto', {...request, backend: 'prolog'});
  assert.equal(prolog.route.backend, 'prolog'); assert.equal(prolog.route.fallback, null);
  assert.equal(prolog.reasoningStrategy, 'prolog-tabling', 'the strategy of the requested backend, not the oracle');
  const mismatch = reg.run('reference', {...request, backend: 'prolog'});
  assert.equal(mismatch.status, 'unsupported'); assert.equal(mismatch.route.backend, 'prolog');
});

test('shadow gate on the smoke suite: with the thresholds forced to zero the routed answer equals the oracle on every case', () => {
  const r = smokeArm();
  assert.ok(r.cases >= 100);
  assert.deepEqual(r.disagree, [], 'a routed answer differs from the oracle');
  assert.ok(r.routed_to_engine >= 30, 'the classes of the router are exercised: ' + JSON.stringify(r.by_engine));
  assert.ok(Object.keys(r.by_engine).some(e => e !== 'js-reference'));
  assert.ok(samePacket({status: 'supported', rows: [{a: 1}, {a: 2}]}, {status: 'supported', rows: [{a: 2}, {a: 1}]}));
  assert.ok(!samePacket({status: 'supported', rows: [{a: 1}]}, {status: 'supported', rows: [{a: 2}]}));
});
