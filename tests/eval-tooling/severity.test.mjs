// Graded severity (DS012 "Graded severity (S0-S4, NONE)"): scale helpers, mechanical layer and metrics (the SymbolicLM-era analysis mapping, SOP comparer and simplifications were archived on 2026-10-03, probably_obsolete/eval-cleanup-2026-10-03/).
import test from 'node:test';
import assert from 'node:assert/strict';
import {SEVERITIES, worst, rank, isGoodEnough} from '../../tools/eval/lib/severity/scale.mjs';
import {mechanicalSeverity} from '../../tools/eval/lib/severity/mechanical.mjs';
import {wilson, summaryMetrics, confusion, distributionStats} from '../../tools/eval/lib/severity/metrics.mjs';

test('scale order and helpers', () => {
  assert.deepEqual(SEVERITIES, ['S0', 'S1', 'S2', 'S3', 'S4', 'NONE']);
  assert.equal(worst('S1', 'S3', 'S2'), 'S3');
  assert.equal(worst('S2', 'NONE'), 'NONE');
  assert.ok(rank('S4') < rank('NONE'));
  assert.ok(isGoodEnough('S2') && !isGoodEnough('S3'));
});

test('mechanical layer: certain S4 flags and exact matches', () => {
  assert.equal(mechanicalSeverity('Did Ana go to Cluj?', 'did ana go to cluj').severity, 'S0');
  const neg = mechanicalSeverity('Ana does not work at Lidl.', 'Ana works at Lidl.');
  assert.equal(neg.severity, 'S4'); assert.ok(neg.flags.some(f => f.kind === 'negation_lost'));
  assert.equal(mechanicalSeverity('Ana lives in Cluj.', 'Ana lives in Sibiu.').severity, 'S4');
  assert.equal(mechanicalSeverity('Ana is 30 years old.', 'Ana is 31 years old.').severity, 'S4');
  assert.equal(mechanicalSeverity('Everyone got an answer.', 'Someone got an answer.').severity, 'S4');
  assert.equal(mechanicalSeverity('If Dan calls, the meeting stays.', 'Dan calls, so the meeting stays.').severity, 'S4');
  assert.equal(mechanicalSeverity('Ana says that Dan left.', 'Dan left.').severity, 'S4');
  assert.equal(mechanicalSeverity('Tomas was late because the bus broke down.', 'The bus broke down because Tomas was late.').severity, 'S4');
  assert.equal(mechanicalSeverity('The office is open.', 'The office is open. The budget was cut by 20 percent.').severity, 'S4');
  assert.equal(mechanicalSeverity('', 'x').decided, false);
  assert.equal(mechanicalSeverity('Hello there', '').severity, 'NONE');
  // a harmless rewrite is not decided as S4
  assert.equal(mechanicalSeverity('i woder if Priya works at Vertex Analytics .', 'I wonder if Priya works at Vertex Analytics.').decided, false);
  assert.equal(mechanicalSeverity('Verify the claim that Radu teaches chemistry.', 'Check whether Radu teaches chemistry.').decided, false);
});

test('metrics: Wilson, S4 recall and false-S4 rate, distribution shares', () => {
  const w = wilson(50, 100); assert.ok(w.lo < 0.5 && w.hi > 0.5);
  const pairs = [{gold: 'S4', pred: 'S4'}, {gold: 'S4', pred: 'S2'}, {gold: 'S3', pred: 'S4'}, {gold: 'S0', pred: 'S0'}];
  const m = summaryMetrics(pairs);
  assert.equal(m.s4_recall.rate, 0.5); assert.equal(m.false_s4.k, 1); assert.equal(m.s4_missed_as_good.k, 1);
  assert.equal(confusion(pairs).S4.S2, 1);
  const d = distributionStats(['S0', 'S1', 'S4', 'NONE']);
  assert.equal(d.good_enough.k, 2); assert.equal(d.catastrophic.k, 1); assert.equal(d.none.k, 1);
});
