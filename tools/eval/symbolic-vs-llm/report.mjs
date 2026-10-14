#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {pairedBootstrap} from '../kbqa/report.mjs';
import {wilson} from './score.mjs';

const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(p * values.length) - 1)] : null;
const rate = (k, n) => ({numerator: k, denominator: n, value: n ? k / n : null, ci95: wilson(k, n)});
const nonAnswers = new Set(['unknown', 'incomplete', 'budget_exhausted', 'unsupported', 'not_computable', 'parse_unavailable', 'unclear', 'clarify', 'not_expressible']);
export function summarize(rows) {
  const n = rows.length;
  const counts = Object.fromEntries(['correct', 'wrong', 'unknown', 'invalid', 'failed'].map(k => [k, rows.filter(r => r.outcome === k).length]));
  const time = key => ({p50: percentile(rows.map(r => r.latency?.[key]).filter(Number.isFinite), .5), p95: percentile(rows.map(r => r.latency?.[key]).filter(Number.isFinite), .95)});
  const layers = {}, routes = {};
  for (const r of rows) {
    if (r.failure_layer) layers[r.failure_layer] = (layers[r.failure_layer] ?? 0) + 1;
    const route = JSON.stringify(r.packet?.route ?? null); routes[route] = (routes[route] ?? 0) + 1;
  }
  const tokens = rows.reduce((n, r) => n + (r.tokens_out ?? 0), 0);
  const modelMs = rows.reduce((n, r) => n + (r.latency?.model_ms > 0 ? r.latency.model_ms : r.latency?.parse_ms ?? 0), 0);
  const cost = rows.reduce((n, r) => n + (r.cost_usd ?? 0), 0);
  const answerable = rows.filter(r => r.gold_answerable !== false);
  const answered = rows.filter(r => ['correct', 'wrong'].includes(r.outcome) && !nonAnswers.has(r.packet?.status));
  return {n, counts, accuracy: rate(counts.correct, n), wrong_rate: rate(counts.wrong, n), unknown_rate: rate(answerable.filter(r => r.outcome === 'unknown').length, answerable.length), invalid_rate: rate(counts.invalid + counts.failed, n),
    wrong_among_answered: rate(counts.wrong, answered.length), verified_correct: rate(rows.filter(r => r.outcome === 'correct' && r.verified === true).length, n),
    proof_validity: rate(rows.filter(r => r.proof_available && r.verified === true).length, rows.filter(r => r.proof_available).length),
    latency_ms: Object.fromEntries(['wall_ms', 'parse_ms', 'linking_ms', 'retrieval_ms', 'engine_ms', 'verify_ms', 'model_ms'].map(k => [k, time(k)])),
    cost_usd: cost, cost_per_100: n ? cost * 100 / n : null, tokens_in: rows.reduce((n, r) => n + (r.tokens_in ?? 0), 0), tokens_out: tokens,
    tokens_per_second: modelMs ? tokens * 1000 / modelMs : null, throughput_basis: 'output tokens per model-call wall second', failure_layers: layers, routes};
}

export function paired(rows, arm = 'B', reference = 'A', condition = 'fits') {
  const filtered = rows.filter(r => condition === 'all' || (r.evidence_does_not_fit ? 'does_not_fit' : 'fits') === condition);
  const key = r => JSON.stringify([r.family ?? null, r.id]);
  const a = new Map(filtered.filter(r => r.arm === arm).map(r => [key(r), r]));
  const b = new Map(filtered.filter(r => r.arm === reference).map(r => [key(r), r]));
  const ids = [...a.keys()].filter(id => b.has(id)).sort();
  if (!ids.length) return null;
  const ci = pairedBootstrap(ids.map(id => +(a.get(id).outcome === 'correct')), ids.map(id => +(b.get(id).outcome === 'correct')), {iterations: 10000, seed: 20261001});
  const wrongA = ids.filter(id => a.get(id).outcome === 'wrong').length / ids.length;
  const wrongB = ids.filter(id => b.get(id).outcome === 'wrong').length / ids.length;
  return {...ci, arm, reference, condition, wrong_delta: wrongA - wrongB, practical_margin: ci.lo > 0 && ci.mean >= .1 && wrongA <= wrongB + .02};
}

