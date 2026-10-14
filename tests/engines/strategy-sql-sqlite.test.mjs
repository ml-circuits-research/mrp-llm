import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {ask, sqlSqlite, capabilities, available, NotExpressibleError, ProgramError} from '../../reasoning/strategies/sql-sqlite/index.mjs';
import {askBank, bankBackend} from '../../reasoning/strategies/sql-sqlite/bank.mjs';
import {ask as oracle} from '../../reasoning/strategies/js-reference/index.mjs';
import {runSeed, usedReplayProblem} from '../../tools/eval/engines/sql-sqlite-fuzz.mjs';
import {cases} from '../../tools/eval/engines/sql-sqlite-cases.mjs';
import {SQLiteBank} from '../../memory/banks/sqlite.mjs';
import {SimpleSQLiteMemory} from '../../memory/sqlite-simple.mjs';

const run = (knowledge, query, budget = {}, options = {}) => ask({theory: {knowledge}, query}, budget, options);
const ref = (knowledge, query) => oracle({theory: {knowledge}, query});
const rowsOf = r => (r.rows ?? []).map(x => JSON.stringify(Object.entries(x).sort())).sort();
const view = r => JSON.stringify({status: r.status, complete: r.complete, rows: r.rows ? rowsOf(r) : undefined, count: r.count, bound: r.bound, reason: r.reason});
/** The strategy and the oracle must give the same answer on a circuit. */
const same = (knowledge, query, options = {}) => {
  const a = run(knowledge, query, {}, options), b = ref(knowledge, query);
  assert.equal(view(a), view(b), `sql-sqlite ${view(a)} differs from the oracle ${view(b)}`);
  return a;
};
const facts = (lines, id = 'f') => lines.map((l, i) => `@${id}${i} fact\n  holds ${l}\n`).join('');
const sel = (where, select) => `@q query\n  where ${where}\n  select ${select}\n`;
const chain = (n, extra = '') => `@edge predicate\n  args source:entity destination:entity\n  closed true\n` + facts(Array.from({length: n}, (_, i) => `edge n${i} n${i + 1}`), 'e') + extra;
const LEFT = '@r1 rule\n  when edge ?x ?y\n  then path ?x ?y\n@r2 rule\n  when path ?x ?y\n  when edge ?y ?z\n  then path ?x ?z\n';
const RIGHT = '@r1 rule\n  when edge ?x ?y\n  then path ?x ?y\n@r2 rule\n  when edge ?x ?m\n  when path ?m ?y\n  then path ?x ?y\n';
const NONLINEAR = '@r1 rule\n  when edge ?x ?y\n  then path ?x ?y\n@r2 rule\n  when path ?x ?y\n  when path ?y ?z\n  then path ?x ?z\n';

// ------------------------------------------------------------------------------------------------------ contract

test('contract: a capability declaration, availability, packet fields and routing', async () => {
  assert.equal(capabilities.id, 'sql-sqlite');
  assert.equal(capabilities.guarantee, 'exact');
  assert.equal(capabilities.delivery, 'slice');
  assert.ok(capabilities.features.includes('recursion') && capabilities.features.includes('aggregate') && capabilities.features.includes('interval'));
  assert.ok(capabilities.notExpressible.includes('plan') && capabilities.notExpressible.includes('why_not') && capabilities.notExpressible.includes('constraint'));
  assert.deepEqual(capabilities.budgetKeys.sort(), ['maxFacts', 'maxJoins', 'maxRounds', 'timeoutMs']);
  assert.equal((await available()).ok, true);
  assert.equal(sqlSqlite.ask, ask);
  const r = ask({theory: {knowledge: facts(['p a'])}, query: sel('p ?x', '?x'), requested: 'sql-sqlite'});
  assert.equal(r.route.chosen, 'sql-sqlite');
  assert.equal(r.route.fallback, null);
  assert.equal(r.route.requested, 'sql-sqlite');
  assert.equal(r.strategy, 'sql-sqlite');
  assert.equal(r.guarantee, 'exact');
  assert.deepEqual(r.rows, [{x: 'a'}]);
  assert.ok('budget' in r && 'retrieval' in r && 'sensitivity' in r && 'timings' in r);
});

test('a circuit that needs a feature the strategy does not declare is not_expressible, never weakened', () => {
  const k = facts(['p a']);
  for (const [query, feature] of [['@q query\n  mode plan\n  where p a\n', 'plan'], ['@q query\n  mode why_not\n  where p b\n', 'why_not'], ['@q query\n  mode abduce\n  where p b\n', 'abduce'],
    ['@q query\n  mode conform\n  where p a\n', 'check_plan'], ['@c constraint\n  var ?x int 0 5\n  require ?x equal 3\n  task prove\n  claim ?x equal 3\n', 'constraint']]) {
    assert.throws(() => run(k, query), e => e instanceof NotExpressibleError && e.features.includes(feature), feature);
  }
  assert.throws(() => run(k, '@p policy\n  procedures true\n@q query\n  where p a\n  policy $p\n'), NotExpressibleError);
});

// ----------------------------------------------------------------------------------------------- evidence and naf

test('four-valued evidence: both is a reported status and nothing else follows from it', () => {
  const k = facts(['bird tweety', 'not flies tweety']) + '@r1 rule\n  when bird ?x\n  then flies ?x\n@r2 rule\n  when flies ?x\n  then can_glide ?x\n@r3 rule\n  when not flies ?x\n  then grounded ?x\n';
  for (const where of ['flies tweety', 'can_glide tweety', 'grounded tweety', 'flies pingu']) same(k, `@q query\n  mode exists\n  where ${where}\n`);
  assert.equal(run(k, '@q query\n  mode exists\n  where flies tweety\n').status, 'both');
  assert.equal(run(k, '@q query\n  mode exists\n  where flies pingu\n').status, 'unknown');
  same(facts(['bird tweety']) + '@r1 rule\n  when bird ?x\n  then flies ?x\n', sel('flies ?x', '?x'));
  same(facts(['bird tweety', 'not flies tweety']) + '@r1 rule\n  when bird ?x\n  then flies ?x\n', sel('flies ?x', '?x'));
});

test('negation as failure: absent needs a closed predicate, the program must be stratified, both errors as the oracle', () => {
  const open = '@r rule\n  when node ?x\n  when absent blocked ?x\n  then free ?x\n';
  assert.throws(() => run(facts(['node a']) + open, sel('free ?x', '?x')), e => e instanceof ProgramError && e.code === 'absent_needs_closed');
  const cyc = '@blocked predicate\n  args subject:entity\n  closed true\n@r1 rule\n  when node ?x\n  when absent blocked ?x\n  then blocked ?x\n';
  assert.throws(() => run(facts(['node a']) + cyc, sel('blocked ?x', '?x')), e => e instanceof ProgramError && e.code === 'not_stratifiable');
  const closed = '@blocked predicate\n  args subject:entity\n  closed true\n@node predicate\n  args subject:entity\n  closed true\n@free predicate\n  args subject:entity\n  closed true\n' + facts(['node a', 'node b', 'node c', 'blocked b']) + open;
  const r = same(closed, sel('free ?x', '?x'));
  assert.deepEqual(rowsOf(r), ['[["x","a"]]', '[["x","c"]]']);
  same(closed, '@q query\n  where absent free b\n');
  same(closed, '@q query\n  where free ?x\n  where absent blocked ?x\n  select ?x\n');
});

