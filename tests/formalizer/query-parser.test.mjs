// The request parser of a turn (server/query-parser.mjs, DS009 "Request parser"): the step-by-step formalizer (owner decision
// 2026-10-02: no one-shot circuit authoring) asks its questions to the Ploinky tier ladder; the honest failures (`parse_unavailable`,
// `parse_failed`, never a local fallback), the cache, archived strategy names, and the chat/API surface, against stub strategies and a
// fake Ploinky transport. No test calls a model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createQueryParser, queryParserSettings} from '../../server/query-parser.mjs';
import {FAMILY, productServer, stubQueryParser} from '../product-helpers.mjs';
import {lex, tempDir} from '../helpers.mjs';

const Q = (object = 'Lab Alpha', relation = 'works_at') => `@q query\n  where match\n    relation "${relation}"\n    role subject "Ana"\n    role object "${object}"\n    polarity affirmed\n  end\n`;

/** A stub step-by-step strategy factory: `outcome(args, calls)` gives the run's result; availability from `available`. */
function stubStrategies(outcome, {available = true, calls = []} = {}) {
  const factory = (name, local) => ({name, settings: local, tag: `stub:${name}`, server: {stop: async () => {}},
    availability: async firstTier => available ? {available: true, models: [firstTier ?? local.tier], skipped: []} : {available: false, reason: `the Ploinky tier ${firstTier ?? local.tier} is not available: the server is down`, models: [], skipped: [{model: local.tier, reason: 'the server is down'}]},
    run: async args => { calls.push({name, message: args.message, firstTier: args.firstTier}); return {steps: [{name: 'kind', answer: '1', tier: 'tiny'}], model: args.firstTier ?? local.tier, ladder: [args.firstTier ?? local.tier], ...await outcome(args, calls)}; }});
  return {factory, calls};
}
const parserWith = (outcome, extra = {}, options = {}) => {
  const stub = stubStrategies(outcome, options);
  return {calls: stub.calls, parser: createQueryParser({settings: queryParserSettings({queryParser: {...extra}}, {}), localFactory: stub.factory, ...(options.chatData ? {chatData: options.chatData} : {})})};
};
const validated = sop => async () => ({ok: true, status: 'validated', sop, program: {wires: []}, usage: {cost_usd: 0}});

test('step by step is the default; the record says who parsed, the tier ladder, the questions and the time', async () => {
  const settings = queryParserSettings({}, {});
  assert.equal(settings.strategy, 'LocalLLMStepByStep');
  assert.deepEqual(settings.models, ['tiny'], 'without a ladder the tier tiny answers alone');
  assert.equal(settings.entries, undefined, 'no one-shot model chain');
  const product = queryParserSettings(JSON.parse(fs.readFileSync(new URL('../../config/runtime.json', import.meta.url), 'utf8')), {});
  assert.equal(product.strategy, 'LocalLLMStepByStep');
  assert.deepEqual(product.models, ['tiny', 'small', 'good'], 'the product ladder: tiny, then small, then good');
  assert.equal(product.local.method, 'B');
  assert.throws(() => queryParserSettings({queryParser: {strategy: 'Nope'}}, {}), e => e.code === 'invalid_strategy');
  const {parser} = parserWith(validated(Q()));
  const r = await parser.parse({message: 'Does Ana work at Lab Alpha?', lexicon: lex, memoryKey: 'm1'});
  assert.equal(r.sop, Q());
  assert.equal(r.parse.parser, 'local_llm_step_by_step');
  assert.equal(r.parse.strategy, 'LocalLLMStepByStep');
  assert.equal(r.parse.model, 'tiny');
  assert.deepEqual(r.parse.ladder, ['tiny']);
  assert.equal(r.parse.steps, 1);
  assert.deepEqual(r.parse.dialog, [{name: 'kind', answer: '1', tier: 'tiny'}]);
  assert.equal(r.parse.cache, 'miss');
});

test('a session that asks for an archived one-shot strategy runs the default step by step, with a note; a preferred tier starts the ladder', async () => {
  const {parser, calls} = parserWith(validated(Q()));
  for (const name of ['LLMDirect', 'CodingAgent', 'LocalLLMDirect']) {
    const r = await parser.parse({message: `Does Ana work at Lab Alpha (${name})?`, lexicon: lex, strategy: name});
    assert.equal(r.parse.strategy, 'LocalLLMStepByStep');
    assert.match(r.parse.strategy_note, new RegExp(`one-shot strategy ${name} is archived`));
  }
  const preferred = await parser.parse({message: 'Is it so?', lexicon: lex, preferredModel: 'small'});
  assert.equal(calls.at(-1).firstTier, 'small');
  assert.equal(preferred.parse.model, 'small');
});

