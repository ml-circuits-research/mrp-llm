import test from 'node:test';
import assert from 'node:assert/strict';
import {parse} from '../../sop/parser.mjs';
import {lowerConstraint} from '../../sop/lower.mjs';
import {solveConstraint} from '../../reasoning/bridge/solve.mjs';
import {solverSkip, withEnv} from '../helpers.mjs';

const prob = s => lowerConstraint(parse('@c constraint\n' + s).wires[0]);
const z3 = solverSkip('z3');
const cases = [
  ['possible', '  var ?x int 0 10\n  require ?x >= 5\n  claim ?x <= 5\n  task possible', 'possible'],
  ['not entailed', '  var ?x int 0 10\n  require ?x >= 5\n  claim ?x <= 5\n  task prove', 'unknown'],
  ['entailed', '  var ?x int 0 10\n  require ?x >= 5\n  claim ?x >= 4', 'entailed'],
  ['refuted', '  var ?x int 0 10\n  require ?x >= 5\n  claim ?x < 4', 'refuted'],
  ['inconsistent', '  var ?x int 0 10\n  require ?x > 9\n  require ?x < 1\n  claim ?x == 0', 'inconsistent'],
  ['constant arithmetic', '  claim 770 + 70 <= 840\n  task possible', 'possible'],
];
for (const [name, source, status] of cases) {
  test('JS ' + name, () => assert.equal(solveConstraint(prob(source), {backend: 'js'}).status, status));
  test('Z3 ' + name, {skip: z3}, () => {
    const result = solveConstraint(prob(source), {backend: 'z3'});
    assert.equal(result.backend, 'z3');
    assert.equal(result.status, status);
  });
}

test('budget exhaustion is not refutation', () => {
  const result = solveConstraint(prob('  var ?x int 0 1000\n  claim ?x > 500'), {backend: 'js', maxAssignments: 10});
  assert.equal(result.status, 'unknown');
});

test('missing Z3 is explicit, never an invented result', () => withEnv('Z3_BIN', '/does/not/exist', () => {
  const result = solveConstraint(prob('  claim 2 < 3'), {backend: 'z3'});
  assert.equal(result.status, 'unsupported');
  assert.equal(result.backend, 'z3');
}));

test('unbounded JS problem fails clearly', () => {
  assert.throws(() => solveConstraint(prob('  var ?x int\n  claim ?x > 1'), {backend: 'js'}), /JS constraints require finite integer domains/);
});