// --------------------------------------------------------------------------------------------------- recursion

test('linear recursion is one recursive CTE, nonlinear and mutual recursion are semi-naive loops, and all agree with the oracle on a cyclic graph', () => {
  const cyc = chain(6) + facts(['edge n6 n2', 'edge n6 q0']);
  const q = sel('path n0 ?t', '?t');
  for (const rules of [LEFT, RIGHT, NONLINEAR]) for (const recursion of ['auto', 'cte', 'loop']) same(cyc + rules, q, {recursion});
  assert.deepEqual(run(cyc + LEFT, q).sql.strata, ['cte']);
  assert.deepEqual(run(cyc + RIGHT, q).sql.strata, ['cte']);
  assert.deepEqual(run(cyc + NONLINEAR, q).sql.strata, ['loop'], 'two recursive atoms cannot be a recursive CTE: the loop runs it');
  assert.deepEqual(run(cyc + LEFT, q, {}, {recursion: 'loop'}).sql.strata, ['loop']);
  const mutual = cyc + '@s1 rule\n  when edge n0 ?x\n  then p ?x\n@s2 rule\n  when p ?x\n  then q ?x\n@s3 rule\n  when q ?x\n  when edge ?x ?y\n  then p ?y\n';
  const m = same(mutual, sel('p ?x', '?x'));
  assert.ok(m.sql.strata.includes('loop') && m.rows.length > 3, 'mutual recursion is expressible through the loop');
  same(mutual, sel('q ?x', '?x'), {recursion: 'loop'});
});

test('value forms run after recursive SQL joins before projection, preserving numeric strings, exclusions and ties', () => {
  const k = chain(5) + LEFT + facts(['value n1 8', 'value n2 "10 units"', 'value n3 10', 'value n4 2', 'value n5 1']);
  const q = '@q query\n  where path n0 ?x\n  where value ?x ?v\n  select ?x\n';
  const best = same(k, q + '  rank highest ?v\n');
  assert.deepEqual(best.rows, [{x: 'n2'}, {x: 'n3'}]);
  assert.equal(best.sensitivity.monotone, false);
  assert.equal(best.used_incomplete, true);
  assert.deepEqual(same(k, q + '  except ?x n2\n  rank highest ?v\n').rows, [{x: 'n3'}]);
  assert.deepEqual(same(k, q + '  compare ?v above 8\n  rank highest ?v position 2\n').rows, []);
  assert.deepEqual(same(k, q + '  rank highest ?v top 2\n  limit 1\n').rows, [{x: 'n1'}]);
  const count = same(k, q.replace('select ?x', 'mode count\n  select ?x') + '  compare ?v above 8\n');
  assert.equal(count.count, 2);
  assert.equal(count.bound, 'at_least');
});

test('a numeric comparison over known rows refutes exists; nonnumeric values remain not_computable', () => {
  const q = '@q query\n  mode exists\n  where value a ?v\n  compare ?v above 10\n';
  assert.equal(same(facts(['value a 5']), q).status, 'refuted');
  assert.equal(same(facts(['value a unknown']), q).status, 'not_computable');
});

test('a recursive ranking cut cannot expose a partial winner as a complete answer', () => {
  const k = chain(12) + LEFT + facts(['value n1 1', 'value n12 99']);
  const query = '@q query\n  where path n0 ?x\n  where value ?x ?v\n  select ?x\n  rank highest ?v\n';
  const cut = run(k, query, {maxRounds: 2});
  assert.equal(cut.status, 'budget_exhausted');
  assert.equal(cut.complete, false);
  assert.equal(cut.rows, undefined);
});

test('a tightened maxRounds runs the stratum as a counted loop: a partial positive answer is a subset of the truth, a count is budget_exhausted', () => {
  const k = chain(12) + LEFT;
  const full = new Set(rowsOf(run(k, sel('path n0 ?t', '?t'))));
  const policy = '@p policy\n  maxRounds 3\n';
  const r = run(k, policy + '@q query\n  where path n0 ?t\n  select ?t\n  policy $p\n');
  assert.equal(r.status, 'supported');
  assert.equal(r.complete, false);
  assert.equal(r.reason, 'rounds');
  assert.equal(r.budget.exhausted, true);
  assert.deepEqual(r.sql.strata, ['loop']);
  assert.ok(r.rows.length >= 1 && r.rows.length < full.size && rowsOf(r).every(x => full.has(x)), 'rows are sound and fewer than the full answer');
  const c = run(k, policy + '@q query\n  mode count\n  where path ?x ?y\n  select ?x ?y\n  policy $p\n');
  assert.equal(c.status, 'budget_exhausted');
  assert.equal(c.complete, false);
  assert.equal(c.reason, 'rounds');
  const u = run(k, '@p policy\n  maxRounds 2\n@q query\n  mode exists\n  where path n0 n12\n  policy $p\n');
  assert.ok(u.status === 'budget_exhausted' || u.status === 'supported', 'a cut is never read as a negative answer');
  assert.notEqual(u.status, 'unknown');
  assert.notEqual(u.status, 'refuted');
});

test('depth 1,000: the chain is closed by one recursive CTE and by the loop, the oracle agrees on smaller sizes', () => {
  const n = 1000;
  const k = chain(n) + '@r1 rule\n  when edge ?x ?y\n  then reach ?x ?y\n@r2 rule\n  when reach ?x ?m\n  when edge ?m ?y\n  then reach ?x ?y\n';
  for (const recursion of ['cte', 'loop']) {
    const r = run(k, '@q query\n  mode count\n  where reach n0 ?t\n  select ?t\n', {}, {recursion, provenance: false});
    assert.equal(r.status, 'supported');
    assert.equal(r.complete, true);
    assert.equal(r.count, n);
  }
  const deep = run(k, '@q query\n  mode exists\n  where reach n0 n1000\n', {}, {recursion: 'loop'});
  assert.equal(deep.status, 'supported');
  assert.equal(deep.used.length > 900, true, 'the support of the deepest tuple is the whole chain');
  assert.equal(deep.used_incomplete, undefined);
  const small = 60;
  const ks = chain(small) + '@r1 rule\n  when start ?x\n  then visited ?x\n@r2 rule\n  when visited ?x\n  when edge ?x ?y\n  then visited ?y\n' + facts(['start n0']);
  same(ks, sel('visited ?t', '?t'));
});

