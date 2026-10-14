import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {htnStripsPlanner, ask, check, capabilities, NotExpressibleError, ProgramError} from '../../reasoning/strategies/htn-strips-planner/index.mjs';
import {readWires} from '../../reasoning/strategies/modes/theory.mjs';
import {buildContext, buildGoal, worldOf} from '../../reasoning/strategies/modes/context.mjs';
import {judgeRun} from '../../reasoning/strategies/htn-strips-planner/conform-mode.mjs';
import {ask as oracleAsk} from '../../reasoning/strategies/js-reference/index.mjs';
import {compare} from '../../eval/smoke-reasoning/lib/compare.mjs';

const cases = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../eval/smoke-reasoning/cases');
const readCase = (dir, file) => fs.readFileSync(path.join(cases, dir, file), 'utf8');
const run = (knowledge, query, budget = {}) => ask({theory: {knowledge}, query}, budget);
const PLAN = goal => `@q query\n  mode plan\n  where ${goal}\n`;

// ---------------------------------------------------------------------------------------------------- the smoke family

const FAMILY = fs.readdirSync(cases).filter(d => /^(11[abc]|3[0-9][abcd]?|4[0-9][abcd]?)-/.test(d) && !/^35[cd]/.test(d)).sort();

for (const dir of FAMILY) {
  test(`smoke case ${dir} passes on the planner`, () => {
    const expected = JSON.parse(readCase(dir, 'expected.json'));
    const got = run(readCase(dir, 'knowledge.sop'), readCase(dir, 'query.sop'));
    assert.deepEqual(compare(expected, got).why, []);
  });
}

test('the family covers 11a-c, 30a-39b and the new cases 40-49', () => {
  for (const id of ['11a', '11b', '11c', '30a', '30b', '30c', '30d', '31a', '31b', '32', '33', '34', '35a', '35b', '36', '37a', '37b', '37c', '37d', '38', '39a', '39b', '40a', '41a', '42b', '43a', '44', '45a', '46a', '47a', '48', '49a']) {
    assert.ok(FAMILY.some(d => d.startsWith(id + '-')), id);
  }
});

// ------------------------------------------------------------------------------------------------------ capabilities

test('capabilities declare the modes-of-work features and never a relational one', () => {
  for (const f of ['plan', 'method', 'htn_choice', 'on_failure', 'norms_hard', 'norms_soft', 'temporal_norms', 'procedures', 'procedure_render', 'amendment', 'check_plan', 'blocked_info', 'abduce_waive', 'binding_advisory', 'norm_conflict', 'conform_asof', 'conform_deviation']) assert.ok(capabilities.features.includes(f), f);
  assert.ok(!capabilities.features.includes('select'));
  assert.equal(capabilities.guarantee, 'bounded');
});

test('relational modes are not_expressible, never answered partially', () => {
  const k = '@f fact\n  holds p a\n';
  for (const q of ['@q query\n  mode exists\n  where p a\n', '@q query\n  mode select\n  where p ?x\n  select ?x\n', '@q query\n  mode why_not\n  where p b\n', '@q query\n  mode abduce\n  where p b\n']) {
    assert.throws(() => run(k, q), NotExpressibleError, q);
  }
});

// ------------------------------------------------------------------------------------------ norms: severity and binding

const ROUTES = '@g predicate\n  args none\n@cheap action\n  cost 1\n  adds g\n@dear action\n  cost 4\n  adds g\n';

test('an absent binding is strict: a hard norm prunes the cheap route and nothing is relaxed', () => {
  const r = run(ROUTES + '@n norm\n  forbid ~cheap\n  severity hard\n', PLAN('g'));
  assert.deepEqual(r.plan.names, ['dear']);
  assert.equal(r.compliance.hard, 'ok');
  assert.equal(r.relaxed, undefined);
});

