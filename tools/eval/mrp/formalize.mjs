#!/usr/bin/env node
/**
 * The benchmark of the formalize slot (DS028 "Benchmark contract"): every formalize strategy of the MRP catalog on the same questions,
 * the same base memory and one Ploinky tier, through the chat turn of ChatSOPAdapter (tools/eval/lib/chat-turn.mjs, the chat's own glue:
 * admission, linking, slice retrieval, StrategyRouter, oracle verification, rendering). A strategy that fails is an outcome of its
 * record, never replaced by another strategy.
 *
 *   node tools/eval/mrp/formalize.mjs [--suites acme,commonsense] [--strategies LocalLLMStepByStep,DirectSOP,...] [--tier fast]
 *                                     [--normalize translate-llm|translate-if-foreign|proofread-llm|passthrough]
 *                                     [--retrieve splade-slice|dense-slice|graph-walk|hybrid-rerank] [--concurrency 4] [--limit N] [--force]
 *
 * `acme-para` (20 acme questions worded unlike the memory: "Who is employed by Acme?") measures the retrieve strategies.
 *
 * `--normalize` runs the MRP normalize slot (lib/mrp/pipeline.mjs, its strategy on the same tier) before the formalizer, so the suite
 * `acme-ro` (16 of the acme questions in Romanian, casual ones included) measures the language edge with the formalizer behind it.
 *   node tools/eval/mrp/formalize.mjs report
 *
 * Suites (eval/mrp-formalize-v1): `acme` (40 questions over acme-demo) and `commonsense` (32 over commonsense-v1). Outcomes: `correct`;
 * `wrong` (a definite answer that differs from the gold, or a definite answer to a question the memory cannot answer: the dangerous
 * class); `honest_unknown` (unknown, clarify, unclear, incomplete: no answer given); `parser_failed` (no circuit: parse_failed or
 * parse_unavailable); `error`. Per strategy: accuracy, wrong rate, coverage (correct + honest unknown on unanswerable questions), mean
 * latency and model calls per question. The base memories are built fresh from the seeds in a private chat data root
 * (state/mrp-eval/chat_data), so the current seed circuits (the acme-demo value schema) are in force.
 * Rows go to eval/reports/current/mrp-formalize/<suite>-<strategy>-<tier>.jsonl; `report` writes report.json and report.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ChatData} from '../../../lib/chat-data/index.mjs';
import {BaseMemories, BASE_NAME} from '../../../lib/chat-data/memories.mjs';
import {ensureSeedMemories} from '../../../lib/knowledge-seeds.mjs';
import {openSession} from '../lib/session.mjs';
import {harnessChat} from '../lib/chat-turn.mjs';
import {judgeGold} from '../formalization/query-parsers.mjs';
import {createMrpPipeline} from '../../../lib/mrp/pipeline.mjs';
import {Models} from '../../../lib/mrp/models.mjs';
import {pworker} from '../../../lib/pworker.mjs';
import {retrieveCandidates} from '../../../lib/mrp/retrieve.mjs';
import {startStrategyService} from '../../../lib/mrp/strategy-service.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const OUT = path.join(ROOT, 'eval/reports/current/mrp-formalize');
export const CHAT_ROOT = path.join(ROOT, 'state/mrp-eval/chat_data');
export const SUITES = Object.freeze({acme: {file: 'eval/mrp-formalize-v1/acme.jsonl', base: 'acme-demo'}, commonsense: {file: 'eval/mrp-formalize-v1/commonsense.jsonl', base: 'commonsense-v1'},
  'acme-ro': {file: 'eval/mrp-formalize-v1/acme-ro.jsonl', base: 'acme-demo'}, 'acme-para': {file: 'eval/mrp-formalize-v1/acme-para.jsonl', base: 'acme-demo'}});
export const STRATEGIES = Object.freeze(['LocalLLMStepByStep', 'InternalReasoningStepByStep', 'DirectSOP', 'SchemaGuidedLLM', 'Ensemble', 'Routed', 'DirectVerified']);
const MODES = {Routed: 'routed', DirectVerified: 'direct-verified'};
const DEFINITE = new Set(['supported', 'refuted', 'contradicted', 'false', 'conflicted']);

/** The outcome of one record: the gold `unknown` is right when no definite answer was given. */
export function outcomeOf(gold, packet, error) {
  if (error) return error.code === 'parse_failed' || error.code === 'parse_unavailable' ? 'parser_failed' : 'error';
  const definite = DEFINITE.has(packet?.status);
  if (gold === 'unknown') return definite ? 'wrong' : 'correct';
  if (judgeGold(gold, packet)) return 'correct';
  return definite ? 'wrong' : 'honest_unknown';
}

