// The runtime's view of the js-reference oracle (reasoning/bridge): lowering, the packet of the runtime (answers with validity,
// proof with derived facts, depth, explanation, statuses over time), the closure the controllers search with, and the registry routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {parse, parseAtom} from '../../sop/parser.mjs';
import {lowerQuery} from '../../sop/lower.mjs';
import {interval, instant} from '../../lib/time.mjs';
import {atomKey} from '../../lib/types.mjs';
import {reason, closure, evaluate, Lowering} from '../../reasoning/bridge/index.mjs';
import {factWire, ruleWire} from '../../reasoning/bridge/lower.mjs';
import {compileProlog, compileSMT} from '../../reasoning/bridge/export.mjs';
import {ReasoningRegistry, ROUTE_IDS} from '../../reasoning/registry.mjs';
import {solverSkip} from '../helpers.mjs';

const query = (body, at = '2026-09-26') => lowerQuery(parse('@q query\n' + body + (/^\s+(at|during) /m.test(body) ? '' : `  at ${at}\n`)).wires[0]);
const fact = (text, id, valid = 'timeless', kind = 'observed') => ({id, kind, atom: parseAtom(text), valid: interval(valid)});
const rule = (id, when, then, valid = 'timeless') => ({id, kind: 'rule', if: when.map(parseAtom), then: parseAtom(then), valid: interval(valid)});
const memory = (facts, rules = []) => ({facts, rules, complete: true, probes: 0});
const bindings = r => r.answers.map(a => a.binding);

test('lowering: terms, validity and renamed predicates and variables are written back unchanged', () => {
  const l = new Lowering();
  assert.equal(l.atom({p: 'works_at', a: ['ana', 'Acme Corp', 42, '42'], neg: true}), 'not works_at ana "Acme Corp" 42 "42"');
  assert.equal(l.atom({p: 'order', a: ['?X', 'x'], neg: false}), 'p_order ?v_' + Buffer.from('?X').toString('hex') + ' x');
  assert.equal(l.unpredicate('p_order'), 'order');
  assert.equal(l.unvariable(l.variable('?X')), '?X');
  assert.equal(l.unvariable('?y'), '?y');
  const w = factWire(l, 'f1', fact('works_at ana acme', 'x', '2024-01-01 open'), 'supposed');
  assert.deepEqual(w.fields.map(f => [f.key, f.value]), [['holds', 'works_at ana acme'], ['valid', '2024-01-01T00:00:00.000Z open'], ['status', 'supposed']]);
  assert.deepEqual(factWire(l, 'f2', fact('works_at ana acme', 'x')).fields.map(f => f.key), ['holds']);
  assert.deepEqual(ruleWire(l, rule('r1', ['p ?x'], 'q ?x')).fields.map(f => [f.key, f.value]), [['when', 'p ?x'], ['then', 'q ?x']]);
});

test('a reserved predicate name and an upper-case variable go through the oracle and come back', () => {
  const facts = [{id: 'f', kind: 'observed', atom: {p: 'order', a: ['book', 7], neg: false}, valid: interval('timeless')}];
  const q = {kind: 'query', mode: 'select', where: [{p: 'order', a: ['book', '?Count'], neg: false}], select: ['?Count'], filters: [], limit: 10, at: instant('2026-09-26'), asof: Infinity};
  assert.deepEqual(bindings(reason(q, memory(facts))), [{'?Count': 7}]);
});

test('a derived fact carries its rule, premises and the intersection of their validities; depth counts rule applications', () => {
  const m = memory([fact('parent ana bogdan', 'f1', '2024-01-01 open'), fact('parent bogdan carina', 'f2', '2020-01-01 2030-01-01')],
    [rule('gp', ['parent ?x ?y', 'parent ?y ?z'], 'grandparent ?x ?z'), rule('anc', ['grandparent ?x ?y'], 'ancestor ?x ?y')]);
  const r = reason(query('  where ancestor ana carina\n  mode explain\n'), m);
  assert.equal(r.status, 'supported');
  assert.equal(r.depth, 2);
  const derived = r.proof.filter(p => p.kind === 'derived');
  assert.deepEqual(derived.map(p => p.rule), ['anc', 'gp']);
  assert.deepEqual(derived[1].from, ['f1', 'f2']);
  assert.deepEqual(derived[1].valid, {from: instant('2024-01-01'), until: instant('2030-01-01')});
  assert.match(derived[0].id, /^d_[0-9a-f]{32}$/);
  assert.equal(r.explanation.kind, 'derivation');
  assert.deepEqual(r.explanation.steps.map(s => s.rule ?? s.source), ['anc', 'gp', 'observed', 'observed']);
});

