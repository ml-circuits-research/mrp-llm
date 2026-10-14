#!/usr/bin/env node
/**
 * Triage by layer of a scored books run (TODO.md section 0, the reasoning cycle of the operating loop):
 *   node tools/eval/books/triage.mjs --run <books run dir> [--arm steps] [--judge] [--out <dir>]
 * Every failed row of the arm gets one layer: formalization | knowledge | engine | construct | gold | infrastructure.
 * Deterministic rules decide what the record shows by itself (a turn error, a refused circuit, a question asked back, a circuit without
 * the problem's own data, a gold answer in another language); the rest is judged by the Ploinky Workers job `jobs/books-triage` (tier good),
 * which sees the problem, the gold, the circuit and the answer. Writes `<out>/triage.jsonl`, `<out>/summary.md` (default
 * eval/reports/current/books-triage/<date>-<run>/). Formalization rows are already in the inbox (score.mjs reportFailures); this tool
 * reports none and changes nothing.
 *   node tools/eval/books/triage.mjs --emit      (used by the job: prints the judge items of $BOOKS_TRIAGE_DIR/judge-items.jsonl)
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {reportFormalizationError} from '../../../lib/formalization-errors.mjs';
import {storeRun} from './gold-circuits.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const opt = (args, name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const readJsonl = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);
export const LAYERS = Object.freeze(['formalization', 'knowledge', 'engine', 'construct', 'gold', 'infrastructure']);
const INFRA = /reach|timeout|timed out|exceeded the|ECONN|socket|fetch failed|\b5\d\d\b|408|429|heap|aborted/i;
// Gold answers of the English books that the extractor kept in the source language of a translated book (yes/no words only).
const FOREIGN_YES_NO = /^\s*(da|nu)\b[.!]?\s*$/i;

/** The circuit models the problem from its own text: at least one `stated` wire. */
const modelled = sop => /^@\S+\s+stated\b/m.test(String(sop ?? ''));
const clarifiedName = text => (String(text ?? '').match(/by "([^"]+)"/) ?? [])[1] ?? null;