/** The aggregate of the records of one strategy on one suite. */
export function summarize(rows) {
  const n = rows.length, count = k => rows.filter(r => r.outcome === k).length;
  const mean = xs => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
  const unanswerable = rows.filter(r => r.gold === 'unknown');
  return {n, correct: count('correct'), wrong: count('wrong'), honest_unknown: count('honest_unknown'), parser_failed: count('parser_failed'), error: count('error'),
    accuracy: n ? Math.round(count('correct') / n * 1000) / 1000 : null, wrong_rate: n ? Math.round(count('wrong') / n * 1000) / 1000 : null,
    answerable_accuracy: rows.length - unanswerable.length ? Math.round(rows.filter(r => r.gold !== 'unknown' && r.outcome === 'correct').length / (rows.length - unanswerable.length) * 1000) / 1000 : null,
    abstention: unanswerable.length ? Math.round(unanswerable.filter(r => r.outcome === 'correct').length / unanswerable.length * 1000) / 1000 : null,
    mean_ms: mean(rows.map(r => r.total_ms)), ...usage(rows)};
}

function usage(rows, log = usageLog) {
  const runs = [...new Set(rows.map(r => r.run).filter(Boolean))].map(run => log().get(run)).filter(Boolean);
  if (!runs.length) return {calls_per_question: null, tokens_per_question: null};
  const sum = k => runs.reduce((a, r) => a + r[k], 0);
  return {calls_per_question: Math.round(sum('requests') / rows.length * 10) / 10, tokens_per_question: Math.round((sum('in_tokens') + sum('out_tokens')) / rows.length)};
}
let cachedLog = null;
const usageLog = () => (cachedLog ??= requestsByRun());

/** The base memories of the suites, built from the seeds in the private root (rebuilt when a seed changed). */
export function prepareRoot(root = CHAT_ROOT) {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/runtime.json'), 'utf8'));
  config.chatData = {...config.chatData, root};
  fs.mkdirSync(root, {recursive: true});
  const memories = new BaseMemories({chatData: ChatData.open(config, {}, ROOT), memory: config.memory});
  const created = ensureSeedMemories(memories, {ids: Object.values(SUITES).map(s => s.base)});
  if (created.stale?.length) {
    fs.rmSync(root, {recursive: true, force: true});
    return prepareRoot(root);
  }
  return {root, created};
}

const callsOf = parse => parse?.ensemble ? null : (parse?.steps ?? parse?.rounds ?? null);

/** Model requests and tokens per Ploinky run tag, from the request log of the Pworker home (every upstream attempt counts). */
export function requestsByRun(home = process.env.PWORKER_HOME ?? path.join(process.env.HOME ?? '', '.pworker')) {
  const dir = path.join(home, 'data'), out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).filter(f => /^requests-.*\.jsonl$/.test(f))) for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
    if (!line.includes('"run":"mrp-')) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    const a = out.get(r.run) ?? {requests: 0, in_tokens: 0, out_tokens: 0, models: {}};
    a.requests++; a.in_tokens += r.in_tokens ?? 0; a.out_tokens += r.out_tokens ?? 0; a.models[r.model] = (a.models[r.model] ?? 0) + 1;
    out.set(r.run, a);
  }
  return out;
}

