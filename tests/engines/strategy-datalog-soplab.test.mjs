import test from 'node:test';
import assert from 'node:assert/strict';
import {Reasoner, abductParsed, all, any, atom, builtin, condition, loadSOP, none, not, parseSOP, planParsed, provider, reduction, ref, rule, unifyTerms, validateReasoner} from '../../eval/reference-engines/datalog-soplab/vendor/index.mjs';

/**
 * The tests of the vendored soplab engine that concern what the strategy uses (soplab-v0.4.0.zip, test/core, cnl, strategy, provider and validate;
 * the property and learning tests are not ported, their modules are not vendored), plus the finding of the smoke case 14a: the engine's own
 * abduction returns ONE cheapest explanation, never all minimal ones.
 */
// ---- from soplab test/core.test.mjs
test('naive and delta materialization agree on recursive closure', () => {
  const build = () => new Reasoner()
    .facts([atom('edge', 'a', 'b'), atom('edge', 'b', 'c'), atom('edge', 'c', 'd')])
    .addRules([
      rule('reach.base', atom('reach', '?x', '?y'), [atom('edge', '?x', '?y')]),
      rule('reach.rec', atom('reach', '?x', '?y'), [atom('edge', '?x', '?z'), atom('reach', '?z', '?y')]),
    ]);
  const a = build(); a.saturate({ strategy: 'naive' });
  const b = build(); b.saturate({ strategy: 'delta' });
  const qa = a.query(atom('reach', '?x', '?y')).map((x) => JSON.stringify(x.bindings)).sort();
  const qb = b.query(atom('reach', '?x', '?y')).map((x) => JSON.stringify(x.bindings)).sort();
  assert.deepEqual(qb, qa);
  assert.equal(b.ask(atom('reach', 'a', 'd')).status, 'supported');
});

test('four-valued evidence keeps contradiction local', () => {
  const r = new Reasoner();
  r.fact(atom('safe', 'x'), { kind: 'source', source: 'A' });
  r.fact(not('safe', 'x'), { kind: 'source', source: 'B' });
  assert.equal(r.ask(atom('safe', 'x')).status, 'conflicting');
  assert.equal(r.ask(atom('safe', 'y')).status, 'unknown');
});

test('condition wires compose AND, OR and local existential variables', () => {
  const r = new Reasoner();
  r.facts([
    atom('parent', 'Ana', 'Bob'), atom('parent', 'Bob', 'Cara'),
    atom('guardian', 'Dan', 'Eva'), atom('active', 'Ana'), atom('active', 'Dan'),
  ]);
  r.addWire(condition('grandparent', 'all', ['?x', '?y'], [
    atom('parent', '?x', '?middle'), atom('parent', '?middle', '?y'),
  ]));
  r.addWire(condition('carer', 'any', ['?x', '?y'], [
    atom('parent', '?x', '?y'), atom('guardian', '?x', '?y'),
  ]));
  r.addRule(rule('responsible', atom('responsible', '?x', '?y'), all(ref('carer', '?x', '?y'), atom('active', '?x'))));
  r.saturate();
  assert.equal(r.query(ref('grandparent', '?g', 'Cara'), { select: ['?g'] })[0].bindings['?g'], 'Ana');
  assert.equal(r.ask(atom('responsible', 'Ana', 'Bob')).status, 'supported');
  assert.equal(r.ask(atom('responsible', 'Dan', 'Eva')).status, 'supported');
});

test('reduce wire is a first-class relation', () => {
  const r = new Reasoner();
  r.facts([atom('parent', 'A', 'c1'), atom('parent', 'A', 'c2'), atom('parent', 'B', 'c3')]);
  r.addWire(reduction('childCount', {
    params: ['?parent', '?count'],
    source: atom('parent', '?parent', '?child'),
    groupBy: ['?parent'],
    aggregates: [{ op: 'count', field: '?child', as: '?count' }],
  }));
  const rows = r.query(ref('childCount', '?p', '?n'), { select: ['?p', '?n'] }).map((x) => x.bindings).sort((a, b) => a['?p'].localeCompare(b['?p']));
  assert.deepEqual(rows, [{ '?p': 'A', '?n': 2 }, { '?p': 'B', '?n': 1 }]);
  assert.equal(r.query(ref('childCount', 'A', '?n'), { select: ['?n'] })[0].bindings['?n'], 2);
});

