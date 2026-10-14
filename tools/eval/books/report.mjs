#!/usr/bin/env node
/**
 * Report of a scored books-eval run: summary.md + summary.json per run, and the cumulative eval/reports/current/books-eval/index.md.
 *   node tools/eval/books/report.mjs --run <dir>
 * The run directory may hold notes.md (conclusions and improvement proposals written after reading the failure classes); it is
 * appended verbatim. Everything here quotes the owner's books and is gitignored (eval/reports/current/).
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const opt = (args, name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const readJsonl = f => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const OUTCOMES = ['correct', 'wrong', 'unknown', 'invalid', 'failed', 'pending'];
const pct = (a, b) => (b ? `${(100 * a / b).toFixed(0)}%` : '-');
const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

function tally(rows) {
  const t = Object.fromEntries(OUTCOMES.map(o => [o, 0]));
  for (const r of rows) t[r.verdict.outcome] = (t[r.verdict.outcome] ?? 0) + 1;
  return {n: rows.length, ...t};
}
const cells = t => `${t.correct}/${t.n} (${pct(t.correct, t.n)}) · w${t.wrong} u${t.unknown} i${t.invalid} f${t.failed}${t.pending ? ' p' + t.pending : ''}`;

/** The failure class of a non-correct record. */
export function failureClass(r) {
  const o = r.verdict.outcome, s = r.system ?? {};
  if (r.arm !== 'direct') {
    if (o === 'invalid') return /could not be read/.test(r.verdict.reason ?? '') ? 'formalizer: the oracle answers could not be read (protocol stopped)' : 'formalizer: no valid circuit';
    if (o === 'failed') return 'infrastructure failure';
    if (o === 'unknown') {
      if (s.status === 'unclear') return s.unclear_kind === 'relation_not_in_memory' ? 'understanding: no relation in memory expresses the question' : `understanding: unclear (${s.unclear_kind ?? 'other'})`;
      if (s.status === 'courtesy') return 'understanding: read as courtesy';
      return `reasoning: circuit valid, memory cannot answer (${s.status})`;
    }
    if (o === 'wrong') return `answered wrong (${s.formalization?.mode ?? s.kind ?? 'query'}${s.understanding?.statements_found ? ', with stated facts' : ', no stated facts captured'})`;
  } else {
    if (o === 'failed') return 'infrastructure failure';
    if (o === 'unknown') return 'declined to answer';
    if (o === 'wrong') return r.missing_final ? 'wrong or unfinished (no final-answer line)' : 'wrong final answer';
  }
  return o;
}

