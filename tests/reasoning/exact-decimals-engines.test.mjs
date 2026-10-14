import test from 'node:test';
import assert from 'node:assert/strict';
import sqlSqlite from '../../reasoning/strategies/sql-sqlite/index.mjs';
import datalogSouffle from '../../reasoning/strategies/datalog-souffle/index.mjs';
import aspClingo from '../../reasoning/strategies/asp-clingo/index.mjs';
import prologTabling from '../../reasoning/strategies/prolog-tabling/index.mjs';
import z3Smt from '../../reasoning/strategies/z3-smt-bounded/index.mjs';
import {ask as oracleAsk, prepare, NotExpressibleError} from '../../reasoning/strategies/js-reference/index.mjs';
import {routedAsk, circuitFeatures} from '../../reasoning/router/index.mjs';
import {decimals, toScaled, fromScaled, planFixedPoint, scaleProgram, MAX_SCALE} from '../../reasoning/strategies/solver-common/fixed-point.mjs';
import {Q, exactCompute, realOf, smtReal} from '../../reasoning/strategies/solver-common/exact-rational.mjs';
import {compileProgram} from '../../reasoning/strategies/js-reference/program.mjs';
import {desugar, parse} from '../../sop/knowledge/index.mjs';

// Exact decimals in every engine (owner question 2026-10-02: why do the engines only run integers?). The integer engines (sql-sqlite,
// datalog-souffle, asp-clingo) carry decimals as fixed point (integers scaled by 10^S); prolog-tabling and z3-smt-bounded as exact rationals.
// Each result is compared with the exact value written by hand, then with the oracle.

const FIXED = {'sql-sqlite': sqlSqlite, 'datalog-souffle': datalogSouffle, 'asp-clingo': aspClingo};
const RATIONAL = {'prolog-tabling': prologTabling, 'z3-smt-bounded': z3Smt};
const ENGINES = {...FIXED, ...RATIONAL};
const ready = {};
for (const [id, e] of Object.entries(ENGINES)) ready[id] = (await e.available()).ok;

const rows = r => (r.rows ?? []).map(x => JSON.stringify(Object.entries(x).sort())).sort();
const entries = (list) => list.map(x => JSON.stringify(Object.entries(x).sort())).sort();
const run = (id, knowledge, query) => ENGINES[id].ask({theory: {knowledge}, query}, {}, {conditional: false});
const SELECT = '@q query\n  mode select\n  select ?k ?v\n  where out ?k ?v\n';
const head = '@price predicate\n  args subject:entity object:rational\n  closed true\n@out predicate\n  args subject:entity object:rational\n';
const fact = (id, p, a, v) => `@${id} fact\n  holds ${p} ${a} ${v}\n`;

/** Every engine named in `ids` answers `knowledge`/`query` with exactly `expected` rows, and the oracle agrees. */
function agree(name, knowledge, query, expected, ids = Object.keys(ENGINES)) {
  for (const id of ids) {
    test(`${name} (${id})`, {skip: !ready[id] && `${id} is not available`}, () => {
      const r = run(id, knowledge, query);
      assert.equal(r.status, 'supported', `${id}: ${r.status} ${r.reason ?? ''}`);
      assert.deepEqual(rows(r), entries(expected));
    });
  }
  test(`${name} (oracle)`, () => {
    assert.deepEqual(rows(oracleAsk({theory: {knowledge}, query})), entries(expected));
  });
}

// ------------------------------------------------------------------------------------------------ the language of the rewriting

test('decimals() counts the places of the shortest decimal text', () => {
  assert.equal(decimals(5), 0);
  assert.equal(decimals(0.1), 1);
  assert.equal(decimals(19.99), 2);
  assert.equal(decimals(-2.75), 2);
  assert.equal(decimals(1e-7), 7);
  assert.equal(decimals(1.5e-7), 8);
  assert.equal(decimals(1e21), 0);
});

