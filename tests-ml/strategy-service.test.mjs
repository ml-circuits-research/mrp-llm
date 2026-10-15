// The strategy service with its real models (SPLADE, bge, spaCy, FrameNet, a small SAE): `npm run test:ml`, never part of `npm test`.
// It needs the private environment tools/.solvers/mrp-env and the models in the HuggingFace cache (dependencies.md); no language model
// is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {servicePython, SERVICE_SCRIPT, serviceSelfcheck, configureStrategyService, serviceCall} from '../lib/mrp/strategy-service.mjs';

const port = 19900 + Math.floor(Math.random() * 90);
const url = `http://127.0.0.1:${port}`;
let child;
test.before(async () => {
  child = spawn(servicePython(), ['-I', SERVICE_SCRIPT], {env: {...process.env, MRP_STRATEGY_SERVICE_PORT: String(port)}, stdio: 'ignore'});
  configureStrategyService(url);
  for (let i = 0; i < 60 && !(await serviceSelfcheck({url, now: Date.now() + i * 60_000})).ok; i++) await new Promise(r => setTimeout(r, 250));
});
test.after(() => child?.kill());
const call = (slot, op, input, params) => serviceCall(slot, op, input, params, {url});

test('every operation of the service is available in the private environment', async () => {
  const check = await serviceSelfcheck({url, now: Date.now() + 1e9});
  assert.equal(check.ok, true);
  for (const [op, s] of Object.entries(check.strategies)) assert.equal(s.available, true, `${op}: ${s.reason}`);
});

test('SPLADE expands "employed" towards work; dense vectors are normalized; spaCy parses the question', async () => {
  const [vec] = (await call('encode', 'splade', {texts: ['Who is employed by Acme?'], top: 40})).vectors;
  assert.ok(vec.employed || vec.employ || vec.employment, JSON.stringify(vec));
  const [a] = (await call('encode', 'dense', {texts: ['hello']})).vectors;
  assert.ok(Math.abs(Math.hypot(...a) - 1) < 1e-3);
  const {tokens} = await call('parse', 'spacy', {text: 'Who works at Acme?'});
  assert.deepEqual(tokens.map(t => t.dep).slice(0, 4), ['nsubj', 'ROOT', 'prep', 'pobj']);
});

test('FrameNet knows the frame of work.v; a small SAE trains and encodes', async t => {
  const {frames} = await call('frames', 'framenet', {lemmas: ['work.v']});
  assert.ok(frames['work.v'].some(f => f.frame === 'Being_employed'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mrp-sae-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const passages = ['Ana works at Acme.', 'Dan works at Acme.', 'Elena works at Globex.', 'Acme is in Cluj.', 'Globex is in Bucharest.', 'Ana is the parent of Bogdan.'];
  const trained = await call('sae', 'train', {passages, path: path.join(dir, 's.pt')}, {latents: 32, epochs: 50, top: 5});
  assert.ok(trained.features.length > 0);
  const {features} = await call('sae', 'encode', {path: path.join(dir, 's.pt'), texts: ['Who works at Acme?'], top: 4});
  assert.ok(features[0].length > 0);
});