test('the cycle does not make a tuple justify itself: used replays in the oracle on a graph full of cycles', () => {
  const k = chain(5) + facts(['edge n5 n0', 'edge n3 n1', 'edge n5 n5']) + LEFT;
  for (const recursion of ['cte', 'loop']) {
    const r = run(k, '@q query\n  mode exists\n  where path n2 n2\n', {}, {recursion});
    assert.equal(r.status, 'supported');
    assert.equal(r.used_incomplete, undefined);
    assert.equal(usedReplayProblem(k, '@q query\n  mode exists\n  where path n2 n2\n', r), null);
    const all = run(k, sel('path ?x ?y', '?x ?y'), {}, {recursion});
    assert.equal(usedReplayProblem(k, sel('path ?x ?y', '?x ?y'), all), null);
  }
});

test('demand: a bound argument that the linear step keeps seeds the CTE with the query constants; otherwise the closure is full; the answers are the oracle\'s', () => {
  const edges = facts(['edge a b', 'edge b c', 'edge c a', 'edge c d', 'edge x y', 'edge y z', 'edge z x', 'edge d d'], 'e');
  const decl = '@edge predicate\n  args source:entity destination:entity\n  closed true\n@path predicate\n  args source:entity destination:entity\n  closed true\n';
  const k = rules => decl + edges + rules;
  const asked = (rules, query) => { const r = run(k(rules), query); assert.equal(view(r), view(ref(k(rules), query)), query); return r; };
  // left-linear keeps position 0: a bound first argument is demanded
  assert.deepEqual(asked(LEFT, sel('path a ?t', '?t')).sql.demand, ['path/2: c0 = "a"']);
  assert.equal(asked(LEFT, '@q query\n  mode count\n  where path a ?t\n  select ?t\n').sql.demand?.length, 1);
  asked(LEFT, '@q query\n  mode exists\n  where path a d\n');
  asked(LEFT, '@q query\n  mode explain\n  where path a d\n');
  asked(LEFT, sel('path x ?t', '?t'));
  asked(LEFT, sel('path q ?t', '?t'));
  asked(LEFT, '@q query\n  mode exists\n  where path q a\n');
  // right-linear keeps position 1
  assert.deepEqual(asked(RIGHT, sel('path ?s d', '?s')).sql.demand, ['path/2: c1 = "d"']);
  assert.equal(asked(RIGHT, sel('path a ?t', '?t')).sql.demand, undefined, 'position 0 changes at every step: no demand');
  // two bound positions keep only the preserved one
  assert.deepEqual(asked(LEFT, '@q query\n  mode exists\n  where path a a\n').sql.demand, ['path/2: c0 = "a"']);
  // other readers of the relation switch the demand off
  const other = LEFT + '@r3 rule\n  when path ?x ?y\n  then known ?x\n';
  assert.equal(asked(other, sel('path a ?t', '?t')).sql.demand?.length, 1, 'a rule outside the dependency slice of the query does not read the relation');
  assert.equal(asked(other, '@q query\n  where path a ?t\n  where known ?x\n  select ?t ?x\n').sql.demand, undefined, 'a rule inside the slice that reads path needs all of it');
  assert.equal(asked(other, sel('known ?x', '?x')).sql.demand, undefined);
  const agg = LEFT + '@a aggregate\n  over path ?x ?y\n  group ?x\n  count as ?n\n  yields reach_count ?x ?n\n';
  assert.equal(asked(agg, '@q query\n  where path a ?t\n  where reach_count ?x ?n\n  select ?t ?n\n').sql.demand, undefined);
  asked(agg, sel('reach_count ?x ?n', '?x ?n'));
  // two query atoms with different constants need two slices of the relation: no demand
  assert.equal(asked(LEFT, '@q query\n  where path a ?m\n  where path ?m d\n  select ?m\n').sql.demand, undefined);
  assert.equal(asked(LEFT, '@q query\n  where path a ?m\n  where path a ?m\n  select ?m\n').sql.demand?.length, 1);
  // an unbound query, a nonlinear closure and the loop run in full
  assert.equal(asked(LEFT, sel('path ?x ?y', '?x ?y')).sql.demand, undefined);
  assert.equal(asked(NONLINEAR, sel('path a ?t', '?t')).sql.demand, undefined);
  assert.equal(run(k(LEFT), sel('path a ?t', '?t'), {}, {recursion: 'loop'}).sql.demand, undefined);
  assert.equal(run(k(LEFT), sel('path a ?t', '?t'), {}, {demand: false}).sql.demand, undefined);
  // base facts of the recursive relation itself and a constant head in a base rule
  const seeded = decl + edges + facts(['path q r', 'path a a'], 'p') + LEFT + '@r4 rule\n  when edge ?x ?y\n  then path ?x r\n';
  for (const q of [sel('path a ?t', '?t'), sel('path q ?t', '?t'), sel('path x ?t', '?t')]) assert.equal(view(run(seeded, q)), view(ref(seeded, q)), q);
});

test('demand: 150 random graphs, left and right linear closures, every bound pattern, answers and used equal to the oracle', () => {
  let state = 12345;
  const rnd = n => { state = (Math.imul(state, 1103515245) + 12345) >>> 0; return (state >>> 8) % n; };
  const names = ['a', 'b', 'c', 'd', 'e', 'f'];
  const decl = '@edge predicate\n  args source:entity destination:entity\n  closed true\n@path predicate\n  args source:entity destination:entity\n  closed true\n';
  let demanded = 0;
  for (let g = 0; g < 150; g++) {
    const es = new Set();
    for (let i = 0, m = 3 + rnd(9); i < m; i++) es.add(`edge ${names[rnd(6)]} ${names[rnd(6)]}`);
    const extra = rnd(3) === 0 ? facts([`path ${names[rnd(6)]} ${names[rnd(6)]}`], 'p') : '';
    for (const rules of [LEFT, RIGHT]) {
      const k = decl + facts([...es], 'e') + extra + rules;
      for (const q of [sel(`path ${names[rnd(6)]} ?t`, '?t'), sel(`path ?s ${names[rnd(6)]}`, '?s'), `@q query\n  mode exists\n  where path ${names[rnd(6)]} ${names[rnd(6)]}\n`, `@q query\n  mode count\n  where path ${names[rnd(6)]} ?t\n  select ?t\n`, `@q query\n  mode explain\n  where path ${names[rnd(6)]} ?t\n`]) {
        const a = run(k, q), b = ref(k, q);
        assert.equal(view(a), view(b), `${q}\n${k}`);
        assert.equal(usedReplayProblem(k, q, a), null, q);
        if (a.sql.demand) demanded++;
      }
    }
  }
  assert.ok(demanded > 100, `demand applied in ${demanded} runs`);
});

