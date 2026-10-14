#!/usr/bin/env node
/**
 * Harness of experiment eval-ingest-v1 (status/preregistrations/eval-ingest-v1.json): questions over documents ingested into task-type
 * base memories, answered by three arms.
 *
 *   node tools/eval/ingestion/ingest-v1.mjs pipeline --doc handbook|europa [--ids h01,h02] [--tier small] [--base ID] [--tag T] [--ladder]
 *        the product path: a session cloned from the base memory, the step-by-step formalizer with its questions answered by ONE
 *        Ploinky tier (default small; LLMDirect is archived), the shared symbolic path, the rendered English answer
 *   node tools/eval/ingestion/ingest-v1.mjs direct --doc ... --arm qwen27b|deepseek [--model M]       the model reads the whole document (one direct call through Ploinky)
 *   node tools/eval/ingestion/ingest-v1.mjs direct --doc ... --arm local [--tier micro]               a local model (a Ploinky tier, default micro) reads the document
 *   node tools/eval/ingestion/ingest-v1.mjs score [--files a.jsonl,b.jsonl]                       correct / wrong / unknown per arm and document
 *
 * Answers go to eval/reports/current/ingest-v1/<arm>-<doc>[-tag].jsonl (one line per question). The questions and the gold are
 * eval/ingest-v1/questions.json; no model ever sees the gold.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SessionStore} from '../../../server/session-store.mjs';
import {ChatData} from '../../../lib/chat-data/index.mjs';
import {BaseMemories, BASE_NAME} from '../../../lib/chat-data/memories.mjs';
import {Sessions} from '../../../lib/chat-data/sessions.mjs';
import {TheoryCache} from '../../../reasoning/slice/index.mjs';
import {harnessChat} from '../lib/chat-turn.mjs';
import {providerChat, parseEntry} from '../../../lib/llm-providers.mjs';
import {pworker} from '../../../lib/pworker.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const OUT = path.join(ROOT, 'eval/reports/current/ingest-v1');
const args = process.argv.slice(2);
const opt = (name, fallback = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
export const QUESTIONS = JSON.parse(fs.readFileSync(path.join(ROOT, 'eval/ingest-v1/questions.json'), 'utf8'));
export const DOCS = {
  handbook: {file: 'datasets_sources/ingest-v1/handbook/brindlewood-handbook.md', base: 'exp-ingest-handbook'},
  europa: {file: 'datasets_sources/ingest-v1/europa-facts/europa-facts.md', base: 'exp-ingest-europa'},
};

export function openProduct(root = path.join(ROOT, 'chat_data')) {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'runtime.json'), 'utf8'));
  config.chatData = {...config.chatData, root};
  const chatData = ChatData.open(config, {}, ROOT);
  const memories = new BaseMemories({chatData, memory: config.memory});
  return {config, memories, sessions: new Sessions({chatData, memories, memory: config.memory})};
}

/** A private session on `base` (user eval-ingest), with the chat turn machinery of the product (server/session-runtime.mjs). */
export function openSession({base, id, product = openProduct()}) {
  const {config, sessions} = product;
  fs.rmSync(sessions.dir(id), {recursive: true, force: true});
  sessions.create({base, user: 'eval-ingest', id, name: `eval-ingest-v1 ${base}`});
  const theories = new TheoryCache();
  const store = new SessionStore({repo: sessions.repository(id), lexicon: sessions.lexicon(id), config: {...config, policy: {...(config.policy ?? {}), reinforce: false}}, root: path.join(sessions.dir(id), 'agent'),
    circuitRules: () => theories.get([...sessions.baseCircuits(id), ...sessions.circuits(id)]).chatRules()});
  return {store, config, lexicon: sessions.lexicon(id), close: () => fs.rmSync(sessions.dir(id), {recursive: true, force: true})};
}

