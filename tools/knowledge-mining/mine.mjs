#!/usr/bin/env node
/**
 * Knowledge mining from the owner's problem books (owner request of 2026-10-02): improves the general knowledge of the chat's default base
 * memory from the problems the system fails, unattended, and admits only knowledge that demonstrably fixes a problem without losing any
 * other answer. Facts and general rules are taken, never book text (DS011; the copy check below).
 *
 *   node tools/knowledge-mining/mine.mjs --n 20 [--seed km-1] [--workers 4] [--out DIR] [--resume DIR] [--ids a,b] [--no-admit]
 *
 * Stages (each writes its file in the run folder and is skipped when resumed):
 *   1. baseline   the product chat turn (tools/eval/books/system.mjs, the step-by-step questions on the Ploinky tier `small`) over a fork of the
 *                 default base memory plus the current commonsense-books-v1 layer, on `n` unseen problems (tools/eval/books/sample.mjs;
 *                 they are marked seen); scored by tools/eval/books/score.mjs rules, an LLM judge for what a rule cannot decide.
 *   2. propose    for each problem answered wrong, unknown or with no valid circuit: the Ploinky tier `small` (Qwen3.8 27b on openference,
 *                 falling back to DeepSeek) gets the problem and the failure trace and writes the GENERAL knowledge it needed as
 *                 SOP wires (lib/ingest/direct-author.mjs: the knowledge validator and this tool's checks in its repair loop).
 *   3. check      deterministic: duplicates and contradictions against the memory, the problem's own names, copied book text;
 *                 an entity the memory already has is merged into it.
 *   4. review     bulk truth and generality review on the Ploinky tier `medium` (DeepSeek flash) (lib/llm-review, kind commonsense-wires):
 *                 confirmed problems are repaired once or the wire is dropped and escalated.
 *   5. admit      per problem: rerun with its candidate group; admitted only when the rerun is correct AND a control rerun without the
 *                 group is not (the fix is the knowledge, not chance); then the fixed regression set must not lose any answer (a loss
 *                 confirmed by a control rerun removes the group that causes it). Admitted wires are appended to
 *                 config/knowledge/commonsense-books-v1/ with provenance (book, problem, model, reviewer, date) on every wire.
 * Outputs: eval/reports/current/knowledge-mining/run-<stamp>/ (baseline.jsonl, proposals/, candidates.jsonl, review/, trials.jsonl,
 * admitted.jsonl, escalations.jsonl, summary.md with at most 10 escalation lines, run.json with the cost from Ploinky's statistics).
 * Every model call goes through Ploinky (lib/pworker.mjs), tagged job:knowledge-mining and the run id of its stage
 * (`<run>.trial`, `<run>.author`, `<run>.review`, `<run>.judge`; registered with the Ploinky proxy, so its statistics give the cost
 * of each stage since the run started).
 */
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {parse, wireText} from '../../sop/knowledge/index.mjs';
import {validateCircuits} from '../../lib/chat-data/memories.mjs';
import {seedLayers} from '../../lib/knowledge-seeds.mjs';
import {directAuthor, openaiChat} from '../../lib/ingest/direct-author.mjs';
import {loadKind, reviewLoop, chat as reviewChat} from '../../lib/llm-review/index.mjs';
import {pworker} from '../../lib/pworker.mjs';
import {loadItems, loadSeen, markSeen, sampleItems} from '../eval/books/sample.mjs';
import {responseOf, deterministic} from '../eval/books/score.mjs';
import {numbersOf} from '../eval/books/extract.mjs';
import {memoryIndex, againstMemory, problemNames, problemOverlap, booksGramIndex, copyFindings, provenance, stamp, uniqueIds, mergeKnownEntities,
  undeclaredConstants, pruneDeclarations, KNOWLEDGE_TYPES} from './checks.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const LAYER_ID = 'commonsense-books-v1';
export const LAYER_DIR = path.join(ROOT, 'config', 'knowledge', LAYER_ID);
export const LAYER_FILE = path.join(LAYER_DIR, '0100-mined.sop');
export const REGRESSION_FILE = path.join(ROOT, 'tools', 'knowledge-mining', 'regression-set.json');
const SEED_LAYERS = ['core-min', 'core-en', 'commonsense-v1', 'assistant-v1'];
const CLIENTS = {trial: 'knowledge-mining-trial', author: 'knowledge-mining-author', review: 'knowledge-mining-review', judge: 'knowledge-mining-judge'};
/** Ploinky tiers (AGENTS.md: jobs name a tier, never a model): `small` is Qwen3.8 27b on openference (fallback DeepSeek), `medium` DeepSeek flash. */
const AUTHOR_MODEL = 'small';
const REVIEW_MODEL = 'medium';
const JUDGE_MODEL = 'small';
const MAX_REGRESSION = 15;

