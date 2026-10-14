#!/usr/bin/env node
/**
 * Recording and references of the offline formalization regression (owner request 2026-10-03), the library under the TaskLambdas
 * `regression-record` and `regression-reference` (jobs/lambdas/regression.mjs):
 *   record     a tier answers the step-by-step questions of a case set through the CURRENT protocol and the product chat turn
 *              (run.mjs: ChatSOPAdapter's stepwise path, the chat default base, the tier without fallback, the record/replay cache in
 *              fill mode); its problem-mode answers become recordings keyed by tier and model (offline.mjs `recordingFile`), so the
 *              offline regression replays them with no model and the recordings of an earlier model stay replayable.
 *   reference  the same, for the larger tiers (`small`, `medium`, `good`) on a stratified sample: the SAME questions, never a one-shot
 *              circuit, so `offline.mjs attribute` compares readings step by step and swaps answers counterfactually.
 * Each recording run registers its run id with Ploinky (a budget of calls and plan credits), so the server refuses calls beyond it and
 * its `/jobs` spend (calls, USD, plan credits) is the cost reported. Cloud tiers run at `background` priority: Ploinky serves them only
 * when nothing else waits and within 70% of each plan window.
 *   node tools/eval/formalization/regression/record.mjs record --tier tiny [--set recorded|cases] [--ids a,b] [--n N] [--run-id ID]
 *   node tools/eval/formalization/regression/record.mjs reference --tier small --n 60 [--seed s] [--from tiny@model] [--failing]
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {loadCases, loadItems, STATE} from './cases.mjs';
import {importRun, loadRecordings, recordingSource, modelSlug, loadFloor} from './offline.mjs';
import {modelIdentity} from '../../../../lib/formalize/replay-cache.mjs';

export const LOCAL_TIERS = Object.freeze(['nano', 'micro', 'supertiny', 'tiny']);
export const REFERENCE_TIERS = Object.freeze(['small', 'medium', 'good']);
/** Plan credits per call of the cloud tiers' first models (the Ploinky user configuration (~/.pworker/config.json) notes), for a budget before the run. */
const CREDITS_PER_CALL = {small: 0.1, medium: 0.75, good: 0.75};
/** Step-by-step questions per case observed in the runs of 2026-10-02/03 (about 7 per turn; a re-ask counts as a call). */
const CALLS_PER_CASE = 10;
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const hash = (seed, s) => createHash('sha256').update(`${seed}/${s}`).digest('hex');

/** The stratum of a case: a book problem by book and chapter (the section's leading number), any other case by its source. */
export function stratumOf(id, items = null) {
  if (!id.startsWith('books/')) return id.split('/')[0];
  const item = items?.get(id.slice(6));
  const book = id.slice(6).split(':')[0];
  return item ? `${book}/${String(item.section ?? item.area ?? '').split(/[\s.]/)[0] || item.chapter || '-'}` : book;
}

/** A seeded stratified sample of `n` ids: strata in a seeded order, cycled, a seeded order inside each; deterministic for a seed. */
export function stratifiedSample(ids, n, {seed = 'reference', strata = id => id.split('/')[0]} = {}) {
  const groups = new Map();
  for (const id of [...ids].sort((a, b) => hash(seed, a).localeCompare(hash(seed, b)))) (groups.get(strata(id)) ?? groups.set(strata(id), []).get(strata(id))).push(id);
  const queues = [...groups.keys()].sort((a, b) => hash(seed, a).localeCompare(hash(seed, b))).map(k => groups.get(k));
  const out = [];
  for (let k = 0; out.length < n && queues.some(q => q.length); k++) { const q = queues[k % queues.length]; if (q.length) out.push(q.shift()); }
  return out;
}

/** The case ids of a set: `recorded` (the ids of the floor's recordings), `cases` (every runnable case), `failed` (see below), or explicit ids. */
export function caseIds({set = 'recorded', ids = null, from = null} = {}) {
  if (ids?.length) return ids;
  const runnable = new Set(loadCases().filter(c => c.runnable).map(c => c.id));
  if (set === 'cases') return [...runnable];
  // `failed`: the cases whose recording by the tier's current model holds a call that gave no answer (a transport failure, a cut
  // reply), recorded again; the later recording of an id replaces the earlier one.
  if (set === 'failed') { const [t] = (from ?? 'tiny').split('@'); return [...loadRecordings(t).values()].filter(r => r.steps.some(s => s.failed) && runnable.has(r.id)).map(r => r.id); }
  const floor = loadFloor();
  const [tier, model] = (from ?? `${floor?.tier ?? 'tiny'}@${floor?.model ?? 'legacy'}`).split('@');
  // A recorded id that is no longer a runnable case (a duplicate of a chat-slice case) is not recorded again.
  return [...loadRecordings(tier, {model}).keys()].filter(id => runnable.has(id));
}

/** The spend of a registered run, from Ploinky's /jobs (calls, USD, plan credits); null when the server does not list it. */
export async function runSpend(ta, run) {
  try { return (await ta.jobs()).runs?.find(r => r.run === run)?.spent ?? null; } catch { return null; }
}

