/**
 * Scoring, failure attribution and the summary of the KBQA evaluation (tools/eval/kbqa/cli.mjs `report`).
 *
 * Outcome of one question (against the gold of the sealed suite, read only here):
 *   correct   the chain answered and the answer equals the gold (entity sets equal; SimpleQuestions: every answered item is a gold value,
 *             since the benchmark asks for one; boolean, number, date and string equal after normalization);
 *   wrong     the chain answered definitely (an entity set, a number, a yes) and the answer differs from the gold (`partial` when the sets overlap);
 *   unknown   honest unknown: no answer, a clarification, an unparsed or unclear message, `unknown`, `not_computable`, an error.
 *             A gold "no" met by "unknown" is an honest unknown (the memory is open-world), never correct.
 * Attribution of every non-correct question to the first layer that failed (`layer.sub`):
 *   symbolic_lm   the service failed, or its SOP has no query (unparsed/unclear/statement), or the message was rejected at admission;
 *   linker        the KnowledgeLinker asked a clarification (relation unknown/ambiguous/role mismatch, entity unknown/ambiguous), or linked
 *                 a predicate other than the gold property (when the benchmark gives it), or an entity other than the annotated one;
 *   memory_slice  the gold answer entity is not an item of the slice, so no engine could produce it;
 *   engine        everything else: a linked, executed query that returns nothing or the wrong set (reasoner, query shape, mode).
 */
import fs from 'node:fs';
import path from 'node:path';
import {ROOT, BENCHMARKS} from './benchmarks.mjs';
import {readSuite} from './suites.mjs';
import {reportDir, stageFile} from './run.mjs';
import {loadSlice, memoryId} from './memory.mjs';

const norm = s => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const upperQ = v => (typeof v === 'string' && /^q\d+$/.test(v) ? v.toUpperCase() : v);

function goldSets(row) {
  const answers = row.gold.answers ?? [];
  return {entities: new Set(answers.filter(a => a.kind === 'entity').map(a => a.qid)), booleans: answers.filter(a => a.kind === 'boolean').map(a => a.value),
    numbers: answers.filter(a => a.kind === 'number').map(a => a.value), strings: answers.filter(a => a.kind === 'date' || a.kind === 'string').map(a => String(a.value))};
}

/** {outcome, partial, f1} of a record against the suite row. */
export function score(row, rec) {
  const g = goldSets(row);
  const a = rec.answer ?? {kind: 'none'};
  // Open world: only a definite status carries an answer (supported, refuted, contradicted, conflicted); unknown/clarify/... never do.
  if (rec.error || a.kind === 'none' || !['supported', 'refuted', 'contradicted', 'false', 'conflicted'].includes(rec.status)) return {outcome: 'unknown', f1: 0};
  if (a.kind === 'boolean') {
    if (!g.booleans.length) return {outcome: 'wrong', f1: 0};
    return g.booleans.includes(a.value) ? {outcome: 'correct', f1: 1} : {outcome: 'wrong', f1: 0};
  }
  if (a.kind === 'number') {
    const ok = g.numbers.some(n => Math.abs(n - a.value) < 1e-9) || g.strings.some(s => Number(s) === a.value);
    return ok ? {outcome: 'correct', f1: 1} : {outcome: 'wrong', f1: 0};
  }
  const values = [...new Set((a.values ?? []).map(upperQ))];
  const entities = values.filter(v => /^Q\d+$/.test(v));
  const literals = values.filter(v => !/^Q\d+$/.test(v));
  if (g.entities.size) {
    const hit = entities.filter(e => g.entities.has(e));
    const precision = entities.length ? hit.length / entities.length : 0, recall = hit.length / g.entities.size;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    const anyOf = row.gold.any_of;
    const ok = anyOf ? entities.length > 0 && hit.length === entities.length : entities.length === g.entities.size && hit.length === g.entities.size;
    return ok ? {outcome: 'correct', f1: 1} : {outcome: 'wrong', partial: hit.length > 0, f1: anyOf ? 0 : f1};
  }
  const gl = new Set([...g.strings.map(norm), ...g.numbers.map(String)]);
  const known = v => gl.has(norm(v)) || gl.has(String(Number(v)));
  return literals.length > 0 && literals.every(known) ? {outcome: 'correct', f1: 1} : {outcome: 'wrong', f1: 0};
}

