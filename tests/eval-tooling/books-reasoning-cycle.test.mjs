// The reasoning cycle of the books operating loop (TODO.md section 0): the compute words minimum_with and maximum_with (DS004
// "Exact arithmetic"), the gold classification of the books (tools/eval/books/extract.mjs), the yes/no score with extra gold numbers
// (tools/eval/books/score.mjs) and the deterministic layer of the triage (tools/eval/books/triage.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import {Agent} from '../../server/agent.mjs';
import {Lexicon} from '../../sop/lexicon.mjs';
import {compute} from '../../reasoning/strategies/js-reference/values.mjs';
import {exactCompute} from '../../reasoning/strategies/solver-common/exact-rational.mjs';
import {lowerLeaf} from '../../reasoning/strategies/asp-clingo/lower.mjs';
import {NotExpressibleError} from '../../reasoning/strategies/js-reference/index.mjs';
import {classifyAnswer} from '../../tools/eval/books/extract.mjs';
import {deterministic, responseOf} from '../../tools/eval/books/score.mjs';
import {deterministicLayer} from '../../tools/eval/books/triage.mjs';
import {context} from '../helpers.mjs';

const stated = (id, relation, value) => `@${id} stated\n  certainty asserted\n  relation "${relation}"\n  role object ${value}\n  polarity affirmed\n`;

test('minimum_with and maximum_with: the smaller or larger of two numbers, exact on decimals, in the oracle and the exact-rational engines; integer engines decline', () => {
  assert.equal(compute('minimum_with', 3, 2.5), 2.5);
  assert.equal(compute('maximum_with', -4, 0), 0);
  assert.equal(compute('maximum_with', 0.1, 0.1), 0.1);
  assert.equal(exactCompute('minimum_with', 130.5, 130), 130);
  assert.equal(exactCompute('maximum_with', 12.5, 17), 17);
  assert.throws(() => lowerLeaf({kind: 'compute', word: 'minimum_with', out: '?m', left: 3, right: 2}), NotExpressibleError);
});

test('a problem circuit with a chained bottleneck and a floor at zero: the session rule computes with minimum_with and maximum_with', async t => {
  const c = context({bootstrap: false});
  t.after(c.dispose);
  const agent = new Agent({repo: c.repo, session: c.session, lexicon: new Lexicon(''), config: {}});
  const sop = ['a', 'b', 'c', 'throughput', 'shortfall'].map(p => `@${p} predicate\n  args object:value\n`).join('')
    + stated('s1', 'a', 170) + stated('s2', 'b', 140) + stated('s3', 'c', 100)
    + '@r1 rule\n  when a ?a\n  when b ?b\n  when c ?c\n  when compute ?m ?a minimum_with ?b\n  when compute ?t ?m minimum_with ?c\n  then throughput ?t\n'
    + '@r2 rule\n  when b ?b\n  when c ?c\n  when compute ?g ?c minus ?b\n  when compute ?s ?g maximum_with 0\n  then shortfall ?s\n'
    + '@q query\n  select ?x\n  where match\n    relation "throughput"\n    role object ?x\n    polarity affirmed\n  end\n'
    + '@q2 query\n  select ?y\n  where match\n    relation "shortfall"\n    role object ?y\n    polarity affirmed\n  end\n';
  const r = await agent.turn('Stages A=170, B=140 and C=100 run in series. What is the throughput, and how much more capacity does C need to reach B, never less than 0?', {language: 'en', formalizer: {formalize: async () => sop}});
  assert.match(r.text, /\b100\b/);
  assert.equal(r.packet.status, 'supported', r.text);
});

test('book golds: Da/Nu of an untranslated book are yes/no; a yes/no gold keeps the numbers the question does not contain', () => {
  assert.deepEqual(classifyAnswer('Da.'), {kind: 'yes_no', value: true});
  assert.deepEqual(classifyAnswer('Nu.'), {kind: 'yes_no', value: false});
  assert.deepEqual(classifyAnswer('Yes, overlap 28 years.', 'From 1900 to 1950 and from 1922 to 1970. Did they overlap? For how many years?'), {kind: 'yes_no', value: true, numbers: [28]});
  assert.deepEqual(classifyAnswer('Yes, 1160 rounds to 1200.', 'Check whether 1160 rounds to 1200.'), {kind: 'yes_no', value: true});
});

test('yes/no score: the right polarity with the extra gold numbers is correct; without them only the judge decides; the wrong polarity is wrong', () => {
  const rec = (text, status) => ({arm: 'steps', ok: true, text, gold_kind: 'yes_no', gold_value: true, gold_numbers: [28], system: {status, answers: []}});
  const verdict = r => deterministic(r, responseOf(r));
  assert.equal(verdict(rec('Yes. The overlap is 28 years.', 'supported')).outcome, 'correct');
  assert.equal(verdict(rec('Yes.', 'supported')), null);
  assert.equal(verdict(rec('No.', 'refuted')).outcome, 'wrong');
});

test('triage: rule-decided layers for a turn error, a question asked back, a circuit without the problem data, a foreign gold; the rest goes to the judge', () => {
  const base = {ok: true, gold: '42', verdict: {outcome: 'wrong'}, system: {status: 'supported', formalization: {sop: '@s1 stated\n  relation "x"\n'}}};
  assert.equal(deterministicLayer(base), null);
  assert.equal(deterministicLayer({...base, ok: false, verdict: {outcome: 'invalid'}, error: {code: 'parse_failed', message: 'x'}}).layer, 'formalization');
  assert.equal(deterministicLayer({...base, ok: false, verdict: {outcome: 'invalid'}, system: {error: {code: 'parse_unavailable', message: 'the proxy is not reachable'}}}).layer, 'infrastructure');
  assert.equal(deterministicLayer({...base, system: {status: 'unclear'}}).layer, 'formalization');
  assert.equal(deterministicLayer({...base, system: {status: 'supported', formalization: {sop: '@q query\n'}}}).sub, 'answered from memory');
  assert.equal(deterministicLayer({...base, gold: 'Da.'}).layer, 'gold');
});

test('gold circuits of the ceiling arm: stored per problem with verdict and provenance; a correct circuit is not replaced by a wrong different one', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const {storeRun, readGold} = await import('../../tools/eval/books/gold-circuits.mjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-')), run = path.join(tmp, 'run-a'), dir = path.join(tmp, 'gold');
  fs.mkdirSync(run);
  const row = (circuit, outcome) => JSON.stringify({arm: 'ceiling', id: 'math:1.2', book: 'math', question: 'Q', gold: '3', author_tier: 'good', circuit, text: 'Answer: 3.', system: {status: 'supported'}, verdict: {outcome}});
  fs.writeFileSync(path.join(run, 'scored.jsonl'), row('@q query\n', 'correct') + '\n');
  assert.deepEqual(storeRun(run, {dir}), {written: 1, kept: 0, skipped: 0});
  fs.writeFileSync(path.join(run, 'scored.jsonl'), row('@other query\n', 'wrong') + '\n');
  assert.deepEqual(storeRun(run, {dir}), {written: 0, kept: 1, skipped: 0});
  const g = readGold('math:1.2', {dir});
  assert.equal(g.correct, true);
  assert.equal(g.circuit, '@q query\n');
  assert.equal(g.provenance.author_tier, 'good');
  fs.rmSync(tmp, {recursive: true, force: true});
});
