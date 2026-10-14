/**
 * Runs the product chain on every question of a suite stage (tools/eval/kbqa/cli.mjs `run`), in process, through the chat turn of
 * ChatSOPAdapter (tools/eval/lib/chat-turn.mjs, the same glue as the chat):
 *   question -> step-by-step formalizer (server/query-parser.mjs: short questions to a Ploinky tier, the system assembles the circuit; the message and the memory vocabulary only) -> Agent
 *   (server/agent.mjs: admission, KnowledgeLinker over the lexicon of the session's base memory, StrategyRouter, oracle) -> packet.
 * Every question gets its own conversation (no carried context); the session is the clone of the stage's base memory, and reads do not
 * reinforce (policy.reinforce false), so the questions of a stage cannot influence each other. Nothing of the gold reaches the chain.
 * One record per question is appended to eval/reports/current/kbqa/<suite>/stage-<n>.jsonl; a rerun resumes unless --force.
 */
import fs from 'node:fs';
import path from 'node:path';
import {SessionStore} from '../../../server/session-store.mjs';
import {BASE_NAME} from '../../../lib/chat-data/memories.mjs';
import {ROOT} from './benchmarks.mjs';
import {readSuite} from './suites.mjs';
import {openData, memoryId} from './memory.mjs';
import {harnessChat, parserFailed} from '../lib/chat-turn.mjs';

export const reportDir = suite => path.join(ROOT, 'eval', 'reports', 'current', 'kbqa', suite);
export const stageFile = (suite, stage, tag = '') => path.join(reportDir(suite), `stage-${stage}${tag}.jsonl`);
const TIMEOUT_MS = Number(process.env.KBQA_TURN_TIMEOUT_MS ?? 180000);

const bindingValue = v => (typeof v === 'string' ? v : v == null ? null : String(v));

/** The comparable answer of a result packet: {kind: 'entities'|'boolean'|'number'|'values'|'none', ...}. */
export function answerOfPacket(packet) {
  if (!packet) return {kind: 'none'};
  const status = packet.status;
  // Open world: a packet whose status is not a definite one (unknown, clarify, ...) carries no answer, whatever count or bindings it holds.
  if (!['supported', 'refuted', 'contradicted', 'false', 'conflicted'].includes(status)) return {kind: 'none', status};
  const answers = (packet.answers ?? []).map(a => Object.values(a.binding ?? {})).filter(v => v.length);
  if (packet.kind === 'count' || typeof packet.count === 'number') return {kind: 'number', value: packet.count ?? answers.length, status};
  if (packet.kind === 'exists' || (packet.query?.mode === 'exists')) {
    if (status === 'supported') return {kind: 'boolean', value: true, status};
    if (status === 'refuted' || status === 'contradicted' || status === 'false') return {kind: 'boolean', value: false, status};
    return {kind: 'none', status};
  }
  if (answers.length) return {kind: 'values', values: answers.flat().map(bindingValue).filter(Boolean), status};
  return {kind: 'none', status};
}

function conclude(packet) {
  const q = packet?.query ?? {};
  return {status: packet?.status ?? null, kind: packet?.kind ?? null, reason: packet?.reason ?? null, complete: packet?.complete ?? null, mode: q.mode ?? null,
    where: (q.where ?? []).map(w => ({p: w.p, a: w.a, neg: w.neg})), required: packet?.required ?? null, answer: answerOfPacket(packet),
    route: packet?.route ? {backend: packet.route.backend, fallback: packet.route.fallback} : null, strategy: packet?.reasoningStrategy ?? null,
    unresolved_spans: packet?.unresolved_spans?.map(s => ({span: s.span, hint: s.hint})) ?? [], clarification: packet?.text ?? null,
    linking: packet?.linking ?? null, retrieval: packet?.retrieval ?? null, reason_detail: packet?.reason ?? null};
}

/**
 * Measurement mode (eval-query-parsers-v1): a failed coding agent is an error of the record (`parser_failed`), never a substitute answer.
 * `tier` answers the step-by-step questions on one Ploinky tier instead of the configured ladder (a tier comparison, like with like).
 */
export async function runSuite(suite, {stage = '100', limit = null, only = null, force = false, tag = '', variant = '', tier = null, log = console.error} = {}) {
  const rows = readSuite(suite, stage).filter(r => !only || r.id === only || r.type === only).slice(0, limit ? Number(limit) : undefined);
  const {config, sessions} = openData();
  const base = memoryId(suite, stage, variant);
  const sid = `run-${suite}-${stage}${variant ? `-${variant}` : ''}`.slice(0, 60);
  // A fresh clone of the stage's base memory for every run.
  fs.rmSync(sessions.dir(sid), {recursive: true, force: true});
  sessions.create({base, user: 'kbqa', id: sid, name: `KBQA ${suite} ${stage}`});
  const repo = sessions.repository(sid);
  const store = new SessionStore({repo, lexicon: sessions.lexicon(sid), config: {...config, policy: {...(config.policy ?? {}), reinforce: false}}, root: path.join(sessions.dir(sid), 'agent')});
  const out = stageFile(suite, stage, tag);
  fs.mkdirSync(path.dirname(out), {recursive: true});
  const done = new Set(!force && fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).id) : []);
  if (force) fs.rmSync(out, {force: true});
  const chat = harnessChat({config, tier, source: 'eval:kbqa'});
  const lexicon = sessions.lexicon(sid);
  let n = 0;
  try {
    for (const row of rows) {
      if (done.has(row.id)) continue;
      const t0 = performance.now();
      const rec = {id: row.id, type: row.type, question: row.question, stage};
      let parse = null;
      try {
        const entry = store.get('kbqa', `c${rows.indexOf(row)}`, BASE_NAME);
        const turned = await Promise.race([
          chat.turn(entry, row.question, {lexicon}),
          new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('turn time limit'), {layer: 'timeout'})), TIMEOUT_MS + 30000)),
        ]);
        const res = turned.result;
        parse = turned.parse;
        Object.assign(rec, {sop: res.sop, exec_sop: res.executionSop?.slice(0, 4000), text: res.text, ...conclude(res.packet), formalization_ms: res.formalization?.ms, lm: parse ? {route: 'coding_agent', ms: parse.ms} : null, parse});
      } catch (error) {
        parse = error.parse ?? null;
        // A request parser that wrote no circuit is the record's `parser_failed`, never a substitute answer.
        const layer = error.layer ?? (parserFailed(error) ? 'parser_failed' : error.modelSop !== undefined ? 'sop_admission' : 'chain');
        Object.assign(rec, {error: String(error.message).slice(0, 400), error_layer: layer, sop: error.modelSop ?? null, lm: parse ? {route: 'coding_agent', ms: parse.ms} : null, parse});
      }
      rec.ms = Math.round(performance.now() - t0);
      fs.appendFileSync(out, JSON.stringify(rec) + '\n');
      if (++n % 10 === 0) log(`[kbqa ${suite}/${stage}] ${n + done.size}/${rows.length}`);
    }
  } finally { await chat.close(); }
  return {suite, stage, questions: rows.length, ran: n, resumed: done.size, file: path.relative(ROOT, out)};
}
