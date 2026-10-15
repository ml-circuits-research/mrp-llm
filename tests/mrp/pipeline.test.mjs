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
  assert.match(fake.calls[0].prompt, /reads only English/);
  assert.deepEqual(pre.trace.map(s => s.slot), ['normalize', 'affect', 'reflex']);
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
  assert.match(fake.calls.at(-1).prompt, /French/);
  assert.equal(models.state('m').reflex.hits, 1);
});

test('reflex strategies: off never fires, margin needs a lead, the judge must confirm', async t => {
  const twoFaq = [...FAQ, {id: 'hours2', q: 'What are your opening hours on Sunday?', a: 'Closed.'}];
  const off = setup(t, {slots: {normalize: 'passthrough', reflex: 'off'}});
  assert.equal((await off.mrp.before({modelId: 'm', text: 'What are your opening hours?'})).reflex, null);
  const margin = setup(t, {faq: twoFaq, slots: {normalize: 'passthrough', reflex: {strategy: 'faq-margin', params: {threshold: 0.3, margin: 0.5}}}});
  const pre = await margin.mrp.before({modelId: 'm', text: 'opening hours'});
  assert.equal(pre.reflex, null);
  assert.ok(pre.trace.find(s => s.slot === 'reflex').margin < 0.5);
  const judge = setup(t, {slots: {normalize: 'passthrough', reflex: 'faq-llm-judge'}}, purpose => purpose === 'reflex' ? '{"same": false}' : null);
  const j = await judge.mrp.before({modelId: 'm', text: 'What are your opening hours?'});
  assert.equal(j.reflex, null);
  assert.deepEqual(j.trace.find(s => s.slot === 'reflex').judge, {same: false});
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
  const {mrp} = setup(t, {slots: {discover: 'sae-pretrained-dictionary'}});
  await assert.rejects(mrp.before({modelId: 'm', text: 'hi'}), e => e.code === 'strategy_unavailable' && /not implemented yet/.test(e.message));
});

test('affect llm-label tunes the voice; doubt signals and language names', async t => {
  const {mrp, fake} = setup(t, {slots: {normalize: 'passthrough', affect: 'llm-label', voice: 'natural-rephrase'}},
    purpose => purpose === 'affect' ? '{"label": "frustrated", "intensity": 0.9}' : purpose === 'voice' ? 'Sorry for the trouble: Ana works there.' : null);
  const pre = await mrp.before({modelId: 'm', text: 'WHO works at acme, I asked three times'});
  assert.deepEqual(pre.affect, {label: 'frustrated', intensity: 0.9});
  await mrp.after({pre, result: {text: 'Answers: Ana.', sop: '', packet: {}}});
  assert.match(fake.calls.at(-1).prompt, /frustrated/);
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
  assert.match(fake.calls[0].prompt, /self-contained/);
  assert.equal(pre.trace[0].context_turns, 2);
  const alone = setup(t, {slots: {normalize: {strategy: 'translate-llm', params: {context: 0}}}}, () => '{"language": "en", "english": "What is MY_VAR?"}');
  await alone.mrp.before({modelId: 'm', text: 'What is MY_VAR?', history});
  assert.doesNotMatch(alone.fake.calls[0].prompt, /PREVIOUS TURNS/);
});

