// The server status (GET /v1/status), the session's formalization strategy and the pipeline trace of the chat page (DS009).
import test from 'node:test';
import assert from 'node:assert/strict';
import {FAMILY, productServer} from '../product-helpers.mjs';
import {strategyRequest, formalizationStrategies} from '../../server/status.mjs';
import {stubQueryParser} from '../helpers.mjs';
import {chatPage} from '../../server/pages/chat.mjs';

test('status: strategies, base memories, engines and caches; listed in the capabilities', async t => {
  const s = await productServer(t);
  const r = await s.user('/v1/status');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.object, 'status');
  assert.equal(r.body.formalization.default, 'LocalLLMStepByStep');
  assert.deepEqual(r.body.formalization.strategies.map(x => x.id), ['LocalLLMStepByStep', 'InternalReasoningStepByStep'], 'the one-shot LLMDirect is archived');
  const steps = r.body.formalization.strategies[0];
  assert.equal(steps.available, true);
  assert.deepEqual(steps.models.map(m => m.id), ['stub/model']);
  assert.ok(r.body.formalization.strategies.slice(1).every(x => x.available === false && x.reason), 'a strategy the server does not run says why');
  assert.ok(r.body.memories.some(m => m.id === 'default'));
  assert.ok(r.body.reasoning.engines.some(e => e.id === 'js-reference' && e.available));
  assert.ok('query-parser' in r.body.caches);
  assert.equal(r.body.ready, true);
  assert.ok((await s.user('/v1/capabilities')).body.endpoints.some(e => e.path === '/v1/status'));
  assert.equal((await s.call('/v1/status')).status, 401, 'the status needs authentication');
});

test('status: a session strategy the server cannot run is refused with parse_unavailable, never substituted', async t => {
  const s = await productServer(t);
  await s.admin('/v1/memories', 'POST', {name: 'Family', id: 'family', circuits: [{name: 'family', text: FAMILY}]});
  const id = (await s.user('/v1/sessions', 'POST', {base: 'family', settings: {formalizer: 'InternalReasoningStepByStep'}})).body.id;
  const chat = () => s.user('/v1/chat/completions', 'POST', {model: 'chatsop-local', messages: [{role: 'user', content: 'Does Ana like Alpha Lab?'}], session_id: id});
  const refused = await chat();
  assert.equal(refused.status, 503);
  assert.equal(refused.body.error.code, 'parse_unavailable');
  assert.match(refused.body.error.message, /InternalReasoningStepByStep/);
  assert.equal((await s.user(`/v1/sessions/${id}/settings`, 'POST', {formalizer: 'Nope'})).status, 400);
  const set = await s.user(`/v1/sessions/${id}/settings`, 'POST', {formalizer: 'CodingAgent'});
  assert.equal(set.body.settings.formalizer, 'LLMDirect', 'the retired name CodingAgent is stored as the archived one-shot name');
  const ok = await chat();
  assert.equal(ok.status, 200, 'an archived one-shot name runs the default step-by-step strategy: ' + JSON.stringify(ok.body));
  assert.equal(typeof ok.body.chatSop.turn_ms, 'number');
  assert.equal(ok.body.chatSop.session.formalizer, 'LLMDirect');
  assert.ok('verification' in ok.body.chatSop && 'session_circuits' in ok.body.chatSop && 'strategy' in ok.body.chatSop);
});

test('status: a request parser with several strategies receives the chosen one and reports its own list', async () => {
  const multi = {strategies: async () => [{id: 'LocalLLMStepByStep', available: true}, {id: 'InternalReasoningStepByStep', available: true}]};
  assert.deepEqual(strategyRequest(multi, 'InternalReasoningStepByStep'), {strategy: 'InternalReasoningStepByStep'});
  assert.deepEqual(strategyRequest(multi, 'CodingAgent'), {strategy: 'CodingAgent'}, 'the full parser resolves an archived name itself and notes it');
  assert.deepEqual((await formalizationStrategies(multi)).map(x => x.id), ['LocalLLMStepByStep', 'InternalReasoningStepByStep']);
  assert.deepEqual(strategyRequest(stubQueryParser(), null), {});
  assert.deepEqual(strategyRequest(stubQueryParser(), 'LLMDirect'), {}, 'an archived name runs the default');
  assert.deepEqual(strategyRequest(stubQueryParser(), 'LocalLLMStepByStep'), {});
  assert.throws(() => strategyRequest(stubQueryParser(), 'InternalReasoningStepByStep'), e => e.code === 'parse_unavailable' && e.status === 503);
});

test('chat page: the strategy selector, the status card and the pipeline trace; no stale controls', () => {
  const html = chatPage({model: 'chatsop-local', ready: true});
  for (const id of ['id="formalizer"', 'id="status-box"', 'id="status-refresh"', 'id="formalizer-model"']) assert.ok(html.includes(id), id);
  for (const section of ['1. Formalization', '2. Vocabulary', '3. Session definitions and assumptions', '4. Linking', '5. Retrieval', '6. Route and verification', '7. Answer formulation', '8. Latency']) assert.ok(html.includes(section), section);
  assert.ok(!html.includes('strategy-info') && !html.includes('Attaching a file is the only thing'), 'stale controls are gone');
});