test('builtin equality can bind a variable', () => {
  const r = new Reasoner();
  const rows = r.query(builtin('eq', '?x', 42), { select: ['?x'] });
  assert.equal(rows[0].bindings['?x'], 42);
});

// ---- from soplab test/cnl.test.mjs
test('CNL parser handles claims, all/any, rules, OR, NONE and goals', () => {
  const text = `
@p1 claim
VALUE parent Ana Bob
@p2 claim
VALUE guardian Dan Bob
@p3 claim
VALUE active Ana
@p4 claim
VALUE blocked Dan

@carer any
GIVES ?x ?y
MATCH parent ?x ?y
MATCH guardian ?x ?y

@r rule
WHEN $carer ?x ?y
AND active ?x
OR guardian ?x ?y
NONE blocked ?x
THEN responsible ?x ?y

@q goal
WHERE responsible ?who Bob
FIND ?who
`;
  const parsed = parseSOP(text);
  const r = loadSOP(new Reasoner(), parsed);
  r.saturate();
  const rows = r.query(parsed.goals[0].where, { select: parsed.goals[0].find });
  assert.deepEqual(rows.map((x) => x.bindings['?who']), ['Ana']);
});

test('CNL reduce wire aggregates without parentheses', () => {
  const text = `
@a claim
VALUE parent Ana Bob
@b claim
VALUE parent Ana Cara
@c claim
VALUE parent Dan Eva

@children all
GIVES ?parent ?child
MATCH parent ?parent ?child

@counts reduce
GIVES ?parent ?count
FROM $children ?parent ?child
GROUP ?parent
COUNT ?child AS ?count

@q goal
WHERE $counts ?p ?n
FIND ?p ?n
`;
  const parsed = parseSOP(text);
  const r = loadSOP(new Reasoner(), parsed);
  const rows = r.query(parsed.goals[0].where, { select: parsed.goals[0].find }).map((x) => x.bindings);
  assert.equal(rows.find((x) => x['?p'] === 'Ana')['?n'], 2);
});

test('CALL invokes a binding provider from CNL', () => {
  const parsed = parseSOP(`
@q goal
CALL range 1 3 ?n
FIND ?n
`);
  const r = loadSOP(new Reasoner(), parsed);
  const rows = r.query(parsed.goals[0].where, { select: parsed.goals[0].find });
  assert.deepEqual(rows.map((x) => x.bindings['?n']), [1, 2, 3]);
});

test('CNL transition blocks can be planned', () => {
  const parsed = parseSOP(`
@f1 claim
VALUE at robot A
@f2 claim
VALUE road A B
@f3 claim
VALUE road B C

@move transition
WHEN at ?who ?from
AND road ?from ?to
REMOVE at ?who ?from
ADD at ?who ?to
COST 1

@goal goal
WHERE at robot C
`);
  const res = planParsed(parsed);
  assert.equal(res.found, true);
  assert.equal(res.path.length, 2);
});

test('CNL assumptions can drive bounded abduction', () => {
  const parsed = parseSOP(`
@f claim
VALUE fever p

@r rule
WHEN fever ?p
AND cough ?p
THEN diagnosis ?p flu

@a1 assumption
VALUE rash p
COST 1
@a2 assumption
VALUE cough p
COST 1

@g goal
WHERE diagnosis p flu
`);
  const res = abductParsed(parsed);
  assert.equal(res.found, true);
  assert.equal(res.assumptions.length, 1);
  assert.equal(res.assumptions[0].atom.pred, 'cough');
});

test('CNL rejects ambiguous nested Boolean syntax inside named all/any wires', () => {
  assert.throws(() => parseSOP(`
@bad all
GIVES ?x
MATCH a ?x
OR b ?x
`), /compose an @\.\.\. any wire/i);
  assert.throws(() => parseSOP(`
@bad any
GIVES ?x
MATCH a ?x
AND b ?x
`), /compose an @\.\.\. all wire/i);
});