const NO_QUERY = /@\w+\s+(unparsed|unclear)\b/;
function attribute(row, rec, slice) {
  if (rec.error) return rec.error_layer === 'parser_failed' ? 'parser.failed' : rec.error_layer === 'sop_admission' ? 'author.admission' : rec.error_layer === 'timeout' ? 'author.timeout' : /SymbolicLM/.test(rec.error) ? 'author.service' : 'chain.error';
  const sop = rec.sop ?? '';
  if (NO_QUERY.test(sop)) return /@\w+\s+unclear/.test(sop) ? 'author.unclear' : (/@\w+\s+query\b/.test(sop) ? 'author.partly_unparsed' : 'author.unparsed');
  if (!/@\w+\s+query\b/.test(sop)) return 'author.no_query';
  if (rec.status === 'clarify' || rec.required?.length) {
    const r = rec.required?.[0];
    return `linker.${r ? `${r.kind}_${r.status}` : rec.reason ?? 'clarify'}`;
  }
  if (rec.status === 'incomplete') return `retrieval.incomplete_${rec.reason_detail ?? 'unknown'}`;
  if (rec.unresolved_spans?.length && rec.status !== 'supported') return 'author.partly_unparsed';
  // memory slice: no gold answer entity among the items
  const goldEntities = (row.gold.answers ?? []).filter(a => a.kind === 'entity').map(a => a.qid);
  if (goldEntities.length && slice && !goldEntities.some(q => slice.items.has(q))) return 'memory_slice.answer_not_in_slice';
  // linked predicate and entities against the annotation
  const used = (rec.where ?? []).map(w => w.p).filter(p => typeof p === 'string');
  const wantProps = (row.properties ?? []).filter(p => p !== 'P31' && p !== 'P279');
  if (wantProps.length && used.length) {
    const pids = used.map(p => (p.match(/^p(\d+)_/) ?? [])[1]).filter(Boolean).map(n => `P${n}`);
    if (pids.length && !wantProps.some(p => pids.includes(p))) return 'linker.wrong_predicate';
  }
  const constants = (rec.where ?? []).flatMap(w => (Array.isArray(w.a) ? w.a : [])).filter(x => typeof x === 'string' && /^q\d+$/.test(x)).map(upperQ);
  if (row.entities?.length && constants.length && !constants.some(c => row.entities.includes(c))) return 'linker.wrong_entity';
  if (rec.mode && !['select', 'exists', 'count'].includes(rec.mode)) return `engine.mode_${rec.mode}`;
  return rec.status === 'unknown' ? 'engine.no_answer_from_linked_query' : 'engine.wrong_result';
}

function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = k / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}

/** Paired bootstrap of the accuracy difference a-b over the shared questions (arrays of 0/1 aligned by index). */
export function pairedBootstrap(a, b, {iterations = 4000, seed = 1} = {}) {
  const n = a.length;
  let s = seed >>> 0;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  const diffs = [];
  for (let i = 0; i < iterations; i++) { let d = 0; for (let j = 0; j < n; j++) { const k = Math.floor(rand() * n); d += a[k] - b[k]; } diffs.push(d / n); }
  diffs.sort((x, y) => x - y);
  return {mean: a.reduce((x, y) => x + y, 0) / n - b.reduce((x, y) => x + y, 0) / n, lo: diffs[Math.floor(0.025 * iterations)], hi: diffs[Math.floor(0.975 * iterations)], n};
}

const read = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);

/** Scores one suite stage; `tag` selects a rerun file. Returns the aggregate and per-question detail. */
export async function scoreStage(suite, stage, {tag = '', withSlice = true} = {}) {
  const records = read(stageFile(suite, stage, tag));
  if (!records.length) return null;
  const rows = new Map(readSuite(suite, 'all').map(r => [r.id, r]));
  let slice = null;
  if (withSlice) { try { slice = await loadSlice(suite, stage); } catch { slice = null; } }
  const per = records.map(rec => {
    const row = rows.get(rec.id);
    const s = score(row, rec);
    const layer = s.outcome === 'correct' ? null : attribute(row, rec, slice);
    return {id: rec.id, type: row.type, outcome: s.outcome, partial: s.partial ?? false, f1: s.f1, layer, ms: rec.ms};
  });
  const n = per.length, count = o => per.filter(p => p.outcome === o).length;
  const technical = records.filter(r => r.error || !/@\w+\s+\w+/.test(r.sop ?? '')).length;
  const byType = {}, byLayer = {};
  for (const p of per) {
    const t = (byType[p.type] ??= {n: 0, correct: 0, wrong: 0, unknown: 0});
    t.n++; t[p.outcome]++;
    if (p.layer) { const top = p.layer.split('.')[0]; byLayer[top] = (byLayer[top] ?? 0) + 1; byLayer[p.layer] = (byLayer[p.layer] ?? 0) + 1; }
  }
  const [lo, hi] = wilson(count('correct'), n);
  return {suite, stage, tag, n, correct: count('correct'), wrong: count('wrong'), unknown: count('unknown'), accuracy: count('correct') / n, ci95: [lo, hi],
    wrong_rate: count('wrong') / n, unknown_rate: count('unknown') / n, mean_f1: per.reduce((a, p) => a + p.f1, 0) / n, technical_failures: technical, technical_rate: technical / n,
    median_ms: per.map(p => p.ms).sort((a, b) => a - b)[Math.floor(n / 2)], by_type: byType, by_layer: byLayer, per};
}

