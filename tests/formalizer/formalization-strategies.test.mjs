import test from 'node:test';
import assert from 'node:assert/strict';
import {createQueryParser, queryParserSettings} from '../../server/query-parser.mjs';
import {checkStrategy, resolveStrategy, ladderOf, FORMALIZATION_STRATEGIES} from '../../lib/formalize/strategies.mjs';
import {Lexicon} from '../../sop/lexicon.mjs';

const lexicon = Lexicon.fromCircuits([{name: 't', text: '@ana entity\n  kind entity\n  label en "Ana"\n@cleared predicate\n  args subject:entity\n'}]);
const SOP = '@q query\n  where match\n    relation "cleared"\n    role subject "ana"\n    polarity affirmed\n  end\n';

/** A stub local strategy factory: records which strategy ran and returns a step-by-step result. */
function stubLocal() {
  const runs = [];
  const factory = (name, local) => ({name, settings: local, server: {stop: async () => runs.push({stopped: name})},
    availability: async () => ({available: true, models: [local.alias], skipped: []}),
    run: async args => { runs.push({name, message: args.message}); return {ok: true, status: 'validated', sop: SOP, program: {wires: []}, rounds: 1, usage: {cost_usd: 0}, model: local.alias, steps: [{}, {}, {}]}; }});
  return {runs, factory};
}

test('formalization is step by step: the strategies are named and selectable; archived one-shot names read as the default', () => {
  assert.deepEqual(FORMALIZATION_STRATEGIES, ['LocalLLMStepByStep', 'InternalReasoningStepByStep']);
  assert.equal(queryParserSettings({}, {}).strategy, 'LocalLLMStepByStep');
  const archived = queryParserSettings({queryParser: {strategy: 'LLMDirect'}}, {});
  assert.equal(archived.strategy, 'LocalLLMStepByStep');
  assert.match(archived.strategyNote, /LLMDirect is archived/);
  for (const name of ['LLMDirect', 'CodingAgent', 'LocalLLMDirect']) assert.equal(checkStrategy(name), 'LocalLLMStepByStep');
  assert.equal(checkStrategy('LLMDirect', 'InternalReasoningStepByStep'), 'InternalReasoningStepByStep', 'an archived name runs the configured default');
  assert.match(resolveStrategy('CodingAgent').note, /archived/);
  assert.equal(resolveStrategy('InternalReasoningStepByStep').note, null);
  assert.equal(queryParserSettings({}, {CHATSOP_FORMALIZER: 'InternalReasoningStepByStep'}).strategy, 'InternalReasoningStepByStep');
  assert.equal(queryParserSettings({}, {}).local.tier, 'tiny', 'the step-by-step model is the Ploinky tier tiny');
  assert.deepEqual(queryParserSettings({queryParser: {local: {ladder: ['tiny', 'small', {tier: 'good', extraBody: {reasoning: {enabled: false}}}]}}}, {}).models, ['tiny', 'small', 'good']);
  assert.throws(() => checkStrategy('Guess'), e => e.code === 'invalid_strategy');
});

test('the tier ladder: smallest first; a preferred first tier starts the ladder there, or alone when it is not on it', () => {
  const local = {tier: 'tiny', ladder: ['tiny', 'small', {tier: 'good', extraBody: {x: 1}}]};
  assert.deepEqual(ladderOf(local).map(r => r.tier), ['tiny', 'small', 'good']);
  assert.deepEqual(ladderOf(local)[2].extraBody, {x: 1});
  assert.deepEqual(ladderOf(local, 'small').map(r => r.tier), ['small', 'good']);
  assert.deepEqual(ladderOf(local, 'medium').map(r => r.tier), ['medium']);
  assert.deepEqual(ladderOf({tier: 'small'}).map(r => r.tier), ['small'], 'without a ladder the single tier answers');
});