test('pattern reflexes: stop ends the turn before the FAQ, continue prefaces the computed answer, pragmatic only tunes the voice', async t => {
  const reflexes = [
    {id: 'who', pattern: '^who are you\\??$', mode: 'stop', reply: 'I am the test model.', priority: 5},
    {id: 'hurry', pattern: '\\bquick(ly)?\\b', mode: 'continue', reply: 'Here is the short answer.'},
    {id: 'calm', pattern: 'nothing works', mode: 'pragmatic', tone: 'Be calm and brief.'},
  ];
  const {mrp, models, fake} = setup(t, {reflexes, slots: {normalize: 'passthrough', reflex: 'faq-fixed', voice: 'natural-rephrase'}, language: {output: 'en'}},
    (purpose, request) => purpose === 'voice' ? request.prompt.match(/DRAFT REPLY:\n([\s\S]*?)\n\nRESULT/)[1] : null);
  const stop = await mrp.before({modelId: 'm', text: 'Who are you?'});
  assert.equal(stop.reflex.kind, 'pattern');
  assert.equal(stop.reflex.answer, 'I am the test model.');
  assert.deepEqual(stop.trace.find(s => s.slot === 'reflex').pattern, {id: 'who', mode: 'stop'});
  assert.equal((await mrp.reflexReply({pre: stop})).english, 'I am the test model.');
  const cont = await mrp.before({modelId: 'm', text: 'Quickly: who works at Acme?'});
  assert.equal(cont.reflex, null);
  assert.equal(cont.preface, 'Here is the short answer.');
  const after = await mrp.after({pre: cont, result: {text: 'Ana works at Acme.', sop: '', packet: {}}});
  assert.equal(after.english, 'Here is the short answer.\n\nAna works at Acme.');
  const calm = await mrp.before({modelId: 'm', text: 'Nothing works, who works at Acme?'});
  assert.equal(calm.tone, 'Be calm and brief.');
  await mrp.after({pre: calm, result: {text: 'Ana works at Acme.', sop: '', packet: {}}});
  assert.match(fake.calls.at(-1).prompt, /Tone: Be calm and brief\./);
  assert.equal(models.state('m').reflex.hits, 3);
  const only = setup(t, {reflexes, slots: {normalize: 'passthrough', reflex: 'pattern-reflex'}});
  assert.equal((await only.mrp.before({modelId: 'm', text: 'When are you open?'})).reflex, null, 'pattern-reflex never consults the FAQ');
  const off = setup(t, {reflexes, slots: {normalize: 'passthrough', reflex: 'off'}});
  assert.equal((await off.mrp.before({modelId: 'm', text: 'Who are you?'})).reflex, null, 'off ignores the pattern reflexes');
});

test('pattern reflexes are checked when a model is saved', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mrp-pipe-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const models = new Models({root});
  assert.throws(() => models.create({id: 'a', reflexes: [{pattern: '(', reply: 'x'}]}), /invalid pattern/);
  assert.throws(() => models.create({id: 'b', reflexes: [{pattern: 'hi', mode: 'stop'}]}), /needs a reply/);
  assert.throws(() => models.create({id: 'c', reflexes: [{pattern: 'hi', mode: 'pragmatic'}]}), /tone line/);
  assert.throws(() => models.create({id: 'd', reflexes: [{pattern: 'hi', mode: 'shout', reply: 'x'}]}), /mode must be/);
  assert.deepEqual(models.create({id: 'e', reflexes: [{pattern: 'hi', reply: 'Hello.'}]}).reflexes, [{id: 'reflex-1', pattern: 'hi', mode: 'stop', priority: 0, reply: 'Hello.'}]);
});

test('affect lexicon: whole-word cues give a label and an intensity with no model call; the voice gets the tone', async t => {
  const {readAffect} = await import('../../lib/mrp/affect-lexicon.mjs');
  assert.deepEqual(readAffect('This is still wrong, I already asked!'), {label: 'frustrated', intensity: 0.9, cues: ['still wrong', 'i already asked']});
  assert.equal(readAffect('I need this urgently').label, 'urgent');
  assert.deepEqual(readAffect('Who works at Acme?'), {label: 'neutral', intensity: 0, cues: []});
  assert.equal(readAffect('the agains').label, 'neutral', 'cues match whole words only');
  const {mrp, fake} = setup(t, {slots: {normalize: 'passthrough', reflex: 'off', affect: 'lexicon'}, language: {output: 'en'}}, purpose => purpose === 'voice' ? 'Ana works at Acme.' : null);
  const pre = await mrp.before({modelId: 'm', text: 'Still wrong! Who works at Acme?'});
  assert.deepEqual(pre.affect, {label: 'frustrated', intensity: 0.8});
  assert.equal(fake.calls.length, 0, 'the lexicon calls no model');
  await mrp.after({pre, result: {text: 'Ana works at Acme.', sop: '', packet: {}}});
  assert.match(fake.calls.at(-1).prompt, /seems frustrated/);
});

