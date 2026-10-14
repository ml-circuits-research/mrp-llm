// Knowledge authoring without omp (owner 2026-10-02): the shared helpers (lib/authoring/circuits.mjs) and POST /v1/author, which calls a
// model of the formalizer chain directly (lib/ingest/direct-author.mjs). Every model is a stub; no test calls a real model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {checkFiles, validateAuthored, vocabularyOf} from '../../lib/authoring/circuits.mjs';
import {FAMILY, productServer, stubAuthorChat} from '../product-helpers.mjs';

test('authoring: files are checked (text only, safe names, bounded)', () => {
  assert.deepEqual(checkFiles([{name: '../../etc/passwd', text: 'x'}, {name: 'passwd', text: 'y'}]).map(f => f.name), ['passwd', '2-passwd']);
  assert.throws(() => checkFiles([{name: 'a.bin', text: 'a\0b'}]), e => e.code === 'unsupported_file');
  assert.throws(() => checkFiles([{name: 'a'}]), e => e.code === 'invalid_files');
  assert.throws(() => checkFiles(Array.from({length: 11}, (_, i) => ({name: `f${i}`, text: 'x'}))), e => e.status === 413);
  assert.throws(() => checkFiles([{name: 'big', text: 'x'.repeat(2_000_001)}]), e => e.status === 413);
});

test('authoring: circuits are validated together with the theory they join (duplicate ids, forbidden wires); the vocabulary is offered', () => {
  const existing = [{name: 'family', text: FAMILY}];
  assert.equal(validateAuthored({knowledge: FAMILY, existing}).problems.some(p => p.code === 'duplicate_id'), true);
  assert.equal(validateAuthored({knowledge: '@j jsEval\n  expression 1\n', existing: []}).ok, false);
  assert.equal(validateAuthored({knowledge: FAMILY, queries: '@q query\n  where great_grandparent ?who di\n  select ?who\n'}).ok, true);
  assert.equal(validateAuthored({knowledge: ''}).problems[0].code, 'missing_output');
  assert.match(vocabularyOf(existing), /predicate/);
});

test('API: POST /v1/author calls the chain model directly and adds the validated circuits to the session; no omp route remains', async t => {
  const chat = stubAuthorChat();
  const s = await productServer(t, {serverOptions: {authorChat: chat}});
  await s.admin('/v1/memories', 'POST', {name: 'Empty', id: 'empty'});
  assert.equal((await s.user('/v1/omp/models')).status, 404, 'the omp model listing is gone');
  const sid = (await s.user('/v1/sessions', 'POST', {base: 'empty'})).body.id;
  assert.equal((await s.user('/v1/author', 'POST', {session: sid})).status, 400, 'needs files or instructions');
  assert.equal((await s.user('/v1/author', 'POST', {session: sid, instructions: 'x', bogus: 1})).status, 400);
  const done = await s.user('/v1/author', 'POST', {session: sid, files: [{name: 'family.txt', text: 'Ann is the parent of Bob.'}], instructions: 'Compile.', model: 'openrouter/deepseek/deepseek-v4-flash'});
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.status, 'validated');
  assert.equal(done.body.model, 'openrouter/deepseek/deepseek-v4-flash');
  assert.equal(done.body.cost_class, 'paid_api');
  assert.equal(chat.calls.at(-1).model, 'deepseek/deepseek-v4-flash', 'the provider prefix selects the endpoint; the model name goes to it');
  assert.match(done.body.added.file, /authored-r-/);
  assert.match(done.body.folder, new RegExp(`^sessions/${sid}/requests/r-`));
  assert.ok(fs.existsSync(path.join(s.chatData.root, done.body.folder, 'input', 'family.txt')));
  assert.match((await s.user(`/v1/sessions/${sid}/theory`)).body.theory, /@r_grand/, 'validated circuits join the session at once');
  assert.equal((await s.user(`/v1/sessions/${sid}/requests/${done.body.request_id}`)).body.status, 'validated');
  assert.equal((await s.user(`/v1/sessions/${sid}/requests/r-none`)).status, 404);
});

test('API: wait false answers 202 and the status route follows the request; a request without a session uses tmp; ingestion refuses the omp author', async t => {
  const s = await productServer(t);
  await s.admin('/v1/memories', 'POST', {name: 'Empty', id: 'empty'});
  const sid = (await s.user('/v1/sessions', 'POST', {base: 'empty'})).body.id;
  const started = await s.user('/v1/author', 'POST', {session: sid, instructions: 'Compile.', wait: false});
  assert.equal(started.status, 202);
  let status;
  for (let i = 0; i < 100; i++) {
    status = (await s.user(started.body.status_url)).body;
    if (status.status !== 'running') break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(status.status, 'validated');
  assert.ok(status.result.added?.file);
  const loose = await s.user('/v1/author', 'POST', {instructions: 'Compile.'});
  assert.equal(loose.status, 200);
  assert.equal(loose.body.added, null);
  assert.match(loose.body.folder, /^tmp\//);
  const omp = await s.admin('/v1/memories/empty/ingest', 'POST', {documents: [{name: 'a.txt', text: 'Ann is the parent of Bob.', source: {rights: 'cleared'}}], author: 'omp'});
  assert.equal(omp.status, 400);
  assert.match(omp.body.error.message, /omp author was retired/);
});
