// The offline per-step formalization regression (tools/eval/formalization/regression/offline.mjs): recorded answers are replayed through
// the current protocol and code with no model; every step is checked and a failure names its first diverging step. The fixture is
// invented text; the books' recordings (local, gitignored) run as a fast tier when present.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {replayCase, runOffline, explain, loadRecordings} from '../../tools/eval/formalization/regression/offline.mjs';

const cases = JSON.parse(fs.readFileSync(new URL('../fixtures/formalization-offline/cases.json', import.meta.url), 'utf8'));
const byId = id => cases.find(c => c.id === id);

test('replayed answers solve compute, choose and deduce problems with no model', async () => {
  for (const id of ['fixture/pens', 'fixture/plans', 'fixture/glorp']) {
    const r = await replayCase(byId(id), byId(id).steps);
    assert.equal(r.outcome, 'correct', explain(r));
    assert.ok(r.trace.every(t => t.ok), explain(r));
  }
});

test('relations between things: who (select), how many (count), a rule over relations, and the closed world of a problem (not shown = no)', async () => {
  for (const id of ['fixture/works', 'fixture/count', 'fixture/grandparent', 'fixture/forced']) {
    const r = await replayCase(byId(id), byId(id).steps);
    assert.ok(['correct', 'undecided'].includes(r.outcome) && r.trace.every(t => t.ok), explain(r));
    if (id === 'fixture/works') assert.match(r.answer + (r.response ?? ''), /Mara|Lena/);
  }
  assert.equal((await replayCase(byId('fixture/grandparent'), byId('fixture/grandparent').steps)).outcome, 'correct');
  assert.equal((await replayCase(byId('fixture/count'), byId('fixture/count').steps)).outcome, 'correct');
  assert.equal((await replayCase(byId('fixture/forced'), byId('fixture/forced').steps)).outcome, 'correct');
});

test('a failure names its first diverging step: an unreadable answer (reader), a wrong formula (answer at execution)', async () => {
  const unread = await replayCase(byId('fixture/unreadable'), byId('fixture/unreadable').steps);
  assert.deepEqual([unread.first.step, unread.first.kind], ['problem_values', 'reader']);
  const wrong = await replayCase(byId('fixture/wrong-formula'), byId('fixture/wrong-formula').steps);
  assert.equal(wrong.outcome, 'wrong');
  assert.deepEqual([wrong.first.step, wrong.first.kind], ['execute', 'answer']);
  assert.match(explain(wrong), /first divergence at execute/);
  // A question the recording does not hold (a protocol change) is a protocol divergence, not a model call.
  const short = await replayCase(byId('fixture/plans'), byId('fixture/plans').steps.slice(0, 3));
  assert.deepEqual([short.first.step, short.first.kind], ['problem_options', 'protocol']);
});

test('the books recordings replay offline in seconds (fast tier; skipped without the local recordings)', {skip: loadRecordings('tiny').size === 0}, async () => {
  const out = await runOffline({tier: 'tiny', fast: 40});
  assert.ok(out.results.length > 0);
  assert.ok(out.ms < 30_000, `took ${out.ms} ms`);
});


test('the balanced argument set replays offline with no model (skipped without the local transport recordings)', {skip: !(await import('../../tools/eval/formalization/regression/argument.mjs')).argumentCases().length || !fs.existsSync((await import('../../tools/eval/formalization/regression/argument.mjs')).transportFile('tiny'))}, async () => {
  const {replayArgument} = await import('../../tools/eval/formalization/regression/argument.mjs');
  const out = await replayArgument({tier: 'tiny', write: false, log: () => {}});
  assert.equal(out.transport.misses, 0, 'every exchange is in the recording');
  assert.equal(out.gold.yes + out.gold.no, out.cases);
});
