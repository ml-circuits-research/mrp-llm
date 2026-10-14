#!/usr/bin/env node
/**
 * Runs the formalization regression set (eval/formalization-regression/cases.jsonl) on the step-by-step formalizer and scores it:
 *   node tools/eval/formalization/regression/run.mjs [--tier tiny] [--strategy LocalLLMStepByStep] [--ids a,b] [--cluster c] [--n N]
 *     [--workers 4] [--run-id ID] [--against RUN_ID] [--learned DIR] [--no-judge] [--purpose job:formalization-improve] [--priority background]
 * Every case is the product chat turn (tools/eval/books/system.mjs, the chat default base memory) with the problem text as the user
 * message, formalized on a Ploinky tier (default `tiny`, without the tier's fallback so the tier is what is measured) and executed.
 * Scoring is the books evaluation's deterministic rules; what only a judge can decide goes to the Ploinky tier
 * `small` in packed calls, cached by (case, gold, answer) in state/formalization-regression/judge-cache.jsonl so a rerun with the
 * same answer costs nothing. `--learned DIR` runs with a candidate learned-rules layer instead of config/knowledge/formalizer-learned-v1.
 * The chat turn is CPU-bound JavaScript, so `--workers N` (default 4) runs N child processes (`--shard k/N`), one turn at a time each
 * (FR_WORKER_HEAP sets their heap in MB, default 12000); the parent merges their results and scores. A run folder resumes: cases
 * already in it are not run again.
 * Writes state/formalization-regression/<run-id>/{results.jsonl, score.json, summary.md}; `--against` adds fixed and lost cases.
 * Calls go through Ploinky tagged with `--purpose` (default `job:formalization-improve`) and the run id.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {loadCases, loadItems, loadAnnotations, resolveCase, STATE, ROOT} from './cases.mjs';
import {replayStore, modelIdentity} from '../../../../lib/formalize/replay-cache.mjs';

/** The record/replay cache of the regression (answers derived from the books: gitignored, DS011). */
export const REPLAY_DIR = process.env.FR_REPLAY_DIR ? path.resolve(process.env.FR_REPLAY_DIR) : path.join(ROOT, 'datasets_sources/formalization-regression/replay');
import {openChatTurn} from '../../books/system.mjs';
import {useConfiguredReplyLayer} from '../../../../lib/conversation/index.mjs';
import {attribution} from '../../books/attribution.mjs';
import {responseOf, deterministic, JUDGE_SYSTEM} from '../../books/score.mjs';
import {providerChat} from '../../../../lib/llm-providers.mjs';
import {useLearnedLayer} from '../../../../lib/formalize/protocol-data.mjs';

