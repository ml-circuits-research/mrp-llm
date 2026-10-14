import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ask, capabilities, NotExpressibleError} from '../../reasoning/strategies/llm-agent/index.mjs';
import {parseAnswer} from '../../reasoning/strategies/llm-agent/packet.mjs';
import {verifyUsed, keepClaims} from '../../reasoning/strategies/llm-agent/verify.mjs';
import {sopPrompt, nlPrompt} from '../../reasoning/strategies/llm-agent/prompt.mjs';

const KN = '@parent predicate\n  args subject:entity object:entity\n@f1 fact\n  holds parent ann bob\n@f2 fact\n  holds parent bob cy\n@f3 fact\n  holds parent zed yan\n';
const Q = '@q query\n  where parent ?x bob\n  select ?x\n';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'llm-agent-test-'));
const fake = (text, extra = {}) => { const calls = []; const run = async a => { calls.push(a); return {ok: true, text, cost: 0.01, ms: 5, ...extra}; }; run.calls = calls; return run; };
const opts = (run, over = {}) => ({run, cacheDir: tmp(), fallbackModels: [], model: 'qwen-test', presentation: 'sop', ...over});

test('capabilities declare an advisory baseline: not exact, not bounded, not verified', () => {
  assert.equal(capabilities.exact, false);
  assert.equal(capabilities.bounded, false);
  assert.equal(capabilities.verified, false);
  assert.equal(capabilities.advisory, true);
});

test('strict parsing: a plain JSON object, one fence, or a marker line are accepted; anything else is an error packet', () => {
  assert.equal(parseAnswer('{"status":"supported","rows":[{"x":"ann"}]}').ok, true);
  assert.equal(parseAnswer('```json\n{"status":"refuted"}\n```').ok, true);
  assert.equal(parseAnswer('thinking...\nANSWER_JSON:\n{"status":"unknown"}', 'ANSWER_JSON:').ok, true);
  for (const bad of ['The answer is {"status":"supported"}', '{"status":"maybe"}', '{"rows":[]}', '[1]', '{"status":"supported","count":"3"}', '{"status":"supported","rows":[{"x":{"a":1}}]}', '', 'no json at all']) {
    const r = parseAnswer(bad);
    assert.equal(r.ok, false, bad);
    assert.equal(r.packet.status, 'error');
    assert.equal(r.packet.reason, 'malformed_output');
  }
  assert.equal(parseAnswer('{"status":"supported"}', 'ANSWER_JSON:').ok, false, 'a missing marker is an error, never a guess');
  assert.deepEqual(parseAnswer('x\nANSWER_JSON: {"status":"a"}\nmore\nANSWER_JSON: {"status":"unknown"}', 'ANSWER_JSON:').packet.status, 'unknown', 'the LAST marker counts');
});

test('budget_exhausted is never complete; unknown fields are dropped and noted', () => {
  const p = parseAnswer('{"status":"budget_exhausted","reason":"horizon","extra":1}').packet;
  assert.equal(p.complete, false);
  assert.match(p.notes[0], /extra/);
  assert.equal(parseAnswer('{"status":"unknown","complete":false}').ok, false);
});

test('ask: a well-formed answer becomes an advisory packet with route, cost and verified false', async () => {
  const run = fake('{"status":"supported","rows":[{"x":"ann"}],"used":["f1"]}');
  const p = await ask({theory: {knowledge: KN}, query: Q}, {}, opts(run, {reasoning: 'direct'}));
  assert.equal(p.status, 'supported');
  assert.deepEqual(p.rows, [{x: 'ann'}]);
  assert.equal(p.advisory, true);
  assert.equal(p.verified, false);
  assert.equal(p.route.chosen, 'llm-agent');
  assert.equal(p.route.backend, 'completion:qwen-test');
  assert.equal(p.llm.cost, 0.01);
  assert.deepEqual(p.used, [{id: 'f1', version: 1}]);
});

test('ask: malformed output is status error, never a guess', async () => {
  const p = await ask({theory: {knowledge: KN}, query: Q}, {}, opts(fake('I think the answer is ann.'), {reasoning: 'direct'}));
  assert.equal(p.status, 'error');
  assert.equal(p.reason, 'malformed_output');
  assert.equal(p.rows, undefined);
});

