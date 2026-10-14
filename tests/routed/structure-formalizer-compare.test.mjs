import test from 'node:test';
import assert from 'node:assert/strict';
import {modelOf, relativeError, partialCredit} from '../../tools/eval/routed/structure/compare.mjs';

test('compare: the model of an arm is its tier without the role prefix', () => {
  assert.equal(modelOf('psm:structure-tiny'), 'tiny');
  assert.equal(modelOf('lfm:formalizer-moe-qwen'), 'moe-qwen');
  assert.equal(modelOf('expr:tiny-think-1.7b:think'), 'think-1.7b');
  assert.equal(modelOf('expr:tiny'), 'tiny');
  assert.equal(modelOf('expr:good:reason'), 'good');
  assert.equal(modelOf('combo:structure-tiny+formalizer-tiny'), null);
});

test('compare: relative error of the closest numeric answer; partial credit of a near miss', () => {
  assert.equal(relativeError([9, 'x'], {kind: 'number', values: [10, 100]}), 0.1);
  assert.equal(relativeError([true], {kind: 'yes_no', values: [true]}), null);
  assert.equal(relativeError([], {kind: 'number', values: [3]}), null);
  const p = partialCredit({gold: {kind: 'number', values: [20]},
    structure: {score: {usedCovered: 2, usedInSolution: 4, goalFound: true}},
    logic: {units: [{converted: true}, {converted: false}], queries: 1, circuits: 1, executed: 1, verdict: 'wrong', answers: [{value: 25}]},
    pathB: {status: 'ok', executed: true, verdict: 'wrong', got: [19]}});
  assert.deepEqual(p, {numbers_found: 0.5, goal: true, query: true, sentences_converted: 0.5, logic_compiled: true, logic_executed: true, logic_verdict: 'wrong', logic_rel_err: 0.25, b_accepted: true, b_executed: true, b_verdict: 'wrong', b_rel_err: 0.05});
});
