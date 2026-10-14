#!/usr/bin/env node
/**
 * Summary of eval-internal-reasoning-stepbystep-v1 records (records-<arm>.jsonl of one or more run folders): per level and arm the
 * outcomes (correct / wrong / unknown / invalid+failed / to judge), questions per message (mean / max), questions avoided by the
 * protocol's defaults and single options (IR), formalization latency p50 / p95, engine ms per decision (IR), the first divergence from
 * the reviewed circuit of every non-correct row, and the paired bootstrap of the correct-rate difference IR − B (pooled and per level)
 * with the preregistered decision (non-inferiority margin 5 pp).
 *   node tools/eval/formalization/internal-reasoning/summarize.mjs --runs stage1 [--judgments FILE] [--json] [--write]
 * Natural rows judged by hand come from --judgments ({"id/arm": {"outcome": "...", "note": "..."}}).
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {pairedBootstrap, divergence, bucket} from '../stepbystep-protocol/summarize.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const DIR = path.join(ROOT, 'eval/reports/current/internal-reasoning');
const LEVELS = {a: 'a known forms', b: 'b held-out forms', c: 'c compositions', n: 'natural'};
const quantile = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

/** The preregistered decision of IR against B: non-inferior, superior, inferior or undecided (margin 5 pp, wrong answers not worse by more than 1). */
export function decideIR({point, low, high}, wrongIR, wrongB, {failedShare = 0} = {}) {
  if (point === null) return 'no data';
  if (failedShare > 0.2) return 'broken';
  if (low > 0 && wrongIR <= wrongB + 1) return 'superior';
  if (low > -0.05 && wrongIR <= wrongB + 1) return 'non-inferior';
  if (high < -0.05) return 'inferior';
  return 'undecided';
}

export function readRecords(runs) {
  return runs.flatMap(run => {
    const dir = path.isAbsolute(run) ? run : path.join(DIR, run);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => /^records-.+\.jsonl$/.test(f)).flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map(JSON.parse));
  });
}

export async function summarize(records, judgments = {}) {
  const {generalityCases} = await import('../../../datasets/diversity/generality.mjs');
  const gen = new Map(generalityCases({per: 20}).map(r => [r.id, r]));
  const manifest = path.join(ROOT, 'eval/smoke-reasoning/bench/manifest.jsonl');
  const known = new Map(fs.readFileSync(manifest, 'utf8').split('\n').filter(Boolean).map(JSON.parse).map(r => [r.id, r]));
  const reference = r => r.level === 'a' ? (known.get(r.id) ? fs.readFileSync(path.resolve(path.dirname(manifest), known.get(r.id).case_dir, 'query.sop'), 'utf8') : null) : gen.get(r.id)?.reference ?? null;
  const outcome = r => judgments[`${r.id}/${r.method}`]?.outcome ?? r.outcome;
  const table = {};
  for (const r of records) {
    const cell = table[`${r.level}|${r.method}`] ??= {level: r.level, arm: r.method, n: 0, correct: 0, wrong: 0, unknown: 0, 'invalid+failed': 0, manual: 0, questions: [], ms: [], engine: [], avoided: [], divergence: {}};
    const o = outcome(r);
    cell.n++;
    if (o === 'manual') cell.manual++; else cell[bucket(o)]++;
    cell.questions.push(r.questions ?? 0);
    if (Number.isFinite(r.formalize_ms)) cell.ms.push(r.formalize_ms);
    if (Number.isFinite(r.engine_ms) && r.decisions) cell.engine.push(r.engine_ms / r.decisions);
    if (r.avoided) cell.avoided.push((r.avoided.defaults ?? 0) + (r.avoided.auto ?? 0));
    if (o !== 'correct' && o !== 'manual') { const d = divergence(r, reference(r)); cell.divergence[d] = (cell.divergence[d] ?? 0) + 1; }
  }
  for (const cell of Object.values(table)) {
    cell.questions_mean = +mean(cell.questions).toFixed(1);
    cell.questions_max = Math.max(0, ...cell.questions);
    cell.p50_ms = quantile(cell.ms, 0.5); cell.p95_ms = quantile(cell.ms, 0.95);
    cell.engine_ms_per_decision = cell.engine.length ? +mean(cell.engine).toFixed(1) : null;
    cell.avoided_mean = cell.avoided.length ? +mean(cell.avoided).toFixed(1) : null;
    delete cell.questions; delete cell.ms; delete cell.engine; delete cell.avoided;
  }
  const byId = arm => new Map(records.filter(r => r.method === arm).map(r => [r.id, r]));
  const comparisons = {};
  for (const [a, b] of [['IR', 'B'], ['IR-greedy', 'B'], ['IR', 'IR-greedy'], ['GLM', 'B'], ['IR', 'GLM']]) {
    const x = byId(a), y = byId(b);
    if (!x.size || !y.size) continue;
    const paired = [...x.values()].filter(r => y.has(r.id) && outcome(r) !== 'manual' && outcome(y.get(r.id)) !== 'manual');
    if (!paired.length) continue;
    const diff = rs => rs.map(r => Number(outcome(r) === 'correct') - Number(outcome(y.get(r.id)) === 'correct'));
    const pooled = pairedBootstrap(diff(paired));
    const wrongX = paired.filter(r => outcome(r) === 'wrong').length, wrongY = paired.filter(r => outcome(y.get(r.id)) === 'wrong').length;
    const failedShare = paired.filter(r => ['invalid', 'failed'].includes(outcome(r)) && r.author?.status === 'failed').length / paired.length;
    const questions = pairedBootstrap(paired.map(r => (r.questions ?? 0) - (y.get(r.id).questions ?? 0)));
    comparisons[`${a}-${b}`] = {pooled, questions, wrong: {[a]: wrongX, [b]: wrongY}, decision: decideIR(pooled, wrongX, wrongY, {failedShare}),
      levels: Object.fromEntries(Object.keys(LEVELS).map(l => [l, pairedBootstrap(diff(paired.filter(r => r.level === l)))]))};
  }
  return {table, comparisons};
}

