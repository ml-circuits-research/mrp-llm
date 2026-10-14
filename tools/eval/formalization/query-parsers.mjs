#!/usr/bin/env node
/**
 * Evaluation of the formalizer (experiment eval-query-parsers-v1, DS007): the step-by-step strategy (LocalLLMStepByStep or
 * InternalReasoningStepByStep) with its questions answered by one Ploinky tier (`--tier`, like with like) or the product ladder (default);
 * one-shot LLMDirect was archived on 2026-10-02 (probably_obsolete/one-shot-formalization/), on the same questions over the
 * same base memory, through the chat turn of ChatSOPAdapter (tools/eval/lib/chat-turn.mjs, the same glue as the chat: Agent turn with admission,
 * linking, slice retrieval, StrategyRouter, oracle verification, completeness guard, rendering). In process, no server, no port; a failed
 * formalizer is an error of the record (`parser_failed`), never replaced by another answer.
 *
 *   node tools/eval/formalization/query-parsers.mjs run    --suite world30|forms [--tier tiny|small|medium|good] [--strategy LocalLLMStepByStep|InternalReasoningStepByStep] [--limit N] [--only q01,q02] [--concurrency 3] [--rows file] [--base world-v1] [--tag t] [--force]
 *   node tools/eval/formalization/query-parsers.mjs recall --rows file [--k 24]   # recall of the gold predicates (the ids of the row's kb_query) in the retrieved candidates, no model
 *   node tools/eval/formalization/query-parsers.mjs report [--suites world30,forms]
 *
 * Suites: `world30` = eval/world-kb/questions.json (30 questions; the six Romanian ones are asked in their English form: the formalizer reads any
 * language, but the gold of this suite was written for the English form); `forms` = a JSONL of {id, form, question, gold} (the dev set of
 * tools/eval/formalization/query-forms, --rows). Outcomes per question: `correct`, `wrong` (a definite answer that differs from the gold: the dangerous class),
 * `honest_unknown` (unknown, clarify, incomplete, unclear, not computable...: no answer given), `parser_failed`, `error`. Latency is the parser time
 * and the whole turn, cost the provider cost (usage.cost; the openference plan is a flat subscription). Outputs: eval/reports/current/query-parsers/<suite>-<strategy>-<tier><tag>.jsonl, report.json, report.md. The sealed
 * suites of kbqa.mjs are run through `node tools/eval/kbqa/cli.mjs run --suite ... [--tier ...]`, once.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {BASE_NAME} from '../../../lib/chat-data/memories.mjs';
import {harnessChat} from '../lib/chat-turn.mjs';
import {candidatePredicates, predicateRecall} from '../../../lib/query-author/retrieval.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const OUT = path.join(ROOT, 'eval/reports/current/query-parsers');
const ENGLISH = {q05: 'When was Albert Einstein born?', q09: 'What is the official language of Brazil?', q12: 'On which continent is Egypt?', q15: 'What is the atomic number of gold?', q19: 'Who founded Microsoft?', q22: 'Who directed Inception?'};
const DEFINITE = new Set(['supported', 'refuted', 'contradicted', 'false', 'conflicted']);
const norm = s => String(s).toLowerCase().replace(/_/g, ' ').normalize('NFKD').replace(/\p{M}/gu, '');

export function judgeWorld(q, packet, text, labels = {}) {
  const status = packet?.status ?? null;
  const blob = norm(`${text} ${JSON.stringify(packet?.proof ?? [])} ${JSON.stringify(packet?.answers ?? [])} ${status}`);
  const matched = q.expect.filter(e => e === 'true' ? status === 'supported' : e === 'false' ? status === 'refuted' : e === 'lower_bound' ? status === 'incomplete' && /at least/i.test(text) : blob.includes(norm(e)) || blob.includes(norm(labels[e]?.en ?? e)));
  return matched.length > 0;
}
const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
export function judgeGold(gold, packet) {
  const status = packet?.status;
  if (!DEFINITE.has(status)) return false;
  if (typeof gold === 'boolean') return gold === (status === 'supported');
  if (typeof gold === 'number') return (packet.count ?? (packet.answers ?? []).length) === gold;
  const values = (packet.answers ?? []).flatMap(a => Object.values(a.binding ?? {})).map(v => (typeof v === 'number' ? v : String(v).toLowerCase()));
  return Array.isArray(gold) && sameSet(values, gold.map(v => (typeof v === 'number' ? v : String(v).toLowerCase())));
}
export const outcomeOf = (pass, packet, error) => error ? ((error.code === 'parse_failed' || error.code === 'parse_unavailable') ? 'parser_failed' : 'error') : pass ? 'correct' : DEFINITE.has(packet?.status) ? 'wrong' : 'honest_unknown';

async function run(args) {
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const suite = opt('--suite', 'world30'), tier = opt('--tier', null), strategy = opt('--strategy', null), parser = [strategy ?? 'steps', tier ?? 'ladder'].join('-').replace(/[^A-Za-z0-9._-]+/g, '_'), tag = opt('--tag', '') ? '-' + opt('--tag') : '';
  const out = path.join(OUT, `${suite}-${parser}${tag}.jsonl`);
  fs.mkdirSync(OUT, {recursive: true});
  const done = new Set(!args.includes('--force') && fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).id) : []);
  if (args.includes('--force')) fs.rmSync(out, {force: true});
  let rows;
  if (suite === 'world30') rows = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval/world-kb/questions.json'), 'utf8')).map(q => ({...q, question: ENGLISH[q.id] ?? q.q}));
  else rows = fs.readFileSync(opt('--rows'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const only = opt('--only', null)?.split(',');
  rows = rows.filter(r => (!only || only.includes(r.id)) && !done.has(r.id)).slice(0, Number(opt('--limit', 1e9)));
  const labels = fs.existsSync(path.join(ROOT, 'datasets_sources/world-kb/entities.json')) ? JSON.parse(fs.readFileSync(path.join(ROOT, 'datasets_sources/world-kb/entities.json'), 'utf8')) : {};
  // world30 runs on the product's chat data; the forms suite on the private root of the query-forms work (world-v1 with the measure lexemes of rules v2.9), unless QF_CHAT_ROOT says otherwise.
  if (suite === 'world30') process.env.QF_CHAT_ROOT ??= path.join(ROOT, 'chat_data');
  const {openSession} = await import('../lib/session.mjs');
  const base = opt('--base', 'world-v1');
  const session = openSession({base, id: `qp-${parser.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}-${Date.now().toString(36)}`});
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/runtime.json'), 'utf8'));
  const chat = harnessChat({config, tier, strategy, source: 'eval:query-parsers'});
  const lexicon = session.sessions.lexicon(session.id);
  const asOne = async row => {
    const started = Date.now();
    let parse = null, result = null, error = null;
    const entry = session.store.get('qp', 'c-' + row.id, BASE_NAME);
    try { const turned = await chat.turn(entry, row.question, {lexicon}); result = turned.result; parse = turned.parse; } catch (e) { error = e; parse = e.parse ?? null; }
    const packet = result?.packet ?? null;
    const pass = !error && (suite === 'world30' ? judgeWorld(row, packet, result.text ?? '', labels) : judgeGold(row.gold, packet));
    return {id: row.id, form: row.form ?? row.kind ?? null, question: row.question, parser, outcome: outcomeOf(pass, packet, error), status: packet?.status ?? null, text: (result?.text ?? '').slice(0, 300),
      model_sop: result?.sop ?? null, parse, error: error ? String(error.message).slice(0, 300) : null, parse_ms: parse?.ms ?? null, total_ms: Date.now() - started, cost_usd: parse?.cost_usd ?? 0, gold: row.gold ?? row.expect ?? null};
  };
  const concurrency = Number(opt('--concurrency', 3));
  const queue = [...rows];
  const workers = Array.from({length: concurrency}, async () => {
    for (let row; (row = queue.shift());) {
      const record = await asOne(row);
      fs.appendFileSync(out, JSON.stringify(record) + '\n');
      console.error(record.id, record.outcome, record.status ?? '-', record.total_ms + 'ms', '$' + record.cost_usd);
    }
  });
  await Promise.all(workers);
  session.close();
  await chat.close();
  console.log(JSON.stringify({suite, parser, written: rows.length, file: path.relative(ROOT, out)}));
}

/** The predicate ids of a gold knowledge query (positional atoms in its where and scope fields). */
export function goldPredicates(kbQuery) {
  const ids = new Set();
  const skip = new Set(['all', 'any', 'end', 'match', 'not']);
  for (const line of String(kbQuery).split('\n')) {
    const head = /^ {2}(?:where|scope)\s+(?:not\s+)?([a-z][a-z0-9_]*)\s/.exec(line);
    const inner = /^ {4,}(?:not\s+)?([a-z][a-z0-9_]*)\s/.exec(line);
    const name = (head ?? inner)?.[1];
    if (name && !skip.has(name)) ids.add(name);
  }
  return [...ids];
}

