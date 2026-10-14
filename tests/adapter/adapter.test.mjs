import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {Repository} from '../../memory/repository.mjs';
import {demoLexicon, seedLexicon} from '../../lib/knowledge-seeds.mjs';
import {Agent} from '../../server/agent.mjs';
import {createServer} from '../../server/http.mjs';
import {createChatSOPAdapter, checkAdapterOptions, adapterSettings, registerMode, decideAgreement, valuesAgree, finalAnswerOf, scratchExecutor} from '../../lib/adapter/index.mjs';
import {adapterReply, verificationFacts} from '../../lib/adapter/reply.mjs';
import {EXPRESSION_SYSTEM} from '../../lib/formalize/expression-program.mjs';
import {ENGINE_CODE_SYSTEM} from '../../lib/adapter/paths/engine-code.mjs';
import {listen, tempDir, stubQueryParser} from '../helpers.mjs';

// One compute problem and one deduction, with the structure spans a structure tier would mark (offsets into the text).
const SHOP = 'Pens cost 3 dollars each. Ann buys 4 pens. How much does Ann pay?';
const span = (text, part) => ({text: part, start: text.indexOf(part), end: text.indexOf(part) + part.length, confidence: null});
const SHOP_STRUCTURE = {entities: {quantity: [span(SHOP, '3 dollars'), span(SHOP, '4 pens')], goal: [span(SHOP, 'How much does Ann pay')], entity: [span(SHOP, 'Ann')]}, relations: []};
const BIRD = 'Tweety is a bird. Is Tweety a bird?';
const BIRD_STRUCTURE = {entities: {entity: [span(BIRD, 'Tweety')]}, relations: []};

/**
 * Fake proxy tiers: the chat completions answer by the question's system message (path B, jsEval, engineCode, the direct answer);
 * /v1/structure and /v1/fol answer by the problem. `replies` overrides the defaults; `calls` counts the questions by kind.
 */
function fakeTiers(replies = {}) {
  const calls = {B: 0, jsEval: 0, engineCode: 0, direct: 0, structure: 0, fol: 0};
  const defaults = {B: '1. answer = v1 * v2\nunused: none', jsEval: '@answer jsEval\n  expr $v1 * $v2', engineCode: '```js\nreturn v1 * v2;\n```', direct: 'Four pens at 3 dollars.\nFINAL ANSWER: 12 dollars'};
  const reply = {...defaults, ...replies};
  const json = body => ({ok: true, status: 200, headers: {get: () => null}, json: async () => body, text: async () => JSON.stringify(body)});
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith('/v1/structure')) { calls.structure++; return json(body.text === SHOP ? SHOP_STRUCTURE : BIRD_STRUCTURE); }
    if (url.endsWith('/v1/fol')) { calls.fol++; return json({results: body.inputs.map(() => ({candidates: ['Bird(tweety)']}))}); }
    const system = body.messages[0].content;
    const kind = system === EXPRESSION_SYSTEM ? 'B' : system === ENGINE_CODE_SYSTEM ? 'engineCode' : /jsEval/.test(system) ? 'jsEval' : 'direct';
    calls[kind]++;
    return json({choices: [{message: {content: reply[kind]}, finish_reason: 'stop'}], usage: {completion_tokens: 5}});
  };
  return {fetchImpl, calls};
}

let executor = null;
const engines = async () => (executor ??= await scratchExecutor());
test.after(() => executor?.dispose());

async function adapterWith(replies = {}, routed = {}) {
  const tiers = fakeTiers(replies);
  const config = {adapter: {routed: {engineCodeLanguages: ['js'], ...routed}}};
  return {adapter: createChatSOPAdapter({config, fetchImpl: tiers.fetchImpl, executor: await engines()}), calls: tiers.calls};
}

test('routed: path B and a second formalization that agree verify the answer; the third is not asked', async () => {
  const {adapter, calls} = await adapterWith();
  const a = await adapter.answer({message: SHOP, mode: 'routed'});
  assert.equal(a.object, 'chatsop.answer');
  assert.equal(a.mode, 'routed');
  assert.equal(a.route.route, 'js');
  assert.equal(a.path, 'B');
  assert.deepEqual(a.answer.values, [12]);
  assert.equal(a.verification.status, 'verified');
  assert.deepEqual(a.verification.paths, ['B', 'jsEval']);
  assert.equal(calls.engineCode, 0, 'early stop: engineCode is not asked once B and jsEval agree');
  assert.ok(a.circuits[0].sop.includes('stated'), 'the answering circuit is reported');
  assert.ok(a.proofs.length > 0, 'the engines give a proof');
  for (const stage of ['structure', 'B', 'jsEval', 'total']) assert.equal(typeof a.timings[stage], 'number');
  assert.deepEqual(a.tiers, {structure: 'structure', compute: 'tiny'});
  assert.ok(a.packet && a.packet.status, 'the runtime packet of the answering path');
});