// ---- from soplab test/strategy.test.mjs
function buildWithNoise() {
  const r = new Reasoner();
  r.facts([atom('edge', 'a', 'b'), atom('edge', 'b', 'c')]);
  r.addRules([
    rule('reach.base', atom('reach', '?x', '?y'), [atom('edge', '?x', '?y')]),
    rule('reach.rec', atom('reach', '?x', '?y'), [atom('edge', '?x', '?z'), atom('reach', '?z', '?y')]),
  ]);
  for (let i = 0; i < 40; i++) {
    r.fact(atom('noise', `x${i}`, `y${i}`));
    r.addRule(rule(`noise.${i}`, atom(`derived${i}`, '?x'), [atom('noise', '?x', '?y')]));
  }
  return r;
}

test('sliced evaluation selects only backward-relevant rules', () => {
  const r = buildWithNoise();
  const sliced = r.evaluate(atom('reach', 'a', '?y'), { scope: 'sliced', strategy: 'delta', select: ['?y'] });
  const global = r.evaluate(atom('reach', 'a', '?y'), { scope: 'global', strategy: 'delta', select: ['?y'] });
  assert.deepEqual(sliced.rows.map((x) => x.bindings['?y']).sort(), global.rows.map((x) => x.bindings['?y']).sort());
  assert.deepEqual(sliced.selectedRules.sort(), ['reach.base', 'reach.rec']);
  assert.ok(sliced.metrics.ruleFirings < global.metrics.ruleFirings);
});

test('argument indexes reduce relation candidates for grounded positions', () => {
  const r = new Reasoner();
  for (let i = 0; i < 100; i++) r.fact(atom('row', `k${i}`, i));
  r.metrics.counters.clear();
  const rows = r.query(atom('row', 'k77', '?v'));
  assert.equal(rows[0].bindings['?v'], 77);
  assert.equal(r.metrics.get('candidateRows'), 1);
});

test('proofs can be exported as an explanation DAG and DOT', () => {
  const r = new Reasoner();
  r.facts([atom('parent', 'A', 'B'), atom('parent', 'B', 'C')]);
  r.addRule(rule('gp', atom('grandparent', '?x', '?y'), [atom('parent', '?x', '?z'), atom('parent', '?z', '?y')])).saturate();
  const e = r.explain(atom('grandparent', 'A', 'C'));
  assert.equal(e.proofs[0].ruleId, 'gp');
  const dot = r.explainDOT(atom('grandparent', 'A', 'C'));
  assert.match(dot, /digraph Proof/);
  assert.match(dot, /gp/);
});

test('NONE uses stratified negation so later positive derivations do not leave stale conclusions', () => {
  const r = new Reasoner();
  r.facts([atom('person', 'A'), atom('person', 'B'), atom('rawBlocked', 'A')]);
  // Deliberately add the negative rule first; stratification must still evaluate blocked before eligible.
  r.addRule(rule('eligible', atom('eligible', '?x'), all(atom('person', '?x'), none(atom('blocked', '?x')))));
  r.addRule(rule('blocked', atom('blocked', '?x'), [atom('rawBlocked', '?x')]));
  r.saturate({ strategy: 'delta' });
  assert.equal(r.ask(atom('eligible', 'A')).status, 'unknown');
  assert.equal(r.ask(atom('eligible', 'B')).status, 'supported');
});

test('negative recursive cycles are rejected as non-stratifiable', () => {
  const r = new Reasoner();
  r.addRule(rule('p', atom('p', '?x'), none(atom('q', '?x'))));
  r.addRule(rule('q', atom('q', '?x'), [atom('p', '?x')]));
  assert.throws(() => r.saturate(), /not stratifiable/i);
});

test('materialization strategies are pluggable', async () => {
  const { materializeNaive } = await import('../../eval/reference-engines/datalog-soplab/vendor/index.mjs');
  let calls = 0;
  const r = new Reasoner();
  r.fact(atom('edge', 'a', 'b'));
  r.addRule(rule('reach', atom('reach', '?x', '?y'), [atom('edge', '?x', '?y')]));
  r.registerMaterializer('instrumented', (reasoner, options) => {
    calls++;
    return materializeNaive(reasoner, options);
  });
  const out = r.evaluate(atom('reach', 'a', 'b'), { strategy: 'instrumented', scope: 'sliced' });
  assert.equal(out.rows.length, 1);
  assert.ok(calls >= 1);
});

