import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ask as aspAsk, capabilities, available} from '../../reasoning/strategies/asp-clingo/index.mjs';
import {ask as oracleAsk, NotExpressibleError, ProgramError} from '../../reasoning/strategies/js-reference/index.mjs';
import {compare} from '../../eval/smoke-reasoning/lib/compare.mjs';

const ready = (await available()).ok;
const opts = {conditional: false, used: false};
const run = (knowledge, query, budget = {}, options = opts) => aspAsk({theory: {knowledge}, query}, budget, options);
const rowsOf = r => r.rows.map(x => JSON.stringify(x)).sort();
const preds = names => names.map(n => `@${n} predicate\n  args none\n  closed true\n`).join('');
const t = (name, fn) => test(name, {skip: !ready && 'clingo is not available'}, fn);

t('polarity is two relations: a fact and its negation stay a model and the status is both', () => {
  const k = '@f1 fact\n  holds p a\n@f2 fact\n  holds not p a\n@r rule\n  when p ?x\n  then q ?x\n';
  assert.equal(run(k, '@q query\n  mode exists\n  where p a\n').status, 'both');
  assert.equal(run(k, '@q query\n  mode exists\n  where q a\n').status, 'supported');
  assert.equal(run(k, '@q query\n  mode exists\n  where p b\n').status, 'unknown');
});

t('absent is negation as failure over a closed predicate; the program must be stratified (no unstable model)', () => {
  const k = '@blocked predicate\n  args subject:entity\n  closed true\n@f1 fact\n  holds node a\n@f2 fact\n  holds node b\n@f3 fact\n  holds blocked b\n@r rule\n  when node ?x\n  when absent blocked ?x\n  then free ?x\n';
  assert.deepEqual(rowsOf(run(k, '@q query\n  where free ?x\n  select ?x\n')), ['{"x":"a"}']);
  const bad = '@p predicate\n  args none\n  closed true\n@r rule\n  when node ?x\n  when absent p\n  then p\n';
  assert.throws(() => run(bad, '@q query\n  mode exists\n  where p\n'), ProgramError);
});

t('aggregates have set semantics over ALL variables of the over group', () => {
  const k = '@salary predicate\n  args subject:entity topic:entity object:integer\n  closed true\n'
    + '@f1 fact\n  holds salary ann dev 100\n@f2 fact\n  holds salary bob dev 100\n@f3 fact\n  holds salary bob dev 100\n'
    + '@a aggregate\n  over salary ?p ?d ?s\n  group ?d\n  count ?p as ?n\n  yields n_of ?d ?n\n'
    + '@b aggregate\n  over salary ?p ?d ?s\n  group ?d\n  sum ?s as ?t\n  yields t_of ?d ?t\n';
  // two people with the same salary count twice; the repeated fact is the same row
  assert.deepEqual(rowsOf(run(k, '@q query\n  where n_of ?d ?n\n  select ?d ?n\n')), ['{"d":"dev","n":2}']);
  assert.deepEqual(rowsOf(run(k, '@q query\n  where t_of ?d ?t\n  select ?d ?t\n')), ['{"d":"dev","t":200}']);
});

t('compute: division truncates toward zero and a zero divisor drops the instance (the comparison is false)', () => {
  const k = '@f1 fact\n  holds num a -7\n@f2 fact\n  holds num b 7\n@f3 fact\n  holds num c 0\n'
    + '@r rule\n  when num ?x ?v\n  when compute ?h ?v whole_divided_by 2\n  then half ?x ?h\n'
    + '@z rule\n  when num ?x ?v\n  when compute ?h 10 whole_divided_by ?v\n  then tenth ?x ?h\n';
  assert.deepEqual(rowsOf(run(k, '@q query\n  where half ?x ?h\n  select ?x ?h\n')), ['{"x":"a","h":-3}', '{"x":"b","h":3}', '{"x":"c","h":0}']);
  assert.deepEqual(rowsOf(run(k, '@q query\n  where tenth ?x ?h\n  select ?x ?h\n')), ['{"x":"a","h":-1}', '{"x":"b","h":1}']);
});

t('defaults agree with the desugared semantics: an exception blocks, equal defaults give both', () => {
  const k = '@penguin predicate\n  args subject:entity\n  closed true\n@f1 fact\n  holds bird tweety\n@f2 fact\n  holds bird pingu\n@f3 fact\n  holds penguin pingu\n'
    + '@d default\n  when bird ?x\n  then flies ?x\n  except penguin ?x\n';
  assert.deepEqual(rowsOf(run(k, '@q query\n  where flies ?x\n  select ?x\n')), ['{"x":"tweety"}']);
  const nixon = '@f1 fact\n  holds quaker nixon\n@f2 fact\n  holds republican nixon\n@d1 default\n  when quaker ?x\n  then pacifist ?x\n@d2 default\n  when republican ?x\n  then not pacifist ?x\n';
  assert.equal(run(nixon, '@q query\n  mode exists\n  where pacifist nixon\n').status, 'both');
});

