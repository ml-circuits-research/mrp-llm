#!/usr/bin/env node
/**
 * End-to-end evaluation on the owner's problem books (docs/runtime.html "Evaluating on the owner's problem books"):
 *   node tools/eval/books/run.mjs --n 100 [--seed s] [--books math,science,...] [--areas text,...] [--arms steps,direct[,remote-direct,ceiling]]
 *     [--include-seen] [--ids a,b] [--resume dir] [--tier micro|tiny|small|medium|good] [--concurrency N]
 *     [--workers N] [--purpose job:books-eval] [--author-tier good] [--mode stepwise|routed|direct-verified]
 * --mode: the ChatSOPAdapter mode of the steps arm (lib/adapter; default stepwise, the chat default).
 * --items-from <run dir> takes the problems of an earlier run; --replay (arm ceiling) executes the stored circuit of a problem
 * (tools/eval/books/gold-circuits.mjs) instead of asking the tier again.
 * Arm ceiling: the same step-by-step questions answered by --author-tier (default good), in one process with --concurrency N: the
 * reasoning layers with the circuits a strong tier's answers assemble (owner 2026-10-02: like with like; LLMDirect is archived).
 * Every model call goes through Ploinky (lib/pworker.mjs): the step-by-step questions and the direct baseline call the same tier
 * (--tier, default micro: the local Qwen3-4B-Instruct that Ploinky starts on demand and guards with its GPU locks), tagged with
 * --purpose (default job:books-eval) and the run id, with the tier's fallback off, so both arms use the same model; --workers N runs the
 * steps arm in N independent chat systems (one session each).
 * Arms: steps = the product chat turn with LocalLLMStepByStep (method B) on --tier, the
 * problem text as the user message, the chat default base memory; direct = the same model answering the problem directly (baseline);
 * coding-agent = the steps arm with the questions answered by tier small; remote-direct = the steps arm on the product's tier ladder
 * (queryParser.local.ladder, escalating per question); ceiling = the steps arm on --author-tier. The last three keep their record names
 * (earlier runs used one-shot LLMDirect under them) and run only when asked. Items already run are not repeated unless --include-seen.
 * Writes eval/reports/current/books-eval/run-<timestamp>/records.jsonl, scores deterministically (tools/eval/books/score.mjs) and
 * prepares the judge batches; the report is tools/eval/books/report.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadItems, loadSeen, markSeen, sampleItems} from './sample.mjs';
import {openChatTurn, ROOT, DEFAULT_TIER} from './system.mjs';
import {attribution, finalLine} from './attribution.mjs';
import {readGold} from './gold-circuits.mjs';

const opt = (args, name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const list = v => (v ? v.split(',').map(s => s.trim()).filter(Boolean) : null);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

export async function main(args = process.argv.slice(2)) {
  const n = Number(opt(args, '--n', 100)), seed = opt(args, '--seed', 'books-1'), arms = list(opt(args, '--arms', 'steps,direct'));
  const unknown = arms.filter(a => !['steps', 'direct', ...Object.keys(REMOTE_ARMS)].includes(a));
  if (unknown.length) throw new Error(`arms: steps, direct, ${Object.keys(REMOTE_ARMS).join(', ')} (got ${unknown})`);
  if (args.includes('--endpoint')) throw new Error('--endpoint is gone: every model call goes through Ploinky; name a tier with --tier (default micro)');
  const resume = opt(args, '--resume', null);
  const out = path.resolve(ROOT, resume ?? `eval/reports/current/books-eval/run-${stamp()}`);
  fs.mkdirSync(out, {recursive: true});
  const itemsFile = path.join(out, 'items.json');
  let sample;
  if (resume && fs.existsSync(itemsFile)) sample = JSON.parse(fs.readFileSync(itemsFile, 'utf8'));
  // --items-from <run dir>: the same problems as an earlier run (with the current golds), e.g. to replay its circuits after a fix.
  else if (opt(args, '--items-from', null)) {
    const ids = new Set(JSON.parse(fs.readFileSync(path.resolve(ROOT, opt(args, '--items-from', null), 'items.json'), 'utf8')).map(i => i.id));
    sample = loadItems(ROOT).filter(i => ids.has(i.id));
    fs.writeFileSync(itemsFile, JSON.stringify(sample, null, 1));
  }
  else {
    const all = loadItems(ROOT);
    sample = sampleItems(all, {n, seed, books: list(opt(args, '--books', null)), areas: list(opt(args, '--areas', null)), ids: list(opt(args, '--ids', null)), seen: loadSeen(ROOT), includeSeen: args.includes('--include-seen')});
    fs.writeFileSync(itemsFile, JSON.stringify(sample, null, 1));
  }
  if (!sample.length) throw new Error('no unseen items match; use --include-seen or other filters');
  console.error(`run ${path.basename(out)}: ${sample.length} items, arms ${arms.join(',')}, seed ${seed}`);
  const file = path.join(out, 'records.jsonl');
  const done = new Set(fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { const r = JSON.parse(l); return `${r.arm}/${r.id}`; }) : []);
  const started = new Date().toISOString();
  const localArms = arms.filter(a => !REMOTE_ARMS[a]);
  let system = null;
  const append = rec => fs.appendFileSync(file, JSON.stringify(rec) + '\n');
  try {
    for (const arm of arms) {
      if (REMOTE_ARMS[arm]) { await remoteArm(arm, sample, done, append, args, out); continue; }
      const tier = opt(args, '--tier', DEFAULT_TIER);
      const tags = runTags(args, out);
      system ??= await openChatTurn({tier, tags, mode: opt(args, '--mode', 'stepwise')});
      if (arm === 'steps' && Number(opt(args, '--workers', 1)) > 1) { await parallelSteps(sample, done, append, args, out, {tier, tags}); continue; }
      let k = 0;
      for (const item of sample) {
        if (done.has(`${arm}/${item.id}`)) continue;
        const base = {run: path.basename(out), arm, id: item.id, book: item.book, area: item.area, grade: item.grade, question: item.question, gold: item.answer, gold_kind: item.answer_kind, gold_value: item.answer_value, ...(item.answer_numbers ? {gold_numbers: item.answer_numbers} : {})};
        if (arm === 'steps') {
          const r = await system.ask(item.question);
          append({...base, ms: r.ms, ok: r.ok, text: r.text ?? null, error: r.error ?? null, system: attribution(r)});
          console.error(`[${++k}/${sample.length}] steps ${item.id} ${r.ok ? r.packet?.status : 'ERR ' + r.error?.code} ${r.ms} ms`);
        } else {
          const r = await system.direct(item.question);
          append({...base, ms: r.ms, ok: r.ok, text: r.text ?? null, final: r.ok ? finalLine(r.text) : null, error: r.ok ? null : {code: 'direct_failed', message: r.reason}, tokens: r.usage ?? null, finish: r.finish ?? null});
          console.error(`[${++k}/${sample.length}] direct ${item.id} ${r.ok ? (finalLine(r.text) ?? '(no final line)').slice(0, 50) : 'ERR'} ${r.ms} ms`);
        }
      }
    }
  } finally { await system?.close(); }
  fs.writeFileSync(path.join(out, 'run.json'), JSON.stringify({run: path.basename(out), started, finished: new Date().toISOString(), n: sample.length, seed, arms, model: `tier:${opt(args, '--tier', DEFAULT_TIER)}`, method: 'B',
    base_memory: system?.baseId ?? null, memory_circuits_sha256: system?.memoryDigest ?? null, filters: {books: opt(args, '--books', null), areas: opt(args, '--areas', null)}}, null, 1));
  if (!args.includes('--include-seen') && !resume && !opt(args, '--items-from', null)) markSeen(ROOT, sample.map(i => i.id), path.basename(out));
  void localArms;
  console.error(`records: ${path.relative(ROOT, file)}\nnext: node tools/eval/books/score.mjs --run ${path.relative(ROOT, out)}`);
}

/**
 * The arms that run the chat turn with the step-by-step questions answered by a larger Ploinky tier (owner decision 2026-10-02: every tier
 * answers the SAME questions; one-shot LLMDirect is archived in probably_obsolete/one-shot-formalization/). The record names are kept.
 * 'coding-agent': tier small; 'remote-direct': the product's ladder (queryParser.local.ladder); 'ceiling' (reasoning cycle): --author-tier
 * (default good), whose circuits measure what the reasoning layers reach with a strong formalization.
 */