// ---- from soplab test/provider.test.mjs
test('custom providers can produce bindings without kernel changes', () => {
  const r = new Reasoner();
  r.registerProvider('double', function* (args, bindings) {
    const input = args[0];
    const output = args[1];
    for (const n of [1, 2, 3]) {
      let b = unifyTerms(input, n, bindings);
      if (!b) continue;
      b = unifyTerms(output, n * 2, b);
      if (b) yield { bindings: b };
    }
  });
  const rows = r.query(provider('double', '?x', '?y'), { select: ['?x', '?y'] });
  assert.deepEqual(rows.map((x) => x.bindings), [
    { '?x': 1, '?y': 2 }, { '?x': 2, '?y': 4 }, { '?x': 3, '?y': 6 },
  ]);
});

test('new wire types can be registered without modifying the evaluator', () => {
  const r = new Reasoner();
  r.facts([{ kind: 'atom', pred: 'person', args: ['Ana'], sign: 1 }, { kind: 'atom', pred: 'person', args: ['Bob'], sign: 1 }]);
  r.registerWireType('alias', function* ({ def, args, seed, evidence, solve }) {
    const target = { kind: 'atom', pred: def.predicate, args, sign: 1 };
    yield* solve(target, seed, evidence);
  });
  r.addWire({ kind: 'wire', wireType: 'alias', id: 'people', params: ['?x'], predicate: 'person' });
  const rows = r.query(ref('people', '?x'), { select: ['?x'] });
  assert.deepEqual(rows.map((x) => x.bindings['?x']).sort(), ['Ana', 'Bob']);
});

// ---- from soplab test/validate.test.mjs
test('program validator detects unsafe rule heads', () => {
  const r = new Reasoner();
  r.addRule(rule('unsafe', atom('p', '?x', '?y'), [atom('q', '?x')]));
  const v = validateReasoner(r);
  assert.equal(v.ok, false);
  assert.equal(v.errors[0].code, 'UNSAFE_RULE_HEAD');
});

// ---- the strategy on top of the vendored engine

import {datalogSoplab, capabilities, NotExpressibleError} from '../../eval/reference-engines/datalog-soplab/index.mjs';

const ask = (knowledge, query, budget = {}) => datalogSoplab.ask({theory: {knowledge}, query}, budget, {conditional: false});
const rowsOf = r => r.rows.map(x => JSON.stringify(x)).sort();

const ABDUCTION = `@wet predicate
  args subject:entity
@r_rain rule
  when rained ?x
  then wet ?x
@r_sprinkler rule
  when sprinkler_on ?x
  then wet ?x
@h1 hypothesis
  holds rained grass
  cost 1
@h2 hypothesis
  holds sprinkler_on grass
  cost 1
`;

test('finding of the smoke case 14a: the vendored abduct() returns one cheapest explanation, the strategy returns all minimal ones', () => {
  const parsed = parseSOP('@r1 rule\nWHEN rained ?x\nTHEN wet ?x\n@r2 rule\nWHEN sprinkler_on ?x\nTHEN wet ?x\n@h1 assumption\nVALUE rained grass\nCOST 1\n@h2 assumption\nVALUE sprinkler_on grass\nCOST 1\n@goal goal\nWHERE wet grass\n');
  const native = abductParsed(parsed);
  assert.equal(native.found, true);
  assert.equal(native.assumptions.length, 1, 'the engine stops at the first cheapest explanation');
  assert.equal(capabilities.nativeAbduce, 'cheapest_only');
  assert.equal(capabilities.abduce, 'all_minimal');
  const out = ask(ABDUCTION, '@q query\n  mode abduce\n  where wet grass\n');
  assert.equal(out.status, 'hypotheses');
  assert.deepEqual(out.hypotheses.map(h => h.join(' ')).sort(), ['rained grass', 'sprinkler_on grass']);
});

