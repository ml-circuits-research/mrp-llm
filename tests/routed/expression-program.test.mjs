// The expression path (lib/formalize/expression-program.mjs), the perturbation agreement (lib/formalize/dual-check.mjs) and the exemplar
// retrieval (lib/formalize/exemplars.mjs): reading a model's `name = expression` lines, the static analysis (references, types, units,
// coverage, dataflow), the lowering to SOP executed by the engines, and agreement against an independently built tree circuit. The tests
// of the archived dual-formalization tooling (strict scoring, recording replay, obligations, the cross-family and tiny-only verifiers)
// moved to probably_obsolete/formalization-experiments-2026-10/tests/. Every problem text here is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readProgram, analyseProgram, lowerProgram, evaluateProgram, expressionFormalize, registryOf, normalizeRegistry} from '../../lib/formalize/expression-program.mjs';
import {crossCheck, perturbations, perturbCircuit, answersAgree, splitCircuit} from '../../lib/formalize/dual-check.mjs';
import {readFormulas, arithmeticCircuit} from '../../lib/query-author/step-by-step/problem.mjs';
import {Repository} from '../../memory/repository.mjs';
import {Agent} from '../../server/agent.mjs';
import {seedLexicon} from '../../lib/knowledge-seeds.mjs';

let world = null;
/** The product's engines over a small memory: `execute(sop)` → {status, values, route, used} (one Agent turn per circuit). */
async function executor() {
  if (world) return world;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'expr-'));
  const repo = new Repository(root, {memory: JSON.parse(fs.readFileSync(new URL('../../config/runtime.json', import.meta.url), 'utf8')).memory});
  repo.init('base');
  const lexicon = seedLexicon('core-min');
  let n = 0;
  // `numbers`: the perturbed numbers a cross-check states, listed after the message so the validator's mention check admits them.
  const execute = async (sop, message = 'problem', numbers = []) => {
    const session = repo.session('base', 'expr', `c${++n}`);
    try {
      const r = await new Agent({repo, session, lexicon, config: {}}).turn(numbers.length ? `${message}\n(${numbers.join(', ')})` : message, {language: 'en', formalizer: {formalize: async () => sop}});
      const p = r.packet ?? {};
      return {status: p.status ?? null, values: (p.answers ?? []).map(a => Object.values(a.binding ?? a)[0]).filter(v => v !== undefined), route: p.route?.chosen ?? null, used: (p.used ?? []).length};
    } catch (error) { return {status: 'error', values: [], error: error.message}; }
    finally { try { repo.discard(session); } catch { /* gone */ } }
  };
  world = {lexicon, execute, dispose: () => fs.rmSync(root, {recursive: true, force: true})};
  return world;
}

const CRATES = 'A crate holds 12 bottles. A shop needs 50 bottles and each crate costs 7 coins. What do the crates cost?';
const crates = registryOf(CRATES);
const analyse = (text, reg = crates) => analyseProgram(readProgram(text), reg);
const codes = a => a.violations.map(v => v.code);
const values = reg => new Map(reg.map(v => [v.index, v.value]));

test('the reader takes numbered lines, shown work, bare Math names and the unused line; structure only', () => {
  const r = readProgram('```\n1. crates = ceil(v2 / v1) = ceil(4.17) = 5\n2) answer = crates * v3;\nunused: none\n```');
  assert.deepEqual(r.lines.map(l => [l.name, l.text]), [['crates', 'Math.ceil(v2 / v1)'], ['answer', 'crates * v3']]);
  assert.equal(readProgram('The answer is 35.'), null);
  assert.deepEqual(readProgram('x = v1\nunused: v2, v3').unused, [2, 3]);
  assert.equal(readProgram('ok = v1 > 2  # a comment').lines[0].text, 'v1 > 2');
});

