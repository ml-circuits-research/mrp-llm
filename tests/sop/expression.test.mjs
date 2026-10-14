import test from 'node:test';
import assert from 'node:assert/strict';
import {runExpression} from '../../sop/expression.mjs';

const accepted = [
  ['arithmetic', '2 + 3 * 4', 14],
  ['string', '$s.trim().toLowerCase()', 'ana'],
  ['slice', '[1, 2, 3].slice(1).join(";")', '2;3'],
  ['conditional', 'false ? 1 / 0 : 7', 7],
  ['object', '({count: 2}).count', 2],
  ['unicode', '"ș".normalize("NFC")', 'ș'],
  ['only', 'only([{x: 42}]).x', 42],
  // Bounded functional operations (proposal P-6).
  ['range', 'range(4)', [0, 1, 2, 3]],
  ['range start end', 'range(2, 5)', [2, 3, 4]],
  ['range empty', 'range(3, 1)', []],
  ['map', '[1, 2, 3].map(x => x * 2)', [2, 4, 6]],
  ['map index', '["a", "b"].map((x, i) => x + String(i))', ['a0', 'b1']],
  ['filter', 'range(10).filter(x => x % 3 == 0)', [0, 3, 6, 9]],
  ['reduce', '[1, 2, 3].reduce((acc, x) => acc + x, 10)', 16],
  ['reduce no initial', '[4, 5].reduce((acc, x) => acc * x)', 20],
  ['sort comparator', '[3, 1, 2].sort((a, b) => a - b)', [1, 2, 3]],
  ['sort descending stable', '[{n: "a", k: 1}, {n: "b", k: 2}, {n: "c", k: 1}].sort((a, b) => b.k - a.k).map(r => r.n).join("")', 'bac'],
  ['sort does not change its input', '$xs.sort((a, b) => b - a).length + $xs[0]', 4],
  ['sum', 'sum([1.5, 2.5, 3])', 7],
  ['sum empty', 'sum([])', 0],
  ['count', 'count([1, 2, 3])', 3],
  ['count with test', 'count(range(20), x => x % 7 == 0)', 3],
  ['min max', 'min([4, 2, 8]) + max([4, 2, 8])', 10],
  ['array includes', '[2, 4, 6].includes(4) && ![2, 4, 6].includes(5)', true],
  ['nested closure', 'range(3).map(i => range(2).map(j => i * 10 + j + $s.length))', [[5, 6], [15, 16], [25, 26]]],
  ['choice from data', '[{name: "A", cost: 12}, {name: "B", cost: 9}].reduce((best, x) => x.cost < best.cost ? x : best).name', 'B'],
];
for (const [name, expr, expected] of accepted) {
  test('jsEval ' + name, () => {
    assert.deepEqual(runExpression(expr, {refs: {s: ' Ana ', xs: [1, 3, 2]}}).value, expected);
  });
}

