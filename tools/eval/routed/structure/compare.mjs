#!/usr/bin/env node
/**
 * Per-model outputs and partial credit of an A/B run (owner, 2026-10-03: keep every model's outputs for external comparison, near misses
 * included). Reads the run's raw.jsonl (ab.mjs fetch) and results.jsonl (ab.mjs score) and writes, in a stable run-named folder:
 *   <model>.jsonl   one record per problem: the raw structure JSON, the raw FOL per sentence, the path-B program, the converted SOP
 *                   circuits, the converter's reasons, the executed answers, the book answer, timings, token usage, the partial credit
 *   compare.jsonl   one row per problem with every model's partial-credit vector
 *   compare.md      the same side by side, with the per-model means on top
 * The model of an arm is its tier without the role prefix (structure-X, formalizer-X, tiny-X → X; structure-tiny, formalizer-tiny,
 * tiny → tiny). Offline evaluation tooling; the files hold book text and stay local (state/ is gitignored, DS011).
 *
 *   node tools/eval/routed/structure/compare.mjs --run moe-ab [--out state/moe-ab/moe-ab]
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadItems} from '../../books/sample.mjs';
import {goldOf} from './gold.mjs';
import {psmScore} from './score.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const arg = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const readJsonl = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);

/** The model of an arm (null for combination arms). */
export function modelOf(arm) {
  const [kind, spec] = arm.split(':');
  if (!['psm', 'lfm', 'expr'].includes(kind)) return null;
  return spec.replace(/^(structure|formalizer|tiny)-/, '') || spec;
}

/** Relative error of the closest numeric answer to the closest gold number; null when either side has no number. */
export function relativeError(values, gold) {
  if (gold?.kind !== 'number') return null;
  const nums = [].concat(values ?? []).flat().map(Number).filter(Number.isFinite);
  if (!nums.length) return null;
  let best = Infinity;
  for (const g of gold.values) for (const a of nums) best = Math.min(best, Math.abs(a - g) / Math.max(Math.abs(g), 1e-9));
  return Number(best.toPrecision(4));
}

const valuesOfLogic = r => (r?.answers ?? []).filter(a => a.value !== null && a.value !== undefined).map(a => a.value);
const ratio = (a, b) => (b ? Number((a / b).toFixed(3)) : null);

/** The partial-credit vector of one model on one problem. */
export function partialCredit(rec) {
  // An arm whose model gave no answer at all (an error or a client timeout) has no credit: null, not 0.
  const s = rec.structure?.raw?.error ? null : rec.structure, l = rec.logic?.error ? null : rec.logic, b = rec.pathB?.status === 'unavailable' ? null : rec.pathB;
  return {
    numbers_found: s ? ratio(s.score.usedCovered, s.score.usedInSolution) : null,
    goal: s ? s.score.goalFound : null,
    query: l ? l.queries > 0 : null,
    sentences_converted: l ? ratio(l.units.filter(u => u.converted).length, l.units.length) : null,
    logic_compiled: l ? l.circuits > 0 : null,
    logic_executed: l ? l.executed > 0 : null,
    logic_verdict: l?.verdict ?? null,
    logic_rel_err: l ? relativeError(valuesOfLogic(l), rec.gold) : null,
    b_accepted: b ? b.status === 'ok' : null,
    b_executed: b ? Boolean(b.executed) : null,
    b_verdict: b?.verdict ?? null,
    b_rel_err: b ? relativeError(b.got, rec.gold) : null,
  };
}