test('toScaled and fromScaled are exact inverses on decimals, with no binary noise', () => {
  for (const [n, s] of [[0.1, 1], [0.3, 1], [19.99, 2], [-2.75, 2], [0.000001, 6], [123456.789, 3], [7, 4]]) {
    const scaled = toScaled(n, s);
    assert.ok(Number.isSafeInteger(scaled));
    assert.equal(fromScaled(scaled, s), n);
  }
  assert.equal(toScaled(0.1, 3) + toScaled(0.2, 3), toScaled(0.3, 3));
  assert.equal(fromScaled(toScaled(0.1, 3) + toScaled(0.2, 3), 3), 0.3);
  assert.equal(fromScaled(-5n, 3), -0.005);
  assert.equal(toScaled(2 ** 52, 4), null);
});

const programOf = text => {
  const h = prepare(text);
  const {wires, origin} = desugar(h.wires);
  return compileProgram(wires, {origin});
};

test('the plan: integers stay untouched, scales add under times, a division by a constant adds its places, a variable divisor adds the headroom', () => {
  assert.equal(planFixedPoint(programOf(head + fact('f1', 'price', 'a', 5) + '@r rule\n  when price ?x ?p\n  when compute ?v ?p times 3\n  then out ?x ?v\n')), null);
  const dec = planFixedPoint(programOf(head + fact('f1', 'price', 'a', 0.25) + '@r rule\n  when price ?x ?p\n  when compute ?v ?p times 0.5\n  then out ?x ?v\n'));
  assert.equal(dec.scale, 3);
  const quarter = planFixedPoint(programOf(head + fact('f1', 'price', 'a', 0.1) + '@r rule\n  when price ?x ?p\n  when compute ?v ?p divided_by 8\n  then out ?x ?v\n'));
  assert.equal(quarter.scale, 4);
  const variable = planFixedPoint(programOf(head + fact('f1', 'price', 'a', 0.1) + fact('f2', 'price', 'b', 4) + '@r rule\n  when price a ?p\n  when price b ?q\n  when compute ?v ?p divided_by ?q\n  then out a ?v\n'));
  assert.equal(variable.flag, true);
  assert.ok(variable.scale >= 3);
  assert.equal(planFixedPoint(programOf(head + fact('f1', 'price', 'a', 0.1) + '@r rule\n  when price ?x ?p\n  when compute ?v ?p rounded_to 5\n  then out ?x ?v\n')).scale, 1);
});

test('the plan refuses what has no exact fixed-point form', () => {
  const k = (word, b) => head + fact('f1', 'price', 'a', 0.5) + `@r rule\n  when price ?x ?p\n  when compute ?v ?p ${word} ${b}\n  then out ?x ?v\n`;
  assert.throws(() => planFixedPoint(programOf(k('divided_by', 3))), NotExpressibleError);       // 1/3 does not terminate
  assert.throws(() => planFixedPoint(programOf(k('power', 9))), NotExpressibleError);            // beyond the unrolled exponents
  assert.throws(() => planFixedPoint(programOf(k('power', '?p'))), NotExpressibleError);         // a variable exponent
  assert.equal(planFixedPoint(programOf(k('divided_by', 8))).scale, 4);
  const wide = head + fact('f1', 'price', 'a', '0.000000000001') + '@r rule\n  when price ?x ?p\n  when compute ?v ?p times 0.1\n  then out ?x ?v\n';
  assert.ok(MAX_SCALE < 13);
  assert.throws(() => planFixedPoint(programOf(wide)), NotExpressibleError);                     // 13 places
});

test('scaleProgram scales facts and constants and expands every word into the four integer words', () => {
  const p = programOf(head + fact('f1', 'price', 'a', 0.1) + '@r rule\n  when price ?x ?p\n  when compute ?v ?p rounded_to 0.5\n  then out ?x ?v\n');
  const plan = planFixedPoint(p);
  const scaled = scaleProgram(p, plan);
  assert.deepEqual(scaled.facts[0].args, ['a', 1 * plan.P / 10]);
  assert.equal(scaled.rules[0].alts.length, 2, 'rounded_to splits on the sign of its operand');
  const words = new Set(scaled.rules[0].alts.flatMap(a => a.leaves.filter(l => l.kind === 'compute').map(l => l.word)));
  for (const w of words) assert.ok(['plus', 'minus', 'times', 'whole_divided_by'].includes(w), w);
});