const opt = (args, name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const list = v => (v ? v.split(',').map(s => s.trim()).filter(Boolean) : null);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const readJsonl = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
export const OUTCOMES = ['correct', 'wrong', 'unknown', 'invalid', 'failed', 'pending'];

/** The failure cluster of a scored result, from structure only (the protocol's report, the outcome, the circuit). */
export function clusterOf(r) {
  if (r.outcome === 'correct') return null;
  if (r.outcome === 'failed') return 'infrastructure';
  if (r.slice === 'chat') return `chat:${r.source}:${r.report?.form ?? 'none'}`;
  const report = r.report ?? {};
  if (r.outcome === 'invalid') return 'invalid';
  // The problem questions were asked but ended early (the general protocol then took over, so the form is not `problem`).
  const askedProblem = (r.dialog ?? []).some(d => d.name === 'problem_kind');
  if (report.form !== 'problem' && askedProblem) return 'problem_unreadable';
  if (report.form !== 'problem') return report.form ? `not_problem:${report.form}` : 'no_form';
  if (!report.problem) return 'problem_unreadable';
  const kind = report.problem.kind;
  if (r.outcome === 'unknown') return kind === 'deduce' ? 'deduce_unknown' : 'compute_unknown';
  return kind === 'deduce' ? 'deduce_wrong' : kind === 'choose' ? 'choose_wrong' : 'formula_wrong';
}

/** One turn → the stored result (the text and circuit stay in state/, never in git). */
function resultOf(c, r) {
  const system = attribution(r);
  let report = null;
  try { report = JSON.parse(r.parse?.report ?? system.understanding?.report ?? 'null'); } catch { /* none */ }
  return {id: c.id, ok: r.ok, ms: r.ms, status: system.status, text: r.text ?? null, error: r.error ?? null, sop: r.sop ?? r.parse?.sop ?? null,
    report, dialog: r.parse?.dialog ?? null, questions: r.parse?.steps ?? null, system};
}

function scoreOf(c, res) {
  const rec = {arm: 'steps', ok: res.ok, text: res.text, error: res.error, system: res.system, gold_kind: c.gold_kind, gold_value: c.gold_value};
  const resp = responseOf(rec);
  // A conversational message (small talk): correct when it was not turned into a lookup that fails or asks back.
  if (c.gold_kind === 'conversational') {
    const status = res.system?.status ?? null;
    const ok = res.ok && status && !['unclear', 'unknown', 'clarify', 'not_computable', 'unsupported'].includes(status);
    return {response: resp.text ?? null, verdict: {outcome: ok ? 'correct' : res.ok ? 'wrong' : resp.outcome ?? 'failed', by: 'rule', reason: `status ${status}`}};
  }
  const v = c.gold == null && c.gold_kind === 'none' ? {outcome: res.ok && !resp.declined ? 'correct' : resp.outcome ?? 'unknown', by: 'rule', reason: 'no gold: a valid answered circuit'} : deterministic(rec, resp);
  return {response: resp.text ?? null, verdict: v};
}

// The judge's cache key holds the judge model's identity and instructions, so a new judge model or prompt is a cache miss.
export const JUDGE_TIER = 'small';
const judgeKey = (c, response) => createHash('sha256').update(`${modelIdentity(JUDGE_TIER)}\0${JUDGE_SYSTEM}\0${c.id}\0${c.gold}\0${response}`).digest('hex').slice(0, 24);

/** Judges the undecided results (cached), `perCall` items per request on the Ploinky tier `tier`. */
export async function judge(pending, {tier = JUDGE_TIER, perCall = 8, purpose, cacheFile = path.join(STATE, 'judge-cache.jsonl')} = {}) {
  const cache = new Map(readJsonl(cacheFile).map(r => [r.key, r]));
  const todo = pending.filter(p => !cache.has(judgeKey(p.c, p.response)));
  let calls = 0;
  for (let i = 0; i < todo.length; i += perCall) {
    const part = todo.slice(i, i + perCall).map((p, k) => ({j: `j${k + 1}`, p}));
    const prompt = JSON.stringify(part.map(({j, p}) => ({j, problem: p.c.message.slice(0, 1800), gold_answer: String(p.c.gold).slice(0, 600), candidate_answer: String(p.response ?? '').slice(0, 900)})));
    const run = await providerChat({system: JUDGE_SYSTEM, prompt, provider: tier, purpose}); calls++;
    let verdicts = [];
    try { verdicts = JSON.parse(run.text.slice(run.text.indexOf('['), run.text.lastIndexOf(']') + 1)); } catch { /* stays pending */ }
    for (const v of Array.isArray(verdicts) ? verdicts : []) {
      const hit = part.find(x => x.j === v.j);
      if (!hit || !['correct', 'partial', 'wrong', 'unanswered'].includes(v.verdict)) continue;
      const row = {key: judgeKey(hit.p.c, hit.p.response), id: hit.p.c.id, verdict: v.verdict, model: run.model};
      cache.set(row.key, row);
      fs.mkdirSync(path.dirname(cacheFile), {recursive: true});
      fs.appendFileSync(cacheFile, JSON.stringify(row) + '\n');
    }
  }
  for (const p of pending) {
    const v = cache.get(judgeKey(p.c, p.response));
    p.verdict = v ? {outcome: {correct: 'correct', partial: 'wrong', wrong: 'wrong', unanswered: 'unknown'}[v.verdict], by: 'judge', judge: v.verdict} : {outcome: 'pending', by: 'judge'};
  }
  return {calls, cached: pending.length - todo.length, model: modelIdentity(tier)};
}

/** Fixed and lost cases of `run` against `base` (results of the same case ids). */
export function compareRuns(run, base) {
  const before = new Map(base.map(r => [r.id, r.outcome])), fixed = [], lost = [];
  for (const r of run) {
    if (!before.has(r.id)) continue;
    const was = before.get(r.id) === 'correct', now = r.outcome === 'correct';
    if (now && !was) fixed.push(r.id);
    if (was && !now) lost.push(r.id);
  }
  return {fixed, lost, compared: run.filter(r => before.has(r.id)).length};
}

export async function runRegression({tier = 'tiny', strategy = 'LocalLLMStepByStep', ids = null, cluster = null, n = null, concurrency = 4, workers = 1, shard = null, replay = 'fill', thinking = false, minTokens = null, bookIds = null, ladder = null, expression = false, score = true, runId = null, against = null, learned = null,
  useJudge = true, purpose = 'job:formalization-improve', priority = null, log = m => console.error(m)} = {}) {
  const items = loadItems(), annotations = loadAnnotations();
  // `bookIds`: book problems outside the regression set (an evaluation sample), as cases built on the fly.
  let cases = bookIds ? bookIds.map(b => ({id: `books/${b}`, source: 'books', provenance: {problem_id: b}, runnable: true})) : loadCases().filter(c => c.runnable);
  if (ids) cases = cases.filter(c => ids.includes(c.id));
  if (cluster) {
    const base = against ? readJsonl(path.join(STATE, against, 'results.jsonl')) : [];
    const inCluster = new Set(base.filter(r => r.cluster === cluster).map(r => r.id));
    cases = cases.filter(c => inCluster.has(c.id));
  }
  if (n) cases = cases.slice(0, n);
  const resolved = cases.map(c => resolveCase(c, {items, annotations})).filter(Boolean);
  if (resolved.length < cases.length) log(`${cases.length - resolved.length} case(s) skipped: their source text is not available locally`);
  const id = runId ?? `run-${stamp()}`;
  const dir = path.join(STATE, id);
  fs.mkdirSync(dir, {recursive: true});
  const restore = learned ? useLearnedLayer(path.resolve(ROOT, learned)) : null;
  const file = path.join(dir, 'results.jsonl');
  const shardFiles = () => fs.readdirSync(dir).filter(f => /^results\.shard-\d+\.jsonl$/.test(f)).map(f => path.join(dir, f));
  const done = new Map([file, ...shardFiles()].flatMap(f => readJsonl(f)).map(r => [r.id, r]));
  // A shard (`--shard k/N`, a child process of `--workers N`) takes every N-th open case and writes its own results file.
  const queue = resolved.filter(c => !done.has(c.id)).filter((c, i) => !shard || i % shard.of === shard.k);
  const out = shard ? path.join(dir, `results.shard-${shard.k}.jsonl`) : file;
  // The children of `--workers` read the book sample from a file in the run folder (an evaluation sample is not in the regression set).
  const bookIdsFile = () => { const f = path.join(dir, 'book-ids.txt'); fs.writeFileSync(f, bookIds.join('\n') + '\n'); return f; };
  if (!shard && workers > 1 && queue.length > 1) {
    // The chat turn is CPU-bound JavaScript: parallel turns need processes, not promises. Each worker is a child process.
    const children = Array.from({length: Math.min(workers, queue.length)}, (_, k) => new Promise(resolve => {
      const child = spawn(process.execPath, [`--max-old-space-size=${Math.max(8000, Number(process.env.FR_WORKER_HEAP ?? 12000))}`, fileURLToPath(import.meta.url), '--run-id', id, '--shard', `${k}/${Math.min(workers, queue.length)}`,
        '--tier', tier, '--strategy', strategy, '--purpose', purpose, ...(priority ? ['--priority', priority] : []), '--replay', replay ?? 'off', '--concurrency', String(concurrency), ...(ladder ? ['--ladder'] : []), ...(expression ? ['--expression'] : []), ...(thinking ? ['--thinking'] : []), ...(minTokens ? ['--min-tokens', String(minTokens)] : []), ...(bookIds ? ['--book-ids', bookIdsFile()] : ['--ids', resolved.map(c => c.id).join(',')]), ...(learned ? ['--learned', learned] : []), '--no-score'], {cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe']});
      child.stderr.on('data', d => { for (const line of String(d).split('\n')) if (/^\[\d+\/\d+\]/.test(line)) log(`w${k} ${line}`); });
      child.on('exit', code => resolve(code));
    }));
    const codes = await Promise.all(children);
    if (codes.some(c => c !== 0)) log(`worker exit codes: ${codes.join(', ')}`);
    for (const r of shardFiles().flatMap(f => readJsonl(f))) done.set(r.id, r);
    queue.length = 0;
  }
  const tags = {purpose, run: id, noFallback: true, ...(priority ? {priority} : {})};
  // The chat's reply memory (config conversation.layers), as the server has it: its message acts are what the formalizer may name.
  await useConfiguredReplyLayer(JSON.parse(fs.readFileSync(path.join(ROOT, 'config/runtime.json'), 'utf8')));
  const started = Date.now();
  let k = done.size;
  const worker = async w => {
    const system = await openChatTurn({tier, strategy, sessionId: `formalization-regression-${process.pid}-${w}`, parserOptions: {reportErrors: false}, tags, ...(replay ? {replay: {mode: replay, dir: REPLAY_DIR}} : {}), ladder: Boolean(ladder), localExtra: {...(thinking ? {thinking: true} : {}), ...(minTokens ? {minTokens} : {}), ...(expression ? {expression: true} : {})}});
    try {
      for (let c = queue.shift(); c; c = queue.shift()) {
        let r = await system.ask(c.message);
        // A busy Ploinky proxy can miss its 2 s readiness probe: the turn is tried again (twice at most) before it counts as infrastructure.
        for (let retry = 0; retry < 2 && replay !== 'replay' && !r.ok && r.error?.code === 'parse_unavailable'; retry++) {
          await new Promise(resolve => setTimeout(resolve, 5000));
          r = await system.ask(c.message);
        }
        const res = resultOf(c, r);
        fs.appendFileSync(out, JSON.stringify(res) + '\n');
        done.set(c.id, res);
        log(`[${++k}/${resolved.length}] ${c.id} ${res.ok ? res.status : 'ERR ' + res.error?.code} ${res.report?.form ?? ''}${res.report?.problem ? '/' + res.report.problem.kind : ''} ${res.ms} ms`);
      }
    } finally { await system.close(); }
  };
  try { if (queue.length) await Promise.all(Array.from({length: Math.max(1, Math.min(concurrency, queue.length))}, (_, w) => worker(w))); } finally { restore?.(); }
  if (!score) return {run: id, shard, done: done.size};
  // Score: rules first, then the cached judge for the rest.
  const scored = resolved.filter(c => done.has(c.id)).map(c => ({c, res: done.get(c.id), ...scoreOf(c, done.get(c.id))}));
  const pending = scored.filter(s => !s.verdict);
  const judged = useJudge && pending.length ? await judge(pending, {purpose}) : {calls: 0, cached: 0};
  for (const s of pending) s.verdict ??= {outcome: 'pending', by: 'judge'};
  const results = scored.map(s => {
    const r = {...s.res, gold_kind: s.c.gold_kind, ...(s.c.slice ? {slice: s.c.slice, source: s.c.source} : {}), response: s.response, outcome: s.verdict.outcome, by: s.verdict.by, ...(s.verdict.judge ? {judge: s.verdict.judge} : {})};
    r.cluster = clusterOf(r);
    return r;
  });
  fs.writeFileSync(file, results.map(r => JSON.stringify(r)).join('\n') + '\n');
  for (const f of shardFiles()) fs.rmSync(f);
  const counts = Object.fromEntries(OUTCOMES.map(o => [o, results.filter(r => r.outcome === o).length]));
  const clusters = {};
  for (const r of results) if (r.cluster) clusters[r.cluster] = (clusters[r.cluster] ?? 0) + 1;
  const base = against ? readJsonl(path.join(STATE, against, 'results.jsonl')) : null;
  const comparison = base ? compareRuns(results, base) : null;
  // Every correct formalization is kept as a positive example (message hash, circuit, answer, provenance): regression gold and a
  // source of protocol examples. It derives from the books, so it stays in the gitignored datasets_sources/ (DS011).
  const good = results.filter(r => r.outcome === 'correct' && r.sop);
  if (good.length) {
    const file = path.join(ROOT, 'datasets_sources/formalization-regression/good.jsonl');
    fs.mkdirSync(path.dirname(file), {recursive: true});
    const have = new Set(readJsonl(file).map(g => `${g.id}\0${g.circuit}`));
    for (const r of good) if (!have.has(`${r.id}\0${r.sop}`)) fs.appendFileSync(file, JSON.stringify({id: r.id, circuit: r.sop, answer: r.response, run: id, tier, strategy, learned: learned ?? null, at: new Date().toISOString()}) + '\n');
  }
  const store = replay ? replayStore(REPLAY_DIR) : null;
  const misses = results.filter(r => /replay_miss/.test(r.error?.message ?? '')).map(r => r.id);
  if (store?.missed.length) fs.writeFileSync(path.join(dir, 'replay-missed.json'), JSON.stringify(store.missed, null, 1));
  const scoreJson = {run: id, tier, strategy, ...(ladder ? {ladder} : {}), ...(expression ? {expression: true} : {}), ...(thinking || minTokens ? {thinking, min_tokens: minTokens} : {}), learned: learned ?? null, cases: results.length, ...counts, clusters,
    replay: replay ? {mode: replay, hits: store.hits, misses: store.misses, recorded: store.recorded, cases_missing: misses.length} : null,
    model_calls: {formalizer: replay === 'replay' ? 0 : store ? store.misses : null, judge: judged.calls}, judge: judged, against: against ?? null, ...(comparison ? {fixed: comparison.fixed, lost: comparison.lost} : {}),
    minutes: Math.round((Date.now() - started) / 600) / 100, finished: new Date().toISOString()};
  fs.writeFileSync(path.join(dir, 'score.json'), JSON.stringify(scoreJson, null, 1) + '\n');
  const top = Object.entries(clusters).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k2, v]) => `${k2} ${v}`).join(', ');
  fs.writeFileSync(path.join(dir, 'summary.md'), [`# Formalization regression ${id}`, '',
    `- tier ${tier}, ${strategy}${learned ? `, learned layer ${learned}` : ''}: ${results.length} cases`,
    `- correct ${counts.correct}, wrong ${counts.wrong}, unknown ${counts.unknown}, invalid ${counts.invalid}, failed ${counts.failed}, pending ${counts.pending}`,
    `- clusters: ${top || 'none'}`,
    `- judge: ${judged.calls} call(s), ${judged.cached} cached; replay ${replay ?? 'off'}${store ? ` (${store.hits} answers replayed, ${store.misses} ${replay === 'replay' ? 'missing' : 'asked live'}${replay === 'replay' ? `, ${misses.length} case(s) with a new question` : ''})` : ''}; ${scoreJson.minutes} min`,
    ...(comparison ? [`- against ${against}: fixed ${comparison.fixed.length}, lost ${comparison.lost.length} (of ${comparison.compared})`] : [])].join('\n') + '\n');
  return scoreJson;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const out = await runRegression({tier: opt(args, '--tier', 'tiny'), strategy: opt(args, '--strategy', 'LocalLLMStepByStep'), ids: list(opt(args, '--ids', null)), cluster: opt(args, '--cluster', null),
    n: opt(args, '--n', null) ? Number(opt(args, '--n', null)) : null, concurrency: Number(opt(args, '--concurrency', 4)), workers: Number(opt(args, '--workers', 1)), thinking: args.includes('--thinking'), expression: args.includes('--expression'), bookIds: opt(args, '--book-ids', null) ? fs.readFileSync(opt(args, '--book-ids'), 'utf8').split(/[\s,]+/).filter(Boolean) : null, ladder: args.includes('--ladder') ? ['product'] : null, minTokens: opt(args, '--min-tokens', null) ? Number(opt(args, '--min-tokens', null)) : null, replay: opt(args, '--replay', 'fill') === 'off' ? null : opt(args, '--replay', 'fill'), runId: opt(args, '--run-id', null), against: opt(args, '--against', null),
    shard: opt(args, '--shard', null) ? {k: Number(opt(args, '--shard').split('/')[0]), of: Number(opt(args, '--shard').split('/')[1])} : null, score: !args.includes('--no-score'),
    learned: opt(args, '--learned', null), useJudge: !args.includes('--no-judge'), purpose: opt(args, '--purpose', 'job:formalization-improve'), priority: opt(args, '--priority', null)});
  if (!out.cases) { console.log(JSON.stringify(out)); process.exit(0); }
  const {fixed, lost, ...rest} = out;
  console.log(JSON.stringify({...rest, ...(fixed ? {fixed: fixed.length, lost: lost.length, lost_ids: lost} : {})}));
}