test('demand makes a bound closure walk one component: a 10,000-edge graph of rings is answered from the chain only', () => {
  const rings = [];
  for (let r = 0; r < 200; r++) for (let i = 0; i < 50; i++) rings.push(`edge k${r}_${i} k${r}_${(i + 1) % 50}`);
  const chainEdges = Array.from({length: 6}, (_, i) => `edge c${i} c${i + 1}`);
  const k = '@edge predicate\n  args source:entity destination:entity\n  closed true\n@path predicate\n  args source:entity destination:entity\n  closed true\n' + facts([...chainEdges, ...rings], 'e') + LEFT;
  const t = performance.now();
  const r = run(k, sel('path c0 ?t', '?t'));
  assert.equal(r.rows.length, 6);
  assert.ok(r.budget.used.maxFacts < 100, `only the chain was derived (${r.budget.used.maxFacts} tuples), not 200 rings of 2,500 pairs`);
  assert.ok(performance.now() - t < 5000);
  assert.equal(usedReplayProblem(k, sel('path c0 ?t', '?t'), r), null);
  const full = run(k, sel('path k3_4 ?t', '?t'));
  assert.equal(full.rows.length, 50);
  assert.ok(full.budget.used.maxFacts < 100);
});

// -------------------------------------------------------------------------------------------- arithmetic and compare

test('compute: integer division truncates toward zero, a zero divisor or an overflow makes the body false and is noted', () => {
  const k = facts(['v a 7', 'v b -7', 'v c 0', 'v d 9007199254740991', 'w a 2', 'w b 2', 'w c 0', 'w d 1']) +
    '@r1 rule\n  when v ?x ?n\n  when w ?x ?m\n  when compute ?q ?n whole_divided_by ?m\n  then quo ?x ?q\n' +
    '@r2 rule\n  when v ?x ?n\n  when compute ?s ?n plus 1\n  then succ ?x ?s\n' +
    '@r3 rule\n  when v ?x ?n\n  when compute ?t ?n times ?n\n  then sq ?x ?t\n';
  const quo = same(k, sel('quo ?x ?q', '?x ?q'));
  assert.deepEqual(rowsOf(quo), ['[["q",-3],["x","b"]]', '[["q",3],["x","a"]]', '[["q",9007199254740991],["x","d"]]'], '7/2 is 3, -7/2 is -3, 0/0 is undefined and gives no row');
  assert.equal(run(k, sel('quo ?x ?q', '?x ?q')).notes.includes('arithmetic_undefined'), true);
  const succ = same(k, sel('succ ?x ?s', '?x ?s'));
  assert.equal(succ.rows.some(r => r.x === 'd'), false, 'the successor of the largest safe integer is not an integer of the language');
  const sq = same(k, sel('sq ?x ?t', '?x ?t'));
  assert.equal(sq.rows.some(r => r.x === 'd'), false);
  assert.equal(sq.rows.find(r => r.x === 'b').t, 49);
});

test('compute and compare ignore text operands exactly as the oracle: an ordering needs integers or times, an integer never equals a string', () => {
  const k = facts(['v a 1', 'v b "1"', 'v c one', 'v d "2024-01-02"', 'v e "2024-01-02T00:00:00Z"']) +
    '@r1 rule\n  when v ?x ?n\n  when compute ?m ?n plus 1\n  then inc ?x ?m\n' +
    '@r2 rule\n  when v ?x ?n\n  when compare ?n above 0\n  then pos ?x\n' +
    '@r3 rule\n  when v ?x ?n\n  when v ?y ?m\n  when compare ?n equal ?m\n  when compare ?x not_equal ?y\n  then twin ?x ?y\n' +
    '@r4 rule\n  when v ?x ?n\n  when compare ?n above "2023-12-31"\n  then recent ?x\n';
  for (const p of ['inc ?x ?m', 'pos ?x', 'twin ?x ?y', 'recent ?x']) same(k, sel(p, p.split(' ').filter(t => t.startsWith('?')).join(' ')));
  assert.deepEqual(rowsOf(run(k, sel('twin ?x ?y', '?x ?y'))), ['[["x","d"],["y","e"]]', '[["x","e"],["y","d"]]'], 'two spellings of one instant are equal');
  assert.deepEqual(rowsOf(run(k, sel('inc ?x ?m', '?x ?m'))), ['[["m",2],["x","a"]]']);
});

test('text values: quotes, unicode, SQL-looking text and the symbol or quoted-text identity', () => {
  const k = facts(['p "O\'Brien"', 'p "x\'); DROP TABLE p; --"', 'p "Zürich"', 'p "ünï cödé 日本語"', 'p plain', 'p "plain"', 'q 1', 'q "1"']);
  const r = same(k, sel('p ?x', '?x'));
  assert.equal(r.rows.length, 5, 'plain and "plain" are the same value');
  assert.ok(r.rows.some(x => x.x === "O'Brien") && r.rows.some(x => x.x.includes('DROP TABLE')));
  same(k, sel('q ?x', '?x'));
  assert.equal(run(k, sel('q ?x', '?x')).rows.length, 2, '1 and "1" stay apart');
  assert.equal(run(k, '@q query\n  mode exists\n  where q 1\n').status, 'supported');
  const nul = facts(['p "a\\u0000b"', 'p "ab"']);
  assert.throws(() => run(nul, sel('p ?x', '?x')), NotExpressibleError, 'a NUL character would be cut by SQLite: the strategy refuses it, never answers a different value');
  assert.throws(() => run(facts(['p ab']), '@q query\n  mode exists\n  where p "a\\u0000b"\n'), NotExpressibleError);
});

// ------------------------------------------------------------------------------------------- aggregates, count, every

test('aggregate: set semantics over the distinct bindings, count, sum, min, max and collect, as the oracle', () => {
  const k = '@s predicate\n  args subject:entity topic:entity object:integer\n  closed true\n' + facts(['s ann dev 100', 's bob dev 100', 's cy dev 90', 's di ops 80', 's ed ops 95', 's fy ops 95', 's gu ops 95']) +
    '@a1 aggregate\n  over s ?p ?d ?v\n  group ?d\n  count as ?n\n  yields n_of ?d ?n\n' +
    '@a2 aggregate\n  over s ?p ?d ?v\n  group ?d\n  sum ?v as ?t\n  yields t_of ?d ?t\n' +
    '@a3 aggregate\n  over s ?p ?d ?v\n  group ?d\n  min ?v as ?t\n  yields lo_of ?d ?t\n' +
    '@a4 aggregate\n  over s ?p ?d ?v\n  group ?d\n  max ?v as ?t\n  yields hi_of ?d ?t\n' +
    '@a5 aggregate\n  over s ?p ?d ?v\n  group ?d\n  collect ?v as ?t\n  yields vals_of ?d ?t\n' +
    '@a6 aggregate\n  over s ?p ?d ?v\n  count as ?n\n  yields total ?n\n';
  for (const [p, vars] of [['n_of', '?d ?n'], ['t_of', '?d ?t'], ['lo_of', '?d ?t'], ['hi_of', '?d ?t'], ['vals_of', '?d ?t'], ['total', '?n']]) same(k, sel(`${p} ${vars}`, vars));
  assert.deepEqual(rowsOf(run(k, sel('t_of ?d ?t', '?d ?t'))), ['[["d","dev"],["t",290]]', '[["d","ops"],["t",365]]']);
  assert.deepEqual(rowsOf(run(k, sel('vals_of ?d ?t', '?d ?t'))), ['[["d","dev"],["t","[90,100]"]]', '[["d","ops"],["t","[80,95]"]]'], 'collect is a sorted JSON array of the distinct values');
  assert.deepEqual(run(k, sel('total ?n', '?n')).rows, [{n: 7}], 'two people with the same salary count twice: the person is in the group');
  const none = '@s predicate\n  args subject:entity object:integer\n  closed true\n@a aggregate\n  over s ?p ?v\n  count as ?n\n  yields total ?n\n';
  assert.deepEqual(run(none, sel('total ?n', '?n')).rows, [], 'no row, no group, no tuple (an empty aggregate yields nothing)');
  same(none, sel('total ?n', '?n'));
});