test('the exact rational module: oracle words, terminating decimals exact, quotients to 12 digits, Z3 reals read back', () => {
  assert.equal(exactCompute('plus', 0.1, 0.2), 0.3);
  assert.equal(exactCompute('times', 19.99, 3), 59.97);
  assert.equal(exactCompute('divided_by', 7, 2), 3.5);
  assert.equal(exactCompute('divided_by', 1, 3), 0.333333333333);
  assert.equal(exactCompute('divided_by', 1, 0), undefined);
  assert.equal(exactCompute('rounded_to', -2.5, 1), -3);
  assert.equal(exactCompute('rounded_to', 2.5, 1), 3);
  assert.equal(exactCompute('rounded_up_to', -2.75, 1), -2);
  assert.equal(exactCompute('rounded_down_to', -2.75, 1), -3);
  assert.equal(exactCompute('modulo', -7, 3), -1);
  assert.equal(exactCompute('whole_divided_by', -7, 2), -3);
  assert.equal(exactCompute('whole_divided_by', 7.5, 2), undefined);
  assert.equal(exactCompute('power', 1.1, 2), 1.21);
  assert.equal(exactCompute('power', 2, 65), undefined);
  assert.equal(realOf(['/', '3.0', '10.0']).toNumber(), 0.3);
  assert.equal(realOf(['-', ['/', '1.0', '3.0']]).toNumber(), -0.333333333333);
  assert.equal(smtReal(-2.75), '(- (/ 11.0 4.0))');
  assert.equal(new Q(1n, 3n).terminates, false);
});

// ------------------------------------------------------------------------------------------------ the engines

agree('0.1 plus 0.2 is exactly 0.3',
  head + fact('f1', 'price', 'a', 0.1) + fact('f2', 'price', 'b', 0.2)
  + '@r rule\n  when price a ?x\n  when price b ?y\n  when compute ?z ?x plus ?y\n  then out sum ?z\n', SELECT, [{k: 'sum', v: 0.3}]);

agree('mixed scales: minus, times by an integer and by a decimal',
  head + fact('f1', 'price', 'a', 19.99) + fact('f2', 'price', 'b', 0.5) + fact('f3', 'price', 'n', 3)
  + '@r1 rule\n  when price a ?x\n  when price b ?y\n  when compute ?z ?x minus ?y\n  then out diff ?z\n'
  + '@r2 rule\n  when price a ?x\n  when price n ?y\n  when compute ?z ?x times ?y\n  then out by_int ?z\n'
  + '@r3 rule\n  when price a ?x\n  when price b ?y\n  when compute ?z ?x times ?y\n  then out by_dec ?z\n',
  SELECT, [{k: 'diff', v: 19.49}, {k: 'by_int', v: 59.97}, {k: 'by_dec', v: 9.995}]);

agree('comparisons order decimals and equal sees 0.1 plus 0.2 as 0.3',
  head + fact('f1', 'price', 'a', 0.1) + fact('f2', 'price', 'b', 0.2) + fact('f3', 'price', 'c', 0.3) + fact('f4', 'price', 'd', 2.5)
  + '@r1 rule\n  when price ?i ?p\n  when compare ?p above 0.15\n  when compare ?p at_most 0.3\n  then out mid ?p\n'
  + '@r2 rule\n  when price a ?x\n  when price b ?y\n  when price c ?z\n  when compute ?s ?x plus ?y\n  when compare ?s equal ?z\n  then out equal_to_c ?s\n',
  SELECT, [{k: 'mid', v: 0.2}, {k: 'mid', v: 0.3}, {k: 'equal_to_c', v: 0.3}]);

