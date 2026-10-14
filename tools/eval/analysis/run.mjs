#!/usr/bin/env node
/**
 * Evaluation of the analysis procedures (DS022 "Analysis procedures") on the test set eval/analysis-v1 (our own documents with planted
 * issues and the KPI values to compute; eval/analysis-v1/README.md). No model is called by this script.
 *
 *   --mode sop        (a) the hand-written SOP of each document (eval/analysis-v1/sop/<doc>.sop, plus <doc>.request.sop when present)
 *                     over analysis-core-v1: the procedures in isolation. Findings match the truth by {rule, witness}.
 *   --mode analyses   (b) end to end: the analysis packets written by the task template analyze-document (ingestion v2, then the
 *                     analysis) for each document, found as <dir>/<doc>/analysis.json (--dir). The ingested symbols are the
 *                     ingestion's own, so a finding matches a planted issue by its rule (strict) or its procedure (family) and by the
 *                     document lines of its evidence (the planted issue's lines).
 *
 * Reports precision and recall of findings, KPI correctness (a truth KPI is correct when a measure with the same predicate and key has
 * the value within 0.005), the rubric score, the provenance check (every finding has evidence, and every quote is words of the document
 * at the line it names) and a bootstrap interval over documents (seeded, 2,000 resamples). Writes eval/reports/current/analysis/<mode>.json.
 *
 *   node tools/eval/analysis/run.mjs [--mode sop|analyses] [--dir DIR] [--reasoning auto|<engine>] [--only doc,doc] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {analyzeSession} from '../../../lib/analysis/index.mjs';
import {seedLayers} from '../../../lib/knowledge-seeds.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SET = path.join(ROOT, 'eval', 'analysis-v1');
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const mode = opt('--mode', 'sop');
const truth = JSON.parse(fs.readFileSync(path.join(SET, 'truth.json'), 'utf8')).documents;
const only = opt('--only', null)?.split(',') ?? null;
const docs = Object.keys(truth).filter(d => !only || only.includes(d));
const norm = s => String(s ?? '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();

/** The analysis packet of a document in mode sop: the library layers, the document layer, the analysis request. */
export function sopAnalysis(doc, {reasoning = 'auto'} = {}) {
  const read = name => { const f = path.join(SET, 'sop', name); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null; };
  const circuits = [...seedLayers('analysis-core-v1'), {name: `${doc}.sop`, text: read(`${doc}.sop`), provenance: {kind: 'document', document: `${doc}.md`}}];
  const request = read(`${doc}.request.sop`);
  if (request) circuits.push({name: `${doc}.request.sop`, text: request});
  return analyzeSession({circuits}, null, {reasoning, render: true});
}

const lineOf = location => { const m = /line (\d+)/.exec(String(location ?? '')); return m ? Number(m[1]) : null; };

/** Provenance check: every finding has evidence, every quote is words of the document (at its line when the location names one). */
function provenance(result, docText) {
  const lines = docText.split('\n').map(norm);
  const all = norm(docText);
  let quotes = 0, ok = 0;
  const bad = [];
  for (const item of [...result.findings, ...result.measures]) for (const e of item.evidence) {
    if (!e.quote) continue;
    quotes++;
    const q = norm(e.quote), at = lineOf(e.location);
    const good = at ? (lines[at - 1] ?? '').includes(q) : all.includes(q);
    if (good) ok++; else bad.push({item: item.id, wire: e.wire, location: e.location, quote: e.quote});
  }
  return {findings_with_evidence: result.findings.filter(f => f.evidence.length).length, findings: result.findings.length, quotes, quotes_ok: ok, bad: bad.slice(0, 5)};
}

function scoreKpis(result, kpis) {
  const measured = result.measures.filter(m => m.predicate.startsWith('kpi_'));
  const keyOf = m => Object.values(m.values).slice(0, -1).map(String);
  const valueOf = m => Object.values(m.values).at(-1);
  let correct = 0;
  const wrong = [];
  for (const k of kpis) {
    const hit = measured.find(m => m.predicate === k.predicate && JSON.stringify(keyOf(m)) === JSON.stringify(k.key));
    if (hit && Math.abs(Number(valueOf(hit)) - k.value) <= 0.005) correct++;
    else wrong.push({...k, got: hit ? valueOf(hit) : null});
  }
  const extra = measured.filter(m => !kpis.some(k => k.predicate === m.predicate && JSON.stringify(keyOf(m)) === JSON.stringify(k.key))).map(m => m.atom);
  return {expected: kpis.length, correct, wrong, extra};
}

