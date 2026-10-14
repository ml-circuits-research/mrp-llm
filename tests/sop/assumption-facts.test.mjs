// DS004 "Assumptions and defeat": a `source assumption` fact must be consumed
// by an `assume` reference, and it is never published, stored or reinforced.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Runtime} from '../../sop/runtime.mjs';
import {context, schema, queryProgram} from '../helpers.mjs';

const guess = '@g fact\n  holds likes ana lab_alpha\n  valid timeless\n  source assumption\n';
const question = '@q query\n  where likes ana lab_alpha\n';
const day0 = Date.parse('2026-01-01');
const userGuard = fact => assert.equal(fact.source, 'user', 'Conversational facts require source user');

test('remember rejects an assumption-sourced fact and stores nothing', async t => {
  const c = context({bootstrap: false});
  t.after(c.dispose);
  await assert.rejects(c.run(guess + '@a solve\n  query $q\n  assume $g\n' + question + '@s remember\n  input $g'), /assumption_fact_not_recordable/);
  await assert.rejects(c.run(guess + '@a solve\n  query $q\n  assume $p\n' + question + '@p pack\n  items $g\n@s remember\n  input $p'), /assumption_fact_not_recordable/);
  assert.equal(Object.keys(c.session.live.claims).length, 0);
});

test('solve data rejects an assumption-sourced fact instead of admitting it as observed', async () => {
  const runtime = new Runtime({schema});
  await assert.rejects(runtime.run(guess + question + '@a solve\n  query $q\n  data $g'), /assumption_fact_unconsumed/);
  await assert.rejects(runtime.run(guess + question + '@a solve\n  query $q\n  data $g\n  assume $g'), /assumption_fact_not_evidence/);
  await assert.rejects(runtime.run(guess + question + '@p pack\n  items $g\n@a solve\n  query $q\n  data $p\n  assume $p'), /assumption_fact_not_evidence/);
  await assert.rejects(runtime.run(guess + question + '@a reason\n  query $q\n  data $g\n  assume $g'), /assumption_fact_not_evidence/);
});

test('an assumption-sourced fact without an assume consumer is rejected', async () => {
  await assert.rejects(new Runtime({schema}).run(guess), /assumption_fact_unconsumed/);
});

test('an assumption consumed through assume yields a hypothetical result', async () => {
  const r = await new Runtime({schema}).run(guess + question + '@a solve\n  query $q\n  assume $g');
  assert.equal(r.result.status, 'supported');
  assert.equal(r.result.hypothetical, true);
});

test('the fact guard exempts an assumption reaching assume through a pack', async () => {
  const runtime = new Runtime({schema, factGuard: userGuard});
  const direct = await runtime.run(guess + question + '@a solve\n  query $q\n  assume $g');
  assert.equal(direct.result.hypothetical, true);
  const packed = await runtime.run(guess + '@h fact\n  holds likes ana lab_beta\n  valid timeless\n  source assumption\n@p pack\n  items $g $h\n@o pack\n  items $p\n' + question + '@a solve\n  query $q\n  assume $o');
  assert.equal(packed.result.status, 'supported');
  assert.equal(packed.result.hypothetical, true);
  await assert.rejects(runtime.run('@f fact\n  holds likes ana lab_alpha\n  valid timeless\n  source "note"\n' + question + '@a solve\n  query $q\n  data $f'), /Conversational facts require source user/);
});

test('reinforcement never promotes an assumption or anything derived from one', async t => {
  const memory = {power: 16, arity: 3, retention: {reinforceOnUse: true, writeStrength: 1, useStrength: 2}};
  const c = context({bootstrap: false, memory});
  t.after(c.dispose);
  await c.run('@f fact\n  holds likes ana lab_alpha\n  valid timeless\n  source user\n@s remember\n  input $f');
  const mixed = await c.run('@g fact\n  holds likes maria lab_alpha\n  valid timeless\n  source assumption\n@q query\n  where likes ana lab_alpha\n  where likes maria lab_alpha\n@a solve\n  query $q\n  assume $g');
  assert.equal(mixed.result.status, 'supported');
  assert.equal(mixed.result.hypothetical, true);
  assert.equal(mixed.result.reinforcement, undefined);
  // A host that bypasses the runtime can still write such a claim; its use must not promote it.
  c.repo.apply(c.session, [{kind: 'fact', atom: {p: 'likes', a: ['ana', 'lab_beta'], neg: false}, valid: {from: -Infinity, until: Infinity}, source: 'assumption', quote: '', retention: 'normal'}], {knownAt: day0});
  const read = await c.run(queryProgram('likes ana lab_beta'));
  assert.equal(read.result.status, 'supported');
  assert.equal(read.result.reinforcement, undefined);
});

test('operation operands beyond data reject an assumption-sourced fact as evidence', async () => {
  const runtime = new Runtime({schema});
  // The fact is legitimately consumed by an assume elsewhere, so only the operand use is at issue.
  const consumed = guess + question + '@a solve\n  query $q\n  assume $g\n';
  await assert.rejects(runtime.run(consumed + '@d abduce\n  observation $g'), /assumption_fact_not_evidence/);
  await assert.rejects(runtime.run(consumed + '@d diagnose\n  observation $g'), /assumption_fact_not_evidence/);
  const observed = '@o fact\n  holds likes ana lab_alpha\n  valid timeless\n  source user\n';
  const ok = await runtime.run(observed + '@d abduce\n  observation $o');
  assert.ok(ok.result.status);
});
