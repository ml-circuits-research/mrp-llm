#!/usr/bin/env node
/**
 * The regression gate of a learned-rules change (AGENTS.md "Formalization improvement"): a candidate change of the learned layer
 * (config/knowledge/formalizer-learned-v1) is admitted only if it fixes cases and loses none, measured on tier `tiny`.
 *   node tools/eval/formalization/regression/gate.mjs check --wires FILE --cases id,id [--tag T] [--admit] [--note "..."]
 *   node tools/eval/formalization/regression/gate.mjs set-current RUN_ID       a full run becomes the baseline
 *   node tools/eval/formalization/regression/gate.mjs show                     the current baseline (runs, counts)
 * Stages (each a child process of run.mjs, so a large heap does not burden the caller):
 *   1. the target cases (the cluster's failures) with the candidate: no case fixed → rejected;
 *   2. every case the baseline answers correctly: a case lost there is a loss;
 *   3. the lost and the fixed cases once more (tiny is served with parallel slots and is not bit-reproducible): a loss that
 *      recovers is noise, a fix that does not repeat is not counted.
 * Targets are cases that failed in every baseline run, the guard is cases correct in every baseline run (`stability`); flaky cases
 * neither count as fixes nor block a change.
 * Admitted: the wires are appended to the learned layer with a comment naming the gate, and the stage runs join the baseline
 * (state/formalization-regression/current.json: a list of runs, a later run's result of a case overrides an earlier one).
 */
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {STATE, ROOT} from './cases.mjs';
import {clusterOf} from './run.mjs';
import {LEARNED_LAYER} from '../../../../lib/formalize/protocol-data.mjs';
import {SEEDS_DIR} from '../../../../lib/knowledge-seeds.mjs';

export const CURRENT = path.join(STATE, 'current.json');
export const LEARNED_DIR = path.join(SEEDS_DIR, LEARNED_LAYER);
const RUNNER = fileURLToPath(new URL('./run.mjs', import.meta.url));
const readJsonl = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

export const currentBaseline = () => fs.existsSync(CURRENT) ? JSON.parse(fs.readFileSync(CURRENT, 'utf8')) : null;
export function setCurrent(runs, extra = {}) {
  fs.mkdirSync(STATE, {recursive: true});
  fs.writeFileSync(CURRENT, JSON.stringify({runs, updated: new Date().toISOString(), ...extra}, null, 1) + '\n');
}

/** The baseline results: a later run's result of a case overrides an earlier one. */
export function baselineResults(baseline = currentBaseline()) {
  const out = new Map();
  // Clusters are recomputed with the current rules (clusterOf), so a refined clustering applies to older runs too.
  for (const run of baseline?.runs ?? []) for (const r of readJsonl(path.join(STATE, run, 'results.jsonl'))) out.set(r.id, {...r, cluster: clusterOf(r)});
  return out;
}

