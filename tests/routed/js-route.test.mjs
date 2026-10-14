import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readWires, admitJsProgram, lowerJsProgram, runOracle, jsMessages, jsFormalize, jsCircuit} from '../../lib/formalize/js-program.mjs';
import {routeOf} from '../../lib/formalize/structure/route.mjs';
import {registryOf} from '../../lib/formalize/expression-program.mjs';
import {splitCircuit} from '../../lib/formalize/dual-check.mjs';
import {parse} from '../../sop/parser.mjs';
import {Repository} from '../../memory/repository.mjs';
import {Agent} from '../../server/agent.mjs';
import {seedLexicon} from '../../lib/knowledge-seeds.mjs';

const SHOP = 'Pens cost 3 dollars and notebooks cost 5 dollars. Ann buys 4 pens and 2 notebooks, with a 10% discount. Boxes weigh 12, 7 and 9 kg; a box over 8 kg costs 2 dollars to ship. Who pays more, Ann or the shipping?';
const reg = registryOf(SHOP);
const admit = text => admitJsProgram(readWires(text), reg, SHOP);
const codes = a => a.violations.map(v => v.code);

let world = null;
/** The product's engines over a small memory (one Agent turn per circuit, as tests/routed/expression-program.test.mjs). */
async function executor() {
  if (world) return world;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jsroute-'));
  const repo = new Repository(root, {memory: JSON.parse(fs.readFileSync(new URL('../../config/runtime.json', import.meta.url), 'utf8')).memory});
  repo.init('base');
  const lexicon = seedLexicon('core-min');
  let n = 0;
  const execute = async sop => {
    const session = repo.session('base', 'js', `c${++n}`);
    try {
      const r = await new Agent({repo, session, lexicon, config: {}}).turn(`values: ${reg.map(v => v.value).join(' ; ')}`, {language: 'en', formalizer: {formalize: async () => sop}});
      const p = r.packet ?? {};
      return {status: p.status ?? null, values: (p.answers ?? []).map(a => Object.values(a.binding ?? a)[0]).filter(v => v !== undefined)};
    } catch (error) { return {status: 'error', values: [], error: error.message}; }
    finally { try { repo.discard(session); } catch { /* gone */ } }
  };
  world = {execute, dispose: () => fs.rmSync(root, {recursive: true, force: true})};
  return world;
}
test.after(() => world?.dispose());

test('the reader takes jsEval wires, joins continued expressions and ignores fences', () => {
  const w = readWires('```sop\n@cost jsEval\n  expr $v1 * $v3 +\n    $v2 * $v4\n@answer jsEval\n  expr $cost\n```');
  assert.deepEqual(w.map(x => [x.id, x.type, x.expr]), [['cost', 'jsEval', '$v1 * $v3 + $v2 * $v4'], ['answer', 'jsEval', '$cost']]);
  assert.deepEqual(readWires('The answer is 12.'), []);
  // A wire has one field: an indented line without a keyword under the header is its expression; a field line is not a continuation.
  assert.deepEqual(readWires('@a jsEval\n  ($v1 - $v3) / 2\n@b jsEval\n  expr $a\n  data 3').map(x => [x.id, x.expr, x.extra ?? null]), [['a', '($v1 - $v3) / 2', null], ['b', '$a', ['data 3']]]);
});

test('admission: an admitted program is evaluated on the registry, percentages as fractions', () => {
  const a = admit('@ann jsEval\n  expr ($v3 * $v1 + $v4 * $v2) * (1 - $v5)\n@ship jsEval\n  expr count([$v6, $v7, $v8], w => w > $v9) * $v10\n@answer jsEval\n  expr $ann > $ship ? "Ann" : "the shipping"');
  assert.ok(a.ok, JSON.stringify(a.violations));
  assert.deepEqual(a.values, {ann: 19.8, ship: 4, answer: 'Ann'});
  assert.deepEqual(a.answers, ['answer']);
});