const args = process.argv.slice(2);
const opt = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const flag = n => args.includes(`--${n}`);
const readJsonl = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const writeJsonl = (f, rows) => fs.writeFileSync(f, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
const stampNow = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const log = m => console.error(`[mine ${new Date().toISOString().slice(11, 19)}] ${m}`);
const PURPOSE = 'job:knowledge-mining';
// The run id of this mining run (set by main); every stage's calls carry `<run>.<stage>` as their Ploinky run tag.
let RUN = null;
const stageRun = stage => (RUN ? `${RUN}.${stage}` : null);
const agentOf = stage => pworker({purpose: PURPOSE, run: stageRun(stage), client: CLIENTS[stage]});
const short = s => createHash('sha256').update(s).digest('hex').slice(0, 6);

/** A pool of `k` concurrent async tasks. */
async function pool(list, k, fn) {
  const out = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(k, list.length)}, async () => { while (next < list.length) { const i = next++; out[i] = await fn(list[i], i); } }));
  return out;
}

// ---- layers --------------------------------------------------------------------------------------------------------------------------

/** The circuits the mined knowledge is validated against: the seed layers of the default base and the admitted layer. */
function existingCircuits() {
  const seen = new Set();
  const seeds = SEED_LAYERS.flatMap(id => seedLayers(id)).filter(c => !seen.has(c.name) && seen.add(c.name));
  const admitted = fs.existsSync(LAYER_FILE) ? [{name: `${LAYER_ID}:0100-mined.sop`, text: fs.readFileSync(LAYER_FILE, 'utf8')}] : [];
  return [...seeds, ...admitted];
}

/** The world-v1 own circuits (Wikidata subset), for duplicates and contradictions. */
function worldCircuits() {
  const dir = path.join(ROOT, 'chat_data', 'base_memories', 'world-v1', 'circuits');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith('.sop')).map(n => ({name: n, text: fs.readFileSync(path.join(dir, n), 'utf8')})) : [];
}

const admittedLayer = () => (fs.existsSync(LAYER_FILE) && parse(fs.readFileSync(LAYER_FILE, 'utf8')).wires.length ? [LAYER_FILE] : []);

// ---- trials --------------------------------------------------------------------------------------------------------------------------

/** Runs problems through trial workers (child processes, `workers` at a time); returns the records in input order. */
async function runTrials({jobs, dir, workers}) {
  fs.mkdirSync(path.join(dir, 'trials'), {recursive: true});
  const results = await pool(jobs, workers, async job => {
    const out = path.join(dir, 'trials', `${job.tag}.jsonl`);
    const done = new Set(readJsonl(out).map(r => r.id));
    const ids = job.ids.filter(id => !done.has(id));
    if (ids.length) {
      const logFile = fs.openSync(path.join(dir, 'trials', `${job.tag}.log`), 'a');
      const code = await new Promise(resolve => {
        const child = spawn(process.execPath, ['--max-old-space-size=12288', path.join(ROOT, 'tools/knowledge-mining/trial.mjs'), '--ids', ids.join(','), '--out', out, '--tag', job.tag, ...(stageRun('trial') ? ['--run', stageRun('trial')] : []),
          ...(job.layer.length ? ['--layer', job.layer.join(',')] : [])], {stdio: ['ignore', logFile, logFile], cwd: ROOT});
        child.on('exit', resolve);
      });
      fs.closeSync(logFile);
      if (code !== 0) log(`trial ${job.tag} exited with ${code} (see trials/${job.tag}.log)`);
    }
    const recs = new Map(readJsonl(out).map(r => [r.id, r]));
    return job.ids.map(id => recs.get(id) ?? {tag: job.tag, id, ok: false, error: {code: 'trial_failed', message: `the trial worker ended without a record (trials/${job.tag}.log)`}, system: null});
  });
  return results;
}

/** One judge call on the `small` tier: `{ok, text, reason?}`. */
async function judgeChat(prompt) {
  const r = await agentOf('judge').chat({tier: JUDGE_MODEL, temperature: 0, maxTokens: 300, extraBody: {chat_template_kwargs: {enable_thinking: false}}, timeoutMs: 300_000,
    messages: [{role: 'system', content: 'You grade answers to school problems strictly against a reference answer.'}, {role: 'user', content: prompt}]});
  return r.ok && r.raw ? {ok: true, text: r.raw} : {ok: false, text: '', reason: r.ok ? 'empty reply' : r.reason};
}

/** Deterministic score, the LLM judge for the rest. `outcome`: correct | wrong | unknown | invalid | failed. */
async function scoreRecord(rec, item) {
  const scoredRec = {...rec, arm: 'remote-direct', gold_kind: item.answer_kind, gold_value: item.answer_value};
  if (rec.error?.code === 'trial_failed') return {outcome: 'failed', by: 'rule', reason: rec.error.message};
  const resp = responseOf(scoredRec);
  const rule = deterministic(scoredRec, resp);
  if (rule) return rule;
  const prompt = `Problem:\n${item.question}\n\nReference answer:\n${item.answer}\n\nSystem answer:\n${resp.text}\n\nDoes the system answer give the reference's final answer (every part the question asks for, same values)? Answer with one JSON object only: {"verdict":"correct"|"partial"|"wrong","reason":"<short>"}`;
  const r = await judgeChat(prompt);
  const m = r.ok ? r.text.match(/\{[\s\S]*\}/) : null;
  let verdict = null;
  try { verdict = m ? JSON.parse(m[0]) : null; } catch { verdict = null; }
  if (!verdict) return {outcome: 'wrong', by: 'judge', reason: `judge unavailable: ${r.reason ?? 'unparsable reply'}`};
  return {outcome: verdict.verdict === 'correct' ? 'correct' : 'wrong', by: 'judge', reason: `${verdict.verdict}: ${verdict.reason ?? ''}`.slice(0, 200)};
}

