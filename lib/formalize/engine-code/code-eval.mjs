/**
 * The sandbox of the `codeEval` wire (proposal P-7, owner decision 2026-10-03): a small JavaScript program written by the formalizer
 * (functions, loops, recursion, arrays, objects) is UNTRUSTED code. It runs
 *   - in a worker thread of its own (node:worker_threads) with V8 resource limits (heap, young generation, code range, stack), an
 *     empty environment, no stdin, captured stdout/stderr, terminated by the caller after a wall-time limit;
 *   - inside that worker, in a fresh V8 context (node:vm) whose global object has only the ECMAScript built-ins: no require, import,
 *     process, console, timers, fetch or WebAssembly; code generation from strings and WebAssembly compilation are disabled (eval,
 *     new Function and Function("…") throw), and the synchronous run has its own timeout;
 *   - with its inputs given as JSON literals (named constants), and its result serialised to JSON inside the context, so no object of
 *     the worker or of the caller ever enters or leaves the sandbox; the result is bounded in size.
 * node:vm alone is not a security mechanism (https://nodejs.org/api/vm.html); here no host object is reachable from the context and
 * the worker bounds time and memory. A WebAssembly isolate (QuickJS) would be a stronger boundary and needs a dependency: recorded as
 * the next step in experiments/proposal/wire-type-proposals.md P-7.
 *
 * Only the JS engine executes `codeEval`; the logic engines never see it (it is not a knowledge wire).
 */
import {Worker} from 'node:worker_threads';

export const CODE_LIMITS = Object.freeze({timeMs: 1000, heapMb: 64, youngMb: 16, codeMb: 16, stackMb: 4, maxOutputBytes: 65536, maxCodeBytes: 16384});
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set(['break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'return', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static', 'enum', 'await', 'implements', 'package', 'protected', 'interface', 'private', 'public', 'null', 'true', 'false', 'undefined', 'NaN', 'Infinity', 'eval', 'arguments', 'globalThis']);

// The worker's own code (CommonJS, evaluated from this string). It builds the context, runs the program once and posts one message.
const BOOTSTRAP = `
const {parentPort, workerData} = require('node:worker_threads');
const vm = require('node:vm');
const {source, timeMs, maxOutputBytes} = workerData;
let out;
try {
  const context = vm.createContext(Object.create(null), {codeGeneration: {strings: false, wasm: false}, microtaskMode: 'afterEvaluate', name: 'codeEval'});
  // ECMAScript built-ins that give a program no use but could block or reach outside: removed before the program runs.
  vm.runInContext('for (const k of ["WebAssembly", "SharedArrayBuffer", "Atomics", "FinalizationRegistry", "WeakRef", "console"]) delete globalThis[k];', context);
  const text = new vm.Script(source, {filename: 'codeEval.js'}).runInContext(context, {timeout: timeMs, breakOnSigint: false});
  if (typeof text !== 'string') out = {ok: false, code: 'code_no_result', message: 'the program returned nothing that can be written as JSON'};
  else if (text.length > maxOutputBytes) out = {ok: false, code: 'code_output_limit', message: 'the result is larger than ' + maxOutputBytes + ' bytes'};
  else out = {ok: true, json: text};
} catch (error) {
  const message = String(error && error.message || error).slice(0, 300);
  out = {ok: false, code: /Script execution timed out/.test(message) ? 'code_time_limit' : /Maximum call stack/.test(message) ? 'code_stack_limit' : /Invalid (string|array) length|allocation failed|out of memory/i.test(message) ? 'code_memory_limit' : /Code generation from strings disallowed/.test(message) ? 'code_generation_refused' : 'code_error', message};
}
parentPort.postMessage(out);
`;

/** Validates the inputs ({name: JSON value}) and the program text; throws with a code. */
function check(code, inputs) {
  if (typeof code !== 'string' || !code.trim()) throw Object.assign(new Error('codeEval needs a program'), {code: 'code_empty'});
  if (Buffer.byteLength(code) > CODE_LIMITS.maxCodeBytes) throw Object.assign(new Error(`the program is longer than ${CODE_LIMITS.maxCodeBytes} bytes`), {code: 'code_too_long'});
  for (const [name, value] of Object.entries(inputs)) {
    if (!NAME.test(name) || RESERVED.has(name)) throw Object.assign(new Error(`input name ${name} is not usable`), {code: 'code_bad_input'});
    const json = JSON.stringify(value);
    if (json === undefined || Buffer.byteLength(json) > CODE_LIMITS.maxOutputBytes) throw Object.assign(new Error(`input ${name} is not a bounded JSON value`), {code: 'code_bad_input'});
  }
}

/**
 * The script run in the context: the inputs as constants (JSON literals), the program as the body of a strict function, the result
 * serialised inside the context. `undefined` (no return) gives no string.
 */
export function codeSource(code, inputs = {}) {
  const constants = Object.entries(inputs).map(([k, v]) => `const ${k} = ${JSON.stringify(v)};`).join('\n');
  // A promise (an async function, a dynamic import, which the context refuses) is not a result.
  return `"use strict";\n(function () {\nconst result = (function () {\n${constants}\n${code}\n})();\nif (result !== null && (typeof result === 'object' || typeof result === 'function') && typeof result.then === 'function') throw new Error('a promise is not a result: compute the answer synchronously');\nreturn JSON.stringify(result);\n})();`;
}

/**
 * Runs a program in the sandbox: {ok: true, value, ms} or {ok: false, code, message, ms}. Codes: code_empty, code_too_long,
 * code_bad_input, code_time_limit, code_memory_limit, code_stack_limit, code_output_limit, code_no_result, code_generation_refused,
 * code_error, code_crashed.
 */
export async function runCode(code, inputs = {}, limits = {}) {
  const L = {...CODE_LIMITS, ...limits}, t0 = performance.now();
  try { check(code, inputs); } catch (error) { return {ok: false, code: error.code, message: error.message, ms: 0}; }
  const worker = new Worker(BOOTSTRAP, {eval: true, workerData: {source: codeSource(code, inputs), timeMs: L.timeMs, maxOutputBytes: L.maxOutputBytes},
    env: {}, argv: [], execArgv: [], stdin: false, stdout: true, stderr: true,
    resourceLimits: {maxOldGenerationSizeMb: L.heapMb, maxYoungGenerationSizeMb: L.youngMb, codeRangeSizeMb: L.codeMb, stackSizeMb: L.stackMb}});
  worker.stdout.resume(); worker.stderr.resume();
  const result = await new Promise(resolve => {
    // The wall-time backstop: the context's own timeout stops a synchronous loop; this ends everything else (start-up included).
    const timer = setTimeout(() => { resolve({ok: false, code: 'code_time_limit', message: `the program ran longer than ${L.timeMs} ms`}); worker.terminate(); }, L.timeMs + 1500);
    worker.once('message', m => { clearTimeout(timer); resolve(m); });
    worker.once('error', error => { clearTimeout(timer); resolve({ok: false, code: error?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'code_memory_limit' : 'code_crashed', message: String(error?.message ?? error).slice(0, 300)}); });
    worker.once('exit', exitCode => { clearTimeout(timer); resolve({ok: false, code: 'code_crashed', message: `the sandbox exited (${exitCode})`}); });
  });
  await worker.terminate().catch(() => {});
  const ms = Math.round(performance.now() - t0);
  if (!result.ok) return {...result, ms};
  let value;
  try { value = JSON.parse(result.json); } catch { return {ok: false, code: 'code_no_result', message: 'the result is not JSON', ms}; }
  return {ok: true, value, ms};
}