test('admission refuses what is not a pure expression over the registry and earlier wires', () => {
  assert.deepEqual(codes(admit('@a value\n  data 3')), ['js_route_type']);
  assert.deepEqual(codes(admit('@v1 jsEval\n  expr 4')), ['js_redefines_registry']);
  assert.deepEqual(codes(admit('@a jsEval\n  expr $v1\n@a jsEval\n  expr $v2')), ['js_duplicate_name']);
  // A wire reads only earlier wires: no forward reference, no self reference, hence no cycle and no recursion.
  assert.deepEqual(codes(admit('@a jsEval\n  expr $b + 1\n@b jsEval\n  expr $v1')), ['js_unknown_reference']);
  assert.deepEqual(codes(admit('@a jsEval\n  expr $a + $v1')), ['js_unknown_reference']);
  assert.deepEqual(codes(admit('@a jsEval\n  expr $v99 + 1')), ['js_unknown_registry_index']);
  assert.deepEqual(codes(admit('@a jsEval\n  expr ?x + $v1')), ['js_variable']);
  assert.deepEqual(codes(admit('@a jsEval\n  expr $v1 > 2 ? "Bob" : "Ann"')), ['js_text_not_in_message']);
  assert.deepEqual(codes(admit('@a jsEval\n  expr [$v1].map(x => { return x })')), ['js_parse_error']);
  assert.deepEqual(codes(admit('@a jsEval\n  expr $v1 + process.env')), ['js_runtime_error']);
  assert.deepEqual(codes(admit('@a jsEval\n  expr range(4096).map(i => range(4000 + $v1))')), ['js_runtime_error']);
  assert.deepEqual(codes(admit('@a jsEval\n  expr ({x: $v1})')), ['js_answer_shape']);
  assert.deepEqual(codes(admit('@a jsEval\n  expr $v1 * 2\n  data 3')), ['js_extra_field']);
});

test('admission keeps the data dependency: an answer must reach a number of the problem', () => {
  assert.deepEqual(codes(admit('@answer jsEval\n  expr 19.8')), ['js_answer_not_from_data']);
  assert.deepEqual(codes(admit('@k jsEval\n  expr 7 * 3\n@answer jsEval\n  expr $k + 1')), ['js_answer_not_from_data']);
  assert.deepEqual(codes(admit('@k jsEval\n  expr $v1\n@answer1 jsEval\n  expr $k\n@answer2 jsEval\n  expr 4')), ['js_answer_not_from_data']);
  // Member keys are names, not text of the problem.
  assert.ok(admit('@answer jsEval\n  expr [{c: $v1}, {c: $v2}].map(r => r.c).length').ok);
});

test('lowering unrolls arrays of fixed shape to compute/compare rules that the engines execute like the oracle', async () => {
  const programs = [
    '@ann jsEval\n  expr ($v3 * $v1 + $v4 * $v2) * (1 - $v5)\n@answer jsEval\n  expr Math.round($ann)',
    '@w jsEval\n  expr [$v6, $v7, $v8]\n@answer jsEval\n  expr count($w, x => x > $v9) * $v10',
    '@answer jsEval\n  expr sum([$v6, $v7, $v8].filter(x => x > $v9))',
    '@answer jsEval\n  expr [$v6, $v7, $v8].map(x => x * $v10).reduce((a, x) => a + x, 0)',
    '@answer jsEval\n  expr max([$v6, $v7, $v8]) - min([$v6, $v7, $v8])',
    '@answer jsEval\n  expr [{name: "Ann", c: $v1 * $v3}, {name: "the shipping", c: $v10 * 2}].reduce((b, x) => x.c > b.c ? x : b).name',
    '@answer jsEval\n  expr [$v6, $v7, $v8].includes($v9 + 4)',
    '@answer jsEval\n  expr sum(range(4).map(i => i * $v1))',
  ];
  const w = await executor();
  for (const p of programs) {
    const a = admit(p);
    assert.ok(a.ok, `${p}\n${JSON.stringify(a.violations)}`);
    const low = lowerJsProgram(a, reg);
    assert.ok(low.lowered, `${p}\n${low.why}`);
    assert.doesNotMatch(low.sop, /jsEval/);
    const oracle = (await runOracle(a, reg)).answers[0].value;
    const {rest, queries} = splitCircuit(low.sop);
    const r = await w.execute(`${rest}\n${queries[0].text}`);
    assert.notEqual(r.status, 'error', r.error);
    const got = typeof oracle === 'boolean' ? r.status === 'supported' : r.values[0];
    assert.equal(got, oracle, `${p}\n${low.sop}`);
  }
});

