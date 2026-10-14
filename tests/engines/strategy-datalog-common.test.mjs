import test from 'node:test';
import assert from 'node:assert/strict';
import {datalogSouffle} from '../../reasoning/strategies/datalog-souffle/index.mjs';
import {datalogE10} from '../../reasoning/strategies/datalog-e10/index.mjs';
import {datalogSoplab} from '../../eval/reference-engines/datalog-soplab/index.mjs';
import {ProgramError, NotExpressibleError} from '../../reasoning/strategies/datalog-common/front.mjs';

/** The contract the three Datalog strategies share (proposal 5.1 to 5.3): handles, packet fields, honest refusals. */
const souffleOk = (await datalogSouffle.available()).ok;
const STRATEGIES = [['datalog-e10', datalogE10, true], ['datalog-soplab', datalogSoplab, true], ['datalog-souffle', datalogSouffle, souffleOk]];

const K = '@f1 fact\n  holds edge a b\n@f2 fact\n  holds edge b c\n@r1 rule\n  when edge ?x ?y\n  then reach ?x ?y\n@r2 rule\n  when reach ?x ?y\n  when edge ?y ?z\n  then reach ?x ?z\n';
const Q = '@q query\n  where reach a ?y\n  select ?y\n';
const ys = r => r.rows.map(x => x.y).sort();

for (const [id, strategy, ok] of STRATEGIES) {
  test(`${id}: a prepared handle answers and follows additions and retractions (update)`, { skip: !ok && 'engine unavailable' }, () => {
    const handle = strategy.prepare({knowledge: K});
    assert.deepEqual(ys(strategy.ask({handle, query: Q})), ['b', 'c']);
    const more = strategy.update(handle, {add: '@f3 fact\n  holds edge c d\n'});
    assert.deepEqual(ys(strategy.ask({handle: more, query: Q})), ['b', 'c', 'd']);
    const less = strategy.update(more, {remove: ['f2']});
    assert.deepEqual(ys(strategy.ask({handle: less, query: Q})), ['b']);
    assert.deepEqual(ys(strategy.ask({handle, query: Q})), ['b', 'c'], 'the old handle is unchanged');
  });

  test(`${id}: the packet names the strategy, the route and never substitutes`, { skip: !ok && 'engine unavailable' }, () => {
    const r = strategy.ask({theory: {knowledge: K}, query: Q, requested: id});
    assert.equal(r.strategy, id);
    assert.deepEqual({requested: r.route.requested, chosen: r.route.chosen, fallback: r.route.fallback}, {requested: id, chosen: id, fallback: null});
    assert.equal(r.guarantee, 'exact');
    assert.equal(r.complete, true);
    assert.equal(r.used, undefined, 'a strategy that does not provide used leaves it to the host');
    assert.ok(r.budget && 'limit' in r.budget && r.budget.exhausted === false);
  });

  test(`${id}: invalid circuits are errors, circuits it cannot run are not_expressible`, { skip: !ok && 'engine unavailable' }, () => {
    assert.throws(() => strategy.ask({theory: {knowledge: '@r rule\n  when p ?x\n  then q ?y\n'}, query: '@q query\n  where q ?y\n  select ?y\n'}), e => e instanceof ProgramError && e.code === 'unsafe_head');
    assert.throws(() => strategy.ask({theory: {knowledge: K}, query: '@q query\n  at 2026-01-01\n  where reach a ?y\n  select ?y\n'}), NotExpressibleError);
    assert.throws(() => strategy.ask({theory: {knowledge: K}, query: '@q query\n  mode why_not\n  where reach c a\n'}), NotExpressibleError);
    assert.throws(() => strategy.ask({theory: {knowledge: K}, query: '@v var\n'}), Error);
  });

  test(`${id}: capabilities carry the routing dimensions`, () => {
    const c = strategy.capabilities;
    assert.equal(c.delivery, 'slice');
    assert.equal(c.guarantee, 'exact');
    assert.ok(Array.isArray(c.features) && c.features.includes('recursion') && c.features.includes('naf'));
    assert.ok(Array.isArray(c.provides));
    assert.ok(c.limits && c.limits.max_arity === 6);
    assert.ok(c.notExpressible.includes('temporal') && c.notExpressible.includes('why_not'));
  });
}

test('the strategies agree with each other on a program with defaults, integrity and negation', { skip: !souffleOk && 'souffle unavailable' }, () => {
  const k = `@penguin predicate
  args subject:entity
  closed true
@f1 fact
  holds bird tweety
@f2 fact
  holds bird pingu
@f3 fact
  holds penguin pingu
@birds_fly default
  when bird ?x
  then flies ?x
  except penguin ?x
@no_flying_penguin integrity
  never all
    penguin ?x
    flies ?x
  end
  witness ?x
  message "a penguin flies"
`;
  const q = '@q query\n  where flies ?x\n  select ?x\n';
  const answers = STRATEGIES.map(([, s]) => ys2(s.ask({theory: {knowledge: k}, query: q}))).map(x => JSON.stringify(x));
  assert.equal(new Set(answers).size, 1);
  assert.deepEqual(JSON.parse(answers[0]), ['tweety']);
});

const ys2 = r => r.rows.map(x => x.x).sort();
