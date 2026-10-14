import test from 'node:test';
import assert from 'node:assert/strict';
import {Runtime} from '../../sop/runtime.mjs';
import {solverSkip} from '../helpers.mjs';

const optimization = `@c constraint
  var ?x int 0 10
  var ?y int 0 10
  require ?x + ?y >= 5
  claim ?x >= 0
  objective 2 * ?x + ?y
  direction min
  task optimize
@r solve
  constraint $c
  backend z3
  output ?x one
  output ?y one`;

const horn = `@f fact
  holds p a
  valid timeless
@r rule
  when p ?x
  then q ?x
@data pack
  items $f $r
@q query
  where q a
  at 2026-09-26
@answer reason
  query $q
  data $data
  backend prolog`;

test('v3 external: actual Z3 optimization plus optimality check', {skip: solverSkip('z3')}, async () => {
  const r = await new Runtime().run(optimization);
  assert.equal(r.result.backend, 'z3');
  assert.equal(r.result.status, 'optimal');
  assert.equal(r.result.objective, 5);
  assert.equal(r.values.x, 0);
  assert.equal(r.values.y, 5);
});

test('v3 external: actual Prolog through the prolog-tabling strategy (the backend line selects it)', {skip: solverSkip('prolog')}, async () => {
  const r = await new Runtime().run(horn);
  assert.equal(r.result.status, 'supported');
  assert.equal(r.result.backend, 'prolog');
  assert.equal(r.result.route.fallback, null);
});