/** One layer for one failed row, or null when only the judge can decide. Structure only: codes, statuses and wire types. */
export function deterministicLayer(r) {
  const s = r.system ?? {}, o = r.verdict?.outcome, sop = s.formalization?.sop ?? null;
  if (FOREIGN_YES_NO.test(String(r.gold ?? ''))) return {layer: 'gold', sub: 'gold not in English', reason: `gold "${r.gold}" was extracted untranslated`};
  if (!r.ok || o === 'failed' || o === 'invalid') {
    const code = s.error?.code ?? r.error?.code ?? '', msg = `${code} ${s.error?.message ?? r.error?.message ?? ''} ${r.verdict?.reason ?? ''}`;
    if (code === 'parse_unavailable' && INFRA.test(msg)) return {layer: 'infrastructure', sub: 'model unavailable', reason: msg.slice(0, 200)};
    if (o === 'failed' && INFRA.test(msg)) return {layer: 'infrastructure', sub: 'turn failed', reason: msg.slice(0, 200)};
    if (o === 'failed') return null;
    return {layer: 'formalization', sub: 'no valid circuit', reason: msg.slice(0, 200)};
  }
  // A strong tier that asks back may have met a construct the language lacks: the judge decides for the ceiling arm.
  if ((['unclear', 'courtesy', 'context_updated'].includes(s.status) || s.status == null) && r.arm !== 'ceiling') return {layer: 'formalization', sub: 'no question formalized', reason: `status ${s.status}`};
  if (s.status === 'clarify') {
    const name = clarifiedName(r.text);
    const stated = name && new RegExp(`^\\s*role \\w+ "${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'mi').test(String(sop ?? '').split(/^@\S+\s+query\b/m)[0]);
    if (stated) return null; // a name the circuit states was still sent to the memory: the linker may be at fault
    return {layer: 'formalization', sub: 'queried name not stated', reason: `asked back about "${name ?? '?'}" (${s.reason}), which the circuit does not state`};
  }
  if (!modelled(sop)) return {layer: 'formalization', sub: 'answered from memory', reason: 'the circuit states none of the problem\'s data'};
  return null;
}

/** The deterministic pass over a scored run: every failed row of the arm, with a layer or queued for the judge. */
export function triageRows(runDir, {arm = 'steps'} = {}) {
  const rows = readJsonl(path.join(runDir, 'scored.jsonl')).filter(r => r.arm === arm);
  const failed = rows.filter(r => r.verdict && !['correct', 'pending'].includes(r.verdict.outcome));
  return {total: rows.length, correct: rows.filter(r => r.verdict?.outcome === 'correct').length, rows: failed.map(r => {
    const d = deterministicLayer(r);
    return {id: r.id, book: r.book, outcome: r.verdict.outcome, status: r.system?.status ?? null, judge_verdict: r.verdict.judge ?? null, gold_kind: r.gold_kind,
      ...(d ? {layer: d.layer, sub: d.sub, reason: d.reason, by: 'rule'} : {layer: null, by: 'judge'}),
      _item: d ? null : {id: r.id, problem: r.question.slice(0, 2500), gold: String(r.gold).slice(0, 700), status: `${r.system?.status ?? 'error'} (scored ${r.verdict.outcome}${r.verdict.judge ? `, judge: ${r.verdict.judge}: ${r.verdict.reason}` : ''})`,
        answer: String(r.text ?? r.response ?? '').replace(/^Sources used:.*$/gm, '').slice(0, 1500), circuit: String(r.system?.formalization?.sop ?? '(none)').slice(0, 6000)}};
  })};
}

function summarise(out, run, t, judgeRun) {
  const by = {}, sub = {}, book = {};
  for (const r of t.rows) {
    const l = r.layer ?? 'undecided';
    by[l] = (by[l] ?? 0) + 1;
    const k = `${l}: ${r.sub ?? '?'}`; sub[k] = (sub[k] ?? 0) + 1;
    (book[r.book] ??= {})[l] = ((book[r.book] ??= {})[l] ?? 0) + 1;
  }
  const lines = [`# Triage of ${run} (arm steps)`, '', `${t.total} problems, ${t.correct} correct, ${t.rows.length} failed. Rule-decided ${t.rows.filter(r => r.by === 'rule').length}, judged ${t.rows.filter(r => r.by === 'judge').length}${judgeRun ? ` (Ploinky Workers job books-triage ${judgeRun})` : ''}.`, '',
    '| layer | rows |', '|---|---|', ...LAYERS.concat('undecided').filter(l => by[l]).map(l => `| ${l} | ${by[l]} |`), '',
    '| book | ' + LAYERS.join(' | ') + ' |', '|---|' + LAYERS.map(() => '---|').join(''),
    ...Object.entries(book).sort().map(([b, c]) => `| ${b} | ${LAYERS.map(l => c[l] ?? 0).join(' | ')} |`), '',
    '## Sub-kinds', '', ...Object.entries(sub).sort((a, b) => b[1] - a[1]).map(([k, n]) => `- ${k}: ${n}`), '',
    '## Non-formalization rows', '', ...t.rows.filter(r => r.layer && r.layer !== 'formalization').map(r => `- ${r.id} [${r.layer}: ${r.sub}] ${r.reason}${r.fix ? ` Fix: ${r.fix}` : ''}`)];
  fs.writeFileSync(path.join(out, 'summary.md'), lines.join('\n') + '\n');
  return by;
}

/**
 * Formalization and construct rows of the ceiling arm go to the formalization inbox once (`inbox-reported.json` in the triage folder):
 * a construct the language lacks is `missing_construct`; a strong tier's question asked back is `unclear`; a refused circuit is
 * `invalid`; an unfaithful circuit that executed is `wrong`.
 */
function reportCeiling(runDir, rows, out, {report = reportFormalizationError} = {}) {
  const file = path.join(out, 'inbox-reported.json');
  const done = new Set(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []);
  const recs = new Map(readJsonl(path.join(runDir, 'scored.jsonl')).filter(r => r.arm === 'ceiling').map(r => [r.id, r]));
  let n = 0;
  for (const t of rows) {
    if (!['formalization', 'construct'].includes(t.layer) || done.has(t.id)) continue;
    const r = recs.get(t.id);
    if (!r) continue;
    const kind = t.layer === 'construct' ? 'missing_construct' : ['unclear', 'clarify', 'courtesy'].includes(r.system?.status) ? 'unclear' : t.outcome === 'invalid' ? 'invalid' : 'wrong';
    report({source: 'reasoning-cycle', kind, message: r.question, strategy: r.system?.understanding?.strategy ?? 'LocalLLMStepByStep', tier: r.author_tier ?? 'good', circuit: r.circuit ?? r.system?.formalization?.sop ?? null, expected: r.gold,
      detail: `${t.sub}: ${t.reason}${t.fix ? ` Fix: ${t.fix}` : ''}`.slice(0, 1200), ref: {run: path.basename(runDir), id: r.id, book: r.book, arm: 'ceiling'}});
    done.add(t.id); n++;
  }
  fs.writeFileSync(file, JSON.stringify([...done], null, 1));
  return n;
}

async function judge(out) {
  // The model judge of the remaining rows was a job of the earlier gateway's job runner, which Ploinky Workers does not have; the
  // deterministic layer above still triages every row it can decide.
  throw new Error(`the model judge needs a Ploinky Workers task for jobs/books-triage (not available); rows left for it are in ${out}`);
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--emit')) {
    const dir = process.env.BOOKS_TRIAGE_DIR;
    if (!dir) throw new Error('--emit needs BOOKS_TRIAGE_DIR');
    process.stdout.write(fs.readFileSync(path.join(dir, 'judge-items.jsonl'), 'utf8'));
    return;
  }
  const runDir = path.resolve(ROOT, opt(args, '--run', ''));
  const run = path.basename(runDir);
  const out = path.resolve(ROOT, opt(args, '--out', `eval/reports/current/books-triage/${new Date().toISOString().slice(0, 10)}-${run}`));
  fs.mkdirSync(out, {recursive: true});
  const t = triageRows(runDir, {arm: opt(args, '--arm', 'steps')});
  const items = t.rows.filter(r => r._item).map(r => r._item);
  fs.writeFileSync(path.join(out, 'judge-items.jsonl'), items.map(i => JSON.stringify(i)).join('\n') + (items.length ? '\n' : ''));
  let judgeRun = null;
  if (args.includes('--judge') && items.length) {
    judgeRun = await judge(out);
    const accepted = new Map(readJsonl(path.join(judgeRun.dir, 'accepted.jsonl')).map(a => [a.id, a.value ?? a.output?.records?.[0]]));
    for (const r of t.rows) {
      const v = r.layer ? null : accepted.get(r.id);
      if (v) Object.assign(r, {layer: v.layer, sub: v.sub, reason: v.reason, fix: v.fix, faithful: v.faithful});
    }
  }
  fs.writeFileSync(path.join(out, 'triage.jsonl'), t.rows.map(({_item, ...r}) => JSON.stringify(r)).join('\n') + '\n');
  // The ceiling arm: its circuits enter the reusable store, and what the strong tier could not formalize goes to the inbox.
  const extra = {};
  if (opt(args, '--arm', 'steps') === 'ceiling') {
    extra.gold_circuits = storeRun(runDir);
    if (!args.includes('--no-inbox')) extra.inbox = reportCeiling(runDir, t.rows, out);
  }
  const by = summarise(out, run, t, judgeRun?.run);
  console.log(JSON.stringify({out: path.relative(ROOT, out), total: t.total, correct: t.correct, failed: t.rows.length, layers: by, judge: judgeRun ? {run: judgeRun.run, status: judgeRun.status} : null, ...extra}));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