export function stopDecision(s) {
  if (s.technical_rate > 0.2) return {stop: true, reason: `broken: ${(100 * s.technical_rate).toFixed(0)}% of the ${s.n} questions have an error or an empty SOP (limit 20%)`};
  if (s.stage === '300' && s.ci95[1] < 0.03) return {stop: true, reason: `futility: the 95% upper bound of the accuracy at 300 is ${(100 * s.ci95[1]).toFixed(1)}%, below the 3% needed to change the conclusion`};
  return {stop: false, reason: null};
}

const pct = x => `${(100 * x).toFixed(1)}%`;

/** Evidence for the owners of the failing layers: the most frequent clarification targets and examples of unparsed and wrong answers. */
function backlog(suite, stage, tag, per) {
  const recs = read(stageFile(suite, stage, tag));
  const layerOf = new Map(per.map(p => [p.id, p]));
  const asked = new Map(), spans = [], wrong = [];
  for (const rec of recs) {
    for (const r of rec.required ?? []) { const k = `${r.kind ?? 'entity'} ${r.status}: ${r.text ?? ''}`.trim(); asked.set(k, (asked.get(k) ?? 0) + 1); }
    const p = layerOf.get(rec.id);
    if (p?.layer?.startsWith('author') && spans.length < 6) spans.push(`${rec.question} -> ${(rec.unresolved_spans ?? []).map(x => x.span).join(' / ') || p.layer}`);
    if (p?.outcome === 'wrong' && wrong.length < 6) wrong.push(`${rec.question} -> ${(rec.where ?? []).map(w => w.p).join(', ') || '?'} -> ${JSON.stringify(rec.answer?.values ?? rec.answer?.value ?? null).slice(0, 80)}`);
  }
  const top = [...asked].sort((a, b) => b[1] - a[1]).slice(0, 12);
  return {top_clarifications: top, author_examples: spans, wrong_examples: wrong};
}

const RUNS = {'': 'mechanical lexicon, first run (linker before the M0 completion; superseded by the m0 runs)', '-lex': 'authored lexicon, first run (linker before the M0 completion; superseded by the m0 runs)',
  '-m0': 'mechanical lexicon (Wikidata labels and aliases only), linker after M0 and the slice path', '-lex-m0': 'authored lexicon (omp-written relation phrases per property), linker after M0 and the slice path'};

