import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {conformCore, judgeByLowering, NotExpressibleError} from '../../reasoning/strategies/conform/index.mjs';
import {lowerTrace} from '../../reasoning/strategies/conform/lower.mjs';
import {ask as oracleAsk, prepare as oraclePrepare} from '../../reasoning/strategies/js-reference/index.mjs';
import {readWires} from '../../reasoning/strategies/modes/theory.mjs';
import {buildContext} from '../../reasoning/strategies/modes/context.mjs';
import {judgeRun} from '../../reasoning/strategies/htn-strips-planner/conform-mode.mjs';
import {compare} from '../../eval/smoke-reasoning/lib/compare.mjs';

const cases = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../eval/smoke-reasoning/cases');
const readCase = (dir, file) => fs.readFileSync(path.join(cases, dir, file), 'utf8');
const CONFORM_CASES = ['37a-conform-trace-violation', '37b-conform-trace-compliant', '37c-conform-trace-asof-old', '37d-conform-method-deviation-strict', '45a-conform-asof-query', '45b-conform-versions-by-step-time', '46b-conform-advisory-violation-relaxed', '47c-conform-at-most-once'];

const ctxOf = (knowledge, asof = null) => buildContext({knowledge: readWires(knowledge), queryWires: readWires(`@q query\n  mode conform\n${asof ? '  asof ' + asof + '\n' : ''}`)});
const step = (action, ...args) => ({action, args, at: null});
const at = (action, date, ...args) => ({action, args, at: date});
/** A compact, comparable summary of a verdict. */
const sig = v => JSON.stringify({c: v.compliant, h: v.compliance.hard, viol: [...v.compliance.violated].sort(), dev: [...v.compliance.deviations].sort(), soft: v.compliance.soft_violations.map(x => x.id + ':' + x.cost).sort(), cost: v.compliance.total_cost, at: v.violations.map(x => `${x.instance}@${x.step}`).sort(), trig: [...v.triggered].sort()});

for (const dir of CONFORM_CASES) {
  test(`conform-core answers smoke case ${dir} through the lowering`, () => {
    const got = conformCore.ask({theory: {knowledge: readCase(dir, 'knowledge.sop')}, query: readCase(dir, 'query.sop')});
    const verdict = compare(JSON.parse(readCase(dir, 'expected.json')), got);
    assert.deepEqual(verdict.why, []);
    assert.equal(got.route.chosen, 'conform-core');
    assert.ok(got.notes.includes('lowered to core rules'));
  });
}

test('the lowered program is core: facts, rules and predicates, nothing else, and it runs on the oracle alone', () => {
  const ctx = ctxOf(readCase('37d-conform-method-deviation-strict', 'knowledge.sop'));
  const low = lowerTrace({ctx, steps: ctx.trace ?? [step('notify_oncall', 'r7'), step('soft_reset', 'r7'), step('extra_check', 'r7'), step('verify_link', 'r7')]});
  const types = new Set(readWires(low.text).map(w => w.type));
  assert.deepEqual([...types].sort(), ['fact', 'predicate', 'rule']);
  assert.match(low.text, /x_c_compliant/);
  // the oracle answers the compliance question on the text alone: this trace deviates from a strict method, so it is not compliant
  const handle = oraclePrepare({knowledge: low.text});
  assert.equal(oracleAsk({handle, query: '@q query\n  mode exists\n  where x_c_compliant\n'}).status, 'refuted');
});

test('non-conformance queries are delegated to the oracle unchanged', () => {
  const k = '@f1 fact\n  holds p a\n';
  const r = conformCore.ask({theory: {knowledge: k}, query: '@q query\n  mode exists\n  where p a\n'});
  assert.equal(r.status, 'supported');
  assert.equal(r.route.chosen, 'js-reference');
});

const HEAD = '@s predicate\n  args subject:entity\n@t predicate\n  args subject:entity\n@a action\n  params ?x\n  requires s ?x\n  adds t ?x\n  cost 2\n@f fact\n  holds s s1\n@g fact\n  holds s s2\n';

test('an absent binding is strict: a violated norm without binding makes the trace non_compliant, an advisory one does not', () => {
  const norm = extra => `@n norm\n  forbid ~a ?x\n  when s ?x\n${extra}`;
  const strict = judgeByLowering(ctxOf(HEAD + norm('')), [step('a', 's1')]);
  assert.equal(strict.compliant, false);
  assert.equal(strict.compliance.hard, 'violated');
  const advisory = judgeByLowering(ctxOf(HEAD + norm('  binding advisory\n')), [step('a', 's1')]);
  assert.equal(advisory.compliant, true);
  assert.equal(advisory.compliance.hard, 'relaxed');
  assert.deepEqual(advisory.compliance.relaxed, ['n']);
});

