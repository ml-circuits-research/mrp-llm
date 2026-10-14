// The TaskLambdas of the offline formalization regression (jobs/lambdas/regression.mjs) and their libraries
// (tools/eval/formalization/regression/{record,grow,argument}.mjs): recordings keyed by tier and model, a failed live call replayed as
// a failure, the recording run with an injected regression runner and a fake Ploinky client (budget and spend), the stratified
// reference sample, the growth exclusions, the recording transport of the argument set and its Yes/No scoring. No model and no server:
// every Ploinky exchange is a fake transport or an injected client. Invented text only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-plugins-'));
process.env.FR_STATE_DIR = path.join(tmp, 'state');
process.env.FR_RECORDINGS_DIR = path.join(tmp, 'steps');
test.after(() => fs.rmSync(tmp, {recursive: true, force: true}));

const offline = await import('../../tools/eval/formalization/regression/offline.mjs');
const record = await import('../../tools/eval/formalization/regression/record.mjs');
const grow = await import('../../tools/eval/formalization/regression/grow.mjs');
const argument = await import('../../tools/eval/formalization/regression/argument.mjs');
const cases = JSON.parse(fs.readFileSync(new URL('../fixtures/formalization-offline/cases.json', import.meta.url), 'utf8'));
const pens = cases.find(c => c.id === 'fixture/pens');