test('ask: a wall timeout is budget_exhausted reason wall; a provider failure is error provider', async () => {
  const t = await ask({theory: {knowledge: KN}, query: Q}, {}, opts(async () => ({ok: false, timedOut: true, cost: 0})));
  assert.equal(t.status, 'budget_exhausted');
  assert.equal(t.reason, 'wall');
  assert.equal(t.complete, false);
  const e = await ask({theory: {knowledge: KN}, query: Q}, {}, opts(async () => ({ok: false, error: 'boom'})));
  assert.equal(e.status, 'error');
  assert.equal(e.reason, 'provider');
});

test('ask: the fallback model answers when the first one fails', async () => {
  const seen = [];
  const run = async a => { seen.push(a.model); return a.model === 'qwen-a' ? {ok: false, error: 'auth'} : {ok: true, text: '{"status":"unknown"}', cost: 0}; };
  const p = await ask({theory: {knowledge: KN}, query: Q}, {}, opts(run, {model: 'qwen-a', fallbackModels: ['qwen-b'], reasoning: 'direct'}));
  assert.deepEqual(seen, ['qwen-a', 'qwen-b']);
  assert.equal(p.route.backend, 'completion:qwen-b');
});

test('cache: the same (model, presentation, case) is answered from the cache at no cost', async () => {
  const run = fake('{"status":"unknown"}');
  const o = opts(run, {reasoning: 'direct'});
  const a = await ask({theory: {knowledge: KN}, query: Q}, {}, o);
  const b = await ask({theory: {knowledge: KN}, query: Q}, {}, o);
  assert.equal(run.calls.length, 1);
  assert.equal(a.llm.cached, false);
  assert.equal(b.llm.cached, true);
  assert.equal(b.llm.cost, 0);
  await ask({theory: {knowledge: KN}, query: Q}, {}, {...o, model: 'qwen-other'});
  assert.equal(run.calls.length, 2, 'another model is another cache key');
});

test('inputs: the nl presentation needs a source; an oversize prompt is not expressible', async () => {
  await assert.rejects(ask({theory: {knowledge: KN}, query: Q}, {}, opts(fake('{}'), {presentation: 'nl'})), NotExpressibleError);
  await assert.rejects(ask({theory: {knowledge: KN}, query: Q}, {}, opts(fake('{}'), {maxChars: 100})), NotExpressibleError);
  const run = fake('{"status":"supported","rows":[{"x":"ann"}]}');
  const p = await ask({theory: {knowledge: KN}, query: Q, source: 'Ann is a parent of Bob.\n\nQuestion: who is a parent of Bob?'}, {}, opts(run, {presentation: 'nl', reasoning: 'direct'}));
  assert.equal(p.status, 'supported');
  assert.match(run.calls[0].prompt, /Ann is a parent of Bob/);
  assert.doesNotMatch(run.calls[0].prompt, /@f1 fact/, 'the nl presentation never shows the wires');
});

test('prompts: sop carries the semantics and the circuits; the cot reply rule asks for the marker', () => {
  const p = sopPrompt({knowledge: KN, query: Q});
  assert.match(p, /Reasoning conventions/);
  assert.match(p, /@f1 fact/);
  assert.match(p, /ANSWER_JSON:/);
  assert.doesNotMatch(sopPrompt({knowledge: KN, query: Q, reasoning: 'direct'}), /ANSWER_JSON:/);
  assert.match(nlPrompt({source: 'Text.'}), /TEXT:\nText\./);
});

test('verify: a used support that re-derives the answer in the oracle is verified per row; a wrong one is not', () => {
  assert.equal(keepClaims(KN, ['f1']).includes('@f2 fact'), false);
  const good = verifyUsed({knowledge: KN, query: Q}, {status: 'supported', rows: [{x: 'ann'}], used: [{id: 'f1'}]});
  assert.equal(good.verified, true);
  assert.deepEqual(good.row_verified, [{row: {x: 'ann'}, verified: true}]);
  const bad = verifyUsed({knowledge: KN, query: Q}, {status: 'supported', rows: [{x: 'ann'}], used: [{id: 'f3'}]});
  assert.equal(bad.verified, false);
  const none = verifyUsed({knowledge: KN, query: Q}, {status: 'supported', rows: [{x: 'ann'}]});
  assert.equal(none.verified, null);
});

test('ask with verify reports the per-row flag and keeps verified false when the claim fails the replay', async () => {
  const run = fake('{"status":"supported","rows":[{"x":"ann"}],"used":["f3"]}');
  const p = await ask({theory: {knowledge: KN}, query: Q}, {}, opts(run, {reasoning: 'direct', verify: true}));
  assert.equal(p.verified, false);
  assert.equal(p.row_verified[0].verified, false);
});
