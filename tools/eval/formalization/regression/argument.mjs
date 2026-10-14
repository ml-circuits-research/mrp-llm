#!/usr/bin/env node
/**
 * The balanced argument set on the FOL path (owner request 2026-10-03), the library under the TaskLambda `regression-argument`
 * (jobs/lambdas/regression.mjs). fol-v3 was measured on argument problems whose gold was mostly "No", so a constant "No" scored
 * nearly as well; this measure is balanced (regression-grow `argument-balanced`: half gold Yes, half gold No) and replayable:
 *
 *   record   every case once through ChatSOPAdapter: mode `routed` (the structure role, the route, then compute path B or the FOL
 *            path as the route says), the FOL path itself (`pathFol` on the `formalizer` tier, today formalizer-tiny-v3: the tiny model
 *            under fol-v3, whatever the route says; arm `fol`) and the direct
 *            answer of the same chat tier (lib/adapter/paths/direct.mjs). The HTTP exchanges with Ploinky are recorded by a
 *            recording transport (request path and body → response), keyed by the tier's model, under the gitignored
 *            datasets_sources/formalization-regression/argument/ (book text, DS011).
 *   replay   the same calls with a replay transport: no server, no model (a missing exchange is a `replay_miss`); the converters,
 *            the engines and the scoring run in this process.
 * Scoring: the formalized answer by the asked-parts scorer of the FOL evaluation (tools/eval/routed/structure/asked.mjs: the
 * first yes/no answer decides; a `which` list answers by being non-empty); the direct answer by its final line's first yes/no word.
 * Yes and No are scored apart, against the constant majority answer and the direct answer, with the balanced accuracy (the mean of
 * the two recalls).
 *   node tools/eval/formalization/regression/argument.mjs record [--tier tiny] [--priority background]
 *   node tools/eval/formalization/regression/argument.mjs replay [--tier tiny]
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {ROOT, STATE, loadCases, loadItems} from './cases.mjs';
import {modelSlug} from './offline.mjs';
import {modelIdentity} from '../../../../lib/formalize/replay-cache.mjs';

export const ARGUMENT_DIR = path.join(ROOT, 'datasets_sources/formalization-regression/argument');
const readJsonl = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
export const argumentCases = () => loadCases().filter(c => c.slice === 'argument' && c.runnable);
/** The transport recordings of a chat tier (the direct answer and the compute paths) and of the formalizer tier's model. */
export const transportFile = tier => path.join(ARGUMENT_DIR, `transport-${tier}@${modelSlug(modelIdentity(tier))}+formalizer@${modelSlug(modelIdentity('formalizer'))}.jsonl`);

const keyOf = (url, init) => createHash('sha256').update(`${new URL(url).pathname}\0${init?.body ?? ''}`).digest('hex');
// The response headers kept with an exchange: all but the connection's own (the library reads what served the call from them).
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'date']);

/**
 * A Ploinky transport (`fetchImpl`) that records or replays model exchanges. `record`: every POST to a model endpoint goes to
 * `inner` and its complete answer is stored; `replay`: answered from the file only (a miss is a 409 replay_miss; GET /health is
 * answered as healthy). Other requests (registration, health) pass through when recording.
 */
export function recordingTransport({file, mode = 'replay', inner = null}) {
  const map = new Map(readJsonl(file).map(r => [r.key, r]));
  const stats = {hits: 0, recorded: 0, misses: 0};
  const respond = row => new Response(row.text, {status: row.status, headers: row.headers});
  const transport = async (url, init = {}) => {
    const p = new URL(url).pathname, method = (init.method ?? 'GET').toUpperCase();
    const model = method === 'POST' && /^\/(?:v1\/(?:chat\/completions|messages|structure|fol)|u\/)/.test(p);
    if (!model) {
      if (mode === 'replay') return new Response(JSON.stringify(p === '/health' ? {ok: true, tiers: []} : {}), {status: 200, headers: {'content-type': 'application/json'}});
      return inner(url, init);
    }
    const key = keyOf(url, init), hit = map.get(key);
    if (hit) { stats.hits++; return respond(hit); }
    if (mode === 'replay') { stats.misses++; return new Response(JSON.stringify({error: {type: 'replay_miss', message: `no recorded exchange for ${p}`}}), {status: 409, headers: {'content-type': 'application/json'}}); }
    const res = await inner(url, init);
    const text = await res.text();
    const headers = Object.fromEntries([...res.headers].filter(([h]) => !HOP.has(h.toLowerCase())));
    const row = {key, path: p, status: res.status, headers, text, at: new Date().toISOString()};
    // Only complete answers are kept: a failed call is asked again by the next recording.
    if (res.status === 200) { map.set(key, row); fs.mkdirSync(path.dirname(file), {recursive: true}); fs.appendFileSync(file, JSON.stringify(row) + '\n'); stats.recorded++; }
    return respond(row);
  };
  transport.stats = stats;
  return transport;
}