/**
 * Records the answers of `tier` on `ids` (a regression run, then an import). Returns {run, tier, model, cases, recorded, not_problem,
 * outcomes, spend, file}. `runner` is run.mjs `runRegression` (injected in tests); `ta` a Ploinky client (budget and spend).
 */
export async function recordTier({tier = 'tiny', ids, runId = null, priority = null, purpose = 'job:formalization-regression', workers = 2, concurrency = 2, budget = null, useJudge = true, ta = null, runner = null, log = m => console.error(m)}) {
  const run = runId ?? `rec-${tier}-${stamp()}`;
  const cloud = !LOCAL_TIERS.includes(tier);
  const pri = priority ?? (cloud ? 'background' : 'normal');
  const model = modelIdentity(tier);
  // The run's budget: the calls of a case set at about CALLS_PER_CASE each, twice over; plan credits from the tier's price per call.
  const limit = budget ?? {calls: Math.max(50, ids.length * CALLS_PER_CASE * 2), ...(cloud ? {credits: Math.ceil(ids.length * CALLS_PER_CASE * 2 * (CREDITS_PER_CALL[tier] ?? 1))} : {})};
  if (ta) { try { await ta.registerRun({job: 'formalization-regression', run, purpose, budget: limit}); } catch (e) { log(`budget not registered: ${e.message}`); } }
  log(`recording ${ids.length} case(s) on ${tier} (${model}), priority ${pri}, run ${run}`);
  const runRegression = runner ?? (await import('./run.mjs')).runRegression;
  const score = await runRegression({tier, ids, runId: run, replay: 'fill', workers, concurrency, purpose, priority: pri === 'normal' ? null : pri, useJudge, log});
  const imported = importRun(run, tier, {model});
  const spend = ta ? await runSpend(ta, run) : null;
  if (ta) { try { await ta.finishRun({run}); } catch { /* listed as running */ } }
  const outcomes = Object.fromEntries(['correct', 'wrong', 'unknown', 'invalid', 'failed', 'pending'].map(o => [o, score?.[o] ?? 0]));
  const out = {run, tier, model, slug: modelSlug(model), priority: pri, cases: ids.length, ...imported, file: path.relative(process.cwd(), imported.file), outcomes, replay: score?.replay ?? null, spend};
  fs.writeFileSync(path.join(STATE, run, 'recording.json'), JSON.stringify({...out, at: new Date().toISOString()}, null, 1) + '\n');
  return out;
}

/**
 * The ids a reference run needs: a stratified sample of `n` from the floor's recordings (`failing`: only the cases the recorded tier
 * does not answer correctly, as the attribution needs), minus the ids this tier's current model already recorded.
 */
export async function referenceIds({tier, n = 60, seed = 'reference-v1', from = null, failing = false, ids = null}) {
  const items = loadItems();
  let pool = caseIds({set: 'recorded', from, ids});
  if (failing) {
    const {runOffline} = await import('./offline.mjs');
    const [t, m] = (from ?? `${loadFloor()?.tier ?? 'tiny'}@${loadFloor()?.model ?? 'legacy'}`).split('@');
    const out = await runOffline({tier: t, model: m, refTiers: []});
    const bad = new Set(out.results.filter(r => r.outcome !== 'correct' && r.outcome !== 'not_problem').map(r => r.id));
    pool = pool.filter(id => bad.has(id));
  }
  const have = recordingSource(tier).model === modelSlug(modelIdentity(tier)) ? loadRecordings(tier) : new Map();
  const sample = ids?.length ? pool : stratifiedSample(pool, n, {seed, strata: id => stratumOf(id, items)});
  return {ids: sample.filter(id => !have.has(id)), already: sample.filter(id => have.has(id)), pool: pool.length};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  const opt = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
  const {pworker} = await import('../../../../lib/pworker.mjs');
  const purpose = opt('--purpose', 'job:formalization-regression');
  const ta = pworker({purpose});
  const tier = opt('--tier', cmd === 'reference' ? 'small' : 'tiny');
  const list = opt('--ids') ? opt('--ids').split(',') : null;
  let ids;
  if (cmd === 'record') ids = caseIds({set: opt('--set', 'recorded'), ids: list, from: opt('--from') ?? (opt('--set') === 'failed' ? tier : null)}).slice(0, opt('--n') ? Number(opt('--n')) : undefined);
  else if (cmd === 'reference') ids = (await referenceIds({tier, n: Number(opt('--n', 60)), seed: opt('--seed', 'reference-v1'), from: opt('--from'), failing: args.includes('--failing'), ids: list})).ids;
  else { console.error('usage: record.mjs record|reference --tier T [--set recorded|cases] [--ids a,b] [--n N] [--seed s] [--from tier@model] [--failing] [--run-id ID] [--priority normal|background] [--workers N] [--concurrency N]'); process.exit(2); }
  if (!ids.length) { console.log(JSON.stringify({tier, cases: 0, note: 'nothing to record'})); process.exit(0); }
  const out = await recordTier({tier, ids, runId: opt('--run-id'), priority: opt('--priority'), purpose, workers: Number(opt('--workers', 2)), concurrency: Number(opt('--concurrency', 2)), ta});
  console.log(JSON.stringify(out));
}
