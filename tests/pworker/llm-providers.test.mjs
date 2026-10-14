// Model entries (lib/llm-providers.mjs, owner decisions 2026-10-02 and 2026-10-03): Ploinky providers and tiers, the step-by-step formalizer on a Ploinky tier,
// the answer-language step and the books judge, all against stubs. No test calls a model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {providerSettings, chainEntry, providerChat, providerReadiness} from '../../lib/llm-providers.mjs';
import {createQueryParser, queryParserSettings} from '../../server/query-parser.mjs';
import {createAnswerFormulator} from '../../server/answer-language.mjs';
import {judgeBatches} from '../../tools/eval/books/score.mjs';
import {lex, tempDir} from '../helpers.mjs';

const Q = '@q query\n  where match\n    relation "works_at"\n    role subject "Ana"\n    role object "Lab Alpha"\n    polarity affirmed\n  end\n';
const reply = content => async (url, init) => ({ok: true, status: 200, text: async () => JSON.stringify({choices: [{message: {content}}], usage: {prompt_tokens: 3}}), _url: url, _body: init?.body});

test('the default provider is openference with Qwen3.8 27b, served through Ploinky; config overrides it', () => {
  const p = providerSettings({});
  assert.equal(p.openference.baseUrl, undefined, 'no endpoint: Ploinky knows where its providers are');
  assert.equal(p.openference.model, 'Qwen3.8 27b');
  assert.equal(providerSettings({llmProviders: {openference: {model: 'GLM-5.3-Flash'}}}).openference.model, 'GLM-5.3-Flash');
  const e = chainEntry({kind: 'completion', provider: 'openference'}, {providers: p});
  assert.equal(e.id, 'openference/Qwen3.8 27b');
  assert.equal(e.upstream, 'openference');
  assert.equal(e.noFallback, true, 'a concrete model switches the server\'s own fallback off');
  assert.deepEqual(e.extraBody, {chat_template_kwargs: {enable_thinking: false}});
  const tier = chainEntry('small', {providers: p});
  assert.deepEqual([tier.id, tier.tier, tier.model, tier.upstream, tier.noFallback], ['small', 'small', 'small', null, false], 'a tier is served by Ploinky with its own fallback');
  assert.throws(() => chainEntry({provider: 'nope'}, {providers: p}), /unknown provider/);
});

test('providerChat answers plain text through Ploinky, strips thinking, tags the call, and reports an unreachable server without throwing', async () => {
  let seen = null;
  const record = async (url, init) => { seen = {url, headers: init.headers, body: JSON.parse(init.body)}; return reply('<think>x</think>hello')(url, init); };
  const ok = await providerChat({system: 's', prompt: 'p', purpose: 'answer-language', fetchImpl: record});
  assert.equal(ok.text, 'hello');
  assert.equal(new URL(seen.url).pathname, '/u/openference/v1/chat/completions', 'a concrete model goes to its provider route');
  assert.equal(seen.body.model, 'Qwen3.8 27b');
  assert.equal(seen.headers['x-pworker-purpose'], 'answer-language');
  assert.equal(seen.headers['x-pworker-no-fallback'], '1');
  const tier = await providerChat({prompt: 'p', provider: 'small', fetchImpl: record});
  assert.equal(tier.model, 'small');
  assert.equal(new URL(seen.url).pathname, '/v1/chat/completions', 'a tier goes to the default route');
  assert.equal(seen.body.model, 'small');
  assert.equal(seen.headers['x-pworker-purpose'], 'chat');
  const down = await providerChat({prompt: 'p', fetchImpl: async () => { throw new Error('ECONNREFUSED'); }});
  assert.equal(down.ok, false);
  assert.match(down.reason, /could not be reached.*not reachable/);
  const state = await providerReadiness('openference', {fetchImpl: async () => { throw new Error('ECONNREFUSED'); }});
  assert.equal(state.available, false);
  assert.match(state.reason, /not reachable/);
  const health = body => async () => ({ok: true, json: async () => body});
  assert.deepEqual(await providerReadiness('small', {fetchImpl: health({ok: true, tiers: [{id: 'small', x_tier: {serves: 'openference/Qwen3.8 27b'}}]})}), {available: true});
  assert.match((await providerReadiness('good', {fetchImpl: health({ok: true, tiers: [{id: 'small'}]})})).reason, /no tier good/);
  const keys = health({ok: true, upstreams: {openference: {key_configured: true}, openrouter: {key_configured: false}}});
  assert.deepEqual(await providerReadiness('openference', {fetchImpl: keys}), {available: true});
  assert.match((await providerReadiness('openrouter/deepseek/deepseek-v4-flash', {fetchImpl: keys})).reason, /no key configured/);
});