test('an aggregate over text ignores the non-integers and says so', () => {
  const k = facts(['s a 1', 's b 2', 's c x']) + '@a aggregate\n  over s ?p ?v\n  sum ?v as ?t\n  yields total ?t\n';
  const r = same(k, sel('total ?t', '?t'));
  assert.deepEqual(r.rows, [{t: 3}]);
  assert.ok(r.notes.includes('aggregate_non_integer_ignored'));
});

test('count, exists and every over open and closed predicates: lower bounds, open domains, counterexamples', () => {
  const open = facts(['p a', 'p b', 'q a']);
  const closed = '@p predicate\n  args subject:entity\n  closed true\n@q predicate\n  args subject:entity\n  closed true\n' + open;
  const count = '@q query\n  mode count\n  where p ?x\n  select ?x\n';
  assert.equal(same(open, count).bound, 'at_least');
  assert.equal(same(closed, count).bound, undefined);
  assert.equal(same(closed, count).count, 2);
  const every = '@q query\n  mode every\n  where p ?x\n  scope q ?x\n';
  const closedDomain = '@p predicate\n  args subject:entity\n  closed true\n' + open;
  assert.equal(same(open, every).status, 'unknown');
  assert.equal(run(open, every).reason, 'open_domain');
  assert.equal(same(closedDomain, every).status, 'unknown');
  assert.equal(run(closedDomain, every).reason, 'scope_unknown', 'an open scope predicate cannot refute b');
  assert.equal(same(closed, every).status, 'refuted', 'with q closed, b has no q: a counterexample');
  assert.equal(same(closed + facts(['q b'], 'g'), every).status, 'supported');
  assert.equal(same(closedDomain + facts(['not q b'], 'g'), every).status, 'refuted');
  same(closed, '@q query\n  mode exists\n  where p ?x\n  where q ?x\n');
  same(closed, '@q query\n  mode exists\n  where p c\n');
  assert.equal(run(closed, '@q query\n  mode exists\n  where p c\n').status, 'refuted', 'a ground atom of a closed predicate that is not stored is refuted');
});

test('time: a point query, an interval throughout and overlapping, and start_of or end_of, as the oracle', () => {
  const k = '@a fact\n  holds on lamp\n  valid 2026-01-01 2026-03-01\n@b fact\n  holds on lamp\n  valid 2026-03-01 2026-06-01\n@c fact\n  holds on desk\n  valid 2026-02-01 2026-04-01\n' +
    '@r1 rule\n  when on ?x\n  then lit ?x\n@r2 rule\n  when on ?x\n  when start_of ?s on ?x\n  when end_of ?e on ?x\n  then span ?x ?s ?e\n';
  for (const q of ['at 2026-02-15\n  where lit ?x\n  select ?x', 'at 2026-05-01\n  where lit ?x\n  select ?x', 'during 2026-01-15 2026-02-15\n  where lit ?x\n  select ?x', 'during 2026-02-10 2026-02-20\n  where lit ?x\n  select ?x',
    'during 2026-02-15 2026-03-15\n  where lit ?x\n  select ?x', 'overlaps 2026-02-15 2026-03-15\n  where lit ?x\n  select ?x', 'overlaps 2026-01-01 2026-12-31\n  where lit ?x\n  select ?x', 'where span ?x ?s ?e\n  select ?x ?s ?e']) same(k, '@q query\n  ' + q + '\n');
  same(k, '@q query\n  during 2026-02-10 2026-02-20\n  mode count\n  where lit ?x\n  select ?x\n');
  const xs = q => run(k, '@q query\n  ' + q + '\n').rows.map(r => r.x).sort();
  assert.deepEqual(xs('at 2026-05-01\n  where lit ?x\n  select ?x'), ['lamp']);
  assert.deepEqual(xs('during 2026-01-15 2026-02-15\n  where lit ?x\n  select ?x'), ['lamp'], 'the desk starts on 02-01: not throughout');
  assert.deepEqual(xs('during 2026-02-15 2026-03-15\n  where lit ?x\n  select ?x'), ['desk', 'lamp'], 'lamp is on at every instant: its two facts meet on 03-01');
  assert.deepEqual(xs('overlaps 2026-04-15 2026-05-15\n  where lit ?x\n  select ?x'), ['lamp']);
  assert.deepEqual(run(k, '@q query\n  where span lamp ?s ?e\n  select ?s ?e\n').rows.map(r => `${r.s}..${r.e}`).sort(), ['2026-01-01..2026-03-01', '2026-01-01..2026-06-01', '2026-03-01..2026-03-01', '2026-03-01..2026-06-01'],
    'start_of and end_of are independent leaves: every start of a stored fact of lamp meets every end');
});

// -------------------------------------------------------------------------------------------------------- budgets

test('budgets: probe, fact and time ceilings are budget_exhausted, never unknown, refuted or a silent short list', () => {
  const n = 800;
  const k = '@n predicate\n  args subject:entity\n  closed true\n' + facts(Array.from({length: n}, (_, i) => `n i${i}`)) + '@r rule\n  when n ?x\n  when n ?y\n  then pair ?x ?y\n';
  const full = run(k, '@q query\n  mode count\n  where pair ?x ?y\n  select ?x ?y\n', {}, {provenance: false});
  assert.equal(full.count, n * n);
  for (const [limits, reason] of [[{maxJoins: 1000}, 'probes'], [{maxFacts: 500}, 'facts'], [{timeoutMs: 20}, 'wall']]) {
    const r = run(k, '@q query\n  mode count\n  where pair ?x ?y\n  select ?x ?y\n', limits, {provenance: false});
    assert.equal(r.status, 'budget_exhausted', JSON.stringify(limits));
    assert.equal(r.complete, false);
    assert.equal(r.reason, reason);
    assert.equal(r.budget.exhausted, true);
    const e = run(k, '@q query\n  mode exists\n  where pair i1 i2\n', limits, {provenance: false});
    assert.ok(e.status === 'budget_exhausted' || e.status === 'supported', `${JSON.stringify(limits)} gave ${e.status}`);
    const sel2 = run(k, sel('pair i1 ?y', '?y'), limits, {provenance: false});
    if (sel2.status === 'supported') assert.equal(sel2.complete, false);
    else assert.equal(sel2.status, 'budget_exhausted');
  }
  const hit = run(k, '@p policy\n  maxJoins 50\n@q query\n  where pair ?x ?y\n  select ?x ?y\n  policy $p\n');
  assert.equal(hit.complete, false);
  assert.ok(!hit.rows || hit.rows.length <= n * n);
});