test('a fixed list answer is one answer per item; a data-dependent shape stays jsEval for the oracle', async () => {
  const list = lowerJsProgram(admit('@answer jsEval\n  expr [$v6, $v7].map(x => x * $v10)'), reg);
  assert.ok(list.lowered, list.why);
  assert.deepEqual(list.queries.map(q => q.name), ['answer_1', 'answer_2']);
  for (const [p, why] of [['@answer jsEval\n  expr sum(range($v1).map(i => i * $v2))', /range over data/], ['@answer jsEval\n  expr [$v6, $v7, $v8].sort((a, b) => b - a)[0]', /sort/],
    ['@answer jsEval\n  expr [$v6, $v7, $v8].filter(x => x > $v9)', /data-dependent length/], ['@answer jsEval\n  expr String($v1) + " dollars"', /String/]]) {
    const a = admit(p);
    assert.ok(a.ok, JSON.stringify(a.violations));
    const low = lowerJsProgram(a, reg);
    assert.equal(low.lowered, false);
    assert.match(low.why, why);
  }
  // The oracle runs the trusted circuit: registry values, then the model's jsEval wires.
  const a = admit('@answer jsEval\n  expr [$v6, $v7, $v8].sort((a, b) => b - a)[0]');
  assert.equal((await runOracle(a, reg)).answers[0].value, 12);
  assert.ok(parse(jsCircuit(a, reg)).wires.some(x => x.type === 'jsEval'));
  // A dead step does not keep the answer from the engines.
  assert.ok(lowerJsProgram(admit('@s jsEval\n  expr [$v6, $v7].sort((a, b) => a - b)\n@answer jsEval\n  expr $v1 + $v2'), reg).lowered);
});

test('the question is the js-v1 role prompt with the registry; a violation is asked once more with the first reply', async () => {
  const m = jsMessages(SHOP, reg);
  assert.equal(m.length, 2);
  assert.match(m[1].content, /v5 = 10% \(a percentage: \$v5 is 0\.1\)/);
  assert.match(m[1].content, /\$v1 to \$v10/);
  const seen = [];
  const replies = ['@answer jsEval\n  expr 19.8', '@answer jsEval\n  expr $v1 * $v3 + $v2 * $v4'];
  const r = await jsFormalize({message: SHOP, chat: async messages => { seen.push(messages); return {ok: true, text: replies[seen.length - 1]}; }});
  assert.equal(r.status, 'ok');
  assert.equal(r.attempts.length, 2);
  assert.equal(seen[1][2].role, 'assistant');
  assert.match(seen[1][3].content, /does not depend on any number/);
  assert.equal(r.admitted.values.answer, 22);
  assert.ok(r.lowering.lowered);
  assert.equal((await jsFormalize({message: 'Is the sky blue?', chat: async () => ({ok: true, text: ''})})).status, 'no_numbers');
});

test('routing reads only the structure labels and the registry', () => {
  const text = 'A crate holds 12 bottles. How many crates are needed for 50 bottles?';
  const span = (label, t) => ({text: t, start: text.indexOf(t), end: text.indexOf(t) + t.length});
  const ex = (labels) => ({entities: Object.fromEntries(labels.map(([l, t]) => [l, [span(l, t)]]))});
  assert.equal(routeOf(ex([['quantity', '12 bottles'], ['goal', 'How many crates are needed']]), text).route, 'js');
  assert.equal(routeOf(ex([['goal', 'How many crates are needed']]), text).route, 'fol');
  assert.equal(routeOf(ex([['quantity', '12 bottles'], ['goal', 'A crate holds']]), text).route, 'fol');
  assert.equal(routeOf(null, text).route, 'fol');
  const logic = 'Every bird can fly. Tweety is a bird. Can Tweety fly?';
  assert.equal(routeOf({entities: {rule: [{text: 'Every bird can fly', start: 0, end: 18}], goal: [{text: 'Can Tweety fly', start: 37, end: 51}]}}, logic).route, 'fol');
});