t('abduction returns every inclusion-minimal explanation, not only the cheapest', () => {
  const k = '@r1 rule\n  when a ?x\n  then goal ?x\n@r2 rule\n  when b ?x\n  then goal ?x\n@r3 rule\n  when c ?x\n  when d ?x\n  then goal ?x\n'
    + ['a', 'b', 'c', 'd', 'e'].map(p => `@h_${p} hypothesis\n  holds ${p} t\n  cost 1\n`).join('');
  const r = run(k, '@q query\n  mode abduce\n  where goal t\n');
  assert.equal(r.status, 'hypotheses');
  assert.deepEqual(r.hypotheses.map(h => h.join('+')).sort(), ['a t', 'b t', 'c t+d t']);
  // already true without any hypothesis: the empty explanation, and nothing else
  const k0 = k + '@f fact\n  holds a t\n';
  assert.deepEqual(run(k0, '@q query\n  mode abduce\n  where goal t\n').hypotheses, [[]]);
});

t('why_not returns the minimum-cardinality sets of missing base atoms', () => {
  const k = '@f1 fact\n  holds parent ann bob\n@r rule\n  when parent ?x ?y\n  when parent ?y ?z\n  then grandparent ?x ?z\n';
  const r = run(k, '@q query\n  mode why_not\n  where grandparent ann cy\n');
  assert.equal(r.status, 'unknown');
  assert.deepEqual(r.missing, [['parent bob cy']]);
});

t('the constraint wire: ties are broken lexicographically like the oracle, unbounded variables are budget_exhausted', () => {
  const c = '@cheapest constraint\n  var ?a int 0 6\n  var ?b int 0 6\n  var ?c int 0 6\n  require 3 times ?a plus 4 times ?b plus 6 times ?c at_least 18\n  require ?a plus ?b plus ?c at_most 5\n  objective 2 times ?a plus 3 times ?b plus 5 times ?c\n  direction min\n  task optimize\n  select ?a ?b ?c\n';
  const r = run('', c);
  assert.equal(r.status, 'optimal');
  assert.equal(r.objective, 13);
  assert.deepEqual(r.witness, {a: 2, b: 3, c: 0});
  const open = run('', '@cheapest constraint\n  var ?x int\n  require ?x above 1\n  task possible\n');
  assert.equal(open.status, 'budget_exhausted');
  assert.equal(open.reason, 'numeric_range');
  const div = run('', '@cheapest constraint\n  var ?x int 1 10\n  var ?y int 0 3\n  require ?x divided_by ?y at_least 5\n  task possible\n  select ?x ?y\n');
  assert.deepEqual(div.witness, {x: 5, y: 1}); // y = 0 is undefined, so the comparison is false there
});

t('planning: a cut by the horizon is budget_exhausted with reason horizon, never no_plan; an exhausted state space is no_plan', () => {
  const n = 12;
  const chain = Array.from({length: n + 1}, (_, i) => `@s${i} predicate\n  args none\n  closed true\n`).join('') + '@f fact\n  holds s0\n'
    + Array.from({length: n}, (_, i) => `@step${i} action\n  requires s${i}\n  adds s${i + 1}\n  removes s${i}\n`).join('');
  const q = `@q query\n  mode plan\n  where s${n}\n`;
  const deep = run(chain, q);
  assert.equal(deep.status, 'plan_found');
  assert.equal(deep.plan.steps, n);
  const tight = run(chain, q, {maxDepth: 8});
  assert.equal(tight.status, 'budget_exhausted');
  assert.equal(tight.reason, 'horizon');
  assert.equal(tight.complete, false);
  const none = run(preds(['a', 'b']) + '@f fact\n  holds a\n@mv action\n  requires a\n  adds a\n', '@q query\n  mode plan\n  where b\n');
  assert.equal(none.status, 'no_plan');
  assert.equal(none.complete, true);
});

const plan = (norms, extra = '') => run(preds(['x', 'y', 'done']) + extra + norms, '@q query\n  mode plan\n  where done\n');
const acts = '@do_a action\n  requires not x\n  adds x\n@do_b action\n  requires not y\n  adds y\n@do_c action\n  requires x\n  adds done\n';

