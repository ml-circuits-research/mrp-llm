#!/usr/bin/env node
/**
 * Probe for the query-form work (experiment eval-query-forms-v1): asks questions of the base memory world-v1 through the chat turn
 * (ChatSOPAdapter, tools/eval/lib/chat-turn.mjs), either with the step-by-step formalizer (config/runtime.json queryParser; `--tier tiny|small|medium|good` answers its questions
 * on one Ploinky tier, default the product ladder; LLMDirect is archived) or with a given SOP (`--sop file`).
 *   node tools/eval/formalization/query-forms/probe.mjs --q "How many countries border Germany?" [--sop file] [--base world-v1] [--tier T]
 * Prints the SOP, the circuit status, the answer and the retrieval/linking summary. Sessions are private to user `qf-probe` and deleted.
 */
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {BASE_NAME} from '../../../../lib/chat-data/memories.mjs';
import {openSession} from '../../lib/session.mjs';
import {harnessChat} from '../../lib/chat-turn.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

if (process.argv[1] === fileURLToPath(import.meta.url) && opt('--batch', null)) {
  // --batch file: one question per line; prints one compact JSON line per question (status, answer values, linked relation, clarification)
  const s = openSession({base: opt('--base', 'world-v1')});
  const chat = harnessChat({config: s.config, tier: opt('--tier', null), source: 'eval:query-forms'});
  try {
    for (const q of fs.readFileSync(opt('--batch'), 'utf8').split('\n').map(l => l.trim()).filter(Boolean)) {
      const entry = s.store.get('qf', 'c' + Math.random().toString(36).slice(2), BASE_NAME);
      let line;
      try {
        const {result: res} = await chat.turn(entry, q, {lexicon: s.lexicon});
        const p = res.packet ?? {};
        line = {q, status: p.status, kind: p.kind, count: p.count, values: (p.answers ?? []).slice(0, 8).map(a => Object.values(a.binding ?? {}).join('/')), complete: p.complete, text: p.status === 'supported' || p.status === 'refuted' ? undefined : String(res.text).slice(0, 160)};
      } catch (error) { line = {q, error: String(error.message).slice(0, 200)}; }
      console.log(JSON.stringify(line));
    }
  } finally { s.close(); await chat.close(); }
  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const q = opt('--q', null);
  const sopFile = opt('--sop', null);
  const s = openSession({base: opt('--base', 'world-v1')});
  const chat = harnessChat({config: s.config, tier: opt('--tier', null), source: 'eval:query-forms'});
  // --sop: a given circuit replaces the chat's circuit author (no model call); the turn is the chat's either way.
  const author = sopFile ? {id: 'fixed', formalize: async () => fs.readFileSync(sopFile, 'utf8')} : null;
  try {
    const entry = s.store.get('qf', 'c1', BASE_NAME);
    const {result: res} = await chat.turn(entry, q, {lexicon: s.lexicon, author});
    console.log(JSON.stringify({sop: res.sop, text: res.text, status: res.packet?.status, kind: res.packet?.kind, count: res.packet?.count, answers: (res.packet?.answers ?? []).slice(0, 12).map(a => a.binding), reason: res.packet?.reason, complete: res.packet?.complete, retrieval: res.packet?.retrieval && {complete: res.packet.retrieval.complete, why: res.packet.retrieval.why ?? res.packet.retrieval.reason}, linking: res.packet?.linking?.slice?.(0, 6)}, null, 1));
  } finally { s.close(); await chat.close(); }
  process.exit(0);
}