export const REMOTE_ARMS = Object.freeze({'coding-agent': {tier: 'small'}, 'remote-direct': {ladder: true}, ceiling: {tier: 'author'}});

/** The Ploinky tags of a run: --purpose (default job:books-eval), the run id, and no fallback (every answer from the named tier). */
const runTags = (args, out) => ({purpose: opt(args, '--purpose', 'job:books-eval'), run: path.basename(out), noFallback: true});

/** The steps arm on a Ploinky tier in N independent chat systems (one private session each, so no turn sees another's session layer). */
async function parallelSteps(sample, done, append, args, out, {tier, tags}) {
  const width = Math.max(1, Number(opt(args, '--workers', 1)));
  const queue = sample.filter(item => !done.has(`steps/${item.id}`));
  let k = 0;
  const worker = async w => {
    const system = await openChatTurn({tier, tags, sessionId: `books-eval-${process.pid}-w${w}`, mode: opt(args, '--mode', 'stepwise')});
    try {
      for (let item = queue.shift(); item; item = queue.shift()) {
        const r = await system.ask(item.question);
        append({run: path.basename(out), arm: 'steps', id: item.id, book: item.book, area: item.area, grade: item.grade, question: item.question, gold: item.answer, gold_kind: item.answer_kind, gold_value: item.answer_value, ...(item.answer_numbers ? {gold_numbers: item.answer_numbers} : {}), ms: r.ms, ok: r.ok, text: r.text ?? null, error: r.error ?? null, system: attribution(r)});
        console.error(`[${++k}/${sample.length}] steps ${item.id} ${r.ok ? r.packet?.status : 'ERR ' + r.error?.code} ${r.ms} ms`);
      }
    } finally { await system.close(); }
  };
  await Promise.all(Array.from({length: width}, (_, w) => worker(w)));
}

