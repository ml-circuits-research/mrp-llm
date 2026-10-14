/**
 * Measures the native closure template on reach cases (proposal 10.2, backlog N04/N18): the shapes of VRC's benchmark (chain, tree, cycle,
 * layered, disconnected) with a bound start, plus two controls where the template must not fire. Compared with the oracle (`js-oracle`,
 * naive bottom-up: it materialises the whole closure) and with the wired Datalog engines when present (their time includes the
 * lowering and the engine call, so it is the cost a caller sees). Warm = prepared handle, median of repeated asks; cold = one call.
 * Run: node eval/smoke-reasoning/bench/closure-template.mjs  -> eval/reports/current/closure-template/bench.json
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {closureTemplate} from '../../../reasoning/strategies/closure-template/index.mjs';
import {jsReference} from '../../../reasoning/strategies/js-reference/index.mjs';
import {adapters} from '../adapters/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const PRED = '@edge predicate\n  args source:entity destination:entity\n@reaches predicate\n  args source:entity destination:entity\n';
const RULES = '@r_base rule\n  when edge ?x ?y\n  then reaches ?x ?y\n@r_step rule\n  when edge ?x ?m\n  when reaches ?m ?y\n  then reaches ?x ?y\n';
const kb = edges => PRED + edges.map(([a, b], i) => `@e${i} fact\n  holds edge ${a} ${b}`).join('\n') + '\n' + RULES;

const graphs = {
  chain: n => Array.from({length: n}, (_, i) => [`n${i}`, `n${i + 1}`]),
  tree: depth => { const e = []; for (let i = 0; i < 2 ** depth - 1; i++) e.push([`n${i}`, `n${2 * i + 1}`], [`n${i}`, `n${2 * i + 2}`]); return e; },
  cycle: n => Array.from({length: n}, (_, i) => [`n${i}`, `n${(i + 1) % n}`]),
  layered: (layers, width) => { const e = []; for (let l = 0; l < layers - 1; l++) for (let a = 0; a < width; a++) for (let b = 0; b < width; b += 3) e.push([`l${l}_${a}`, `l${l + 1}_${(a + b) % width}`]); return e; },
  disconnected: comps => Array.from({length: comps}, (_, c) => [[`c${c}_0`, `c${c}_1`], [`c${c}_1`, `c${c}_2`]]).flat()
};
const start = {chain: 'n0', tree: 'n0', cycle: 'n0', layered: 'l0_0', disconnected: 'c0_0'};
const median = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const timeAsync = async (f) => { const t0 = performance.now(); const out = await f(); return {ms: performance.now() - t0, out}; };
const time = (f, reps = 1) => { const t = []; let out; for (let i = 0; i < reps; i++) { const t0 = performance.now(); out = f(); t.push(performance.now() - t0); } return {ms: median(t), out}; };
const q = s => `@q query\n  where reaches ${s} ?t\n  select ?t\n`;

const cases = [['chain', 40], ['tree', 6], ['cycle', 30], ['layered', 6, 12], ['disconnected', 60], ['chain', 80], ['cycle', 60]];
const rows = [];
const wired = adapters.filter(a => ['datalog-e10', 'datalog-soplab', 'datalog-souffle'].includes(a.id) && a.status === 'available');
for (const [kind, ...args] of cases) {
  await 0;
  const edges = graphs[kind](...args), k = kb(edges), query = q(start[kind]);
  const oracle = time(() => jsReference.ask({theory: {knowledge: k}, query}), 1);
  if (!oracle.out.rows) oracle.out.rows = [];
  const cold = time(() => closureTemplate.ask({theory: {knowledge: k}, query}), 1);
  const handle = closureTemplate.prepare(k);
  const warm = time(() => closureTemplate.ask({handle, query}), 30);
  const row = {graph: `${kind}(${args.join(',')})`, edges: edges.length, rows: warm.out.rows.length, oracle_rows: oracle.out.rows.length, oracle_complete: oracle.out.complete, same_rows: JSON.stringify(oracle.out.rows.map(r => r.t).sort()) === JSON.stringify(warm.out.rows.map(r => r.t).sort()),
    oracle: {ms: +oracle.ms.toFixed(2), probes: oracle.out.budget.used.maxJoins}, template: {cold_ms: +cold.ms.toFixed(3), warm_ms: +warm.ms.toFixed(3), edge_visits: warm.out.budget.used.maxJoins},
    speedup_vs_oracle: {cold: +(oracle.ms / cold.ms).toFixed(1), warm: +(oracle.ms / warm.ms).toFixed(1)}, engines: {}};
  for (const a of wired) {
    try {
      const r = await timeAsync(() => a.run({knowledge: k, query}, {}));
      row.engines[a.id] = {ms: +r.ms.toFixed(2), rows: r.out?.rows?.length ?? null, complete: r.out?.complete ?? null, note: 'wall of the adapter call, includes lowering'};
    } catch (e) { row.engines[a.id] = {error: String(e.message).slice(0, 80)}; }
  }
  rows.push(row);
  console.log(row.graph.padEnd(20), `edges ${row.edges}`.padEnd(11), `rows ${row.rows}`.padEnd(9), `oracle ${row.oracle.ms} ms (${row.oracle.probes} probes)`.padEnd(38), `template ${row.template.warm_ms} ms warm, ${row.template.cold_ms} cold (${row.template.edge_visits} edge visits)`.padEnd(60), `x${row.speedup_vs_oracle.warm} warm, x${row.speedup_vs_oracle.cold} cold`, row.oracle_complete === false ? '(oracle stopped at its probe ceiling: ratio is a lower bound)' : (row.same_rows ? '' : 'ROWS DIFFER'), Object.entries(row.engines).map(([k, v]) => `${k} ${v.ms ?? v.error} ms`).join(', '));
}
// controls: the template must decline and the caller falls back to the oracle (ratio 1.0 by routing, not by speed)
const controls = [];
{
  const k = kb(graphs.chain(40)), unbound = '@q query\n  where reaches ?x ?y\n  select ?x ?y\n';
  let declined = false;
  try { closureTemplate.ask({theory: {knowledge: k}, query: unbound}); } catch { declined = true; }
  controls.push({control: 'both arguments free (all pairs)', template_declines: declined, note: 'the closure is the answer, a BFS per node would not beat the rules'});
  const k2 = k.replace('  when edge ?x ?m\n  when reaches ?m ?y\n', '  when edge ?x ?m\n  when reaches ?m ?y\n  when edge ?y ?y\n');
  let declined2 = false;
  try { closureTemplate.ask({theory: {knowledge: k2}, query: q('n0')}); } catch { declined2 = true; }
  controls.push({control: 'step rule with a third condition (not a pure closure)', template_declines: declined2});
}
console.log(controls.map(c => `control: ${c.control}: template declines = ${c.template_declines}`).join('\n'));
const outDir = path.join(repo, 'eval/reports/current/closure-template');
fs.mkdirSync(outDir, {recursive: true});
fs.writeFileSync(path.join(outDir, 'bench.json'), JSON.stringify({generated: new Date().toISOString(), note: 'Regenerable observation (eval/smoke-reasoning/bench/closure-template.mjs). The oracle is deliberately naive: it materialises the whole closure, so the ratios compare query-directed search with broad bottom-up evaluation, not two graph algorithms (inventory V03).', rows, controls}, null, 2) + '\n');
console.log('report: eval/reports/current/closure-template/bench.json');