function scoreFindings(result, expected, {e2e = false} = {}) {
  const procedureOf = new Map(result.procedures.flatMap(p => p.integrity.map(i => [i, p.id])));
  const libraryProcedure = rule => procedureOf.get(rule) ?? null;
  const used = new Set();
  const matches = expected.map(t => {
    const i = result.findings.findIndex((f, j) => {
      if (used.has(j)) return false;
      if (!e2e) return f.rule.id === t.rule && String(f.witness) === t.witness;
      const lines = f.evidence.map(e => lineOf(e.location)).filter(Boolean);
      const sameRule = f.rule.id === t.rule, sameFamily = libraryProcedure(f.rule.id) && libraryProcedure(f.rule.id) === libraryProcedure(t.rule);
      return (sameRule || sameFamily) && lines.some(l => t.lines.includes(l));
    });
    if (i >= 0) used.add(i);
    return {truth: t, found: i >= 0 ? result.findings[i].id : null, strict: i >= 0 && result.findings[i].rule.id === t.rule};
  });
  const tp = matches.filter(m => m.found).length, strict = matches.filter(m => m.strict).length;
  return {expected: expected.length, predicted: result.findings.length, tp, strict, fp: result.findings.length - used.size, missed: matches.filter(m => !m.found).map(m => `${m.truth.rule} ${m.truth.witness}`), spurious: result.findings.filter((_, j) => !used.has(j)).map(f => f.id)};
}

function bootstrap(rows, stat, {n = 2000, seed = 7} = {}) {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const values = [];
  for (let i = 0; i < n; i++) { const sample = rows.map(() => rows[Math.floor(rand() * rows.length)]); const v = stat(sample); if (Number.isFinite(v)) values.push(v); }
  values.sort((a, b) => a - b);
  return [values[Math.floor(values.length * 0.025)] ?? null, values[Math.floor(values.length * 0.975)] ?? null].map(v => (v === null ? null : Math.round(v * 1000) / 1000));
}

const ratio = (a, b) => (b ? a / b : null);
const per = [];
for (const doc of docs) {
  const t = truth[doc];
  const docText = fs.readFileSync(path.join(SET, 'documents', `${doc}.md`), 'utf8');
  let result;
  if (mode === 'sop') result = sopAnalysis(doc, {reasoning: opt('--reasoning', 'auto')});
  else {
    const file = path.join(path.resolve(opt('--dir', '.')), doc, 'analysis.json');
    if (!fs.existsSync(file)) { per.push({doc, missing: true}); continue; }
    result = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const findings = scoreFindings(result, t.findings, {e2e: mode !== 'sop'});
  const kpis = mode === 'sop' ? scoreKpis(result, t.kpis) : null;
  const score = result.measures.find(m => m.predicate === 'rubric_score');
  const rubric = mode === 'sop' ? {expected: t.rubric.score, got: score ? Object.values(score.values).at(-1) : 0} : null;
  per.push({doc, kind: t.kind, findings, kpis, rubric, provenance: provenance(result, docText), engines: result.routes?.engines ?? [], ms: result.ms});
}
const rows = per.filter(r => !r.missing);
const sum = (f, rs = rows) => rs.reduce((n, r) => n + f(r), 0);
const precision = rs => ratio(sum(r => r.findings.tp, rs), sum(r => r.findings.tp + r.findings.fp, rs));
const recall = rs => ratio(sum(r => r.findings.tp, rs), sum(r => r.findings.expected, rs));
const summary = {
  mode, documents: rows.length, missing: per.filter(r => r.missing).map(r => r.doc),
  findings: {expected: sum(r => r.findings.expected), predicted: sum(r => r.findings.predicted), tp: sum(r => r.findings.tp), strict: sum(r => r.findings.strict), fp: sum(r => r.findings.fp),
    precision: precision(rows), recall: recall(rows), precision_ci95: bootstrap(rows, precision), recall_ci95: bootstrap(rows, recall)},
  ...(mode === 'sop' ? {kpis: {expected: sum(r => r.kpis.expected), correct: sum(r => r.kpis.correct), extra: sum(r => r.kpis.extra.length)}, rubric: {correct: rows.filter(r => r.rubric.got === r.rubric.expected).length, of: rows.length}} : {}),
  provenance: {findings_with_evidence: sum(r => r.provenance.findings_with_evidence), findings: sum(r => r.provenance.findings), quotes: sum(r => r.provenance.quotes), quotes_ok: sum(r => r.provenance.quotes_ok)},
};
const outDir = path.join(ROOT, 'eval', 'reports', 'current', 'analysis');
fs.mkdirSync(outDir, {recursive: true});
fs.writeFileSync(path.join(outDir, `${mode}.json`), JSON.stringify({ran_at: new Date().toISOString(), summary, documents: per}, null, 1) + '\n');
if (args.includes('--json')) console.log(JSON.stringify({summary, documents: per}, null, 1));
else {
  for (const r of per) console.log(r.missing ? `${r.doc}: no analysis` : `${r.doc}: findings ${r.findings.tp}/${r.findings.expected} found, ${r.findings.fp} spurious${r.kpis ? `; KPIs ${r.kpis.correct}/${r.kpis.expected} (+${r.kpis.extra.length} extra)` : ''}${r.rubric ? `; rubric ${r.rubric.got}/${r.rubric.expected}` : ''}; quotes ${r.provenance.quotes_ok}/${r.provenance.quotes}${r.findings.missed.length ? `; missed ${r.findings.missed.join(', ')}` : ''}${r.findings.spurious.length ? `; spurious ${r.findings.spurious.join(', ')}` : ''}`);
  console.log(JSON.stringify(summary));
}