/** The yes/no polarity of a direct answer's final line (its first yes/no word), or null. */
export const directPolarity = text => { const m = String(text ?? '').match(/\b(yes|no|true|false)\b/i); return m ? /^(yes|true)$/i.test(m[1]) : null; };

/** One case through the adapter (routed) and the direct path, over `transport`; returns the scored row. */
async function answerCase({c, item, adapter, transport, tier, tags, executor}) {
  const {pathDirect, tierChat, pathFol, folClient, structureClient, structureRoute} = await import('../../../../lib/adapter/index.mjs');
  const {askedVerdict} = await import('../../routed/structure/asked.mjs');
  const {goldOf} = await import('../../routed/structure/gold.mjs');
  const gold = goldOf(item);
  const row = {id: c.id, gold: gold?.values?.[0] ?? null};
  try {
    const a = await adapter.answer({message: item.question, mode: 'routed', run: tags.run, priority: tags.priority});
    const answers = a.answer?.answers ?? [];
    row.formal = {path: a.path, route: a.route?.route ?? null, status: a.verification?.status ?? null, answers: answers.map(x => ({kind: x.kind, value: x.value})), verdict: askedVerdict(item, gold, answers).verdict};
  } catch (e) { row.formal = {error: e.message.slice(0, 200), verdict: 'no_answer'}; }
  // The FOL path itself (the formalizer tier, today the tiny model under fol-v3), whatever the route says: the structure role's names
  // link the constants, as in mode routed.
  try {
    const t = {purpose: tags.purpose, run: tags.run, priority: tags.priority, fetchImpl: transport};
    const route = await structureRoute({message: item.question, structure: structureClient('structure', t)});
    const f = await pathFol({message: item.question, fol: folClient('formalizer', t), executor, names: route.names, tier: 'formalizer'});
    row.fol = {status: f.status, answers: f.answers.map(x => ({kind: x.kind, value: x.value})), verdict: askedVerdict(item, gold, f.answers).verdict};
  } catch (e) { row.fol = {error: e.message.slice(0, 200), verdict: 'no_answer'}; }
  try {
    const chat = tierChat(tier, {purpose: tags.purpose, run: tags.run, priority: tags.priority, noFallback: true, fetchImpl: transport});
    const d = await pathDirect({message: item.question, chat});
    const said = d.status === 'ok' ? directPolarity(d.detail?.text) : null;
    row.direct = {status: d.status, text: d.detail?.text ?? null, said, verdict: said === null ? 'no_answer' : said === row.gold ? 'correct' : 'wrong'};
  } catch (e) { row.direct = {error: e.message.slice(0, 200), verdict: 'no_answer'}; }
  return row;
}

/** Yes and No apart: correct / n per gold, the balanced accuracy, and the constant majority answer as a baseline. */
export function scoreRows(rows) {
  const arms = ['formal', 'fol', 'direct'];
  const by = g => rows.filter(r => r.gold === g);
  const yes = by(true), no = by(false);
  const majority = no.length >= yes.length ? false : true;
  const rate = (list, arm) => ({correct: list.filter(r => r[arm]?.verdict === 'correct').length, wrong: list.filter(r => r[arm]?.verdict === 'wrong').length, n: list.length});
  const out = {cases: rows.length, gold: {yes: yes.length, no: no.length}};
  for (const arm of arms) {
    const y = rate(yes, arm), n = rate(no, arm);
    out[arm] = {yes: y, no: n, correct: y.correct + n.correct, balanced_accuracy: Math.round(1000 * ((y.n ? y.correct / y.n : 0) + (n.n ? n.correct / n.n : 0)) / 2) / 1000};
  }
  const mc = (majority ? yes : no).length;
  out.majority = {answer: majority ? 'Yes' : 'No', yes: {correct: majority ? yes.length : 0, n: yes.length}, no: {correct: majority ? 0 : no.length, n: no.length}, correct: mc, balanced_accuracy: 0.5};
  return out;
}

