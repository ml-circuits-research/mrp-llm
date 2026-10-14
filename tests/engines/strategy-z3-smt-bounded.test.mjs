import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ask as z3Ask, capabilities, available} from '../../reasoning/strategies/z3-smt-bounded/index.mjs';
import {z3Command} from '../../reasoning/strategies/z3-smt-bounded/z3.mjs';
import {ask as aspAsk, available as aspAvailable} from '../../reasoning/strategies/asp-clingo/index.mjs';
import {ask as oracleAsk, NotExpressibleError} from '../../reasoning/strategies/js-reference/index.mjs';
import {compare} from '../../eval/smoke-reasoning/lib/compare.mjs';

const ready = (await available()).ok;
const aspReady = (await aspAvailable()).ok;
const opts = {conditional: false, used: false};
const run = (knowledge, query, budget = {}, options = opts) => z3Ask({theory: {knowledge}, query}, budget, options);
const rowsOf = r => r.rows.map(x => JSON.stringify(x)).sort();
const preds = names => names.map(n => `@${n} predicate\n  args none\n  closed true\n`).join('');
const t = (name, fn) => test(name, {skip: !ready && 'z3 is not available'}, fn);

t('two Booleans per ground atom: a fact and its negation stay satisfiable and the status is both', () => {
  const k = '@f1 fact\n  holds p a\n@f2 fact\n  holds not p a\n@r rule\n  when p ?x\n  then q ?x\n';
  assert.equal(run(k, '@q query\n  mode exists\n  where p a\n').status, 'both');
  assert.equal(run(k, '@q query\n  mode exists\n  where q a\n').status, 'supported');
  assert.equal(run(k, '@q query\n  mode exists\n  where p b\n').status, 'unknown');
});

t('recursion is declared unsupported: completion over a cycle admits models that are not the least model', () => {
  const cyc = '@f1 fact\n  holds edge a b\n@f2 fact\n  holds edge b a\n@r1 rule\n  when edge ?x ?y\n  then reach ?x ?y\n@r2 rule\n  when edge ?x ?m\n  when reach ?m ?y\n  then reach ?x ?y\n';
  assert.throws(() => run(cyc, '@q query\n  where reach a ?y\n  select ?y\n'), e => e instanceof NotExpressibleError && e.features.includes('recursion'));
  assert.ok(capabilities.notExpressible.includes('recursion'));
  assert.ok(!capabilities.features.includes('recursion'));
  // a recursive rule OUTSIDE the dependency slice of the question does not matter
  const r = run(cyc + '@f3 fact\n  holds bird tweety\n@r3 rule\n  when bird ?x\n  then flies ?x\n', '@q query\n  where flies ?x\n  select ?x\n');
  assert.deepEqual(rowsOf(r), ['{"x":"tweety"}']);
  // the unfounded-loop probe: the completion has a model that the least model does not have (probes/z3-64-unfounded-loop.smt2)
  const probe = path.join(new URL('../../eval/smoke-reasoning/probes/', import.meta.url).pathname, 'z3-64-unfounded-loop.smt2');
  const out = spawnSync(z3Command(), [probe], {encoding: 'utf8'}).stdout.trim().split(/\s+/);
  assert.deepEqual(out, ['sat', 'unsat']);
});