test('a turn runs the strategy the session chose; an archived name runs the default with a note in the parse record', async () => {
  const {runs, factory} = stubLocal();
  const parser = createQueryParser({settings: queryParserSettings({queryParser: {local: {alias: 'qwen-test'}}}, {}), localFactory: factory});
  const done = await parser.parse({message: 'Is Ana cleared?', lexicon, strategy: 'LocalLLMStepByStep'});
  assert.equal(done.parse.strategy, 'LocalLLMStepByStep');
  assert.equal(done.parse.parser, 'local_llm_step_by_step');
  assert.equal(done.parse.steps, 3);
  assert.equal(done.parse.model, 'qwen-test');
  assert.equal(done.parse.strategy_note, undefined);
  const reasoning = await parser.parse({message: 'Is Ana cleared today?', lexicon, strategy: 'InternalReasoningStepByStep'});
  assert.equal(reasoning.parse.parser, 'internal_reasoning_step_by_step');
  const archived = await parser.parse({message: 'Is Ana cleared now?', lexicon, strategy: 'LLMDirect'});
  assert.equal(archived.parse.strategy, 'LocalLLMStepByStep');
  assert.match(archived.parse.strategy_note, /one-shot strategy LLMDirect is archived/);
  assert.deepEqual(runs.map(r => r.name), ['LocalLLMStepByStep', 'InternalReasoningStepByStep', 'LocalLLMStepByStep']);
  await assert.rejects(parser.parse({message: 'x', lexicon, strategy: 'Other'}), e => e.code === 'invalid_strategy');
  await parser.stop();
});

test('per-question escalation: an unreadable answer goes up the ladder with the same history; the next question starts at the bottom', async () => {
  const {createOracle, Unreadable} = await import('../../lib/query-author/step-by-step/index.mjs');
  const calls = [];
  const rung = (tier, answers) => ({tier, chat: async messages => { calls.push({tier, messages: messages.map(m => m.content)}); const text = answers.shift(); return text === undefined ? {ok: false, reason: 'down'} : {ok: true, text}; }});
  const ladder = [rung('tiny', ['banana', 'still banana', '2']), rung('small', ['3']), rung('good', [])];
  const oracle = createOracle({chat: null, ladder, system: 'sys'});
  const readNumber = t => /^\d+$/.test(t.trim()) ? Number(t) : null;
  assert.equal(await oracle.read('kind', 'Which kind?', readNumber, 'Reply with one number.'), 3, 'tiny failed twice, small answered');
  assert.deepEqual(calls.map(c => c.tier), ['tiny', 'tiny', 'small']);
  assert.deepEqual(calls[2].messages, ['sys', 'Which kind?'], 'the failed exchange left the conversation before the escalation');
  assert.equal(await oracle.read('next', 'And then?', readNumber, 'Reply with one number.'), 2, 'the next question starts at tiny again');
  assert.deepEqual(oracle.messages.map(m => m.content), ['sys', 'Which kind?', '3', 'And then?', '2']);
  assert.deepEqual(oracle.escalations, [{question: 'kind', from: 'tiny', to: 'small', reason: 'unreadable'}]);
  assert.deepEqual(oracle.steps.map(s => [s.tier, Boolean(s.escalated)]), [['tiny', true], ['tiny', true], ['small', false], ['tiny', false]]);
  // A tier that does not answer escalates too; the last rung's failure is the run's stop.
  const down = createOracle({chat: null, ladder: [rung('tiny', []), rung('small', ['ok'])]});
  assert.equal(await down.ask('free', 'Say ok'), 'ok');
  const none = createOracle({chat: null, ladder: [rung('tiny', ['x', 'y'])]});
  await assert.rejects(none.read('kind', 'Which?', readNumber, 'Reply with one number.'), e => e instanceof Unreadable);
});