test('with every route forbidden, a strict norm blocks and an advisory one is relaxed and listed', () => {
  const only = '@g predicate\n  args none\n@cheap action\n  cost 1\n  adds g\n';
  const blocked = run(only + '@n norm\n  forbid ~cheap\n  message "no cheap"\n', PLAN('g'));
  assert.equal(blocked.status, 'blocked');
  assert.deepEqual(blocked.blocked_by, ['n']);
  assert.equal(blocked.blocked.requirement, 'no cheap');
  const relaxed = run(only + '@n norm\n  forbid ~cheap\n  binding advisory\n', PLAN('g'));
  assert.equal(relaxed.status, 'plan_found');
  assert.deepEqual(relaxed.relaxed, ['n']);
  assert.equal(relaxed.compliance.hard, 'relaxed');
  // a policy may only tighten: policy binding strict makes the advisory norm strict
  const tightened = run(only + '@n norm\n  forbid ~cheap\n  binding advisory\n@p policy\n  binding strict\n', '@q query\n  mode plan\n  where g\n  policy $p\n');
  assert.equal(tightened.status, 'blocked');
});

test('a soft norm trades cost: the plan pays the violation when that is cheaper, and the violation is reported', () => {
  const cheapPays = run(ROUTES + '@n norm\n  forbid ~cheap\n  severity soft\n  cost 2\n', PLAN('g'));
  assert.deepEqual(cheapPays.plan.names, ['cheap']);
  assert.deepEqual(cheapPays.compliance.soft_violations, [{id: 'n', cost: 2}]);
  assert.equal(cheapPays.compliance.total_cost, 3);
  const dearIsCheaper = run(ROUTES + '@n norm\n  forbid ~cheap\n  severity soft\n  cost 9\n', PLAN('g'));
  assert.deepEqual(dearIsCheaper.plan.names, ['dear']);
  assert.deepEqual(dearIsCheaper.compliance.soft_violations, []);
});

test('equal-strength forbid and oblige of one step block both; a higher priority resolves it; overrides resolve it', () => {
  const k = '@p predicate\n  args none\n@halted predicate\n  args none\n@f fact\n  holds p\n@stop action\n  requires p\n  adds halted\n  cost 1\n';
  const forbid = prio => `@keep norm\n  forbid ~stop\n  when p\n${prio}`;
  const oblige = prio => `@must norm\n  oblige ~stop\n  when p\n${prio}`;
  const tie = run(k + forbid('') + oblige(''), PLAN('halted'));
  assert.equal(tie.status, 'blocked');
  assert.deepEqual([...tie.blocked_by].sort(), ['keep', 'must']);
  assert.equal(run(k + forbid('  priority 1\n') + oblige('  priority 2\n'), PLAN('halted')).status, 'plan_found');
  assert.equal(run(k + forbid('') + oblige('  overrides $keep\n'), PLAN('halted')).status, 'plan_found');
  // only a forbid of an action can be overridden: a forbid that outranks an obligation is not expressible, never silently dropped
  assert.throws(() => run(k + forbid('  priority 2\n') + oblige('  priority 1\n'), PLAN('halted')), NotExpressibleError);
  assert.throws(() => run(k + forbid('  overrides $must\n') + oblige(''), PLAN('halted')), NotExpressibleError);
});

// -------------------------------------------------------------------------------------------------- temporal qualifiers

const SVC = '@svc predicate\n  args subject:entity\n@done predicate\n  args subject:entity\n@a_done predicate\n  args subject:entity\n@b_done predicate\n  args subject:entity\n@f fact\n  holds svc s1\n@f2 fact\n  holds svc s2\n'
  + '@a action\n  params ?s\n  requires svc ?s\n  adds a_done ?s\n  cost 1\n@b action\n  params ?s\n  requires svc ?s\n  adds b_done ?s\n  cost 1\n@fin action\n  params ?s\n  requires svc ?s\n  adds done ?s\n  cost 1\n';

test('forbid before and after ~b, at_most_once and the deadline of within N', () => {
  const before = run(SVC + '@n norm\n  forbid ~fin ?s\n  before ~a\n', PLAN('done s1'));
  assert.deepEqual(before.plan.names, ['a', 'fin']);
  const after = run(SVC + '@n norm\n  forbid ~fin ?s\n  after ~a\n', PLAN('done s1'));
  assert.deepEqual(after.plan.names, ['fin']);
  const within = run(SVC + '@n norm\n  oblige ~b ?s\n  when svc ?s\n  within 1\n  severity soft\n  cost 5\n', PLAN('done s1'));
  assert.deepEqual(within.plan.names, ['b', 'fin'], 'b must be the first step to meet the deadline of one step');
  const late = run(SVC + '@n norm\n  oblige ~b ?s\n  when svc ?s\n  within 1\n  severity soft\n  cost 5\n@c norm\n  forbid ~b ?s\n  after ~fin\n', PLAN('done s1'));
  assert.deepEqual(late.plan.names, ['b', 'fin']);
});