test('a statement that explodes is stopped inside SQLite by the tick function (the statement timeout), the connection stays usable', () => {
  const k = '@n predicate\n  args subject:entity\n  closed true\n' + facts(Array.from({length: 3000}, (_, i) => `n i${i}`)) + '@r rule\n  when n ?x\n  when n ?y\n  when n ?z\n  then triple ?x ?y ?z\n';
  const t = performance.now();
  const r = run(k, '@q query\n  mode exists\n  where triple i1 i2 i3\n', {timeoutMs: 100, maxJoins: 5_000_000}, {provenance: false});
  assert.equal(r.status, 'budget_exhausted');
  assert.ok(performance.now() - t < 5000, 'a 27-billion-row join is cut after the ceiling');
  assert.ok(['probes', 'wall'].includes(r.reason));
});

// ------------------------------------------------------------------------------------------------ used and explain

test('used: one sufficient support set that replays in the oracle; used_incomplete when the proof rests on absence, a count or an every', () => {
  const k = facts(['parent ann bob', 'parent bob cy', 'parent bob di', 'parent cy eve', 'pet ann rex']) + '@r1 rule\n  when parent ?x ?y\n  then anc ?x ?y\n@r2 rule\n  when parent ?x ?m\n  when anc ?m ?y\n  then anc ?x ?y\n';
  for (const q of ['@q query\n  mode exists\n  where anc ann eve\n', sel('anc ann ?t', '?t'), '@q query\n  mode explain\n  where anc ann di\n']) {
    const r = run(k, q);
    assert.equal(r.status, 'supported');
    assert.ok(r.used.length >= 3 && !r.used.some(u => u.id === 'f4'), 'the unrelated fact is not used');
    assert.equal(usedReplayProblem(k, q, r), null);
  }
  const closed = '@blocked predicate\n  args subject:entity\n  closed true\n@node predicate\n  args subject:entity\n  closed true\n' + facts(['node a', 'node b', 'blocked b']) + '@r rule\n  when node ?x\n  when absent blocked ?x\n  then free ?x\n';
  assert.equal(run(closed, '@q query\n  mode exists\n  where free a\n').used_incomplete, true, 'the absence of blocked a cannot be named as a claim');
  assert.equal(run(closed, '@q query\n  mode count\n  where node ?x\n  select ?x\n').used_incomplete, true);
  assert.equal(run(closed, '@q query\n  mode every\n  where node ?x\n  scope node ?x\n').used_incomplete, true);
  assert.equal(run(closed, '@q query\n  mode exists\n  where not blocked a\n').status, 'unknown');
  assert.equal(run(closed, '@q query\n  mode exists\n  where not blocked b\n').status, 'refuted', 'blocked b is stored: its negation cannot hold');
  const refuted = run(facts(['not flies pingu']), '@q query\n  mode exists\n  where flies pingu\n');
  assert.equal(refuted.status, 'refuted');
  assert.deepEqual(refuted.used.map(u => u.id), ['f0']);
});

test('used covers both sides of a both answer, the aggregate members and the default that fired', () => {
  const both = facts(['bird tweety', 'not flies tweety']) + '@r1 rule\n  when bird ?x\n  then flies ?x\n';
  const rb = run(both, '@q query\n  mode exists\n  where flies tweety\n');
  assert.equal(rb.status, 'both');
  assert.equal(usedReplayProblem(both, '@q query\n  mode exists\n  where flies tweety\n', rb), null);
  assert.ok(rb.used.some(u => u.id === 'f1'), 'the negative fact is part of the support of both');
  const agg = '@s predicate\n  args subject:entity object:integer\n  closed true\n' + facts(['s a 1', 's b 2', 's c 3']) + '@a aggregate\n  over s ?p ?v\n  sum ?v as ?t\n  yields total ?t\n';
  const ra = run(agg, '@q query\n  mode exists\n  where total ?t\n');
  assert.deepEqual(ra.used.map(u => u.id).sort(), ['a', 'f0', 'f1', 'f2']);
  assert.equal(usedReplayProblem(agg, '@q query\n  mode exists\n  where total ?t\n', ra), null);
  const def = facts(['bird tweety', 'bird pingu', 'penguin pingu']) + '@p predicate\n  args subject:entity\n  closed true\n@d default\n  when bird ?x\n  then flies ?x\n  except penguin ?x\n';
  const rd = run(def, '@q query\n  mode exists\n  where flies tweety\n');
  assert.equal(rd.status, 'supported');
  assert.ok(rd.used.some(u => u.id === 'd') && rd.used.some(u => u.id === 'f0'));
});

test('explain returns the proof DAG and the explanation of the oracle', () => {
  const k = facts(['parent ann bob', 'parent bob cy']) + '@r1 rule\n  when parent ?x ?y\n  then anc ?x ?y\n@r2 rule\n  when parent ?x ?m\n  when anc ?m ?y\n  then anc ?x ?y\n';
  const q = '@q query\n  mode explain\n  where anc ann cy\n';
  const a = run(k, q), b = ref(k, q);
  assert.equal(a.status, 'supported');
  assert.deepEqual(a.explain.uses.sort(), b.explain.uses.sort());
  assert.equal(a.explain.depth, b.explain.depth);
  assert.ok(a.proof.nodes.length >= 4 && a.proof.roots.length >= 1);
  assert.equal(a.proof.nodes.every(n => ['fact', 'rule', 'assumption', 'default', 'aggregate'].includes(n.kind)), true);
});

test('the host rule for per-row conditional runs around the strategy when asked', () => {
  const k = facts(['works ann alpha']) + '@s fact\n  holds works bob alpha\n  status supposed\n';
  const r = run(k, sel('works ?x alpha', '?x'), {}, {conditional: true});
  assert.deepEqual(r.conditional, ['s']);
  assert.deepEqual(r.row_conditional.find(x => x.row.x === 'bob').conditional, ['s']);
  assert.deepEqual(r.row_conditional.find(x => x.row.x === 'ann').conditional, []);
  assert.equal(run(k, sel('works ?x alpha', '?x')).conditional, undefined, 'by default the host computes it');
});

// ----------------------------------------------------------------------------------------- the same front end