test('the tier strategy sends each rung to its Ploinky tier and reports the tiers that answered', async () => {
  const {localStrategy, ladderUsage} = await import('../../lib/formalize/strategies.mjs');
  const bodies = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith('/health')) return {ok: true, json: async () => ({ok: true, tiers: [{id: 'tiny'}, {id: 'small'}]})};
    const body = JSON.parse(init.body);
    bodies.push(body);
    // tiny never gives a readable kind; small answers every question with "0" or "none".
    const text = body.model === 'tiny' ? 'I am not sure' : '1';
    return {ok: true, text: async () => JSON.stringify({choices: [{message: {content: text}}], usage: {}})};
  };
  const s = localStrategy('LocalLLMStepByStep', {tier: 'tiny', ladder: ['tiny', 'small'], method: 'B'}, {fetchImpl});
  assert.deepEqual(s.ladder, ['tiny', 'small']);
  assert.equal((await s.availability()).available, true);
  const r = await s.run({message: 'Is Ana cleared?', lexicon});
  assert.deepEqual(r.ladder, ['tiny', 'small']);
  assert.ok(bodies.some(b => b.model === 'tiny') && bodies.some(b => b.model === 'small'), 'both tiers were asked');
  assert.ok(r.tiers.escalated.length >= 1 && r.tiers.answered.small >= 1, JSON.stringify(r.tiers));
  assert.deepEqual(ladderUsage([{tier: 'tiny', ok: true}, {tier: 'tiny', ok: true, escalated: true}, {tier: 'small', ok: true}]), {answered: {tiny: 1, small: 1}, escalated: [{question: undefined, tier: 'tiny'}]});
});

test('the strategies listing reports a Ploinky proxy that does not answer, or an explicit endpoint, as unavailable, without starting anything', async () => {
  const parser = createQueryParser({settings: queryParserSettings({queryParser: {}}, {}), fetchImpl: async () => { throw new Error('ECONNREFUSED'); }});
  const listed = await parser.strategies();
  assert.deepEqual(listed.map(s => s.id), ['LocalLLMStepByStep', 'InternalReasoningStepByStep']);
  const local = listed.find(s => s.id === 'LocalLLMStepByStep');
  assert.equal(local.available, false);
  assert.match(local.reason, /proxy not reachable/);
  let asked = false;
  const endpoint = createQueryParser({settings: queryParserSettings({queryParser: {local: {endpoint: 'http://127.0.0.1:9/v1'}}}, {}), fetchImpl: async () => { asked = true; throw new Error('ECONNREFUSED'); }});
  const refused = (await endpoint.strategies()).find(s => s.id === 'LocalLLMStepByStep');
  assert.equal(refused.available, false);
  assert.match(refused.reason, /must be a Ploinky tier/);
  assert.equal(asked, false, 'an explicit endpoint is refused without a request');
});

test('the step-by-step strategies ask the Ploinky tier tiny: no model server is managed, readiness comes from the Ploinky /health', async () => {
  const {localStrategy, usesTier} = await import('../../lib/formalize/strategies.mjs');
  assert.equal(usesTier({tier: 'tiny'}), true);
  assert.equal(usesTier({tier: 'tiny', gguf: '/m.gguf'}), false, 'an explicit GGUF is no Ploinky tier');
  assert.throws(() => localStrategy('LocalLLMStepByStep', {tier: 'tiny', gguf: '/m.gguf'}), e => e.code === 'invalid_strategy' && /Ploinky provider/.test(e.message), 'a GGUF is configured as a Ploinky provider, never started here');
  assert.throws(() => localStrategy('LocalLLMStepByStep', {endpoint: 'http://127.0.0.1:9/v1'}), e => e.code === 'invalid_strategy');
  const seen = [];
  const health = tiers => async url => { seen.push(url); return {ok: true, json: async () => ({ok: true, tiers})}; };
  const tier = localStrategy('LocalLLMStepByStep', {}, {fetchImpl: health([{id: 'tiny', x_tier: {serves: 'local/Qwen3.6-35B-A3B'}}])});
  assert.deepEqual(await tier.availability(), {available: true, models: ['tiny'], skipped: []});
  assert.equal(new URL(seen[0]).pathname, '/health');
  const missing = localStrategy('InternalReasoningStepByStep', {}, {fetchImpl: health([])});
  assert.match((await missing.availability()).reason, /tier tiny is not available/);
  const failing = localStrategy('LocalLLMStepByStep', {}, {fetchImpl: health([{id: 'tiny', x_tier: {error: 'no provider of the chain has a key'}}])});
  assert.match((await failing.availability()).reason, /no provider of the chain has a key/);
});
