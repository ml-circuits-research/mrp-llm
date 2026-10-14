// The direct author of document ingestion (lib/ingest/direct-author.mjs; owner decision 2026-10-02: chat completions instead of an omp
// session per chunk). The completion client is a fake that answers from the conversation; no test calls a model or the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {ChatData} from '../../lib/chat-data/index.mjs';
import {BaseMemories} from '../../lib/chat-data/memories.mjs';
import {Ingestions, directAuthor, parseFiles, applyPatch, reasoningBody, directModel, redeclaredPredicates} from '../../lib/ingest/index.mjs';
import {runtimeConfig} from '../product-helpers.mjs';
import {tempDir} from '../helpers.mjs';

const library = t => new BaseMemories({chatData: ChatData.open({chatData: {root: tempDir(t, 'ingd-') + '/cd'}}, {}), memory: runtimeConfig().memory});

const DOC = `# Tiny Handbook

## 1. Staff

Ann works in the Workshop. Bob works in the Office.

## 2. Remote work

Office staff may work remotely.
`;

const WORKS_IN = `@works_in predicate
  args subject:entity object:entity
  label en "works in"
  description "the department a person works in"
`;
const reply = (knowledge, queries = '', report = 'Nothing left out.') => `=== BEGIN knowledge.sop ===\n${knowledge}\n=== END knowledge.sop ===\n=== BEGIN queries.sop ===\n${queries}\n=== END queries.sop ===\n=== BEGIN report.md ===\n${report}\n=== END report.md ===\n`;

/** A fake completion client: `answer(messages)` returns the reply text; every call is recorded. */
const fakeChat = (answer, calls = []) => async ({messages, model, extraBody, tags}) => {
  calls.push({messages: messages.map(m => ({...m})), model, extraBody, tags});
  await new Promise(r => setTimeout(r, 5));
  return {ok: true, text: answer(messages, calls.length), usage: {input_tokens: 100, output_tokens: 50}, finish_reason: 'stop', ms: 5};
};

test('direct author: a repair patch replaces wires by id, appends new ones and removes listed ones', () => {
  const text = '@a fact\n  holds p x\n\n@b fact\n  holds p y\n\n@c fact\n  holds p z\n';
  assert.equal(applyPatch(text, '@b fact\n  holds p w\n\n@d fact\n  holds p v\n', ['c']), '@a fact\n  holds p x\n\n@b fact\n  holds p w\n\n@d fact\n  holds p v\n');
  assert.equal(applyPatch(text, '', []), text);
});

test('direct author: parsing the reply blocks, the reasoning setting and the model name', () => {
  const files = parseFiles('<think>plan</think>\n' + reply('```sop\n@a fact\n  holds p x\n```', '', 'ok'));
  assert.equal(files['knowledge.sop'], '@a fact\n  holds p x\n', 'a code fence inside a block is not part of the file');
  assert.equal(files['queries.sop'], '');
  assert.equal(files['report.md'], 'ok\n');
  assert.deepEqual(parseFiles('no blocks'), {'knowledge.sop': '', 'queries.sop': '', 'report.md': ''});
  assert.deepEqual(reasoningBody('off'), {chat_template_kwargs: {enable_thinking: false}});
  assert.deepEqual(reasoningBody('low'), {reasoning_effort: 'low'});
  assert.throws(() => reasoningBody('huge'), /reasoning/);
  assert.equal(directModel('openference/Qwen3.8 27b'), 'Qwen3.8 27b', 'a chain id of the default provider loses its prefix');
  assert.equal(directModel('good'), 'good');
  assert.equal(directModel(null), 'small', 'the default is the Ploinky tier small');
});