test('a soft norm costs, once per instance, and the trace stays compliant', () => {
  const k = HEAD + '@n norm\n  forbid ~a ?x\n  severity soft\n  cost 5\n';
  const v = judgeByLowering(ctxOf(k), [step('a', 's1'), step('a', 's1'), step('a', 's2')]);
  assert.equal(v.compliant, true);
  assert.deepEqual(v.compliance.soft_violations, [{id: 'n', cost: 5}, {id: 'n', cost: 5}]);
  assert.equal(v.compliance.total_cost, 6 + 10);
});

test('a permit overrides the prohibition only where its own when holds', () => {
  const k = HEAD + '@ok predicate\n  args subject:entity\n@h fact\n  holds ok s1\n@n norm\n  forbid ~a ?x\n  when s ?x\n@p norm\n  permit ~a ?x\n  when ok ?x\n  overrides $n\n';
  const v = judgeByLowering(ctxOf(k), [step('a', 's1'), step('a', 's2')]);
  assert.deepEqual(v.violations.map(x => x.instance), ['n s2']);
  assert.ok(v.used.some(u => u.id === 'p'), 'the permission that overrode is used');
});

test('timestamped trace: an obligation with within N counts days, an untimed one counts steps', () => {
  const k = HEAD + '@b predicate\n  args subject:entity\n@c action\n  params ?x\n  requires s ?x\n  adds b ?x\n  cost 1\n@o norm\n  oblige ~c ?x\n  when s ?x\n  within 3\n  severity soft\n  cost 9\n';
  const ctx = ctxOf(k);
  const timed = judgeByLowering(ctx, [at('a', '2026-03-01', 's1'), at('a', '2026-03-10', 's2'), at('c', '2026-03-11', 's1')]);
  assert.ok(timed.violations.some(x => x.instance === 'o s1'), 'the first c is 10 days late');
  const timedOk = judgeByLowering(ctx, [at('a', '2026-03-01', 's1'), at('c', '2026-03-03', 's1')]);
  assert.equal(timedOk.violations.filter(x => x.instance === 'o s1').length, 0);
  const steps = judgeByLowering(ctx, [step('a', 's1'), step('a', 's1'), step('a', 's1'), step('a', 's1'), step('c', 's1')]);
  assert.ok(steps.violations.some(x => x.instance === 'o s1' && x.step === 3), 'violated when the third step passes');
});

test('method deviation: any_order, if/else, until, pick and optional are checked; achieve is not_expressible', () => {
  const dom = '@u predicate\n  args subject:entity\n@w predicate\n  args subject:entity\n@act action\n  params ?x\n  requires u ?x\n  adds w ?x\n@x action\n  params ?x\n  requires u ?x\n@y action\n  params ?x\n  requires u ?x\n@z action\n  params ?x\n  requires u ?x\n@f fact\n  holds u e1\n@f2 fact\n  holds u e2\n';
  const m = body => `${dom}@m method\n  achieves w ?e\n  when u ?e\n${body}`;
  const ok = (k, steps) => judgeByLowering(ctxOf(k), steps).deviations.length === 0;
  const anyOrder = m('  step any_order\n    ~x ?e\n    ~y ?e\n  end\n  step ~z ?e\n');
  assert.ok(ok(anyOrder, [step('y', 'e1'), step('x', 'e1'), step('z', 'e1')]));
  assert.ok(!ok(anyOrder, [step('x', 'e1'), step('z', 'e1'), step('y', 'e1')]));
  const optional = m('  step optional ~x ?e\n  step ~z ?e\n');
  assert.ok(ok(optional, [step('z', 'e1')]) && ok(optional, [step('x', 'e1'), step('z', 'e1')]) && !ok(optional, [step('x', 'e1'), step('x', 'e1'), step('z', 'e1')]));
  const branch = m('  step if w ?e\n    ~x ?e\n  else\n    ~y ?e\n  end\n');
  assert.ok(ok(branch, [step('y', 'e1')]));
  assert.ok(!ok(branch, [step('x', 'e1')]));
  const loop = m('  step until w ?e max 2\n    ~x ?e\n  end\n');
  assert.ok(!ok(loop, [step('x', 'e1'), step('x', 'e1')]), 'the loop condition w never holds and the cap is 2 passes: x x then the cap, a failed run');
  const pick = m('  step pick ?v where u ?v\n  step ~x ?v\n');
  assert.ok(ok(pick, [step('x', 'e1')]));
  const achieve = m('  step ~x ?e\n  step achieve w ?e\n');
  assert.throws(() => judgeByLowering(ctxOf(achieve), [step('x', 'e1')]), NotExpressibleError);
  assert.throws(() => judgeRun(ctxOf(achieve), [step('x', 'e1')]), NotExpressibleError);
});

