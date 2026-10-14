#!/usr/bin/env node
/**
 * Report driver of the llm-agent baseline (advisory LLM through Ploinky Workers). Costs real model calls: it refuses to run unless SMOKE_LLM=1.
 *
 *   SMOKE_LLM=1 node eval/smoke-reasoning/bench/llm-agent-report.mjs --model Qwen3.8 27b --presentation sop|nl|both [--case 07] [--subset nl] [--concurrency 4] [--refresh] [--verify]
 *   node eval/smoke-reasoning/bench/llm-agent-report.mjs --summary          (no model calls: rebuild eval/reports/current/llm-agent/summary.md from the per-run files)
 *
 * For each case it records the agreement with the oracle's expected answer in two ways: FULL (the harness `compare`, including wire ids such as
 * `used`, `conditional`, `blocked_by`) and CORE (status, rows, count, bound, reason, witness, objective, plan, hypotheses, missing, blockers: the
 * answer content without wire ids, the only fair measure for the `nl` presentation, which has no ids). The answers are advisory: nothing here
 * makes them ground truth. Output: eval/reports/current/llm-agent/<model>.<presentation>.json (gitignored, regenerable).
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadCases} from '../run.mjs';
import {compare} from '../lib/compare.mjs';
import {llmAgent, NotExpressibleError} from '../../../reasoning/strategies/llm-agent/index.mjs';
import {sourceOf} from '../adapters/llm-agent.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '../../reports/current/llm-agent');
const args = process.argv.slice(2);
const opt = (n, d = null) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const flag = n => args.includes(n);

const CORE_KEYS = ['status', 'complete', 'rows', 'rows_subset_of', 'min_rows', 'count', 'bound', 'reason', 'witness', 'objective', 'plan', 'hypotheses', 'missing', 'blockers', 'budget', 'acceptable_if_incomplete'];
/** nl answers are compared after squashing the spelling of names (case, spaces, hyphens, underscores): the text names things in prose, the wires in symbols. */
const squash = v => (typeof v === 'string' ? v.toLowerCase().replace(/[^a-z0-9]/g, '') : v);
const squashAll = e => ({...e, rows: e.rows?.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, squash(v)]))), rows_subset_of: e.rows_subset_of?.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, squash(v)]))), plan: e.plan && {...e.plan, names: e.plan.names?.map(squash)}, hypotheses: e.hypotheses?.map(h => h.map(a => a.split(' ').map(squash).join(' '))), missing: e.missing?.map(h => h.map(a => a.split(' ').map(squash).join(' '))), blockers: e.blockers?.map(a => a.split(' ').map(squash).join(' '))});
const coreOf = e => Object.fromEntries(CORE_KEYS.filter(k => k in e).map(k => [k, e[k]]));
// the core comparison also drops the wire-id fields of the answer: `conditional`, `used`, `blocked_by`, `compliance` details are in FULL only

/** Failure family of a case, from its required features, in priority order (the first family that applies). */
export function familyOf(expected) {
  const r = new Set(expected.requires ?? []);
  const any = (...f) => f.some(x => r.has(x));
  if (any('budget', 'budget_probes') || expected.budget) return 'budget honesty';
  if (any('plan', 'method', 'htn_choice', 'on_failure', 'norms_hard', 'norms_soft', 'temporal_norms', 'procedures', 'procedure_render', 'amendment', 'check_plan', 'blocked_info', 'abduce_waive', 'abduce')) return 'planning';
  if (any('temporal', 'interval', 'throughout', 'time_vars', 'snapshot_derived')) return 'time';
  if (any('compute_in_rules', 'compare_in_rules', 'constraint', 'optimize')) return 'arithmetic';
  if (any('count', 'aggregate')) return 'counting';
  if (any('default', 'overrides', 'strict_contrary')) return 'defaults';
  if (any('naf', 'closed_world', 'closed_derived', 'open_world', 'classical_negation', 'conflict', 'every', 'integrity')) return 'negation and closed world';
  if (any('epistemic_status', 'whatif')) return 'assumptions (conditional)';
  return 'basic reasoning';
}

