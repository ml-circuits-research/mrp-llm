#!/usr/bin/env node
/**
 * eval-pragmatics-v1: how well each formalization strategy understands courtesy and emotion (DS023), on the 300 labelled messages of
 * eval/pragmatics-v1/messages.jsonl (labels: a kind is positive when both judges of emotion-detection-v1, Grok and GLM, listed it,
 * negative when neither did; disputed kinds are left out of that message's numbers).
 *
 * Arms:
 *   stepbystep  LocalLLMStepByStep's first question (Q1 kind and message acts, then the emotion question) on the local Ploinky tier
 *               micro (records stepbystep.jsonl), or with --tier on another Ploinky tier (records stepbystep-<tier>.jsonl): larger
 *               tiers answer the SAME questions (like with like)
 * The one-shot arm `coding` (LLMDirect writing the whole circuit) was archived on 2026-10-02 (probably_obsolete/one-shot-formalization/)
 * and the `lexicon` arm (the archived lexicon/regex EmotionDetectionSystem) was dropped on 2026-10-03; their earlier records
 * (coding.jsonl, lexicon.jsonl) are still reported.
 *
 *   node tools/eval/conversation/pragmatics/run.mjs --arm stepbystep --limit 50                    (tier micro, the local Qwen3-4B-Instruct)
 *   node tools/eval/conversation/pragmatics/run.mjs --arm stepbystep --tier small --limit 50 --concurrency 4
 *   node tools/eval/conversation/pragmatics/run.mjs --report            (every arm's records → summary.json and summary.md)
 * Records: eval/reports/current/pragmatics/<arm>.jsonl (resumable). The first `--limit` messages are a fixed stratified order
 * (every message with a positive label interleaved with the neutral ones, seed-free: by id).
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {messageActs} from '../../../../sop/message-acts.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SET = path.join(ROOT, 'eval/pragmatics-v1/messages.jsonl');
const OUT = path.join(ROOT, 'eval/reports/current/pragmatics');
const opt = (args, name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const jl = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
/** The kinds the step-by-step first question can name (its message acts and emotions); the comparable core of every arm. */
export const CORE = Object.freeze(['greeting', 'thanks', 'apology', 'closing', 'politeness', 'frustration', 'confusion', 'urgency', 'anger', 'disappointment', 'joy', 'sadness', 'fear', 'curiosity']);
// The message acts of conversation-v1 (memory data since P-2.1, 2026-10-03): the kinds the labels of this set use.
export const ALL = Object.freeze(messageActs().kinds.filter(k => k !== 'unclassified'));

/** Messages in a fixed order: labelled and neutral messages alternate, so any prefix has both. */
export function ordered(rows) {
  const labelled = rows.filter(r => r.positive.length), neutral = rows.filter(r => !r.positive.length), out = [];
  for (let i = 0; out.length < rows.length; i++) { if (labelled[i]) out.push(labelled[i]); if (neutral[i]) out.push(neutral[i]); }
  return out;
}

/** The pragmatic kinds of a circuit text (structural: the `kind` line of each `pragmatic` wire). */
export const kindsOfSop = sop => [...String(sop ?? '').matchAll(/^@\w+\s+pragmatic\s*\n((?:[ \t]+.*\n?)*)/gm)].map(m => /^\s+kind\s+(\w+)/m.exec(m[1])?.[1]).filter(Boolean);

async function stepByStepArm(rows, args) {
  const {createOracle} = await import('../../../../lib/query-author/step-by-step/index.mjs');
  const {firstQuestion} = await import('../../../../lib/query-author/step-by-step/protocol.mjs');
  const {tierChat} = await import('../../../../lib/formalize/strategies.mjs');
  // --tier: a Ploinky tier with the product ladder's request settings for that tier; without it the local tier micro (Qwen3-4B-Instruct).
  if (args.includes('--endpoint') || args.includes('--model')) throw new Error('--endpoint and --model are gone: every model call goes through Ploinky; name a tier with --tier (default micro)');
  const tier = opt(args, '--tier', null);
  const {tierLadder} = await import('../../lib/tier-parser.mjs');
  const rung = tier ? tierLadder(JSON.parse(fs.readFileSync(path.join(ROOT, 'config/runtime.json'), 'utf8')), tier)[0] : null;
  const extraBody = {chat_template_kwargs: {enable_thinking: false}, ...(rung?.extraBody ?? {})};
  const chat = tierChat({tier: tier ?? 'micro', extraBody, timeoutMs: 120_000, purpose: 'job:pragmatics-eval'});
  return async row => {
    const oracle = createOracle({chat});
    const started = Date.now();
    const first = await firstQuestion(oracle, row.message);
    return {kinds: first.pragmatic, form: first.form, questions: oracle.steps.length, ms: Date.now() - started, answers: oracle.steps.map(s => s.answer)};
  };
}