test('provider entries name Ploinky providers; the formalizer asks its tier through Ploinky; an unreachable server is parse_unavailable', async () => {
  const flash = chainEntry('openrouter/deepseek/deepseek-v4-flash');
  assert.deepEqual([flash.id, flash.upstream, flash.model], ['openrouter/deepseek/deepseek-v4-flash', 'openrouter', 'deepseek/deepseek-v4-flash']);
  assert.equal(chainEntry('Qwen3.8 27b').id, 'openference/Qwen3.8 27b', 'a bare model id goes to the default provider');
  assert.throws(() => chainEntry({kind: 'omp', model: 'x'}), /not supported/);
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({url, headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : null}); return url.endsWith('/health') ? {ok: true, json: async () => ({ok: true, tiers: [{id: 'small', x_tier: {serves: 'openference/Qwen3.8 27b'}}]})} : reply('1')(url, init); };
  const qp = createQueryParser({settings: queryParserSettings({queryParser: {strategy: 'LocalLLMDirect', local: {tier: 'small', method: 'B'}}}, {}), fetchImpl});
  // The stub answers "1" to every question, so the run may stop on an unreadable answer: the record is the same either way.
  const r = await qp.parse({message: 'Does Ana work at Lab Alpha?', lexicon: lex}).catch(error => error);
  assert.equal(r.parse.strategy, 'LocalLLMStepByStep', 'the archived name runs the step-by-step default');
  assert.equal(r.parse.model, 'small');
  assert.equal(r.parse.backend, 'completion');
  const sent = calls.find(c => c.url.endsWith('/chat/completions'));
  assert.equal(new URL(sent.url).pathname, '/v1/chat/completions');
  assert.equal(sent.body.model, 'small', 'the tier name goes to Ploinky');
  assert.equal(sent.headers['x-pworker-purpose'], 'formalize');
  const down = createQueryParser({settings: queryParserSettings({queryParser: {}}, {}), fetchImpl: async () => { throw new Error('ECONNREFUSED'); }});
  await assert.rejects(down.parse({message: 'm', lexicon: lex}), e => e.code === 'parse_unavailable' && /not reachable/.test(e.message));
});

test('the answer-language step calls the providers in order (no omp) and keeps the English draft when none is faithful', async () => {
  const settings = {mode: 'always', providers: ['openference', 'openrouter'], timeoutSeconds: 5};
  const good = createAnswerFormulator({settings, chat: async ({provider}) => provider === 'openference' ? {ok: false, text: '', reason: 'rate limited', model: 'openference/Qwen3.8 27b'} : {ok: true, text: 'Da, 42.', model: 'openrouter/deepseek/deepseek-v4-flash'}});
  const a = await good.formulate({message: 'Este?', english: 'Yes, 42.', packet: {}});
  assert.equal(a.applied, true);
  assert.equal(a.model, 'openrouter/deepseek/deepseek-v4-flash');
  assert.match(a.tried[0].reason, /rate limited/);
  const down = createAnswerFormulator({settings, chat: async () => ({ok: false, text: '', reason: 'the endpoint could not be reached'})});
  const b = await down.formulate({message: 'Este?', english: 'Yes.', packet: {}});
  assert.equal(b.applied, false);
  assert.match(b.reason, /could not be reached/);
});

test('the books judge writes blind verdicts per batch through the remote model and leaves unparsable items pending', async t => {
  const dir = tempDir(t, 'judge-');
  fs.writeFileSync(path.join(dir, 'judge-input-1.json'), JSON.stringify([{j: 'j001', problem: 'p', gold_answer: '4', candidate_answer: '4'}, {j: 'j002', problem: 'p', gold_answer: '4', candidate_answer: '5'}]));
  const r = await judgeBatches(dir, {chat: async () => ({ok: true, model: 'openference/Qwen3.8 27b', text: 'Verdicts: [{"j":"j001","verdict":"correct","reason":"same"},{"j":"j002","verdict":"maybe","reason":"x"}]'})});
  assert.deepEqual(r, {calls: 1, judged: 1, failed: 0});
  const out = JSON.parse(fs.readFileSync(path.join(dir, 'judge-output-1.json'), 'utf8'));
  assert.deepEqual(out.map(v => [v.j, v.verdict]), [['j001', 'correct']]);
});