t('negation as failure over a closed predicate is completion; an aggregate is evaluated by Z3 at its stratum', () => {
  const k = '@salary predicate\n  args subject:entity topic:entity object:integer\n  closed true\n@blocked predicate\n  args subject:entity\n  closed true\n'
    + '@f1 fact\n  holds salary ann dev 100\n@f2 fact\n  holds salary bob dev 100\n@f3 fact\n  holds salary cy ops 70\n@f4 fact\n  holds blocked cy\n'
    + '@a aggregate\n  over salary ?p ?d ?s\n  group ?d\n  count ?p as ?n\n  yields n_of ?d ?n\n'
    + '@b aggregate\n  over salary ?p ?d ?s\n  group ?d\n  sum ?s as ?t\n  yields t_of ?d ?t\n'
    + '@c aggregate\n  over salary ?p ?d ?s\n  group ?d\n  max ?s as ?m\n  yields max_of ?d ?m\n'
    + '@r rule\n  when n_of ?d ?n\n  when t_of ?d ?t\n  when compare ?n at_least 2\n  when compute ?avg ?t whole_divided_by ?n\n  then avg_of ?d ?avg\n'
    + '@free rule\n  when salary ?p ?d ?s\n  when absent blocked ?p\n  then free ?p\n';
  assert.deepEqual(rowsOf(run(k, '@q query\n  where n_of ?d ?n\n  select ?d ?n\n')), ['{"d":"dev","n":2}', '{"d":"ops","n":1}']);
  assert.deepEqual(rowsOf(run(k, '@q query\n  where avg_of ?d ?v\n  select ?d ?v\n')), ['{"d":"dev","v":100}']);
  assert.deepEqual(rowsOf(run(k, '@q query\n  where max_of ?d ?v\n  select ?d ?v\n')), ['{"d":"dev","v":100}', '{"d":"ops","v":70}']);
  assert.deepEqual(rowsOf(run(k, '@q query\n  where free ?p\n  select ?p\n')), ['{"p":"ann"}', '{"p":"bob"}']);
});

t('compute: division truncates toward zero and a zero divisor drops the instance', () => {
  const k = '@f1 fact\n  holds num a -7\n@f2 fact\n  holds num b 7\n@f3 fact\n  holds num c 0\n'
    + '@r rule\n  when num ?x ?v\n  when compute ?h ?v whole_divided_by 2\n  then half ?x ?h\n'
    + '@z rule\n  when num ?x ?v\n  when compute ?h 10 whole_divided_by ?v\n  then tenth ?x ?h\n';
  assert.deepEqual(rowsOf(run(k, '@q query\n  where half ?x ?h\n  select ?x ?h\n')), ['{"x":"a","h":-3}', '{"x":"b","h":3}', '{"x":"c","h":0}']);
  assert.deepEqual(rowsOf(run(k, '@q query\n  where tenth ?x ?h\n  select ?x ?h\n')), ['{"x":"a","h":-1}', '{"x":"b","h":1}']);
});

t('the constraint wire: lexicographic ties, truncating division with a variable divisor, unbounded variables', () => {
  const c = '@cheapest constraint\n  var ?a int 0 6\n  var ?b int 0 6\n  var ?c int 0 6\n  require 3 times ?a plus 4 times ?b plus 6 times ?c at_least 18\n  require ?a plus ?b plus ?c at_most 5\n  objective 2 times ?a plus 3 times ?b plus 5 times ?c\n  direction min\n  task optimize\n  select ?a ?b ?c\n';
  const r = run('', c);
  assert.equal(r.status, 'optimal');
  assert.equal(r.objective, 13);
  assert.deepEqual(r.witness, {a: 2, b: 3, c: 0});
  const div = run('', '@cheapest constraint\n  var ?x int 1 10\n  var ?y int 0 3\n  require ?x divided_by ?y at_least 5\n  task possible\n  select ?x ?y\n');
  assert.deepEqual(div.witness, {x: 5, y: 1});
  const neg = run('', '@cheapest constraint\n  var ?x int -9 9\n  require ?x divided_by 2 equal -3\n  task possible\n  select ?x\n');
  assert.deepEqual(neg.witness, {x: -7}); // -7 / 2 truncates to -3 (not floor, -4)
  assert.equal(run('', '@cheapest constraint\n  var ?x int\n  require ?x above 1\n  task possible\n').reason, 'numeric_range');
  const proof = run('', '@cheapest constraint\n  var ?x int 0 10\n  var ?y int 0 10\n  require ?x plus ?y equal 10\n  claim ?x at_most 10\n  task prove\n  select ?x ?y\n');
  assert.equal(proof.status, 'entailed');
});