test('the lowering and the planner monitors agree on generated traces (shadow, fixed seed)', () => {
  const domains = [
    {dir: '37a-conform-trace-violation', actions: ['notify_oncall', 'soft_reset', 'hard_reset', 'verify_link'], consts: ['r7', 'r8'], dates: ['2026-01-10', '2026-02-01', '2026-10-05']},
    {dir: '45b-conform-versions-by-step-time', actions: ['deploy'], consts: ['s1', 's2'], dates: ['2026-03-01', '2026-07-01']},
    {dir: '47b-oblige-after-follow-up', actions: ['test', 'deploy', 'announce'], consts: ['s1', 's2'], dates: []},
    {dir: '44-standing-obligation-unscoped', actions: ['investigate', 'patch', 'log_incident'], consts: ['i1', 'i2'], dates: []}
  ];
  let seed = 20261001, compared = 0;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const pick = xs => xs[Math.floor(rnd() * xs.length)];
  for (const d of domains) {
    const knowledge = readWires(readCase(d.dir, 'knowledge.sop'));
    for (let i = 0; i < 30; i++) {
      const timed = d.dates.length > 0 && rnd() < 0.5;
      const steps = Array.from({length: Math.floor(rnd() * 6)}, () => ({action: pick(d.actions), args: [pick(d.consts)], at: timed ? pick(d.dates) : null}));
      if (timed) steps.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
      const ctx = buildContext({knowledge, queryWires: readWires('@q query\n  mode conform\n')});
      assert.equal(sig(judgeByLowering(ctx, steps)), sig(judgeRun(ctx, steps)), `${d.dir} ${JSON.stringify(steps)}`);
      compared++;
    }
  }
  assert.equal(compared, 120);
});

// ------------------------------------------------------------- the lowered program runs on any core strategy

for (const name of ['prolog-tabling', 'sql-sqlite', 'asp-clingo', 'datalog-souffle']) {
  test(`the lowered conformance program gives the oracle's verdict on ${name}`, async t => {
    const mod = await import(`../../reasoning/strategies/${name}/index.mjs`);
    if (!(await mod.available()).ok) return t.skip(`${name} is not available`);
    const strat = Object.values(mod).find(v => v && typeof v === 'object' && typeof v.ask === 'function');
    const shim = {prepare: ({knowledge}) => ({theory: {knowledge}}), ask: ({handle, query}) => strat.ask({theory: handle.theory, query}, {}, {conditional: false, used: false})};
    for (const dir of ['37a-conform-trace-violation', '37d-conform-method-deviation-strict', '45b-conform-versions-by-step-time']) {
      const ctx = buildContext({knowledge: readWires(readCase(dir, 'knowledge.sop')), queryWires: readWires(readCase(dir, 'query.sop'))});
      assert.equal(sig(judgeByLowering(ctx, ctx.trace, {oracle: shim})), sig(judgeByLowering(ctx, ctx.trace)), `${name} ${dir}`);
    }
  });
}

test('conform-core exports the strategy interface and check(plan) agrees with the planner', async () => {
  const mod = await import('../../reasoning/strategies/conform/index.mjs');
  assert.equal(mod.id, 'conform-core');
  assert.deepEqual(await mod.available(), {ok: true});
  const planner = await import('../../reasoning/strategies/htn-strips-planner/index.mjs');
  const knowledge = readCase('37a-conform-trace-violation', 'knowledge.sop');
  const plan = {steps: [{action: 'notify_oncall', args: ['r7']}, {action: 'hard_reset', args: ['r7']}, {action: 'verify_link', args: ['r7']}]};
  const a = mod.check(plan, {theory: {knowledge}}), b = planner.check(plan, {theory: {knowledge}});
  assert.equal(a.status, 'non_compliant');
  assert.deepEqual(a.compliance, b.compliance);
});