export function summarise(dir) {
  const rows = readJsonl(path.join(dir, 'scored.jsonl'));
  const run = fs.existsSync(path.join(dir, 'run.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')) : {run: path.basename(dir)};
  const arms = [...new Set(rows.map(r => r.arm))];
  const by = (arm, key) => { const m = new Map(); for (const r of rows.filter(x => x.arm === arm)) { const k = key(r); (m.get(k) ?? m.set(k, []).get(k)).push(r); } return m; };
  const summary = {run: run.run, started: run.started, n_items: new Set(rows.map(r => r.id)).size, model: run.model, base_memory: run.base_memory, arms: {}};
  const md = [];
  md.push(`# Books evaluation ${run.run}`, '', `Items: ${summary.n_items} (seed ${run.seed ?? '?'}), model ${run.model ?? '?'} (Qwen3-4B-Instruct Q4_K_M), base memory ${run.base_memory ?? '-'}, memory circuits sha ${(run.memory_circuits_sha256 ?? '-').slice(0, 12)}, strategy LocalLLMStepByStep method ${run.method ?? 'B'}.`,
    'Outcome cells: correct/n (rate) · w wrong · u honest unknown (the system declined) · i invalid (no valid circuit) · f infrastructure failure. A judge verdict "partial" counts as wrong.', '');
  md.push('## Overall', '', '| arm | n | correct | wrong | unknown | invalid | failed | answered accuracy | p50 ms |', '|---|---|---|---|---|---|---|---|---|');
  for (const arm of arms) {
    const rs = rows.filter(r => r.arm === arm), t = tally(rs);
    summary.arms[arm] = {...t, answered_accuracy: t.correct + t.wrong ? t.correct / (t.correct + t.wrong) : null, p50_ms: median(rs.map(r => r.ms ?? 0))};
    md.push(`| ${arm} | ${t.n} | ${t.correct} (${pct(t.correct, t.n)}) | ${t.wrong} | ${t.unknown} | ${t.invalid} | ${t.failed} | ${pct(t.correct, t.correct + t.wrong)} | ${Math.round(median(rs.map(r => r.ms ?? 0)))} |`);
  }
  // Paired comparison: how much reasoning the system adds over the bare model.
  if (arms.includes('steps') && arms.includes('direct')) {
    const S = new Map(rows.filter(r => r.arm === 'steps').map(r => [r.id, r])), D = new Map(rows.filter(r => r.arm === 'direct').map(r => [r.id, r]));
    const c = {both: 0, steps_only: 0, direct_only: 0, neither: 0};
    for (const [id, s] of S) { const d = D.get(id); if (!d) continue; const a = s.verdict.outcome === 'correct', b = d.verdict.outcome === 'correct'; c[a && b ? 'both' : a ? 'steps_only' : b ? 'direct_only' : 'neither']++; }
    summary.paired = c;
    md.push('', `Paired (same items): both correct ${c.both}, only steps ${c.steps_only}, only direct ${c.direct_only}, neither ${c.neither}. The system adds correct answers beyond the bare model on ${c.steps_only} items; it loses ${c.direct_only} the bare model solves.`);
  }
  for (const [title, key] of [['book', r => r.book], ['area', r => `${r.book} / ${r.area}`]]) {
    md.push('', `## Per ${title}`, '', `| ${title} | n | ${arms.join(' | ')} |`, `|---|---|${arms.map(() => '---').join('|')}|`);
    const keys = [...by(arms[0], key).keys()].sort();
    const out = {};
    for (const k of keys) {
      const n = by(arms[0], key).get(k).length;
      md.push(`| ${k} | ${n} | ${arms.map(a => cells(tally(by(a, key).get(k) ?? []))).join(' | ')} |`);
      out[k] = Object.fromEntries(arms.map(a => [a, tally(by(a, key).get(k) ?? [])]));
    }
    summary[`per_${title}`] = out;
  }
  // By answer kind
  md.push('', '## Per gold answer kind', '', `| kind | n | ${arms.join(' | ')} |`, `|---|---|${arms.map(() => '---').join('|')}|`);
  for (const k of [...by(arms[0], r => r.gold_kind).keys()].sort()) md.push(`| ${k} | ${by(arms[0], r => r.gold_kind).get(k).length} | ${arms.map(a => cells(tally(by(a, r => r.gold_kind).get(k) ?? []))).join(' | ')} |`);

  // What the system did (attribution), steps arm.
  for (const arm of arms.filter(a => a !== 'direct')) {
    const rs = rows.filter(r => r.arm === arm), sys = rs.map(r => r.system).filter(Boolean);
    const turns = sys.filter(s => s.turn === 'answered_turn');
    const queries = turns.filter(s => ['supported', 'refuted', 'partial', 'incomplete'].includes(s.status) || (s.answers?.length));
    const attr = {
      problems: rs.length, turn_completed: turns.length, circuit_valid: sys.filter(s => s.formalization?.valid).length,
      statements_found: sys.filter(s => s.understanding?.statements_found > 0).length, questions_per_problem_mean: mean(sys.map(s => s.understanding?.questions ?? 0)),
      status: Object.fromEntries([...new Set(sys.map(s => s.status ?? 'error'))].map(k => [k, sys.filter(s => (s.status ?? 'error') === k).length])),
      engine: Object.fromEntries([...new Set(turns.map(s => s.reasoning?.engine ?? 'none'))].map(k => [k, turns.filter(s => (s.reasoning?.engine ?? 'none') === k).length])),
      memory_found_facts: turns.filter(s => (s.knowledge?.retrieval_facts ?? 0) > 0).length, rules_fired: turns.filter(s => s.reasoning?.rules_used > 0).length,
      proof_facts_mean_answered: mean(queries.map(s => s.reasoning?.proof_facts ?? 0)), proof_facts_max: Math.max(0, ...queries.map(s => s.reasoning?.proof_facts ?? 0)),
      aggregates: turns.filter(s => s.reasoning?.aggregates > 0).length, answered: queries.length,
      answered_correct: rs.filter(r => r.verdict.outcome === 'correct' && (r.system?.answers?.length || ['supported', 'refuted'].includes(r.system?.status))).length,
      solver_ms_mean: mean(turns.map(s => s.reasoning?.solver_ms ?? 0)), parse_ms_mean: mean(turns.map(s => s.understanding?.parse_ms ?? 0)),
    };
    summary.arms[arm].attribution = attr;
    md.push('', `## What the system did (${arm})`, '',
      `- Problems ${attr.problems}; chat turns completed ${attr.turn_completed}; valid circuit written ${attr.circuit_valid}; problems where facts stated in the message were captured as turn evidence ${attr.statements_found}; questions asked of the model per problem (mean) ${attr.questions_per_problem_mean.toFixed(1)}.`,
      `- Result status: ${Object.entries(attr.status).map(([k, v]) => `${k} ${v}`).join(', ')}.`,
      `- Reasoning: engines ${JSON.stringify(attr.engine)}; memory held facts for the question in ${attr.memory_found_facts} turns; rules fired in ${attr.rules_fired}; answered by the engine ${attr.answered} (correct ${attr.answered_correct}); proof facts per answered problem mean ${attr.proof_facts_mean_answered.toFixed(1)}, max ${attr.proof_facts_max}; aggregates ${attr.aggregates}; mean parse ${Math.round(attr.parse_ms_mean)} ms, solver ${attr.solver_ms_mean.toFixed(1)} ms.`);
  }
  // Failure classes with examples
  for (const arm of arms) {
    const bad = rows.filter(r => r.arm === arm && r.verdict.outcome !== 'correct');
    const classes = new Map();
    for (const r of bad) { const k = failureClass(r); (classes.get(k) ?? classes.set(k, []).get(k)).push(r); }
    const sorted = [...classes.entries()].sort((a, b) => b[1].length - a[1].length);
    summary.arms[arm].failure_classes = sorted.map(([k, v]) => ({class: k, n: v.length, ids: v.map(r => r.id)}));
    md.push('', `## Failure classes (${arm})`);
    for (const [k, v] of sorted) {
      md.push('', `### ${k} — ${v.length}`);
      for (const r of v.slice(0, 3)) md.push('', `- \`${r.id}\` (${r.area})`, `  - question: ${cut(r.question, 420)}`, ...(r.system?.formalization?.sop ? [`  - circuit: \`${cut(r.system.formalization.sop, 300)}\``] : []),
        `  - answer: ${cut(r.response ?? r.text ?? r.verdict.reason, 260)}`, `  - gold: ${cut(r.gold, 220)}`, `  - verdict: ${r.verdict.outcome} by ${r.verdict.by}${r.verdict.reason ? ' — ' + cut(r.verdict.reason, 200) : ''}`);
    }
  }
  const notes = path.join(dir, 'notes.md');
  if (fs.existsSync(notes)) md.push('', fs.readFileSync(notes, 'utf8'));
  fs.writeFileSync(path.join(dir, 'summary.md'), md.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 1));
  writeIndex(path.dirname(dir));
  return summary;
}