/** One question through the chat's own turn (ChatSOPAdapter, `chat` = harnessChat) in a fresh conversation; returns the record of the answer. */
export async function askPipeline(s, question, {chat}) {
  const entry = s.store.get('eval-ingest', 'c' + Math.random().toString(36).slice(2), BASE_NAME);
  const started = Date.now();
  const parseOf = parse => parse && {model: parse.model, rounds: parse.rounds, repairs: parse.repairs, ms: parse.ms, cost_usd: parse.cost_usd, procedures: parse.retrieval?.procedures ?? null};
  try {
    const {result: res, parse} = await chat.turn(entry, question, {lexicon: s.lexicon});
    const p = res.packet ?? {};
    return {text: String(res.text ?? ''), status: p.status ?? null, kind: p.kind ?? null, count: p.count ?? null, answers: (p.answers ?? []).slice(0, 12).map(a => a.binding),
      sop: res.sop ?? null, session_circuits: p.session_circuits?.text ?? null, parse: parseOf(parse), ms: Date.now() - started};
  } catch (error) {
    const parse = error.parse;
    return {text: '', error: String(error.message).slice(0, 400), code: error.code ?? null, parse: parse && {model: parse.model, rounds: parse.rounds, repairs: parse.repairs}, ms: Date.now() - started};
  }
}

/** The default model since 2026-10-02 (commit 41e0db8): Qwen3.8 27b of the openference plan through Ploinky. */
export const DEFAULT_MODEL = 'openference/Qwen3.8 27b';
export const DIRECT_SYSTEM = 'You answer questions about one document. Use only the document. Reply with the answer in one short sentence. If the document does not contain the answer, reply exactly: The document does not say.';
const directPrompt = (doc, q) => `<document>\n${doc}\n</document>\n\nQuestion: ${q}`;

function questionsFor(doc) {
  const ids = opt('--ids') ? new Set(opt('--ids').split(',')) : null;
  return QUESTIONS.questions.filter(q => q.doc === doc && (!ids || ids.has(q.id)));
}
const outFile = (arm, doc) => path.join(OUT, `${arm}-${doc}${opt('--tag') ? '-' + opt('--tag') : ''}.jsonl`);
const append = (file, row) => fs.appendFileSync(file, JSON.stringify(row) + '\n');

/** Scores an answer text against the gold patterns of a question: correct, wrong or unknown. */
export function scoreAnswer(question, record) {
  const text = String(record.text ?? '').toLowerCase();
  const unknownText = /does not say|doesn't say|not stated|not specified|unknown|no information|cannot (be )?(determine|answer)|could not|i don't know|not enough|no answer|clarif/.test(text);
  if (record.error || !text.trim()) return question.gold === 'not_stated' ? 'correct' : 'unknown';
  if (question.gold === 'not_stated') return question.accept.some(a => new RegExp(a, 'i').test(text)) || unknownText ? 'correct' : 'wrong';
  // A packet that decides nothing (unknown, incomplete, a clarification) is unknown, before the accept patterns: "does not decide"
  // would otherwise match an accept pattern such as "not" of a negative gold.
  if (['unknown', 'incomplete', 'clarify', 'unclear', 'not_computable', 'unsupported'].includes(record.status)) return 'unknown';
  const hit = question.accept.some(a => new RegExp(a, 'i').test(text));
  const rejected = (question.reject ?? []).some(a => new RegExp(a, 'i').test(text));
  if (hit && !rejected) return 'correct';
  if (unknownText || ['unknown', 'incomplete', 'clarify', 'not_computable', 'unsupported'].includes(record.status)) return 'unknown';
  return 'wrong';
}

/** Hand corrections of the pattern scorer, `{<file>: {<id>: {score, why}}}` (eval/ingest-v1/manual-scores.json): every mismatch is read by hand. */
const manualScores = () => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'eval/ingest-v1/manual-scores.json'), 'utf8')); } catch { return {}; } };

