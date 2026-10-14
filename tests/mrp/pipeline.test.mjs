import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Models} from '../../lib/mrp/models.mjs';
import {createMrpPipeline, doubted, languageName} from '../../lib/mrp/pipeline.mjs';

const FAQ = [{id: 'hours', q: 'What are your opening hours?', a: 'We are open from 9 to 17.', variants: ['When are you open?']}];

/** A fake Ploinky client: `reply(purpose, request)` returns the model text; every call is recorded. */
function fakeClient(reply) {
  const calls = [];
  return {calls, client: purpose => ({chat: async request => { calls.push({purpose, ...request}); const text = await reply(purpose, request); return text == null ? {ok: false, reason: 'down'} : {ok: true, text, served: 'fake/model'}; }})};
}
function setup(t, model = {}, reply = () => null, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mrp-pipe-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const models = new Models({root});
  models.create({id: 'm', faq: FAQ, ...model});
  const fake = fakeClient(reply);
  return {models, fake, mrp: createMrpPipeline({models, client: fake.client, ...options})};
}

test('normalize translates to English with the detected language; the answer language follows the message', async t => {
  const {mrp, fake} = setup(t, {}, (purpose) => purpose === 'normalize' ? 'Sure! {"language": "ro", "english": "Who works at Acme?", "changed": true}' : null);
  const pre = await mrp.before({modelId: 'm', text: 'Cine lucrează la Acme?'});
  assert.equal(pre.english, 'Who works at Acme?');
  assert.equal(pre.language, 'ro');
  assert.equal(pre.output, 'ro');
  assert.equal(pre.reflex, null);
  assert.equal(fake.calls[0].tier, 'small');
  assert.match(fake.calls[0].system, /reads only English/);
  assert.deepEqual(pre.trace.map(s => s.slot), ['normalize', 'reflex', 'affect']);
});

test('normalize degrades to the original text when the tier fails, and says so', async t => {
  const {mrp} = setup(t, {}, () => null);
  const pre = await mrp.before({modelId: 'm', text: 'Who works at Acme?'});
  assert.equal(pre.english, 'Who works at Acme?');
  assert.match(pre.trace[0].degraded, /tier small failed/);
});

test('translate-if-foreign and passthrough skip the model for English messages', async t => {
  const {mrp, fake} = setup(t, {slots: {normalize: 'translate-if-foreign'}});
  const pre = await mrp.before({modelId: 'm', text: 'Who works at Acme?'});
  assert.equal(pre.output, 'en');
  assert.equal(fake.calls.length, 0);
  assert.match(pre.trace[0].skipped, /English/);
});

test('reflex: a FAQ variant above the boundary ends the turn; the voice phrases it in the output language', async t => {
  const {mrp, models, fake} = setup(t, {slots: {normalize: 'passthrough', reflex: {strategy: 'faq-fixed', params: {threshold: 0.6}}}, language: {output: 'fr'}},
    purpose => purpose === 'voice' ? 'Nous sommes ouverts de 9 à 17.' : null);
  const pre = await mrp.before({modelId: 'm', text: 'When are you open?'});
  assert.equal(pre.reflex.id, 'hours');
  assert.equal(pre.output, 'fr');
  const out = await mrp.reflexReply({pre});
  assert.equal(out.text, 'Nous sommes ouverts de 9 à 17.');
  assert.match(fake.calls.at(-1).system, /French/);
  assert.equal(models.state('m').reflex.hits, 1);
});