export function markdown(out) {
  const lines = ['| level | arm | n | correct | wrong | unknown | invalid+failed | to judge | questions mean / max | avoided mean | p50 ms | p95 ms | engine ms/decision | first divergence of non-correct rows |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const c of Object.values(out.table).sort((a, b) => a.level.localeCompare(b.level) || a.arm.localeCompare(b.arm)))
    lines.push(`| ${LEVELS[c.level]} | ${c.arm} | ${c.n} | ${c.correct} | ${c.wrong} | ${c.unknown} | ${c['invalid+failed']} | ${c.manual} | ${c.questions_mean} / ${c.questions_max} | ${c.avoided_mean ?? '–'} | ${c.p50_ms} | ${c.p95_ms} | ${c.engine_ms_per_decision ?? '–'} | ${Object.entries(c.divergence).map(([k, v]) => `${k} ${v}`).join(', ')} |`);
  const f = x => x === null ? '–' : (100 * x).toFixed(1);
  for (const [k, c] of Object.entries(out.comparisons))
    lines.push('', `${k}: correct-rate difference ${f(c.pooled.point)} pp [${f(c.pooled.low)}, ${f(c.pooled.high)}] n=${c.pooled.n}; questions ${c.questions.point?.toFixed(2)} [${c.questions.low?.toFixed(2)}, ${c.questions.high?.toFixed(2)}]; wrong ${JSON.stringify(c.wrong)}; decision ${c.decision}; per level ${Object.entries(c.levels).filter(([, b]) => b.n).map(([l, b]) => `${l} ${f(b.point)} [${f(b.low)}, ${f(b.high)}] n=${b.n}`).join('; ')}`);
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const records = readRecords(opt('--runs', 'stage1').split(','));
  const judgments = opt('--judgments', null) ? JSON.parse(fs.readFileSync(opt('--judgments'), 'utf8')) : {};
  const out = await summarize(records, judgments);
  console.log(args.includes('--json') ? JSON.stringify(out, null, 1) : markdown(out));
}