test('an obligation is triggered per binding the goal or an executed step concerns, not per row of memory', () => {
  const k = SVC + '@n norm\n  oblige ~b ?s\n  when svc ?s\n  within 5\n  severity soft\n  cost 5\n';
  const r = run(k, PLAN('done s1'));
  assert.deepEqual(r.obligations_triggered, ['n s1']);
  const standing = run(SVC + '@n norm\n  oblige ~b ?s\n  when svc ?s\n  within 5\n  standing\n  severity soft\n  cost 5\n', PLAN('done s1'));
  assert.deepEqual([...standing.obligations_triggered].sort(), ['n s1', 'n s2']);
  assert.deepEqual(standing.obligation_unscoped, ['n']);
});

test('oblige always maintains a state atom from the trigger on; the planner never breaks it', () => {
  const k = '@u predicate\n  args subject:entity\n@powered predicate\n  args subject:entity\n@sealed predicate\n  args subject:entity\n@moved predicate\n  args subject:entity\n@f fact\n  holds u u1\n@f2 fact\n  holds powered u1\n@f3 fact\n  holds sealed u1\n'
    + '@swap action\n  params ?x\n  requires u ?x\n  removes powered ?x\n  adds moved ?x\n  cost 1\n@swap2 action\n  params ?x\n  requires u ?x\n  adds moved ?x\n  cost 3\n'
    + '@n norm\n  oblige powered ?x\n  when sealed ?x\n  always\n  severity hard\n';
  assert.deepEqual(run(k, PLAN('moved u1')).plan.names, ['swap2']);
});

// ----------------------------------------------------------------------------------------------------------- methods

test('a strict method may not be left; an unmet requirement blocks and names the step; on_failure and an advisory method fall back', () => {
  const k = '@g predicate\n  args none\n@need predicate\n  args none\n  closed true\n@s1 action\n  requires need\n  adds g\n  cost 1\n@s2 action\n  adds g\n  cost 9\n';
  const method = binding => `@m method\n  achieves g\n  binding ${binding}\n  step ~s1\n`;
  const strict = run(k + method('strict'), PLAN('g'));
  assert.equal(strict.status, 'blocked');
  assert.deepEqual(strict.blocked, {step: '~s1', requirement: 'need', norm: null});
  const advisory = run(k + method('advisory'), PLAN('g'));
  assert.deepEqual(advisory.plan.names, ['s2']);
  assert.ok(advisory.notes.includes('method_fallback_to_primitives'));
  const replan = run(k + method('strict') + '  on_failure replan\n', PLAN('g'));
  assert.deepEqual(replan.plan.names, ['s2']);
});

test('a loop cap is budget_exhausted (depth), an until that exits is a plan', () => {
  const k = '@c predicate\n  args none\n@t predicate\n  args none\n@tick action\n  adds t\n  cost 1\n@bump action\n  adds c\n  cost 1\n@m method\n  achieves c\n  step until c max 2\n    ~tick\n  end\n';
  const r = run(k, PLAN('c'));
  assert.equal(r.status, 'budget_exhausted');
  assert.equal(r.reason, 'depth');
  assert.equal(r.complete, false);
  assert.deepEqual(run(k.replace('~tick', '~bump'), PLAN('c')).plan.names, ['bump']);
});

test('the plan-length horizon is budget_exhausted (horizon), a closed finite space with no plan is no_plan', () => {
  const chain = '@at predicate\n  args subject:entity location:entity\n@road predicate\n  args source:entity destination:entity\n@s fact\n  holds at r a\n@r1 fact\n  holds road a b\n@r2 fact\n  holds road b c\n@r3 fact\n  holds road c d\n@move action\n  params ?r ?f ?t\n  requires at ?r ?f\n  requires road ?f ?t\n  adds at ?r ?t\n  removes at ?r ?f\n';
  const cut = run(chain, PLAN('at r d'), {maxDepth: 2});
  assert.deepEqual([cut.status, cut.reason, cut.complete], ['budget_exhausted', 'horizon', false]);
  assert.equal(run(chain, PLAN('at r d')).plan.steps, 3);
  assert.equal(run(chain, PLAN('at r z')).status, 'no_plan');
  const tiny = run(chain, PLAN('at r d'), {maxNodes: 2});
  assert.equal(tiny.status, 'budget_exhausted');
});