async function runCase(c, presentation, model, verify, reasoning) {
  const t0 = Date.now();
  const rec = {case: c.dir, feature: c.expected.feature, family: familyOf(c.expected), presentation, reasoning, model};
  const source = sourceOf(c.dir);
  if (presentation === 'nl' && !source) return {...rec, result: 'no_source'};
  try {
    const got = await llmAgent.ask({theory: {knowledge: c.knowledge}, query: c.query, source}, {}, {presentation, model, verify, reasoning, fallbackModels: []});
    if (verify && c.expected.used_support && got.verified === false) got.used_replay = {ok: false, why: 'the oracle does not re-derive the answer from the claimed used support'};
    const full = compare(c.expected, got), core = presentation === 'nl' ? compare(squashAll(coreOf(c.expected)), squashAll(coreOf(got))) : compare(coreOf(c.expected), coreOf(got));
    if (got.status === 'error' && got.reason === 'provider') return {...rec, result: 'provider_error', why: [String(got.detail).split('\n')[0]], cost: got.llm.cost};
    const err = got.status === 'error';
    return {...rec, result: err ? 'error' : full.ok ? 'pass' : 'fail', core: err ? 'error' : core.ok ? 'pass' : 'fail', status: got.status, expected_status: c.expected.status, why: full.why, core_why: core.why, cost: got.llm.cost, notional_cost: got.llm.notional_cost ?? got.llm.cost, paid: got.llm.paid, cached: got.llm.cached, ms: got.llm.original_ms ?? Date.now() - t0, tokens: got.llm.tokens, verified: got.verified, detail: got.detail ?? got.reason, raw: got.llm.raw, answered_by: got.llm.model, answer: {status: got.status, rows: got.rows, count: got.count, bound: got.bound, plan: got.plan}};
  } catch (e) {
    if (e instanceof NotExpressibleError) return {...rec, result: 'not_expressible', why: [e.message]};
    return {...rec, result: 'error', core: 'error', why: [String(e.message).split('\n')[0]]};
  }
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({length: n}, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

const slug = m => m.replace(/[^a-z0-9.]+/gi, '_');

async function main() {
  if (flag('--summary')) return (await import('./llm-agent-summary.mjs')).writeSummary(outDir);
  if (process.env.SMOKE_LLM !== '1') { console.error('refusing to call a model: set SMOKE_LLM=1'); return 2; }
  const model = opt('--model', 'Qwen3.8 27b');
  const pres = opt('--presentation', 'both') === 'both' ? ['sop', 'nl'] : [opt('--presentation')];
  const reasoning = opt('--reasoning', 'cot');
  const cases = loadCases(opt('--case')).filter(c => opt('--subset') !== 'nl' || sourceOf(c.dir));
  fs.mkdirSync(outDir, {recursive: true});
  for (const presentation of pres) {
    const chosen = presentation === 'nl' ? cases.filter(c => sourceOf(c.dir)) : cases;
    const t0 = Date.now();
    const rows = await pool(chosen, Number(opt('--concurrency', 4)), c => runCase(c, presentation, model, flag('--verify'), reasoning));
    const file = path.join(outDir, `${slug(model)}.${presentation}.${reasoning}${opt('--subset') ? '.subset-' + opt('--subset') : ''}${opt('--tag') ? '.' + opt('--tag') : ''}.json`);
    if (opt('--case')) fs.writeFileSync(file.replace('.json', '.partial.json'), JSON.stringify({generated: new Date().toISOString(), model, presentation, rows}, null, 1));
    else fs.writeFileSync(file, JSON.stringify({generated: new Date().toISOString(), note: 'Regenerable observation of the advisory llm-agent baseline; answers are never ground truth.', model, presentation, reasoning, subset: opt('--subset'), verify: flag('--verify'), wall_ms: Date.now() - t0, rows}, null, 1));
    const t = r => rows.filter(x => x.result === r).length;
    const cost = rows.reduce((s, x) => s + (x.cached ? 0 : x.cost ?? 0), 0);
    console.log(`${model} ${presentation} ${reasoning}: ${rows.length} cases, full pass ${t('pass')}, core pass ${rows.filter(x => x.core === 'pass').length}, fail ${t('fail')}, error ${t('error')}, not expressible ${t('not_expressible')}; new notional cost ${cost.toFixed(4)} USD; ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    for (const r of rows.filter(x => x.result === 'fail' || x.result === 'error')) console.log(`  ${r.result} ${r.case} [${r.family}] core ${r.core}: ${(r.core === 'fail' ? r.core_why : r.why).join('; ').slice(0, 220)}`);
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main());
