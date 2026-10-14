import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {vrcCompressedPlanning as vrc, NotExpressibleError} from '../../reasoning/strategies/vrc-compressed-planning/index.mjs';
import {readProgram, buildModel} from '../../reasoning/strategies/vrc-compressed-planning/model.mjs';
import {learn, importArtifact} from '../../reasoning/strategies/vrc-compressed-planning/compress.mjs';
import {jsReference} from '../../reasoning/strategies/js-reference/index.mjs';
import {compare} from '../../eval/smoke-reasoning/lib/compare.mjs';
import {lowerToStrips} from '../../eval/smoke-reasoning/lib/numeric-strips.mjs';
import {energyWorld, productWorld, guardRichControl} from '../../eval/smoke-reasoning/bench/vrc-worlds.mjs';
import {parseExpression, parseRational, parseGuard, parseObserve, parseNext, checkNumericAction, stateVariables, constantValue} from '../../sop/knowledge/numeric-action.mjs';
import {parse} from '../../sop/knowledge/index.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const caseDir = d => path.join(here, '../../eval/smoke-reasoning/cases', d);
const loadCase = d => ({knowledge: fs.readFileSync(path.join(caseDir(d), 'knowledge.sop'), 'utf8'), query: fs.readFileSync(path.join(caseDir(d), 'query.sop'), 'utf8'), expected: JSON.parse(fs.readFileSync(path.join(caseDir(d), 'expected.json'), 'utf8'))});
const run = (k, q, budget = {}, options = {learning: 'on-demand', shadow: true}) => vrc.ask({handle: vrc.prepare(k, {learning: options.learning ?? 'off', query: q}), query: q}, budget, options);

// ------------------------------------------------------------------------------------------- the grammar module (E2)
test('numeric-action syntax: exact rationals, polynomials, guards, observe', () => {
  assert.deepEqual(parseRational('0.25'), {n: 1n, d: 4n});
  assert.deepEqual(parseRational('-3/6'), {n: -1n, d: 2n});
  assert.equal(parseRational('1/0'), null);
  assert.equal(parseRational('abc'), null);
  assert.equal(parseExpression('?q + ?x0^2 - 3 * (?y + 1)').vars.length, 3);
  assert.match(parseExpression('?a / ?b').error, /constant/);
  assert.match(parseExpression('?a / 0').error, /zero/);
  assert.match(parseExpression('?a ^ ?b').error, /power/);
  assert.match(parseExpression('?a + eval(1)').error, /unexpected/, 'never JavaScript');
  assert.deepEqual(constantValue(parseExpression('1/2 + 1/3').ast), {n: 5n, d: 6n});
  assert.equal(parseNext('q ?q + 1').variable, 'q');
  assert.ok(parseGuard('?q below 10').word === 'below' && parseGuard('?q above').error);
  assert.deepEqual(parseObserve('demo ?q at_least 4808').threshold, {n: 4808n, d: 1n});
  assert.ok(parseObserve('demo ?q at_least').error);
  const w = parse('@a action\n  next q ?q + 1\n  next q ?q\n  adds x\n@b action\n  next r ?q + ?z\n  adds y\n').wires;
  const msgs = w.flatMap(x => checkNumericAction(x, stateVariables(w)).map(p => p.code));
  assert.ok(msgs.includes('duplicate_next') && msgs.includes('missing_next') && msgs.includes('unknown_state_variable'));
});

// ------------------------------------------------------------------------------------------------- the smoke cases 70-73
for (const d of ['70-vrc-energy-world-small', '71-vrc-product-world-small', '72-vrc-guard-rich-control', '73-vrc-horizon-budget']) {
  test(`smoke case ${d}: the compressed search agrees with expected.json, the full search and the replay`, () => {
    const c = loadCase(d);
    const got = run(c.knowledge, c.query);
    const cmp = compare(c.expected, got);
    assert.deepEqual(cmp.why, []);
    if (got.status === 'plan_found') assert.equal(got.witness.verified, true, 'the plan is replayed in the original laws');
    assert.equal(got.shadow?.status === 'FOUND' ? 'plan_found' : got.shadow?.status === 'BUDGET' ? 'budget_exhausted' : 'no_plan', got.status, 'shadow: the full search says the same');
  });
}