test('reflex strategies: off never fires, margin needs a lead, the judge must confirm', async t => {
  const twoFaq = [...FAQ, {id: 'hours2', q: 'What are your opening hours on Sunday?', a: 'Closed.'}];
  const off = setup(t, {slots: {normalize: 'passthrough', reflex: 'off'}});
  assert.equal((await off.mrp.before({modelId: 'm', text: 'What are your opening hours?'})).reflex, null);
  const margin = setup(t, {faq: twoFaq, slots: {normalize: 'passthrough', reflex: {strategy: 'faq-margin', params: {threshold: 0.3, margin: 0.5}}}});
  const pre = await margin.mrp.before({modelId: 'm', text: 'opening hours'});
  assert.equal(pre.reflex, null);
  assert.ok(pre.trace[1].margin < 0.5);
  const judge = setup(t, {slots: {normalize: 'passthrough', reflex: 'faq-llm-judge'}}, purpose => purpose === 'reflex' ? '{"same": false}' : null);
  const j = await judge.mrp.before({modelId: 'm', text: 'What are your opening hours?'});
  assert.equal(j.reflex, null);
  assert.deepEqual(j.trace[1].judge, {same: false});
});

test('round trip: on-doubt runs only on doubtful circuits; a mismatch with warn adds a note before the voice', async t => {
  const sopDoubt = '@q query\n  where works_at ?x "acme"\n  select ?x\n\n@u unclear\n  text "which acme"';
  const replies = purpose => purpose === 'roundtrip' ? 'Which cities are in Romania?' : purpose === 'voice' ? null : null;
  const {mrp} = setup(t, {slots: {normalize: 'passthrough', roundtrip: {strategy: 'on-doubt', params: {onMismatch: 'warn'}}, voice: 'english-only'}}, replies);
  const pre = await mrp.before({modelId: 'm', text: 'Who works at Acme?'});
  const calm = await mrp.after({pre, result: {text: 'Answers: Ana.', sop: '@q query\n  where works_at ?x "acme"\n  select ?x', packet: {}}});
  assert.equal(calm.roundtrip, null);
  assert.equal(calm.trace.find(s => s.slot === 'roundtrip').note, 'the formalizer showed no doubt');
  const nothing = await mrp.after({pre, result: {text: 'I do not know.', sop: '@q unclear\n  kind relation_not_in_memory', packet: {}}});
  assert.equal(nothing.trace.find(s => s.slot === 'roundtrip').note, 'nothing was formalized');
  assert.equal(nothing.text, 'I do not know.');
  const doubtful = await mrp.after({pre, result: {text: 'Answers: Ana.', sop: sopDoubt, packet: {}}});
  assert.equal(doubtful.roundtrip.agree, false);
  assert.match(doubtful.text, /I understood your message as: "Which cities are in Romania\?"/);
});

test('round trip lexical-always agrees on a faithful restatement; llm-judge uses the model verdict', async t => {
  const {mrp} = setup(t, {slots: {normalize: 'passthrough', roundtrip: 'lexical-always', voice: 'english-only'}}, purpose => purpose === 'roundtrip' ? 'Who works at Acme?' : null);
  const pre = await mrp.before({modelId: 'm', text: 'Who works at Acme?'});
  const out = await mrp.after({pre, result: {text: 'Ana.', sop: '@q query\n  select ?x', packet: {}}});
  assert.equal(out.roundtrip.agree, true);
  assert.equal(out.roundtrip.score, 1);
  let n = 0;
  const judged = setup(t, {slots: {normalize: 'passthrough', roundtrip: 'llm-judge', voice: 'english-only'}}, purpose => purpose === 'roundtrip' ? (n++ ? '{"same": true}' : 'Which persons are employed by Acme?') : null);
  const pre2 = await judged.mrp.before({modelId: 'm', text: 'Who works at Acme?'});
  assert.equal((await judged.mrp.after({pre: pre2, result: {text: 'Ana.', sop: '@q query\n  select ?x', packet: {}}})).roundtrip.agree, true);
});

test('lexical-sampled checks only the sampled share', async t => {
  const {mrp, fake} = setup(t, {slots: {normalize: 'passthrough', roundtrip: {strategy: 'lexical-sampled', params: {rate: 0.2}}, voice: 'english-only'}}, () => 'x', {random: () => 0.9});
  const pre = await mrp.before({modelId: 'm', text: 'Who works at Acme?'});
  const out = await mrp.after({pre, result: {text: 'Ana.', sop: '@q query\n  select ?x', packet: {}}});
  assert.equal(out.trace.find(s => s.slot === 'roundtrip').note, 'not sampled');
  assert.equal(fake.calls.length, 0);
});