t('Z3 integers are unbounded but the packet carries safe integers: a larger value is numeric_range, not a rounded number', () => {
  const big = ['p1', 'p2', 'p3'].map((p, i) => `@f${i} fact\n  holds pay ${p} 4000000000000000\n`).join('') + '@s aggregate\n  over pay ?p ?v\n  group\n  sum ?v as ?t\n  yields total ?t\n';
  const r = run(big, '@q query\n  where total ?t\n  select ?t\n');
  assert.equal(r.status, 'budget_exhausted');
  assert.equal(r.reason, 'numeric_range');
  const ok = ['p1', 'p2', 'p3'].map((p, i) => `@f${i} fact\n  holds pay ${p} 1000000000\n`).join('') + '@s aggregate\n  over pay ?p ?v\n  group\n  sum ?v as ?t\n  yields total ?t\n';
  assert.deepEqual(rowsOf(run(ok, '@q query\n  where total ?t\n  select ?t\n')), ['{"t":3000000000}']); // beyond 32 bits, exact in Z3
});

t('abduction returns every inclusion-minimal explanation; why_not the minimum-cardinality missing atoms', () => {
  const k = '@r1 rule\n  when a ?x\n  then goal ?x\n@r2 rule\n  when b ?x\n  then goal ?x\n@r3 rule\n  when c ?x\n  when d ?x\n  then goal ?x\n'
    + ['a', 'b', 'c', 'd', 'e'].map(p => `@h_${p} hypothesis\n  holds ${p} t\n  cost 1\n`).join('');
  const r = run(k, '@q query\n  mode abduce\n  where goal t\n');
  assert.deepEqual(r.hypotheses.map(h => h.join('+')).sort(), ['a t', 'b t', 'c t+d t']);
  const kp = '@f1 fact\n  holds parent ann bob\n@r rule\n  when parent ?x ?y\n  when parent ?y ?z\n  then grandparent ?x ?z\n';
  const w = run(kp, '@q query\n  mode why_not\n  where grandparent ann cy\n');
  assert.deepEqual(w.missing, [['parent bob cy']]);
});

t('planning: horizon cut is budget_exhausted with reason horizon, an exhausted state space is no_plan, a small domain limit is reason domain', () => {
  const n = 12;
  const chain = Array.from({length: n + 1}, (_, i) => `@s${i} predicate\n  args none\n  closed true\n`).join('') + '@f fact\n  holds s0\n'
    + Array.from({length: n}, (_, i) => `@step${i} action\n  requires s${i}\n  adds s${i + 1}\n  removes s${i}\n`).join('');
  const q = `@q query\n  mode plan\n  where s${n}\n`;
  assert.equal(run(chain, q).status, 'plan_found');
  const tight = run(chain, q, {maxDepth: 8});
  assert.equal(tight.status, 'budget_exhausted');
  assert.equal(tight.reason, 'horizon');
  assert.equal(tight.complete, false);
  const none = run(preds(['a', 'b']) + '@f fact\n  holds a\n@mv action\n  requires a\n  adds a\n', '@q query\n  mode plan\n  where b\n');
  assert.equal(none.status, 'no_plan');
  assert.equal(none.complete, true);
  const domain = run(chain, q, {maxCandidates: 5});
  assert.equal(domain.status, 'budget_exhausted');
  assert.equal(domain.reason, 'domain');
});

const acts = '@do_a action\n  requires not x\n  adds x\n@do_b action\n  requires not y\n  adds y\n@do_c action\n  requires x\n  adds done\n';
const plan = (norms, extra = '', fn = run) => fn(preds(['x', 'y', 'done']) + extra + norms, '@q query\n  mode plan\n  where done\n');

