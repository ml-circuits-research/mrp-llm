/**
 * The runners of the `engineCode` wire (proposal P-7, owner decisions 2026-10-03): a program the formalizer wrote directly in an
 * engine's own language, run by that engine only, on the problem's inputs (named constants). The program is UNTRUSTED.
 *
 *   engine    language             inputs as                              the answer is                      sandbox
 *   js        JavaScript           const NAME = value;                     the returned value                 sop/code-eval.mjs (worker + bare context)
 *   prolog    SWI-Prolog           facts NAME(value).                      every X of answer(X)               load_files sandboxed(true) + safe_goal
 *   asp       clingo (ASP)         facts NAME(value).                      every answer(X) of the (optimal) model   no #script, #include
 *   smt       SMT-LIB (Z3)         (define-fun NAME () Int|Real value)     the values of answer, answer1, ...       no include; check-sat added
 *   datalog   Soufflé              .decl NAME(x: number|float) + fact      every tuple of answer                no .input/.output/.functor/#include
 *   sql       SQLite (in memory)   table input(name, value)                the rows of the last SELECT          child process; no ATTACH/PRAGMA/extension; query_only for the SELECT
 *
 * Every engine runs with a wall-clock limit and is killed on timeout; external solvers run under `prlimit` (address space and CPU
 * time) with an empty environment, in a fresh temporary directory removed afterwards. A refused construct is `code_forbidden`, never
 * silently removed. Result: {ok: true, values: [...], ms, engine} or {ok: false, code, message, ms, engine}.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {runCode, CODE_LIMITS} from './code-eval.mjs';
import {z3Command, parseSexps} from '../../../reasoning/strategies/z3-smt-bounded/z3.mjs';
import {clingoCommand, parseAtom} from '../../../reasoning/strategies/asp-clingo/clingo.mjs';
import {swiplCommand} from '../../../reasoning/strategies/prolog-tabling/swipl.mjs';
import {souffleBinary} from '../../../reasoning/strategies/datalog-souffle/runner.mjs';

export const ENGINE_LANGUAGES = Object.freeze(['js', 'prolog', 'asp', 'smt', 'datalog', 'sql']);
export const ENGINE_LIMITS = Object.freeze({timeMs: 5000, memoryMb: 512, maxOutputBytes: 65536, maxCodeBytes: 16384});
const NAME = /^[a-z][a-z0-9_]*$/;
const fail = (code, message) => ({ok: false, code, message: String(message).slice(0, 400)});
const PRLIMIT = fs.existsSync('/usr/bin/prlimit') ? '/usr/bin/prlimit' : null;

/** Constructs each language must not use (I/O, scripting, loading): a refusal names the first one found. */
const FORBIDDEN = {
  prolog: [],  // the sandbox library decides (load_files sandboxed(true), safe_goal)
  asp: [[/#\s*script\b/, '#script (embedded scripting)'], [/#\s*include\b/, '#include (file loading)']],
  smt: [[/\(\s*include\b/, 'include (file loading)'], [/\(\s*set-option\s+:(?:regular-output-channel|diagnostic-output-channel|trace-file-name)\b/, 'an output channel option']],
  datalog: [[/^\s*\.(?:input|output|printsize|functor|include|pragma|plan)\b/m, 'a directive with I/O or loading (.input, .output, .printsize, .functor, .pragma)'], [/#\s*include\b/, '#include (file loading)'], [/@\s*[A-Za-z_]/, 'a user-defined functor']],
  sql: [[/\b(?:attach|detach|vacuum|pragma|load_extension|readfile|writefile|edit|fts3_tokenizer)\b/i, 'ATTACH, PRAGMA, VACUUM or a file/extension function']],
  js: [],
};

function check(engine, code, inputs) {
  if (!ENGINE_LANGUAGES.includes(engine)) return fail('code_engine_unknown', `engine must be one of ${ENGINE_LANGUAGES.join(', ')}`);
  if (typeof code !== 'string' || !code.trim()) return fail('code_empty', 'no program');
  if (Buffer.byteLength(code) > ENGINE_LIMITS.maxCodeBytes) return fail('code_too_long', `the program is longer than ${ENGINE_LIMITS.maxCodeBytes} bytes`);
  for (const [name, value] of Object.entries(inputs)) {
    if (!NAME.test(name)) return fail('code_bad_input', `input name ${name} must be lowercase letters, digits and _`);
    if (engine !== 'js' && engine !== 'sql' && typeof value !== 'number') return fail('code_bad_input', `input ${name} must be a number for ${engine}`);
  }
  for (const [re, what] of FORBIDDEN[engine]) if (re.test(code)) return fail('code_forbidden', `${engine} programs may not use ${what}`);
  return null;
}

/** A solver process: empty environment, own temp dir, address-space and CPU limits, killed at the wall-clock limit. */
function solver(command, args, {input = null, cwd, timeMs, memoryMb}) {
  const limited = PRLIMIT ? [PRLIMIT, [`--as=${memoryMb * 1024 * 1024}`, `--cpu=${Math.ceil(timeMs / 1000) + 1}`, '--', command, ...args]] : [command, args];
  const r = spawnSync(limited[0], limited[1], {input, cwd, encoding: 'utf8', timeout: timeMs, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, env: {LANG: 'C.UTF-8', HOME: cwd, TMPDIR: cwd, PATH: '/usr/bin:/bin'}});
  if (r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGKILL' || r.signal === 'SIGXCPU') return {timedOut: true, stdout: r.stdout ?? '', stderr: r.stderr ?? ''};
  if (r.error) return {error: r.error.message, stdout: '', stderr: ''};
  return {status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? ''};
}

const scalar = t => (typeof t === 'number' || typeof t === 'string' ? t : t?.tuple ? t.tuple.map(scalar) : t?.fn ? `${t.fn}(${t.args.map(scalar).join(',')})` : String(t));

// ------------------------------------------------------------------------------------------------ per engine

function runProlog(code, inputs, L, dir) {
  const facts = Object.entries(inputs).map(([k, v]) => `${k}(${v}).`).join('\n');
  fs.writeFileSync(path.join(dir, 'program.pl'), `${facts}\n${code}\n`);
  // The runner: the program is loaded in sandboxed mode (its directives must be safe) and answer/1 must pass safe_goal (every
  // predicate it can reach is a safe built-in or the program's own); the stacks are limited and the call has a time limit.
  const runner = `:- use_module(library(sandbox)).
:- use_module(library(http/json)).
:- set_prolog_flag(stack_limit, ${Math.min(L.memoryMb, 1024) * 1024 * 1024 / 2}).
out(X, X) :- (number(X) ; atom(X) ; string(X)), !.
out(X, S) :- term_to_atom(X, S).
main :- catch(( load_files('program.pl', [sandboxed(true)]),
                ( current_predicate(user:answer/1) -> true ; throw(no_answer_predicate) ),
                safe_goal(user:answer(_)),
                call_with_time_limit(${(L.timeMs / 1000 * 0.8).toFixed(2)}, findall(X, user:answer(X), Xs)),
                maplist(out, Xs, Os), json_write(current_output, json([ok= @(true), values=Os]), [width(0)]), nl ),
              E, ( message_to_codes(E, C), atom_codes(A, C), json_write(current_output, json([ok= @(false), error=A]), [width(0)]), nl )).
message_to_codes(E, C) :- catch(( message_to_codes(E, [], C0) -> C = C0 ; term_to_atom(E, A0), atom_codes(A0, C) ), _, ( term_to_atom(E, A1), atom_codes(A1, C) )).
`;
  fs.writeFileSync(path.join(dir, 'runner.pl'), runner);
  const r = solver(swiplCommand(), ['-q', '-f', 'none', '--no-packs', '--on-error=status', '-g', "consult('runner.pl')", '-g', 'main', '-t', 'halt'], {cwd: dir, timeMs: L.timeMs, memoryMb: L.memoryMb});
  if (r.timedOut) return fail('code_time_limit', `prolog ran longer than ${L.timeMs} ms`);
  const line = r.stdout.split('\n').filter(l => l.startsWith('{')).at(-1);
  if (!line) return fail('code_error', (r.stderr || r.stdout || 'no output').split('\n').slice(0, 4).join(' | '));
  const j = JSON.parse(line);
  if (!j.ok) return fail(/sandbox|No permission|unsafe/i.test(j.error) ? 'code_forbidden' : /time.?limit/i.test(j.error) ? 'code_time_limit' : /stack/i.test(j.error) ? 'code_memory_limit' : 'code_error', j.error);
  // A refused directive is reported by the sandboxed load and skipped; the program is refused as a whole, never run without it.
  if (/permission_error|No permission/i.test(r.stderr)) return fail('code_forbidden', r.stderr.split('\n').find(l => /permission/i.test(l)) ?? 'a directive was refused by the sandbox');
  return {ok: true, values: j.values};
}

function runAsp(code, inputs, L, dir) {
  const facts = Object.entries(inputs).map(([k, v]) => `${k}(${Number.isInteger(v) ? v : `"${v}"`}).`).join('\n');
  const optimize = /#\s*(?:minimi[sz]e|maximi[sz]e)\b|:~/.test(code);
  const text = `${facts}\n${code}\n#show answer/1.\n`;
  const r = solver(clingoCommand(), ['--outf=2', '-n', optimize ? '0' : '1', ...(optimize ? ['--opt-mode=opt'] : []), `--time-limit=${Math.max(1, Math.floor(L.timeMs / 1000) - 1)}`, '-'], {input: text, cwd: dir, timeMs: L.timeMs, memoryMb: L.memoryMb});
  if (r.timedOut) return fail('code_time_limit', `clingo ran longer than ${L.timeMs} ms`);
  let j;
  try { j = JSON.parse(r.stdout); } catch { return fail('code_error', (r.stderr || r.stdout || 'no output').split('\n').filter(Boolean).slice(0, 3).join(' | ')); }
  const err = (r.stderr ?? '').split('\n').find(l => /error:/i.test(l));
  if (err) return fail('code_error', err);
  if (j.Result === 'UNSATISFIABLE') return fail('code_unsat', 'the program has no answer set');
  if (j.Result === 'UNKNOWN') return fail('code_time_limit', 'clingo stopped before an answer');
  const witnesses = (j.Call ?? []).flatMap(c => c.Witnesses ?? []);
  if (optimize && j.Models?.Optimum !== 'yes') return fail('code_time_limit', 'the optimum was not proven');
  const w = witnesses.at(-1);
  return {ok: true, values: (w?.Value ?? []).map(parseAtom).filter(a => a.name === 'answer' && a.args.length >= 1).map(a => (a.args.length === 1 ? scalar(a.args[0]) : a.args.map(scalar)))};
}

/** Top-level s-expressions of an SMT-LIB script, as text. */
function topForms(text) {
  const out = [];
  let depth = 0, start = -1, inString = false, comment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (comment) { if (c === '\n') comment = false; continue; }
    if (inString) { if (c === '"') inString = false; continue; }
    if (c === ';') { comment = true; continue; }
    if (c === '"') { inString = true; continue; }
    if (c === '(') { if (depth++ === 0) start = i; }
    else if (c === ')') { if (--depth === 0) out.push(text.slice(start, i + 1)); if (depth < 0) return null; }
  }
  return depth === 0 ? out : null;
}

const smtNumber = x => {
  if (typeof x === 'string' && /^-?\d+(?:\.\d+)?$/.test(x)) return Number(x);
  if (Array.isArray(x) && x[0] === '-' && x.length === 2) { const v = smtNumber(x[1]); return v === null ? null : -v; }
  if (Array.isArray(x) && x[0] === '/' && x.length === 3) { const a = smtNumber(x[1]), b = smtNumber(x[2]); return a === null || b === null ? null : a / b; }
  return x === 'true' ? true : x === 'false' ? false : null;
};

function runSmt(code, inputs, L, dir) {
  const forms = topForms(code);
  if (!forms) return fail('code_error', 'the script has unbalanced parentheses');
  // The runner asks the question itself: the program's own check-sat, get-* and exit are left out, then check-sat and get-value of
  // its answer constants (answer, answer1, ...) are added.
  const kept = forms.filter(f => !/^\(\s*(?:check-sat|get-model|get-value|get-objectives|exit|echo|get-info|get-option|push|pop|reset)\b/.test(f));
  const answers = [...new Set(kept.map(f => /^\(\s*(?:declare-const|declare-fun|define-fun|define-const)\s+(answer\d*)\b/.exec(f)?.[1]).filter(Boolean))].sort();
  if (!answers.length) return fail('code_error', 'the script declares no answer constant (answer, answer1, ...)');
  const defs = Object.entries(inputs).map(([k, v]) => `(define-fun ${k} () ${Number.isInteger(v) ? 'Int' : 'Real'} ${Number.isInteger(v) ? (v < 0 ? `(- ${-v})` : v) : (v < 0 ? `(- ${(-v).toFixed(12)})` : v.toFixed(12))})`);
  const text = [...defs, ...kept, '(check-sat)', `(get-value (${answers.join(' ')}))`].join('\n') + '\n';
  const r = solver(z3Command(), ['-in', `-T:${Math.max(1, Math.floor(L.timeMs / 1000))}`, `-memory:${L.memoryMb}`], {input: text, cwd: dir, timeMs: L.timeMs + 1000, memoryMb: L.memoryMb + 256});
  if (r.timedOut) return fail('code_time_limit', `z3 ran longer than ${L.timeMs} ms`);
  const res = parseSexps(r.stdout);
  if (res[0] === 'unsat') return fail('code_unsat', 'the constraints have no solution');
  const error = res.find(x => Array.isArray(x) && x[0] === 'error');
  if (error) return fail('code_error', `z3: ${error.slice(1).join(' ')}`);
  if (res[0] !== 'sat') return fail(res[0] === 'timeout' || res[0] === 'unknown' ? 'code_time_limit' : 'code_error', `z3 answered ${JSON.stringify(res[0] ?? r.stderr).slice(0, 100)}`);
  const pairs = Array.isArray(res[1]) ? res[1] : [];
  const values = answers.map(a => smtNumber(pairs.find(p => p[0] === a)?.[1]));
  if (values.some(v => v === null)) return fail('code_error', 'an answer is not a number or a truth value');
  return {ok: true, values};
}

function runDatalog(code, inputs, L, dir) {
  const decls = Object.entries(inputs).map(([k, v]) => `.decl ${k}(x: ${Number.isInteger(v) ? 'number' : 'float'})\n${k}(${Number.isInteger(v) ? v : v.toFixed(12)}).`).join('\n');
  if (!/\.decl\s+answer\s*\(/.test(code)) return fail('code_error', 'the program declares no answer relation (.decl answer(...))');
  fs.writeFileSync(path.join(dir, 'program.dl'), `${decls}\n${code}\n.output answer\n`);
  const r = solver(souffleBinary(), ['-w', '-D', '-', '-j', '1', 'program.dl'], {cwd: dir, timeMs: L.timeMs, memoryMb: L.memoryMb});
  if (r.timedOut) return fail('code_time_limit', `souffle ran longer than ${L.timeMs} ms`);
  if (r.status !== 0) return fail('code_error', (r.stderr || r.stdout).split('\n').filter(Boolean).slice(0, 3).join(' | '));
  const block = r.stdout.split(/^=+$/m);
  if (block.length < 3) return fail('code_error', 'souffle printed no answer relation');
  const rows = block[1].split('\n').map(l => l.trim()).filter(Boolean).map(l => l.split('\t').map(x => (/^-?\d+(?:\.\d+)?(?:e-?\d+)?$/.test(x) ? Number(x) : x)));
  return {ok: true, values: rows.map(r => (r.length === 1 ? r[0] : r))};
}

// The SQL runner is a child process (a native SQLite loop cannot be interrupted inside a thread): it reads its job on stdin.
const SQL_CHILD = `
const {DatabaseSync} = require('node:sqlite');
let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  const {statements, inputs, maxOutputBytes} = JSON.parse(input);
  let out;
  try {
    const db = new DatabaseSync(':memory:', {allowExtension: false});
    db.exec('CREATE TABLE input(name TEXT PRIMARY KEY, value)');
    const ins = db.prepare('INSERT INTO input(name, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(inputs)) ins.run(k, v);
    for (const s of statements.slice(0, -1)) db.exec(s);
    db.exec('PRAGMA query_only = ON');
    const rows = db.prepare(statements.at(-1)).all();
    const values = rows.map(r => { const v = Object.values(r); return v.length === 1 ? v[0] : v; });
    const json = JSON.stringify(values);
    out = json.length > maxOutputBytes ? {ok: false, code: 'code_output_limit', message: 'the result is too large'} : {ok: true, values: JSON.parse(json)};
  } catch (error) { out = {ok: false, code: 'code_error', message: String(error && error.message || error).slice(0, 300)}; }
  process.stdout.write(JSON.stringify(out) + String.fromCharCode(10));
});
`;

/** SQL statements split at semicolons outside quotes and comments. */
function sqlStatements(code) {
  const out = [];
  let cur = '', q = null;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; cur += c; continue; }
    if (c === '-' && code[i + 1] === '-') { while (i < code.length && code[i] !== '\n') i++; cur += '\n'; continue; }
    if (c === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function runSql(code, inputs, L, dir) {
  const statements = sqlStatements(code);
  if (!statements.length || !/^\s*(?:select|with)\b/i.test(statements.at(-1))) return fail('code_error', 'the last statement must be the SELECT of the answer');
  const r = solver(process.execPath, ['--no-warnings', '--max-old-space-size=128', '-e', SQL_CHILD], {input: JSON.stringify({statements, inputs, maxOutputBytes: L.maxOutputBytes}), cwd: dir, timeMs: L.timeMs, memoryMb: Math.max(L.memoryMb, 4096)});
  if (r.timedOut) return fail('code_time_limit', `sql ran longer than ${L.timeMs} ms`);
  const line = r.stdout.split('\n').filter(l => l.startsWith('{')).at(-1);
  return line ? JSON.parse(line) : fail('code_crashed', (r.stderr || 'no output').split('\n').slice(0, 3).join(' | '));
}

/**
 * Runs `code` in `engine` on `inputs` ({name: value}); see the table above. A js program's returned value becomes `values` (an array
 * stays a list of answers, anything else is one answer).
 */
export async function runEngineCode(engine, code, inputs = {}, limits = {}) {
  const L = {...ENGINE_LIMITS, ...limits}, t0 = performance.now();
  const refused = check(engine, code, inputs);
  if (refused) return {...refused, engine, ms: 0};
  let r;
  if (engine === 'js') {
    const x = await runCode(code, inputs, {timeMs: Math.min(L.timeMs, CODE_LIMITS.timeMs * 5), maxOutputBytes: L.maxOutputBytes});
    r = x.ok ? {ok: true, values: Array.isArray(x.value) ? x.value : [x.value]} : x;
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `chatsop-code-${engine}-`));
    try { r = engine === 'prolog' ? runProlog(code, inputs, L, dir) : engine === 'asp' ? runAsp(code, inputs, L, dir) : engine === 'smt' ? runSmt(code, inputs, L, dir) : engine === 'sql' ? runSql(code, inputs, L, dir) : runDatalog(code, inputs, L, dir); }
    catch (error) { r = fail('code_error', error.message); }
    finally { fs.rmSync(dir, {recursive: true, force: true}); }
  }
  return {...r, engine, ms: Math.round(performance.now() - t0)};
}