test('voice keeps the English answer when the phrasing drops a number, and translate-only skips English output', async t => {
  const {mrp} = setup(t, {slots: {normalize: 'passthrough', voice: 'translate-only'}, language: {output: 'ro'}}, purpose => purpose === 'voice' ? 'Răspuns: multe.' : null);
  const pre = await mrp.before({modelId: 'm', text: 'How many?'});
  const out = await mrp.after({pre, result: {text: 'Answer: 42.', sop: '', packet: {}}});
  assert.equal(out.text, 'Answer: 42.');
  assert.match(out.trace.at(-1).degraded, /dropped 42/);
  const en = setup(t, {slots: {normalize: 'passthrough', voice: 'translate-only'}, language: {output: 'en'}}, () => 'never');
  const pre2 = await en.mrp.before({modelId: 'm', text: 'How many?'});
  assert.equal((await en.mrp.after({pre: pre2, result: {text: 'Answer: 42.', sop: '', packet: {}}})).text, 'Answer: 42.');
  assert.equal(en.fake.calls.length, 0);
});

test('a model whose slot names an external strategy is refused with the requirement, never run with a substitute', async t => {
  const {mrp} = setup(t, {slots: {formalize: 'CNL-ACE'}});
  await assert.rejects(mrp.before({modelId: 'm', text: 'hi'}), e => e.code === 'strategy_unavailable' && /Attempto/.test(e.message));
});

test('affect llm-label tunes the voice; doubt signals and language names', async t => {
  const {mrp, fake} = setup(t, {slots: {normalize: 'passthrough', affect: 'llm-label', voice: 'natural-rephrase'}},
    purpose => purpose === 'affect' ? '{"label": "frustrated", "intensity": 0.9}' : purpose === 'voice' ? 'Sorry for the trouble: Ana works there.' : null);
  const pre = await mrp.before({modelId: 'm', text: 'WHO works at acme, I asked three times'});
  assert.deepEqual(pre.affect, {label: 'frustrated', intensity: 0.9});
  await mrp.after({pre, result: {text: 'Answers: Ana.', sop: '', packet: {}}});
  assert.match(fake.calls.at(-1).system, /frustrated/);
  assert.deepEqual(doubted({modelSop: '@a assumed\n  x 1', parse: {escalated: 1}}), ['assumed lines in the circuit', 'a formalization question escalated to a larger tier']);
  assert.equal(languageName('ro'), 'Romanian');
  assert.equal(languageName('xx'), 'xx');
});

test('normalize with context: previous turns are shown so the message becomes self-contained; context 0 reads the message alone', async t => {
  const {mrp, fake} = setup(t, {}, () => '{"language": "en", "english": "Given that MY_VAR is 100, what is MY_VAR?", "changed": true}');
  const history = [{role: 'user', text: 'Remember that MY_VAR is 100.'}, {role: 'assistant', text: 'Noted.'}];
  const pre = await mrp.before({modelId: 'm', text: 'What is MY_VAR?', history});
  assert.equal(pre.english, 'Given that MY_VAR is 100, what is MY_VAR?');
  assert.match(fake.calls[0].prompt, /PREVIOUS TURNS:\nUSER: Remember that MY_VAR is 100\.\nASSISTANT: Noted\.\n\nMESSAGE:\nWhat is MY_VAR\?/);
  assert.match(fake.calls[0].system, /self-contained/);
  assert.equal(pre.trace[0].context_turns, 2);
  const alone = setup(t, {slots: {normalize: {strategy: 'translate-llm', params: {context: 0}}}}, () => '{"language": "en", "english": "What is MY_VAR?"}');
  await alone.mrp.before({modelId: 'm', text: 'What is MY_VAR?', history});
  assert.doesNotMatch(alone.fake.calls[0].prompt, /PREVIOUS TURNS/);
});