test('affect runs before the reflex: an affect reflex reacts to the emotion; reflex wires of the base memory count like the model\'s', async t => {
  const reflexes = [{id: 'hurry', affect: 'urgent', mode: 'continue', reply: 'I see this is urgent; here is the answer.'}];
  const memoryReflexes = [{id: 'rx_who', pattern: '^who are you', mode: 'stop', reply: 'I am the memory reflex.', priority: 0, source: 'memory'}];
  const {mrp} = setup(t, {reflexes, slots: {normalize: 'passthrough', affect: 'lexicon', reflex: 'pattern-reflex'}, language: {output: 'en'}});
  const urgent = await mrp.before({modelId: 'm', text: 'I need it right now, who works at Acme?'});
  assert.deepEqual(urgent.trace.map(s => s.slot), ['normalize', 'affect', 'reflex']);
  assert.equal(urgent.preface, 'I see this is urgent; here is the answer.');
  assert.equal((await mrp.before({modelId: 'm', text: 'Who works at Acme?'})).preface, null, 'no emotion, no affect reflex');
  const who = await mrp.before({modelId: 'm', text: 'Who are you?', memoryReflexes});
  assert.equal(who.reflex.answer, 'I am the memory reflex.');
  assert.deepEqual(who.trace.find(s => s.slot === 'reflex').pattern, {id: 'rx_who', mode: 'stop', source: 'memory'});
});

test('a reflex wire is knowledge: the validator checks its trigger, pattern and reply; the lexicon reads it', async () => {
  const {validateProgram, parse} = await import('../../sop/knowledge/index.mjs');
  const {Lexicon} = await import('../../sop/lexicon.mjs');
  const {validateCircuits} = await import('../../lib/chat-data/memories.mjs');
  const ok = '@rx_hours reflex\n  pattern "opening hours"\n  mode stop\n  reply "From 9 to 17."\n  priority 2\n@rx_calm reflex\n  affect angry\n  mode pragmatic\n  tone "Stay calm."\n';
  assert.equal(validateCircuits([{name: 'r', text: ok}]).ok, true, JSON.stringify(validateCircuits([{name: 'r', text: ok}]).problems));
  const codes = text => validateCircuits([{name: 'r', text}]).problems.map(p => p.code);
  assert.ok(codes('@rx reflex\n  mode stop\n  reply "x"\n').includes('reflex_without_trigger'));
  assert.ok(codes('@rx reflex\n  pattern "("\n  reply "x"\n').includes('bad_pattern'));
  assert.ok(codes('@rx reflex\n  pattern "hi"\n').includes('reflex_without_reply'));
  const lexicon = Lexicon.fromCircuits([{name: 'r', text: ok}]);
  assert.deepEqual(lexicon.reflexes.map(r => [r.id, r.mode, r.reply ?? r.tone, r.affect]), [['rx_hours', 'stop', 'From 9 to 17.', null], ['rx_calm', 'pragmatic', 'Stay calm.', 'angry']]);
  void validateProgram; void parse;
});

test('the compiled lexicon cache keeps the schemas and the reflexes of a memory', async () => {
  const {Lexicon} = await import('../../sop/lexicon.mjs');
  const lexicon = Lexicon.fromCircuits([{name: 'm', text: '@p predicate\n  args subject:entity\n@s schema\n  name "s"\n  predicate ~p\n@rx reflex\n  pattern "hi"\n  reply "Hello."\n'}]);
  const revived = Lexicon.revive(JSON.parse(JSON.stringify(lexicon.serialize())));
  assert.deepEqual(revived.reviewedSchemaPredicates(), ['p']);
  assert.equal(revived.reflexes[0].reply, 'Hello.');
});