export async function scoreAll(records, items) {
  return pool(records, 4, async rec => ({...rec, score: await scoreRecord(rec, items.get(rec.id))}));
}

/** Runs and scores trial jobs; a problem whose turn failed for infrastructure (no record, timeout, no model) is run once more. */
async function scoredTrials({jobs, dir, workers, items}) {
  const first = await scoreAll((await runTrials({jobs, dir, workers})).flat(), items);
  const failed = first.filter(r => r.score.outcome === 'failed');
  if (!failed.length) return first;
  log(`retrying ${failed.length} trial(s) that failed for infrastructure`);
  const jobOf = id => jobs.find(j => j.ids.includes(id));
  const again = await scoreAll((await runTrials({jobs: failed.map(r => ({tag: `${jobOf(r.id).tag}-retry-${r.id.replace(/[^\w.-]/g, '_')}`, ids: [r.id], layer: jobOf(r.id).layer})), dir, workers})).flat(), items);
  const byId = new Map(again.map(r => [r.id, r]));
  return first.map(r => byId.get(r.id) ?? r);
}

// ---- propose -------------------------------------------------------------------------------------------------------------------------

export const MINER_INSTRUCTIONS = `You are mining GENERAL common-sense knowledge for the base memory of a symbolic reasoner. input/problem.txt is a school problem
(grade 8 or below) that the reasoner failed; input/failure.md shows how it failed (its circuit and the runtime's verdict). The reasoner reads
the problem's own data from the message itself; what it lacks is the general knowledge a pupil brings to such problems.

Write, in knowledge.sop, the general, timeless knowledge that problems of this KIND need and that the memory lacks: facts, rules, unit
definitions and conversion factors, formulas (rules with compute), part-whole relations, typical properties, uses, places and class
membership. Here the "source" is general knowledge taught at school, not the problem.

Hard rules:
1. GENERAL only: true for every problem of this kind. Never write the problem's names, invented entities (its people, places, plans, sites,
   letters such as A and B), its specific numbers, its story or its answer. Numbers only for universal definitions and constants (a week
   has 7 days, a metre has 100 centimetres, water freezes at 0 degrees Celsius).
2. Only what is true; when unsure, leave it out. A property that holds only typically is a default or a typical-relation fact, never a
   strict rule.
3. Reuse the predicates of input/existing-vocabulary.sop and the entities listed in input/known-entities.txt (use their ids); declare a
   new predicate only when none means the same, with args, roles, label en, description and one English lexeme.
4. If the failure does not come from missing general knowledge (the problem is self-contained, as most logic puzzles are, or the circuit
   was simply wrong), write knowledge.sop with the single comment line "# none: <one-line reason>" and nothing else. That is a good answer.
5. Ids of facts, rules, defaults and new entities start with kmb_. Write source "general knowledge" on every wire that takes a source
   (the runtime replaces it with provenance). Never quote the problem.
6. At most 12 wires besides declarations. queries.sop: one test query per rule (may be empty).
7. Use only the existing wire types (fact, rule, default, entity, predicate, lexeme). If the knowledge cannot be written with them, write
   none and say in report.md what wire type it would need (the owner decides new wire types; never invent one).`;

/** The failure trace the miner sees: verdict, circuit, the runtime's problems and the answer text (no gold answer). */
export function failureText(rec) {
  const s = rec.system ?? {};
  const lines = [`# How the reasoner failed`, '', `- turn: ${s.turn ?? (rec.ok ? 'answered_turn' : 'turn_error')}`, `- status: ${s.status ?? 'none'}${s.unclear_kind ? ` (${s.unclear_kind})` : ''}`];
  if (rec.error) lines.push(`- error: ${rec.error.code}: ${String(rec.error.message ?? '').slice(0, 300)}`);
  for (const p of rec.error?.problems ?? []) lines.push(`  - ${p.code}: ${String(p.message ?? '').slice(0, 200)}`);
  const k = s.knowledge ?? {}, r = s.reasoning ?? {};
  lines.push(`- memory predicates retrieved: ${k.predicates ?? 0}; rules used: ${r.rules_used ?? 0}; answers: ${(s.answers ?? []).length}`);
  if (rec.sop) lines.push('', '## The circuit the formalizer wrote', '', '```', String(rec.sop).slice(0, 3000), '```');
  if (rec.text) lines.push('', '## The reasoner\'s reply', '', String(rec.text).slice(0, 800));
  return lines.join('\n') + '\n';
}