test('time: a claim and its negation in different intervals are mixed_temporal, in the same part both, answers carry their validity', () => {
  const sequential = memory([fact('likes ana tea', 'a', '2024-01-01 2025-01-01'), fact('not likes ana tea', 'b', '2025-01-01 2026-01-01')]);
  assert.equal(reason(query('  where likes ana tea\n  during 2024-01-01 2026-01-01\n'), sequential).status, 'mixed_temporal');
  assert.equal(reason(query('  where likes ana tea\n  at 2024-06-01\n'), sequential).status, 'supported');
  assert.equal(reason(query('  where likes ana tea\n  at 2025-06-01\n'), sequential).status, 'refuted');
  const overlapping = memory([fact('likes ana tea', 'a', '2024-01-01 2025-06-01'), fact('not likes ana tea', 'b', '2025-01-01 2026-01-01')]);
  assert.equal(reason(query('  where likes ana tea\n  during 2024-01-01 2026-01-01\n'), overlapping).status, 'both');
  const jobs = memory([fact('works_at ana lab', 'j1', '2024-01-01 2025-01-01'), fact('works_at ana lab', 'j2', '2026-01-01 open')]);
  const r = reason(query('  where works_at ana ?o\n  select ?o\n  during 2023-01-01 2027-01-01\n'), jobs);
  assert.deepEqual(r.answers.map(a => a.valid), [{from: instant('2024-01-01'), until: instant('2025-01-01')}, {from: instant('2026-01-01'), until: instant('2027-01-01')}]);
  // intervals that never overlap cannot join, however the question is cut
  const apart = memory([fact('parent a b', 'x', '2024-01-01 2025-01-01'), fact('parent b c', 'y', '2025-01-01 2026-01-01')], [rule('gp', ['parent ?x ?y', 'parent ?y ?z'], 'grandparent ?x ?z')]);
  assert.equal(reason(query('  where grandparent a c\n  during 2024-01-01 2026-01-01\n'), apart).status, 'unknown');
});

test('time variables: span is the validity interval, measure its start, end or length; a timeline asks for every interval', () => {
  const m = memory([fact('visited ana cluj', 'v1', '2021-05-01 2021-05-02'), fact('visited ana cluj', 'v2', '2022-07-01 2022-07-02'), fact('works_at dan zeta', 'w', '2018-01-01 2021-01-01')]);
  const q = lowerQuery(parse('@q query\n  where visited ana cluj\n  select ?t\n  span ?t\n  mode count\n').wires[0]);
  assert.equal(reason(q, m).count, 2);
  const w = lowerQuery(parse('@q query\n  where works_at dan zeta\n  select ?t\n  span ?t\n  measure duration\n').wires[0]);
  assert.deepEqual(reason({...w, now: instant('2026-09-28')}, m).answers.map(a => a.binding['?t']), [1096]);
  const s = lowerQuery(parse('@q query\n  where works_at dan zeta\n  select ?t\n  span ?t\n  measure start\n').wires[0]);
  assert.deepEqual(reason(s, m).answers.map(a => a.binding['?t']), ['2018-01-01T00:00:00.000Z']);
});

test('temporal order compares the starts of the intervals of two conditions', () => {
  const m = memory([fact('joined ana acme', 'a', '2019-01-01 open'), fact('left bob acme', 'b', '2021-01-01 open')]);
  const order = relation => lowerQuery(parse(`@q query\n  where all\n    joined ana acme\n    left bob acme\n  end\n  span ?a\n  order ?a ${relation} ?b leaves 0 1\n  mode exists\n`).wires[0]);
  assert.equal(reason(order('before'), m).status, 'supported');
  assert.equal(reason(order('after'), m).status, 'refuted');
});

test('assumptions: a defeated one never enters, a used one makes the answer hypothetical', () => {
  const world = memory([fact('located r1 hall', 'f')], [rule('r', ['located ?x ?y', 'door_open ?x'], 'connected ?x ?y')]);
  const assumption = (text, id) => ({...fact(text, id), kind: 'assumed'});
  const used = reason(query('  where connected r1 hall\n'), world, {assumptions: [assumption('door_open r1', 'a1')]});
  assert.equal(used.status, 'supported');
  assert.equal(used.hypothetical, true);
  assert.deepEqual(used.proof.filter(p => p.kind === 'assumed').map(p => p.id), ['a1']);
  const defeated = reason(query('  where connected r1 hall\n'), memory([...world.facts, fact('not door_open r1', 'n')], world.rules), {assumptions: [assumption('door_open r1', 'a1')]});
  assert.equal(defeated.status, 'unknown');
  assert.deepEqual(defeated.defeatedAssumptions, ['a1']);
  assert.equal(defeated.hypothetical, false);
});

