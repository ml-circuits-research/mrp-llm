import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {qualify} from '../../tools/qualify-solvers.mjs';
import {solverSkip, tempDir} from '../helpers.mjs';

const row = (rows, id) => {
  const found = rows.find(x => x.cell === id);
  assert.ok(found, `Missing qualification cell ${id}`);
  return found;
};

// The qualification run is shared by every test below; it runs inside the
// first test that needs it so an import never executes solvers.
let report;
function qualification(t) {
  if (!report) {
    const out = path.join(tempDir(t, 'solver-qualification-'), 'qualification.json');
    qualify({out});
    report = JSON.parse(fs.readFileSync(out, 'utf8'));
  }
  return report;
}

test('reference oracle distinguishes recursive evidence, variable outputs, conflict, time, and incomplete closure', t => {
  const {reference} = qualification(t);
  const recursion = row(reference, 'recursion');
  assert.equal(recursion.result.status, 'supported');
  assert.equal(recursion.result.backend, 'js');
  assert.equal(recursion.result.complete, true);
  assert.ok(recursion.result.proofIds.includes('p1'));
  assert.ok(recursion.result.proofIds.includes('p2'));
  assert.deepEqual(row(reference, 'variables-output').result.answers.map(a => a['?who']).sort(), ['bogdan', 'carina']);
  assert.equal(row(reference, 'explicit-negation').result.status, 'refuted');
  assert.equal(row(reference, 'contradiction').result.status, 'both');
  assert.equal(row(reference, 'time-in-range').result.status, 'supported');
  assert.equal(row(reference, 'time-out-of-range').result.status, 'unknown');
  assert.equal(row(reference, 'hypothesis').result.hypothetical, true);
  assert.deepEqual(row(reference, 'defeated-hypothesis').result.defeatedAssumptions, ['h1']);
  assert.equal(row(reference, 'fact-limit').result.complete, false);
  assert.equal(row(reference, 'fact-limit').result.status, 'unknown');
});

test('an unavailable solver is recorded as skipped for every cell, never as a result', t => {
  const current = qualification(t);
  for (const [binary, cells] of [['swi', current.swi], ['z3', current.z3]]) {
    if (current.binaries[binary].available) continue;
    assert.ok(cells.length > 0, binary);
    for (const cell of cells) {
      assert.equal(cell.status, 'skipped', `${binary}:${cell.cell}`);
      assert.equal(cell.result, undefined, `${binary}:${cell.cell}`);
    }
  }
});

test('prolog-tabling answers the relational core while the oracle constructs the proof', {skip: solverSkip('prolog')}, t => {
  const current = qualification(t);
  assert.equal(current.binaries.swi.available, true, 'the probed SWI binary must be the one qualification uses');
  for (const cell of current.swi) {
    assert.equal(cell.result.backend, 'prolog');
    assert.equal(cell.result.proofBackend, 'js-reference-derivation-checked-against-prolog-tabling');
    assert.ok(cell.costMs.oracle >= 0);
    assert.ok(cell.costMs.composedAdapter >= 0);
    if (cell.result.complete) assert.equal(cell.result.backendAgreement, true);
    assert.equal(cell.result.status, row(current.reference, cell.cell).result.status);
  }
  assert.deepEqual(row(current.swi, 'variables-output').result.answers.map(a => a['?who']).sort(), ['bogdan', 'carina']);
  assert.equal(row(current.swi, 'hypothesis').result.hypothetical, true);
  assert.equal(row(current.swi, 'defeated-hypothesis').result.hypothetical, false);
  assert.equal(row(current.swi, 'fact-limit').result.complete, false);
});

test('the JS reference keeps satisfiability, entailment and optimum ambiguity distinct', t => {
  const {reference} = qualification(t);
  assert.equal(row(reference, 'sat-not-entailment').result.status, 'possible');
  assert.equal(row(reference, 'same-claim-not-entailed').result.status, 'unknown');
  assert.equal(row(reference, 'non-unique-optimum').result.outputProjection['?x'].status, 'ambiguous');
});

test('Z3 keeps satisfiability, entailment, optimality, unsat and resource limits distinct', {skip: solverSkip('z3')}, t => {
  const current = qualification(t);
  assert.equal(current.binaries.z3.available, true, 'the probed Z3 binary must be the one qualification uses');
  assert.equal(row(current.z3, 'sat-not-entailment').result.checks.withNegatedClaim, 'sat');
  assert.equal(row(current.z3, 'same-claim-not-entailed').result.status, 'unknown');
  assert.equal(row(current.z3, 'entailed').result.checks.withNegatedClaim, 'unsat');
  assert.equal(row(current.z3, 'unsat-base').result.status, 'inconsistent');
  const optimum = row(current.z3, 'non-unique-optimum');
  assert.equal(optimum.result.status, 'optimal');
  assert.equal(optimum.result.optimalityCheck, 'impossible');
  assert.equal(optimum.result.outputProjection['?x'].status, 'ambiguous');
  const timeout = row(current.z3, 'timeout-1ms');
  assert.equal(timeout.result.backend, 'z3');
  assert.equal(timeout.timeoutMs, 1);
  if (!timeout.result.complete) assert.equal(timeout.interpretation, 'undecided-within-bound');
});

test('an explicit backend runs its own strategy and an unavailable one is unsupported, never substituted', t => {
  const current = qualification(t);
  assert.equal(row(current.routing, 'reference-constraint').result.route.backend, 'js');
  if (current.binaries.z3.available) assert.equal(row(current.routing, 'z3-strategy-constraint').result.route.backend, 'z3');
  if (current.binaries.swi.available) assert.equal(row(current.routing, 'prolog-strategy-horn').result.route.backend, 'prolog');
  assert.equal(row(current.routing, 'reference-horn').result.route.backend, 'js');
  const unavailable = row(current.routing, 'z3-strategy-unavailable').result;
  assert.equal(unavailable.status, 'unsupported');
  assert.equal(unavailable.route.backend, 'z3');
  assert.equal(unavailable.route.fallback, null);
  const missing = row(current.routing, 'explicit-z3-unavailable').result;
  assert.equal(missing.status, 'unsupported');
  assert.equal(missing.backend, 'z3');
  assert.ok(current.unsupported.some(x => x.cell === 'cross-family-global-score'));
});