test('faq-llm-select: the model names the FAQ entry or none; the answer is the entry\'s', async t => {
  const {mrp, fake} = setup(t, {slots: {normalize: 'passthrough', reflex: 'faq-llm-select'}}, (purpose, request) => purpose === 'reflex' ? (/MESSAGE: til when r u open/.test(request.prompt) ? '{"faq": "hours"}' : '{"faq": null}') : null);
  const hit = await mrp.before({modelId: 'm', text: 'til when r u open'});
  assert.equal(hit.reflex.id, 'hours');
  assert.match(fake.calls[0].prompt, /- hours: What are your opening hours\? \| When are you open\?/);
  assert.equal((await mrp.before({modelId: 'm', text: 'Who works at Acme?'})).reflex, null);
});

test('faq-hybrid: no call for a clear match or a clear miss, the model chooses in between', async t => {
  const {mrp, fake} = setup(t, {slots: {normalize: 'passthrough', reflex: 'faq-hybrid'}}, (purpose, request) => purpose === 'reflex' ? (/MESSAGE: til when do you open/.test(request.prompt) ? '{"faq": "hours"}' : '{"faq": null}') : null);
  assert.equal((await mrp.before({modelId: 'm', text: 'What are your opening hours?'})).reflex.id, 'hours');
  assert.equal(fake.calls.length, 0, 'a clear lexical match costs no call');
  assert.equal((await mrp.before({modelId: 'm', text: 'Who works at Globex?'})).reflex, null);
  assert.equal(fake.calls.length, 0, 'a clear miss costs no call');
  const between = await mrp.before({modelId: 'm', text: 'til when do you open'});
  assert.equal(between.reflex.id, 'hours');
  assert.equal(between.trace.find(s => s.slot === 'reflex').band, 'model');
  assert.equal(fake.calls.length, 1);
});

test('lexicon-then-llm asks the model only without a cue; judge-on-doubt judges only doubtful circuits; natural-if-foreign skips English', async t => {
  const {mrp, fake} = setup(t, {slots: {normalize: 'passthrough', reflex: 'off', affect: 'lexicon-then-llm', roundtrip: 'judge-on-doubt', voice: 'natural-if-foreign'}, language: {output: 'en'}},
    (purpose, request) => purpose === 'affect' ? '{"label": "sad", "intensity": 0.7}' : purpose === 'roundtrip' ? (/Decide whether two English sentences/.test(request.prompt) ? '{"same": false}' : 'Who works at Globex?') : null);
  const cue = await mrp.before({modelId: 'm', text: 'This is urgent: who works at Acme?'});
  assert.equal(cue.affect.label, 'urgent');
  assert.equal(fake.calls.length, 0, 'a cue answers without a model');
  const none = await mrp.before({modelId: 'm', text: 'My dog died, who works at Acme?'});
  assert.deepEqual(none.affect, {label: 'sad', intensity: 0.7});
  assert.equal(fake.calls.length, 1);
  const calm = await mrp.after({pre: none, result: {text: 'Ana works at Acme.', sop: '@q query\n  select ?x\n  where works_at ?x acme\n', packet: {}}});
  assert.equal(calm.roundtrip, null, 'no doubt, no judge');
  assert.equal(calm.text, 'Ana works at Acme.', 'English output is the deterministic answer, with no voice call');
  const doubt = await mrp.after({pre: none, result: {text: 'Ana works at Acme.', sop: '@q query\n  select ?x\n  where works_at ?x acme\n@a assumed\n  relation "works at"\n', packet: {}}});
  assert.equal(doubt.roundtrip.agree, false);
  assert.match(doubt.english, /I understood your message as/);
});
