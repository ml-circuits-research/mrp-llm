// Adversarial tests of the engineCode sandboxes (proposal P-7, owner authorization 2026-10-03): model-written programs are untrusted;
// every escape, resource bomb and I/O construct must be refused or stopped, and ordinary programs must give their answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {runCode} from '../../lib/formalize/engine-code/code-eval.mjs';
import {runEngineCode} from '../../lib/formalize/engine-code/index.mjs';

test('js: an ordinary program returns its answer from the named inputs', async () => {
  const r = await runCode('let t = 0; for (let i = 0; i < boxes; i++) t += per_box * price; return t;', {boxes: 3, per_box: 12, price: 2.5});
  assert.equal(r.ok, true); assert.equal(r.value, 90);
});

test('js: escapes, bombs and code generation are refused or stopped', async () => {
  const cases = [
    ['while (true) {}', 'code_time_limit'],
    ['const a = []; while (true) a.push(new Array(1e6).fill(1));', /code_memory_limit|code_crashed|code_time_limit/],
    ['function f() { return f(); } return f();', /code_stack_limit|code_error/],
    ['return eval("1+1");', /code_generation_refused|code_error/],
    ['return Function("return 1")();', /code_generation_refused|code_error/],
    ['return (function(){}).constructor("return process")();', /code_generation_refused|code_error/],
    ['return typeof require + typeof process + typeof fetch;', null],
  ];
  for (const [code, expected] of cases) {
    const r = await runCode(code, {});
    if (expected === null) { assert.equal(r.ok, true); assert.equal(r.value, 'undefinedundefinedundefined'); continue; }
    assert.equal(r.ok, false, code);
    if (expected instanceof RegExp) assert.match(r.code, expected, code); else assert.equal(r.code, expected, code);
  }
});

test('engines: forbidden I/O constructs are refused before running', async () => {
  const refused = [
    ['asp', '#script (python) import os #end. answer(1).'],
    ['asp', '#include "/etc/passwd". answer(1).'],
    ['smt', '(include "/etc/passwd") (declare-const answer Int)'],
    ['datalog', '.decl answer(x: number)\n.input answer(filename="/etc/passwd")'],
    ['sql', "ATTACH DATABASE '/tmp/x.db' AS x; SELECT 1;"],
  ];
  for (const [engine, code] of refused) {
    const r = await runEngineCode(engine, code, {});
    assert.equal(r.ok, false, `${engine}: ${code}`);
    assert.equal(r.code, 'code_forbidden', `${engine}: ${code}`);
  }
});

test('engines: an ordinary program in each language gives the answer from the named inputs', async (t) => {
  const inputs = {boxes: 3, per_box: 12};
  const programs = {
    js: 'return boxes * per_box;',
    prolog: 'answer(T) :- boxes(B), per_box(P), T is B * P.',
    asp: 'answer(T) :- boxes(B), per_box(P), T = B * P.',
    smt: '(declare-const answer Int) (assert (= answer (* boxes per_box)))',
    datalog: '.decl answer(x: number)\nanswer(t) :- boxes(b), per_box(p), t = b * p.',
    sql: "SELECT (SELECT value FROM input WHERE name = 'boxes') * (SELECT value FROM input WHERE name = 'per_box');",
  };
  for (const [engine, code] of Object.entries(programs)) {
    const r = await runEngineCode(engine, code, inputs);
    if (!r.ok && /ENOENT|not found|spawn/.test(r.message ?? '')) { t.diagnostic(`${engine} not installed: ${r.message}`); continue; }
    assert.equal(r.ok, true, `${engine}: ${r.code} ${r.message}`);
    assert.deepEqual(r.values.map(Number), [36], engine);
  }
});

test('prolog: shell, file and network predicates are refused by the sandbox', async (t) => {
  for (const code of ['answer(X) :- shell("echo hi", X).', 'answer(X) :- open("/etc/passwd", read, S), read(S, X).', ':- shell("touch /tmp/pwned").\nanswer(1).']) {
    const r = await runEngineCode('prolog', code, {});
    if (!r.ok && /ENOENT|spawn/.test(r.message ?? '')) { t.diagnostic('swipl not installed'); return; }
    assert.equal(r.ok, false, code);
    assert.equal(r.code, 'code_forbidden', `${code}: ${r.message}`);
  }
});

test('engines: a runaway program is stopped at the wall-clock limit', async (t) => {
  const r = await runEngineCode('prolog', 'loop :- loop. answer(1) :- loop.', {}, {timeMs: 2000});
  if (!r.ok && /ENOENT|spawn/.test(r.message ?? '')) { t.diagnostic('swipl not installed'); return; }
  assert.equal(r.ok, false); assert.match(r.code, /code_time_limit|code_memory_limit|code_forbidden/);
});