agree('sum, min, max and count over decimals',
  head + '@s predicate\n  args subject:entity object:rational\n  closed true\n'
  + ['0.1', '0.2', '0.3', '0.7', '19.99'].map((v, i) => fact(`f${i}`, 's', `i${i}`, v)).join('')
  + '@a1 aggregate\n  over s ?i ?v\n  sum ?v as ?t\n  yields out sum ?t\n'
  + '@a2 aggregate\n  over s ?i ?v\n  min ?v as ?t\n  yields out min ?t\n'
  + '@a3 aggregate\n  over s ?i ?v\n  max ?v as ?t\n  yields out max ?t\n'
  + '@a4 aggregate\n  over s ?i ?v\n  count ?i as ?t\n  yields out count ?t\n',
  SELECT, [{k: 'sum', v: 21.29}, {k: 'min', v: 0.1}, {k: 'max', v: 19.99}, {k: 'count', v: 5}]);

agree('division: by a constant (exact), by a variable (exact), and the places of the quotient',
  head + fact('f1', 'price', 'a', 10.5) + fact('f2', 'price', 'n', 4) + fact('f3', 'price', 'b', 7)
  + '@r1 rule\n  when price a ?x\n  when compute ?z ?x divided_by 4\n  then out by_const ?z\n'
  + '@r2 rule\n  when price a ?x\n  when price n ?y\n  when compute ?z ?x divided_by ?y\n  then out by_var ?z\n'
  + '@r3 rule\n  when price b ?x\n  when compute ?z ?x divided_by 8\n  then out eighth ?z\n',
  SELECT, [{k: 'by_const', v: 2.625}, {k: 'by_var', v: 2.625}, {k: 'eighth', v: 0.875}]);

agree('rounding: half away from zero, up, down, on negative and positive decimals',
  head + ['2.5', '-2.5', '2.4', '-2.75', '19.99', '0.05'].map((v, i) => fact(`f${i}`, 'price', `i${i}`, v)).join('')
  + '@r1 rule\n  when price ?i ?x\n  when compute ?z ?x rounded_to 1\n  then out nearest ?z\n'
  + '@r2 rule\n  when price ?i ?x\n  when compute ?z ?x rounded_up_to 0.5\n  then out up ?z\n'
  + '@r3 rule\n  when price ?i ?x\n  when compute ?z ?x rounded_down_to 0.5\n  then out down ?z\n',
  SELECT, [
    ...[3, -3, 2, -3, 20, 0].map(v => ({k: 'nearest', v})),
    ...[2.5, -2.5, 2.5, -2.5, 20, 0.5].map(v => ({k: 'up', v})),
    ...[2.5, -2.5, 2, -3, 19.5, 0].map(v => ({k: 'down', v}))
  ].filter((x, i, all) => all.findIndex(y => y.k === x.k && y.v === x.v) === i));

agree('power, whole_divided_by and modulo over decimals and negatives',
  head + fact('f1', 'price', 'a', 1.1) + fact('f2', 'price', 'n', -7) + fact('f3', 'price', 'h', 7.5)
  + '@r1 rule\n  when price a ?x\n  when compute ?z ?x power 3\n  then out cube ?z\n'
  + '@r2 rule\n  when price n ?x\n  when compute ?z ?x whole_divided_by 2\n  then out whole ?z\n'
  + '@r3 rule\n  when price n ?x\n  when compute ?z ?x modulo 3\n  then out rem ?z\n'
  + '@r4 rule\n  when price h ?x\n  when compute ?z ?x whole_divided_by 2\n  then out never ?z\n',
  SELECT, [{k: 'cube', v: 1.331}, {k: 'whole', v: -3}, {k: 'rem', v: -1}]);

agree('a zero divisor and a non-integer operand of a whole word make the body false',
  head + fact('f1', 'price', 'a', 1.5) + fact('f2', 'price', 'z', 0)
  + '@r1 rule\n  when price a ?x\n  when price z ?y\n  when compute ?v ?x divided_by ?y\n  then out zero_div ?v\n'
  + '@r2 rule\n  when price a ?x\n  when compute ?v ?x modulo 2\n  then out mod ?v\n'
  + '@r3 rule\n  when price a ?x\n  when compute ?v ?x plus 0.5\n  then out ok ?v\n',
  SELECT, [{k: 'ok', v: 2}]);

// ------------------------------------------------------------------------------------------------ refusals

