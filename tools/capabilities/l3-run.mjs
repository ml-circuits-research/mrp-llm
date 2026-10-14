#!/usr/bin/env node
/**
 * L3 of the capability battery: formalization, message -> circuit -> answer. Every case of eval/capabilities/l3/catalog.jsonl (messages
 * written for the battery, never book or sealed text) is one product chat turn, exactly as the formalization regression runner
 * (tools/eval/formalization/regression/run.mjs) runs it: `openChatTurn` of tools/eval/books/system.mjs on a Ploinky tier (default `tiny`,
 * without the tier's fallback), the chat default base memory, one conversation per case. It is scored by the books evaluation's
 * deterministic rules (no judge: what the rules cannot decide is `unknown`), and the circuit is tagged by tools/capabilities/tags.mjs
 * so the result says whether the formalization actually USED the capability the case lists.
 *
 *   node --max-old-space-size=12000 tools/capabilities/l3-run.mjs [--tier tiny] [--strategy LocalLLMStepByStep] [--ids a,b] [--n N] [--run-id ID]
 *                                      [--report-failures] [--report-only RUN_ID]
 * One process, one turn at a time: every chat-turn harness loads the default base memory (about 9 GB for world-v1), so parallel
 * processes overload the machine (coordinator, 2026-10-02). A run folder resumes: cases already in it are not run again.
 * Writes eval/reports/current/capabilities/l3/<run-id>/results.jsonl (texts and circuits: local only) and the compact
 * eval/capabilities/l3/results.json {run, tier, strategy, finished, cases: {id: {outcome, used}}} that tools/capabilities/check.mjs reads.
 * `--report-failures` sends every case that is not correct to the formalization inbox (lib/formalization-errors.mjs, source
 * `capability-battery`), the formalization improver's way in to its regression set; `--report-only RUN_ID` does that from a stored run.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openChatTurn} from '../eval/books/system.mjs';
import {attribution} from '../eval/books/attribution.mjs';
import {responseOf, deterministic} from '../eval/books/score.mjs';
import {reportFormalizationError} from '../../lib/formalization-errors.mjs';
import {circuitTags} from './tags.mjs';
import {ROOT} from './inventory.mjs';

export const CATALOG = path.join(ROOT, 'eval/capabilities/l3/catalog.jsonl');
export const COMPACT = path.join(ROOT, 'eval/capabilities/l3/results.json');
export const RUNS = path.join(ROOT, 'eval/reports/current/capabilities/l3');
const readJsonl = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const opt = (args, name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

export const loadCatalog = (file = CATALOG) => readJsonl(file);

/** The outcome of one turn: correct, wrong, unknown (declined or undecided by the rules), invalid, failed. */
export function scoreTurn(c, r) {
  const system = attribution(r);
  const rec = {arm: 'steps', ok: r.ok, text: r.text, error: r.error, system, gold_kind: c.gold_kind, gold_value: c.gold_value};
  const resp = responseOf(rec);
  const v = deterministic(rec, resp);
  return {outcome: v?.outcome ?? 'unknown', reason: v?.reason ?? 'undecided by the rules', response: resp.text ?? null, status: system.status ?? null};
}

/** Which of the case's target capabilities (`capabilities`; the scaffolding of every question is `context`) the circuit carries, by parsing it. */
export function usedCapabilities(c, sop) {
  let tags = new Set();
  try { if (sop) tags = circuitTags({text: sop}); } catch { /* an unreadable circuit uses nothing */ }
  // a query without a mode line asks `select` when it selects and `exists` otherwise (DS014): the default counts as used
  for (const q of String(sop ?? '').split(/\n(?=@)/).filter(w => /^@\S+\s+query\s*$/m.test(w.split('\n')[0]))) {
    if (/^\s+mode\s/m.test(q)) continue;
    tags.add(/^\s+select\s/m.test(q) ? 'm.enum.query.mode.select' : 'm.enum.query.mode.exists');
  }
  // the same comparison word written in a session rule (`compare ?v above 80`) is the same capability on the knowledge surface
  for (const t of [...tags]) if (t.startsWith('k.leaf.compare.')) tags.add('m.word.query.compare.' + t.slice('k.leaf.compare.'.length));
  const present = (c.capabilities ?? []).filter(id => tags.has(id));
  return {present, missing: (c.capabilities ?? []).filter(id => !tags.has(id)), tags: [...tags]};
}

async function runCases(cases, {tier, strategy, runId, out, log}) {
  const tags = {purpose: 'job:capability-battery', run: runId, noFallback: true};
  const system = await openChatTurn({tier, strategy, sessionId: `capability-l3-${process.pid}`, parserOptions: {reportErrors: false}, tags});
  try {
    for (const c of cases) {
      let r = await system.ask(c.message);
      for (let retry = 0; retry < 2 && !r.ok && r.error?.code === 'parse_unavailable'; retry++) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        r = await system.ask(c.message);
      }
      const sop = r.sop ?? r.parse?.sop ?? null;
      const score = scoreTurn(c, r);
      const used = usedCapabilities(c, sop);
      const res = {id: c.id, ok: r.ok, ms: r.ms, ...score, error: r.error ?? null, sop, used: used.missing.length === 0, present: used.present, missing: used.missing, capabilities: c.capabilities};
      fs.appendFileSync(out, JSON.stringify(res) + '\n');
      log(`${c.id} ${res.outcome} ${res.used ? 'used' : 'missing ' + used.missing.length} ${r.ms} ms`);
    }
  } finally { await system.close(); }
}