// Each rejection names the sandbox guard that must fire, so an incidental
// TypeError or a different guard cannot make the case pass.
const rejected = [
  ['process.exit()', /Method not allowed: exit$/],
  ['globalThis', /No global values in jsEval: globalThis$/],
  ['Function("return 1")()', /Unsupported call$/],
  ['({}).constructor', /Forbidden property$/],
  ['({})["__proto__"]', /Forbidden property$/],
  ['require("fs")', /Only String\/Number\/only\/range\/sum\/count\/min\/max are callable$/],
  ['import("fs")', /Only String\/Number\/only\/range\/sum\/count\/min\/max are callable$/],
  ['while(true){}', /Expected eof, got \{$/],
  ['/abc/.test("a")', /Expected expression, got \/$/],
  ['"x".repeat(1000000000)', /Method not allowed: repeat$/],
  ['1/0', /Nonfinite result$/],
  ['only([])', /only\(\) requires exactly one result/],
  ['only([1,2])', /only\(\) requires exactly one result/],
  // Arrow functions exist only as arguments of the bounded operations: no call, no storage, no recursion, no block body.
  ['(x => x)(1)', /Unsupported call$/],
  ['x => x', /A function is allowed only as the argument/],
  ['[x => x]', /A function is allowed only as the argument/],
  ['({f: x => x}).f', /A function is allowed only as the argument/],
  ['[1].map(true ? x => x : x => 0)', /A function is allowed only as the argument/],
  ['"ab".includes(x => x)', /A function is allowed only as the argument/],
  ['[1].map(x => { return x })', /expression body, not a block/],
  ['[1].map(x => { a: 1 })', /expression body, not a block/],
  ['[1].map(constructor => 1)', /Arrow parameter name not allowed: constructor$/],
  ['[1].map(Math => 1)', /Arrow parameter name not allowed: Math$/],
  ['[1].map((x, x) => 1)', /Duplicate arrow parameter$/],
  ['[1].map((a, b, c, d) => a)', /at most 3 parameters$/],
  ['[1].map((a, b, c) => a)', /passes at most 2 arguments/],
  ['[1].map(x => y)', /No global values in jsEval: y$/],
  ['[1].map(x => globalThis)', /No global values in jsEval: globalThis$/],
  ['[1].map(x => this)', /No global values in jsEval: this$/],
  ['[1].map(x => x.constructor)', /Forbidden property$/],
  ['[1].map(x => x["__proto__"])', /Forbidden property$/],
  ['[1].map(x => x.map)', /Cannot index this value$/],
  ['[[1]].map(x => x.map)', /Missing own property map$/],
  ['[1].map(x => [].map.call(x))', /Method not allowed: call$/],
  ['[1].map([1])', /map takes one function$/],
  ['[1].filter(x => x).sort()', /sort takes a comparator/],
  ['[1, 2].sort((a, b) => "x")', /comparator must return a number$/],
  ['[].reduce((a, x) => a + x)', /empty array needs an initial value$/],
  ['sum([1, "2"])', /sum requires an array of numbers$/],
  ['max([])', /max\(\) of an empty array$/],
  ['min(1, 2)', /min\(array\) takes one array/],
  ['range(1.5)', /range\(n\) or range\(start, end\) takes integers$/],
  ['range(100000)', /Array output budget$/],
  ['[{a: 1}].includes({a: 1})', /includes takes one number, string or yes\/no value$/],
  ['[1].sort((a, b) => a - b).sort', /Missing own property sort$/],
  ['({a:1}).missing', /Missing own property missing$/],
];
for (const [expr, message] of rejected) {
  test('jsEval rejects ' + expr, () => {
    assert.throws(() => runExpression(expr), message);
  });
}

test('a data value shaped like a closure is never a function', () => {
  const forged = {closure: {type: 'arrow', params: [], body: {type: 'literal', value: 1}}, scope: null};
  assert.throws(() => runExpression('[1].map($f)', {refs: {f: forged}}), /map takes one function$/);
});

test('every callback call and every whole-array step is charged to the operation budget', () => {
  assert.throws(() => runExpression('range(4096).map(i => range(4096))'), /Expression operation budget$/);
  assert.throws(() => runExpression('range(2000).map(x => x).map(x => x).map(x => x)'), /Expression operation budget$/);
  assert.throws(() => runExpression('range(1000).sort((a, b) => b - a)'), /Expression operation budget$/);
  assert.throws(() => runExpression('sum(range(4000)) + sum(range(4000)) + sum(range(4000))'), /Expression operation budget$/);
  assert.throws(() => runExpression('count(range(10), x => x > 1)', {maxOps: 20}), /Expression operation budget$/);
  assert.throws(() => runExpression('range(10).map(x => "aaaaaaaa").join("")', {maxBytes: 40}), /join output budget$/);
  assert.equal(runExpression('sum(range(100))').value, 4950);
});

test('operation and output limits', () => {
  assert.throws(() => runExpression('1+2+3', {maxOps: 2}), /Expression operation budget$/);
  assert.throws(() => runExpression('"12345" + "6789"', {maxBytes: 6}), /Concatenation budget$/);
});

test('no coercive equality', () => {
  assert.equal(runExpression('"2" == 2').value, false);
});