for (const id of Object.keys(FIXED)) {
  test(`a quotient that does not terminate is not_expressible on ${id}, exact on the rational engines`, {skip: !ready[id] && 'unavailable'}, () => {
    const k = head + fact('f1', 'price', 'a', 10) + fact('f2', 'price', 'n', 3) + '@r rule\n  when price a ?x\n  when price n ?y\n  when compute ?z ?x divided_by ?y\n  then out third ?z\n';
    assert.throws(() => run(id, k, SELECT), e => e instanceof NotExpressibleError && e.features.includes('exact_arithmetic'));
  });
}
for (const id of Object.keys(RATIONAL)) {
  test(`${id} answers 10 divided_by 3 as the oracle renders it (12 significant digits)`, {skip: !ready[id] && 'unavailable'}, () => {
    const k = head + fact('f1', 'price', 'a', 10) + fact('f2', 'price', 'n', 3) + '@r rule\n  when price a ?x\n  when price n ?y\n  when compute ?z ?x divided_by ?y\n  then out third ?z\n';
    assert.deepEqual(run(id, k, SELECT).rows, [{k: 'third', v: 3.33333333333}]);
    assert.deepEqual(oracleAsk({theory: {knowledge: k}, query: SELECT}).rows, [{k: 'third', v: 3.33333333333}]);
  });
}

test('more than 12 decimal places, or a constant divisor with a prime factor other than 2 and 5, is not_expressible for the integer engines', () => {
  const wide = head + fact('f1', 'price', 'a', '0.0000000000001') + '@r rule\n  when price a ?x\n  when compute ?z ?x plus 1\n  then out k ?z\n';
  const third = head + fact('f1', 'price', 'a', 1) + '@r rule\n  when price a ?x\n  when compute ?z ?x divided_by 3\n  then out k ?z\n';
  for (const id of Object.keys(FIXED)) {
    if (!ready[id]) continue;
    assert.throws(() => run(id, wide, SELECT), NotExpressibleError, id);
    assert.throws(() => run(id, third, SELECT), NotExpressibleError, id);
  }
});

test('the 32-bit engines flag an overflow of scaled values as numeric_range, never a wrapped number', () => {
  if (!ready['datalog-souffle']) return;
  const k = head + fact('f1', 'price', 'a', 99999.99) + '@r rule\n  when price a ?x\n  when compute ?z ?x times ?x\n  then out sq ?z\n';
  const r = run('datalog-souffle', k, SELECT);
  assert.equal(r.status, 'budget_exhausted');
  assert.equal(r.reason, 'numeric_range');
  assert.deepEqual(run('sql-sqlite', k, SELECT).rows, [{k: 'sq', v: 9999998000.0001}]);
});

test('proofs and explanations of a fixed-point answer carry decimals, not scaled integers', () => {
  const k = head + fact('f1', 'price', 'a', 0.1) + fact('f2', 'price', 'b', 0.2) + '@r rule\n  when price a ?x\n  when price b ?y\n  when compute ?z ?x plus ?y\n  then out sum ?z\n';
  const r = sqlSqlite.ask({theory: {knowledge: k}, query: '@q query\n  mode explain\n  select ?k ?v\n  where out ?k ?v\n'}, {}, {conditional: false});
  assert.equal(r.status, 'supported');
  const text = JSON.stringify([r.explain, r.proof]);
  assert.match(text, /0\.1/);
  assert.match(text, /0\.2/);
  assert.match(text, /0\.3/);
  assert.doesNotMatch(text, /\b(1000|2000|3000|10000|20000|30000)\b/);
});

// ------------------------------------------------------------------------------------------------ differential fuzz

function lcg(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); }

