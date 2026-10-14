// The step-by-step protocol as base-memory data (AGENTS.md "Formalization improvement"; lib/formalize/protocol-data.mjs): the problem
// questions, their order per kind, their conditions and early exits come from formalizer-protocol-v1/0060-problem.sop; the learned-rules
// layer adds hints and replaces texts; both LocalLLMStepByStep and InternalReasoningStepByStep read the same layers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {protocolData, useLearnedLayer, factsOf} from '../../lib/formalize/protocol-data.mjs';
import {problemCircuit, problemQuestions, problemKinds} from '../../lib/query-author/step-by-step/problem.mjs';
import {loadProtocol, internalReasoningQuery, createReasoningOracle} from '../../lib/formalize/internal-reasoning/index.mjs';
import {demoLexicon} from '../../lib/knowledge-seeds.mjs';
import {validateQuery} from '../../lib/query-author/validate.mjs';
import {createWorld} from '../../tools/eval/symbolic-vs-llm/world.mjs';

const lexicon = demoLexicon();

/** A scripted step-by-step oracle: answers by question name; records the names asked. */
function oracleOf(answers) {
  const asked = [];
  return {asked, async read(name, text, reader, again) {
    asked.push(name);
    const first = reader(answers[name] ?? '');
    if (first !== null) return first;
    asked.push(`${name}_again`);
    const second = reader(answers[`${name}_again`] ?? '');
    if (second !== null) return second;
    throw new Error('unreadable');
  }};
}

test('the problem kinds, texts and order are protocol data; facts are indexed without the fp_ namespace', () => {
  const data = protocolData();
  assert.deepEqual(problemKinds(data).map(([k]) => k), ['compute', 'choose', 'deduce', 'other']);
  assert.match(problemQuestions.kind(data), /^Answer about the same request\. .*\n1\. one or more numbers.*\n4\. none of these\nReply with the number only\.$/s);
  assert.match(problemQuestions.formulas(['a', 'b'], 'choose', data), /The values are: a, b\.\n.* Write one line per option, for the number the options are judged by\. Do not compute the result\.$/s);
  assert.doesNotMatch(problemQuestions.formulas(['a'], 'compute', data), /one line per option/);
  assert.deepEqual(data.rows('problem_step').filter(r => r[0] === 'deduce').map(r => r[2]), ['problem_facts', 'problem_rules', 'problem_question']);
  assert.deepEqual(factsOf([{text: '@x fact\n  holds fp_hint problem_values "a \\"b\\""\n@y rule\n  when fp_kind ?k\n  then fp_needed x none\n'}]).get('hint'), [['problem_values', 'a "b"']]);
});

test('problem mode follows the protocol order: compute asks the asked values only with several formulas, choose asks the direction only with options', async () => {
  const message = 'Pens cost 1.5 each; Ana buys 12. Plan A costs 400 and Plan B 150.';
  const compute = oracleOf({problem_kind: '1', problem_values: 'price = 1.5\nquantity = 12', problem_formulas: 'total = price * quantity'});
  const r1 = await problemCircuit(compute, {message, lexicon});
  assert.deepEqual(compute.asked, ['problem_kind', 'problem_values', 'problem_formulas']);
  assert.ok(validateQuery({sop: r1.sop, message, lexicon, mode: 'id', mentions: []}).ok);
  const choose = oracleOf({problem_kind: '2', problem_values: 'cost_plan_a = 400\ncost_plan_b = 150', problem_formulas: 'a = cost_plan_a\nb = cost_plan_b', problem_options: 'Plan A = a\nPlan B = b', problem_direction: '1'});
  const r2 = await problemCircuit(choose, {message, lexicon});
  assert.deepEqual(choose.asked, ['problem_kind', 'problem_values', 'problem_formulas', 'problem_options', 'problem_direction']);
  assert.equal(r2.report.direction, 'lowest');
  assert.match(r2.sop, /rank lowest \?v/);
  // An exit kind and an unreadable required answer end problem mode (null), without further questions.
  const other = oracleOf({problem_kind: '4'});
  assert.equal(await problemCircuit(other, {message, lexicon}), null);
  assert.deepEqual(other.asked, ['problem_kind']);
  const unreadable = oracleOf({problem_kind: '1', problem_values: 'no numbers here'});
  assert.equal(await problemCircuit(unreadable, {message, lexicon}), null);
  assert.deepEqual(unreadable.asked, ['problem_kind', 'problem_values', 'problem_values_again']);
});

