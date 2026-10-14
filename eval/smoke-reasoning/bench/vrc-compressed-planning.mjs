/**
 * Re-measures VRC's three planning worlds through the product strategy (inventory V09): the energy world (25 coordinates), the
 * product world (21) and the guard-rich control, full exact search against the certified compressed search, warm (search only) and cold
 * (learning counted). Plans are replayed in the original laws; both searches must agree on status and depth.
 * Run: node eval/smoke-reasoning/bench/vrc-compressed-planning.mjs -> eval/reports/current/vrc-compressed-planning/bench.json
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {vrcCompressedPlanning as vrc} from '../../../reasoning/strategies/vrc-compressed-planning/index.mjs';
import {energyWorld, productWorld, guardRichControl} from './vrc-worlds.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const median = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const ms = f => { const t = performance.now(); const out = f(); return {ms: performance.now() - t, out}; };

const worlds = [
  {name: 'energy world (12 pairs, target 19x the best increment + 1, horizon 28)', w: energyWorld(), claim: 'VRC: 25 to 5 coordinates, 39.5x warm'},
  {name: 'product world, closure to depth 10 (10 pairs, goal unreachable)', w: (() => { const w = productWorld({horizon: 10, target: 1e15}); return w; })(), claim: 'VRC: 144,799 to 264 states, 1,719.7x warm'},
  {name: 'guard-rich control, closure to depth 10', w: guardRichControl({goal: 1000000, horizon: 10}), claim: 'VRC: 111 to 111 states, 0.96x warm, 0.17x cold (a loss)'}
];
const rows = [];
for (const {name, w, claim} of worlds) {
  const t0 = performance.now();
  const handle = vrc.prepare(w.knowledge, {learning: 'on-demand', query: w.query, learn: {maxLatent: 8, maxMilliseconds: 20000}});
  const prepareMs = performance.now() - t0;
  const full = [], red = [];
  let a, b;
  for (let i = 0; i < 3; i++) {
    const runFull = () => { a = vrc.ask({theory: {knowledge: w.knowledge}, query: w.query}, {timeoutMs: 120000}); full.push(a.timings.search); };
    const runRed = () => { b = vrc.ask({handle, query: w.query}, {timeoutMs: 120000}); red.push(b.timings.search); };
    if (i % 2) { runRed(); runFull(); } else { runFull(); runRed(); }
  }
  const agree = a.status === b.status && (a.plan?.steps ?? null) === (b.plan?.steps ?? null);
  const row = {
    world: name, vrc_claim: claim, state_coordinates: {full: b.stats.fullDimension, certified: b.stats.dimension}, cache: handle.cacheStatus,
    unique_states: {full: a.stats.unique, compressed: b.stats.unique, reduction: +(a.stats.unique / b.stats.unique).toFixed(1)},
    status: {full: a.status, compressed: b.status, plan_steps: b.plan?.steps ?? null, agree},
    search_ms: {full: +median(full).toFixed(2), compressed: +median(red).toFixed(2)},
    warm_speedup: +(median(full) / median(red)).toFixed(2),
    learning_ms: handle.timings.learn ?? null, prepare_ms: +prepareMs.toFixed(1),
    cold_speedup: +((median(full)) / (median(red) + prepareMs)).toFixed(2)
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}
const outDir = path.join(repo, 'eval/reports/current/vrc-compressed-planning');
fs.mkdirSync(outDir, {recursive: true});
fs.writeFileSync(path.join(outDir, 'bench.json'), JSON.stringify({generated: new Date().toISOString(), node: process.version, note: 'Regenerable observation (eval/smoke-reasoning/bench/vrc-compressed-planning.mjs). Exact rational arithmetic; median of three interleaved runs; cold counts learning and certification. The energy encoder is q plus four sums of squares: the world was generated with that symmetry, so this is reuse of a designed structure, not transfer to an external benchmark.', rows}, null, 2) + '\n');