/** A regression run's results as run.mjs writes them: one problem-mode dialog, one turn outside problem mode, one infrastructure failure. */
function writeRun(run, {failed = false} = {}) {
  const dir = path.join(process.env.FR_STATE_DIR, run);
  fs.mkdirSync(dir, {recursive: true});
  const dialog = [{name: 'kind', answer: 'problem'}, ...pens.steps.map((s, i) => ({...s, qsha: `q${i}`, ...(failed && s.name === 'problem_formulas' ? {answer: '', failed: true, finish: 'length'} : {})}))];
  const rows = [
    {id: 'fixture/pens', ok: true, outcome: 'correct', cluster: null, report: {form: 'problem'}, dialog},
    {id: 'fixture/hello', ok: true, outcome: 'correct', report: {form: 'courtesy'}, dialog: [{name: 'kind', answer: 'greeting'}]},
    {id: 'fixture/down', ok: false, outcome: 'failed', dialog: []},
  ];
  fs.writeFileSync(path.join(dir, 'results.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return {score: {run, correct: 2, failed: 1, replay: {mode: 'fill'}}};
}

test('recordings are keyed by tier and model; a legacy file stays replayable; a turn outside problem mode is kept without steps', () => {
  writeRun('r1');
  const out = offline.importRun('r1', 'tiny', {model: 'tier:tiny=local/Model-A#gguf:1:2'});
  assert.deepEqual([out.recorded, out.not_problem], [2, 1]);
  assert.equal(path.basename(out.file), 'tiny@local-model-a.jsonl');
  offline.importRun('r1', 'tiny', {legacy: true});
  assert.equal(offline.loadRecordings('tiny', {model: 'legacy'}).size, 1, 'the legacy import keeps problem-mode turns only, as before');
  const a = offline.loadRecordings('tiny', {model: 'local-model-a'});
  assert.equal(a.get('fixture/pens').model, 'tier:tiny=local/Model-A#gguf:1:2');
  assert.deepEqual(a.get('fixture/hello').steps, []);
  assert.equal(a.get('fixture/hello').live.form, 'courtesy');
  assert.equal(offline.modelSlug('tier:small=openference/Qwen3.8 27b'), 'openference-qwen3.8-27b');
  assert.equal(offline.recordingSource('tiny', 'legacy').model, 'legacy');
});

test('a live call that gave no answer replays as that failure, not as a readable empty answer', async () => {
  const steps = pens.steps.map(s => (s.name === 'problem_formulas' ? {...s, answer: '', failed: true, finish: 'length'} : s));
  const r = await offline.replayCase(pens, steps);
  assert.equal(r.outcome, 'failed_step');
  assert.deepEqual([r.first.step, r.first.kind], ['problem_formulas', 'no_answer']);
  assert.match(r.first.why, /no answer \(finish length\)/);
  assert.equal((await offline.replayCase(pens, pens.steps)).outcome, 'correct');
});

test('the reference sample is stratified and the same for the same seed', () => {
  const ids = [...Array.from({length: 30}, (_, i) => `books/a:${i}`), ...Array.from({length: 6}, (_, i) => `books/b:${i}`), 'capabilities/x', 'capabilities/y'];
  const strata = id => id.split(/[/:]/)[1] === 'a' ? 'a' : id.split(/[/:]/)[1] === 'b' ? 'b' : 'chat';
  const s1 = record.stratifiedSample(ids, 9, {seed: 's', strata}), s2 = record.stratifiedSample(ids, 9, {seed: 's', strata});
  assert.deepEqual(s1, s2);
  assert.equal(new Set(s1).size, 9);
  for (const k of ['a', 'b', 'chat']) assert.ok(s1.filter(id => strata(id) === k).length >= 2, `stratum ${k} under-sampled: ${s1}`);
});

test('growth never admits a held-out unit, a gold defect, a fol-v3 development problem, a case already in the set or a seen item', () => {
  const ex = {held: new Set(['logic/2.1 Cards']), unitOf: i => `${i.book}/${i.section}`, dev: new Set(['logic:9']), defects: new Set(['logic:8']), seen: new Set(['logic:7']), caseIds: new Set(['logic:6']), hashes: new Set()};
  const item = (id, extra = {}) => ({id, book: 'logic', section: '3.1 Cases', question: `Is ${id} fine?`, answer: 'No.', answer_kind: 'yes_no', answer_value: false, ...extra});
  assert.equal(grow.refusal(item('logic:1', {section: '2.1 Cards'}), ex), 'held-out unit');
  assert.equal(grow.refusal(item('logic:8'), ex), 'gold defect');
  assert.equal(grow.refusal(item('logic:9'), ex), 'fol-v3 development');
  assert.equal(grow.refusal(item('logic:6'), ex), 'already a case');
  assert.equal(grow.refusal(item('logic:7'), ex), 'seen by an evaluation');
  assert.equal(grow.refusal(item('logic:7'), ex, {seenToo: false}), null);
  assert.equal(grow.refusal(item('logic:5', {dup_of: 'logic:4'}), ex), 'duplicate item');
  const c = grow.caseOf(item('logic:5'), {seed: 's', slice: 'argument', stratum: 'logic/3'});
  assert.deepEqual([c.id, c.slice, c.gold_kind, c.runnable, 'message' in c, 'question' in c], ['books/logic:5', 'argument', 'yes_no', true, false, false]);
});

test('the argument transport records model exchanges once and replays them with no server; a miss is a replay_miss', async () => {
  const file = path.join(tmp, 'transport.jsonl');
  let served = 0;
  const inner = async (url, init) => { served++; return new Response(JSON.stringify({choices: [{message: {content: `answer to ${JSON.parse(init.body).q}`}}]}), {status: 200, headers: {'content-type': 'application/json', 'x-pworker-model': 'local/M'}}); };
  const rec = argument.recordingTransport({file, mode: 'record', inner});
  const body = JSON.stringify({q: 1});
  assert.match(await (await rec('http://127.0.0.1:1/v1/chat/completions', {method: 'POST', body})).text(), /answer to 1/);
  await rec('http://127.0.0.1:1/v1/chat/completions', {method: 'POST', body});
  assert.equal(served, 1, 'the second identical exchange is answered from the recording');
  const rep = argument.recordingTransport({file, mode: 'replay'});
  const r = await rep('http://elsewhere:9/v1/chat/completions', {method: 'POST', body});
  assert.equal(r.headers.get('x-pworker-model'), 'local/M');
  assert.match(await r.text(), /answer to 1/);
  assert.equal((await rep('http://elsewhere:9/v1/fol', {method: 'POST', body: '{"q":2}'})).status, 409);
  assert.equal((await rep('http://elsewhere:9/health')).status, 200);
  assert.deepEqual(rep.stats, {hits: 1, recorded: 0, misses: 1});
});

test('the argument score keeps Yes and No apart, with the constant majority answer and the balanced accuracy', () => {
  const row = (gold, formal, direct) => ({gold, formal: {verdict: formal}, direct: {verdict: direct}});
  const s = argument.scoreRows([row(true, 'correct', 'wrong'), row(true, 'wrong', 'wrong'), row(false, 'correct', 'correct'), row(false, 'correct', 'correct'), row(false, 'no_answer', 'correct')]);
  assert.deepEqual(s.gold, {yes: 2, no: 3});
  assert.deepEqual([s.formal.yes.correct, s.formal.no.correct, s.formal.balanced_accuracy], [1, 2, 0.583]);
  assert.deepEqual([s.direct.yes.correct, s.direct.no.correct, s.direct.balanced_accuracy], [0, 3, 0.5]);
  assert.deepEqual([s.majority.answer, s.majority.correct, s.majority.balanced_accuracy], ['No', 3, 0.5]);
  assert.equal(argument.directPolarity('No, it does not follow.'), false);
  assert.equal(argument.directPolarity('Yes'), true);
  assert.equal(argument.directPolarity('It depends'), null);
});