/** Per kind and micro precision/recall over both-judge positives and neither-judge negatives (disputed kinds left out). */
export function score(records, rowsById, kinds) {
  const perKind = Object.fromEntries(kinds.map(k => [k, {tp: 0, fp: 0, fn: 0}]));
  for (const r of records) {
    const row = rowsById.get(r.id);
    if (!row || r.error) continue;
    for (const k of kinds) {
      if (row.disputed.includes(k)) continue;
      const p = r.kinds.includes(k), a = row.positive.includes(k);
      if (p && a) perKind[k].tp++; else if (p) perKind[k].fp++; else if (a) perKind[k].fn++;
    }
  }
  const sum = key => Object.values(perKind).reduce((n, x) => n + x[key], 0);
  const ratio = (a, b) => b ? Math.round(1000 * a / b) / 10 : null;
  const tp = sum('tp'), fp = sum('fp'), fn = sum('fn');
  return {n: records.filter(r => !r.error).length, errors: records.filter(r => r.error).length, micro: {precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn), tp, fp, fn},
    perKind: Object.fromEntries(Object.entries(perKind).filter(([, x]) => x.tp + x.fp + x.fn).map(([k, x]) => [k, {...x, precision: ratio(x.tp, x.tp + x.fp), recall: ratio(x.tp, x.tp + x.fn)}]))};
}

function report() {
  const rows = jl(SET), byId = new Map(rows.map(r => [r.id, r]));
  const summary = {};
  const lines = ['| arm | n | errors | core P | core R | all-kinds P | all-kinds R | p50 ms |', '|---|---|---|---|---|---|---|---|'];
  const tiered = fs.existsSync(OUT) ? fs.readdirSync(OUT).filter(f => /^stepbystep-[\w-]+\.jsonl$/.test(f)).map(f => f.slice(0, -6)) : [];
  for (const arm of ['stepbystep', ...tiered, 'coding', 'guide-haiku', 'lexicon']) {
    const records = jl(path.join(OUT, `${arm}.jsonl`));
    if (!records.length) continue;
    // Every arm is scored on the messages the smallest arm has, so the numbers compare like with like.
    const core = score(records, byId, CORE), all = score(records, byId, ALL);
    const ms = records.map(r => r.ms).filter(Number.isFinite).sort((a, b) => a - b);
    summary[arm] = {core, all, p50_ms: ms.length ? ms[Math.floor(ms.length / 2)] : null, ids: records.map(r => r.id)};
    lines.push(`| ${arm} | ${core.n} | ${core.errors} | ${core.micro.precision} | ${core.micro.recall} | ${all.micro.precision} | ${all.micro.recall} | ${summary[arm].p50_ms ?? '-'} |`);
  }
  // The same messages for every arm: the intersection of the scored ids.
  const common = Object.values(summary).map(s => new Set(s.ids)).reduce((a, b) => new Set([...a].filter(x => b.has(x))));
  lines.push('', `Paired on the ${common.size} messages every arm has:`, '', '| arm | core P | core R |', '|---|---|---|');
  for (const arm of Object.keys(summary)) {
    const s = score(jl(path.join(OUT, `${arm}.jsonl`)).filter(r => common.has(r.id)), byId, CORE);
    summary[arm].paired = s;
    lines.push(`| ${arm} | ${s.micro.precision} | ${s.micro.recall} |`);
  }
  for (const s of Object.values(summary)) delete s.ids;
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT, 'summary.md'), lines.join('\n') + '\n');
  console.log(lines.join('\n'));
}

export async function main(args = process.argv.slice(2)) {
  fs.mkdirSync(OUT, {recursive: true});
  if (args.includes('--report')) return report();
  const arm = opt(args, '--arm', null);
  const factory = {stepbystep: stepByStepArm}[arm];
  if (!factory) throw new Error('--arm stepbystep (the one-shot arm coding was archived on 2026-10-02 and the lexicon arm dropped on 2026-10-03)');
  const limit = Number(opt(args, '--limit', 300)), concurrency = Number(opt(args, '--concurrency', 1));
  const rows = ordered(jl(SET)).slice(0, limit);
  const file = path.join(OUT, `${arm}${arm === 'stepbystep' && opt(args, '--tier', null) ? '-' + opt(args, '--tier', null) : ''}.jsonl`);
  const done = new Set(jl(file).map(r => r.id));
  const run = await factory(rows, args);
  const queue = rows.filter(r => !done.has(r.id));
  const worker = async () => {
    for (let row = queue.shift(); row; row = queue.shift()) {
      let record;
      try { record = {id: row.id, ...await run(row)}; } catch (error) { record = {id: row.id, kinds: [], error: error.message}; }
      fs.appendFileSync(file, JSON.stringify(record) + '\n');
      console.error(`${row.id} ${record.error ? 'ERROR ' + record.error : record.kinds.join(',') || '-'} | gold ${row.positive.join(',') || '-'}`);
    }
  };
  await Promise.all(Array.from({length: concurrency}, worker));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