test('failures are honest: parse_unavailable when the first tier cannot run or no tier answers, parse_failed for an invalid circuit', async () => {
  const none = parserWith(validated(Q()), {}, {available: false}).parser;
  await assert.rejects(none.parse({message: 'm', lexicon: lex}), error => error.code === 'parse_unavailable' && error.status === 503 && /tier tiny is not available.*the server is down/.test(error.message) && error.parse.parser === 'local_llm_step_by_step');
  const down = parserWith(async () => ({ok: false, status: 'failed', sop: '', reason: 'the local model could not be reached'})).parser;
  await assert.rejects(down.parse({message: 'm', lexicon: lex}), error => error.code === 'parse_unavailable' && /could not be reached/.test(error.message) && Boolean(error.parse.failed));
  const invalid = parserWith(async () => ({ok: false, status: 'invalid', sop: '@q query\n  where bogus\n', validation: {ok: false, problems: [{code: 'bad_where', message: 'x'}]}})).parser;
  await assert.rejects(invalid.parse({message: 'm', lexicon: lex}), error => error.code === 'parse_failed' && error.status === 422 && /bad_where/.test(error.message) && error.attempt.sop.includes('bogus'));
  const gibberish = await parserWith(validated('@u unclear\n  kind gibberish\n')).parser.parse({message: 'asdf', lexicon: lex});
  assert.match(gibberish.sop, /gibberish/, 'an honest unclear is the formalizer\'s answer, not a failure');
  let release;
  const gate = new Promise(r => { release = r; });
  const busy = parserWith(async () => { await gate; return {ok: true, status: 'validated', sop: Q(), program: {wires: []}}; }, {maxConcurrent: 1}).parser;
  const first = busy.parse({message: 'one', lexicon: lex});
  await new Promise(r => setTimeout(r, 10));
  await assert.rejects(busy.parse({message: 'two', lexicon: lex}), error => error.code === 'parse_unavailable' && /busy/.test(error.message));
  release();
  assert.equal((await first).parse.parser, 'local_llm_step_by_step');
});

test('identical requests are cached per memory version', async () => {
  const {parser, calls} = parserWith(validated(Q()));
  const args = {message: '  Does   Ana like Bob? ', lexicon: lex, memoryKey: 'v1'};
  const a = await parser.parse(args);
  const b = await parser.parse({...args, message: 'does ana like bob?'});
  assert.equal(a.parse.cache, 'miss');
  assert.equal(b.parse.cache, 'hit');
  assert.equal(b.parse.cost_usd, 0);
  assert.equal(calls.length, 1);
  await parser.parse({...args, memoryKey: 'v2'});
  assert.equal(calls.length, 2, 'another memory version asks again');
  assert.equal(parser.stats().cache_hits, 1);
});

/** A fake Ploinky transport: `/health` lists the tiers, `/v1/chat/completions` answers `reply(body)`; every chat request is recorded. */
function fakePworker(reply, calls = []) {
  const json = body => ({ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body});
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith('/health')) return json({ok: true, tiers: ['tiny', 'small', 'good']});
    const body = JSON.parse(init.body || '{}');
    calls.push({url, headers: init.headers ?? {}, body});
    return json({choices: [{message: {content: reply(body)}, finish_reason: 'stop'}], usage: {prompt_tokens: 100, completion_tokens: 2}});
  };
  return {fetchImpl, calls};
}
/** The product server with the real request parser over `fetchImpl` (no answer-language step: the server has an injected parser). */
const parserServer = (t, config, fetchImpl) => productServer(t, {config, serverOptions: {queryParser: createQueryParser({settings: queryParserSettings(config), fetchImpl})}});