test('static analysis: references, forbidden constructs, types, coverage, restated and copied registry numbers', () => {
  const ok = analyse('crates = Math.ceil(v2 / v1)\nanswer = crates * v3');
  assert.ok(ok.ok, JSON.stringify(ok.violations));
  assert.deepEqual(evaluateProgram(ok.program, values(crates)), {crates: 5, answer: 35});
  assert.deepEqual(codes(analyse('answer = total * v3\nunused: v1, v2')), ['unknown_name']);
  assert.deepEqual(codes(analyse('answer = v9 * v3\nunused: v1, v2')), ['unknown_registry_index']);
  assert.ok(codes(analyse('answer = String(v1)\nunused: v2, v3')).includes('forbidden_construct'));
  assert.ok(codes(analyse('answer = $v1 + v2 + v3')).includes('forbidden_construct'));
  assert.ok(codes(analyse('answer = process.env\nunused: v1, v2, v3')).includes('forbidden_construct'));
  assert.deepEqual(codes(analyse('ok = v1 > v2\nanswer = ok * v3')), ['type_error']);
  assert.deepEqual(codes(analyse('answer = v1 * v3')), ['unused_number']);
  assert.deepEqual(codes(analyse('v1 = 13\nanswer = v1 * v2 * v3')), ['redefines_registry']);
  const restated = analyse('v1 = 12\nanswer = Math.ceil(v2 / v1) * v3');
  assert.ok(restated.ok && restated.warnings.some(w => w.code === 'restated_registry'));
  // A copied number is its registry index (so perturbing the registry perturbs it); a constant like 60 stays a constant.
  const copied = analyse('answer = Math.ceil(50 / v1) * v3');
  assert.ok(copied.ok && copied.program.used.includes(2), JSON.stringify(copied));
  assert.deepEqual(codes(analyse('answer = v1 +\nunused: v2, v3')), ['parse_error']);
  // A percentage's fraction copied as a constant is the percentage (a program that is not a function of v2 would hide it).
  const pct = analyseProgram(readProgram('answer = v1 * (1 - 0.15)'), registryOf('A price of 80 coins falls by 15%.'));
  assert.ok(pct.ok && pct.program.used.includes(2), JSON.stringify(pct.violations));
  // A sentence written as an answer computes nothing: dropped with a warning; only constant text is no computation at all.
  const prose = analyse('answer1 = Math.ceil(v2 / v1) * v3\nanswer2 = "buy whole crates"');
  assert.ok(prose.ok && prose.program.answers.join() === 'answer1' && prose.warnings.some(w => w.code === 'constant_text_dropped'));
  assert.deepEqual(codes(analyse('answer = "it depends"\nunused: v1, v2, v3')), ['no_computed_answer']);
});

test('units: + - and comparisons need the same unit where the registry knows units', () => {
  const reg = normalizeRegistry([{index: 1, value: 3, span: '3', unit: 'hours'}, {index: 2, value: 20, span: '20', unit: 'minutes'}, {index: 3, value: 60, span: '60', unit: 'minutes'}]);
  assert.deepEqual(codes(analyseProgram(readProgram('answer = v1 + v2\nunused: v3'), reg)), ['unit_mismatch']);
  assert.ok(analyseProgram(readProgram('answer = v1 * v3 + v2'), reg).violations.some(v => v.code === 'unit_mismatch'));
  assert.ok(analyseProgram(readProgram('answer = v2 + v3\nunused: v1'), reg).ok);
});

test('the dataflow graph is the model\'s decomposition: intermediates, depth, dead lines', () => {
  const a = analyse('need = v2\ncrates = Math.ceil(need / v1)\nspare = v1 * crates - need\nanswer = crates * v3');
  assert.ok(a.ok);
  assert.equal(a.program.graph.intermediates, 2);
  assert.equal(a.program.graph.depth, 3);
  assert.ok(a.warnings.some(w => w.code === 'dead_line' && /spare/.test(w.message)));
});

test('lowering: the engines compute what the interpreter computes, for chains, checks, choices, Math and percentages', async () => {
  const w = await executor();
  const cases = [
    [CRATES, 'crates = Math.ceil(v2 / v1)\nanswer = crates * v3', [35]],
    [CRATES, 'answer = v2 <= v1 * 4 && v3 < 10', [false]],
    [CRATES, 'answer = v1 * v3 < 90 ? "crates" : "bottles"\nunused: v2', ['crates']],
    [CRATES, 'answer = Math.max(v1, v2, v3) - Math.min(v1, Math.abs(0 - v3))', [43]],
    ['A price of 80 coins rises by 15% and then falls by 10%. What is the final price?', 'up = v1 * (1 + v2)\nanswer = Math.round(up * (1 - v3) * 100) / 100', [82.8]],
  ];
  for (const [message, text, want] of cases) {
    const reg = registryOf(message), a = analyseProgram(readProgram(text), reg);
    assert.ok(a.ok, `${text}: ${JSON.stringify(a.violations)}`);
    const interp = evaluateProgram(a.program, values(reg));
    assert.deepEqual(a.program.answers.map(n => interp[n]), want);
    const low = lowerProgram(a, reg, {lexicon: w.lexicon});
    const {rest, queries} = splitCircuit(low.sop);
    const r = await w.execute(`${rest}\n${queries[0].text}`, message);
    assert.notEqual(r.status, 'error', r.error);
    assert.equal(r.route, 'js-reference');
    const got = typeof want[0] === 'boolean' ? r.status === 'supported' : r.values[0];
    assert.equal(got, want[0], `${text}\n${low.sop}`);
    assert.ok(r.used > 0, 'the answer carries its support');
  }
});