/** Entities of the general vocabulary whose English label is a word or two-word phrase of the problem: id and label. */
function knownEntities(question, labels) {
  const words = String(question).toLowerCase().match(/[\p{L}]+/gu) ?? [];
  const found = new Map();
  for (let i = 0; i < words.length; i++) for (const n of [1, 2]) {
    const phrase = words.slice(i, i + n).join(' ');
    for (const form of [phrase, phrase.replace(/s$/, '')]) if (labels.has(form) && !found.has(form)) found.set(form, labels.get(form));
  }
  return [...found].slice(0, 80).map(([label, id]) => `${id}: ${label}`).join('\n') || '(none)';
}

async function propose({rec, item, dir, existing, labels, ids, names}) {
  const folder = path.join(dir, 'proposals', item.id.replace(/[^\w.-]/g, '_'));
  if (fs.existsSync(path.join(folder, 'result.json'))) return {id: item.id, ...JSON.parse(fs.readFileSync(path.join(folder, 'result.json'), 'utf8')), knowledge: fs.readFileSync(path.join(folder, 'knowledge.sop'), 'utf8')};
  const check = text => {
    const problems = [];
    const wires = parse(text).wires;
    const known = new Set([...ids, ...wires.map(w => w.id)]);
    for (const w of wires) {
      const story = undeclaredConstants(w, known);
      if (story.length) problems.push({code: 'undeclared_constant', wire: w.id, message: `${story.join(', ')} is declared nowhere: a general fact is about classes, units and kinds of the vocabulary (input/known-entities.txt, or a class entity you declare), never about the problem's own things; remove the fact or state it about the general class`});
      const own = problemOverlap(w, {names, numbers: []});
      if (own.names.length) problems.push({code: 'problem_name', wire: w.id, message: `the wire names the problem's own ${own.names.join(', ')}; write general knowledge without the problem's names`});
    }
    return problems;
  };
  const result = await directAuthor({folder, instructions: MINER_INSTRUCTIONS, existing, maxFixRounds: 2, maxTokens: 6000, timeoutMs: 600_000, check,
    files: [{name: 'problem.txt', text: item.question + '\n'}, {name: 'failure.md', text: failureText(rec)}, {name: 'known-entities.txt', text: knownEntities(item.question, labels) + '\n'}],
    chat: openaiChat({purpose: PURPOSE, run: stageRun('author')}), model: AUTHOR_MODEL});
  log(`propose ${item.id}: ${result.status}, ${result.rounds} rounds`);
  return {id: item.id, ok: result.ok, status: result.status, rounds: result.rounds, model: result.model, usage: result.usage, knowledge: result.circuits[0]?.text ?? '', report: result.report};
}

// ---- check, review, groups -----------------------------------------------------------------------------------------------------------

/** Validates a group against the existing circuits, dropping the wires the validator names until it passes. */
function settleGroup(wires, existing) {
  let current = wires;
  const dropped = [];
  for (let round = 0; round < 8 && current.length; round++) {
    const text = current.map(w => wireText(w)).join('\n\n') + '\n';
    const check = validateCircuits([{name: 'group.sop', text}], existing);
    if (check.ok) return {wires: current, dropped};
    const bad = new Set(check.problems.map(p => p.wire).filter(Boolean));
    if (!bad.size) { dropped.push(...current.map(w => ({id: w.id, reason: check.problems.map(p => p.code).join(',')}))); return {wires: [], dropped}; }
    for (const w of current) if (bad.has(w.id)) dropped.push({id: w.id, reason: check.problems.filter(p => p.wire === w.id).map(p => `${p.code}: ${p.message}`).join('; ').slice(0, 300)});
    current = current.filter(w => !bad.has(w.id));
  }
  return {wires: current.some(w => KNOWLEDGE_TYPES.includes(w.type)) ? current : [], dropped};
}

/** Predicate declarations a wire set uses (from the group or the existing circuits), as text for the reviewer's context. */
function declarationsFor(wires, existingDecls) {
  const used = new Set();
  for (const w of wires) for (const f of w.fields) for (const t of String(f.value).split(/\s+/)) if (existingDecls.has(t)) used.add(t);
  return [...used].map(id => existingDecls.get(id)).join('\n\n');
}

// ---- main ----------------------------------------------------------------------------------------------------------------------------