/** A remote arm: the same chat turn with the arm's strategy; only when asked. */
async function remoteArm(arm, sample, done, append, args, out) {
  const spec = REMOTE_ARMS[arm];
  // The run's tags and no fallback, so every answer of the arm comes from the named tier (the ladder's own tiers for remote-direct).
  const tier = spec.tier === 'author' ? opt(args, '--author-tier', 'good') : spec.tier ?? null;
  const system = await openChatTurn({tier, ladder: Boolean(spec.ladder), tags: runTags(args, out), sessionId: `books-eval-${process.pid}-${arm}`});
  // `--concurrency N` (default 2): remote turns wait on the provider, so a few run at once (Ploinky enforces the plan's rate limits).
  const width = Math.max(1, Number(opt(args, '--concurrency', 2)));
  const queue = sample.filter(item => !done.has(`${arm}/${item.id}`));
  let k = 0;
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      // --replay: a problem with a stored circuit of the same tier (state/formalization-gold/books) is executed again without a model call.
      const stored = arm === 'ceiling' && args.includes('--replay') ? readGold(item.id) : null;
      const replay = stored && stored.author_tier === tier && stored.circuit ? stored.circuit : null;
      const r = await system.ask(item.question, {sop: replay});
      append({run: path.basename(out), arm, id: item.id, book: item.book, area: item.area, grade: item.grade, question: item.question, gold: item.answer, gold_kind: item.answer_kind, gold_value: item.answer_value, ...(item.answer_numbers ? {gold_numbers: item.answer_numbers} : {}), ms: r.ms, ok: r.ok, text: r.text ?? null, error: r.error ?? null,
        ...(arm === 'ceiling' ? {author_tier: tier, circuit: r.authored ?? null, replayed: Boolean(replay)} : {}), system: attribution(r)});
      console.error(`[${++k}/${sample.length}] ${arm} ${item.id}${replay ? ' (replay)' : ''} ${r.ok ? r.packet?.status : 'ERR ' + r.error?.code} ${r.ms} ms`);
    }
  };
  try { await Promise.all(Array.from({length: width}, worker)); } finally { await system.close(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