async function recall(args) {
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const rows = fs.readFileSync(opt('--rows'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.kb_query);
  process.env.QF_CHAT_ROOT ??= path.join(ROOT, 'chat_data');
  const {openSession} = await import('../lib/session.mjs');
  const session = openSession({base: opt('--base', 'world-v1'), id: `qp-recall-${Date.now().toString(36)}`});
  const lexicon = session.sessions.lexicon(session.id);
  const k = Number(opt('--k', 24));
  const perRow = rows.map(r => { const gold = goldPredicates(r.kb_query).filter(id => lexicon.predicates[id]); const got = candidatePredicates(r.question, lexicon, {k}); return {id: r.id, form: r.form, gold, recall: predicateRecall(got, gold), missed: gold.filter(id => !got.some(c => c.id === id))}; });
  session.close();
  const scored = perRow.filter(r => r.recall !== null);
  const mean = scored.reduce((t, r) => t + r.recall, 0) / Math.max(1, scored.length);
  const all = scored.filter(r => r.recall === 1).length;
  console.log(JSON.stringify({rows: scored.length, k, mean_recall: Math.round(mean * 1000) / 1000, rows_fully_covered: all, rows_fully_covered_pct: pct(all, scored.length), missed: perRow.filter(r => r.missed.length).map(r => ({id: r.id, missed: r.missed}))}, null, 1));
}

const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
const quantile = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null; };

