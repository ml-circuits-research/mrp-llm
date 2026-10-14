#!/usr/bin/env node
/**
 * Summary of eval-stepbystep-protocol-v1 records: per level and method correct / wrong / unknown / invalid+failed, questions per
 * message, p50/p95 formalization latency, the paired bootstrap of the correct-rate difference of each method against A (pooled and
 * per level), the preregistered stop decision, and the slot of the first divergence from the reviewed circuit for every non-correct row.
 *   node tools/eval/formalization/stepbystep-protocol/summarize.mjs --runs stage1[,stage2] [--judgments FILE] [--json]
 * Natural rows judged by hand come from --judgments ({"id/method": {"outcome": "...", "note": "..."}}).
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DIR = path.join(ROOT, 'eval/reports/current/stepbystep-protocol');
const LEVELS = {a: 'a known forms', b: 'b held-out forms', c: 'c compositions', n: 'natural'};

export const bucket = outcome => ['invalid', 'failed'].includes(outcome) ? 'invalid+failed' : outcome;
const quantile = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

/** Deterministic PRNG (mulberry32). */
function random(seed) {
  let t = seed >>> 0;
  return () => { t = (t + 0x6D2B79F5) >>> 0; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
}

/** Paired bootstrap of mean(x - y) over rows: {n, point, low, high} (95% percentile interval). */
export function pairedBootstrap(diffs, {resamples = 10000, seed = 1} = {}) {
  if (!diffs.length) return {n: 0, point: null, low: null, high: null};
  const next = random(seed), means = [];
  for (let k = 0; k < resamples; k++) { let sum = 0; for (let i = 0; i < diffs.length; i++) sum += diffs[Math.floor(next() * diffs.length)]; means.push(sum / diffs.length); }
  means.sort((a, b) => a - b);
  return {n: diffs.length, point: diffs.reduce((a, b) => a + b, 0) / diffs.length, low: means[Math.floor(0.025 * resamples)], high: means[Math.floor(0.975 * resamples)]};
}

/** The preregistered stop rule for method M against A. */
export function decide({point, low, high}, wrongM, wrongA, {stage = 1, failedShare = 0} = {}) {
  if (failedShare > 0.2 && stage === 1) return 'broken';
  if (low > 0 && point >= 0.10 && wrongM <= wrongA + 1) return 'decisive';
  if (high < 0.05) return 'futility';
  return 'undecided';
}

const shape = sop => {
  const text = String(sop ?? '');
  const relations = [...text.matchAll(/relation\s+"([^"]+)"|^\s+(?:where|when)\s+(?:absent\s+)?([a-z_0-9]+)\s/gm)].map(m => m[1] ?? m[2]).filter(Boolean);
  return {
    kind: /mode count/.test(text) ? 'count' : /mode every/.test(text) ? 'every' : /mode explain/.test(text) ? 'why' : /\brank (highest|lowest)/.exec(text)?.[1] ?? (/\bselect\b/.test(text) ? 'select' : /constraint/.test(text) ? 'puzzle' : /unclear/.test(text) ? 'unclear' : 'yesno'),
    relations: new Set(relations.filter(r => !/^(?:hop_|reach|allowed_|links_needed|group_size|size_gap|.*_count_per_|.*_difference)/.test(r))),
    defined: /\b(aggregate|rule|default)\b/.test(text),
    polarity: [...text.matchAll(/polarity (\w+)|where absent/g)].map(m => m[1] ?? 'absent').filter(p => p !== 'affirmed').sort().join(','),
    compares: (text.match(/\bcompare\b/g) ?? []).length + (text.match(/^\s+(?:\?\w+ equal)/gm) ?? []).length,
    excepts: (text.match(/\bexcept\b/g) ?? []).length,
    time: /\b(at|during|overlaps)\s+["\d]/.test(text),
    supposed: /certainty supposed|\bif \$/.test(text),
  };
};

/** The first slot where the authored circuit differs from the reviewed one (kind, statements, polarity, limits, …, places). */
export function divergence(record, reference) {
  if (!reference) return record.level === 'n' ? 'natural (by hand)' : 'no reference';
  if (!record.author?.sop) return 'no circuit (failed)';
  const a = shape(record.author.sop), r = shape(reference);
  if (a.kind !== r.kind && !(a.kind === 'select' && ['highest', 'lowest'].includes(r.kind))) return 'kind';
  if (r.supposed && !a.supposed) return 'clause (supposition)';
  const missing = [...r.relations].filter(x => !a.relations.has(x)), extra = [...a.relations].filter(x => !r.relations.has(x));
  if (missing.length || extra.length) return r.defined && !a.defined ? 'definition' : 'statements';
  if (a.polarity !== r.polarity) return 'truth/negation';
  if (a.compares !== r.compares) return 'limit/comparison';
  if (a.excepts !== r.excepts) return 'exclusion';
  if (a.time !== r.time) return 'time';
  if (a.kind !== r.kind) return 'kind';
  return 'places';
}

function referenceOf(record, rows) {
  if (record.level === 'a') {
    const manifest = path.join(ROOT, 'eval/smoke-reasoning/bench/manifest.jsonl');
    rows.a ??= new Map(fs.readFileSync(manifest, 'utf8').split('\n').filter(Boolean).map(JSON.parse).map(r => [r.id, r]));
    const row = rows.a.get(record.id);
    return row ? fs.readFileSync(path.resolve(path.dirname(manifest), row.case_dir, 'query.sop'), 'utf8') : null;
  }
  return rows.gen?.get(record.id)?.reference ?? null;
}

export async function summarize(records, judgments = {}) {
  const {generalityCases} = await import('../../../datasets/diversity/generality.mjs');
  const rows = {gen: new Map(generalityCases({per: 15}).map(r => [r.id, r]))};
  const outcome = r => judgments[`${r.id}/${r.method}`]?.outcome ?? r.outcome;
  const methods = [...new Set(records.map(r => r.method))];
  const table = {};
  for (const r of records) {
    const cell = table[`${r.level}|${r.method}`] ??= {level: r.level, method: r.method, n: 0, correct: 0, wrong: 0, unknown: 0, 'invalid+failed': 0, manual: 0, questions: [], ms: [], divergence: {}};
    const o = outcome(r);
    cell.n++;
    if (o === 'manual') cell.manual++; else cell[bucket(o)]++;
    cell.questions.push(r.questions ?? 0);
    if (Number.isFinite(r.formalize_ms)) cell.ms.push(r.formalize_ms);
    if (o !== 'correct' && o !== 'manual') { const d = divergence(r, referenceOf(r, rows)); cell.divergence[d] = (cell.divergence[d] ?? 0) + 1; }
  }
  for (const cell of Object.values(table)) {
    cell.questions_mean = +(cell.questions.reduce((a, b) => a + b, 0) / Math.max(1, cell.questions.length)).toFixed(1);
    cell.questions_max = Math.max(0, ...cell.questions);
    cell.p50_ms = quantile(cell.ms, 0.5); cell.p95_ms = quantile(cell.ms, 0.95);
    delete cell.questions; delete cell.ms;
  }
  const comparisons = {};
  const byId = method => new Map(records.filter(r => r.method === method).map(r => [r.id, r]));
  const base = byId('A');
  for (const method of methods.filter(m => m !== 'A')) {
    const other = byId(method);
    const paired = [...other.values()].filter(r => base.has(r.id) && outcome(r) !== 'manual' && outcome(base.get(r.id)) !== 'manual');
    const diff = rs => rs.map(r => Number(outcome(r) === 'correct') - Number(outcome(base.get(r.id)) === 'correct'));
    const pooled = pairedBootstrap(diff(paired));
    const wrongM = paired.filter(r => outcome(r) === 'wrong').length, wrongA = paired.filter(r => outcome(base.get(r.id)) === 'wrong').length;
    const failedShare = paired.filter(r => ['invalid', 'failed'].includes(outcome(r)) && r.author?.status === 'failed').length / Math.max(1, paired.length);
    comparisons[`${method}-A`] = {pooled, wrong: {[method]: wrongM, A: wrongA}, decision: decide(pooled, wrongM, wrongA, {failedShare}),
      levels: Object.fromEntries(Object.keys(LEVELS).map(l => [l, pairedBootstrap(diff(paired.filter(r => r.level === l)))]))};
  }
  return {table, comparisons};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const records = opt('--runs', 'stage1').split(',').flatMap(run => {
    const file = path.join(DIR, run, 'records.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
  });
  const judgments = opt('--judgments', null) ? JSON.parse(fs.readFileSync(opt('--judgments'), 'utf8')) : {};
  const out = await summarize(records, judgments);
  if (args.includes('--json')) console.log(JSON.stringify(out, null, 1));
  else {
    console.log('| level | method | n | correct | wrong | unknown | invalid+failed | to judge | questions mean / max | p50 ms | p95 ms | first divergence of non-correct rows |');
    console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const c of Object.values(out.table).sort((a, b) => a.level.localeCompare(b.level) || a.method.localeCompare(b.method)))
      console.log(`| ${LEVELS[c.level]} | ${c.method} | ${c.n} | ${c.correct} | ${c.wrong} | ${c.unknown} | ${c['invalid+failed']} | ${c.manual} | ${c.questions_mean} / ${c.questions_max} | ${c.p50_ms} | ${c.p95_ms} | ${Object.entries(c.divergence).map(([k, v]) => `${k} ${v}`).join(', ')} |`);
    for (const [k, c] of Object.entries(out.comparisons)) {
      const f = x => x === null ? '–' : (100 * x).toFixed(1);
      console.log(`\n${k}: pooled ${f(c.pooled.point)} pp [${f(c.pooled.low)}, ${f(c.pooled.high)}] n=${c.pooled.n}; wrong ${JSON.stringify(c.wrong)}; decision ${c.decision}; per level ${Object.entries(c.levels).map(([l, b]) => `${l} ${f(b.point)} [${f(b.low)}, ${f(b.high)}] n=${b.n}`).join('; ')}`);
    }
  }
}
