import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Models, profiles, checkSlots} from '../../lib/mrp/models.mjs';
import {SLOTS, SLOT_IDS, STRATEGIES, DEFAULT_SLOTS, strategy, checkParams, availability, catalog} from '../../lib/mrp/strategies.mjs';

const store = t => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mrp-models-')); t.after(() => fs.rmSync(root, {recursive: true, force: true})); return new Models({root}); };

test('every slot has a default strategy that exists, runs on the server and has valid default parameters', () => {
  for (const slot of SLOTS) {
    const s = strategy(slot.id, DEFAULT_SLOTS[slot.id]);
    assert.ok(s, slot.id);
    assert.equal(s.runs, 'server', slot.id);
    assert.deepEqual(Object.keys(checkParams(s, {})), s.params.map(p => p.key));
  }
  assert.equal(new Set(STRATEGIES.map(s => s.slot + '/' + s.id)).size, STRATEGIES.length);
  for (const s of STRATEGIES) { assert.ok(SLOT_IDS.includes(s.slot)); assert.ok(s.summary && s.title, s.id); if (s.runs === 'external') assert.ok(s.requires, s.id); }
});

test('the open design questions are slots with several documented strategies', () => {
  for (const slot of ['reflex', 'roundtrip', 'commit', 'normalize', 'voice']) assert.ok(STRATEGIES.filter(s => s.slot === slot).length >= 3, slot);
  assert.ok(STRATEGIES.filter(s => s.slot === 'discover' && s.id.startsWith('sae-')).length >= 3, 'several SAE strategies');
});

test('parameters are checked: unknown keys, ranges and enums are refused', () => {
  const s = strategy('reflex', 'faq-margin');
  assert.deepEqual(checkParams(s, {threshold: 0.5}), {threshold: 0.5, margin: 0.15});
  assert.throws(() => checkParams(s, {nope: 1}), /no parameter nope/);
  assert.throws(() => checkParams(s, {threshold: 2}), /invalid threshold/);
  assert.throws(() => checkParams(strategy('roundtrip', 'on-doubt'), {onMismatch: 'shout'}), /invalid onMismatch/);
  assert.throws(() => checkSlots({nope: 'x'}), /unknown slot/);
  assert.throws(() => checkSlots({reflex: 'faq-psychic'}), /no strategy/);
});

test('availability: server strategies check their tier, external strategies report their requirement', async () => {
  const tierCheck = async tier => tier === 'small' ? {available: true} : {available: false, reason: 'not configured'};
  assert.deepEqual(await availability(strategy('normalize', 'translate-llm'), {tierCheck}), {available: true, status: 'ready'});
  assert.match((await availability(strategy('normalize', 'translate-llm'), {tierCheck, params: {tier: 'gone'}})).reason, /tier gone: not configured/);
  assert.deepEqual(await availability(strategy('reflex', 'faq-fixed'), {tierCheck}), {available: true, status: 'ready'});
  const ext = await availability(strategy('discover', 'sae-pretrained-dictionary'), {tierCheck});
  assert.equal(ext.available, false);
  assert.match(ext.reason, /sentence-embedding/);
  assert.equal(ext.status, 'not-implemented', 'a catalog entry without code says so, apart from a missing dependency');
  const all = await catalog({check: true, tierCheck});
  assert.equal(all.length, SLOTS.length);
});

test('a model is created from a profile; effective settings layer catalog defaults, model, session and request', t => {
  const models = store(t);
  for (const p of profiles()) models.create({id: p.id, profile: p.id});
  assert.ok(models.ids().includes('acme-demo') && models.ids().includes('rigorous-judge'));
  const e = models.effective('acme-demo', {session: {language: 'ro'}, request: {slots: {roundtrip: {strategy: 'lexical-sampled', params: {rate: 0.5}}}}});
  assert.equal(e.language.output, 'ro');
  assert.equal(e.slots.reflex.strategy, 'faq-feedback');
  assert.deepEqual(e.slots.roundtrip, {strategy: 'lexical-sampled', params: {tier: 'small', threshold: 0.4, rate: 0.5, onMismatch: 'note'}});
  assert.equal(e.slots.admit.strategy, 'validate-repair');
  assert.deepEqual(e.overridden, ['session:language', 'request:slots']);
  const strict = models.effective('rigorous-judge', {request: {slots: {reflex: 'faq-fixed'}}});
  assert.equal(strict.slots.reflex.strategy, 'off');
  assert.deepEqual(strict.refused, ['request']);
});