function report(args) {
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
  const suites = opt('--suites', 'world30,forms').split(',');
  const table = [];
  const files = fs.existsSync(OUT) ? fs.readdirSync(OUT).filter(f => f.endsWith('.jsonl')).sort() : [];
  for (const suite of suites) for (const name of files.filter(f => f.startsWith(suite + '-'))) {
    const label = name.slice(suite.length + 1, -'.jsonl'.length);
    const file = path.join(OUT, name);
    const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const n = rows.length, count = k => rows.filter(r => r.outcome === k).length;
    const cost = rows.reduce((t, r) => t + (r.cost_usd ?? 0), 0);
    table.push({suite, parser: label, n, correct: count('correct'), wrong: count('wrong'), honest_unknown: count('honest_unknown'), parser_failed: count('parser_failed'), error: count('error'),
      accuracy_pct: pct(count('correct'), n), wrong_pct: pct(count('wrong'), n), unknown_pct: pct(count('honest_unknown'), n), parse_ms_median: quantile(rows.map(r => r.parse_ms ?? 0), 0.5), parse_ms_p90: quantile(rows.map(r => r.parse_ms ?? 0), 0.9),
      total_ms_median: quantile(rows.map(r => r.total_ms), 0.5), cost_usd_total: Math.round(cost * 1e5) / 1e5, cost_usd_per_question: n ? Math.round((cost / n) * 1e5) / 1e5 : null});
  }
  const md = ['# Circuit author: the formalizer (eval-query-parsers-v1)', '', '| suite | model | n | correct | wrong | honest unknown | parser failed | error | median parse ms | p90 parse ms | median turn ms | USD/question |', '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...table.map(r => `| ${r.suite} | ${r.parser} | ${r.n} | ${r.correct} (${r.accuracy_pct}%) | ${r.wrong} (${r.wrong_pct}%) | ${r.honest_unknown} (${r.unknown_pct}%) | ${r.parser_failed} | ${r.error} | ${r.parse_ms_median} | ${r.parse_ms_p90} | ${r.total_ms_median} | ${r.cost_usd_per_question} |`), ''].join('\n');
  fs.mkdirSync(OUT, {recursive: true});
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({generated_at: new Date().toISOString(), table}, null, 1) + '\n');
  fs.writeFileSync(path.join(OUT, 'report.md'), md);
  console.log(md);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'run') { await run(rest); process.exit(0); }
  else if (command === 'recall') { await recall(rest); process.exit(0); }
  else if (command === 'report') report(rest);
  else { console.error('usage: node tools/eval/formalization/query-parsers.mjs run|report [--suite world30|forms] [--tier T] [--strategy S]'); process.exit(2); }
}
