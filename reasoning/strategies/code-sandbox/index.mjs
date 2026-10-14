/**
 * code-sandbox: runs a `code` wire on `test` wires (DS004 "Programming wires", DS006 "code-sandbox") and says what happened. It is not a
 * reasoning engine and it holds no knowledge; it is the verifier of the programming path (proposal `programming-kb-plan.md`, milestone P0).
 *
 *   input     `ask({code, tests, inputs}, budget, options)`
 *               code    SOP text with ONE `code` wire, or `{entry, body}` (language javascript)
 *               tests   SOP text of `test` wires, or an array of `{id, call, expect, kind?, timeout?}`
 *               inputs  optional extra calls without expectation (generated inputs): `"f([3, 1])"` or `{id, call}`; they must run without an error
 *   output    `verified` (every test passed; `guarantee: bounded`, never `exact`), `failed` (failing tests with call, expected, actual or error),
 *             `budget_exhausted` (`reason: wall | memory`, the test that hit it), `not_computable` (`reason: no_tests`: a program is never
 *             verified by zero tests) or `error` (a malformed problem). The execution trace is a list of CLOSED facts: `run r1`, `in_elem r1 3`,
 *             `out_elem r1 2`, `test_result r1 t1 passed` (integers only, at most 50 per run), for `conform` and the Datalog strategies.
 *   isolation one worker thread per ask, empty environment, a heap limit, a wall-clock guard owned by the parent that terminates the worker;
 *             the program runs in a `vm` context with the ECMAScript built-ins only (no require, no process, no network, no filesystem, no timers,
 *             `import()` fails), one context per test, with a per-test CPU timeout. See worker.mjs. Asynchronous results (promises) are failures.
 *   honesty   a passing program is `verified` by the given tests only (`guarantee: bounded`). A program written to cheat the sandbox is not a
 *             security threat to the host, but it could try to mislead its own comparison: the expected value is therefore evaluated in a separate
 *             clean context and both values are compared by tag in the worker realm.
 */
import {Worker} from 'node:worker_threads';
import {fileURLToPath} from 'node:url';
import {parse, FEATURES} from '../../../sop/knowledge/index.mjs';
import {NotExpressibleError, ProgramError} from '../js-reference/values.mjs';

export {NotExpressibleError, ProgramError};

const WORKER = fileURLToPath(new URL('./worker.mjs', import.meta.url));
export const DEFAULT_BUDGET = {wallMs: 10000, perTestMs: 1500, heapMb: 128, maxFacts: 50};

export const capabilities = {
  id: 'code-sandbox',
  features: ['code_sandbox'],
  notExpressible: FEATURES.filter(f => f !== 'code_sandbox'),
  delivery: 'whole',
  limits: {max_wires: Infinity, max_chars: 200000, max_arity: 6, integer_range: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]},
  guarantee: 'bounded',
  exact: false,
  bounded: true,
  verified: false,
  advisory: false,
  provides: ['trace'],
  budgetKeys: ['wall', 'memory'],
  determinism: 'deterministic-for-pure-code',
  isolation: true,
  languages: ['javascript']
};

export async function available() { return {ok: true, version: process.version, isolation: 'worker_threads + vm context'}; }

const text = f => { try { return JSON.parse(f.value.trim()); } catch { throw new ProgramError(`field ${f.key} is not a JSON string`); } };
const field = (w, k) => w.fields.find(f => f.key === k);

/** Normalise the code input to `{entry, body}`. */
export function readCode(code) {
  if (code && typeof code === 'object') {
    if (typeof code.entry !== 'string' || typeof code.body !== 'string') throw new ProgramError('code needs entry and body');
    return {entry: code.entry, body: code.body, id: code.id ?? null};
  }
  if (typeof code !== 'string') throw new ProgramError('code is SOP text with a code wire, or {entry, body}');
  const {wires, errors} = parse(code);
  if (errors.length) throw new ProgramError('code wire does not parse: ' + errors[0].message);
  const w = wires.filter(x => x.type === 'code');
  if (w.length !== 1) throw new ProgramError(`expected exactly one code wire, found ${w.length}`);
  const language = field(w[0], 'language')?.value.trim();
  if (language !== 'javascript') throw new NotExpressibleError(['language'], `the code-sandbox runs javascript only, not ${language}`);
  return {entry: field(w[0], 'entry').value.trim(), body: text(field(w[0], 'body')), id: w[0].id};
}

/** Normalise the tests input to `[{id, call, expect, kind, timeout}]`. */
export function readTests(tests) {
  if (Array.isArray(tests)) return tests.map((t, i) => ({id: t.id ?? 't' + (i + 1), call: t.call, expect: t.expect, kind: t.kind ?? 'example', timeout: t.timeout}));
  if (typeof tests !== 'string') throw new ProgramError('tests is SOP text of test wires, or an array of {id, call, expect}');
  const {wires, errors} = parse(tests);
  if (errors.length) throw new ProgramError('test wires do not parse: ' + errors[0].message);
  return wires.filter(w => w.type === 'test').map(w => ({id: w.id, call: text(field(w, 'call')), expect: text(field(w, 'expect')), kind: field(w, 'kind')?.value.trim() ?? 'example', timeout: field(w, 'timeout') ? Number(field(w, 'timeout').value) : undefined}));
}