export async function main() {
  const t0 = Date.now();
  const workers = Number(opt('workers', 4));
  const resume = opt('resume');
  const dir = path.resolve(ROOT, resume ?? opt('out') ?? `eval/reports/current/knowledge-mining/run-${stampNow()}`);
  fs.mkdirSync(dir, {recursive: true});
  const runFile = path.join(dir, 'run.json');
  const run = fs.existsSync(runFile) ? JSON.parse(fs.readFileSync(runFile, 'utf8')) : {run: path.basename(dir), started: new Date().toISOString(), started_ms: t0, n: Number(opt('n', 20)), seed: opt('seed', 'km-1'), workers};
  fs.writeFileSync(runFile, JSON.stringify(run, null, 1));
  RUN = run.run;
  await registerStages(run.run);
  const all = loadItems(ROOT);
  const items = new Map(all.map(i => [i.id, i]));
  const escalations = [];

  // 1. sample and baseline
  const sampleFile = path.join(dir, 'problems.json');
  if (!fs.existsSync(sampleFile)) {
    const ids = opt('ids') ? opt('ids').split(',') : null;
    const picked = sampleItems(all, {n: run.n, seed: run.seed, ids, seen: loadSeen(ROOT)}).map(i => i.id);
    fs.writeFileSync(sampleFile, JSON.stringify(picked, null, 1));
    if (!ids) markSeen(ROOT, picked, `knowledge-mining/${run.run}`);
  }
  const problems = JSON.parse(fs.readFileSync(sampleFile, 'utf8'));
  const baselineFile = path.join(dir, 'baseline.jsonl');
  let baseline = readJsonl(baselineFile);
  // a problem whose trial worker died (no record) is run again once on resume
  const lostIds = baseline.filter(r => r.error?.code === 'trial_failed').map(r => r.id);
  if (lostIds.length && resume) {
    log(`baseline: running ${lostIds.length} problems again whose trial worker ended without a record`);
    const chunks = Array.from({length: workers}, (_, k) => lostIds.filter((_, i) => i % workers === k)).filter(c => c.length);
    const again = await scoredTrials({jobs: chunks.map((ids, k) => ({tag: `baseline-retry-${k}`, ids, layer: admittedLayer()})), dir, workers, items});
    const byId = new Map(again.map(r => [r.id, r]));
    baseline = baseline.map(r => byId.get(r.id) ?? r);
    writeJsonl(baselineFile, baseline);
  }
  if (baseline.length < problems.length) {
    log(`baseline: ${problems.length} problems, ${workers} workers`);
    const chunks = Array.from({length: workers}, (_, k) => problems.filter((_, i) => i % workers === k)).filter(c => c.length);
    baseline = await scoredTrials({jobs: chunks.map((ids, k) => ({tag: `baseline-${k}`, ids, layer: admittedLayer()})), dir, workers, items});
    writeJsonl(baselineFile, baseline);
  }
  const outcome = r => r.score?.outcome;
  const failing = baseline.filter(r => outcome(r) !== 'correct' && outcome(r) !== 'failed');
  log(`baseline: ${baseline.filter(r => outcome(r) === 'correct').length}/${baseline.length} correct; ${failing.length} failing problems to mine`);

  // 2. propose
  const existing = existingCircuits();
  const seedIndex = memoryIndex(existing);
  const proposalsFile = path.join(dir, 'proposals.jsonl');
  let proposals = readJsonl(proposalsFile);
  if (proposals.length < failing.length) {
    proposals = await pool(failing, workers, rec => propose({rec, item: items.get(rec.id), dir, existing, labels: seedIndex.labels, ids: seedIndex.ids, names: problemNames(items.get(rec.id).question, seedIndex.labels)}));
    writeJsonl(proposalsFile, proposals.map(({knowledge, ...p}) => ({...p, wires: parse(knowledge ?? '').wires.length})));
    proposals = readJsonl(proposalsFile);
  }

  // 3. deterministic checks
  log('checks: indexing the memory (world-v1 own circuits and the seed layers)');
  const index = memoryIndex([...existing, ...worldCircuits()]);
  const books = booksGramIndex(all);
  const candidates = [];
  for (const p of proposals) {
    const item = items.get(p.id);
    const folder = path.join(dir, 'proposals', p.id.replace(/[^\w.-]/g, '_'));
    const text = fs.existsSync(path.join(folder, 'knowledge.sop')) ? fs.readFileSync(path.join(folder, 'knowledge.sop'), 'utf8') : '';
    if (!p.ok) { candidates.push({id: p.id, wire: null, decision: 'proposal_invalid', reason: p.status}); continue; }
    const merged = mergeKnownEntities(parse(text).wires, index.labels);
    const names = problemNames(item.question, seedIndex.labels), numbers = [...new Set(numbersOf(item.question))];
    for (const w of merged.wires) {
      const mem = againstMemory(w, index);
      const own = problemOverlap(w, {names, numbers});
      const copy = copyFindings(w, [item.question, item.answer, item.solution].join('\n'), books);
      let decision = 'candidate', reason = null;
      const story = undeclaredConstants(w, new Set([...index.ids, ...merged.wires.map(x => x.id)]));
      if (story.length) { decision = 'dropped_story_entity'; reason = story.join(', '); }
      else if (copy.copied) { decision = 'dropped_copy'; reason = `copied book text: ${copy.long_spans} 8-grams, ${copy.distinctive_4grams} distinctive 4-grams`; }
      else if (own.names.length) { decision = 'dropped_problem_name'; reason = own.names.join(', '); }
      else if (mem.conflicts.length) { decision = 'conflict'; reason = mem.conflicts.join('; '); escalations.push({id: `${p.id}/${w.id}`, stage: 'check', reason: 'contradiction', detail: reason, work: wireText(w)}); }
      else if (mem.duplicate) { decision = 'duplicate'; reason = 'the memory holds the same wire'; }
      candidates.push({id: p.id, wire: w.id, type: w.type, decision, reason, problem_numbers: own.numbers, text: wireText(w)});
    }
    for (const [from, to] of merged.merged) candidates.push({id: p.id, wire: from, type: 'entity', decision: 'merged_into_memory', reason: `the memory already has ${to}`});
  }
  writeJsonl(path.join(dir, 'candidates.jsonl'), candidates);

  // 4. review (truth and generality), Ploinky tier medium (DeepSeek flash)
  const decls = new Map();
  for (const c of existing) for (const w of parse(c.text).wires) if (w.type === 'predicate') decls.set(w.id, wireText(w));
  const live = candidates.filter(c => c.decision === 'candidate');
  const byProblem = new Map();
  for (const c of live) (byProblem.get(c.id) ?? byProblem.set(c.id, []).get(c.id)).push(c);
  const reviewFile = path.join(dir, 'review.json');
  let review = fs.existsSync(reviewFile) ? JSON.parse(fs.readFileSync(reviewFile, 'utf8')) : null;
  if (!review && live.length) {
    const groupDecls = new Map(decls);
    for (const c of live) if (c.type === 'predicate') groupDecls.set(c.wire, c.text);
    const reviewItems = live.map(c => ({id: `${c.id}#${c.wire}`, material: '(no source passage: general knowledge)', work: c.text + (c.problem_numbers.length ? `\n# numbers shared with the problem: ${c.problem_numbers.join(', ')}` : ''),
      context_id: c.id, context: `PROBLEM (shows the gap; not a source):\n${items.get(c.id).question}\n\nPREDICATES USED:\n${declarationsFor(byProblem.get(c.id).map(x => parse(x.text).wires[0]), groupDecls)}`}));
    const kind = loadKind('commonsense-wires');
    // The tier's own fallback stays on, as in the earlier runs of this tool.
    const call = ({system, user}) => reviewChat({tier: REVIEW_MODEL, system, user, clientName: CLIENTS.review, purpose: PURPOSE, ta: agentOf('review'), maxTokens: 8000, reasoning: 'off', noFallback: false});
    const checkWire = (item, work) => {
      const [pid, wid] = item.id.split('#');
      const others = byProblem.get(pid).filter(c => c.wire !== wid).map(c => c.text);
      const v = validateCircuits([{name: 'group.sop', text: [...others, work].join('\n\n') + '\n'}], existing);
      return {ok: v.ok, problems: v.problems.map(p => `${p.code}: ${p.message}`)};
    };
    const res = await reviewLoop({items: reviewItems, kind, call, check: checkWire, budgetTokens: 30000, log});
    review = {confirmed: res.confirmed, repaired: res.repaired, escalations: res.escalations, findings: res.findings, dismissed: res.dismissed, noted: res.noted, ledger: res.ledger.stages};
    fs.writeFileSync(reviewFile, JSON.stringify(review, null, 1));
  }
  review ??= {confirmed: [], repaired: [], escalations: [], findings: []};
  const repairedBy = new Map((review.repaired ?? []).map(r => [r.id, r.work]));
  const confirmed = new Set(review.confirmed ?? []);
  // A wire the review rejects and no repair saves is dropped (resolved); only a review that could not run is escalated.
  for (const e of review.escalations ?? []) if (e.reason === 'review_failed') escalations.push({...e, stage: `review/${e.stage}`});

  // 5. groups: reviewed wires per problem, unique ids, validated, stamped
  const date = new Date().toISOString().slice(0, 10);
  const groupsDir = path.join(dir, 'groups');
  fs.mkdirSync(groupsDir, {recursive: true});
  const groups = [];
  for (const [pid, list] of byProblem) {
    const item = items.get(pid);
    const wires = [];
    for (const c of list) {
      const key = `${pid}#${c.wire}`;
      if (repairedBy.has(key)) { const w = parse(repairedBy.get(key)).wires[0]; if (w) wires.push(w); c.decision = 'repaired'; }
      else if (confirmed.has(key)) c.decision = 'dropped_review';
      else wires.push(parse(c.text).wires[0]);
    }
    const prefix = `kmb_${item.book}_${item.number ?? short(pid)}`.replace(/[^\w]/g, '_');
    const settled = settleGroup(pruneDeclarations(uniqueIds(wires, prefix)), existing);
    for (const d of settled.dropped) { const c = list.find(x => d.id.endsWith(x.wire.replace(/^kmb_/, '')) || x.wire === d.id); if (c) { c.decision = 'dropped_invalid'; c.reason = d.reason; } }
    if (!settled.wires.some(w => KNOWLEDGE_TYPES.includes(w.type))) continue;
    const prov = provenance({book: item.book, problem: pid, model: `Ploinky tier ${AUTHOR_MODEL} (Qwen3.8 27b, fallback DeepSeek flash)`, reviewer: `Ploinky tier ${REVIEW_MODEL} (DeepSeek flash)`, date});
    const text = `# ${pid}: mined general knowledge (${date})\n\n` + settled.wires.map(w => stamp(w, prov)).join('\n\n') + '\n';
    const file = path.join(groupsDir, `${pid.replace(/[^\w.-]/g, '_')}.sop`);
    fs.writeFileSync(file, text);
    groups.push({id: pid, file, wires: settled.wires.length, knowledge: settled.wires.filter(w => KNOWLEDGE_TYPES.includes(w.type)).length});
  }
  writeJsonl(path.join(dir, 'candidates.jsonl'), candidates);
  log(`groups: ${groups.length} problems with reviewed candidate knowledge (${groups.reduce((n, g) => n + g.knowledge, 0)} knowledge wires)`);

  // 6. admission trials
  const admittedFile = path.join(dir, 'admitted.jsonl');
  let admitted = readJsonl(admittedFile);
  const trialsFile = path.join(dir, 'trials.jsonl');
  if (!flag('no-admit') && groups.length && !fs.existsSync(path.join(dir, 'admission.done'))) {
    const base = admittedLayer();
    const scoredWith = await scoredTrials({jobs: groups.map(g => ({tag: `with-${g.id.replace(/[^\w.-]/g, '_')}`, ids: [g.id], layer: [...base, g.file]})), dir, workers, items});
    const fixed = groups.filter((g, k) => scoredWith[k].score.outcome === 'correct');
    let controls = [];
    if (fixed.length) {
      const chunks = Array.from({length: workers}, (_, k) => fixed.filter((_, i) => i % workers === k).map(g => g.id)).filter(c => c.length);
      controls = await scoredTrials({jobs: chunks.map((ids, k) => ({tag: `control-${k}`, ids, layer: base})), dir, workers, items});
    }
    const controlOf = new Map(controls.map(r => [r.id, r]));
    writeJsonl(trialsFile, [...scoredWith.map(r => ({...r, phase: 'with_group'})), ...controls.map(r => ({...r, phase: 'control'}))]);
    let provisional = fixed.filter(g => controlOf.get(g.id)?.score?.outcome !== 'correct');
    for (const g of fixed.filter(x => !provisional.includes(x))) escalations.push({id: g.id, stage: 'admit', reason: 'not_attributable', detail: 'the control rerun without the knowledge was also correct; nothing admitted'});
    log(`admission: ${fixed.length} groups fixed their problem, ${provisional.length} attributable to the knowledge`);

    // regression: the fixed regression set must not lose an answer
    const regressionSet = fs.existsSync(REGRESSION_FILE) ? JSON.parse(fs.readFileSync(REGRESSION_FILE, 'utf8')).ids : [];
    const fresh = baseline.filter(r => outcome(r) === 'correct').map(r => r.id).filter(id => !regressionSet.includes(id));
    const regression = [...regressionSet, ...fresh].slice(0, MAX_REGRESSION);
    if (provisional.length && regression.length) {
      const layer = [...base, ...provisional.map(g => g.file)];
      const chunks = Array.from({length: workers}, (_, k) => regression.filter((_, i) => i % workers === k)).filter(c => c.length);
      const reg = await scoredTrials({jobs: chunks.map((ids, k) => ({tag: `regression-${k}`, ids, layer})), dir, workers, items});
      const lost = reg.filter(r => r.score.outcome !== 'correct').map(r => r.id);
      fs.appendFileSync(trialsFile, reg.map(r => JSON.stringify({...r, phase: 'regression'})).join('\n') + (reg.length ? '\n' : ''));
      if (lost.length) {
        const ctl = await scoredTrials({jobs: [{tag: 'regression-control', ids: lost, layer: base}], dir, workers, items});
        fs.appendFileSync(trialsFile, ctl.map(r => JSON.stringify({...r, phase: 'regression_control'})).join('\n') + '\n');
        const confirmedLoss = ctl.filter(r => r.score.outcome === 'correct').map(r => r.id);
        log(`regression: ${lost.length} not correct with the new knowledge, ${confirmedLoss.length} confirmed by the control`);
        for (const id of confirmedLoss) {
          // the group whose removal restores the answer is withdrawn; when none does, every new group is withdrawn
          let culprit = null;
          for (const g of provisional) {
            const rest = provisional.filter(x => x !== g).map(x => x.file);
            const [r] = await scoredTrials({jobs: [{tag: `bisect-${id.replace(/[^\w.-]/g, '_')}-${g.id.replace(/[^\w.-]/g, '_')}`, ids: [id], layer: [...base, ...rest]}], dir, workers, items});
            if (r.score.outcome === 'correct') { culprit = g; break; }
          }
          const withdrawn = culprit ? [culprit] : provisional;
          for (const g of withdrawn) escalations.push({id: g.id, stage: 'regression', reason: 'regression_loss', detail: `withdrawn: with it the regression problem ${id} is no longer answered correctly`});
          provisional = provisional.filter(g => !withdrawn.includes(g));
          if (!provisional.length) break;
        }
      }
    }
    // admit: append the groups to the layer
    for (const g of provisional) {
      const text = fs.readFileSync(g.file, 'utf8');
      fs.appendFileSync(LAYER_FILE, (fs.readFileSync(LAYER_FILE, 'utf8').endsWith('\n\n') ? '' : '\n') + text);
      admitted.push({id: g.id, run: run.run, wires: g.wires, knowledge: g.knowledge, at: new Date().toISOString(), types: parse(text).wires.reduce((m, w) => ({...m, [w.type]: (m[w.type] ?? 0) + 1}), {})});
    }
    writeJsonl(admittedFile, admitted);
    fs.writeFileSync(REGRESSION_FILE, JSON.stringify({description: 'The fixed regression set of tools/knowledge-mining: book problems the system answered correctly in a mining baseline; admitted knowledge must not lose any of them. Ids only, grows, never shrinks.', ids: regression}, null, 1) + '\n');
    fs.writeFileSync(path.join(dir, 'admission.done'), new Date().toISOString());
  }

  // 7. report
  writeJsonl(path.join(dir, 'escalations.jsonl'), escalations);
  const cost = await runCosts(run.run);
  const summary = report({run, baseline, failing, proposals, candidates, groups, admitted, escalations, cost});
  fs.writeFileSync(path.join(dir, 'summary.md'), summary);
  fs.writeFileSync(runFile, JSON.stringify({...run, finished: new Date().toISOString(), cost}, null, 1));
  console.log(summary);
}

