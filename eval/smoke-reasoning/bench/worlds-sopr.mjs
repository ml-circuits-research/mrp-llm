/**
 * Measures `worlds-sopr` on many what-if worlds over a growing base (proposal 7, backlog N06): the cost of the first query (base
 * saturation), of an addition world, of a retraction world and of a `set` world, against the oracle that recomputes every world.
 * Run: node eval/smoke-reasoning/bench/worlds-sopr.mjs  -> eval/reports/current/worlds-sopr/bench.json
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {worldsSopr} from '../../../reasoning/strategies/worlds-sopr/index.mjs';
import {jsReference} from '../../../reasoning/strategies/js-reference/index.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const zones = 20;
const DECL = `@is_a predicate\n  args subject:entity object:entity\n@in_zone predicate\n  args subject:entity location:entity\n@load predicate\n  args subject:entity object:integer\n  key 1\n@capacity predicate\n  args subject:entity object:integer\n  key 1\n@backup predicate\n  args subject:entity\n  closed true\n@located_in predicate\n  args subject:entity object:entity\n@overloaded predicate\n  args subject:entity\n@alert predicate\n  args subject:entity\n  closed true\n@busy_zone predicate\n  args subject:entity\n@hotspot predicate\n  args subject:entity\n`;
const RULES = `@r_over rule\n  when load ?e ?l\n  when capacity ?e ?c\n  when compare ?l above ?c\n  then overloaded ?e\n@r_alert rule\n  when overloaded ?e\n  when absent backup ?e\n  then alert ?e\n@r_busy rule\n  when in_zone ?e ?z\n  when alert ?e\n  then busy_zone ?z\n@r_hot rule\n  when located_in ?z ?s\n  when busy_zone ?z\n  then hotspot ?s\n`;
function facts(N) {
  const f = [];
  for (let e = 0; e < N; e++) {
    f.push(['in_zone', `e${e}`, `z${e % zones}`], ['load', `e${e}`, 20 + (e * 7) % 60], ['capacity', `e${e}`, 30 + (e * 11) % 40]);
    if (e % 9 === 0) f.push(['backup', `e${e}`]);
  }
  for (let z = 0; z < zones; z++) f.push(['located_in', `z${z}`, `s${z % 4}`]);
  return f;
}
const render = f => DECL + f.map((x, i) => `@f${i} fact\n  holds ${x.join(' ')}`).join('\n') + '\n' + RULES;
const Q = '@q query\n  where hotspot ?s\n  select ?s\n';
const median = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const ms = f => { const t = performance.now(); const out = f(); return {ms: performance.now() - t, out}; };

const rows = [];
for (const N of [200, 1000, 4000]) {
  const base = facts(N);
  const text = render(base);
  const t0 = performance.now();
  const handle = worldsSopr.prepare(text);
  const prepareMs = performance.now() - t0;
  const first = ms(() => worldsSopr.ask({handle, query: Q}));
  const per = kind => {
    const worlds = Array.from({length: 40}, (_, i) => {
      const e = `e${(i * 37) % N}`;
      if (kind === 'add') return {add: [`load n${i} 95`, `capacity n${i} 10`, `in_zone n${i} z${i % zones}`]};
      if (kind === 'remove') return {remove: [`backup e${(i * 9) % N - ((i * 9) % N) % 9}`]};
      return {set: [`load ${e} 95`]};
    });
    const times = worlds.map(w => ms(() => worldsSopr.ask({world: worldsSopr.fork(handle, w), query: Q})).ms);
    const batch = ms(() => worldsSopr.askMany(handle, worlds, Q));
    return {per_world_ms: +median(times).toFixed(2), batch_per_world_ms: +(batch.ms / worlds.length).toFixed(2), batch_continuations: batch.out.stats.incrementalContinuations};
  };
  const row = {entities: N, facts: base.length, prepare_ms: +prepareMs.toFixed(1), first_query_ms: +first.ms.toFixed(1), add: per('add'), remove: per('remove'), set: per('set')};
  if (N <= 1000) {
    const o = [0, 1, 2].map(i => ms(() => jsReference.ask({theory: {knowledge: render([...base, ['load', `n${i}`, 95], ['capacity', `n${i}`, 10], ['in_zone', `n${i}`, `z${i}`]])}, query: Q})));
    row.oracle_per_world_ms = +median(o.map(x => x.ms)).toFixed(1);
    row.oracle_complete = o.every(x => x.out.complete !== false);
  }
  rows.push(row);
  console.log(JSON.stringify(row));
}
const outDir = path.join(repo, 'eval/reports/current/worlds-sopr');
fs.mkdirSync(outDir, {recursive: true});
fs.writeFileSync(path.join(outDir, 'bench.json'), JSON.stringify({generated: new Date().toISOString(), note: 'Regenerable observation (eval/smoke-reasoning/bench/worlds-sopr.mjs). per_world_ms: one world per engine call (median of 40); batch_per_world_ms: 40 sibling worlds in one call. The oracle recomputes every world from scratch.', rows}, null, 2) + '\n');