/** Strip ES module `export` syntax so that the body runs as a script in the vm context (imports stay and fail inside the context). */
export function toScript(body) {
  return body
    .replace(/^[ \t]*export\s+default\s+(?=(?:async\s+)?function|class)/gm, '')
    .replace(/^[ \t]*export\s+(?=(?:async\s+)?function|const|let|var|class)/gm, '')
    .replace(/^[ \t]*export\s*\{[^}]*\}\s*;?[ \t]*$/gm, '');
}

const factText = f => f.p + ' ' + f.terms.join(' ');
const result = (packet, extra) => ({...packet, guarantee: 'bounded', exact: false, bounded: true, advisory: false, route: {requested: extra.requested ?? null, chosen: 'code-sandbox', reason: extra.requested ? 'explicit request' : 'direct call to the strategy', fallback: null, backend: 'worker_threads+vm'}});

/** Run the worker once; resolves with the collected messages and how the run ended (`done`, `wall`, `memory` or `crash`). */
function runWorker(data, {wallMs, heapMb}) {
  return new Promise(resolve => {
    const results = []; let current = null, ended = false;
    const worker = new Worker(WORKER, {workerData: data, env: {}, stdout: true, stderr: true, resourceLimits: {maxOldGenerationSizeMb: heapMb, maxYoungGenerationSizeMb: Math.max(8, Math.floor(heapMb / 4)), stackSizeMb: 2, codeRangeSizeMb: 16}});
    const finish = (how, detail) => { if (ended) return; ended = true; clearTimeout(timer); worker.terminate().catch(() => {}); resolve({results, current, how, detail}); };
    const timer = setTimeout(() => finish('wall'), wallMs);
    worker.on('message', m => { if (m.type === 'start') current = m.id; else if (m.type === 'result') { results.push(m.result); current = null; } else if (m.type === 'done') finish('done'); });
    worker.on('error', e => finish(e?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'memory' : 'crash', String(e?.message ?? e).slice(0, 200)));
    worker.on('exit', () => finish(current === null ? 'crash' : 'crash', 'worker exited early'));
  });
}

/**
 * Run `code` on `tests` (and `inputs`). `budget`: `{wallMs, perTestMs, heapMb}` (defaults DEFAULT_BUDGET). Never throws for a failing program; a malformed problem
 * throws ProgramError and an unsupported language NotExpressibleError.
 */
export async function ask(problem, budgetArg = {}, options = {}) {
  const budget = {...DEFAULT_BUDGET, ...Object.fromEntries(Object.entries(budgetArg ?? {}).filter(([, v]) => v !== undefined))};
  const t0 = Date.now();
  const code = readCode(problem.code);
  const tests = readTests(problem.tests ?? []);
  const inputs = (problem.inputs ?? []).map((c, i) => typeof c === 'string' ? {id: 'in' + (i + 1), call: c} : {id: c.id ?? 'in' + (i + 1), call: c.call, timeout: c.timeout});
  const base = {tests: {total: tests.length, passed: 0, failed: 0}, ms: 0};
  if (!tests.length) return result({status: 'not_computable', reason: 'no_tests', complete: true, notes: ['a program is never verified by zero tests'], ...base, trace: [], facts: []}, {requested: problem.requested});
  const run = await runWorker({body: toScript(code.body), entry: code.entry, tests, inputs, perTestMs: budget.perTestMs, maxFacts: budget.maxFacts}, budget);
  const facts = run.results.flatMap(r => r.facts ?? []);
  const failures = run.results.filter(r => ['failed', 'error', 'bad_test'].includes(r.outcome)).map(({id, kind, call, expected, actual, error, outcome}) => ({id, kind, call, ...(expected !== undefined ? {expected} : {}), ...(actual !== undefined ? {actual} : {}), ...(error ? {error} : {}), ...(outcome === 'bad_test' ? {bad_test: true} : {})}));
  const passed = run.results.filter(r => r.outcome === 'passed' || r.outcome === 'ran').length;
  const budgetHit = run.results.find(r => r.outcome === 'budget');
  const stats = {tests: {total: tests.length, passed, failed: failures.length}, ms: Date.now() - t0, ran: run.results.length};
  const common = {...stats, failures, trace: facts.map(factText), facts, code: {entry: code.entry, id: code.id}};
  const extra = {requested: problem.requested};
  if (budgetHit || run.how === 'wall' || run.how === 'memory') {
    const reason = run.how === 'memory' ? 'memory' : 'wall';
    const where = budgetHit?.id ?? run.current;
    return result({status: 'budget_exhausted', reason, complete: false, hit: where, notes: [reason === 'memory' ? `heap limit of ${budget.heapMb} MB reached` : `wall limit reached`].concat(where ? [`while running ${where}`] : []), ...common}, extra);
  }
  if (run.how === 'crash') return result({status: 'error', reason: 'worker', complete: false, detail: run.detail, ...common}, extra);
  const complete = run.results.length === tests.length + inputs.length;
  if (failures.length) return result({status: 'failed', complete: true, ...common}, extra);
  if (!complete) return result({status: 'error', reason: 'incomplete_run', complete: false, ...common}, extra);
  return result({status: 'verified', complete: true, ...common}, extra);
}

export const codeSandbox = {...capabilities, capabilities, available, ask};
export default codeSandbox;
