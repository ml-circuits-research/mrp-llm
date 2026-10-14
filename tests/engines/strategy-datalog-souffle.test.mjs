import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ask as oracle} from '../../reasoning/strategies/js-reference/index.mjs';
import {datalogSouffle, capabilities, makeEngine, NotExpressibleError} from '../../reasoning/strategies/datalog-souffle/index.mjs';
import {encodeSymbol, decodeSymbol} from '../../reasoning/strategies/datalog-souffle/lower.mjs';
import {parse} from '../../sop/knowledge/index.mjs';
import * as scale from '../../eval/smoke-reasoning/bench/datalog-scale.mjs';

const available = await datalogSouffle.available();
const skip = available.ok ? false : 'no Souffle binary (tools/.solvers/souffle or SOUFFLE_BIN)';

const ask = (knowledge, query, budget = {}, options = {}) => datalogSouffle.ask({theory: {knowledge}, query}, budget, {conditional: false, ...options});
const rowsOf = r => r.rows.map(x => JSON.stringify(x)).sort();
const sel = (where, select) => `@q query\n  where ${where}\n  select ${select}\n`;

test('capabilities declare what is not provided and what is not expressible', () => {
  assert.equal(capabilities.id, 'datalog-souffle');
  assert.deepEqual(capabilities.provides, []);
  assert.match(capabilities.providesNote, /used: false/);
  for (const f of ['temporal', 'plan', 'abduce', 'explain', 'used']) assert.ok(capabilities.notExpressible.includes(f), f);
  assert.deepEqual(capabilities.limits.integer_range, [-(2 ** 31), 2 ** 31 - 1]);
});

test('text round-trips through the symbol encoding (spaces, quotes, tabs, backslashes, unicode, empty)', () => {
  for (const s of ['plain', 'two words', 'say "hi"', 'tab\there', 'back\\slash', 'café ü', '', '~tilde', 'line\nbreak']) assert.equal(decodeSymbol(encodeSymbol(s)), s);
  assert.equal(encodeSymbol('ab_c-1'), 'ab_c-1', 'a plain symbol stays readable in the lowered program');
});

test('quoted text with awkward characters survives the facts file and the answer', { skip }, () => {
  const k = '@f1 fact\n  holds label n1 "two words"\n@f2 fact\n  holds label n2 "say \\"hi\\" \\\\ café"\n@f3 fact\n  holds label n3 ""\n@f4 fact\n  holds label n4 plain\n';
  const out = ask(k, sel('label ?n ?t', '?n ?t'));
  const want = oracle({theory: {knowledge: k}, query: sel('label ?n ?t', '?n ?t')});
  assert.deepEqual(rowsOf(out), rowsOf(want));
  assert.equal(out.rows.length, 4);
});

test('two relations per predicate: explicit negation is evidence of its own, both is reported and nothing explodes', { skip }, () => {
  const k = '@f1 fact\n  holds bird tweety\n@f2 fact\n  holds not flies tweety\n@r1 rule\n  when bird ?x\n  then flies ?x\n@r2 rule\n  when flies ?x\n  then can_glide ?x\n@r3 rule\n  when not flies ?x\n  then grounded ?x\n';
  assert.equal(ask(k, '@q query\n  mode exists\n  where flies tweety\n').status, 'both');
  assert.equal(ask(k, '@q query\n  mode exists\n  where can_glide tweety\n').status, 'supported');
  assert.equal(ask(k, '@q query\n  mode exists\n  where grounded tweety\n').status, 'supported');
  assert.equal(ask(k, '@q query\n  mode exists\n  where flies pingu\n').status, 'unknown');
});

