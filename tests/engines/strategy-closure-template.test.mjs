import test from 'node:test';
import assert from 'node:assert/strict';
import {closureTemplate, NotExpressibleError} from '../../reasoning/strategies/closure-template/index.mjs';
import {jsReference} from '../../reasoning/strategies/js-reference/index.mjs';
import {parse, wiresText} from '../../sop/knowledge/index.mjs';

const PRED = closed => `@edge predicate\n  args source:entity destination:entity\n@reaches predicate\n  args source:entity destination:entity\n${closed ? '  closed true\n' : ''}`;
const RULES = {
  right: '@r_base rule\n  when edge ?x ?y\n  then reaches ?x ?y\n@r_step rule\n  when edge ?x ?m\n  when reaches ?m ?y\n  then reaches ?x ?y\n',
  left: '@r_base rule\n  when edge ?x ?y\n  then reaches ?x ?y\n@r_step rule\n  when reaches ?x ?m\n  when edge ?m ?y\n  then reaches ?x ?y\n',
  both: '@r_base rule\n  when edge ?x ?y\n  then reaches ?x ?y\n@r_step rule\n  when reaches ?x ?m\n  when reaches ?m ?y\n  then reaches ?x ?y\n',
  reversed: '@r_base rule\n  when edge ?x ?y\n  then reaches ?x ?y\n@r_step rule\n  when reaches ?m ?y\n  when edge ?x ?m\n  then reaches ?x ?y\n'
};
const facts = edges => edges.map(([a, b], i) => `@e${i} fact\n  holds edge ${a} ${b}`).join('\n') + '\n';
const kb = (edges, shape = 'right', closed = false) => PRED(closed) + facts(edges) + RULES[shape];
const q = (where, extra = '') => `@q query\n  where ${where}\n${extra}`;
const ct = (k, query, budget) => closureTemplate.ask({theory: {knowledge: k}, query}, budget);
const orc = (k, query) => jsReference.ask({theory: {knowledge: k}, query});
const rowSet = p => (p.rows ?? []).map(r => JSON.stringify(r)).sort();
const E = [['a', 'b'], ['b', 'c'], ['c', 'a'], ['c', 'd'], ['x', 'y']];

test('the three step shapes (and the swapped body order) are recognised, anything else is not', () => {
  for (const shape of ['right', 'left', 'both', 'reversed']) {
    const m = closureTemplate.matches({theory: {knowledge: kb(E, shape)}, query: q('reaches a ?t', '  select ?t\n')});
    assert.ok(m, shape);
    assert.equal(m.E, 'edge');
  }
  const no = (k, why) => assert.equal(closureTemplate.matches({theory: {knowledge: k}, query: q('reaches a ?t', '  select ?t\n')}), null, why);
  no(kb(E, 'right') + '@r_extra rule\n  when edge ?x ?y\n  then reaches ?y ?x\n', 'a third rule for the closure predicate');
  no(kb(E, 'right') + '@f_p fact\n  holds reaches q r\n', 'a fact of the closure predicate itself');
  no(kb(E, 'right') + '@n1 fact\n  holds not edge a b\n', 'a negative fact about the edge relation');
  no(kb(E, 'right') + '@r_e rule\n  when other ?x ?y\n  then edge ?x ?y\n', 'a derived edge relation');
  no(kb(E, 'right').replace('@e0 fact\n  holds edge a b', '@e0 fact\n  holds edge a b\n  valid 2025-01-01 2026-01-01'), 'a validity interval');
  no(PRED(false) + facts(E) + '@r_base rule\n  when edge ?x ?y\n  then reaches ?x ?y\n@r_step rule\n  when edge ?x ?m\n  when reaches ?m ?y\n  when edge ?y ?x\n  then reaches ?x ?y\n', 'a step with a third condition');
});

test('forward, backward and ground queries return the oracle rows with a witness path', () => {
  const k = kb(E);
  const fwd = ct(k, q('reaches a ?t', '  select ?t\n'));
  assert.equal(fwd.status, 'supported');
  assert.deepEqual(rowSet(fwd), rowSet(orc(k, q('reaches a ?t', '  select ?t\n'))));
  assert.deepEqual(rowSet(fwd), ['{"t":"a"}', '{"t":"b"}', '{"t":"c"}', '{"t":"d"}']);
  const bwd = ct(k, q('reaches ?s d', '  select ?s\n'));
  assert.deepEqual(rowSet(bwd), ['{"s":"a"}', '{"s":"b"}', '{"s":"c"}']);
  const g = ct(k, q('reaches a d', '  mode exists\n'));
  assert.equal(g.status, 'supported');
  assert.deepEqual(g.witness.path, ['a', 'b', 'c', 'd']);
  assert.equal(ct(k, q('reaches a y', '  mode exists\n')).status, 'unknown', 'open predicate: no path is unknown');
  assert.equal(ct(kb(E, 'right', true), q('reaches a y', '  mode exists\n')).status, 'refuted', 'closed predicate: no path is refuted');
});

