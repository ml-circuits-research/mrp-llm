import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const script = fileURLToPath(new URL('../../tools/eval/engines/router-timing.mjs', import.meta.url));
const cell = (shape, params, engine, extra = {}) => {
  const proc = spawnSync(process.execPath, [script, '--cell', JSON.stringify({shape, params, engine, ...extra})],
    {encoding: 'utf8', timeout: 15_000});
  assert.equal(proc.status, 0, proc.stderr);
  const result = JSON.parse(proc.stdout.trim());
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
};

test('closure superlative keeps the two tied winners after a recursive join', () => {
  const oracle = cell('closure-rank', {facts: 1_000}, 'reference');
  const sql = cell('closure-rank', {facts: 1_000}, 'sql-sqlite');
  assert.equal(oracle.correct, true);
  assert.equal(sql.correct, true);
  assert.equal(sql.reachable, 550);
  assert.equal(sql.candidates, 450);
  assert.equal(sql.complete, true);
  assert.equal(sql.answerDigest, oracle.answerDigest);
});

test('negation count distinguishes exact closed output from an open-domain lower bound', () => {
  for (const engine of ['reference', 'sql-sqlite']) {
    const closed = cell('negation-complete', {nodes: 677}, engine);
    const open = cell('negation-open-count', {nodes: 677}, engine);
    assert.equal(closed.facts, 1_000);
    assert.equal(closed.correct, true);
    assert.equal(closed.bound, null);
    assert.equal(open.correct, true);
    assert.equal(open.bound, 'at_least');
    assert.equal(open.complete, true, 'a completed lower-bound calculation is not an exact count');
    assert.notEqual(open.answerDigest, closed.answerDigest);
  }
});

test('a cut closure cannot be scored as a definite count or superlative', () => {
  for (const shape of ['closure-count', 'closure-rank']) {
    const answer = cell(shape, {facts: 1_000}, 'reference', {budget: {maxFacts: 200}});
    assert.equal(answer.status, 'budget_exhausted');
    assert.equal(answer.complete, false);
    assert.equal(answer.correct, null);
    assert.equal(answer.answerDigest, null);
  }
});

test('offline replay verifies a routed closure count separately from engine latency', () => {
  const packet = cell('closure-count', {facts: 1_000}, 'auto', {verifyOffline: true, verifyTimeoutMs: 5_000});
  assert.equal(packet.reachable, 1_000);
  assert.equal(packet.candidates, 1_000);
  assert.equal(packet.correct, true);
  assert.equal(packet.chosen, 'sql-sqlite');
  assert.equal(packet.verification, 'agreed');
  assert.equal(packet.verifiedCorrect, true);
});