// ------------------------------------------------------------------------ shadow check against the oracle (js-oracle)
test('shadow gate: plan costs equal the oracle\'s uniform-cost planning over the lowered ground graph', () => {
  const cases = [loadCase('70-vrc-energy-world-small'), loadCase('71-vrc-product-world-small'), loadCase('72-vrc-guard-rich-control')];
  cases.push({knowledge: guardRichControl({a: 2, b: 3, goal: 18, horizon: 6}).knowledge, query: guardRichControl({a: 2, b: 3, goal: 18, horizon: 6}).query});
  cases.push({knowledge: guardRichControl({a: 1, b: 1, goal: 5, horizon: 5}).knowledge, query: guardRichControl({a: 1, b: 1, goal: 5, horizon: 5}).query});
  for (const w of [energyWorld({groups: 4, values: [[1, 2], [2, 1], [1, 1], [3, 1]], target: 60, horizon: 7}), productWorld({groups: 3, values: [[2, 3], [1, 1], [1, 2]], target: 30, horizon: 6})]) cases.push(w);
  for (const c of cases) {
    const mine = run(c.knowledge, c.query);
    const low = lowerToStrips(c.knowledge, c.query);
    const oracle = jsReference.ask({theory: {knowledge: low.knowledge}, query: low.query});
    if (mine.status === 'plan_found') { assert.equal(oracle.status, 'plan_found'); assert.equal(oracle.plan.cost, mine.plan.cost, 'shortest plan cost'); }
    else if (mine.status === 'budget_exhausted') assert.equal(oracle.status, 'no_plan', 'the oracle sees only the truncated graph');
  }
});

test('a finite closed state space with no plan is no_plan (complete); only a live frontier at the horizon is budget_exhausted', () => {
  const closed = '@state predicate\n  args subject:entity topic:entity object:rational\n@s fact\n  holds state d v 0\n@inc action\n  guard ?v below 3\n  next v ?v + 1\n';
  const goal = n => `@q query\n  mode plan\n  observe d ?v at_least ${n}\n  horizon 10\n`;
  const none = run(closed, goal(5));
  assert.equal(none.status, 'no_plan');
  assert.equal(none.complete, true);
  assert.equal(run(closed, goal(3)).status, 'plan_found');
  const unbounded = '@state predicate\n  args subject:entity topic:entity object:rational\n@s fact\n  holds state d v 0\n@inc action\n  next v ?v + 1\n';
  const cut = run(unbounded, goal(50).replace('horizon 10', 'horizon 5'));
  assert.equal(cut.status, 'budget_exhausted');
  assert.equal(cut.reason, 'horizon');
  assert.equal(cut.complete, false);
});

// --------------------------------------------------------------------------------------------- exact rational arithmetic
test('exact rationals: 1/10^13 is not 0, a value above 2^53 is exact, fractions never round', () => {
  const tiny = '@state predicate\n  args subject:entity topic:entity object:rational\n@s fact\n  holds state d v 0\n@a action\n  next v ?v + 1/10000000000000\n';
  const goal = (t, h = 8) => `@q query\n  mode plan\n  observe d ?v at_least ${t}\n  horizon ${h}\n`;
  assert.equal(run(tiny, goal('3/10000000000000')).plan.steps, 3);
  assert.equal(run(tiny, goal('1/20000000000000')).plan.steps, 1, 'half a step is reached by one');
  const big = '@state predicate\n  args subject:entity topic:entity object:rational\n@s fact\n  holds state d v 9007199254740992\n@a action\n  next v ?v + 1\n';
  const r = run(big, goal('9007199254740995'));
  assert.equal(r.plan.steps, 3, 'float64 would not tell 2^53 + 1 from 2^53');
  const third = '@state predicate\n  args subject:entity topic:entity object:rational\n@s fact\n  holds state d v 0\n@a action\n  next v ?v + 1/3\n';
  assert.equal(run(third, goal('1')).plan.steps, 3, 'three thirds are exactly one');
});