test('all-minimal abduction skips supersets and keeps the cost order', () => {
  const k = `${ABDUCTION}@h3 hypothesis
  holds rained grass
  holds sprinkler_on grass
  cost 5
`;
  const out = ask(k, '@q query\n  mode abduce\n  where wet grass\n');
  assert.equal(out.hypotheses.length, 3, 'a hypothesis wire holding both atoms is its own, costlier explanation');
  const two = ask(k, '@q query\n  mode abduce\n  where wet grass\n  limit 1\n');
  assert.equal(two.hypotheses.length, 1);
  assert.equal(two.complete, false, 'a limited list says it is partial');
});

test('the planner finds the cheapest plan and no_plan only when the state space is exhausted', () => {
  const world = `@move action
  params ?r ?f ?t
  requires at ?r ?f
  requires road ?f ?t
  adds at ?r ?t
  removes at ?r ?f
  cost 1
@s1 fact
  holds at robot a
@s2 fact
  holds road a b
@s3 fact
  holds road b c
`;
  const found = ask(world, '@q query\n  mode plan\n  where at robot c\n');
  assert.equal(found.status, 'plan_found');
  assert.equal(found.plan.cost, 2);
  assert.deepEqual(found.plan.names, ['move', 'move']);
  assert.equal(ask(world, '@q query\n  mode plan\n  where at robot z\n').status, 'no_plan');
  const cut = ask(world, '@q query\n  mode plan\n  where at robot z\n', {maxNodes: 1});
  assert.equal(cut.status, 'budget_exhausted', 'a search cut by the node ceiling is not a negative answer');
  assert.equal(cut.reason, 'nodes');
});

test('a closure cut by maxRounds is partial and sound, never a negative answer', () => {
  const chain = Array.from({length: 12}, (_, i) => `@e${i} fact\n  holds edge n${i} n${i + 1}\n`).join('') + '@r1 rule\n  when edge ?a ?b\n  then reach ?a ?b\n@r2 rule\n  when reach ?a ?b\n  when edge ?b ?c\n  then reach ?a ?c\n';
  const full = ask(chain, '@q query\n  where reach n0 ?y\n  select ?y\n');
  assert.equal(full.rows.length, 12);
  const cut = ask(chain, '@q query\n  where reach n0 ?y\n  select ?y\n', {maxRounds: 3});
  assert.equal(cut.complete, false);
  assert.equal(cut.status, 'supported');
  assert.ok(cut.rows.length >= 1 && cut.rows.length < 12 && cut.rows.every(r => full.rows.some(f => f.y === r.y)));
  const none = ask(chain, '@q query\n  where reach n0 n12\n  mode exists\n', {maxRounds: 2});
  assert.equal(none.status, 'budget_exhausted', 'not reaching n12 within two rounds is not "unknown"');
});

test('what soplab does not lower is not_expressible: compute, ungrouped aggregate, time, why_not', () => {
  const arithmetic = '@r rule\n  when n ?x\n  when compute ?y ?x times 2\n  then double ?x ?y\n@f1 fact\n  holds n 2\n';
  assert.throws(() => ask(arithmetic, '@q query\n  where double ?x ?y\n  select ?x ?y\n'), NotExpressibleError);
  const ungrouped = '@f1 fact\n  holds amount a 3\n@agg aggregate\n  over amount ?e ?v\n  sum ?v as ?t\n  yields total ?t\n';
  assert.throws(() => ask(ungrouped, '@q query\n  where total ?t\n  select ?t\n'), NotExpressibleError);
  assert.throws(() => ask('@f1 fact\n  holds p a\n', '@q query\n  at 2026-01-01\n  where p ?x\n  select ?x\n'), NotExpressibleError);
  assert.throws(() => ask('@f1 fact\n  holds p a\n', '@q query\n  mode why_not\n  where p b\n'), NotExpressibleError);
});

test('grouped aggregates count a group only when it has rows, as the oracle does', () => {
  const k = '@f1 fact\n  holds amount a x 3\n@f2 fact\n  holds amount b x 3\n@agg aggregate\n  over amount ?e ?g ?v\n  group ?g\n  sum ?v as ?t\n  yields total ?g ?t\n';
  const out = ask(k, '@q query\n  where total ?g ?t\n  select ?g ?t\n');
  assert.deepEqual(rowsOf(out), ['{"g":"x","t":6}']);
});