/** The cumulative index across the run directories. */
export function writeIndex(base) {
  const runs = fs.readdirSync(base).filter(d => /^run-/.test(d) && fs.existsSync(path.join(base, d, 'summary.json'))).sort();
  const lines = ['# Books evaluation: all runs', '', '| run | items | arm | correct | wrong | unknown | invalid | failed | answered accuracy |', '|---|---|---|---|---|---|---|---|---|'];
  const cumulative = {};
  for (const d of runs) {
    const s = JSON.parse(fs.readFileSync(path.join(base, d, 'summary.json'), 'utf8'));
    for (const [arm, t] of Object.entries(s.arms)) {
      lines.push(`| [${d}](${d}/summary.md) | ${s.n_items} | ${arm} | ${t.correct} (${pct(t.correct, t.n)}) | ${t.wrong} | ${t.unknown} | ${t.invalid} | ${t.failed} | ${t.answered_accuracy == null ? '-' : pct(t.answered_accuracy * 1000, 1000)} |`);
      const c = cumulative[arm] ??= {n: 0, correct: 0, wrong: 0, unknown: 0, invalid: 0, failed: 0};
      for (const k of Object.keys(c)) c[k] += t[k] ?? 0;
    }
  }
  lines.push('', '## Cumulative', '', '| arm | n | correct | wrong | unknown | invalid | failed |', '|---|---|---|---|---|---|---|');
  for (const [arm, c] of Object.entries(cumulative)) lines.push(`| ${arm} | ${c.n} | ${c.correct} (${pct(c.correct, c.n)}) | ${c.wrong} | ${c.unknown} | ${c.invalid} | ${c.failed} |`);
  fs.writeFileSync(path.join(base, 'index.md'), lines.join('\n') + '\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = path.resolve(ROOT, opt(process.argv.slice(2), '--run', ''));
  const s = summarise(dir);
  console.log(`summary: ${path.relative(ROOT, path.join(dir, 'summary.md'))}`, JSON.stringify(Object.fromEntries(Object.entries(s.arms).map(([a, t]) => [a, `${t.correct}/${t.n}`]))));
}