async function run(args) {
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const suites = opt('--suites', Object.keys(SUITES).join(',')).split(',');
  const strategies = opt('--strategies', STRATEGIES.join(',')).split(',');
  const tier = opt('--tier', 'fast'), limit = Number(opt('--limit', 1e9)), concurrency = Number(opt('--concurrency', 4)), normalize = opt('--normalize', null), retrieve = opt('--retrieve', null);
  // --retrieve names a retrieve strategy (lib/mrp/retrieve.mjs): its candidate predicates reach the one-shot formalizer through the turn policy.
  if (retrieve && retrieve !== 'graph-walk' && retrieve !== 'slice') await startStrategyService();
  // The normalize slot of a throw-away Model (passthrough everywhere else), when --normalize is given.
  let normalizeText = async text => ({english: text, language: null, ms: 0});
  if (normalize) {
    const models = new Models({root: path.join(ROOT, 'state/mrp-eval/models')});
    const id = `bench-${normalize}`;
    if (models.exists(id)) models.delete(id);
    models.create({id, slots: {normalize: {strategy: normalize, params: normalize === 'passthrough' ? {} : {tier, ...(['translate-llm', 'proofread-llm'].includes(normalize) ? {context: 0} : {})}}, reflex: 'off', affect: 'off'}});
    const mrp = createMrpPipeline({models, client: purpose => pworker({purpose: 'job:mrp-formalize', run: `mrp-normalize-${normalize}`, priority: 'background'})});
    normalizeText = async text => { const t0 = Date.now(); const pre = await mrp.before({modelId: id, text}); return {english: pre.english, language: pre.language, ms: Date.now() - t0}; };
  }
  const {root} = prepareRoot();
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/runtime.json'), 'utf8'));
  fs.mkdirSync(OUT, {recursive: true});
  for (const suite of suites) {
    const rows = fs.readFileSync(path.join(ROOT, SUITES[suite].file), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).slice(0, limit);
    for (const strategy of strategies) {
      const label = [strategy, normalize, retrieve].filter(Boolean).join('+');
      const out = path.join(OUT, `${suite}-${label}-${tier}.jsonl`);
      if (args.includes('--force')) fs.rmSync(out, {force: true});
      const done = new Set(fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).id) : []);
      const todo = rows.filter(r => !done.has(r.id));
      if (!todo.length) continue;
      const session = openSession({base: SUITES[suite].base, root, id: `mrp-${suite}-${strategy}-${Date.now().toString(36)}`.toLowerCase()});
      // One Ploinky run tag per strategy and run, so the request log counts its model calls and tokens (report).
      const run = `mrp-formalize-${suite}-${strategy}-${tier}-${Date.now().toString(36)}`;
      const chat = harnessChat({config, tier, strategy: MODES[strategy] ? null : strategy, mode: MODES[strategy] ?? 'stepwise', source: 'eval:mrp-formalize', tags: {purpose: 'job:mrp-formalize', run}});
      const queue = [...todo];
      await Promise.all(Array.from({length: concurrency}, async () => {
        for (let row; (row = queue.shift());) {
          const started = Date.now();
          let result = null, parse = null, error = null;
          const entry = session.store.get('mrp', `c-${row.id}`, BASE_NAME);
          const n = await normalizeText(row.question);
          entry.agent.turnPolicy = retrieve ? {retrieval: await retrieveCandidates({strategy: retrieve, memory: SUITES[suite].base, english: n.english, lexicon: session.lexicon, circuits: session.sessions.baseCircuits(session.id)})} : null;
          try { const turned = await chat.turn(entry, n.english, {lexicon: session.lexicon}); result = turned.result; parse = turned.parse; } catch (e) { error = e; parse = e.parse ?? null; }
          const packet = result?.packet ?? null;
          const record = {id: row.id, form: row.form, question: row.question, ...(normalize ? {english: n.english, language: n.language, normalize_ms: n.ms} : {}), gold: row.gold, suite, strategy: label, tier, outcome: outcomeOf(row.gold, packet, error), status: packet?.status ?? null,
            text: (result?.text ?? '').slice(0, 300), model_sop: result?.sop ?? null, error: error ? String(error.message).slice(0, 300) : null, calls: callsOf(parse),
            ensemble: parse?.ensemble?.agreement ?? null, run, total_ms: Date.now() - started};
          fs.appendFileSync(out, JSON.stringify(record) + '\n');
          console.error(suite, strategy, record.id, record.outcome, record.status ?? '-', `${record.total_ms}ms`);
        }
      }));
      session.close();
      await chat.close();
    }
  }
  report();
}

/** report.json and report.md from every row file of the output folder. */
export function report() {
  const files = fs.existsSync(OUT) ? fs.readdirSync(OUT).filter(f => f.endsWith('.jsonl')) : [];
  const groups = {};
  for (const f of files) for (const line of fs.readFileSync(path.join(OUT, f), 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(line);
    ((groups[r.suite] ??= {})[`${r.strategy}@${r.tier}`] ??= []).push(r);
  }
  const summary = Object.fromEntries(Object.entries(groups).map(([suite, by]) => [suite, Object.fromEntries(Object.entries(by).map(([k, rows]) => [k, summarize(rows)]))]));
  fs.mkdirSync(OUT, {recursive: true});
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({date: new Date().toISOString(), summary}, null, 2) + '\n');
  const lines = ['# Formalize slot benchmark', ''];
  for (const [suite, by] of Object.entries(summary)) {
    lines.push(`## ${suite}`, '', '| strategy | n | correct | wrong | honest unknown | parser failed | accuracy | answerable acc. | abstention | wrong rate | mean ms | calls/q | tokens/q |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const [k, s] of Object.entries(by).sort((a, b) => b[1].accuracy - a[1].accuracy)) lines.push(`| ${k} | ${s.n} | ${s.correct} | ${s.wrong} | ${s.honest_unknown} | ${s.parser_failed + s.error} | ${s.accuracy} | ${s.answerable_accuracy ?? '-'} | ${s.abstention ?? '-'} | ${s.wrong_rate} | ${s.mean_ms} | ${s.calls_per_question ?? '-'} | ${s.tokens_per_question ?? '-'} |`);
    lines.push('');
  }
  fs.writeFileSync(path.join(OUT, 'report.md'), lines.join('\n'));
  console.log(lines.join('\n'));
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args[0] === 'report') report(); else await run(args);
}
