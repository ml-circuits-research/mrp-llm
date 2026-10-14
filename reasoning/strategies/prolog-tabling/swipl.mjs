/**
 * The private SWI-Prolog subprocess of the prolog-tabling and golog-swi strategies. The binary is found through `SWIPL_BIN`, then
 * `tools/.solvers/swi/swipl` (the private 9.0.4 build), then `swipl` on the PATH. Nothing is installed.
 *
 * A run writes the generated program to a temporary file, starts `swipl` with a hard wall-clock timeout (a kill is the budget
 * reason `wall`) and parses the single JSON line the program prints. One process per solve (no persistent worker): the start-up
 * is about 60 ms, which the shadow runs pay once per closure.
 */
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');

export const swiplCommand = () => {
  if (process.env.SWIPL_BIN) return process.env.SWIPL_BIN;
  const priv = path.join(repo, 'tools/.solvers/swi/swipl');
  return fs.existsSync(priv) ? priv : 'swipl';
};

let cachedProbe = null;
export function probeSwipl() {
  if (cachedProbe) return cachedProbe;
  const command = swiplCommand();
  const r = spawnSync(command, ['--version'], {encoding: 'utf8', timeout: 5000});
  cachedProbe = r.status === 0
    ? {ok: true, version: (r.stdout || r.stderr).trim(), path: command}
    : {ok: false, reason: `swipl not available (SWIPL_BIN, tools/.solvers/swi/swipl or PATH): ${r.error?.message ?? r.stderr}`};
  return cachedProbe;
}

/**
 * Run Prolog source `text` and call `goal`; returns {ok, json} or {ok: false, timedOut, stderr}. `files` are consulted first
 * (absolute paths), so the generated text can rely on the runtime.
 */
export function runSwipl({text, goal, files = [], wallMs}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatsop-swipl-'));
  try {
    const file = path.join(dir, 'program.pl');
    fs.writeFileSync(file, text);
    const load = [...files, file].flatMap(f => ['-g', `consult('${f.replace(/'/g, "\\'")}')`]);
    const args = ['-q', '-f', 'none', ...load, '-g', goal, '-t', 'halt'];
    const r = spawnSync(swiplCommand(), args, {encoding: 'utf8', timeout: wallMs, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 * 1024, env: {...process.env, LANG: 'C.UTF-8'}});
    if (r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM') return {ok: false, timedOut: true, stderr: r.stderr ?? ''};
    if (r.error) return {ok: false, stderr: r.error.message};
    const line = (r.stdout ?? '').split('\n').filter(l => l.startsWith('{')).at(-1);
    if (!line) return {ok: false, stderr: (r.stderr || r.stdout || 'no output').slice(0, 2000)};
    return {ok: true, json: JSON.parse(line), stderr: r.stderr ?? ''};
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}