/** The preregistered broken-arm check is model output quality, not downstream engine failure. */
export function stopDecision(rows, stage) {
  const arms = [...new Set(rows.map(r => r.arm))];
  const brokenCounts = {};
  if (stage >= 100) for (const arm of arms) {
    const first = rows.filter(r => r.arm === arm).slice(0, 100);
    if (first.length !== 100) continue;
    const emptyOrUnparsable = first.filter(r => r.broken_model_output === true ||
      (r.broken_model_output !== false && (r.response_empty === true || r.parse_ok === false ||
        (['A', "A'", 'D'].includes(arm) && r.packet?.reason === 'malformed_output') ||
        ['parse_failed', 'parser_failed'].includes(r.author?.status) ||
        (r.author?.status === 'invalid' && r.author.parsed === false &&
          (r.author.problems ?? r.author.validation?.problems)?.some(p => ['invalid_wire', 'missing_output'].includes(p.code)))))).length;
    brokenCounts[arm] = {empty_or_unparsable: emptyOrUnparsable, denominator: 100};
  }
  const broken = arms.filter(arm => brokenCounts[arm]?.empty_or_unparsable > 20);
  if (broken.length) return {stop: true, reason: 'broken', dropped_arms: broken, broken_counts: brokenCounts, comparison: paired(rows)};
  const comparison = paired(rows);
  if (stage >= 100 && comparison?.lo > .1) return {stop: true, reason: 'decisive', comparison};
  if (stage >= 100 && comparison?.hi < 0) return {stop: true, reason: 'futility', comparison};
  if (stage >= 600) return {stop: true, reason: 'full_stage', comparison};
  return {stop: false, reason: null, comparison};
}

export function report(records, {pilot = false, provenance = {}} = {}) {
  const groups = {};
  for (const r of records) {
    const condition = r.evidence_does_not_fit ? 'evidence_does_not_fit' : 'fits';
    const keys = [`all/${r.arm}/${condition}`, `${r.family}/${r.arm}/${condition}`, `${r.family}/size-${r.facts}/${r.arm}/${condition}`, `${r.family}/depth-${r.depth}/${r.arm}/${condition}`];
    for (const key of keys) (groups[key] ??= []).push(r);
  }
  const cells = Object.fromEntries(Object.entries(groups).map(([key, rows]) => [key, summarize(rows)]));
  const comparisons = Object.fromEntries([...new Set(records.map(r => r.family))].map(f => {
    const rows = records.filter(r => r.family === f);
    const variants = {};
    for (const arm of ['B-grammar', 'B-structured']) if (rows.some(r => r.arm === arm)) {
      variants[`${arm}_minus_A`] = paired(rows, arm, 'A');
      variants[`${arm}_minus_B`] = paired(rows, arm, 'B');
      variants[`${arm}_capped_minus_A`] = paired(rows, arm, 'A', 'does_not_fit');
    }
    return [f, {fits: paired(rows), does_not_fit: paired(rows, 'B', 'A', 'does_not_fit'), B_minus_C: paired(rows, 'B', 'C', 'all'), B_minus_A_cot: paired(rows, 'B', "A'"), D_minus_A: paired(rows, 'D', 'A'), ...variants}];
  }));
  const lines = [`# Symbolic versus LLM ${pilot ? 'dev pilot (sanity only; not a benchmark result)' : 'evaluation'}`, '', 'Capped English evidence is a separate B-versus-text condition, never a same-evidence reasoning win. B/C share symbolic memory and remain paired regardless of the English cap.', '', '| Family / arm / evidence | Correct / n | Verified correct / n | Wrong / n | Unknown / n | Invalid or failed / n | p50 / p95 wall ms | Cost USD / 100 |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
  for (const [key, cell] of Object.entries(cells).filter(([key]) => !key.includes('/size-') && !key.includes('/depth-'))) {
    lines.push(`| ${key} | ${cell.counts.correct}/${cell.n} | ${cell.verified_correct.numerator}/${cell.n} | ${cell.counts.wrong}/${cell.n} | ${cell.counts.unknown}/${cell.n} | ${cell.counts.invalid + cell.counts.failed}/${cell.n} | ${cell.latency_ms.wall_ms.p50} / ${cell.latency_ms.wall_ms.p95} | ${cell.cost_per_100?.toFixed(4) ?? '—'} |`);
  }
  lines.push('', 'Paired bootstrap: 10,000 resamples, seed 20261001; listed arm-minus-reference differences. Wilson intervals, token rates, size/depth cells, routes and failure layers are in summary.json.', '', '```json', JSON.stringify(comparisons, null, 2), '```', '');
  return {summary: {format: 'chatsop-symbolic-vs-llm-report-v1', pilot, provenance, cells, comparisons}, markdown: lines.join('\n')};
}

export function writeReport(dir, options = {}) {
  const records = fs.readFileSync(path.join(dir, 'records.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const result = report(records, options);
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(result.summary, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'summary.md'), result.markdown);
  return result.summary;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: node tools/eval/symbolic-vs-llm/report.mjs REPORT_DIRECTORY [--pilot]');
  console.log(JSON.stringify(writeReport(dir, {pilot: process.argv.includes('--pilot')})));
}