/**
 * Registers the stage runs of a mining run with the Ploinky proxy (`<run>.trial`, `.author`, `.review`, `.judge`), so its statistics
 * count each stage's calls since the run started. A resumed run is already registered (the error is ignored); the runs are left
 * running, so a resume can tag them again. The budget is a guard only.
 */
export async function registerStages(run, {fetchImpl = null} = {}) {
  const ta = pworker({purpose: PURPOSE, fetchImpl});
  for (const stage of Object.keys(CLIENTS)) {
    try { await ta.registerRun({job: 'knowledge-mining', run: `${run}.${stage}`, purpose: PURPOSE, budget: {calls: 100000}}); } catch { /* already registered, or no server yet */ }
  }
}

/** USD and openference plan credits of this run's calls per stage client, from Ploinky's statistics (`jobs.runs`, registered runs). */
export async function runCosts(run, {fetchImpl = null} = {}) {
  const out = {};
  let stats = null;
  try { stats = await pworker({purpose: PURPOSE, fetchImpl}).stats(); } catch { return out; }
  for (const r of stats?.jobs?.runs ?? []) {
    const stage = String(r.run).startsWith(`${run}.`) ? r.run.slice(run.length + 1) : null;
    if (!stage || !CLIENTS[stage]) continue;
    out[CLIENTS[stage]] = {calls: r.spent?.calls ?? 0, usd: Math.round((r.spent?.usd ?? 0) * 1e4) / 1e4, credits: Math.round((r.spent?.credits ?? 0) * 100) / 100};
  }
  return out;
}