/** The non-correct cases of a run go to the formalization inbox (append-only; the improver's build turns them into regression cases). */
export function reportFailures(results, {catalog = loadCatalog(), tier, strategy}) {
  const byId = new Map(catalog.map(c => [c.id, c]));
  let n = 0;
  for (const r of results) {
    if (r.outcome === 'correct') continue;
    const c = byId.get(r.id);
    if (!c) continue;
    const kind = r.outcome === 'invalid' ? 'invalid' : r.outcome === 'failed' ? 'parse_failed' : r.outcome === 'unknown' ? (r.status === 'unclear' ? 'unclear' : 'wrong') : 'wrong';
    reportFormalizationError({source: 'capability-battery', kind, message: c.message, strategy, tier, circuit: r.sop, expected: c.gold,
      detail: [r.outcome, r.status ?? '', r.reason ?? '', ...(r.missing?.length ? ['missing_capability'] : [])].filter(Boolean).join(' | '), ref: `eval/capabilities/l3/catalog.jsonl#${r.id}`});
    n++;
  }
  return n;
}

/** Circuits of the last full L3 run, for the coverage report (source `battery`). */
export function l3Circuits() {
  if (!fs.existsSync(COMPACT)) return [];
  const {run} = JSON.parse(fs.readFileSync(COMPACT, 'utf8'));
  return readJsonl(path.join(RUNS, run, 'results.jsonl')).filter(r => r.sop).map(r => ({source: 'battery', ref: 'l3/' + r.id, circuit: {text: r.sop}}));
}

export async function runL3({tier = 'tiny', strategy = 'LocalLLMStepByStep', ids = null, n = null, runId = null, log = m => console.error(m)} = {}) {
  let cases = loadCatalog();
  if (ids) cases = cases.filter(c => ids.includes(c.id));
  if (n) cases = cases.slice(0, n);
  const id = runId ?? `l3-${stamp()}`;
  const dir = path.join(RUNS, id);
  fs.mkdirSync(dir, {recursive: true});
  const file = path.join(dir, 'results.jsonl');
  // results of an interrupted run (also the shard files of the former multi-process mode) are kept: the run resumes
  for (const f of fs.readdirSync(dir).filter(x => /^results\.shard-\d+\.jsonl$/.test(x))) {
    fs.appendFileSync(file, fs.readFileSync(path.join(dir, f)));
    fs.rmSync(path.join(dir, f));
  }
  const done = new Set(readJsonl(file).map(r => r.id));
  const queue = cases.filter(c => !done.has(c.id));
  const started = Date.now();
  if (queue.length) await runCases(queue, {tier, strategy, runId: id, out: file, log});
  const results = readJsonl(file);
  const counts = {};
  for (const r of results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  const compact = {run: id, tier, strategy, finished: new Date().toISOString(), cases: Object.fromEntries(results.sort((a, b) => a.id.localeCompare(b.id)).map(r => [r.id, {outcome: r.outcome, used: r.used}]))};
  // the compact file is the battery's L3 state: only a run of the whole catalog replaces it
  const full = !ids && !n;
  if (full) fs.writeFileSync(COMPACT, JSON.stringify(compact, null, 1) + '\n');
  const summary = {run: id, tier, strategy, cases: results.length, ...counts, used: results.filter(r => r.used).length, minutes: Math.round((Date.now() - started) / 600) / 100, compactWritten: full};
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 1) + '\n');
  return {summary, results};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const tier = opt(args, '--tier', 'tiny'), strategy = opt(args, '--strategy', 'LocalLLMStepByStep');
  // `--rescore RUN_ID`: recompute `used` from the stored circuits (after a change of the tagger) and rewrite the compact file; no model call
  const rescore = opt(args, '--rescore', null);
  if (rescore) {
    const file = path.join(RUNS, rescore, 'results.jsonl'), byId = new Map(loadCatalog().map(c => [c.id, c]));
    const results = readJsonl(file).map(r => { const c = byId.get(r.id); if (!c) return r; const u = usedCapabilities(c, r.sop); return {...r, used: u.missing.length === 0, present: u.present, missing: u.missing, capabilities: c.capabilities}; });
    fs.writeFileSync(file, results.map(r => JSON.stringify(r)).join('\n') + '\n');
    const old = fs.existsSync(COMPACT) ? JSON.parse(fs.readFileSync(COMPACT, 'utf8')) : {};
    fs.writeFileSync(COMPACT, JSON.stringify({run: rescore, tier: old.tier ?? tier, strategy: old.strategy ?? strategy, finished: old.finished ?? new Date().toISOString(), cases: Object.fromEntries(results.sort((a, b) => a.id.localeCompare(b.id)).map(r => [r.id, {outcome: r.outcome, used: r.used}]))}, null, 1) + '\n');
    console.log(JSON.stringify({rescored: results.length, used: results.filter(r => r.used).length}));
    process.exit(0);
  }
  const reportOnly = opt(args, '--report-only', null);
  if (reportOnly) {
    const results = readJsonl(path.join(RUNS, reportOnly, 'results.jsonl'));
    console.log(JSON.stringify({reported: reportFailures(results, {tier, strategy})}));
    process.exit(0);
  }
  const out = await runL3({tier, strategy, ids: opt(args, '--ids', null)?.split(','), n: opt(args, '--n', null) ? Number(opt(args, '--n')) : null, runId: opt(args, '--run-id', null)});
  if (args.includes('--report-failures')) out.summary.reported = reportFailures(out.results, {tier, strategy});
  console.log(JSON.stringify(out.summary));
}