async function main() {
  const command = args[0];
  fs.mkdirSync(OUT, {recursive: true});
  if (command === 'pipeline') {
    const doc = opt('--doc');
    // --ladder: the product's configured tier ladder (queryParser.local.ladder), escalating per question, instead of one tier.
    const tier = args.includes('--ladder') ? null : opt('--tier', 'small'), model = tier ? `tier:${tier}` : 'ladder';
    const s = openSession({base: opt('--base', DOCS[doc].base), id: `eval-ingest-${doc}${opt('--tag') ? '-' + opt('--tag') : ''}`});
    const file = outFile('pipeline', doc);
    const chat = harnessChat({config: s.config, tier, source: 'eval:ingest-v1'});
    try {
      for (const q of questionsFor(doc)) {
        const r = await askPipeline(s, q.q, {chat});
        const row = {id: q.id, q: q.q, arm: 'pipeline', model, ...r};
        row.score = scoreAnswer(q, row);
        append(file, row);
        console.log(JSON.stringify({id: q.id, score: row.score, status: row.status, text: row.text.slice(0, 160), error: row.error, ms: row.ms}));
      }
    } finally { s.close(); await chat.close(); }
  } else if (command === 'direct') {
    const doc = opt('--doc');
    const arm = opt('--arm', 'qwen27b');
    const text = fs.readFileSync(path.join(ROOT, DOCS[doc].file), 'utf8');
    const file = outFile(arm, doc);
    for (const q of questionsFor(doc)) {
      let r;
      if (arm !== 'local') {
        const model = opt('--model', arm === 'deepseek' ? 'openrouter/deepseek/deepseek-v4-flash' : DEFAULT_MODEL);
        const entry = parseEntry(model);
        const out = await providerChat({system: DIRECT_SYSTEM, prompt: directPrompt(text, q.q), ...(entry.tier ? {provider: entry.tier} : {provider: entry.provider, model: entry.model}), timeoutMs: 240_000, purpose: 'job:eval-ingest-v1'});
        r = {model, text: out.text ?? '', ...(out.ok ? {} : {error: out.reason}), ms: out.ms, usage: out.usage};
      } else {
        // A local model is a Ploinky tier (Ploinky starts and stops the local model servers).
        if (args.includes('--endpoint')) throw new Error('--endpoint is gone: a local model is a Ploinky tier (--tier, default micro)');
        const tier = opt('--tier', 'micro');
        const out = await pworker({purpose: 'job:eval-ingest-v1'}).chat({tier, messages: [{role: 'system', content: DIRECT_SYSTEM}, {role: 'user', content: directPrompt(text, q.q)}],
          maxTokens: 200, temperature: 0, stream: false, extraBody: {cache_prompt: true, timings_per_token: false}, timeoutMs: 300_000});
        r = {model: `tier:${tier}`, text: out.text ?? '', ...(out.ok ? {} : {error: out.reason}), ms: out.ms, usage: out.ok ? {input_tokens: out.usage.in, output_tokens: out.usage.out, reasoning_tokens: out.usage.reasoning} : undefined};
      }
      const row = {id: q.id, q: q.q, arm, ...r};
      row.score = scoreAnswer(q, row);
      append(file, row);
      console.log(JSON.stringify({id: q.id, score: row.score, text: row.text.slice(0, 160), error: row.error, ms: row.ms}));
    }
  } else if (command === 'score') {
    const files = opt('--files') ? opt('--files').split(',') : fs.readdirSync(OUT).filter(f => f.endsWith('.jsonl'));
    const byId = new Map(QUESTIONS.questions.map(q => [q.id, q]));
    const table = {};
    for (const f of files) {
      const rows = fs.readFileSync(path.join(OUT, path.basename(f)), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
      const last = new Map(rows.map(r => [r.id, r]));
      const t = {n: 0, correct: 0, wrong: 0, unknown: 0, median_ms: null};
      const ms = [];
      const manual = manualScores()[path.basename(f, '.jsonl')] ?? {};
      for (const r of last.values()) { const s = manual[r.id]?.score ?? scoreAnswer(byId.get(r.id), r); t.n++; t[s]++; ms.push(r.ms ?? 0); }
      ms.sort((a, b) => a - b);
      t.median_ms = ms.length ? ms[Math.floor(ms.length / 2)] : null;
      table[path.basename(f, '.jsonl')] = t;
    }
    console.log(JSON.stringify(table, null, 2));
  } else {
    console.error('usage: node tools/eval/ingestion/ingest-v1.mjs pipeline|direct|score ... (see the header)');
    process.exit(2);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().then(() => process.exit(0), error => { console.error(error.stack); process.exit(1); });