t('norm qualifiers over a horizon: before and after change the plan or block it', () => {
  const before = plan('@n norm\n  forbid ~do_c\n  before ~do_b\n  severity hard\n', acts);
  assert.equal(before.status, 'plan_found');
  assert.equal(before.plan.names.at(-1), 'do_c');
  assert.ok(before.plan.names.indexOf('do_b') < before.plan.names.indexOf('do_c'));
  assert.equal(before.plan.cost, 3);
  const after = plan('@n norm\n  forbid ~do_c\n  after ~do_b\n  severity hard\n', acts);
  assert.deepEqual(after.plan.names, ['do_a', 'do_c']);
  const blocked = plan('@n norm\n  forbid ~do_c\n  severity hard\n', acts);
  assert.equal(blocked.status, 'blocked');
  assert.deepEqual(blocked.blocked_by, ['n']);
});

t('severity and binding: soft costs, advisory hard is relaxed and listed, strict hard blocks', () => {
  const k = preds(['go', 'target']) + '@f fact\n  holds go\n@hit action\n  requires go\n  adds target\n  cost 2\n';
  const q = '@q query\n  mode plan\n  where target\n';
  const soft = run(k + '@n norm\n  forbid ~hit\n  severity soft\n  cost 9\n', q);
  assert.equal(soft.status, 'plan_found');
  assert.deepEqual(soft.compliance, {hard: 'ok', soft_violations: [{id: 'n', cost: 9}], total_cost: 11});
  const adv = run(k + '@n norm\n  forbid ~hit\n  severity hard\n  binding advisory\n', q);
  assert.equal(adv.status, 'plan_found');
  assert.deepEqual(adv.relaxed, ['n']);
  assert.equal(adv.compliance.hard, 'relaxed');
  const strict = run(k + '@n norm\n  forbid ~hit\n  severity hard\n  binding strict\n', q);
  assert.equal(strict.status, 'blocked');
  assert.deepEqual(strict.blocked_by, ['n']);
});

t('a forbid and an oblige of equal strength on one action are a conflict that names both norms', () => {
  const k = preds(['go', 'target']) + '@f fact\n  holds go\n@hit action\n  requires go\n  adds target\n'
    + '@no norm\n  forbid ~hit\n  severity hard\n@must norm\n  oblige ~hit\n  when go\n  sometime\n  severity hard\n';
  const r = run(k, '@q query\n  mode plan\n  where target\n');
  assert.equal(r.status, 'blocked');
  assert.deepEqual(r.blocked_by, ['must', 'no']);
});

t('abduction over a plan: the minimal sets of norms to waive', () => {
  const k = preds(['go', 'target']) + '@f fact\n  holds go\n@hit action\n  requires go\n  adds target\n'
    + '@f1 norm\n  forbid ~hit\n  severity hard\n@f2 norm\n  forbid ~hit\n  severity hard\n@w1 hypothesis\n  waive $f1\n  cost 1\n@w2 hypothesis\n  waive $f2\n  cost 1\n';
  const r = run(k, '@q query\n  mode abduce\n  where target\n');
  assert.deepEqual(r.hypotheses, [['waive f1', 'waive f2']]);
});

t('a solver stop is budget_exhausted with reason wall, never an answer', () => {
  const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clingo-')), 'clingo');
  fs.writeFileSync(fake, '#!/bin/sh\nsleep 8\n');
  fs.chmodSync(fake, 0o755);
  const saved = process.env.CLINGO_BIN;
  process.env.CLINGO_BIN = fake;
  try {
    const r = run('@f fact\n  holds p a\n', '@q query\n  mode exists\n  where p a\n', {timeoutMs: 1000});
    assert.equal(r.status, 'budget_exhausted');
    assert.equal(r.reason, 'wall');
    assert.equal(r.complete, false);
  } finally {
    if (saved === undefined) delete process.env.CLINGO_BIN; else process.env.CLINGO_BIN = saved;
  }
});

t('what the strategy declares unsupported is not_expressible, never weakened', () => {
  for (const f of ['explain', 'method', 'budget', 'time_vars']) assert.ok(capabilities.notExpressible.includes(f), f);
  assert.ok(!capabilities.features.includes('explain'));
  assert.throws(() => run('@f fact\n  holds p a\n', '@q query\n  mode explain\n  where p a\n'), NotExpressibleError);
  const dates = '@f fact\n  holds start e1 "2026-01-01"\n@r rule\n  when start ?e ?d\n  when compare ?d above "2025-12-31"\n  then late ?e\n';
  assert.throws(() => run(dates, '@q query\n  where late ?e\n  select ?e\n'), NotExpressibleError);
});