test('a sub-task without a method, an unknown action and a bad step arity are errors of the circuit, not plans', () => {
  const k = '@g predicate\n  args none\n@a action\n  adds g\n';
  assert.throws(() => run(k + '@m method\n  achieves g\n  step ~nothing\n', PLAN('g')), ProgramError);
  assert.throws(() => run(k + '@m method\n  achieves g\n  step ~a 1 2\n', PLAN('g')), ProgramError);
  assert.equal(run(k + '@m method\n  achieves g\n  step some_task\n', PLAN('g')).status, 'blocked');
});

// ------------------------------------------------------------------------------------- governance and the what-if modes

const GOV = '@g predicate\n  args none\n@fast action\n  adds g\n  cost 1\n@slow action\n  adds g\n  cost 5\n';

test('only approved versions bind; asof selects the version; a proposed version binds only when supposed; contested binds flagged', () => {
  const v1 = '@n1 norm\n  forbid ~fast\n  version 1\n  approval superseded\n  approved_by "b"\n  approved_at 2025-01-01\n';
  const v2 = '@n2 norm\n  forbid ~fast\n  severity hard\n  version 2\n  supersedes $n1\n  approval approved\n  approved_by "b"\n  approved_at 2026-06-01\n';
  const k = GOV + v1 + v2;
  assert.equal(run(k, PLAN('g')).plan.names[0], 'slow');
  assert.equal(run(k, PLAN('g').replace('where g', 'where g\n  asof 2026-01-01')).plan.names[0], 'slow', 'version 1 was in force and also forbids the fast action');
  assert.equal(run(GOV + '@n norm\n  forbid ~fast\n  approval proposed\n', PLAN('g')).plan.names[0], 'fast');
  const supposed = run(GOV + '@n norm\n  forbid ~fast\n  approval proposed\n', PLAN('g') + '  if $n\n');
  assert.deepEqual([supposed.plan.names, supposed.conditional], [['slow'], ['n']]);
  const contested = run(GOV + '@n norm\n  forbid ~fast\n  approval contested\n  approved_by "b"\n  approved_at 2026-01-01\n', PLAN('g'));
  assert.deepEqual([contested.plan.names, contested.contested], [['slow'], ['n']]);
});

test('an amendment may remove wires: the what-if drops them and is conditional on the amendment', () => {
  const k = GOV + '@n norm\n  forbid ~fast\n@am amendment\n  of $n\n  proposed_by user\n  removes $n\n  approval proposed\n';
  assert.equal(run(k, PLAN('g')).plan.names[0], 'slow');
  const r = run(k, PLAN('g') + '  if $am\n');
  assert.deepEqual([r.plan.names, r.conditional], [['fast'], ['am']]);
});

test('why_not asks about a step: a legal plan through it, or blocked by the minimal norms to waive', () => {
  const k = GOV + '@n norm\n  forbid ~fast\n  message "too risky"\n';
  const blocked = run(k, '@q query\n  mode why_not\n  where g\n  via ~fast\n');
  assert.deepEqual([blocked.status, blocked.blocked_by], ['blocked', ['n']]);
  assert.deepEqual(blocked.blocked, {step: '~fast', requirement: 'too risky', norm: 'n'});
  const legal = run(k, '@q query\n  mode why_not\n  where g\n  via ~slow\n');
  assert.equal(legal.status, 'plan_found');
});

