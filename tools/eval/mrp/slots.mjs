#!/usr/bin/env node
/**
 * The benchmark of the MRP slots that run before the core (DS028 "Benchmark contract"): the same cases through several strategies of
 * one slot, with the same metrics, so a Model's reflex boundary and affect reader are chosen by measurement.
 *
 *   reflex  cases {text, expect: FAQ id | null} over the FAQ and pattern reflexes of a profile (default acme-demo): fired right, fired
 *           wrong, fired on a message that needs reasoning, missed; precision, recall, mean latency and model calls per strategy.
 *   affect  cases {text, expect: label}: accuracy, macro precision and recall over the labels, mean latency and model calls.
 *
 * Strategies that call a model run only with `--live` (through Ploinky Workers, the tier of the strategy's defaults or `--tier`); without
 * it they are reported as skipped with the reason. Messages are English (the normalize slot is passthrough), because the slots read the
 * normalized English text.
 *
 *   node tools/eval/mrp/slots.mjs [--slot reflex|affect] [--live] [--tier fast] [--profile acme-demo] [--out file.json]
 *
 * The report goes to eval/reports/current/mrp-slots/<date>.json (gitignored) and a table to stdout.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Models, profiles} from '../../../lib/mrp/models.mjs';
import {createMrpPipeline} from '../../../lib/mrp/pipeline.mjs';
import {strategiesOf} from '../../../lib/mrp/strategies.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const CASES_FILE = path.join(ROOT, 'eval', 'mrp-slots-v1', 'cases.jsonl');
export const STRATEGIES = Object.freeze({reflex: ['faq-fixed', 'faq-margin', 'faq-feedback', 'faq-llm-judge', 'faq-llm-select', 'faq-hybrid', 'pattern-reflex'], affect: ['lexicon', 'lexicon-then-llm', 'llm-label', 'off']});

export const readCases = (file = CASES_FILE) => fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));

/** The message acts of eval/pragmatics-v1 that are emotions, as affect labels (the other acts read as neutral for this slot). */
export const PRAGMATIC_AFFECT = Object.freeze({frustration: 'frustrated', urgency: 'urgent', confusion: 'confused', thanks: 'grateful', anger: 'angry', offensive: 'angry', profanity: 'angry', joy: 'happy', sadness: 'sad', disappointment: 'sad'});
/** The 300 labelled messages of eval/pragmatics-v1 (several languages) as affect cases: `expect` is the set of affect labels, or [neutral]. */
export function pragmaticsCases(file = path.join(ROOT, 'eval', 'pragmatics-v1', 'messages.jsonl')) {
  return readCases(file).map(r => {
    const labels = [...new Set(r.positive.map(a => PRAGMATIC_AFFECT[a]).filter(Boolean))];
    return {id: r.id, slot: 'affect', text: r.message, expect: labels.length ? labels : ['neutral']};
  });
}

const round = x => Math.round(x * 1000) / 1000;
const ratio = (a, b) => b ? round(a / b) : null;

/** Reflex metrics of `[{expect, fired: id | null}]`. */
export function reflexMetrics(rows) {
  const right = rows.filter(r => r.expect && r.fired === r.expect).length;
  const wrong = rows.filter(r => r.expect && r.fired && r.fired !== r.expect).length;
  const intrusive = rows.filter(r => !r.expect && r.fired).length;
  const missed = rows.filter(r => r.expect && !r.fired).length;
  return {cases: rows.length, right, wrong, intrusive, missed, precision: ratio(right, right + wrong + intrusive), recall: ratio(right, rows.filter(r => r.expect).length)};
}

/**
 * Affect metrics of `[{expect, label}]` (`expect` one label or a set of labels): accuracy (the label is one of the expected), macro
 * precision/recall over the labels, and the detection of an emotion at all (emotional versus neutral).
 */
export function affectMetrics(rows) {
  const want = r => Array.isArray(r.expect) ? r.expect : [r.expect];
  const labels = [...new Set(rows.flatMap(want))].sort();
  const per = Object.fromEntries(labels.map(l => {
    const tp = rows.filter(r => want(r).includes(l) && r.label === l).length;
    return [l, {precision: ratio(tp, rows.filter(r => r.label === l).length), recall: ratio(tp, rows.filter(r => want(r).includes(l)).length)}];
  }));
  const mean = key => round(labels.reduce((s, l) => s + (per[l][key] ?? 0), 0) / labels.length);
  const emotional = rows.filter(r => !want(r).includes('neutral')), saidEmotional = rows.filter(r => r.label !== 'neutral');
  return {cases: rows.length, accuracy: ratio(rows.filter(r => want(r).includes(r.label)).length, rows.length), macroPrecision: mean('precision'), macroRecall: mean('recall'),
    emotionDetection: {precision: ratio(saidEmotional.filter(r => !want(r).includes('neutral')).length, saidEmotional.length), recall: ratio(emotional.filter(r => r.label !== 'neutral').length, emotional.length)}, perLabel: per};
}

/**
 * Runs the cases of `slot` through each strategy. `client` is a Ploinky client factory (`--live`), or null to skip the strategies that
 * call a model. Returns `[{strategy, skipped?} | {strategy, metrics, ms, calls, rows}]`.
 */