test('direct author: the validator and the caller check run in repair rounds of the same conversation', async t => {
  const folder = tempDir(t, 'ingd-task-');
  const bad = `${WORKS_IN}\n@c1_f1 fact\n  holds works_in ann workshop\n  quote "Ann works in the Workshops."\n`;
  const good = bad.replace('Workshops.', 'Workshop.');
  const calls = [];
  const check = knowledge => (/Workshops/.test(knowledge) ? [{code: 'quote_not_in_source', wire: 'c1_f1', message: 'not in the passage'}] : []);
  const result = await directAuthor({folder, files: [{name: 'passage.md', text: DOC}], instructions: 'Compile the passage.', existing: [{name: 'm.sop', text: '@lives_in predicate\n  args subject:entity object:entity\n'}],
    reasoning: 'low', check, chat: fakeChat((messages, n) => (n === 1 ? reply(bad) : reply(good)), calls)});
  assert.equal(result.status, 'validated');
  assert.equal(result.rounds, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].extraBody, {reasoning_effort: 'low'});
  assert.equal(calls[0].tags.purpose, 'job:ingest-document', 'the calls are tagged for the Ploinky log');
  assert.match(calls[0].messages[0].content, /Skill file SKILL\.md/, 'the system message carries the authoring skill');
  assert.match(calls[0].messages[1].content, /input\/existing-vocabulary\.sop[\s\S]*@lives_in predicate/, 'the vocabulary of the memory is attached');
  assert.match(calls[0].messages[1].content, /input\/passage\.md[\s\S]*Ann works in the Workshop\./);
  assert.equal(calls[1].messages.length, 4, 'the repair continues the conversation: system, request, answer, problems');
  assert.match(calls[1].messages[3].content, /quote_not_in_source \(@c1_f1\)/);
  assert.equal(fs.readFileSync(path.join(folder, 'knowledge.sop'), 'utf8'), good);
  for (const f of ['TASK.md', 'queries.sop', 'report.md', 'result.json', 'transcript.json', 'input/passage.md', 'input/existing-vocabulary.sop']) assert.ok(fs.existsSync(path.join(folder, f)), f);

  const failed = await directAuthor({folder: tempDir(t, 'ingd-fail-'), files: [{name: 'p.md', text: DOC}], instructions: 'x', maxFixRounds: 1,
    chat: async () => ({ok: false, text: '', usage: {}, ms: 1, reason: 'the endpoint could not be reached: refused'})});
  assert.equal(failed.status, 'failed');
  assert.equal(failed.runs.length, 3, 'two transport failures are retried');
  assert.match(failed.reason, /could not be reached/);
});

test('ingest with the direct author (default): chunks in parallel, merged in order, labelled, stored', async t => {
  const bm = library(t);
  const memory = bm.create({name: 'policies', imports: []});
  const ingestions = new Ingestions({memories: bm});
  const calls = [];
  // Both chunks declare works_in (drafted in parallel, neither sees the other); the entity stage labels the symbols.
  const answer = messages => {
    const request = messages[1].content;
    if (/input\/symbols\.txt/.test(request)) {
      const symbols = /=== BEGIN input\/symbols\.txt ===\n([\s\S]*?)\n=== END/.exec(request)[1].split('\n');
      return reply(symbols.map(s => `@${s} entity\n  label en "${s[0].toUpperCase() + s.slice(1)}"\n`).join('\n'));
    }
    if (/Remote work/.test(request)) return reply(`${WORKS_IN}\n@may_work_remotely predicate\n  args subject:entity\n  description "whether a person may work remotely"\n\n@d1c2_r1 rule\n  when all\n    works_in ?p office\n  end\n  then may_work_remotely ?p\n  quote "Office staff may work remotely."\n`,
      '@q query\n  select ?p\n  where may_work_remotely ?p\n');
    return reply(`${WORKS_IN}\n@d1c1_f1 fact\n  holds works_in ann workshop\n  quote "Ann works in the Workshop."\n\n@d1c1_f2 fact\n  holds works_in bob office\n  quote "Bob works in the Office."\n`);
  };
  const record = await ingestions.draft(memory.id, {documents: [{name: 'tiny.md', text: DOC, source: {rights: 'cleared'}}], maxChunkBytes: 100, concurrency: 2, chat: fakeChat(answer, calls)});
  assert.equal(record.author, 'direct');
  assert.equal(record.status, 'stored', JSON.stringify(record.chunks.map(c => [c.key, c.status, c.problems])));
  const chunks = record.chunks.filter(c => !c.key.endsWith('-entities'));
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every(c => c.status === 'stored'));
  assert.deepEqual(chunks[1].redeclared, ['works_in'], 'the later chunk drops the predicate the earlier one declared with the same signature');
  const labels = record.chunks.find(c => c.key.endsWith('-entities'));
  assert.equal(labels.status, 'stored');
  assert.equal(calls.length, 3, 'one call per chunk and one for the entity stage');
  assert.ok(calls.every(c => c.model === 'small' && c.tags.run === record.id), 'a tier, never a concrete model; the run is the ingestion');
  assert.equal(bm.lexicon(memory.id).entities.bob.labels.en, 'Bob');
  assert.equal(bm.manifest(memory.id).circuits, 3);
  assert.match(fs.readFileSync(path.join(ingestions.dir(memory.id, record.id), 'report.md'), 'utf8'), /author direct, model small, reasoning off/);
  assert.ok(fs.existsSync(path.join(ingestions.dir(memory.id, record.id), 'chunks', chunks[0].key, 'transcript.json')));
});