test('routed: a disagreeing second formalization makes engineCode the tie-breaker; a lone path is unverified', async () => {
  const {adapter, calls} = await adapterWith({jsEval: '@answer jsEval\n  expr $v1 * $v2 + 1'});
  const a = await adapter.answer({message: SHOP, mode: 'routed'});
  assert.equal(a.verification.status, 'verified');
  assert.deepEqual(a.verification.paths, ['B', 'engineCode:js']);
  assert.deepEqual(a.verification.alternatives, [{path: 'jsEval', values: [13]}]);
  assert.equal(calls.engineCode, 1);
  const lone = await (await adapterWith()).adapter.answer({message: SHOP, mode: 'routed', options: {routed: {second: []}}});
  assert.equal(lone.verification.status, 'unverified');
  assert.deepEqual(lone.verification.paths, ['B']);
  const split = await (await adapterWith({jsEval: '@answer jsEval\n  expr $v1 * $v2 + 1', engineCode: '```js\nreturn v1 + v2;\n```'})).adapter.answer({message: SHOP, mode: 'routed'});
  assert.equal(split.verification.status, 'unresolved');
  assert.equal(split.path, 'B', 'the primary formalization answers, the others are reported');
  assert.equal(split.verification.alternatives.length, 2);
});

test('routed: a problem without a goal over quantities goes to FOL, executed on the engines', async () => {
  const {adapter, calls} = await adapterWith();
  const a = await adapter.answer({message: BIRD, mode: 'routed'});
  assert.equal(a.route.route, 'fol');
  assert.equal(a.path, 'fol');
  assert.equal(calls.B, 0);
  assert.equal(calls.fol, 1);
  assert.equal(a.verification.status, 'unverified');
  assert.deepEqual(a.answer.values, [true]);
});

test('direct-verified: verified, contradicted and unverified', async () => {
  const ok = await adapterWith();
  const v = await ok.adapter.answer({message: SHOP, mode: 'direct-verified'});
  assert.equal(v.path, 'direct');
  assert.equal(v.answer.text, '12 dollars');
  assert.equal(v.verification.status, 'verified');
  assert.deepEqual(v.verification.paths, ['direct', 'B']);
  assert.equal(v.verification.check, 'number');
  assert.equal(ok.calls.jsEval, 0, 'early stop once a symbolic path verifies the answer');
  assert.deepEqual(v.tiers, {direct: 'tiny', structure: 'structure', compute: 'tiny'});

  const c = await (await adapterWith({direct: 'FINAL ANSWER: 15'})).adapter.answer({message: SHOP, mode: 'direct-verified'});
  assert.equal(c.verification.status, 'contradicted');
  assert.equal(c.verification.model_answer, '15');
  assert.deepEqual(c.answer.values, [12], 'the value two formalizations agree on is answered');
  assert.deepEqual(c.verification.paths, ['B', 'jsEval', 'engineCode:js'], 'no early stop: every formalization is asked');

  const u = await (await adapterWith({direct: 'FINAL ANSWER: 15'})).adapter.answer({message: SHOP, mode: 'direct-verified', options: {routed: {second: []}}});
  assert.equal(u.verification.status, 'unverified');
  assert.equal(u.path, 'direct');
  assert.equal(u.answer.text, '15');
});

test('stepwise: the chat turn of the session with its circuit author; the adapter records the path', async t => {
  const root = tempDir(t, 'adapter-stepwise-');
  const repo = new Repository(root);
  repo.init('base');
  const agent = new Agent({repo, session: repo.session('base', 'u', 'c'), lexicon: demoLexicon(), config: {}});
  const sop = '@q query\n  where match\n    relation "likes"\n    role subject "Ana"\n    role object "Alpha Lab"\n    polarity affirmed\n  end';
  const adapter = createChatSOPAdapter({config: {}});
  const a = await adapter.answer({message: 'Does Ana like Alpha Lab?', stepwise: {agent, formalizer: {id: 'stub', formalize: async () => sop}}});
  assert.equal(a.mode, 'stepwise');
  assert.equal(a.path, 'stepwise');
  assert.equal(a.verification.status, 'unverified');
  assert.equal(typeof a.answer.text, 'string');
  assert.equal(a.turn.sop, sop);
});

test('settings, options and the mode registry', () => {
  assert.equal(adapterSettings({}).mode, 'stepwise');
  assert.equal(adapterSettings({adapter: {mode: 'routed'}}).mode, 'routed');
  assert.deepEqual(adapterSettings({adapter: {routed: {second: ['jsEval']}}}).routed.second, ['jsEval']);
  assert.throws(() => adapterSettings({}, {mode: 'oracle'}), /adapter mode/);
  assert.deepEqual(checkAdapterOptions({mode: 'routed', options: {tiers: {compute: 'small'}}}), {mode: 'routed', tiers: {compute: 'small'}});
  assert.throws(() => checkAdapterOptions({mode: 'nope'}), /adapter.mode/);
  assert.throws(() => checkAdapterOptions({mode: 'routed', options: {prompt: 'x'}}), /unknown adapter option/);
  registerMode('ensemble-test', async () => ({results: [], chosen: null, verification: {status: 'unresolved', paths: []}, timings: {}, tiers: {}}));
  assert.equal(checkAdapterOptions({mode: 'ensemble-test'}).mode, 'ensemble-test');
});