test('defaults, overrides, strict contraries and integrity go through the shared desugaring and agree with the oracle', () => {
  const k = facts(['bird tweety', 'bird pingu', 'bird opus', 'penguin pingu', 'not flies opus']) + '@p predicate\n  args subject:entity\n  closed true\n' +
    '@d default\n  when bird ?x\n  then flies ?x\n  except penguin ?x\n' +
    '@i integrity\n  never all\n    penguin ?x\n    flies ?x\n  end\n  witness ?x\n  message "a penguin flies"\n';
  same(k, sel('flies ?x', '?x'));
  same(k, '@q query\n  mode exists\n  where flies opus\n');
  same(k, sel('violation ?id ?w', '?id ?w'));
  const supposed = k + '@s fact\n  holds penguin tweety\n  status supposed\n';
  same(supposed, sel('flies ?x', '?x'));
});

test('a predicate used with two arities is two relations; zero-arity atoms work; versions follow asof', () => {
  same(facts(['p a', 'p a b', 'p a b c']), sel('p ?x', '?x'));
  same(facts(['p a', 'p a b', 'p a b c']), sel('p ?x ?y', '?x ?y'));
  same(facts(['alarm', 'door open']) + '@r rule\n  when door open\n  then alarm_on\n', '@q query\n  mode exists\n  where alarm_on\n');
  const gov = '@v1 rule\n  when a ?x\n  then b ?x\n  version 1\n  approval superseded\n  approved_by "o"\n  approved_at 2025-01-01\n@v2 rule\n  when a ?x\n  then c ?x\n  version 2\n  supersedes $v1\n  approval approved\n  approved_by "o"\n  approved_at 2026-06-01\n' + facts(['a z']);
  same(gov, sel('c ?x', '?x'));
  same(gov, '@q query\n  asof 2026-01-01\n  where b ?x\n  select ?x\n');
});

// ----------------------------------------------------------------------------------------------- shadow gate

test('differential fuzz: 300 generated circuits (joins, not, absent, compute, aggregates, linear, nonlinear and mutual recursion) agree with the oracle in both recursion modes, used replays', () => {
  const bad = [];
  for (let seed = 0; seed < 300; seed++) bad.push(...runSeed(seed));
  assert.deepEqual(bad.map(b => `${b.seed} [${b.recursion}] ${b.why}`), []);
});

test('the smoke cases 50 to 54 are the generator\'s output and sql-sqlite answers them as the generator computed', () => {
  for (const c of cases()) {
    const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '../../eval/smoke-reasoning/cases', c.dir);
    assert.equal(fs.readFileSync(path.join(dir, 'knowledge.sop'), 'utf8'), c.knowledge, c.dir);
    assert.equal(fs.readFileSync(path.join(dir, 'query.sop'), 'utf8'), c.query, c.dir);
    const r = run(c.knowledge, c.query);
    assert.equal(r.status, c.expected.status, c.dir);
    assert.equal(r.complete, true);
    if (c.expected.count !== undefined) assert.equal(r.count, c.expected.count, c.dir);
    if (c.expected.rows) assert.deepEqual(rowsOf(r), c.expected.rows.map(x => JSON.stringify(Object.entries(x).sort())).sort(), c.dir);
  }
});

test('scale: thousands of facts joined, grouped and negated in one statement each, agreeing with a procedural answer and (smaller) with the oracle', () => {
  const N = 20000, C = 400;
  const f = [];
  for (let o = 0; o < N; o++) f.push(`orders o${o} c${o % C}`);
  for (let c = 0; c < C; c++) f.push(`lives c${c} g${c % 12}`);
  for (let c = 0; c < C; c += 9) f.push(`vip c${c}`);
  const k = '@orders predicate\n  args subject:entity object:entity\n  closed true\n@lives predicate\n  args subject:entity object:entity\n  closed true\n@vip predicate\n  args subject:entity\n  closed true\n@og predicate\n  args subject:entity object:entity\n  closed true\n@plain predicate\n  args subject:entity object:entity\n  closed true\n' +
    facts(f) + '@r1 rule\n  when orders ?o ?c\n  when lives ?c ?g\n  then og ?o ?g\n@r2 rule\n  when og ?o ?g\n  when orders ?o ?c\n  when absent vip ?c\n  then plain ?o ?g\n';
  const t = performance.now();
  const r = run(k, '@q query\n  mode count\n  where plain ?o g3\n  select ?o\n', {}, {provenance: false});
  assert.ok(performance.now() - t < 10000);
  let want = 0;
  for (let o = 0; o < N; o++) if ((o % C) % 12 === 3 && (o % C) % 9 !== 0) want++;
  assert.equal(r.count, want);
  const small = k.replace(/@f\d+ fact\n {2}holds orders o(\d+) c\d+\n/g, (m, i) => (Number(i) < 150 ? m : ''));
  same(small, '@q query\n  mode count\n  where plain ?o g3\n  select ?o\n');
});

// ------------------------------------------------------------------------------------------------------ bank mode