t('gringo integers are 32 bits and wrap silently: an overflow is numeric_range, a wide constant or a possible overflow is not_expressible', () => {
  const double = '@f fact\n  holds big a 2000000000\n@r rule\n  when big ?x ?v\n  when compute ?w ?v times 2\n  then twice ?x ?w\n';
  const r = run(double, '@q query\n  where twice ?x ?w\n  select ?x ?w\n');
  assert.equal(r.status, 'budget_exhausted');
  assert.equal(r.reason, 'numeric_range');
  const small = double.replace('2000000000', '1000');
  assert.deepEqual(rowsOf(run(small, '@q query\n  where twice ?x ?w\n  select ?x ?w\n')), ['{"x":"a","w":2000}']);
  assert.throws(() => run('@f fact\n  holds big a 5000000000\n', '@q query\n  where big ?x ?v\n  select ?x\n'), NotExpressibleError);
  const sums = ['p1', 'p2', 'p3'].map((p, i) => `@f${i} fact\n  holds pay ${p} 1000000000\n`).join('') + '@s aggregate\n  over pay ?p ?v\n  group ?g\n  sum ?v as ?t\n  yields total ?t\n';
  assert.equal(run(sums.replace('group ?g', 'group'), '@q query\n  where total ?t\n  select ?t\n').status, 'budget_exhausted');
  assert.throws(() => run('', '@cheap constraint\n  var ?x int 0 100000\n  require ?x times ?x at_least 5\n  task possible\n'), NotExpressibleError);
});

t('a program that compares values and holds time texts as values is not lowered (the oracle compares them by instant)', () => {
  const k = '@f1 fact\n  holds start e1 "2026-01-01"\n@f2 fact\n  holds start e2 "2026-01-01T00:00:00Z"\n@r rule\n  when start ?a ?x\n  when start ?b ?y\n  when compare ?x equal ?y\n  when compare ?a not_equal ?b\n  then same_time ?a ?b\n';
  assert.throws(() => run(k, '@q query\n  where same_time ?a ?b\n  select ?a ?b\n'), NotExpressibleError);
});

t('used is one sufficient support set, verified by a replay', () => {
  const k = '@fa fact\n  holds p a\n@fb fact\n  holds q a\n@r1 rule\n  when p ?x\n  then s ?x\n@r2 rule\n  when q ?x\n  then s ?x\n';
  const r = run(k, '@q query\n  mode exists\n  where s a\n', {}, {conditional: false});
  assert.equal(r.status, 'supported');
  assert.ok(r.used_incomplete || r.used.length > 0);
  const chain = run('@fa fact\n  holds p a\n@r1 rule\n  when p ?x\n  then s ?x\n@r2 rule\n  when s ?x\n  then t ?x\n', '@q query\n  mode exists\n  where t a\n', {}, {conditional: false});
  assert.deepEqual(chain.used.map(u => u.id).sort(), ['fa', 'r1', 'r2']);
});

// the shadow gate on representative smoke cases: agree with js-oracle on status, rows and counts
const caseDir = new URL('../../eval/smoke-reasoning/cases/', import.meta.url).pathname;
const shadow = ['03-rules-chaining', '05a-classical-negation-conflict', '05b-naf-closed-world', '07b-aggregate-group-sum', '07c-aggregate-then-rule', '09a-default-exception', '09b-default-conflict-unresolved',
  '12d-temporal-derived-throughout', '13b-why-not', '14a-abduction', '17-integrity-violation', '62-arithmetic-logic-ferry-fares', '63-abduction-all-minimal-equal-cost', '64-unfounded-loop-stable-vs-supported'];
for (const dir of shadow) {
  t(`shadow: ${dir} agrees with the oracle`, () => {
    const read = f => (fs.existsSync(path.join(caseDir, dir, f)) ? fs.readFileSync(path.join(caseDir, dir, f), 'utf8') : '');
    const expected = JSON.parse(read('expected.json'));
    const mine = run(read('knowledge.sop'), read('query.sop'));
    const oracle = oracleAsk({theory: {knowledge: read('knowledge.sop')}, query: read('query.sop')});
    assert.deepEqual(compare(expected, mine).why, [], 'asp-clingo vs expected');
    assert.equal(mine.status, oracle.status);
    assert.deepEqual(mine.rows ?? null, oracle.rows ?? null);
    assert.equal(mine.count, oracle.count);
  });
}