function report({run, baseline, failing, proposals, candidates, groups, admitted, escalations, cost}) {
  const thisRun = admitted.filter(a => a.run === run.run);
  const count = (list, f) => list.reduce((m, x) => { const k = f(x); m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const decisions = count(candidates.filter(c => c.wire), c => c.decision);
  const types = thisRun.reduce((m, a) => { for (const [k, v] of Object.entries(a.types)) m[k] = (m[k] ?? 0) + v; return m; }, {});
  const usd = Object.values(cost).reduce((n, s) => n + s.usd, 0), credits = Object.values(cost).reduce((n, s) => n + s.credits, 0);
  const per100 = n => (failing.length ? (100 * n / failing.length).toFixed(1) : '-');
  const lines = [`# Knowledge mining ${run.run}`, '',
    `- problems: ${baseline.length} (seed ${run.seed}); baseline correct ${baseline.filter(r => r.score?.outcome === 'correct').length}; failing and mined ${failing.length} (${JSON.stringify(count(failing, r => r.score.outcome))})`,
    `- proposals: ${proposals.length} (${JSON.stringify(count(proposals, p => p.status))}); proposals with knowledge: ${proposals.filter(p => p.wires > 0).length}`,
    `- candidate wires by decision: ${JSON.stringify(decisions)}`,
    `- groups tried: ${groups.length}; admitted: ${thisRun.length} problems fixed by admitted knowledge = ${per100(thisRun.length)} per 100 failing problems (${baseline.length ? (100 * thisRun.length / baseline.length).toFixed(1) : '-'} per 100 problems)`,
    `- wires admitted: ${JSON.stringify(types)}`,
    `- cost: ${usd.toFixed(4)} USD (Ploinky statistics, paid upstream), ${credits.toFixed(1)} openference plan credits; by client: ${Object.entries(cost).map(([k, s]) => `${k} ${s.calls} calls, ${s.usd} USD, ${s.credits} credits`).join('; ') || 'none'}`,
    `- escalations: ${escalations.length} (escalations.jsonl)`, ''];
  if (escalations.length) {
    lines.push('## Escalations (at most 10 lines)', '');
    for (const e of escalations.slice(0, 10)) lines.push(`- ${e.id} [${e.stage}/${e.reason}] ${String(e.detail ?? e.problem ?? '').replace(/\s+/g, ' ').slice(0, 160)}`);
    lines.push('');
  }
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