test('agreement and the direct reader are structural', () => {
  assert.ok(valuesAgree([12, 12], [12.0000001]));
  assert.ok(valuesAgree(['A'], ['a']));
  assert.ok(!valuesAgree([12, 5], [12]));
  const r = (path, values) => ({path, status: 'ok', values, answers: values.map(value => ({value}))});
  assert.equal(decideAgreement([r('B', [1]), r('jsEval', [2]), r('engineCode:js', [2])]).status, 'verified');
  assert.deepEqual(decideAgreement([r('B', [1]), r('jsEval', [2]), r('engineCode:js', [2])]).paths, ['jsEval', 'engineCode:js']);
  assert.equal(decideAgreement([r('engineCode:js', [2]), r('engineCode:smt', [2])]).sameCall, true);
  assert.equal(finalAnswerOf('work...\n**Final answer:** 42 km.'), '42 km');
  assert.deepEqual(finalAnswerOf('FINAL ANSWER: x = 3 + 4 = 7'), {invalid: 'the final answer must be the answer only, short, without a calculation'});
  assert.equal(finalAnswerOf('no marker'), null);
});

test('the reply shows the verification status through the conversation layer (no phrasing in code)', async t => {
  const {adapter} = await adapterWith();
  const root = tempDir(t, 'adapter-reply-');
  const repo = new Repository(root);
  repo.init('base');
  const agent = new Agent({repo, session: repo.session('base', 'u', 'c'), lexicon: seedLexicon('core-min'), config: {}});
  const cases = [
    [await adapter.answer({message: SHOP, mode: 'routed'}), 'answer_verified'],
    [await adapter.answer({message: SHOP, mode: 'direct-verified'}), 'answer_model_verified'],
    [await (await adapterWith({direct: 'FINAL ANSWER: 15'})).adapter.answer({message: SHOP, mode: 'direct-verified'}), 'answer_contradicted'],
    [await (await adapterWith({direct: 'FINAL ANSWER: 15'})).adapter.answer({message: SHOP, mode: 'direct-verified', options: {routed: {second: []}}}), 'answer_model_unverified'],
    [await adapter.answer({message: BIRD, mode: 'routed'}), 'answer_formalized_unverified'],
  ];
  const layer = fs.readFileSync(new URL('../../config/knowledge/conversation-v1/0080-verification.sop', import.meta.url), 'utf8');
  for (const [answer, situation] of cases) {
    const out = adapterReply(agent, answer, {text: SHOP});
    assert.equal(out.packet.reply.body.situation, situation, JSON.stringify(verificationFacts(answer)));
    assert.ok(layer.includes(`situation ${situation}`), 'the body comes from the verification layer');
    assert.equal(out.packet.adapter.verification.status, answer.verification.status);
    assert.ok(out.text.startsWith(String(answer.answer.text).split('\n')[0]), out.text);
  }
});

test('a chat turn runs through the adapter: the session default (stepwise) and a routed request', async t => {
  const root = tempDir(t, 'adapter-http-');
  const repo = new Repository(root);
  repo.init('base');
  const parser = stubQueryParser();
  parser.parse = async () => ({sop: '@q query\n  where match\n    relation "likes"\n    role subject "Ana"\n    role object "Alpha Lab"\n    polarity affirmed\n  end', parse: {parser: 'stub', model: 'stub/model', ms: 1, cache: 'miss'}});
  const tiers = fakeTiers();
  const adapter = createChatSOPAdapter({config: {adapter: {routed: {engineCodeLanguages: ['js']}}}, fetchImpl: tiers.fetchImpl, executor: await engines()});
  const server = createServer({repo, lexicon: demoLexicon(), base: 'base', authTokens: {alice: 'alice-secret-token-123456'}, config: {policy: {allowWrite: true}}, queryParser: parser, adapter});
  const url = await listen(t, server);
  const chat = async (text, extra = {}) => (await fetch(url + '/v1/chat/completions', {method: 'POST', headers: {Authorization: 'Bearer alice-secret-token-123456', 'Content-Type': 'application/json'},
    body: JSON.stringify({model: 'chatsop-local', messages: [{role: 'user', content: text}], ...extra})})).json();
  const stepwise = await chat('Does Ana like Alpha Lab?');
  assert.equal(stepwise.chatSop.adapter.mode, 'stepwise');
  assert.equal(stepwise.chatSop.adapter.path, 'stepwise');
  const routed = await chat(SHOP, {adapter: {mode: 'routed'}});
  assert.equal(routed.chatSop.adapter.mode, 'routed');
  assert.equal(routed.chatSop.adapter.verification.status, 'verified');
  assert.equal(routed.chatSop.reply.body.situation, 'answer_verified');
  assert.ok(routed.choices[0].message.content.startsWith('12') || /12/.test(routed.choices[0].message.content));
  const bad = await fetch(url + '/v1/chat/completions', {method: 'POST', headers: {Authorization: 'Bearer alice-secret-token-123456', 'Content-Type': 'application/json'},
    body: JSON.stringify({model: 'chatsop-local', messages: [{role: 'user', content: SHOP}], adapter: {mode: 'guess'}})});
  assert.equal(bad.status, 400);
});