function build(run, out) {
  const dir = path.join(ROOT, 'state/structure-formalizer', run);
  const raw = readJsonl(path.join(dir, 'raw.jsonl')), results = readJsonl(path.join(dir, 'results.jsonl'));
  if (!results.length) throw new Error(`no results.jsonl in ${dir}: run ab.mjs score --run ${run} first`);
  const items = new Map(loadItems(ROOT).map(i => [i.id, i]));
  const res = new Map(results.map(r => [`${r.arm}|${r.id}`, r]));
  const recs = new Map(); // model → id → record
  const recOf = (model, id) => {
    if (!recs.has(model)) recs.set(model, new Map());
    const m = recs.get(model);
    if (!m.has(id)) { const item = items.get(id); m.set(id, {model, id, book: item.book, question: item.question, book_answer: item.answer ?? null, gold: goldOf(item), arms: {}, timings: {}, usage: {}}); }
    return m.get(id);
  };
  for (const r of raw) {
    const model = modelOf(r.arm);
    if (!model) continue;
    const kind = r.arm.split(':')[0], rec = recOf(model, r.id), sc = res.get(`${r.arm}|${r.id}`) ?? null, item = items.get(r.id);
    rec.arms[kind] = r.arm;
    rec.timings[kind] = {ms: r.ms, cached: Boolean(r.cached), ...(r.load ? {load: r.load} : {})};
    const usage = r.psm?.usage ?? r.extra?.usage ?? r.usage ?? null;
    if (usage) rec.usage[kind] = usage;
    if (kind === 'psm') {
      const score = psmScore(r, item);
      rec.structure = {raw: r.psm, score: {...score, names: undefined}};
    } else if (kind === 'lfm') {
      rec.logic = sc?.error ? {error: sc.error, fol: r.lfm} : {fol: Array.isArray(r.lfm) ? r.lfm.map((x, i) => ({sentence: r.units?.[i]?.text ?? x.input, candidates: x.candidates})) : r.lfm,
        units: sc?.units ?? [], queries: sc?.queriesInIr ?? 0, circuits: sc?.circuits ?? 0, executed: sc?.executed ?? 0,
        sop: sc?.sop ?? [], reasons: sc?.reasons ?? [], answers: sc?.answers ?? [], verdict: sc?.verdict ?? (sc?.error ? 'error' : null), extra: r.extra ?? null};
    } else if (kind === 'expr') {
      rec.pathB = {status: r.expr?.status ?? null, attempts: r.expr?.attempts ?? [], sop: r.expr?.sop ?? null, asked: r.expr?.answers ?? null,
        executed: sc?.executed ?? false, queries: sc?.queries ?? [], got: sc?.got ?? [], verdict: sc?.verdict ?? null};
    }
  }
  fs.mkdirSync(out, {recursive: true});
  const models = [...recs.keys()];
  const byId = new Map();
  for (const model of models) {
    const lines = [];
    for (const rec of recs.get(model).values()) {
      rec.partial = partialCredit(rec);
      lines.push(JSON.stringify(rec));
      if (!byId.has(rec.id)) byId.set(rec.id, {id: rec.id, book: rec.book, gold: rec.gold, models: {}});
      byId.get(rec.id).models[model] = rec.partial;
    }
    fs.writeFileSync(path.join(out, `${model}.jsonl`), lines.join('\n') + '\n');
  }
  const rows = [...byId.values()];
  fs.writeFileSync(path.join(out, 'compare.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(out, 'compare.md'), markdown(run, models, rows));
  return {models, problems: rows.length, out};
}

const mean = xs => { const v = xs.filter(x => x !== null && x !== undefined).map(Number); return v.length ? (v.reduce((a, b) => a + b, 0) / v.length) : null; };
const fmt = x => (x === null || x === undefined ? '-' : typeof x === 'boolean' ? (x ? '1' : '0') : Number(x).toFixed(2));
const verdictMark = v => ({correct: 'C', wrong: 'W', no_answer: '-'}[v] ?? '-');
const errMark = e => (e === null ? '' : `e${e < 0.01 ? '0' : e.toFixed(2)}`);

function markdown(run, models, rows) {
  const L = [`# Side-by-side partial credit: ${run} (${rows.length} problems)`, '',
    'Regenerate: `node tools/eval/routed/structure/compare.mjs --run ' + run + '`. Per model: N numbers of the solution found by the structure role, G goal found, Q question turned into a query, S sentences converted, L logic role (c compiled, x executed, C correct, W wrong), B path B (a accepted, x executed, C/W), e relative error of the closest numeric answer.', '',
    '## Means per model', '', 'Means over the problems where the arm answered (n); the relative error is the median over the WRONG numeric answers of the closest answer to the closest gold number (how near the misses are; 0 means a wrong answer list that still contains a gold number).', '',
    '| model | n (structure / logic / B) | numbers found | goal | query | sentences converted | logic compiled | logic executed | logic correct / wrong | logic miss rel. err | B accepted | B correct / wrong | B miss rel. err |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  const med = xs => { const v = xs.filter(x => x !== null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
  for (const m of models) {
    const P = rows.map(r => r.models[m]).filter(Boolean);
    const n = k => P.filter(p => p[k] !== null).length;
    L.push(`| ${m} | ${n('goal')} / ${n('query')} / ${n('b_accepted')} | ${fmt(mean(P.map(p => p.numbers_found)))} | ${fmt(mean(P.map(p => p.goal)))} | ${fmt(mean(P.map(p => p.query)))} | ${fmt(mean(P.map(p => p.sentences_converted)))} | ${fmt(mean(P.map(p => p.logic_compiled)))} | ${fmt(mean(P.map(p => p.logic_executed)))} | ${P.filter(p => p.logic_verdict === 'correct').length} / ${P.filter(p => p.logic_verdict === 'wrong').length} | ${fmt(med(P.filter(p => p.logic_verdict === 'wrong').map(p => p.logic_rel_err)))} | ${fmt(mean(P.map(p => p.b_accepted)))} | ${P.filter(p => p.b_verdict === 'correct').length} / ${P.filter(p => p.b_verdict === 'wrong').length} | ${fmt(med(P.filter(p => p.b_verdict === 'wrong').map(p => p.b_rel_err)))} |`);
  }
  L.push('', '## Per problem', '', `| problem | gold | ${models.join(' | ')} |`, `|---|---|${models.map(() => '---').join('|')}|`);
  for (const r of rows) {
    const cell = p => !p ? '' : [`N${fmt(p.numbers_found)}`, `G${fmt(p.goal)}`, `Q${fmt(p.query)}`, `S${fmt(p.sentences_converted)}`,
      `L${p.logic_compiled ? 'c' : ''}${p.logic_executed ? 'x' : ''}${verdictMark(p.logic_verdict)}${errMark(p.logic_rel_err)}`,
      `B${p.b_accepted ? 'a' : ''}${p.b_executed ? 'x' : ''}${verdictMark(p.b_verdict)}${errMark(p.b_rel_err)}`].join(' ');
    L.push(`| ${r.id} | ${r.gold?.kind ?? 'n/a'} | ${models.map(m => cell(r.models[m])).join(' | ')} |`);
  }
  return L.join('\n') + '\n';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const run = arg('run', 'moe-ab');
  const out = path.resolve(ROOT, arg('out', `state/moe-ab/${run}`));
  const r = build(run, out);
  console.log(`${r.models.length} models × ${r.problems} problems → ${path.relative(ROOT, r.out)}/ (${r.models.map(m => `${m}.jsonl`).join(', ')}, compare.jsonl, compare.md)`);
}
