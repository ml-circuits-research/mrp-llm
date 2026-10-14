/**
 * Z3 as a subprocess: the SMT-LIB script goes in on stdin (`z3 -in`), the answers come back as s-expressions. Every call carries a
 * hard time limit (`-T`); a stop is reported as `interrupted`, which the strategy maps to `budget_exhausted` with `reason wall`, and an
 * `unknown` answer (for example a nonlinear problem) is never read as sat or unsat.
 *
 * The binary is private (tools/.solvers/z3/bin/z3, or Z3_BIN); nothing is installed.
 * Debugging aid: Z3_DUMP=1 prints every script to stderr before the call.
 */
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

const repoBin = fileURLToPath(new URL('../../../tools/.solvers/z3/bin/z3', import.meta.url));

export const z3Command = () => process.env.Z3_BIN || (fs.existsSync(repoBin) ? repoBin : 'z3');

export function z3Version() {
  const r = spawnSync(z3Command(), ['--version'], {encoding: 'utf8', timeout: 5000});
  if (r.error || (r.status !== 0 && r.status !== null)) return null;
  return /Z3 version ([\d.]+)/.exec(r.stdout ?? '')?.[1] ?? null;
}

export class SolverStop extends Error {
  constructor(reason) { super(`solver stopped: ${reason}`); this.reason = reason; }
}

/** Parse the output of a script into a list of top-level s-expressions (atoms are strings, lists are arrays). */
export function parseSexps(text) {
  const out = [];
  let i = 0;
  const skip = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const one = () => {
    skip();
    if (text[i] === '(') {
      i++;
      const list = [];
      for (;;) { skip(); if (i >= text.length || text[i] === ')') { i++; break; } list.push(one()); }
      return list;
    }
    if (text[i] === '"') { let j = i + 1; while (j < text.length && text[j] !== '"') j++; const s = text.slice(i, j + 1); i = j + 1; return s; }
    const m = /^[^\s()]+/.exec(text.slice(i));
    i += m[0].length;
    return m[0];
  };
  for (skip(); i < text.length; skip()) out.push(one());
  return out;
}

/** An SMT integer literal as text (negative numbers are `(- n)`). */
export const smtInt = n => (n < 0 ? `(- ${-n})` : String(n));
/** The integer a value s-expression denotes. */
export function intOf(x) {
  const n = Array.isArray(x) ? (x[0] === '-' ? -intOf(x[1]) : Number(x[0])) : Number(x);
  // Z3 integers are unbounded; the packet's are safe integers, so a value beyond them is a range stop, not a rounded number
  if (!Number.isSafeInteger(n)) throw new SolverStop('numeric_range');
  return n;
}

/**
 * Run a script. `text` should end with the commands whose answers matter. Returns {results: [sexp...], interrupted}. An `(error ...)`
 * answer throws, because it means the strategy wrote an invalid script.
 */
export function runZ3(text, {timeoutMs = 30000} = {}) {
  if (process.env.Z3_DUMP) process.stderr.write('--- z3 script ---\n' + text + '\n');
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const r = spawnSync(z3Command(), ['-in', `-T:${seconds}`], {input: text, encoding: 'utf8', timeout: timeoutMs + 3000, maxBuffer: 512 * 1024 * 1024});
  if (r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM') return {results: [], interrupted: true};
  if (r.error) throw new Error('z3 could not run: ' + r.error.message);
  const results = parseSexps(r.stdout ?? '');
  if (/^timeout/m.test(r.stdout ?? '')) return {results, interrupted: true};
  // a get-value after an `unsat` answers "model is not available": the script asked for it unconditionally, it is not a script error
  const errors = results.filter(x => Array.isArray(x) && x[0] === 'error' && !/model is not available/.test(String(x[1])));
  if (errors.length) throw new Error('z3 rejected the script: ' + errors[0].slice(1).join(' '));
  return {results: results.filter(x => !(Array.isArray(x) && x[0] === 'error')), interrupted: false};
}

/** The `(name value)` pairs of a get-value answer as a Map name -> value s-expression. */
export function valuesOf(answer) {
  const m = new Map();
  if (!Array.isArray(answer)) return m;
  for (const pair of answer) if (Array.isArray(pair) && pair.length === 2) m.set(typeof pair[0] === 'string' ? pair[0] : JSON.stringify(pair[0]), pair[1]);
  return m;
}