test('the learned layer adds hints and replaces texts for both strategies; restoring it restores the shipped protocol', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learned-'));
  fs.writeFileSync(path.join(dir, '0001-learned.sop'), '@fp_l1 fact\n  holds fp_hint problem_formulas "Write the formula of the final answer last."\n@fp_l2 fact\n  holds fp_question_text problem_question "Which thing and property does the question ask about? One line `thing | property`."\n');
  const before = loadProtocol().version;
  const restore = useLearnedLayer(dir);
  try {
    const data = protocolData();
    assert.match(problemQuestions.formulas(['a'], 'compute', data), /Do not compute the result\.\nWrite the formula of the final answer last\.$/);
    assert.match(problemQuestions.question(data), /^Which thing and property/);
    assert.notEqual(loadProtocol().version, before, 'InternalReasoningStepByStep reads the same learned layer');
    assert.equal(loadProtocol().questions.get('problem_question').text, 'Which thing and property does the question ask about? One line `thing | property`.');
  } finally { restore(); fs.rmSync(dir, {recursive: true, force: true}); }
  assert.equal(loadProtocol().version, before);
});

test('InternalReasoningStepByStep: the kind `problem` plans the problem questions and assembles their circuit', async () => {
  const world = createWorld('@unit_cost predicate\n  args subject:entity object:integer\n  label en "costs"\n');
  try {
    const protocol = loadProtocol();
    const kinds = protocol.questions.get('ask_kind').choices.map(c => c.value);
    const answers = [[/Which kind of answer/, String(kinds.indexOf('problem') + 1)], [/For each line, do the words/, 'A: no\nB: no\nC: no\nD: no\nE: no\nF: no\nG: yes'],
      [/What does it ask for\?/, '1'], [/List every number the problem gives/, 'price = 1.5\nquantity = 12'], [/Write how each value/, 'total = price * quantity']];
    const chat = async messages => ({ok: true, text: answers.find(([re]) => re.test(messages.at(-1).content))?.[1] ?? '0', ms: 1, usage: {input_tokens: 1, output_tokens: 1}});
    const r = await internalReasoningQuery({message: 'Pens cost 1.5 each. What do 12 pens cost?', lexicon: world.lexicon, repo: world.repo, session: world.session, oracle: createReasoningOracle({chat, protocol}), protocol});
    assert.equal(r.status, 'validated', JSON.stringify(r.validation?.problems));
    assert.match(r.sop, /compute \?t1 \?v_price times \?v_quantity/);
    assert.deepEqual(r.trace.filter(e => e.chosen).map(e => e.chosen.split(' ')[0]), ['ask_kind', 'ask_acts', 'ask_problem', 'assemble']);
  } finally { world.dispose(); }
});

test('formulas read max(...) and min(...) as chains of the exact compute words; the final results are always queried', async () => {
  const {readFormula, readFormulas, arithmeticCircuit} = await import('../../lib/query-author/step-by-step/problem.mjs');
  assert.deepEqual(readFormula('max(a, b + 1, c)', new Set(['a', 'b', 'c'])).lines, ['compute ?t1 ?v_b plus 1', 'compute ?t2 ?v_a maximum_with ?t1', 'compute ?t3 ?t2 maximum_with ?v_c']);
  const formulas = readFormulas('part = a + b\ntotal = part * 2', ['a', 'b']);
  const sop = arithmeticCircuit({values: [{name: 'a', value: 1}, {name: 'b', value: 2}], formulas, asked: ['part'], lexicon});
  assert.match(sop, /@q query[\s\S]*relation "part"[\s\S]*@q2 query[\s\S]*relation "total"/, 'the asked value first, then the final result');
});

test('record and replay: a recorded answer is replayed without the model; a strict replay names a new question as a miss', async () => {
  const {replayChat} = await import('../../lib/formalize/replay-cache.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-'));
  try {
    let live = 0;
    const chat = async () => ({ok: true, text: String(++live), usage: {}});
    const fill = replayChat(chat, {dir, mode: 'fill', model: 'tier:tiny'});
    const messages = [{role: 'system', content: 's'}, {role: 'user', content: 'q1'}];
    assert.equal((await fill(messages, 8)).text, '1');
    assert.equal((await fill(messages, 8)).text, '1', 'the second ask is replayed');
    assert.equal(live, 1);
    const strict = replayChat(chat, {dir: dir, mode: 'replay', model: 'tier:tiny'});
    assert.equal((await strict(messages, 8)).text, '1');
    const miss = await strict([...messages, {role: 'user', content: 'q2'}], 8);
    assert.equal(miss.ok, false);
    assert.match(miss.reason, /^replay_miss: .*q2/);
    assert.equal(live, 1, 'a strict replay never calls the model');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