test('a port of VRC\'s own handover examples (product, fractional, precision, branching, bounded, missing state)', () => {
  const base = (a, b, goal, depth, guard = '') => guardRichControl({a, b, goal, horizon: depth}).knowledge.replace(/  guard \?a at_least 1\n/g, guard);
  const q = (g, h) => `@q query\n  mode plan\n  observe demo ?q at_least ${g}\n  horizon ${h}\n`;
  const product = run(base('2', '3', 18, 6, ''), q(18, 6));
  assert.equal(product.plan.steps, 3);
  const fractional = run(base('1/2', '2/3', 1, 6, ''), q(1, 6));
  assert.equal(fractional.status, 'plan_found');
  assert.equal(fractional.plan.steps, 3);
  const guard = run(guardRichControl({a: 2, b: 3, goal: 12, horizon: 6}).knowledge, q(12, 6));
  assert.equal(guard.plan.steps, 2);
  // branching: a mode that can go to a dead end or to a live mode; existential, the plan avoids the dead end
  const branching = '@s predicate\n  args none\n@live predicate\n  args none\n@dead predicate\n  args none\n@state predicate\n  args subject:entity topic:entity object:rational\n@m fact\n  holds s\n@st fact\n  holds state demo q 0\n@a_dead action\n  requires s\n  removes s\n  adds dead\n  next q ?q + 1\n@a_live action\n  requires s\n  removes s\n  adds live\n  next q ?q + 1\n@b action\n  requires live\n  removes live\n  adds s\n  next q ?q + 1\n';
  assert.equal(run(branching, q(2, 3)).plan.steps, 2);
  assert.deepEqual(run(branching, q(2, 3)).plan.names, ['a_live', 'b']);
  // VRC says NOT_FOUND ("complete within the bound") when the bound is hit; the proposal says budget_exhausted: a bound is not a negative
  const bounded = run(base('2', '3', 999, 2, ''), q(999, 2));
  assert.equal(bounded.status, 'budget_exhausted');
  assert.equal(bounded.reason, 'horizon');
  const missing = run(base('2', '3', 6, 6, '').replace('@sb fact\n  holds state demo b 3\n', ''), q(6, 6));
  assert.equal(missing.status, 'unknown');
  assert.equal(missing.reason, 'missing_state');
});

// -------------------------------------------------------------------------------------------- compression and artifacts
test('the certified encoding compresses the symmetric worlds and does nothing on the guard-rich control', () => {
  const stat = c => { const r = run(c.knowledge, c.query, {}, {learning: 'on-demand'}); return r.stats; };
  const e = stat(loadCase('70-vrc-energy-world-small'));
  assert.equal(e.cacheStatus, 'LEARNED');
  assert.equal(e.fullDimension, 9);
  assert.equal(e.dimension, 5, 'q and the four invariant norms');
  const p = stat(loadCase('71-vrc-product-world-small'));
  assert.ok(p.dimension < p.fullDimension);
  const g = stat(loadCase('72-vrc-guard-rich-control'));
  assert.equal(g.dimension, g.fullDimension, 'no smaller encoding exists: the negative control');
  const full = run(loadCase('71-vrc-product-world-small').knowledge, loadCase('71-vrc-product-world-small').query, {}, {learning: 'off'});
  assert.ok(p.unique * 3 < full.stats.unique, `unique states ${p.unique} against ${full.stats.unique}`);
});