t('norms over a horizon: qualifiers, severity and binding, and the conflict of equal strength', () => {
  const before = plan('@n norm\n  forbid ~do_c\n  before ~do_b\n  severity hard\n', acts);
  assert.equal(before.plan.cost, 3);
  assert.ok(before.plan.names.indexOf('do_b') < before.plan.names.indexOf('do_c'));
  assert.deepEqual(plan('@n norm\n  forbid ~do_c\n  after ~do_b\n  severity hard\n', acts).plan.names, ['do_a', 'do_c']);
  const blocked = plan('@n norm\n  forbid ~do_c\n  severity hard\n', acts);
  assert.equal(blocked.status, 'blocked');
  assert.deepEqual(blocked.blocked_by, ['n']);
  const k = preds(['go', 'target']) + '@f fact\n  holds go\n@hit action\n  requires go\n  adds target\n  cost 2\n';
  const q = '@q query\n  mode plan\n  where target\n';
  const soft = run(k + '@n norm\n  forbid ~hit\n  severity soft\n  cost 9\n', q);
  assert.deepEqual(soft.compliance, {hard: 'ok', soft_violations: [{id: 'n', cost: 9}], total_cost: 11});
  const adv = run(k + '@n norm\n  forbid ~hit\n  severity hard\n  binding advisory\n', q);
  assert.deepEqual(adv.relaxed, ['n']);
  assert.equal(adv.compliance.hard, 'relaxed');
  const conflict = run(k + '@no norm\n  forbid ~hit\n  severity hard\n@must norm\n  oblige ~hit\n  when go\n  sometime\n  severity hard\n', q);
  assert.equal(conflict.status, 'blocked');
  assert.deepEqual(conflict.blocked_by, ['must', 'no']);
  const waive = run(k + '@f1 norm\n  forbid ~hit\n  severity hard\n@f2 norm\n  forbid ~hit\n  severity hard\n@w1 hypothesis\n  waive $f1\n  cost 1\n@w2 hypothesis\n  waive $f2\n  cost 1\n', '@q query\n  mode abduce\n  where target\n');
  assert.deepEqual(waive.hypotheses, [['waive f1', 'waive f2']]);
});

t('a solver stop is budget_exhausted with reason wall, never an answer', () => {
  const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'z3-')), 'z3');
  fs.writeFileSync(fake, '#!/bin/sh\nsleep 8\n');
  fs.chmodSync(fake, 0o755);
  const saved = process.env.Z3_BIN;
  process.env.Z3_BIN = fake;
  try {
    const r = run('@f fact\n  holds p a\n@r rule\n  when p ?x\n  then q ?x\n', '@q query\n  mode exists\n  where q a\n', {timeoutMs: 1000});
    assert.equal(r.status, 'budget_exhausted');
    assert.equal(r.reason, 'wall');
    assert.equal(r.complete, false);
  } finally {
    if (saved === undefined) delete process.env.Z3_BIN; else process.env.Z3_BIN = saved;
  }
});

t('what the strategy declares unsupported is not_expressible, never weakened', () => {
  for (const f of ['recursion', 'explain', 'method', 'budget']) assert.ok(capabilities.notExpressible.includes(f), f);
  assert.throws(() => run('@f fact\n  holds p a\n', '@q query\n  mode explain\n  where p a\n'), NotExpressibleError);
  assert.throws(() => run('@f fact\n  holds p a\n@a aggregate\n  over p ?x\n  group ?x\n  collect ?x as ?l\n  yields l_of ?x ?l\n', '@q query\n  where l_of ?x ?l\n  select ?x\n'), NotExpressibleError);
});