/** One regression run in a child process; returns its score.json and results. */
export function runStage({ids, runId, learned, concurrency = 4, log = () => {}}) {
  const args = ['--max-old-space-size=16000', RUNNER, '--ids', ids.join(','), '--run-id', runId, '--concurrency', String(concurrency), ...(learned ? ['--learned', learned] : [])];
  log(`stage ${runId}: ${ids.length} case(s)`);
  const r = spawnSync(process.execPath, args, {cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']});
  if (r.status !== 0) throw new Error(`regression run ${runId} failed (${r.status}): ${(r.stderr || '').split('\n').filter(l => !/^\[\d+\/\d+\]/.test(l)).slice(-6).join(' | ')}`);
  return {score: JSON.parse(fs.readFileSync(path.join(STATE, runId, 'score.json'), 'utf8')), results: new Map(readJsonl(path.join(STATE, runId, 'results.jsonl')).map(x => [x.id, x]))};
}

/** The candidate learned layer: the shipped learned files plus the proposal as the last file. */
export function candidateDir(tag, wires) {
  const dir = path.join(STATE, 'candidates', tag);
  fs.rmSync(dir, {recursive: true, force: true});
  fs.mkdirSync(dir, {recursive: true});
  for (const f of fs.existsSync(LEARNED_DIR) ? fs.readdirSync(LEARNED_DIR).filter(n => n.endsWith('.sop')) : []) fs.copyFileSync(path.join(LEARNED_DIR, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, '9999-candidate.sop'), wires.trim() + '\n');
  return dir;
}

/** Appends admitted wires to the learned layer (the last .sop file of the layer) with a comment line naming the gate. */
export function admitWires(wires, note) {
  const files = fs.readdirSync(LEARNED_DIR).filter(n => n.endsWith('.sop')).sort();
  const file = path.join(LEARNED_DIR, files.at(-1) ?? '0001-learned.sop');
  fs.appendFileSync(file, `\n# ${note}\n${wires.trim()}\n`);
  return path.relative(ROOT, file);
}

const correct = r => r?.outcome === 'correct';

/**
 * Stability of each case over every run of the baseline: tiny is served with parallel slots and the same prompt can get a different
 * answer (2026-10-02: 66 of 122 dialogs differed between two runs of byte-identical prompts, 6 outcomes flipped). A case is
 * `correct` when every run answered it correctly, `failing` when none did, `flaky` otherwise.
 */
export function stability(baseline = currentBaseline()) {
  const seen = new Map();
  for (const run of baseline?.runs ?? []) for (const r of readJsonl(path.join(STATE, run, 'results.jsonl'))) (seen.get(r.id) ?? seen.set(r.id, []).get(r.id)).push(correct(r));
  return new Map([...seen].map(([id, v]) => [id, v.every(Boolean) ? 'correct' : v.some(Boolean) ? 'flaky' : 'failing']));
}

/**
 * Runs the gate for `wires` (SOP text of the change) on the `cases` it should fix. Returns
 * {admitted, reason, fixed, lost, noise, stages, tag}. With `admit`, an admitted change is written and the baseline extended.
 */
export function gate({wires, cases, tag = `gate-${stamp()}`, admit = false, note = '', concurrency = 4, log = m => console.error(m)}) {
  const baseline = currentBaseline();
  if (!baseline) throw new Error('no baseline: run the full set and `gate.mjs set-current RUN_ID` first');
    const learned = candidateDir(tag, wires);
  const stable = stability(baseline);
  const targets = cases.filter(id => stable.get(id) === 'failing');
  if (!targets.length) return {admitted: false, reason: 'no target case fails in the baseline', fixed: [], lost: [], tag};
  const s1 = runStage({ids: targets, runId: `${tag}-s1`, learned, concurrency, log});
  const fixed1 = targets.filter(id => correct(s1.results.get(id)));
  if (!fixed1.length) return {admitted: false, reason: `fixes none of ${targets.length} target case(s)`, fixed: [], lost: [], tag, stages: {s1: s1.score}, target_outcomes: Object.fromEntries(targets.map(id => [id, s1.results.get(id)?.outcome ?? null]))};
  // The guard is every case the baseline answers correctly in every run; flaky cases are run (stage 2) but cannot block a change.
  const guard = [...stable].filter(([, v]) => v === 'correct').map(([id]) => id);
  const flaky = [...stable].filter(([, v]) => v === 'flaky').map(([id]) => id);
  const s2 = guard.length ? runStage({ids: guard, runId: `${tag}-s2`, learned, concurrency, log}) : {score: null, results: new Map()};
  const lost2 = guard.filter(id => !correct(s2.results.get(id)));
  const again = [...new Set([...lost2, ...fixed1])];
  const s3 = runStage({ids: again, runId: `${tag}-s3`, learned, concurrency, log});
  const lost = lost2.filter(id => !correct(s3.results.get(id)));
  const fixed = fixed1.filter(id => correct(s3.results.get(id)));
  const noise = {losses_recovered: lost2.filter(id => !lost.includes(id)), fixes_not_repeated: fixed1.filter(id => !fixed.includes(id))};
  const admitted = fixed.length > 0 && lost.length === 0;
  const verdict = {admitted, guard: guard.length, flaky: flaky.length, reason: admitted ? `fixed ${fixed.length}, lost 0` : lost.length ? `loses ${lost.length} case(s)` : 'no fix repeated on the second run', fixed, lost, noise, tag,
    stages: {s1: s1.score, s2: s2.score, s3: s3.score}};
  if (admitted && admit) {
    if (wires.trim()) verdict.file = admitWires(wires, `admitted ${new Date().toISOString().slice(0, 10)} by the regression gate ${tag}${note ? ` (${note})` : ''}: fixed ${fixed.join(', ')}; lost none`);
    setCurrent([...baseline.runs, `${tag}-s1`, ...(guard.length ? [`${tag}-s2`] : []), `${tag}-s3`], {admitted: [...(baseline.admitted ?? []), tag]});
  }
  fs.writeFileSync(path.join(STATE, 'candidates', tag, 'verdict.json'), JSON.stringify(verdict, null, 1) + '\n');
  return verdict;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  const opt = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
  if (cmd === 'set-current') { setCurrent([args[0]]); console.log(JSON.stringify(currentBaseline())); }
  else if (cmd === 'show') {
    const b = currentBaseline(), res = [...baselineResults(b).values()];
    const counts = {};
    for (const r of res) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
    console.log(JSON.stringify({...b, cases: res.length, ...counts}));
  } else if (cmd === 'check') {
    const wires = fs.readFileSync(path.resolve(opt('--wires')), 'utf8');
    console.log(JSON.stringify(gate({wires, cases: opt('--cases', '').split(',').filter(Boolean), tag: opt('--tag') ?? undefined, admit: args.includes('--admit'), note: opt('--note', '')}), null, 1));
  } else { console.error('usage: gate.mjs check --wires FILE --cases a,b [--tag T] [--admit] | set-current RUN | show'); process.exit(2); }
}
