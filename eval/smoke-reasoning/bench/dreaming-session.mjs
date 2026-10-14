/**
 * Measures the dreaming wrapper on a repeated query family (proposal 5.6, backlog N01): probes (the oracle's own unit) and wall clock
 * of the plain run against the frozen deployment plan, the cost of the dream pass, the break-even number of queries, and a control
 * where there is nothing to learn (the wrapper then only adds overhead). E10 found probe gains far larger than wall gains; so does this.
 * Run: node eval/smoke-reasoning/bench/dreaming-session.mjs  -> eval/reports/current/dreaming-session/bench.json
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {dreamingSession} from '../../../reasoning/strategies/dreaming-session/index.mjs';
import {jsReference} from '../../../reasoning/strategies/js-reference/index.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const median = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const timed = (f, reps) => { const t = []; let out; for (let i = 0; i < reps; i++) { const t0 = performance.now(); out = f(); t.push(performance.now() - t0); } return {ms: median(t), out}; };

const pred = '@a predicate\n  args subject:entity object:entity\n@b predicate\n  args subject:entity object:entity\n@c predicate\n  args subject:entity\n@hit predicate\n  args subject:entity object:entity\n';
function family(n, rule) {
  let k = pred;
  for (let i = 0; i < n; i++) k += `@fa${i} fact\n  holds a n${i} m${i % 30}\n@fb${i} fact\n  holds b m${i % 30} o${i}\n`;
  for (let i = 0; i < 3; i++) k += `@fc${i} fact\n  holds c n${i}\n`;
  return k + rule;
}
const BAD = '@r_hit rule\n  when a ?x ?y\n  when b ?y ?z\n  when c ?x\n  then hit ?x ?z\n';
const GOOD = '@r_hit rule\n  when c ?x\n  when a ?x ?y\n  when b ?y ?z\n  then hit ?x ?z\n';
const q = c => `@q query\n  where hit ${c} ?z\n  select ?z\n`;

const rows = [];
for (const [name, n, rule] of [['bad written order, 60 rows', 60, BAD], ['bad written order, 120 rows', 120, BAD], ['bad written order, 300 rows', 300, BAD], ['control: already well ordered', 120, GOOD]]) {
  const k = family(n, rule);
  const s = dreamingSession(jsReference, {});
  const journal = ['n0', 'n1', 'n2'].map(c => s.ask({theory: k, query: q(c)}));
  const dreamT = timed(() => s.dream({minTasks: 3, minScore: 0}), 1);
  const handle = jsReference.prepare({knowledge: k});
  const plainCold = timed(() => jsReference.ask({theory: {knowledge: k}, query: q('n1')}), 25);
  const plainWarm = timed(() => jsReference.ask({handle, query: q('n1')}), 25);
  const frozen = timed(() => s.ask({theory: k, query: q('n1')}), 25);
  const deployed = Boolean(frozen.out.dream.plan);
  const probes = p => p.budget.used.maxJoins;
  const row = {
    case: name, facts: 2 * n + 3, plan_deployed: deployed,
    probes: {plain: probes(plainCold.out), frozen: probes(frozen.out), ratio: +(probes(plainCold.out) / probes(frozen.out)).toFixed(1)},
    wall_ms: {plain_parse_each_call: +plainCold.ms.toFixed(2), plain_prepared_handle: +plainWarm.ms.toFixed(2), frozen_wrapper_parse_each_call: +frozen.ms.toFixed(2)},
    wall_ratio: {vs_plain_parse_each_call: +(plainCold.ms / frozen.ms).toFixed(2), vs_prepared_handle: +(plainWarm.ms / frozen.ms).toFixed(2)},
    dream_pass_ms: +dreamT.ms.toFixed(1),
    break_even_queries: deployed && plainCold.ms > frozen.ms ? Math.ceil(dreamT.ms / (plainCold.ms - frozen.ms)) : null,
    same_answer: JSON.stringify(plainCold.out.rows) === JSON.stringify(frozen.out.rows),
    journal_probes: journal.map(probes)
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}
const outDir = path.join(repo, 'eval/reports/current/dreaming-session');
fs.mkdirSync(outDir, {recursive: true});
fs.writeFileSync(path.join(outDir, 'bench.json'), JSON.stringify({generated: new Date().toISOString(), note: 'Regenerable observation (eval/smoke-reasoning/bench/dreaming-session.mjs). Probes are the oracle\'s units. The wrapper re-parses the circuits on every call (it reads the text to check the schema cone), so its wall clock carries that overhead; the prepared-handle column is the fair floor for the plain engine.', rows}, null, 2) + '\n');