test('an artifact is re-certified on import: a tampered model and a changed law are both rejected', () => {
  const c = loadCase('70-vrc-energy-world-small');
  const model = buildModel(readProgram(c.knowledge, 'k'), readProgram(c.query, 'q'));
  const learned = learn(model);
  assert.equal(learned.status, 'VERIFIED');
  assert.ok(importArtifact(learned.artifact, model).certificate.verified);
  const tampered = JSON.parse(JSON.stringify(learned.artifact));
  tampered.model.actions[0].G[0].terms[0][1] = '7';
  assert.throws(() => importArtifact(tampered, model), /verification failed|stale/);
  const other = loadCase('71-vrc-product-world-small');
  const m2 = buildModel(readProgram(other.knowledge, 'k'), readProgram(other.query, 'q'));
  assert.throws(() => importArtifact(learned.artifact, m2), /stale|differ/);
  // through the strategy: a rejected artifact falls back to the full search and the answer is still right
  const h = vrc.prepare(c.knowledge, {learning: 'reuse', artifact: tampered, query: c.query});
  assert.equal(h.cacheStatus, 'REJECTED');
  assert.equal(vrc.ask({handle: h, query: c.query}).status, 'plan_found');
});

test('one certified artifact serves a family: the contract excludes the initial facts and the threshold', () => {
  const a = loadCase('70-vrc-energy-world-small');
  const h = vrc.prepare(a.knowledge, {learning: 'on-demand', query: a.query});
  assert.equal(h.cacheStatus, 'LEARNED');
  const second = a.query.replace('at_least 100', 'at_least 200').replace('horizon 8', 'horizon 12');
  const r = vrc.ask({handle: h, query: second}, {}, {shadow: true});
  assert.equal(r.stats.backend, 'vrc');
  assert.equal(r.plan.steps, 7);
  // a changed law is a different contract: the handle drops the artifact (stale) and answers by the full search
  const changed = a.knowledge.replace('next q ?q + ?x0^2 + ?y0^2', 'next q ?q + 2 * ?x0^2 + ?y0^2');
  const h2 = {...h, wires: readProgram(changed, 'k')};
  const r2 = vrc.ask({handle: h2, query: a.query});
  assert.equal(r2.stats.backend, 'full');
  assert.equal(r2.stats.cacheStatus, 'STALE');
});

// ----------------------------------------------------------------------------------------------------- budgets, refusals
test('budgets: a node ceiling and a wall clock are budget_exhausted with their reason, never a no_plan', () => {
  const c = loadCase('71-vrc-product-world-small');
  const nodes = run(c.knowledge, c.query, {maxNodes: 20}, {learning: 'off'});
  assert.equal(nodes.status, 'budget_exhausted');
  assert.equal(nodes.reason, 'nodes');
  const wall = run(c.knowledge, c.query, {timeoutMs: 0}, {learning: 'off'});
  assert.equal(wall.status, 'budget_exhausted');
  assert.equal(wall.reason, 'wall');
});

test('outside the fragment is not_expressible, never weakened', () => {
  const st = '@state predicate\n  args subject:entity topic:entity object:rational\n@s fact\n  holds state d v 0\n';
  const q = '@q query\n  mode plan\n  observe d ?v at_least 1\n  horizon 3\n';
  assert.throws(() => run(st + '@a action\n  params ?x\n  requires p ?x\n  next v ?v + 1\n', q), NotExpressibleError, 'parameters');
  assert.throws(() => run(st + '@a action\n  cost 5\n  next v ?v + 1\n', q), NotExpressibleError, 'a non-unit cost is rejected, not ignored');
  assert.throws(() => run(st + '@r rule\n  when p ?x\n  then q ?x\n@a action\n  next v ?v + 1\n', q), NotExpressibleError, 'rules');
  assert.throws(() => run(st + '@a action\n  next v ?v + 1\n', '@q query\n  mode select\n  where p ?x\n  select ?x\n'), NotExpressibleError, 'only plan queries');
  assert.throws(() => run('@x fact\n  holds p a\n', q), NotExpressibleError, 'no numeric action at all');
});