test('model fields are validated and updates keep id and creation time', t => {
  const models = store(t);
  assert.throws(() => models.create({id: 'Bad Id'}), /needs an id/);
  const m = models.create({id: 'm1', faq: [{q: 'Hours?', a: '9-17', variants: ['When open?']}]});
  assert.throws(() => models.create({id: 'm1'}), /already exists/);
  assert.throws(() => models.update('m1', {language: {output: 'klingon!'}}), /language.output/);
  assert.throws(() => models.update('m1', {faq: [{q: 'x'}]}), /needs a question q and an answer a/);
  assert.throws(() => models.update('m1', {id: 'm2'}), /unsupported model field id/);
  const u = models.update('m1', {name: 'Renamed', slots: {voice: 'english-only'}});
  assert.equal(u.id, 'm1');
  assert.equal(u.created_at, m.created_at);
  assert.equal(models.effective('m1').slots.voice.strategy, 'english-only');
  assert.deepEqual(models.get('m1').faq[0].variants, ['When open?']);
});

test('faq-feedback: a down vote raises the boundary, an up vote on a borderline answer lowers it, within bounds', t => {
  const models = store(t);
  models.create({id: 'f', slots: {reflex: {strategy: 'faq-feedback', params: {threshold: 0.6, step: 0.05, min: 0.5, max: 0.7}}}, faq: [{q: 'a', a: 'b'}]});
  models.reflexFeedback('f', {score: 0.62, helpful: false});
  assert.equal(models.effective('f').slots.reflex.params.threshold, 0.65);
  models.reflexFeedback('f', {score: 0.66, helpful: false});
  models.reflexFeedback('f', {score: 0.69, helpful: false});
  assert.equal(models.effective('f').slots.reflex.params.threshold, 0.7);
  models.reflexFeedback('f', {score: 0.72, helpful: true});
  assert.equal(models.effective('f').slots.reflex.params.threshold, 0.675);
  assert.deepEqual([models.state('f').reflex.up, models.state('f').reflex.down], [1, 3]);
});

test('the review queue keeps items and their decisions', t => {
  const models = store(t);
  models.create({id: 'q'});
  models.queueReview('q', {session: 's1', circuits: [{name: 'a.sop', text: '@a fact\n  holds p x y'}]});
  const [item] = models.state('q').review;
  assert.equal(item.status, 'pending');
  models.setReviewStatus('q', item.id, 'rejected', {by: 'me'});
  assert.equal(models.reviewItem('q', item.id).status, 'rejected');
  assert.throws(() => models.reviewItem('q', '00000000-0000-0000-0000-000000000000'), /unknown review item/);
});

test('ensureDefaults creates the first-start profiles only when no model exists and their base memory exists', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mrp-models-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const memories = {manifest: id => { if (id !== 'default') throw new Error('missing'); return {id}; }};
  const models = new Models({root, memories});
  assert.deepEqual(models.ensureDefaults(), ['general']);
  assert.deepEqual(models.ensureDefaults(), []);
});

test('a stored model that names a strategy no longer in the catalog is refused with the reason, not a crash', t => {
  const models = store(t);
  models.create({id: 'old'});
  const file = path.join(models.dir('old'), 'model.json');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  stored.slots.memory = {strategy: 'hybrid', params: {}};
  fs.writeFileSync(file, JSON.stringify(stored));
  assert.throws(() => models.effective('old'), e => e.code === 'strategy_unavailable' && /hybrid/.test(e.message));
  assert.equal(models.list().length, 1, 'listing the models still works');
});

test('a strategy of the strategy service with a tier is available when the service runs its operations and the tier answers', async t => {
  const {configureStrategyService} = await import('../../lib/mrp/strategy-service.mjs');
  const http = await import('node:http');
  const srv = http.createServer((req, res) => { res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({ok: true, strategies: {'parse/spacy': {available: true}}})); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  t.after(() => { srv.close(); configureStrategyService(null); });
  configureStrategyService(`http://127.0.0.1:${srv.address().port}`);
  const tierCheck = async tier => tier === 'tiny' ? {available: true} : {available: false, reason: 'no tier'};
  assert.deepEqual(await availability(strategy('formalize', 'DependencyScaffold'), {tierCheck}), {available: true, status: 'ready'});
  assert.match((await availability(strategy('formalize', 'DependencyScaffold'), {tierCheck, params: {tier: 'gone'}})).reason, /tier gone: no tier/);
});
