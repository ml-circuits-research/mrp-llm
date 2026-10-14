#!/usr/bin/env node
/**
 * Per level and arm counts of eval-generality-v1: correct / wrong / unknown / invalid+failed, with a default failure layer
 * (refined by hand in the report). Natural rows judged by hand come from --judgments (id/arm -> outcome, note).
 *   node tools/eval/formalization/generality/summarize.mjs --runs run3-C,run2-D,replay-postfix [--judgments FILE] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DIR = path.join(ROOT, 'eval/reports/current/generality');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

export function layerOf(r) {
  if (r.outcome === 'correct') return null;
  const reason = String(r.author?.reason ?? r.error ?? '');
  if (/circuit output rejected|budget exhausted|timed out|could not be started|no circuit/.test(reason)) return 'transport/output format';
  if (r.arm === 'D') return r.outcome === 'failed' ? 'transport/output format' : 'reasoning (direct answer)';
  if (r.outcome === 'invalid') return 'author (circuit rejected after repairs)';
  if (/relation_not_in_memory|unclear/.test(r.packet?.status ?? '') || r.packet?.status === 'unclear') return 'author or vocabulary (declined)';
  if (r.packet?.reason === 'unsupported_circuit_composition') return 'author (several queries, not one composed answer)';
  if (r.packet?.status === 'not_computable') return 'author (ill-typed comparison)';
  if (r.packet?.status === 'clarify') return 'linking (clarification)';
  return 'author (circuit differs from the question)';
}

export function summarize(records, judgments = {}) {
  const levelOf = r => r.level === 'n' ? 'c-natural' : r.level === 'c' ? 'c-compositions' : 'b-held-out';
  const table = {};
  for (let r of records) {
    const j = judgments[`${r.id}/${r.arm}`];
    if (r.arm === 'D' && r.expected?.conditional && r.packet?.status && r.packet.status === r.expected.status) r = {...r, outcome: 'correct'};
    const outcome = j?.outcome ?? r.outcome;
    const key = `${levelOf(r)} | ${r.arm}`;
    const cell = table[key] ??= {correct: 0, wrong: 0, unknown: 0, 'invalid+failed': 0, manual_pending: 0, layers: {}};
    if (outcome === 'manual') cell.manual_pending++;
    else cell[['invalid', 'failed'].includes(outcome) ? 'invalid+failed' : outcome]++;
    const layer = j?.layer ?? layerOf({...r, outcome});
    if (layer && outcome !== 'manual') cell.layers[layer] = (cell.layers[layer] ?? 0) + 1;
  }
  return table;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const runs = opt('--runs', 'run3-C,run2-D,replay-postfix').split(',');
  const records = runs.flatMap(run => {
    const file = path.join(DIR, run, 'records.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => ({...JSON.parse(l), run})) : [];
  }).map(r => r.run.startsWith('replay') ? {...r, arm: 'R', level: r.level ?? (r.id.startsWith('gen-c') ? 'c' : 'b')} : r);
  const judgments = opt('--judgments', null) ? JSON.parse(fs.readFileSync(opt('--judgments'), 'utf8')) : {};
  const table = summarize(records, judgments);
  if (args.includes('--json')) console.log(JSON.stringify(table, null, 1));
  else for (const [key, c] of Object.entries(table).sort()) console.log(`${key.padEnd(24)} ${c.correct}/${c.wrong}/${c.unknown}/${c['invalid+failed']}${c.manual_pending ? ` (+${c.manual_pending} to judge)` : ''}  ${JSON.stringify(c.layers)}`);
}