/** Records (or replays) every argument case; writes state/formalization-regression/argument-<mode>-<tier>.json. */
async function runArgument({mode, tier = 'tiny', priority = null, purpose = 'job:formalization-regression', ta = null, write = true, log = m => console.error(m)}) {
  const {createChatSOPAdapter} = await import('../../../../lib/adapter/index.mjs');
  const {httpFetch} = await import('pworker/http-fetch');
  const cases = argumentCases(), items = loadItems();
  if (!cases.length) return {cases: 0, summary: 'no argument case: run regression-grow with set argument-balanced first'};
  const file = transportFile(tier);
  const run = `argument-${mode}-${tier}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  // The priority (Ploinky's background class for a cloud tier) is a per-call option of the adapter and its clients.
  const transport = recordingTransport({file, mode: mode === 'record' ? 'record' : 'replay', inner: httpFetch});
  if (mode === 'record' && ta) { try { await ta.registerRun({job: 'formalization-regression', run, purpose, budget: {calls: cases.length * 12}}); } catch (e) { log(`budget not registered: ${e.message}`); } }
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/runtime.json'), 'utf8'));
  // The adapter's calls carry this run's purpose (not the chat's interactive `formalize`), so they queue as batch work.
  const adapter = createChatSOPAdapter({config: {...config, adapter: {...(config.adapter ?? {}), purpose}}, settings: null, fetchImpl: transport});
  const rows = [];
  const {scratchExecutor} = await import('../../../../lib/adapter/index.mjs');
  const executor = await scratchExecutor();
  try {
    for (const [k, c] of cases.entries()) {
      const item = items.get(c.provenance.problem_id);
      if (!item) continue;
      rows.push(await answerCase({c, item, adapter, transport, tier, tags: {purpose, run, priority}, executor}));
      log(`[${k + 1}/${cases.length}] ${c.id} gold ${rows.at(-1).gold ? 'Yes' : 'No'}: routed ${rows.at(-1).formal.path ?? '-'} ${rows.at(-1).formal.verdict}, fol ${rows.at(-1).fol.verdict}, direct ${rows.at(-1).direct.verdict}`);
    }
  } finally { adapter.dispose(); executor.dispose(); }
  const spend = mode === 'record' && ta ? (await ta.jobs().catch(() => null))?.runs?.find(r => r.run === run)?.spent ?? null : null;
  if (mode === 'record' && ta) { try { await ta.finishRun({run}); } catch { /* listed as running */ } }
  const score = scoreRows(rows);
  const out = {mode, tier, formalizer: modelIdentity('formalizer'), model: modelIdentity(tier), transport: {file: path.relative(ROOT, file), ...transport.stats}, spend, ...score};
  if (write) fs.mkdirSync(STATE, {recursive: true});
  if (write) fs.writeFileSync(path.join(STATE, `argument-${mode}-${tier}.json`), JSON.stringify({...out, rows, at: new Date().toISOString()}, null, 1) + '\n');
  out.summary = `${score.cases} argument cases (${score.gold.yes} Yes, ${score.gold.no} No), ${mode}: routed ${score.formal.yes.correct}/${score.gold.yes} Yes, ${score.formal.no.correct}/${score.gold.no} No (balanced ${score.formal.balanced_accuracy}); FOL path ${score.fol.yes.correct}/${score.gold.yes} Yes, ${score.fol.no.correct}/${score.gold.no} No (balanced ${score.fol.balanced_accuracy}); direct ${score.direct.yes.correct}/${score.gold.yes} Yes, ${score.direct.no.correct}/${score.gold.no} No (balanced ${score.direct.balanced_accuracy}); constant ${score.majority.answer} ${score.majority.correct}/${score.cases} (balanced 0.5); transport ${JSON.stringify(transport.stats)}`;
  return out;
}

export const recordArgument = o => runArgument({...o, mode: 'record'});
export const replayArgument = o => runArgument({...o, mode: 'replay'});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  const opt = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
  if (!['record', 'replay'].includes(cmd)) { console.error('usage: argument.mjs record|replay [--tier tiny] [--priority background]'); process.exit(2); }
  const {pworker} = await import('../../../../lib/pworker.mjs');
  const out = await runArgument({mode: cmd, tier: opt('--tier', 'tiny'), priority: opt('--priority'), ta: cmd === 'record' ? pworker({purpose: 'job:formalization-regression'}) : null});
  console.log(out.summary);
}