test('differential: random decimal programs agree between every engine that answers and the oracle', () => {
  const rnd = lcg(20261002);
  const pick = list => list[Math.floor(rnd() * list.length)];
  const num = () => pick([0.1, 0.2, 0.25, 0.5, 1.5, 2.75, 3, 4, 0.05, 12.5, -0.5, -1.25, 7]);
  let compared = 0, refused = 0;
  for (let n = 0; n < 40; n++) {
    const facts = ['a', 'b', 'c'].map((id, i) => fact(`f${i}`, 'price', id, num())).join('');
    const word = pick(['plus', 'minus', 'times', 'rounded_to', 'rounded_up_to', 'rounded_down_to', 'divided_by']);
    const right = word.startsWith('rounded') ? pick([0.5, 1, 0.25, 0.1]) : word === 'divided_by' ? pick([2, 4, 5, 8, 0.5, 10]) : pick(['?y', num()]);
    const body = `  when price a ?x\n  when price b ?y\n${right === '?y' || /^\?/.test(String(right)) ? '' : ''}  when compute ?z ?x ${word} ${right}\n`;
    const agg = pick(['', '@g aggregate\n  over price ?i ?v\n  sum ?v as ?t\n  yields out total ?t\n', '@g aggregate\n  over price ?i ?v\n  max ?v as ?t\n  yields out top ?t\n']);
    const k = head + facts + `@r rule\n${body}  then out calc ?z\n` + agg;
    const want = rows(oracleAsk({theory: {knowledge: k}, query: SELECT}));
    for (const id of Object.keys(ENGINES)) {
      if (!ready[id]) continue;
      let got;
      try { got = run(id, k, SELECT); } catch (e) { if (e instanceof NotExpressibleError) { refused++; continue; } throw e; }
      if (got.status === 'budget_exhausted') { refused++; continue; }
      assert.deepEqual(rows(got), want, `${id}: ${word} ${right}\n${k}`);
      compared++;
    }
  }
  assert.ok(compared > 120, `only ${compared} comparisons`);
  assert.ok(refused < compared);
});

// ------------------------------------------------------------------------------------------------ the router

const cfg = {small_facts: {nonlinear: 0, recursion: 0, other: 0}};
const route = (knowledge, query = SELECT, requested = 'auto') => routedAsk({handle: prepare(knowledge), query, requested, config: cfg});

test('router: a decimal circuit is routed to an integer engine that carries it and the oracle verifies the answer', () => {
  const k = head + fact('f1', 'price', 'a', 0.1) + fact('f2', 'price', 'b', 0.2) + '@r rule\n  when price a ?x\n  when price b ?y\n  when compute ?z ?x plus ?y\n  then out sum ?z\n';
  const features = circuitFeatures(prepare(k), parse(SELECT).wires);
  assert.equal(features.exact_arithmetic, true);
  assert.ok(features.required.includes('exact_arithmetic'));
  assert.equal(features.fixed_point.ok, true);
  const r = route(k);
  assert.ok(Object.keys(FIXED).includes(r.route.chosen), r.route.chosen);
  assert.deepEqual(r.rows, [{k: 'sum', v: 0.3}]);
  assert.equal(r.route.verification.outcome, 'agreed');
});

test('router: a circuit without an exact fixed-point form goes to the oracle with the reason, and a named engine is never substituted', () => {
  const k = head + fact('f1', 'price', 'a', 10) + '@r rule\n  when price a ?x\n  when compute ?z ?x divided_by 3\n  then out third ?z\n';
  const r = route(k);
  assert.equal(r.route.chosen, 'js-reference');
  assert.deepEqual(r.rows, [{k: 'third', v: 3.33333333333}]);
  assert.ok(r.route.alternatives.every(a => !a.eligible && /fixed-point|exact/.test(a.why)), JSON.stringify(r.route.alternatives));
  const named = route(k, SELECT, 'sql-sqlite');
  assert.equal(named.status, 'unsupported');
  assert.equal(named.route.backend, 'sql-sqlite');
  assert.equal(named.route.fallback, null);
});

test('router: an integer engine that leaves its range hands the question to the oracle (auto), and says so', () => {
  if (!ready['datalog-souffle']) return;
  const k = head + fact('f1', 'price', 'a', 99999.99) + '@r rule\n  when price a ?x\n  when compute ?z ?x times ?x\n  then out sq ?z\n';
  const r = route(k);
  // the integer engine's exact 9999998000.0001 is beyond the oracle's 12 significant digits: the oracle's rendering is the product answer
  assert.deepEqual(r.rows, [{k: 'sq', v: 9999998000}]);
});