test('ingest with the direct author: a clash between parallel chunks is repaired in the chunk\'s own conversation when merged', async t => {
  const bm = library(t);
  const memory = bm.create({name: 'policies', imports: []});
  const ingestions = new Ingestions({memories: bm});
  const calls = [];
  const clash = `@works_in predicate\n  args subject:entity\n  description "whether a person works"\n\n@d1c2_f1 fact\n  holds works_in ann\n  quote "Office staff may work remotely."\n`;
  const fixed = `@d1c2_f1 fact\n  holds works_in ann office\n  quote "Office staff may work remotely."\n`;
  const answer = messages => {
    const request = messages[1].content;
    if (/input\/symbols\.txt/.test(request)) return reply('@ann entity\n  label en "Ann"\n');
    if (/Remote work/.test(request)) return messages.length > 2 ? `${reply(fixed)}=== BEGIN remove ===\nworks_in\n=== END remove ===\n` : reply(clash);
    return reply(`${WORKS_IN}\n@d1c1_f1 fact\n  holds works_in ann workshop\n  quote "Ann works in the Workshop."\n`);
  };
  const record = await ingestions.draft(memory.id, {documents: [{name: 'tiny.md', text: DOC, source: {rights: 'cleared'}}], maxChunkBytes: 100, concurrency: 2, chat: fakeChat(answer, calls)});
  const second = record.chunks.find(c => c.index === 2 && !c.key.endsWith('-entities'));
  assert.equal(second.merge_repair, true);
  assert.equal(second.status, 'stored', JSON.stringify(second.problems));
  const repair = calls.find(c => c.messages.length === 4);
  assert.match(repair.messages[3].content, /duplicate_id[\s\S]*Correct them with a patch/, 'the merge problems are sent back in the same conversation, as a patch request');
  assert.equal(redeclaredPredicates(clash, [{name: 'a', text: WORKS_IN}]).length, 0, 'a different signature is not dropped silently');
});