test('waive abduction returns the inclusion-minimal sets of norms to waive, each with its hypothesis', () => {
  const k = '@g predicate\n  args none\n@r1 action\n  adds g\n  cost 1\n@r2 action\n  adds g\n  cost 1\n@n1 norm\n  forbid ~r1\n@n2 norm\n  forbid ~r2\n@w1 hypothesis\n  waive $n1\n  cost 1\n@w2 hypothesis\n  waive $n2\n  cost 2\n';
  const r = run(k, '@q query\n  mode abduce\n  where g\n  via ~r1\n');
  assert.equal(r.status, 'hypotheses');
  assert.deepEqual(r.hypotheses, [['waive n1']]);
  const either = run(k, '@q query\n  mode abduce\n  where g\n');
  assert.deepEqual(either.hypotheses, [['waive n1'], ['waive n2']]);
  const both = run(k.replace('@w1 hypothesis\n  waive $n1\n  cost 1\n@w2 hypothesis\n  waive $n2\n  cost 2\n', '@w hypothesis\n  waive $n1\n  waive $n2\n  cost 3\n'), '@q query\n  mode abduce\n  where g\n');
  assert.deepEqual(both.hypotheses, [['waive n1, waive n2']]);
  const none = run('@g predicate\n  args none\n@n norm\n  forbid ~r1\n@r1 action\n  adds g\n@w hypothesis\n  waive $other\n', '@q query\n  mode abduce\n  where g\n');
  assert.equal(none.status, 'unknown');
});

test('mode procedure renders the version in force at asof without searching', () => {
  const r = run(readCase('35b-procedure-render-current', 'knowledge.sop'), readCase('35b-procedure-render-current', 'query.sop'));
  assert.equal(r.status, 'procedure_found');
  assert.deepEqual(r.procedure.steps, ['~notify_oncall ?r', 'choose', '~soft_reset ?r', '~hard_reset ?r', 'end', '~verify_link ?r']);
  assert.deepEqual(run(readCase('35b-procedure-render-current', 'knowledge.sop'), PLAN('other_task x').replace('mode plan', 'mode procedure')).reason, 'no_procedure');
});

test('the policy scope filters scoped wires; with no context scope they bind and the packet says so', () => {
  const k = GOV + '@n norm\n  forbid ~fast\n  scope "ops, night"\n';
  const open = run(k, PLAN('g'));
  assert.deepEqual([open.plan.names[0], open.scope_unknown], ['slow', true]);
  const ops = run(k, '@q query\n  mode plan\n  where g\n  policy $p\n@p policy\n  scope "ops"\n');
  assert.deepEqual([ops.plan.names[0], ops.scope_unknown], ['slow', undefined]);
  assert.equal(run(k, '@q query\n  mode plan\n  where g\n  policy $p\n@p policy\n  scope "sales"\n').plan.names[0], 'fast');
});

test('objective violations minimises the number of violations before the cost', () => {
  const k = '@g predicate\n  args none\n@many action\n  adds g\n  cost 1\n@few action\n  adds g\n  cost 3\n@n1 norm\n  forbid ~many\n  severity soft\n  cost 1\n@n2 norm\n  forbid ~many\n  severity soft\n  cost 1\n@n3 norm\n  forbid ~few\n  severity soft\n  cost 1\n@p policy\n  objective violations\n';
  assert.deepEqual(run(k, PLAN('g')).plan.names, ['many'], 'by cost: many costs 1 + 2, few costs 3 + 1 = 4');
  assert.deepEqual(run(k, '@q query\n  mode plan\n  where g\n  policy $p\n').plan.names, ['few'], 'by violations: one violation beats two');
});

// ------------------------------------------------------------------------------------------------------------ check

test('check(plan) judges a given plan: feasibility, norms, methods and the goal', () => {
  const k = readCase('30a-router-reset-plan-under-norms', 'knowledge.sop');
  const good = check({steps: [{action: 'notify_oncall', args: ['r7']}, {action: 'soft_reset', args: ['r7']}, {action: 'verify_link', args: ['r7']}], goal: 'router_reset r7'}, {theory: {knowledge: k}});
  assert.deepEqual([good.status, good.compliance.hard, good.compliance.total_cost], ['compliant', 'ok', 5]);
  const infeasible = check({steps: [{action: 'soft_reset', args: ['r7']}]}, {theory: {knowledge: k}});
  assert.equal(infeasible.status, 'non_compliant');
  assert.deepEqual(infeasible.infeasible.map(x => x.requirement), ['notified r7']);
  const goalMissed = check({steps: [{action: 'notify_oncall', args: ['r7']}], goal: 'router_reset r7'}, {theory: {knowledge: k}});
  assert.equal(goalMissed.status, 'non_compliant');
  assert.ok(goalMissed.notes.includes('goal_not_reached'));
});