function makeBank(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-sqlite-bank-'));
  const file = path.join(dir, 'bank.sqlite');
  const bank = new SQLiteBank({}, null, {path: file});
  for (const r of rows) bank.add(r);
  bank.close();
  return {dir, file, hash: () => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')};
}
const atom = (p, ...a) => ({p, a, neg: false});
const natom = (p, ...a) => ({p, a, neg: true});

test('bank mode: the rules run against a SQLite memory bank, read-only, and agree with the same facts in memory', () => {
  const rows = [atom('parent', 'ann', 'bob'), atom('parent', 'bob', 'cy'), atom('parent', 'cy', 'dee'), atom('parent', 'dee', 'ann'), atom('parent', 'cy', 'eve'), natom('parent', 'ann', 'zed'), atom('age', 'ann', 41), atom('age', 'bob', 12), atom('age', 'cy', 70)];
  const b = makeBank(rows);
  const theory = '@parent predicate\n  args subject:entity object:entity\n@r1 rule\n  when parent ?x ?y\n  then anc ?x ?y\n@r2 rule\n  when parent ?x ?m\n  when anc ?m ?y\n  then anc ?x ?y\n' +
    '@r3 rule\n  when age ?x ?a\n  when compare ?a above 30\n  when compute ?d ?a minus 30\n  then senior ?x ?d\n' +
    '@c aggregate\n  over parent ?x ?y\n  group ?x\n  count as ?n\n  yields kids ?x ?n\n';
  const before = b.hash();
  const memory = facts(rows.filter(r => !r.neg).map(r => `${r.p} ${r.a.join(' ')}`)).concat(facts(['not parent ann zed']).replace('@f0', '@fneg'));
  for (const q of [sel('anc ann ?t', '?t'), sel('anc ?s eve', '?s'), sel('senior ?x ?d', '?x ?d'), sel('kids ?x ?n', '?x ?n'), '@q query\n  mode count\n  where anc ?x ?y\n  select ?x ?y\n', '@q query\n  mode exists\n  where parent ann zed\n', '@q query\n  mode exists\n  where not parent ann zed\n']) {
    const inBank = askBank({bank: b.file, theory, query: q});
    const inMemory = run(theory + memory, q);
    assert.equal(view(inBank), view(inMemory), q);
    assert.equal(inBank.sql.backend, 'bank');
    assert.equal(inBank.route.delivery, 'bank');
  }
  assert.equal(b.hash(), before, 'the bank file is byte for byte unchanged');
  assert.deepEqual(fs.readdirSync(b.dir), ['bank.sqlite'], 'no journal, no temp file next to the bank');
});

test('bank mode is read-only by construction: opened readOnly, only TEMP objects are created, the bank cannot be written', () => {
  const b = makeBank([atom('p', 'a'), atom('p', 'b')]);
  const backend = bankBackend(b.file);
  const budget = {tick() {}, stop: null};
  const session = backend.open(budget);
  assert.throws(() => session.exec('CREATE TABLE intruder (x)'), /readonly|read-only|attempt to write/i);
  assert.throws(() => session.exec(`INSERT INTO atoms (id, p, n, neg, v0, body, meta) VALUES ('x','p',1,0,'"c"','p c','{}')`), /readonly|read-only|attempt to write/i);
  session.exec('CREATE TEMP TABLE scratch (x)');
  session.exec(`INSERT INTO scratch VALUES (1)`);
  session.close();
  const r = askBank({bank: b.file, theory: '@r rule\n  when p ?x\n  then q ?x\n', query: sel('q ?x', '?x')});
  assert.deepEqual(rowsOf(r), ['[["x","a"]]', '[["x","b"]]']);
  const bank = new SQLiteBank({}, null, {path: b.file});
  assert.equal(bank.count(), 2, 'the bank still holds exactly its two atoms');
  bank.close();
  assert.throws(() => askBank({bank: path.join(b.dir, 'missing.sqlite'), query: sel('p ?x', '?x')}), ProgramError);
  const notABank = path.join(b.dir, 'other.sqlite');
  fs.writeFileSync(notABank, '');
  assert.throws(() => askBank({bank: notABank, query: sel('p ?x', '?x')}), e => e.code === 'not_a_bank');
});

test('bank mode uses the bank\'s own indexes: a bound constant and a join are index searches on atoms', () => {
  const rows = [];
  for (let i = 0; i < 300; i++) rows.push(atom('edge', `n${i}`, `n${i + 1}`));
  const b = makeBank(rows);
  const backend = bankBackend(b.file);
  const budget = {tick() {}, stop: null};
  const session = backend.open(budget);
  session.exec(`CREATE TEMP VIEW "+edge/2" AS SELECT a.v0 AS c0, a.v1 AS c1, 0 AS rk FROM atoms AS a WHERE a.p = 'edge' AND a.n = 2 AND a.neg = 0`);
  const plan = sql => session.all('EXPLAIN QUERY PLAN ' + sql).map(r => r.detail).join(' | ');
  assert.match(plan(`SELECT t.c1 FROM "+edge/2" AS t WHERE t.c0 = '"n7"'`), /atoms_a0/, 'a constant in position 0 is an index search');
  assert.match(plan(`SELECT t.c0 FROM "+edge/2" AS t WHERE t.c1 = '"n7"'`), /atoms_a1/, 'a constant in position 1 is an index search');
  assert.match(plan(`SELECT s.c1 FROM "+edge/2" AS t, "+edge/2" AS s WHERE t.c0 = '"n7"' AND s.c0 = t.c1`), /atoms_a0/);
  session.close();
  const r = askBank({bank: b.file, theory: '@r1 rule\n  when edge ?x ?y\n  then reach ?x ?y\n@r2 rule\n  when reach ?x ?m\n  when edge ?m ?y\n  then reach ?x ?y\n', query: '@q query\n  mode count\n  where reach n0 ?t\n  select ?t\n'});
  assert.equal(r.count, 300);
  const point = askBank({bank: b.file, theory: '@r rule\n  when edge ?x ?y\n  when edge ?y ?z\n  then two ?x ?z\n', query: sel('two n10 ?t', '?t')});
  assert.deepEqual(point.rows, [{t: 'n12'}]);
});

test('bank mode with the single-file memory: asof, retraction, end events and the point in time follow the claims', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-sqlite-simple-'));
  const file = path.join(dir, 'facts.sqlite');
  const mem = new SimpleSQLiteMemory(file);
  const iv = (from, until) => ({from: Date.parse(from), until: until === 'open' ? Infinity : Date.parse(until)});
  const c1 = mem.add({atom: atom('works', 'ann', 'alpha'), valid: iv('2020-01-01', 'open')}, {knownAt: Date.parse('2020-01-01')});
  const c2 = mem.add({atom: atom('works', 'bob', 'alpha'), valid: iv('2021-01-01', 'open')}, {knownAt: Date.parse('2021-01-01')});
  const c3 = mem.add({atom: atom('works', 'cy', 'alpha'), valid: iv('2022-01-01', 'open')}, {knownAt: Date.parse('2022-01-01')});
  mem.event({action: 'end', target: c2, effective: Date.parse('2023-01-01')}, {knownAt: Date.parse('2023-06-01')});
  mem.event({action: 'retract', target: c3}, {knownAt: Date.parse('2024-01-01')});
  mem.close();
  const who = extra => askBank({bank: file, theory: '', query: `@q query\n  ${extra}where works ?x alpha\n  select ?x\n`}).rows.map(r => r.x).sort();
  assert.deepEqual(who(''), ['ann', 'bob'], 'now: cy is retracted; bob ended but, without a point in time, a claim of non-empty validity counts');
  assert.deepEqual(who('at 2022-06-01\n  '), ['ann', 'bob'], 'cy was retracted since (knowledge as of now)');
  assert.deepEqual(who('at 2023-03-01\n  '), ['ann'], 'bob ended on 2023-01-01');
  assert.deepEqual(who('asof 2022-06-01\n  at 2022-06-01\n  '), ['ann', 'bob', 'cy'], 'as known on 2022-06-01 nothing was ended or retracted yet');
  assert.deepEqual(who('asof 2020-06-01\n  at 2020-06-01\n  '), ['ann'], 'bob was not known yet');
  assert.throws(() => askBank({bank: file, query: '@q query\n  during 2022-01-01 2023-01-01\n  where works ?x alpha\n  select ?x\n'}), NotExpressibleError);
  const used = askBank({bank: file, theory: '', query: '@q query\n  mode exists\n  where works ann alpha\n'});
  assert.equal(used.used.length, 1);
  assert.match(used.used[0].id, /^[0-9a-f]{64}$/, 'a bank tuple is named by its atoms.id');
});

test('the bank mode is opt-in: ask never touches a bank and the router-facing capability names it as a separate entry point', () => {
  assert.match(capabilities.bank, /askBank/);
  assert.equal(typeof sqlSqlite.askBank, 'undefined');
});