export async function runSlot(slot, {cases = readCases(), profile = 'acme-demo', client = null, tier = null, strategies = STRATEGIES[slot], normalize = 'passthrough'} = {}) {
  const list = cases.filter(c => c.slot === slot);
  const p = profiles().find(x => x.id === profile) ?? {};
  const out = [];
  for (const id of strategies) {
    const entry = strategiesOf(slot).find(s => s.id === id);
    const usesModel = entry.params.some(x => x.type === 'tier');
    if ((usesModel || normalize !== 'passthrough') && !client) { out.push({strategy: id, skipped: 'calls a model: run with --live'}); continue; }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mrp-bench-'));
    try {
      const models = new Models({root});
      const params = usesModel && tier ? {tier} : {};
      models.create({id: 'bench', faq: p.faq ?? [], reflexes: p.reflexes ?? [], language: {output: 'en'}, slots: {normalize: normalize === 'passthrough' ? 'passthrough' : {strategy: normalize, params: {...(tier ? {tier} : {}), ...(['translate-llm', 'proofread-llm'].includes(normalize) ? {context: 0} : {})}}, reflex: slot === 'reflex' ? {strategy: id, params} : 'off', affect: slot === 'affect' ? {strategy: id, params} : 'off'}});
      let calls = 0;
      const counted = client ? purpose => { const c = client(purpose); return {chat: async r => { calls++; return c.chat(r); }}; } : () => ({chat: async () => { calls++; return {ok: false, reason: 'no model in this run'}; }});
      const mrp = createMrpPipeline({models, client: counted});
      const rows = [];
      const t0 = Date.now();
      for (const c of list) {
        const pre = await mrp.before({modelId: 'bench', text: c.text});
        rows.push(slot === 'reflex' ? {id: c.id, expect: c.expect, fired: pre.reflex?.id ?? null} : {id: c.id, expect: c.expect, label: pre.affect?.label ?? 'neutral'});
      }
      const ms = round((Date.now() - t0) / Math.max(1, list.length));
      out.push({strategy: id, metrics: slot === 'reflex' ? reflexMetrics(rows) : affectMetrics(rows), ms, calls, rows});
    } finally { fs.rmSync(root, {recursive: true, force: true}); }
  }
  return out;
}

function table(slot, results) {
  const head = slot === 'reflex' ? '| strategy | precision | recall | right | wrong | intrusive | missed | ms/case | calls |' : '| strategy | accuracy | macro P | macro R | emotion P / R | ms/case | calls |';
  const rows = results.map(r => r.skipped ? `| ${r.strategy} | skipped: ${r.skipped} |` : slot === 'reflex'
    ? `| ${r.strategy} | ${r.metrics.precision} | ${r.metrics.recall} | ${r.metrics.right} | ${r.metrics.wrong} | ${r.metrics.intrusive} | ${r.metrics.missed} | ${r.ms} | ${r.calls} |`
    : `| ${r.strategy} | ${r.metrics.accuracy} | ${r.metrics.macroPrecision} | ${r.metrics.macroRecall} | ${r.metrics.emotionDetection.precision} / ${r.metrics.emotionDetection.recall} | ${r.ms} | ${r.calls} |`);
  return [`### ${slot}`, '', head, head.replace(/[^|]+/g, ' --- '), ...rows].join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const slots = arg('--slot') ? [arg('--slot')] : Object.keys(STRATEGIES);
  // --set pragmatics: the affect slot on eval/pragmatics-v1 (300 messages in several languages); --normalize names the normalize strategy.
  const set = arg('--set'), normalize = arg('--normalize') ?? 'passthrough';
  let client = null;
  if (args.includes('--live')) { const {pworker} = await import('../../../lib/pworker.mjs'); client = purpose => pworker({purpose: `test:mrp-slots-${purpose}`, run: 'mrp-slots-bench', priority: 'background'}); }
  const report = {object: 'mrp.slots.bench', date: new Date().toISOString(), cases: set === 'pragmatics' ? 'eval/pragmatics-v1/messages.jsonl' : path.relative(ROOT, CASES_FILE), normalize, live: Boolean(client), tier: arg('--tier'), slots: {}};
  for (const slot of slots) {
    report.slots[slot] = await runSlot(slot, {client, tier: arg('--tier'), profile: arg('--profile') ?? 'acme-demo', normalize, ...(arg('--strategies') ? {strategies: arg('--strategies').split(',')} : {}), ...(set === 'pragmatics' ? {cases: pragmaticsCases()} : {})});
    console.log(table(slot, report.slots[slot]) + '\n');
  }
  const out = arg('--out') ?? path.join(ROOT, 'eval', 'reports', 'current', 'mrp-slots', `${report.date.slice(0, 10)}${set ? '-' + set : ''}-${normalize}${arg('--strategies') ? '-' + arg('--strategies').replace(/,/g, '+') : ''}.json`);
  fs.mkdirSync(path.dirname(out), {recursive: true});
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(`report: ${path.relative(ROOT, out)}`);
}