test('direct author: the chat client asks a Ploinky tier (not streamed), tagged, and collects text, finish reason and usage', async () => {
  const sent = [];
  const answering = (body, status = 200) => async (url, init) => { sent.push({url, headers: init.headers, body: JSON.parse(init.body)}); return new Response(body, {status}); };
  const {openaiChat} = await import('../../lib/ingest/direct-author.mjs');
  const plain = await openaiChat({fetchImpl: answering('{"choices":[{"message":{"content":"<think>p</think>hi"},"finish_reason":"length"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"cost":0.002}}')})(
    {messages: [{role: 'user', content: 'x'}], model: 'small', extraBody: {reasoning_effort: 'low'}, tags: {purpose: 'job:ingest-document', run: 'r1'}});
  assert.equal(new URL(sent[0].url).pathname, '/v1/chat/completions');
  assert.deepEqual([sent[0].body.model, sent[0].body.stream, sent[0].body.reasoning_effort, sent[0].body.max_tokens], ['small', false, 'low', 5000]);
  assert.equal(sent[0].headers['x-pworker-purpose'], 'job:ingest-document');
  assert.equal(sent[0].headers['x-pworker-run'], 'r1');
  assert.deepEqual([plain.ok, plain.text, plain.finish_reason, plain.usage.input_tokens, plain.usage.output_tokens, plain.usage.cost_usd], [true, '<think>p</think>hi', 'length', 3, 1, 0.002], 'the raw text: parseFiles strips the thinking');
  await openaiChat({upstream: 'openrouter', purpose: 'ingest', fetchImpl: answering('{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}],"usage":{"completion_tokens":1}}')})({messages: [], model: 'deepseek/deepseek-v4-flash'});
  assert.equal(new URL(sent[1].url).pathname, '/u/openrouter/v1/chat/completions', 'a concrete model goes to its provider route');
  assert.equal(sent[1].body.model, 'deepseek/deepseek-v4-flash');
  assert.equal(sent[1].headers['x-pworker-purpose'], 'ingest');
  const cut = await openaiChat({fetchImpl: answering('{"choices":[{"message":{"content":"1 2 3"},"finish_reason":"stop"}]}')})({messages: [], model: 'small'});
  assert.equal(cut.finish_reason, 'interrupted', 'a "stop" without usage ended early upstream');
  const refused = await openaiChat({fetchImpl: answering('{"error":"busy"}', 429)})({messages: [], model: 'small'});
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /429/);
  const down = await openaiChat({fetchImpl: async () => { throw new Error('ECONNREFUSED'); }})({messages: [], model: 'small'});
  assert.equal(down.ok, false);
  assert.match(down.reason, /could not be reached/);
});

test('direct author: an answer cut mid-way keeps its complete wires and continues as a patch', async t => {
  const folder = tempDir(t, 'ingd-cut-');
  const first = `=== BEGIN knowledge.sop ===\n${WORKS_IN}\n@c1_f1 fact\n  holds works_in ann workshop\n  quote "Ann works in the Workshop."\n\n@c1_f2 fact\n  holds works_in bo`;
  const rest = reply('@c1_f2 fact\n  holds works_in bob office\n  quote "Bob works in the Office."\n');
  const calls = [];
  const chat = async ({messages}) => { calls.push(messages.length); return calls.length === 1 ? {ok: true, text: first, finish_reason: 'length', usage: {}, ms: 1} : {ok: true, text: rest, finish_reason: 'stop', usage: {}, ms: 1}; };
  const result = await directAuthor({folder, files: [{name: 'p.md', text: DOC}], instructions: 'x', maxFixRounds: 0, chat});
  assert.equal(result.status, 'validated', JSON.stringify(result.validation.problems));
  assert.match(result.circuits[0].text, /@c1_f1 fact[\s\S]*@c1_f2 fact\n  holds works_in bob office/);
  assert.equal(calls.length, 2, 'the continuation is not counted as a repair');

  // An answer that ended early upstream (finish "stop" without usage) before its first block is asked again.
  const seen = [];
  const flaky = async ({messages}) => { seen.push(messages.length); return seen.length === 1 ? {ok: true, text: 'I will now', finish_reason: 'interrupted', usage: {}, ms: 1} : {ok: true, text: reply(`${WORKS_IN}`), finish_reason: 'stop', usage: {}, ms: 1}; };
  const again = await directAuthor({folder: tempDir(t, 'ingd-int-'), files: [{name: 'p.md', text: DOC}], instructions: 'x', maxFixRounds: 0, chat: flaky});
  assert.equal(again.status, 'validated');
  assert.deepEqual(seen, [2, 2], 'the same request is sent again');
});