test('perturbations are reproducible, keep integers and signs, and move stated numbers only', () => {
  const p1 = perturbations(crates, {k: 3, seed: 's'}), p2 = perturbations(crates, {k: 3, seed: 's'});
  assert.deepEqual(p1.map(m => [...m]), p2.map(m => [...m]));
  for (const m of p1) for (const [x, y] of m) { assert.ok(Number.isInteger(y) && y > 0 && y !== x); }
  const sop = '@s1 stated\n  certainty asserted\n  relation "a"\n  role object 12\n  polarity affirmed\n\n@r1 rule\n  when a ?x\n  when compute ?y ?x times 12\n  then b ?y\n';
  const moved = perturbCircuit(sop, new Map([[12, 13]]));
  assert.match(moved, /role object 13/);
  assert.match(moved, /times 12/);
});

/** A tree circuit built independently, by the problem mode's own assembler from named values and formulas. */
const tree = formula => arithmeticCircuit({values: [{name: 'per_crate', value: 12}, {name: 'needed', value: 50}, {name: 'price', value: 7}], formulas: readFormulas(`cost = ${formula}`, ['per_crate', 'needed', 'price']), lexicon: null});

test('cross-check: two formalizations agree on the numbers and on perturbed numbers; a different formula disagrees and names the divergent values', async () => {
  const w = await executor();
  const execute = (sop, numbers) => w.execute(sop, CRATES, numbers);
  const chat = async () => ({ok: true, text: '1. crates = Math.ceil(v2 / v1)\n2. answer = crates * v3'});
  const expr = await expressionFormalize({message: CRATES, chat, lexicon: w.lexicon});
  assert.equal(expr.status, 'ok');
  const agree = await crossCheck({expr, treeSop: tree('ceil(needed / per_crate) * price'), execute, registry: expr.registry, seed: 't'});
  assert.equal(agree.verdict, 'agree', JSON.stringify(agree));
  assert.ok(agree.lowering.ok);
  assert.equal(agree.perturbed.length, 0, 'perturbation is off by default (owner decision 2026-10-03)');
  const off = await crossCheck({expr, treeSop: tree('needed / per_crate * price'), execute, registry: expr.registry, seed: 't'});
  assert.equal(off.verdict, 'disagree');
  assert.ok(off.divergent.expression.some(x => /^crates=5$/.test(x)), JSON.stringify(off.divergent));
  // A tree that happens to give 35 on these numbers agrees on the original numbers; the optional perturbation (k > 0) tells it apart.
  assert.equal((await crossCheck({expr, treeSop: tree('price * 5'), execute, registry: expr.registry, seed: 't'})).verdict, 'agree');
  const perturbed = await crossCheck({expr, treeSop: tree('ceil(needed / per_crate) * price'), execute, registry: expr.registry, seed: 't', k: 3});
  assert.ok(perturbed.verdict === 'agree' && perturbed.perturbed.length === 3 && perturbed.perturbed.every(p => p.agree));
  const lucky = await crossCheck({expr, treeSop: tree('price * 5'), execute, registry: expr.registry, seed: 't', k: 3});
  assert.equal(lucky.verdict, 'disagree');
  assert.equal((await crossCheck({expr, treeSop: null, execute, registry: expr.registry})).verdict, 'single');
  assert.equal(answersAgree([35], [{values: [35]}]), true);
  assert.equal(answersAgree([], [{values: [35]}]), null);
  // Several asked values match as multisets; a repeated value does not cover a missing one.
  assert.equal(answersAgree([130, 140], [{values: [140]}, {values: [130]}]), true);
  assert.equal(answersAgree([130, 130], [{values: [130]}, {values: [140]}]), false);
  // A choice: the top option and the listed scores.
  assert.equal(answersAgree(['b'], [{rank: true, values: ['B', 'A']}, {values: ['A', 'B']}]), true);
});

