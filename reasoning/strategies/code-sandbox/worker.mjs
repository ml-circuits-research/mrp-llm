/**
 * The worker of the code-sandbox strategy. It runs inside a `worker_threads` Worker started by `index.mjs` with an empty
 * environment, a heap limit and a wall-clock guard owned by the parent. The program under test never runs in this realm: it runs
 * in a fresh `vm` context that holds only the ECMAScript built-ins (no `require`, `process`, `fetch`, timers, `console` output or
 * module loader; `import()` has no callback and fails), one context per test, with a per-test CPU timeout.
 *
 * The expected value of a test is evaluated in a SEPARATE clean context, never in the context that holds the program, so a program
 * cannot change the expected value; both values are serialised here, in the worker realm, by tags (`Object.prototype.toString`), so
 * prototype changes made by the program do not affect the comparison.
 *
 * Messages to the parent: {type:'start', id}, {type:'result', ...}, {type:'done'}.
 */
import {parentPort, workerData} from 'node:worker_threads';
import vm from 'node:vm';

const {body, entry, tests, inputs, perTestMs, maxFacts} = workerData;
const tag = v => Object.prototype.toString.call(v).slice(8, -1);

/** Canonical, order-insensitive for objects, Maps and Sets; distinguishes undefined, NaN, Infinity, BigInt and Date. */
function enc(v, depth = 0) {
  if (depth > 30) return {t: 'deep'};
  if (v === undefined) return {t: 'undefined'};
  if (v === null) return null;
  switch (typeof v) {
    case 'number': return Number.isNaN(v) ? {t: 'nan'} : (v === Infinity || v === -Infinity) ? {t: 'inf', s: v > 0 ? 1 : -1} : (Object.is(v, -0) ? 0 : v);
    case 'string': case 'boolean': return v;
    case 'bigint': return {t: 'bigint', v: String(v)};
    case 'function': return {t: 'function'};
    case 'symbol': return {t: 'symbol'};
    default: break;
  }
  const k = tag(v);
  if (Array.isArray(v)) { const out = []; for (let i = 0; i < v.length; i++) out.push(enc(v[i], depth + 1)); return out; }
  if (k === 'Map') { const out = []; Map.prototype.forEach.call(v, (x, key) => out.push([enc(key, depth + 1), enc(x, depth + 1)])); return {t: 'map', v: out.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)}; }
  if (k === 'Set') { const out = []; Set.prototype.forEach.call(v, x => out.push(enc(x, depth + 1))); return {t: 'set', v: out.sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)}; }
  if (k === 'Date') return {t: 'date', v: Date.prototype.getTime.call(v)};
  if (k === 'Promise') return {t: 'promise'};
  if (k === 'Object') { const o = {}; for (const key of Object.keys(v).sort()) o[key] = enc(v[key], depth + 1); return {t: 'object', v: o}; }
  return {t: k};
}
const canon = v => JSON.stringify(enc(v));
const show = v => { let s; try { s = JSON.stringify(v, (_, x) => x === undefined ? '[undefined]' : typeof x === 'bigint' ? String(x) + 'n' : typeof x === 'number' && !Number.isFinite(x) ? String(x) : typeof x === 'function' ? '[function]' : tag(x) === 'Promise' ? '[Promise]' : Map.prototype.isPrototypeOf(x) || tag(x) === 'Map' ? {Map: [...Map.prototype.entries.call(x)]} : tag(x) === 'Set' ? {Set: [...Set.prototype.values.call(x)]} : x); } catch { s = '[unprintable]'; } return (s ?? 'undefined').slice(0, 300); };

/** Safe integers of a value, flat or one array level deep, at most `max` of them (the closed trace facts of DS006 `code-sandbox`). */
function ints(v, max) {
  const out = [];
  const add = x => { if (Number.isSafeInteger(x) && out.length < max) out.push(x); };
  if (Array.isArray(v)) { for (const x of v) { if (Array.isArray(x)) for (const y of x) add(y); else add(x); } } else add(v);
  return out;
}

/** The user context: only the built-ins plus a silent `console`. */
function userContext() {
  const ctx = vm.createContext(Object.create(null), {codeGeneration: {strings: true, wasm: false}});
  new vm.Script('globalThis.console = {log() {}, info() {}, warn() {}, error() {}, debug() {}};').runInContext(ctx);
  return ctx;
}

/** `(function(ENTRY){ return (CALL); })(ARGUMENTS)`: evaluates the call with the entry name bound to a function that returns its arguments. */
const argsProbe = call => `(function(${entry}) { return (${call}); })(function() { return Array.prototype.slice.call(arguments); })`;

function evalIn(ctx, source, timeout) { return new vm.Script(source).runInContext(ctx, {timeout}); }

function runOne({id, call, expect, timeout, kind}, runNo) {
  const limit = Math.min(timeout ?? perTestMs, perTestMs * 4);
  const run = 'r' + runNo;
  const facts = [{p: 'run', terms: [run]}];
  const base = {id, kind: kind ?? 'example', call, run};
  let expectedValue = null, hasExpect = expect !== undefined && expect !== null;
  if (hasExpect) {
    try { expectedValue = evalIn(vm.createContext(Object.create(null)), '(' + expect + ')', limit); } catch (e) { return {...base, outcome: 'bad_test', error: 'expect cannot be evaluated: ' + String(e?.message ?? e).slice(0, 200), facts}; }
  }
  try { for (const n of ints(evalIn(vm.createContext(Object.create(null)), argsProbe(call), limit), maxFacts)) facts.push({p: 'in_elem', terms: [run, n]}); } catch { /* the call is not a plain entry call: no input facts */ }
  const ctx = userContext();
  let actual;
  try {
    evalIn(ctx, body, limit);
    actual = evalIn(ctx, '(' + call + ')', limit);
  } catch (e) {
    const msg = String(e?.message ?? e).slice(0, 300);
    if (e?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return {...base, outcome: 'budget', reason: 'wall', error: 'no result within ' + limit + ' ms', facts};
    facts.push({p: 'test_result', terms: [run, id, 'failed']});
    return {...base, outcome: 'error', error: (e?.name ? e.name + ': ' : '') + msg, facts};
  }
  for (const n of ints(actual, maxFacts)) facts.push({p: 'out_elem', terms: [run, n]});
  if (!hasExpect) return {...base, outcome: 'ran', actual: show(actual), facts};
  const same = canon(actual) === canon(expectedValue);
  facts.push({p: 'test_result', terms: [run, id, same ? 'passed' : 'failed']});
  return {...base, outcome: same ? 'passed' : 'failed', expected: show(expectedValue), actual: show(actual), facts};
}

let runNo = 0;
const all = [...tests.map(t => ({...t, kind: t.kind ?? 'example'})), ...inputs.map((c, i) => ({id: c.id ?? 'in' + (i + 1), call: c.call, expect: undefined, kind: 'generated', timeout: c.timeout}))];
for (const t of all) {
  parentPort.postMessage({type: 'start', id: t.id});
  const result = runOne(t, ++runNo);
  parentPort.postMessage({type: 'result', result});
  if (result.outcome === 'budget') break;
}
parentPort.postMessage({type: 'done'});
