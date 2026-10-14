#!/usr/bin/env node
/**
 * The benchmark of the voice slot (DS028 "Benchmark contract": numeric and id fidelity of the voice). The deterministic English answers
 * of a formalize benchmark run (tools/eval/mrp/formalize.mjs, correct rows) are phrased in other languages by each voice strategy. A
 * phrasing is `applied` when it passes the voice's own fidelity guard (every number, date, name and source id kept,
 * lib/mrp/pipeline.mjs); otherwise the English answer is shown, which is safe but not in the user's language. Reported per strategy and
 * language: the applied share, the reasons of the fallbacks, latency and model calls.
 *
 *   node tools/eval/mrp/voice.mjs [--rows eval/reports/current/mrp-formalize/acme-LocalLLMStepByStep-fast.jsonl] [--tier fast] [--languages ro,fr]
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

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const file = opt('--rows', path.join(ROOT, 'eval/reports/current/mrp-formalize/acme-LocalLLMStepByStep-fast.jsonl'));
  const tier = opt('--tier', 'fast'), languages = opt('--languages', 'ro,fr').split(',');
  const answers = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.outcome === 'correct' && r.text && r.text.length < 300);
  const report = {object: 'mrp.voice.bench', date: new Date().toISOString(), rows: path.relative(ROOT, file), tier, answers: answers.length, results: {}};
  for (const strategy of ['natural-rephrase', 'translate-only']) for (const language of languages) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mrp-voice-'));
    let calls = 0;
    const models = new Models({root});
    models.create({id: 'bench', slots: {voice: {strategy, params: {tier}}}});
    const mrp = createMrpPipeline({models, client: () => { const c = pworker({purpose: 'job:mrp-voice', run: `mrp-voice-${strategy}-${language}`, priority: 'background'}); return {chat: o => { calls++; return c.chat(o); }}; }});
    const slot = models.effective('bench').slots.voice;
    const rows = [];
    const queue = [...answers];
    await Promise.all(Array.from({length: 4}, async () => { for (let a; (a = queue.shift());) {
      const trace = [], t0 = Date.now();
      const out = await mrp.voice(slot, {english: a.text, packet: {}, output: language, original: a.question, affect: null}, trace);
      rows.push({id: a.id, applied: out.applied, text: out.text, degraded: trace[0]?.degraded ?? null, ms: Date.now() - t0});
    } }));
    const applied = rows.filter(r => r.applied).length;
    const reasons = {};
    for (const r of rows.filter(r => !r.applied)) { const k = /dropped/.test(r.degraded ?? '') ? 'dropped a kept token' : r.degraded ?? 'not applied'; reasons[k] = (reasons[k] ?? 0) + 1; }
    report.results[`${strategy}/${language}`] = {answers: rows.length, applied_rate: round(applied / Math.max(1, rows.length)), fallbacks: reasons, mean_ms: Math.round(rows.reduce((s, r) => s + r.ms, 0) / Math.max(1, rows.length)), calls_per_answer: round(calls / Math.max(1, rows.length)), rows};
    console.log(strategy, language, JSON.stringify({applied_rate: report.results[`${strategy}/${language}`].applied_rate, fallbacks: reasons}));
    fs.rmSync(root, {recursive: true, force: true});
  }
  const out = path.join(ROOT, 'eval/reports/current/mrp-slots', `voice-${report.date.slice(0, 10)}.json`);
  fs.mkdirSync(path.dirname(out), {recursive: true});
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(`report: ${path.relative(ROOT, out)}`);
}
