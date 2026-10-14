/**
 * Running Soufflé: a temporary directory with the `.dl` program and the `.facts` TSV files, one subprocess with a wall-clock timeout,
 * the output relations read back (tab-separated, decoded by column type).
 *
 * Interpreter mode (default) runs the `.dl` directly. Compile mode generates C++ and builds a binary with the private g++ the first
 * time a program text is seen and keeps it in a cache keyed by the SHA-256 of the program text (the facts are not part of the key, so
 * the same program over new facts reuses the binary): worthwhile for repeated queries over the same rules, not for a single one.
 * A timeout kills the subprocess and is reported as `timedOut`; there are no partial results, so the caller answers
 * `budget_exhausted` (reason `wall`).
 */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {decodeSymbol} from './lower.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PRIVATE = path.join(repo, 'tools/.solvers/souffle/souffle');

/** The Soufflé executable: SOUFFLE_BIN, else the private build under tools/.solvers, else `souffle` on the PATH. */
export function souffleBinary() {
  return process.env.SOUFFLE_BIN || (fs.existsSync(PRIVATE) ? PRIVATE : 'souffle');
}

let probed = null;
/** {ok, version, path} or {ok: false, reason}; probed once per process. */
export function probeSouffle() {
  if (probed) return probed;
  const command = souffleBinary();
  const r = spawnSync(command, ['--version'], {encoding: 'utf8', timeout: 8000});
  if (r.status !== 0) return (probed = {ok: false, reason: `souffle binary not available (SOUFFLE_BIN or tools/.solvers/souffle)`, path: command});
  const version = ((r.stdout || '') + (r.stderr || '')).split('\n').map(l => l.trim()).find(l => /version/i.test(l)) ?? '';
  return (probed = {ok: true, version, path: command});
}

/**
 * The private build's compile script points at a source tree that was removed after the build; its headers were kept under
 * `install/include`. g++ finds them through CPLUS_INCLUDE_PATH, which is the only thing compile mode needs (nothing is installed).
 */
function compileEnv(bin) {
  const include = path.join(path.dirname(path.resolve(bin)), 'install/include');
  const env = {...process.env};
  if (fs.existsSync(path.join(include, 'souffle', 'CompiledSouffle.h'))) env.CPLUS_INCLUDE_PATH = [include, process.env.CPLUS_INCLUDE_PATH].filter(Boolean).join(':');
  return env;
}

const cacheRoot = () => process.env.CHATSOP_SOUFFLE_CACHE || path.join(os.tmpdir(), 'chatsop-souffle-cache');
const sha = text => createHash('sha256').update(text).digest('hex');

function readRelation(file, cols) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  if (!cols.length) return text.trim() ? [[]] : [];
  const rows = [];
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    if (end > start) {
      const parts = text.slice(start, end).split('\t');
      rows.push(parts.map((v, i) => (cols[i] === 'number' ? Number(v) : decodeSymbol(v))));
    }
    start = end + 1;
  }
  return rows;
}

/**
 * Run a lowered program. `mode` is 'interpret' or 'compile'; `magic` is a relation list for `-m` (or null); `timeoutMs` the wall limit.
 * Returns {tables, overflow, timedOut, timings, compiled}; throws on a Soufflé error (a bug in the lowering, never a user error).
 */
export function runSouffle({lowered, mode = 'interpret', magic = null, timeoutMs = 30_000, compileTimeoutMs = 180_000}) {
  const t0 = performance.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatsop-souffle-'));
  const factDir = path.join(dir, 'facts'), outDir = path.join(dir, 'out');
  fs.mkdirSync(factDir); fs.mkdirSync(outDir);
  try {
    for (const [name, text] of lowered.files) fs.writeFileSync(path.join(factDir, name), text);
    const dlFile = path.join(dir, 'program.dl');
    fs.writeFileSync(dlFile, lowered.dl);
    const bin = souffleBinary();
    const magicArgs = magic?.length ? [`--magic-transform=${magic.join(',')}`] : [];
    const t1 = performance.now();
    let r, compiled = false, compileMs = 0;
    if (mode === 'compile') {
      const key = sha(`${probeSouffle().version}\n${lowered.dl}\n#magic ${(magic ?? []).join(',')}`);
      const cacheDir = path.join(cacheRoot(), key);
      const exe = path.join(cacheDir, 'program');
      if (!fs.existsSync(exe)) {
        fs.mkdirSync(cacheDir, {recursive: true});
        const c0 = performance.now();
        const tmpExe = `${exe}.${process.pid}.tmp`;
        const built = spawnSync(bin, ['-w', ...magicArgs, '-o', tmpExe, dlFile], {encoding: 'utf8', timeout: compileTimeoutMs, maxBuffer: 1 << 26, env: compileEnv(bin)});
        if (built.status !== 0 || !fs.existsSync(tmpExe)) throw new Error('souffle compile failed: ' + (built.stderr || built.error?.message || '').slice(0, 800));
        fs.renameSync(tmpExe, exe);
        fs.rmSync(`${tmpExe}.cpp`, {force: true});
        compileMs = performance.now() - c0;
        compiled = true;
      }
      r = spawnSync(exe, ['-F', factDir, '-D', outDir], {encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1 << 26});
    } else {
      r = spawnSync(bin, ['-w', ...magicArgs, '-F', factDir, '-D', outDir, dlFile], {encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1 << 26});
    }
    const t2 = performance.now();
    if (r.error?.code === 'ETIMEDOUT' || (r.signal === 'SIGTERM' && r.status === null)) return {tables: new Map(), overflow: false, timedOut: true, timings: {write: ms(t0, t1), run: ms(t1, t2)}, compiled};
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`souffle exited with ${r.status}: ${(r.stderr || '').slice(0, 1200)}`);
    const tables = new Map();
    for (const o of lowered.outputs) tables.set(o.key, readRelation(path.join(outDir, o.rel + '.csv'), o.cols));
    const overflow = lowered.overflowGuard && readRelation(path.join(outDir, 'x_ovf.csv'), ['symbol']).length > 0;
    return {tables, overflow, timedOut: false, compiled, timings: {write: ms(t0, t1), run: ms(t1, t2), compile: Math.round(compileMs), read: ms(t2, performance.now())}};
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

const ms = (a, b) => Math.round(b - a);
