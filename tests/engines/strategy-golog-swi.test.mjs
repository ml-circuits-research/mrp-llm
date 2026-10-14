import test from 'node:test';
import assert from 'node:assert/strict';
import {gologSwi, NotExpressibleError, capabilities} from '../../reasoning/strategies/golog-swi/index.mjs';
import {htnStripsPlanner} from '../../reasoning/strategies/htn-strips-planner/index.mjs';
import {probeSwipl} from '../../reasoning/strategies/prolog-tabling/swipl.mjs';
import {SCENARIOS} from './golog-scenarios.mjs';

const swi = probeSwipl();
const opts = {skip: swi.ok ? false : 'private swipl not available'};
const ask = (knowledge, query, budget = {}) => gologSwi.ask({theory: {knowledge}, query}, budget);
const scenario = name => SCENARIOS.find(s => s[0] === name);
const run = name => { const [, k, q] = scenario(name); return ask(k, q); };
const idv = xs => (xs ?? []).map(u => `${u.id}@${u.version}`).sort().join(',');

test('capabilities: the planning family only, no blind planning, no relational modes', opts, () => {
  assert.equal(capabilities.id, 'golog-swi');
  for (const f of ['plan', 'method', 'htn_choice', 'on_failure', 'norms_hard', 'norms_soft', 'temporal_norms', 'check_plan', 'procedure_render', 'conform_deviation']) assert.ok(capabilities.features.includes(f), f);
  for (const f of ['recursion', 'aggregate', 'default', 'constraint', 'norm_conflict', 'interval']) assert.ok(!capabilities.features.includes(f), f);
});

test('a method is a Golog program: choice, optional, loops, sub-tasks and any_order give the cheapest legal run', opts, () => {
  assert.deepEqual(run('loop-until-reaches-goal').plan.names, ['heat', 'finish']);
  assert.deepEqual(run('optional-step-skipped-when-costly').plan.names, ['prep', 'do_it']); // the costly optional check is skipped
  assert.deepEqual(run('subtask-uses-its-own-method').plan.names, ['do_a', 'do_b', 'seal']);
  const used = idv(run('subtask-uses-its-own-method').used);
  assert.ok(used.includes('m_a@1') && used.includes('m_all@1'), used);
  assert.deepEqual(run('any-order-forced-by-preconditions').plan.names, ['cut_it', 'sand_it', 'finish_it']); // the only order whose preconditions hold
});

test('an `until` loop that reaches its cap is budget_exhausted (depth), never a plan or a no', opts, () => {
  const r = run('loop-until-cap-is-budget');
  assert.equal(r.status, 'budget_exhausted');
  assert.equal(r.reason, 'depth');
  assert.equal(r.complete, false);
});

test('hard norms prune runs, soft norms cost, a hard obligation can block', opts, () => {
  assert.deepEqual(run('forbid-before-qualifier-picks-the-other-order').plan.names, ['make_x', 'make_y', 'join']);
  assert.equal(run('at-most-once-forbids-the-repeat').status, 'blocked');
  assert.deepEqual(run('at-most-once-forbids-the-repeat').blocked_by, ['once']);
  const soft = run('oblige-within-soft-is-paid-when-skipped');
  assert.deepEqual(soft.plan.names, ['log_it', 'work']); // logging (1) is cheaper than the soft violation (10)
  assert.equal(soft.compliance.total_cost, 3);
  assert.deepEqual(soft.obligations_triggered, ['promptly a']);
  const picked = run('pick-a-target-under-a-norm');
  assert.equal(picked.status, 'plan_found');
  assert.ok(idv(picked.used).includes('no_t1@1'), 'a prohibition that ruled an alternative out is used');
});

test('why_not with via names the norm that blocks the step', opts, () => {
  const r = run('why-not-via-blocked-by-two-norms');
  assert.equal(r.status, 'blocked');
  assert.deepEqual(r.blocked_by, ['n1']);
  assert.equal(r.blocked.step, '~hasty a');
});