test('one more question on a violation, naming it; refused after the second; no answer is unavailable', async () => {
  const asked = [];
  const answers = ['answer = total * v3', '1. crates = Math.ceil(v2 / v1)\n2. answer = crates * v3'];
  const ok = await expressionFormalize({message: CRATES, chat: async m => { asked.push(m.at(-1).content); return {ok: true, text: answers.shift()}; }});
  assert.equal(ok.status, 'ok');
  assert.equal(ok.attempts.length, 2);
  assert.match(asked[1], /previous answer had a problem: .*total/);
  const bad = await expressionFormalize({message: CRATES, chat: async () => ({ok: true, text: 'answer = 35'})});
  assert.equal(bad.status, 'rejected');
  assert.equal((await expressionFormalize({message: CRATES, chat: async () => ({ok: false, reason: 'down'})})).status, 'unavailable');
  assert.equal((await expressionFormalize({message: 'No numbers here.', chat: async () => ({ok: true, text: ''})})).status, 'no_numbers');
});

test.after(async () => (await executor()).dispose());

test('N-way selection: the largest agreeing cluster wins; a tie cascades; no majority is unresolved, never a guess', async () => {
  const {selectByAgreement} = await import('../../lib/formalize/dual-check.mjs');
  const w = await executor();
  const execute = (sop, numbers) => w.execute(sop, CRATES, numbers);
  const expr = async (name, text) => ({name, kind: 'expr', result: await expressionFormalize({message: CRATES, chat: async () => ({ok: true, text}), lexicon: w.lexicon})});
  const right = 'crates = Math.ceil(v2 / v1)\nanswer = crates * v3', wrong = 'answer = v2 / v1 * v3';
  const two = await selectByAgreement([await expr('a', right), await expr('b', wrong), {name: 'tree', kind: 'tree', sop: tree('ceil(needed / per_crate) * price')}], {registry: crates, execute, seed: 'n'});
  assert.equal(two.status, 'selected');
  assert.equal(two.chosen, 'a');
  assert.deepEqual(two.answers, [35]);
  assert.deepEqual(two.clusters[0], ['a', 'tree']);
  let asked = 0;
  const tie = await selectByAgreement([await expr('a', right), await expr('b', wrong)], {registry: crates, execute, seed: 'n', cascade: async () => { asked++; return expr('small', wrong); }});
  assert.equal(asked, 1);
  assert.equal(tie.status, 'selected');
  assert.equal(tie.chosen, 'b');
  assert.ok(tie.cascaded);
  const none = await selectByAgreement([await expr('a', right), await expr('b', wrong)], {registry: crates, execute, seed: 'n', cascade: async () => null});
  assert.equal(none.status, 'unresolved');
  assert.deepEqual(none.answers, []);
  // Without perturbation a yes/no answer needs three agreeing formalizations (owner decision 2026-10-03), a value two.
  const yes2 = await selectByAgreement([await expr('a', 'answer = v2 > v1\nunused: v3'), await expr('b', 'answer = v3 < v2\nunused: v1')], {registry: crates, execute});
  assert.equal(yes2.status, 'unresolved');
  const yes3 = await selectByAgreement([await expr('a', 'answer = v2 > v1\nunused: v3'), await expr('b', 'answer = v3 < v2\nunused: v1'), await expr('c', 'answer = v1 < v2\nunused: v3')], {registry: crates, execute});
  assert.equal(yes3.status, 'selected'); assert.deepEqual(yes3.answers, [true]);
});

test('exemplars: retrieval by registry shape, nearest first, leave-one-out by the caller', async () => {
  const {exemplarOf, retrieve, shapeOf} = await import('../../lib/formalize/exemplars.mjs');
  const index = [
    exemplarOf({id: 'p1', registry: registryOf('Ann has 3 boxes of 12 pens.'), program: 'answer = v1 * v2'}),
    exemplarOf({id: 'p2', registry: registryOf('A price of 80 falls by 15% and rises by 10%.'), program: 'answer = v1 * (1 - v2) * (1 + v3)'}),
    exemplarOf({id: 'p3', registry: registryOf('A crate holds 10 bottles; 40 are needed; a crate costs 6.'), program: 'answer = Math.ceil(v2 / v1) * v3'}),
  ];
  assert.deepEqual(shapeOf(registryOf('Up 5% then down 2% from 300.')).pct, 2);
  assert.deepEqual(retrieve(index, crates, {k: 1}).map(x => x.id), ['p3']);
  assert.deepEqual(retrieve(index, registryOf('From 200, up 12% then down 4%.'), {k: 1}).map(x => x.id), ['p2']);
  assert.deepEqual(retrieve(index, crates, {k: 1, exclude: r => r.id === 'p3'}).map(x => x.id), ['p1']);
});