test('chat: the step-by-step formalizer asks the Ploinky tiers, tagged; an unreadable answer of tiny escalates to small; the packet records it', async t => {
  // tiny never answers in a readable form; small answers every question with "0" (nothing in the request matches).
  const ta = fakePworker(body => body.model === 'tiny' ? 'Well, it depends on many things.' : '0');
  const s = await parserServer(t, {queryParser: {timeoutSeconds: 30, local: {tier: 'tiny', ladder: ['tiny', 'small'], method: 'B'}}}, ta.fetchImpl);
  await s.admin('/v1/memories', 'POST', {name: 'Family', id: 'family', circuits: [{name: 'family', text: FAMILY}]});
  const id = (await s.user('/v1/sessions', 'POST', {base: 'family'})).body.id;
  const chat = (content = 'Does Ana like Alpha Lab?') => s.user('/v1/chat/completions', 'POST', {model: 'chatsop-local', session_id: id, messages: [{role: 'user', content}]});
  const first = await chat();
  const c = first.body.chatSop;
  assert.ok(c.parse, JSON.stringify(first.body).slice(0, 400));
  assert.equal(c.parse.parser, 'local_llm_step_by_step');
  assert.deepEqual(c.parse.ladder, ['tiny', 'small']);
  assert.ok(ta.calls.length > 0 && ta.calls.every(x => x.headers['x-pworker-purpose'] === 'formalize' && x.url.endsWith('/v1/chat/completions')), 'every formalization call names a tier and is tagged for the Ploinky log');
  assert.ok(ta.calls.some(x => x.body.model === 'tiny') && ta.calls.some(x => x.body.model === 'small'), 'the unreadable tiny answers escalated to small');
  assert.ok(c.parse.tiers.escalated.length >= 1, JSON.stringify(c.parse.tiers));
  assert.ok(c.parse.dialog.some(d => d.tier === 'small' && !d.escalated));
  assert.equal(ta.calls[0].body.messages[0].role, 'system', 'the stable protocol prefix is the first (cached) message');
  assert.equal((await s.user(`/v1/sessions/${id}/settings`, 'POST', {parser: 'local'})).status, 400);
  const set = await s.user(`/v1/sessions/${id}/settings`, 'POST', {formalizer_model: 'small', formalizer: 'CodingAgent'});
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.settings.formalizer, 'LLMDirect', 'an old strategy name is stored as the archived one-shot name');
  const before = ta.calls.length;
  const second = await chat('Does Bob like Alpha Lab?');
  assert.equal(second.body.chatSop.parse.strategy, 'LocalLLMStepByStep', 'the archived strategy runs the default step by step');
  assert.match(second.body.chatSop.parse.strategy_note, /archived/);
  assert.ok(ta.calls.slice(before).every(x => x.body.model === 'small'), 'the session\'s first tier small starts the ladder');
  const status = await s.user('/v1/status');
  assert.deepEqual(status.body.formalization.strategies.map(x => x.id), ['LocalLLMStepByStep', 'InternalReasoningStepByStep', 'DirectSOP', 'SchemaGuidedLLM', 'SchemaOrDirect', 'Ensemble', 'EnsembleOneShot', 'DependencyScaffold', 'SpladeRouted', 'SaeRouted', 'FrameGuided', 'CNL-ACE', 'FineTunedSOP']);
  assert.deepEqual(status.body.formalization.strategies[0].ladder, ['tiny', 'small']);
  const models = await s.user('/v1/models');
  assert.equal(models.body.data[0].chatsop.formalizer.available, true);
  assert.deepEqual(models.body.data[0].chatsop.formalizer.models, ['tiny', 'small'], 'the tier ladder is listed');
});

test('chat: an unreachable Ploinky proxy is parse_unavailable (503) with the record, never a local answer', async t => {
  const s = await parserServer(t, {}, async () => { throw new Error('ECONNREFUSED'); });
  const id = (await s.user('/v1/sessions', 'POST', {base: 'default'})).body.id;
  const r = await s.user('/v1/chat/completions', 'POST', {model: 'chatsop-local', session_id: id, messages: [{role: 'user', content: 'Does Ana like Alpha Lab?'}]});
  assert.equal(r.status, 503, JSON.stringify(r.body));
  assert.equal(r.body.error.code, 'parse_unavailable');
  assert.equal(r.body.chatSop.status, 'parse_unavailable');
  assert.match(r.body.chatSop.reason, /not available.*proxy not reachable/);
  assert.equal((await s.user('/readyz')).status, 503);
  const stub = await productServer(t, {serverOptions: {queryParser: stubQueryParser({available: false})}});
  const down = await stub.user('/v1/chat/completions', 'POST', {model: 'chatsop-local', messages: [{role: 'user', content: 'Does Ana like Alpha Lab?'}]});
  assert.equal(down.status, 503);
});

test('a clear question no predicate expresses is an honest unclear and is logged as a gap of the memory', async t => {
  const root = tempDir(t, 'qp-gap-');
  const {parser} = parserWith(async () => ({ok: true, status: 'validated', sop: '@u unclear\n  kind relation_not_in_memory\n', unclear: 'relation_not_in_memory', closest: [{id: 'works_at'}], program: {wires: []}}), {}, {chatData: {root}});
  const r = await parser.parse({message: 'Who employs Ana?', lexicon: lex, memoryKey: 'gap-1'});
  assert.equal(r.parse.parser, 'local_llm_step_by_step');
  assert.match(r.sop, /relation_not_in_memory/);
  const log = fs.readFileSync(path.join(root, 'query-gaps.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(log.length, 1);
  assert.equal(log[0].message, 'Who employs Ana?');
  assert.equal(log[0].memory, 'gap-1');
  assert.ok(log[0].closest.length > 0, 'the closest predicates are material for the authoring path');
});