// -------------------------------------------------------------- the search against brute force (shadow of the monitors)

test('the planner finds the cheapest compliant plan: it agrees with an exhaustive search judged by the same monitors', () => {
  const MAXD = 5;
  let seed = 424242, compared = 0;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const R = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const mutate = t => t.replace(/^(  cost )(\d+)$/gm, (m, p) => p + R(1, 5)).replace(/^(  within )(\d+)$/gm, (m, p) => p + R(1, 5));
  for (const dir of ['32-norm-trajectory-hard', '33-norm-obligation-soft-unmet', '38-norm-obligation-scoping', '47a-forbid-before-qualifier', '47b-oblige-after-follow-up', '11a-plan-strips']) {
    for (let i = 0; i < 5; i++) {
      const k = i === 0 ? readCase(dir, 'knowledge.sop') : mutate(readCase(dir, 'knowledge.sop')), q = readCase(dir, 'query.sop');
      const got = run(k, q, {maxDepth: MAXD});
      if (got.relaxed?.length) continue;
      const ctx = buildContext({knowledge: readWires(k), queryWires: readWires(q)});
      const world = worldOf(ctx), goal = buildGoal(world, ctx.q);
      let best = null;
      const dfs = (lits, ev, steps) => {
        if (goal.holds(ev)) { const v = judgeRun(ctx, steps, {check: true, goal}); if (v.compliant && v.compliance.hard === 'ok' && (best === null || v.compliance.total_cost < best)) best = v.compliance.total_cost; }
        if (steps.length >= MAXD) return;
        for (const m of world.applicable(ev)) { const l2 = world.effect(lits, m.action, m.env); dfs(l2, world.close(l2).ev, [...steps, {action: m.action.id, args: m.params, at: null}]); }
      };
      const l0 = world.initial();
      dfs(l0, world.close(l0).ev, []);
      if (got.status === 'plan_found') assert.equal(got.compliance.total_cost, best, dir);
      else if (got.status !== 'budget_exhausted') assert.equal(best, null, dir);
      compared++;
    }
  }
  assert.ok(compared >= 25);
});

test('a plan that needs four norms waived is still blocked, named by the norms that pruned, flagged as not minimal', () => {
  const k = '@g predicate\n  args none\n@a1 predicate\n  args none\n@a2 predicate\n  args none\n@a3 predicate\n  args none\n@a4 predicate\n  args none\n'
    + ['1', '2', '3', '4'].map(i => `@s${i} action\n  adds a${i}\n  cost 1\n@n${i} norm\n  forbid ~s${i}\n`).join('')
    + '@fin action\n  requires a1\n  requires a2\n  requires a3\n  requires a4\n  adds g\n  cost 1\n';
  const r = run(k, PLAN('g'));
  assert.equal(r.status, 'blocked');
  assert.deepEqual([...r.blocked_by].sort(), ['n1', 'n2', 'n3', 'n4']);
  assert.ok(r.notes.includes('blocked_by_not_minimal'));
});

test('the planner agrees with the oracle on blind planning: status and cost on generated road graphs (shadow, fixed seed)', () => {
  let seed = 77, compared = 0;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const R = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  for (let t = 0; t < 40; t++) {
    const nodes = R(3, 8), names = Array.from({length: nodes}, (_, i) => 'n' + i);
    let k = '@at predicate\n  args subject:entity location:entity\n@road predicate\n  args source:entity destination:entity\n@s fact\n  holds at robot n0\n';
    for (let i = 0; i < R(2, 14); i++) k += `@e${i} fact\n  holds road ${names[R(0, nodes - 1)]} ${names[R(0, nodes - 1)]}\n`;
    k += `@move action\n  params ?r ?f ?t\n  requires at ?r ?f\n  requires road ?f ?t\n  adds at ?r ?t\n  removes at ?r ?f\n  cost ${R(1, 3)}\n`;
    const q = PLAN(`at robot ${names[R(0, nodes - 1)]}`);
    const a = oracleAsk({theory: {knowledge: k}, query: q}), b = run(k, q);
    assert.equal(b.status, a.status);
    if (a.plan) assert.equal(b.plan.cost, a.plan.cost);
    compared++;
  }
  assert.equal(compared, 40);
});