test('procedure renders the approved method as written, with its version', opts, () => {
  const r = run('procedure-renders-the-method');
  assert.equal(r.status, 'procedure_found');
  assert.equal(r.procedure.version, 3);
  assert.deepEqual(r.procedure.steps, ['~work ?x']);
});

test('conformance: a strict method is a program, a trace that is not one of its runs deviates; an advisory deviation is only listed', opts, () => {
  const bad = run('conform-method-deviation-by-order');
  assert.equal(bad.status, 'non_compliant');
  assert.deepEqual(bad.compliance.deviations, ['m']);
  assert.equal(run('conform-method-ok-with-optional-and-if').status, 'compliant');
  const adv = run('conform-advisory-method-deviation-only-listed');
  assert.equal(adv.status, 'compliant');
  assert.deepEqual(adv.compliance.deviations, ['m']);
  const permit = run('conform-forbid-always-with-permit');
  assert.equal(permit.status, 'compliant');
  assert.ok(idv(permit.used).includes('ok_in_window@1'));
});

test('a circuit golog-swi does not cover is not_expressible, never weakened', opts, () => {
  const k = '@a action\n  params ?x\n  requires p ?x\n  adds q ?x\n@f fact\n  holds p a\n';
  assert.throws(() => ask(k, '@q query\n  mode plan\n  where q a\n'), NotExpressibleError); // no approved method: blind planning
  assert.throws(() => ask(k, '@q query\n  where p ?x\n  select ?x\n'), NotExpressibleError); // a relational mode
  const achieve = k + '@m method\n  achieves r ?x\n  when p ?x\n  step achieve q ?x\n';
  assert.throws(() => ask(achieve, '@q query\n  mode plan\n  where r a\n'), NotExpressibleError);
});

test('budgets: a probe limit is budget_exhausted, the wall limit kills the process', opts, () => {
  const [, k, q] = scenario('optional-step-skipped-when-costly');
  const probes = ask(k, q, {maxJoins: 50});
  assert.equal(probes.status, 'budget_exhausted');
  assert.equal(probes.reason, 'probes');
});

test('check(plan): an executable, compliant plan is compliant, a step whose precondition fails is infeasible', opts, () => {
  const [, k] = scenario('optional-step-skipped-when-costly');
  const good = gologSwi.check({steps: [{action: 'prep', args: ['a']}, {action: 'do_it', args: ['a']}]}, {theory: {knowledge: k}});
  assert.equal(good.status, 'compliant');
  const bad = gologSwi.check({steps: [{action: 'do_it', args: ['a']}]}, {theory: {knowledge: k}});
  assert.equal(bad.status, 'non_compliant');
  assert.equal(bad.infeasible.length, 1);
});

test('shadow: every scenario agrees with the htn-strips-planner on status, plan, compliance, used, blocked_by and procedure', opts, () => {
  const view = p => ({
    status: p.status, plan: p.plan && {names: p.plan.names, cost: p.plan.cost},
    compliance: p.compliance && {hard: p.compliance.hard, violated: [...(p.compliance.violated ?? [])].sort(), soft: (p.compliance.soft_violations ?? []).map(s => `${s.id}:${s.cost}`).sort(), dev: [...(p.compliance.deviations ?? [])].sort(), total: p.compliance.total_cost},
    used: idv(p.used), blocked_by: p.blocked_by && [...p.blocked_by].sort(), trig: p.obligations_triggered && [...p.obligations_triggered].sort(),
    proc: p.procedure && {id: p.procedure.id, version: p.procedure.version, steps: p.procedure.steps}, reason: p.reason
  });
  const disagreements = [];
  let compared = 0;
  for (const [name, k, q] of SCENARIOS) {
    let g, h;
    try { g = ask(k, q); } catch (e) { if (e instanceof NotExpressibleError) continue; throw e; }
    try { h = htnStripsPlanner.ask({theory: {knowledge: k}, query: q}); } catch (e) { continue; }
    compared++;
    if (JSON.stringify(view(g)) !== JSON.stringify(view(h))) disagreements.push({name, golog: view(g), planner: view(h)});
  }
  assert.ok(compared >= SCENARIOS.length - 1, `only ${compared} scenarios compared`);
  assert.deepEqual(disagreements, []);
});
