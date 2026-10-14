/**
 * clingo as a subprocess: the program goes in on stdin, the answer sets come back as JSON (`--outf=2`). Every call carries
 * `--time-limit` and a hard process timeout; a stop by either is reported as `interrupted`, which the strategy maps to
 * `budget_exhausted` with `reason wall`, never to an answer.
 *
 * The binary is private (tools/.solvers/clingo/bin/clingo, or CLINGO_BIN); nothing is installed.
 * Debugging aid: CLINGO_DUMP=1 prints every program to stderr before the call.
 */
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

const repoBin = fileURLToPath(new URL('../../../tools/.solvers/clingo/bin/clingo', import.meta.url));

export const clingoCommand = () => process.env.CLINGO_BIN || (fs.existsSync(repoBin) ? repoBin : 'clingo');

export function clingoVersion() {
  const r = spawnSync(clingoCommand(), ['--version'], {encoding: 'utf8', timeout: 5000});
  if (r.status !== 0 && r.status !== null) return null;
  if (r.error) return null;
  return /clingo version ([\d.]+)/.exec(r.stdout ?? '')?.[1] ?? null;
}

/** A solver stop that is not an answer. */
export class SolverStop extends Error {
  constructor(reason) { super(`solver stopped: ${reason}`); this.reason = reason; }
}

/**
 * Run a program. Options: `models` (0 = all), `optMode` (`opt` | `optN`), `timeoutMs`, `args`.
 * Returns {result: 'SAT' | 'UNSAT' | 'OPT', witnesses: [{atoms: [text], costs}], optimum: [costs] | null, interrupted: boolean}.
 */
export function runClingo(text, {models = 1, optMode = null, timeoutMs = 30000, args = []} = {}) {
  if (process.env.CLINGO_DUMP) process.stderr.write('--- clingo program ---\n' + text + '\n');
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const argv = ['--outf=2', '-n', String(optMode ? 0 : models), ...(optMode ? ['--opt-mode=' + optMode] : []), `--time-limit=${seconds}`, ...args, '-'];
  const r = spawnSync(clingoCommand(), argv, {input: text, encoding: 'utf8', timeout: timeoutMs + 3000, maxBuffer: 512 * 1024 * 1024});
  if (r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM') return {result: 'UNKNOWN', witnesses: [], optimum: null, interrupted: true};
  if (r.error) throw new Error('clingo could not run: ' + r.error.message);
  let j;
  try { j = JSON.parse(r.stdout); } catch { throw new Error('clingo gave no JSON answer: ' + (r.stderr || r.stdout).split('\n').slice(0, 6).join(' | ')); }
  const errors = (r.stderr ?? '').split('\n').filter(l => /error:/i.test(l));
  if (errors.length) throw new Error('clingo rejected the program: ' + errors[0]);
  const witnesses = (j.Call ?? []).flatMap(c => c.Witnesses ?? []).map(w => ({atoms: w.Value ?? [], costs: w.Costs ?? null}));
  // gringo's 32-bit arithmetic wraps silently; the lowering derives `ovf_arith` when an operation overflows
  if (witnesses.some(w => w.atoms.includes('ovf_arith'))) throw new SolverStop('numeric_range');
  const status = j.Result ?? 'UNKNOWN';
  const optimization = Array.isArray(j.Models?.Costs);
  const interrupted = status === 'UNKNOWN' || (optimization && j.Models.Optimum !== 'yes') || (!optMode && models === 0 && j.Models?.More === 'yes');
  const result = status === 'UNSATISFIABLE' ? 'UNSAT' : status === 'OPTIMUM FOUND' ? 'OPT' : status === 'SATISFIABLE' ? 'SAT' : 'UNKNOWN';
  return {result, witnesses, optimum: optimization ? j.Models.Costs : null, interrupted};
}

/**
 * Atom text of a model -> {name, args}. Arguments are integers, strings (clingo prints them quoted), tuples `(a,b)` as
 * `{tuple: [...]}` and function terms as `{fn, args}`.
 */
export function parseAtom(text) {
  const m = /^([A-Za-z_][A-Za-z0-9_']*)(?:\((.*)\))?$/s.exec(text);
  if (!m) throw new Error('unreadable atom ' + text);
  return {name: m[1], args: m[2] === undefined ? [] : termList(m[2])};
}

function termList(src) {
  const out = [];
  let i = 0;
  const term = () => {
    if (src[i] === '"') {
      let o = '';
      i++;
      while (src[i] !== '"') { if (src[i] === '\\') { i++; o += src[i] === 'n' ? '\n' : src[i]; } else o += src[i]; i++; }
      i++;
      return o;
    }
    if (src[i] === '(') { i++; const items = items_(')'); return {tuple: items}; }
    const m = /^-?\d+/.exec(src.slice(i));
    if (m) { i += m[0].length; return Number(m[0]); }
    const f = /^[A-Za-z_][A-Za-z0-9_']*/.exec(src.slice(i));
    if (!f) throw new Error('unreadable term ' + src.slice(i));
    i += f[0].length;
    if (src[i] === '(') { i++; return {fn: f[0], args: items_(')')}; }
    return f[0];
  };
  const items_ = close => {
    const list = [];
    while (i < src.length && src[i] !== close) {
      list.push(term());
      if (src[i] === ',') i++;
    }
    if (close) i++;
    return list;
  };
  const all = items_(null);
  out.push(...all);
  return out;
}