test('the lowered program has two relations per polarity, stratified negation and a set relation per aggregate', { skip }, () => {
  const k = '@c predicate\n  args subject:entity\n  closed true\n@f1 fact\n  holds p a\n@f2 fact\n  holds not p b\n@f3 fact\n  holds c a\n@r rule\n  when p ?x\n  when absent c ?x\n  then q ?x\n@agg aggregate\n  over p ?x\n  group ?x\n  count ?x as ?n\n  yields cnt ?x ?n\n';
  const probe = makeEngine();
  const {askWith} = awaitableFront;
  askWith(probe, {theory: {knowledge: k}, query: '@q query\n  where q ?x\n  select ?x\n'}, {}, {conditional: false});
  const first = probe.lastRun.dl;
  askWith(probe, {theory: {knowledge: k}, query: '@q query\n  where cnt ?x ?n\n  select ?x ?n\n'}, {}, {conditional: false});
  const dl = first + probe.lastRun.dl;
  assert.match(dl, /\.decl p_p\(/);
  assert.match(dl, /\.decl n_p\(/);
  assert.match(dl, /!p_c\(/);
  assert.match(dl, /x_agg_agg_rows/);
});

test('negation as failure over three strata is evaluated layer by layer', { skip }, () => {
  const inst = scale.negationChain({nodes: 40});
  const out = datalogSouffle.ask({theory: {knowledge: inst.knowledge}, query: inst.query}, {}, {conditional: false});
  assert.deepEqual(rowsOf(out), rowsOf({rows: inst.answer.rows}));
});

test('aggregates run over the set of distinct bindings: equal salaries both count', { skip }, () => {
  const k = '@salary predicate\n  args subject:entity topic:entity object:integer\n  closed true\n@f1 fact\n  holds salary a dev 100\n@f2 fact\n  holds salary b dev 100\n@f3 fact\n  holds salary c ops 7\n@s aggregate\n  over salary ?p ?d ?s\n  group ?d\n  sum ?s as ?t\n  yields total ?d ?t\n@c aggregate\n  over salary ?p ?d ?s\n  group ?d\n  count ?p as ?n\n  yields size ?d ?n\n@m aggregate\n  over salary ?p ?d ?s\n  group ?d\n  min ?s as ?v\n  yields low ?d ?v\n';
  assert.deepEqual(rowsOf(ask(k, sel('total ?d ?t', '?d ?t'))), ['{"d":"dev","t":200}', '{"d":"ops","t":7}']);
  assert.deepEqual(rowsOf(ask(k, sel('size ?d ?n', '?d ?n'))), ['{"d":"dev","n":2}', '{"d":"ops","n":1}']);
  assert.deepEqual(rowsOf(ask(k, sel('low ?d ?v', '?d ?v'))), ['{"d":"dev","v":100}', '{"d":"ops","v":7}']);
});

test('arithmetic: integer division truncates toward zero and a zero divisor makes the body false', { skip }, () => {
  const k = '@f1 fact\n  holds n a -7\n@f2 fact\n  holds n b 0\n@f3 fact\n  holds n c 9\n@r rule\n  when n ?x ?v\n  when compute ?h ?v whole_divided_by 2\n  then half ?x ?h\n@r2 rule\n  when n ?x ?v\n  when compute ?q 100 whole_divided_by ?v\n  then inv ?x ?q\n';
  assert.deepEqual(rowsOf(ask(k, sel('half ?x ?h', '?x ?h'))), ['{"x":"a","h":-3}', '{"x":"b","h":0}', '{"x":"c","h":4}']);
  assert.deepEqual(rowsOf(ask(k, sel('inv ?x ?q', '?x ?q'))), ['{"x":"a","q":-14}', '{"x":"c","q":11}']);
});

test('a 32-bit overflow is budget_exhausted with reason numeric_range, never a wrapped number', { skip }, () => {
  const k = '@f1 fact\n  holds n a 100000\n@f2 fact\n  holds n b 3\n@r rule\n  when n ?x ?v\n  when compute ?sq ?v times ?v\n  then square ?x ?sq\n';
  const out = ask(k, sel('square ?x ?sq', '?x ?sq'));
  assert.equal(out.status, 'budget_exhausted');
  assert.equal(out.reason, 'numeric_range');
  assert.equal(out.complete, false);
  // the same program with small numbers is exact and agrees with the oracle (which has 53-bit integers)
  const small = k.replace('100000', '1000');
  assert.deepEqual(rowsOf(ask(small, sel('square ?x ?sq', '?x ?sq'))), rowsOf(oracle({theory: {knowledge: small}, query: sel('square ?x ?sq', '?x ?sq')})));
  // a sum that overflows is flagged too
  const sum = '@amount predicate\n  args subject:entity object:integer\n  closed true\n@f1 fact\n  holds amount a 2000000000\n@f2 fact\n  holds amount b 2000000000\n@s aggregate\n  over amount ?e ?v\n  group ?e2\n  sum ?v as ?t\n  yields total ?t\n'.replace('group ?e2\n  ', '');
  assert.equal(ask(sum, sel('total ?t', '?t')).reason, 'numeric_range');
});

test('what does not fit Soufflé is not_expressible: integers beyond 32 bits, mixed types, ordering over text, collect, time, explain', { skip }, () => {
  assert.throws(() => ask('@f1 fact\n  holds n a 5000000000\n', sel('n ?x ?v', '?x ?v')), NotExpressibleError);
  assert.throws(() => ask('@f1 fact\n  holds p a 1\n@f2 fact\n  holds p b c\n', sel('p ?x', '?x')), NotExpressibleError);
  assert.throws(() => ask('@f1 fact\n  holds p a\n@r rule\n  when p ?x\n  when compare ?x above 3\n  then q ?x\n', sel('q ?x', '?x')), NotExpressibleError);
  assert.throws(() => ask('@f1 fact\n  holds p a 1\n@agg aggregate\n  over p ?x ?v\n  group ?x\n  collect ?v as ?l\n  yields bag ?x ?l\n', sel('bag ?x ?l', '?x ?l')), NotExpressibleError);
  assert.throws(() => ask('@f1 fact\n  holds p a\n', '@q query\n  at 2026-01-01\n  where p ?x\n  select ?x\n'), NotExpressibleError);
  assert.throws(() => ask('@f1 fact\n  holds p a\n', '@q query\n  mode explain\n  where p a\n'), NotExpressibleError);
});

test('select, exists and count pushed into the program agree with the closure path and with the oracle', { skip }, () => {
  const inst = scale.ringComponents({components: 30, size: 6});
  const pushed = ask(inst.knowledge, inst.query);
  const closure = ask(inst.knowledge, inst.query, {}, {pushdown: false});
  const magic = ask(inst.knowledge, inst.query, {}, {magic: true});
  const want = oracle({theory: {knowledge: inst.knowledge}, query: inst.query});
  assert.deepEqual(rowsOf(pushed), rowsOf(want));
  assert.deepEqual(rowsOf(closure), rowsOf(want));
  assert.deepEqual(rowsOf(magic), rowsOf(want));
  const count = ask(inst.knowledge, '@q query\n  mode count\n  where reach n0_0 ?y\n');
  assert.equal(count.count, 6);
  assert.equal(count.bound, 'at_least', 'reach is not declared closed: a count is a lower bound');
});

test('refuted, unknown and both come out of the pushed-down query as in the oracle', { skip }, () => {
  const k = '@c predicate\n  args subject:entity\n  closed true\n@f1 fact\n  holds c a\n@f2 fact\n  holds not o a\n@f3 fact\n  holds o a\n@f4 fact\n  holds o b\n';
  for (const q of ['@q query\n  mode exists\n  where c z\n', '@q query\n  mode exists\n  where o z\n', '@q query\n  mode exists\n  where not o b\n', '@q query\n  mode select\n  where o ?x\n  select ?x\n', '@q query\n  mode exists\n  where o a\n']) {
    const got = ask(k, q), want = oracle({theory: {knowledge: k}, query: q});
    assert.equal(got.status, want.status, q);
    assert.deepEqual(rowsOf({rows: got.rows ?? []}), rowsOf({rows: want.rows ?? []}), q);
  }
});

test('a wall-clock timeout kills the subprocess: budget_exhausted, reason wall, never a negative answer', { skip }, () => {
  const inst = scale.denseNonlinear({nodes: 260, density: 4});
  const out = ask(inst.knowledge, inst.query, {timeoutMs: 1});
  assert.equal(out.status, 'budget_exhausted');
  assert.equal(out.reason, 'wall');
  assert.equal(out.complete, false);
});

test('maxFacts is checked before the run', { skip }, () => {
  const inst = scale.ringComponents({components: 10, size: 5});
  const out = ask(inst.knowledge, inst.query, {maxFacts: 20});
  assert.equal(out.status, 'budget_exhausted');
  assert.equal(out.reason, 'facts');
});

test('compile mode agrees with the interpreter and reuses its binary from the cache', { skip: skip || (spawnProbe() ? false : 'no g++') , timeout: 240000 }, () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'souffle-cache-test-'));
  const old = process.env.CHATSOP_SOUFFLE_CACHE;
  process.env.CHATSOP_SOUFFLE_CACHE = cache;
  try {
    const inst = scale.ringComponents({components: 3, size: 4});
    const engine = makeEngine({mode: 'compile'});
    const first = awaitableFront.askWith(engine, {theory: {knowledge: inst.knowledge}, query: inst.query}, {}, {conditional: false});
    assert.equal(engine.lastRun.compiled, true);
    assert.deepEqual(rowsOf(first), rowsOf({rows: inst.answer.rows}));
    const second = awaitableFront.askWith(engine, {theory: {knowledge: inst.knowledge}, query: inst.query}, {}, {conditional: false});
    assert.equal(engine.lastRun.compiled, false, 'the second run finds the binary in the cache');
    assert.deepEqual(rowsOf(second), rowsOf(first));
    // a different fact set with the same program text reuses the binary: the facts are not part of the cache key
    const other = scale.ringComponents({components: 5, size: 4});
    awaitableFront.askWith(engine, {theory: {knowledge: other.knowledge}, query: other.query}, {}, {conditional: false});
    assert.equal(engine.lastRun.compiled, false);
  } finally {
    if (old === undefined) delete process.env.CHATSOP_SOUFFLE_CACHE; else process.env.CHATSOP_SOUFFLE_CACHE = old;
    fs.rmSync(cache, {recursive: true, force: true});
  }
});

