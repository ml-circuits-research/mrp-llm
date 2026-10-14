#!/usr/bin/env node
/**
 * The benchmark of the roundtrip slot (DS028 "Benchmark contract": the share of misread messages it catches per model call it costs).
 * Cases are built from a formalize benchmark run (tools/eval/mrp/formalize.mjs): every question whose circuit was correct is paired
 * with its own circuit (faithful) and with the correct circuit of another question of a different form (a misread: the circuit
 * answers another question). Each strategy restates the circuit and compares; a misread is caught when the strategy disagrees, a false
 * alarm is a disagreement on a faithful pair. The lexical strategies are also swept over their threshold, from the same restatements.
 *
 *   node tools/eval/mrp/roundtrip.mjs [--rows eval/reports/current/mrp-formalize/acme-LocalLLMStepByStep-fast.jsonl] [--tier fast]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Models} from '../../../lib/mrp/models.mjs';
import {createMrpPipeline} from '../../../lib/mrp/pipeline.mjs';
import {pworker} from '../../../lib/pworker.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const round = x => Math.round(x * 1000) / 1000;

/** Faithful and misread pairs from formalize rows: `[{id, english, sop, faithful}]`. */
export function pairsOf(rows) {
  const good = rows.filter(r => r.outcome === 'correct' && r.model_sop && r.gold !== 'unknown');
  return good.flatMap((r, i) => {
    const other = good.slice(i + 1).concat(good.slice(0, i)).find(o => o.form !== r.form && JSON.stringify(o.gold) !== JSON.stringify(r.gold));
    return [{id: `${r.id}-own`, english: r.question, sop: r.model_sop, faithful: true}, ...(other ? [{id: `${r.id}-as-${other.id}`, english: r.question, sop: other.model_sop, faithful: false}] : [])];
  });
}

/** Catch rate, false alarms and calls of `[{faithful, agree}]`. */
export function roundtripMetrics(rows, calls) {
  const mis = rows.filter(r => !r.faithful), ok = rows.filter(r => r.faithful);
  return {pairs: rows.length, catch_rate: mis.length ? round(mis.filter(r => r.agree === false).length / mis.length) : null,
    false_alarm_rate: ok.length ? round(ok.filter(r => r.agree === false).length / ok.length) : null, undecided: rows.filter(r => r.agree == null).length, calls_per_pair: round(calls / Math.max(1, rows.length))};
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const file = opt('--rows', path.join(ROOT, 'eval/reports/current/mrp-formalize/acme-LocalLLMStepByStep-fast.jsonl'));
  const tier = opt('--tier', 'fast');
  const pairs = pairsOf(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)));
  const report = {object: 'mrp.roundtrip.bench', date: new Date().toISOString(), rows: path.relative(ROOT, file), tier, strategies: {}};
  const only = opt('--strategies', null)?.split(',');
  for (const strategy of (only ?? ['lexical-always', 'llm-judge', 'embedding'])) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mrp-rt-'));
    let calls = 0;
    const models = new Models({root});
    models.create({id: 'bench', slots: {normalize: 'passthrough', roundtrip: {strategy, params: {tier}}}});
    const mrp = createMrpPipeline({models, client: purpose => { const c = pworker({purpose: 'job:mrp-roundtrip', run: `mrp-roundtrip-${strategy}`, priority: 'background'}); return {chat: o => { calls++; return c.chat(o); }}; }});
    const slot = models.effective('bench').slots.roundtrip;
    const rows = [];
    const queue = [...pairs];
    await Promise.all(Array.from({length: 4}, async () => { for (let p; (p = queue.shift());) { const r = await mrp.roundtrip(slot, {english: p.english, modelSop: p.sop, parse: null}, []); rows.push({...p, agree: r?.agree ?? null, score: r?.score ?? null, restated: r?.restated ?? null}); } }));
    report.strategies[strategy] = {...roundtripMetrics(rows, calls), rows};
    if (strategy === 'embedding') report.sweepEmbedding = [0.6, 0.7, 0.75, 0.8, 0.85, 0.9].map(th => ({threshold: th, ...roundtripMetrics(rows.map(r => ({...r, agree: r.score == null ? null : r.score >= th})), calls)}));
    if (strategy === 'lexical-always') report.sweep = [0.2, 0.3, 0.4, 0.45, 0.5, 0.6].map(th => ({threshold: th, ...roundtripMetrics(rows.map(r => ({...r, agree: r.score == null ? null : r.score >= th})), calls)}));
    fs.rmSync(root, {recursive: true, force: true});
    console.log(strategy, JSON.stringify(roundtripMetrics(rows, calls)));
  }
  if (report.sweep) for (const s of report.sweep) console.log('lexical threshold', s.threshold, 'catch', s.catch_rate, 'false alarm', s.false_alarm_rate);
  if (report.sweepEmbedding) for (const s of report.sweepEmbedding) console.log('embedding threshold', s.threshold, 'catch', s.catch_rate, 'false alarm', s.false_alarm_rate);
  const out = path.join(ROOT, 'eval/reports/current/mrp-slots', `roundtrip-${report.date.slice(0, 10)}${only ? '-' + only.join('+') : ''}.json`);
  fs.mkdirSync(path.dirname(out), {recursive: true});
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(`report: ${path.relative(ROOT, out)}`);
}
