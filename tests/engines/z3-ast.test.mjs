// The typed integer constraint of the runtime in Z3 (reasoning/strategies/z3-smt-bounded/ast.mjs): domains may be unbounded.
import test from 'node:test';
import assert from 'node:assert/strict';
import {z3Decide, z3Optimize, compile} from '../../reasoning/strategies/z3-smt-bounded/ast.mjs';
import {enumerateConstraint, optimizeConstraint, validateConstraint, assignmentsOf} from '../../reasoning/strategies/js-reference/constraint-ast.mjs';
import {solverSkip} from '../helpers.mjs';

const cmp = (op, a, b) => ({op, a: [a, b]});
const z3 = solverSkip('z3');

test('the SMT script of a typed problem declares every variable, its bounds and the requirements', () => {
  const {decl, term} = compile({vars: {x: {sort: 'Int', min: -2, max: 3}, y: {sort: 'Int'}}, constraints: [], task: 'possible'});
  assert.deepEqual(decl, ['(declare-const x Int)', '(assert (>= x (- 2)))', '(assert (<= x 3))', '(declare-const y Int)']);
  assert.equal(term(cmp('ne', 'x', 'y')), '(distinct x y)');
  assert.equal(term({op: 'and', a: [cmp('lt', 'x', 1), {op: 'not', a: [cmp('eq', 'y', 0)]}]}), '(and (< x 1) (not (= y 0)))');
});

test('validation refuses what the typed profile does not allow', () => {
  const bad = c => () => validateConstraint({vars: {x: {sort: 'Int'}}, constraints: [c], task: 'possible'});
  assert.throws(bad(cmp('eq', 'x', 'y')), /Undeclared variable/);
  assert.throws(bad(cmp('eq', cmp('mul', 'x', 'x'), 1)), /multiplication by an integer constant/);
  assert.throws(bad({op: 'shell', a: []}), /Unsupported operator/);
  assert.equal(assignmentsOf({vars: {x: {sort: 'Int', min: 0, max: 9}, y: {sort: 'Int', min: 1, max: 3}}}), 30);
  assert.equal(assignmentsOf({vars: {x: {sort: 'Int'}}}), Infinity);
});

test('the finite profile enumerates; a variable without a domain is refused, never guessed', () => {
  const p = {vars: {x: {sort: 'Int', min: 0, max: 4}}, constraints: [cmp('ge', 'x', 2)], claim: cmp('ge', 'x', 2), task: 'prove'};
  assert.equal(enumerateConstraint(p).status, 'entailed');
  assert.equal(enumerateConstraint({...p, claim: cmp('ge', 'x', 3)}).status, 'unknown');
  assert.equal(enumerateConstraint({...p, claim: cmp('lt', 'x', 2)}).status, 'refuted');
  assert.equal(enumerateConstraint({...p, constraints: [cmp('gt', 'x', 9)]}).status, 'inconsistent');
  assert.equal(enumerateConstraint(p, {maxAssignments: 2}).complete, false);
  assert.throws(() => enumerateConstraint({...p, vars: {x: {sort: 'Int'}}}), /finite integer domains/);
  const o = optimizeConstraint({vars: {x: {sort: 'Int', min: 0, max: 4}}, constraints: [cmp('ge', 'x', 2)], claim: cmp('ge', 'x', 0), objective: 'x', direction: 'min', task: 'optimize'}, {project: [{name: 'x', mode: 'one'}]});
  assert.equal(o.status, 'optimal');
  assert.equal(o.objective, 2);
  assert.deepEqual(o.outputProjection['?x'], {status: 'bound', value: 2});
  assert.equal(optimizeConstraint({vars: {x: {sort: 'Int'}}, constraints: [], claim: cmp('ge', 'x', 0), objective: 'x', direction: 'min', task: 'optimize'}).status, 'unsupported');
});

test('Z3 decides unbounded integer problems: entailment, refutation, possibility and the output port', {skip: z3}, () => {
  const p = {vars: {x: {sort: 'Int'}}, constraints: [cmp('gt', 'x', 5)], claim: cmp('gt', 'x', 3), task: 'prove'};
  assert.equal(z3Decide(p).status, 'entailed');
  assert.equal(z3Decide({...p, claim: cmp('lt', 'x', 3)}).status, 'refuted');
  assert.equal(z3Decide({...p, claim: cmp('gt', 'x', 9)}).status, 'unknown');
  assert.equal(z3Decide({...p, claim: cmp('gt', 'x', 9), task: 'possible'}).status, 'possible');
  assert.equal(z3Decide({...p, constraints: [cmp('gt', 'x', 5), cmp('lt', 'x', 2)]}).status, 'inconsistent');
  const fixed = {vars: {x: {sort: 'Int'}}, constraints: [cmp('eq', 'x', 7)], claim: cmp('ge', 'x', 0), task: 'prove'};
  assert.deepEqual(z3Decide(fixed, {project: [{name: 'x', mode: 'one'}]}).outputProjection['?x'], {status: 'bound', value: 7});
  assert.equal(z3Decide(p, {project: [{name: 'x', mode: 'one'}]}).outputProjection['?x'].status, 'ambiguous');
  assert.equal(z3Decide(p, {project: [{name: 'x', mode: 'many'}]}).outputProjection['?x'].status, 'unsupported_projection');
  const groups = {vars: {x: {sort: 'Int', min: 0, max: 3}}, constraints: [{op: 'or', a: [cmp('eq', 'x', 1), {op: 'and', a: [cmp('gt', 'x', 2), {op: 'not', a: [cmp('eq', 'x', 3)]}]}]}], claim: cmp('eq', 'x', 1), task: 'prove'};
  assert.equal(z3Decide(groups).status, 'entailed');
});

test('Z3 optimizes with an independent optimality check; an unbounded objective is never called optimal', {skip: z3}, () => {
  const p = {vars: {x: {sort: 'Int'}, y: {sort: 'Int'}}, constraints: [cmp('ge', cmp('add', 'x', 'y'), 5), cmp('ge', 'x', 0), cmp('ge', 'y', 0)], claim: cmp('ge', 'x', 0), objective: cmp('add', cmp('mul', 'x', 2), 'y'), direction: 'min', task: 'optimize'};
  const r = z3Optimize(p, {project: [{name: 'x', mode: 'one'}, {name: 'y', mode: 'one'}]});
  assert.equal(r.status, 'optimal');
  assert.equal(r.objective, 5);
  assert.equal(r.optimalityCheck, 'impossible');
  assert.deepEqual([r.outputProjection['?x'], r.outputProjection['?y']], [{status: 'bound', value: 0}, {status: 'bound', value: 5}]);
  const open = z3Optimize({...p, direction: 'max'});
  assert.notEqual(open.status, 'optimal');
  assert.equal(open.complete, false);
  assert.equal(z3Optimize({...p, constraints: [cmp('lt', 'x', 0), cmp('ge', 'x', 0)]}).status, 'inconsistent');
});
