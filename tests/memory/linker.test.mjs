import test from 'node:test';
import assert from 'node:assert/strict';
import {planGoals, matchRule} from '../../reasoning/linker.mjs';
import {parse} from '../../sop/parser.mjs';
import {lowerQuery, lowerRule} from '../../sop/lower.mjs';
import {context, schema} from '../helpers.mjs';
import {StrategyRegistry} from '../../memory/strategies.mjs';
import {Runtime} from '../../sop/runtime.mjs';

const q = s => lowerQuery(parse('@q query\n  where ' + s + '\n  at 2026-09-26').wires[0]);
const rule = (head, body, id = 'r') => lowerRule(parse('@' + id + ' rule\n' + body.map(b => '  when ' + b + '\n').join('') + '  then ' + head).wires[0]);
const ask = strategy => `@q query
  select ?who
  where grandmother ?who carina
  at 2026-09-26
@r solve
  query $q
  strategy ${strategy}
  output ?who one
@answer cnl
  result $r
  language ro`;

/** Runs `body` against a fresh repository context and always disposes it. */
async function withContext(options, body) {
  const c = context(options);
  try {
    await body(c);
  } finally {
    c.dispose();
  }
}

test('unification substitutes constants into prerequisite goals', () => {
  const p = planGoals(q('grandmother ?who carina'), [rule('grandmother ?x ?z', ['mother ?x ?y', 'parent ?y ?z'])]);
  assert.ok(p.goals.some(a => a.p === 'parent' && a.a[1] === 'carina'));
  assert.equal(p.rules.length, 1);
});

test('predicate similarity never invents a bridge', () => {
  const p = planGoals(q('lives_in ana ?city'), [rule('works_in ?p ?c', ['works_at ?p ?o', 'located_in ?o ?c'])]);
  assert.equal(p.rules.length, 0);
});

test('repeated variable constraints prevent an incompatible rule match', () => {
  assert.equal(matchRule(q('same ana bogdan').where[0], rule('same ?x ?x', ['person ?x'])), null);
});

test('rule-local variable names do not capture goal variables', () => {
  const r = rule('path ?x ?z', ['edge ?x ?y', 'edge ?y ?z']);
  const p = matchRule(q('path ?y target').where[0], r);
  assert.equal(p.subgoals[1].a[1], 'target');
  assert.notEqual(p.subgoals[0].a[0], p.subgoals[0].a[1]);
});

test('recursive goal planning terminates through normalized goal keys', () => {
  const p = planGoals(q('ancestor ?x carina'), [
    rule('ancestor ?x ?y', ['parent ?x ?y'], 'base'),
    rule('ancestor ?x ?z', ['parent ?x ?y', 'ancestor ?y ?z'], 'rec'),
  ]);
  assert.equal(p.complete, true);
  assert.ok(p.goals.length < 20);
});

test('goal budget marks incomplete planning, not falsehood', () => {
  const p = planGoals(q('grandmother ?who carina'), [rule('grandmother ?x ?z', ['mother ?x ?y', 'parent ?y ?z'])], {maxGoals: 2});
  assert.equal(p.complete, false);
});

test('opposite facts are sought for explicit conflict detection', () => {
  const p = planGoals(q('parent ana carina'), []);
  assert.equal(p.goals.length, 2);
  assert.equal(p.goals[1].neg, true);
});

test('inactive temporal rules do not expand the query', () => {
  const r = rule('grandmother ?x ?z', ['mother ?x ?z']);
  r.valid = {from: 0, until: Date.parse('2020-01-01')};
  assert.equal(planGoals(q('grandmother ?who carina'), [r]).rules.length, 0);
});

for (const strategy of ['recall-memory', 'exact', 'hybrid']) {
  test('same task solved with independent strategy ' + strategy, () => withContext({memory: {exact: true}}, async c => {
    const r = await c.run(ask(strategy));
    assert.equal(r.values.who, 'ana');
    assert.equal(r.values.r.linkPlan.strategy, strategy);
  }));
}

test('exact strategy declares incomplete coverage without exact tuples', () => withContext({}, async c => {
  const r = await c.run(ask('exact'));
  assert.equal(r.values.r.complete, false);
  assert.equal(r.outputs.who.status, 'incomplete');
}));

test('a host can register a retrieval provider without changing SOP', () => withContext({}, async c => {
  let called = 0;
  const registry = new StrategyRegistry().register('custom', request => {
    called++;
    return new StrategyRegistry().retrieve('recall-memory', request);
  });
  const r = await new Runtime({repo: c.repo, session: c.session, schema, strategies: registry}).run(ask('custom'));
  assert.equal(r.values.who, 'ana');
  assert.ok(called > 0);
}));

test('unrecognized retrieval strategy fails closed', () => withContext({}, async c => {
  await assert.rejects(c.run(ask('magic')), /Unknown retrieval strategy/);
}));

test('host restricts strategy choice independently from model output', () => withContext({memory: {exact: true}}, async c => {
  await assert.rejects(c.run(ask('exact'), {policy: {allowedStrategies: ['recall-memory']}}), /forbidden/);
}));

test('exact strategy respects update and asof history', () => withContext({memory: {exact: true}}, async c => {
  const layer = c.repo.visible(c.session).find(x => Object.keys(x.layer.claims).length).layer;
  const claim = Object.values(layer.claims).find(x => layer.exactAtoms[x.tupleHash].p === 'works_at');
  c.repo.apply(c.session, [{kind: 'event', action: 'retract', target: claim.id}], {knownAt: Date.parse('2026-01-01')});
  const registry = new StrategyRegistry();
  const pattern = layer.exactAtoms[claim.tupleHash];
  for (const [asof, count] of [[Date.parse('2025-01-01'), 1], [Date.parse('2026-09-26'), 0]]) {
    const result = registry.retrieve('exact', {
      repo: c.repo,
      session: c.session,
      pattern,
      query: {...q('works_at ana cern'), asof},
      limits: {maxProbes: 100, maxFacts: 10},
    });
    assert.equal(result.rows.length, count);
  }
}));