test('10^5 facts: reachability over many ring components is answered exactly (smoke case 65 at scale); the oracle agrees at 200 facts', { skip, timeout: 120000 }, () => {
  const big = scale.ringComponents({components: 10000, size: 10});
  const wires = parseChunks(big.knowledge);
  const t0 = performance.now();
  const out = datalogSouffle.ask({theory: {wires}, query: big.query}, {}, {conditional: false});
  const ms = performance.now() - t0;
  assert.equal(out.complete, true);
  assert.deepEqual(rowsOf(out), rowsOf({rows: big.answer.rows}));
  assert.ok(ms < 60000, `10^5 facts took ${Math.round(ms)} ms`);
  const small = scale.ringComponents({components: 20, size: 10}); // the naive oracle does 10^6 probes on 200 facts
  const want = oracle({theory: {knowledge: small.knowledge}, query: small.query});
  const got = ask(small.knowledge, small.query);
  assert.deepEqual(rowsOf(got), rowsOf(want));
});

test('conditional answers come from the host rule: a supposition is listed, a Soufflé run per variant', { skip }, () => {
  const k = '@s1 fact\n  holds works_at ann alpha\n  status supposed\n@f2 fact\n  holds works_at bob alpha\n';
  const out = datalogSouffle.ask({theory: {knowledge: k}, query: sel('works_at ?p alpha', '?p')}, {});
  assert.deepEqual(out.conditional, ['s1']);
  assert.deepEqual(out.row_conditional.map(r => [r.row.p, r.conditional.length]).sort(), [['ann', 1], ['bob', 0]]);
});

// ---- helpers
import * as awaitableFront from '../../reasoning/strategies/datalog-common/front.mjs';
import {spawnSync} from 'node:child_process';

function spawnProbe() { return spawnSync('g++', ['--version'], {encoding: 'utf8'}).status === 0; }

function parseChunks(text, size = 400) {
  const blocks = text.split(/\n(?=@)/), wires = [];
  for (let i = 0; i < blocks.length; i += size) wires.push(...parse(blocks.slice(i, i + size).join('\n') + '\n').wires);
  return wires;
}