// the two solver strategies are independent encodings of the same semantics: they must agree with each other on planning with norms
const scenarios = {
  before: [preds(['x', 'y', 'done']) + acts + '@n norm\n  forbid ~do_c\n  before ~do_b\n  severity hard\n', 'done'],
  afterBlocked: [preds(['x', 'done']) + '@do_a action\n  requires not x\n  adds x\n@do_b action\n  requires x\n  adds done\n@n norm\n  forbid ~do_b\n  after ~do_a\n  severity hard\n', 'done'],
  sometime: [preds(['hot', 'cooled', 'alerted', 'done']) + '@f fact\n  holds hot\n@cool action\n  requires hot\n  adds cooled\n@alert action\n  requires hot\n  adds alerted\n@finish action\n  requires cooled\n  adds done\n@n norm\n  oblige ~alert\n  when hot\n  sometime\n  severity soft\n  cost 7\n', 'done'],
  maintain: [preds(['safe', 'x', 'done']) + '@f fact\n  holds safe\n@drop action\n  requires safe\n  adds x\n  removes safe\n@goalstep action\n  requires x\n  adds done\n@n norm\n  oblige safe\n  when x\n  always\n  severity hard\n  binding strict\n', 'done'],
  stateForbid: [preds(['p', 'q', 'r', 'done']) + '@a1 action\n  requires not p\n  adds p\n@a2 action\n  requires p\n  adds q\n  removes p\n@a3 action\n  requires q\n  adds done\n@both rule\n  when p\n  when q\n  then r\n@n norm\n  forbid r\n  always\n  severity hard\n', 'done'],
  deadline: [preds(['go', 'urgent', 'target', 'ready']) + '@f fact\n  holds urgent\n@prep action\n  requires urgent\n  adds ready\n@hit action\n  requires ready\n  adds target\n@n norm\n  oblige ~hit\n  when urgent\n  within 1\n  severity hard\n  binding strict\n', 'target']
};
for (const [name, [k, goal]] of Object.entries(scenarios)) {
  test(`differential: z3-smt-bounded and asp-clingo agree on the norm scenario ${name}`, {skip: !(ready && aspReady) && 'a solver is not available'}, () => {
    const q = `@q query\n  mode plan\n  where ${goal}\n`;
    const a = aspAsk({theory: {knowledge: k}, query: q}, {}, opts), z = run(k, q);
    assert.equal(z.status, a.status);
    assert.equal(z.plan?.cost, a.plan?.cost);
    assert.deepEqual(z.plan?.names.slice().sort(), a.plan?.names.slice().sort());
    assert.deepEqual(z.blocked_by, a.blocked_by);
    assert.deepEqual(z.compliance, a.compliance);
    assert.equal(z.guarantee, a.guarantee);
  });
}

const caseDir = new URL('../../eval/smoke-reasoning/cases/', import.meta.url).pathname;
const shadow = ['03-rules-chaining', '05a-classical-negation-conflict', '05b-naf-closed-world', '06d-rule-arithmetic', '07b-aggregate-group-sum', '07c-aggregate-then-rule', '09a-default-exception', '09b-default-conflict-unresolved',
  '12d-temporal-derived-throughout', '13b-why-not', '14a-abduction', '17-integrity-violation', '60-optimise-cheapest-assignment', '62-arithmetic-logic-ferry-fares', '63-abduction-all-minimal-equal-cost'];
for (const dir of shadow) {
  t(`shadow: ${dir} agrees with the oracle`, () => {
    const read = f => (fs.existsSync(path.join(caseDir, dir, f)) ? fs.readFileSync(path.join(caseDir, dir, f), 'utf8') : '');
    const expected = JSON.parse(read('expected.json'));
    const mine = run(read('knowledge.sop'), read('query.sop'));
    const oracle = oracleAsk({theory: {knowledge: read('knowledge.sop')}, query: read('query.sop')});
    assert.deepEqual(compare(expected, mine).why, [], 'z3-smt-bounded vs expected');
    assert.equal(mine.status, oracle.status);
    assert.deepEqual(mine.rows ?? null, oracle.rows ?? null);
    assert.equal(mine.count, oracle.count);
  });
}