test('answer language: off for English, phrased from the result for another language, English kept when a number is dropped', async () => {
  const {createAnswerFormulator, looksEnglish} = await import('../../server/answer-language.mjs');
  assert.equal(looksEnglish('Who wrote Hamlet?'), true);
  assert.equal(looksEnglish('Is Paris located in Europe?'), true);
  assert.equal(looksEnglish('Ada Lovelace?'), true);
  assert.equal(looksEnglish('Care este capitala Franței?'), false);
  assert.equal(looksEnglish('Wer hat Hamlet geschrieben?'), false);
  const calls = [];
  const chat = async ({provider}) => { calls.push(provider); return provider === 'bad' ? {ok: true, text: 'Răspuns: unsprezece.'} : {ok: true, text: 'Răspuns: 11 (Wikidata Q183).', model: 'good'}; };
  const f = createAnswerFormulator({settings: {mode: 'auto', natural: 'off', providers: ['bad', 'good'], timeoutSeconds: 5}, chat});
  const english = await f.formulate({message: 'How many?', english: 'Answer: 11 (Wikidata Q183).', packet: {}});
  assert.equal(english.applied, false);
  assert.equal(calls.length, 0, 'no model call for an English message when natural phrasing is off');
  const ro = await f.formulate({message: 'Câte țări se învecinează cu Germania?', english: 'Answer: 11 (Wikidata Q183).', packet: {status: 'supported'}});
  assert.equal(ro.applied, true);
  assert.equal(ro.model, 'good');
  assert.match(ro.tried[0].reason, /dropped 11/);
  const none = createAnswerFormulator({settings: {mode: 'always', providers: ['bad'], timeoutSeconds: 5}, chat});
  assert.equal((await none.formulate({message: 'x', english: 'Answer: 11.', packet: {}})).applied, false, 'an unfaithful phrasing falls back to English');
});

test('base memories: the encyclopedic default falls back to the minimal memory when world-v1 is not loaded; three kinds of new memory', async t => {
  const s = await productServer(t);
  const list = (await s.user('/v1/memories')).body;
  assert.equal(list.default_base, 'default', 'world-v1 is not loaded in the test root, so the minimal default is used');
  assert.deepEqual(list.kinds, ['encyclopedic', 'minimal', 'empty']);
  const session = await s.user('/v1/sessions', 'POST', {});
  assert.equal(session.status, 201, JSON.stringify(session.body));
  assert.equal(session.body.base.id, 'default', 'a session without base forks the default');
  const empty = await s.admin('/v1/memories', 'POST', {name: 'Specialised', kind: 'empty'});
  assert.equal(empty.status, 201, JSON.stringify(empty.body));
  assert.deepEqual(empty.body.imports, []);
  const minimal = await s.admin('/v1/memories', 'POST', {name: 'Small', kind: 'minimal'});
  assert.deepEqual(minimal.body.imports.map(l => l.id), ['core-min']);
  assert.equal((await s.admin('/v1/memories', 'POST', {name: 'World copy', kind: 'encyclopedic'})).status, 409, 'no encyclopedic memory on this server');
  assert.equal((await s.admin('/v1/memories', 'POST', {name: 'X', kind: 'huge'})).status, 400);
});

test('memory sizes as knowledge files and SOP wires: added fields on status, memories and sessions; the old fields stay', async t => {
  const s = await productServer(t);
  await s.admin('/v1/memories', 'POST', {name: 'Family', id: 'family', circuits: [{name: 'family', text: FAMILY}]});
  const wires = m => Object.values(m.wires_by_type).reduce((a, b) => a + b, 0);
  const one = await s.user('/v1/memories/family');
  assert.equal(one.status, 200);
  const files = one.body.knowledge_files;
  assert.ok(files >= 1, 'import layers and own files are counted');
  assert.ok(one.body.sop_wires > 0 && one.body.sop_wires === wires(one.body));
  assert.ok(one.body.wires_by_type.fact >= 3);
  assert.equal(typeof one.body.circuits, 'number', 'the existing counters stay');
  assert.equal(typeof one.body.facts, 'number');
  const list = (await s.user('/v1/memories')).body.data.find(m => m.id === 'family');
  assert.deepEqual([list.knowledge_files, list.sop_wires, list.wires_by_type], [one.body.knowledge_files, one.body.sop_wires, one.body.wires_by_type]);
  const st = (await s.user('/v1/status')).body.memories.find(m => m.id === 'family');
  assert.equal(st.sop_wires, one.body.sop_wires);
  assert.equal(st.circuits, one.body.circuits);
  await s.admin('/v1/memories/family/knowledge', 'POST', {circuits: [{name: 'more', text: '@f9 fact\n  holds parent di ed\n  source "t"\n'}]});
  assert.equal((await s.user('/v1/memories/family')).body.knowledge_files, files + 1, 'the cache follows the content');
  const sid = (await s.user('/v1/sessions', 'POST', {base: 'family'})).body.id;
  const sess = (await s.user(`/v1/sessions/${sid}`)).body;
  assert.equal(sess.knowledge_files, files + 1);
  assert.ok(sess.sop_wires > 0 && Array.isArray(sess.circuits));
});