export async function writeReport({suites}) {
  const dir = path.join(ROOT, 'eval', 'reports', 'current', 'kbqa');
  fs.mkdirSync(dir, {recursive: true});
  const result = {generated_at: new Date().toISOString(), suites: {}};
  let md = `# KBQA end-to-end evaluation (experiment eval-kbqa-v1)\n\nGenerated ${result.generated_at}. Chain: coding agent -> KnowledgeLinker -> reference route over a Wikidata-slice base memory (the slice is gold-guided: it measures the chain given the knowledge). Numbers are observations of this run, not product claims. Preregistration: status/preregistrations/eval-kbqa-v1.json.\n\n`;
  for (const suite of suites) {
    const runs = {};
    const scored = {};
    for (const [tag, title] of Object.entries(RUNS)) {
      const stages = {};
      for (const stage of ['100', '300', 'all']) {
        const s = await scoreStage(suite, stage, {tag});
        if (!s) continue;
        scored[`${stage}${tag}`] = s;
        const {per, ...agg} = s;
        stages[stage] = {...agg, stop: stopDecision(s)};
        fs.writeFileSync(path.join(reportDir(suite), `score-${stage}${tag}.json`), JSON.stringify(s, null, 1));
      }
      if (Object.keys(stages).length) runs[tag || 'mechanical'] = {title, stages};
    }
    const baselines = {};
    for (const file of fs.existsSync(reportDir(suite)) ? fs.readdirSync(reportDir(suite)).filter(f => /^baseline-.*\.json$/.test(f)) : []) baselines[file.replace(/^baseline-|\.json$/g, '')] = JSON.parse(fs.readFileSync(path.join(reportDir(suite), file), 'utf8'));
    // Paired bootstrap on the shared questions of stage 100: every chain run against every baseline, and the runs against each other.
    const paired = [];
    const vec = per => new Map(per.map(p => [p.id, p.outcome === 'correct' ? 1 : 0]));
    const subjects = [...Object.entries(scored).filter(([k]) => k.startsWith('100')).map(([k, v]) => [`chain${k.slice(3) || '-first'}`, vec(v.per)]), ...Object.entries(baselines).map(([m, b]) => [`baseline ${m}`, vec(b.per)])];
    for (let i = 0; i < subjects.length; i++) for (let j = i + 1; j < subjects.length; j++) {
      const ids = [...subjects[i][1].keys()].filter(id => subjects[j][1].has(id));
      if (ids.length >= 20) paired.push({a: subjects[i][0], b: subjects[j][0], ...pairedBootstrap(ids.map(id => subjects[i][1].get(id)), ids.map(id => subjects[j][1].get(id)))});
    }
    result.suites[suite] = {runs, baselines: Object.fromEntries(Object.entries(baselines).map(([m, b]) => [m, {...b, per: undefined}])), paired};
    md += `## ${suite} (${BENCHMARKS[suite].license})\n\n`;
    for (const [name, run] of Object.entries(runs)) {
      md += `### Chain, ${run.title}\n\n| stage | n | correct | wrong | unknown | accuracy (95% CI) | mean F1 | technical failures | median ms |\n|---|---|---|---|---|---|---|---|---|\n`;
      for (const [stage, s] of Object.entries(run.stages)) md += `| ${stage} | ${s.n} | ${s.correct} | ${s.wrong} | ${s.unknown} | ${pct(s.accuracy)} (${pct(s.ci95[0])}-${pct(s.ci95[1])}) | ${s.mean_f1.toFixed(3)} | ${pct(s.technical_rate)} | ${s.median_ms} |\n`;
      const last = Object.entries(run.stages).at(-1);
      const [stage, s] = last;
      md += `\nStop rule at stage ${stage}: ${s.stop.stop ? s.stop.reason : 'continue'}\n\nFailure attribution at stage ${stage} (${s.n - s.correct} questions not answered correctly):\n\n| layer | count |\n|---|---|\n`;
      const tops = Object.entries(s.by_layer).filter(([k]) => !k.includes('.')).sort((x, y) => y[1] - x[1]);
      for (const [top, count] of tops) {
        md += `| **${top}** | ${count} |\n`;
        for (const [k, v] of Object.entries(s.by_layer).filter(([k]) => k.startsWith(top + '.')).sort((x, y) => y[1] - x[1])) md += `| &nbsp;&nbsp;${k} | ${v} |\n`;
      }
      md += `\nBy question type:\n\n| type | n | correct | wrong | unknown |\n|---|---|---|---|---|\n`;
      for (const [k, v] of Object.entries(s.by_type)) md += `| ${k} | ${v.n} | ${v.correct} | ${v.wrong} | ${v.unknown} |\n`;
      const b = backlog(suite, stage, name === 'mechanical' ? '' : name, scored[`${stage}${name === 'mechanical' ? '' : name}`].per);
      run.backlog = b;
      md += `Backlog evidence (stage ${stage}): most frequent clarification targets: ${b.top_clarifications.map(([k, v]) => `${k} (${v})`).join('; ') || 'none'}.\n\n`;
      if (b.author_examples.length) md += `Circuit author examples: ${b.author_examples.join(' | ')}\n\n`;
      if (b.wrong_examples.length) md += `Wrong answers (question -> linked predicates -> answer): ${b.wrong_examples.join(' | ')}\n\n`;
    }
    if (Object.keys(baselines).length) {
      md += `### llm-agent baselines (stage 100; a model reading the same slice statements as text, omp, no outside knowledge)\n\n| model | questions covered | answered lines | correct | wrong | unknown | accuracy (of covered) |\n|---|---|---|---|---|---|---|\n`;
      for (const [m, b] of Object.entries(baselines)) md += `| ${m}${b.complete === false ? ' (incomplete: provider limit)' : ''} | ${b.n}/${b.n_total ?? b.n} | ${b.answered_lines} | ${b.correct} | ${b.wrong} | ${b.unknown} | ${pct(b.accuracy)} |\n`;
      md += '\n';
    }
    if (paired.length) {
      md += `### Paired bootstrap on the shared questions (accuracy difference a - b, 95% interval)\n\n| a | b | n | difference | interval |\n|---|---|---|---|---|\n`;
      for (const d of paired) md += `| ${d.a} | ${d.b} | ${d.n} | ${(100 * d.mean).toFixed(1)} pts | ${(100 * d.lo).toFixed(1)} to ${(100 * d.hi).toFixed(1)} |\n`;
      md += '\n';
    }
  }
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(result, null, 1));
  fs.writeFileSync(path.join(dir, 'summary.md'), md);
  return {summary: 'eval/reports/current/kbqa/summary.md', suites: Object.fromEntries(Object.entries(result.suites).map(([k, v]) => [k, Object.fromEntries(Object.entries(v.runs).map(([r, run]) => [r, Object.fromEntries(Object.entries(run.stages).map(([s, a]) => [s, {n: a.n, accuracy: a.accuracy}]))]))]))};
}