test('count follows the host rule: a lower bound over an open predicate, exact over a closed one', () => {
  const open = ct(kb(E), q('reaches a ?t', '  mode count\n'));
  assert.equal(open.count, 4);
  assert.equal(open.bound, 'at_least');
  const closed = ct(kb(E, 'right', true), q('reaches a ?t', '  mode count\n'));
  assert.equal(closed.count, 4);
  assert.equal(closed.bound, undefined);
  assert.equal(ct(kb(E, 'right', true), q('reaches y ?t', '  mode count\n')).count, 0);
});

test('declines what it cannot answer exactly: both arguments free, other modes, time, suppositions', () => {
  const k = kb(E);
  for (const query of [q('reaches ?x ?y', '  select ?x ?y\n'), q('reaches a ?t', '  mode explain\n'), q('reaches a ?t', '  select ?t\n  at 2026-01-01\n'), q('reaches ?x ?x', '  select ?x\n')]) {
    assert.throws(() => ct(k, query), NotExpressibleError);
  }
});

test('a round ceiling is an honest partial answer; a probe ceiling is budget_exhausted without rows', () => {
  const chain = Array.from({length: 12}, (_, i) => [`n${i}`, `n${i + 1}`]);
  const k = kb(chain);
  const cut = ct(k, q('reaches n0 ?t', '  select ?t\n  policy $p\n') + '@p policy\n  maxRounds 3\n');
  assert.equal(cut.status, 'supported');
  assert.equal(cut.complete, false);
  assert.equal(cut.rows.length, 3);
  const full = ct(k, q('reaches n0 ?t', '  select ?t\n'));
  assert.equal(full.rows.length, 12);
  for (const r of cut.rows) assert.ok(rowSet(full).includes(JSON.stringify(r)), 'a partial row is a true row');
  const probes = ct(k, q('reaches n0 ?t', '  select ?t\n'), {maxJoins: 5});
  assert.equal(probes.status, 'budget_exhausted');
  assert.equal(probes.reason, 'probes');
  assert.equal(ct(k, q('reaches n0 n12', '  mode exists\n  policy $p\n') + '@p policy\n  maxRounds 3\n').status, 'budget_exhausted', 'a cut that has not found the target is not a negative');
});

// ----------------------------------------------------------------------------------------------------- shadow gate
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Replay `used` alone in the oracle (5.4): keep only the used claim wires and the predicate declarations. */
function replayUsed(k, used, query) {
  const ids = new Set(used.map(u => u.id));
  const wires = parse(k).wires.filter(w => w.type === 'predicate' || ids.has(w.id));
  return orc(wiresText(wires), query);
}

test('shadow gate: 120 random programs, every shape, every bound pattern, equal to the oracle, and `used` replays', () => {
  const R = rng(20261001);
  let compared = 0, replayed = 0;
  for (let t = 0; t < 120; t++) {
    const n = 4 + Math.floor(R() * 9), m = Math.floor(R() * n * 2);
    const edges = Array.from({length: m}, () => [`v${Math.floor(R() * n)}`, `v${Math.floor(R() * n)}`]);
    const shape = ['right', 'left', 'both', 'reversed'][t % 4], closed = t % 3 === 0;
    const k = kb(edges, shape, closed);
    const a = `v${Math.floor(R() * n)}`, b = `v${Math.floor(R() * n)}`;
    for (const query of [q(`reaches ${a} ?t`, '  select ?t\n'), q(`reaches ?s ${b}`, '  select ?s\n'), q(`reaches ${a} ${b}`, '  mode exists\n'), q(`reaches ${a} ${b}`, '  select\n'), q(`reaches ${a} ?t`, '  mode count\n')]) {
      const got = ct(k, query), want = orc(k, query);
      assert.equal(got.status, want.status, `${shape} ${query}`);
      assert.deepEqual(rowSet(got), rowSet(want), `${shape} ${query}`);
      assert.equal(got.count, want.count);
      assert.equal(got.bound, want.bound);
      compared++;
      if (got.status === 'supported' && got.used.length) {
        const rep = replayUsed(k, got.used, query);
        assert.equal(rep.status, got.status, 'used replays to the same status');
        assert.deepEqual(rowSet(rep), rowSet(got), 'used replays to the same rows');
        replayed++;
      }
    }
  }
  assert.ok(compared >= 600 && replayed > 100);
});

test('the template is a native search: probes grow with the reachable part, not with the whole graph', () => {
  const comps = Array.from({length: 200}, (_, c) => [[`c${c}a`, `c${c}b`], [`c${c}b`, `c${c}c`]]).flat();
  const k = kb(comps);
  const r = ct(k, q('reaches c7a ?t', '  select ?t\n'));
  assert.equal(r.rows.length, 2);
  assert.ok(r.budget.used.maxJoins <= 4, 'only the component of the start node is visited');
});