test('a universal question merges the members of the parts and groups them under the quantifier', () => {
  const m = memory([fact('works_at ana acme', 'a', '2020-01-01 open'), fact('works_at bob acme', 'b', '2019-01-01 open'), fact('certified ana', 'c'), fact('not certified bob', 'd'),
    fact('works_at dan zeta', 'e', '2018-01-01 2021-01-01'), fact('certified dan', 'f')]);
  const every = (extra = '') => reason(lowerQuery(parse('@q query\n  mode every\n  where works_at ?e acme\n  scope certified ?e\n' + extra).wires[0]), m);
  const refuted = every('  at 2026-09-26\n');
  assert.equal(refuted.status, 'refuted');
  assert.deepEqual(refuted.counterexamples, [{'?e': 'bob'}]);
  assert.equal(refuted.members, 2);
  assert.equal(every('  at 2026-09-26\n  quantifier at_least 1\n').status, 'supported');
  assert.equal(every('  at 2019-06-01\n').status, 'refuted');
  const byOrg = reason(lowerQuery(parse('@q query\n  mode every\n  where works_at ?e ?c\n  select ?c\n  scope certified ?e\n  during 2020-06-01 2020-07-01\n').wires[0]), m);
  assert.deepEqual(bindings(byOrg), [{'?c': 'zeta'}]);
});

test('closure keeps the controllers shapes; blocked heads are never derived; evaluate reads closed facts', () => {
  const facts = [fact('mother ana bogdan', 'm'), fact('works_at ana acme', 'w')];
  const rules = [rule('r1', ['mother ?x ?y'], 'parent ?x ?y')];
  const cl = closure(facts, rules);
  assert.equal(cl.complete, true);
  assert.deepEqual(cl.facts.map(f => atomKey(f.atom)).sort(), [...facts.map(f => atomKey(f.atom)), atomKey(parseAtom('parent ana bogdan'))].sort());
  const derived = cl.facts.find(f => f.kind === 'derived');
  assert.equal(derived.rule, 'r1');
  assert.deepEqual(derived.from, ['m']);
  const blocked = closure(facts, rules, {blockedHeads: new Set([atomKey(parseAtom('parent ana bogdan'))])});
  assert.equal(blocked.facts.some(f => f.kind === 'derived'), false);
  const found = evaluate(query('  where parent ana ?c\n  select ?c\n'), cl.facts);
  assert.deepEqual(bindings(found), [{'?c': 'bogdan'}]);
  assert.deepEqual(found.proof.map(p => p.kind), ['derived', 'observed']);
  assert.equal(closure(facts, rules, {maxJoins: 1}).complete, false);
});

test('registry: reference is the oracle under three ids, advanced is gone, an external backend is never substituted', () => {
  assert.deepEqual(ROUTE_IDS, ['reference', 'js-reference', 'js-oracle']);
  const q = query('  where likes ana book\n  mode exists\n');
  const request = {query: q, memory: memory([fact('likes ana book', 'f')])};
  const registry = new ReasoningRegistry({availability: () => false});
  for (const id of ROUTE_IDS) {
    const r = registry.run(id, request);
    assert.equal(r.status, 'supported');
    assert.equal(r.reasoningStrategy, 'reference');
    assert.equal(r.route.backend, 'js');
    assert.equal(r.route.deprecated, undefined);
  }
  assert.throws(() => registry.run('advanced', request), /Unknown reasoning strategy advanced/);
  const pinned = registry.run('prolog-tabling', {...request, backend: 'prolog'});
  assert.equal(pinned.reasoningStrategy, 'prolog-tabling');
  assert.equal(pinned.route.backend, 'prolog');
  const denied = registry.run('js-oracle', {...request, backend: 'prolog'});
  assert.equal(denied.code, 'reference_backend_mismatch');
  assert.equal(denied.route.backend, 'prolog');
  assert.equal(denied.route.fallback, null);
});

test('an explicit Prolog request runs prolog-tabling and the answer is checked against the oracle', {skip: solverSkip('prolog')}, () => {
  const m = memory([fact('parent ana bogdan', 'a'), fact('parent bogdan carina', 'b')], [rule('gp', ['parent ?x ?y', 'parent ?y ?z'], 'grandparent ?x ?z')]);
  const r = new ReasoningRegistry().run('prolog-tabling', {query: query('  where grandparent ?g carina\n  select ?g\n  mode select\n'), memory: m, backend: 'prolog'});
  assert.equal(r.route.backend, 'prolog');
  assert.equal(r.backendAgreement, true);
  assert.equal(r.backendStrategy, 'prolog-tabling');
  assert.deepEqual(bindings(r), [{'?g': 'ana'}]);
});

test('inspectable programs: the Prolog text of prolog-tabling and the SMT script of a typed constraint', () => {
  const text = compileProlog([parseAtom('parent ana bogdan')], [rule('r', ['parent ?x ?y'], 'ancestor ?x ?y')]);
  assert.match(text, /:- table p_parent\/2\./);
  assert.match(text, /p_ancestor/);
  const smt = compileSMT({vars: {x: {sort: 'Int', min: 0, max: 5}}, constraints: [{op: 'ge', a: ['x', 2]}], claim: {op: 'le', a: ['x', 4]}, task: 'prove'});
  assert.match(smt.prefix, /\(declare-const x Int\)/);
  assert.match(smt.prefix, /\(assert \(>= x 2\)\)/);
  assert.equal(smt.claim, '(<= x 4)');
});
