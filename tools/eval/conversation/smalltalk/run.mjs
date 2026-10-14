#!/usr/bin/env node
/**
 * Small evaluation of the small-talk collections (owner request of 2026-10-02): the 40 fresh chat messages of
 * eval/smalltalk-v1/messages.jsonl go through the chat turn of ChatSOPAdapter (tools/eval/lib/chat-turn.mjs, the same glue as the chat;
 * server/agent.mjs over the default base memory world-v1, request parser: the step-by-step formalizer on its configured tier ladder, or
 * one tier with --tier), each formalized once (the cached circuit is the turn's circuit author); the reply is composed under three reply layers:
 *
 *   A  conversation-v1 alone (the layer before the collections)
 *   B  conversation-v1 + the default collections (config conversation.layers): smalltalk-core, -empathy, -self, -playful
 *   C  B, with the message's label added as a pragmatic signal (an oracle signal: what B gives once the formalizer may write the
 *      proposed kinds; only turns without a computed answer are recomposed)
 *
 * The replies are drafts of the conversation layer (the optional answer-formulation step of the HTTP server is not applied). The judge
 * is jobs/smalltalk-judge (auditor tier, blind: hashed ids, arms shuffled). Writes eval/reports/current/smalltalk/.
 *
 *   node tools/eval/conversation/smalltalk/run.mjs turns [--tier T] [--arms B,A]   formalize (under the first arm's layer) and compose
 *   node tools/eval/conversation/smalltalk/run.mjs judge-input [--before FILE]   the blind judge input (state/llm-jobs/smalltalk-judge-input.jsonl);
 *                                                           --before adds the B rows of an earlier turns.jsonl as the arm `before`
 *   node tools/eval/conversation/smalltalk/run.mjs report --run DIR      scores per arm and category, paired bootstrap B-A and C-A
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {SessionStore} from '../../../../server/session-store.mjs';
import {ChatData} from '../../../../lib/chat-data/index.mjs';
import {BaseMemories, BASE_NAME} from '../../../../lib/chat-data/memories.mjs';
import {Sessions} from '../../../../lib/chat-data/sessions.mjs';
import {TheoryCache} from '../../../../reasoning/slice/index.mjs';
import {harnessChat} from '../../lib/chat-turn.mjs';
import {seedCircuits} from '../../../../lib/knowledge-seeds.mjs';
import {setReplyLayer, indexLayer} from '../../../../sop/replies.mjs';
import {composeReply} from '../../../../lib/conversation/index.mjs';
import {topicsOf} from '../../../../lib/assistant/statistics.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const OUT = path.join(ROOT, 'eval/reports/current/smalltalk');
const PURPOSE = 'job:smalltalk-eval-formalize';
const args = process.argv.slice(2);
const opt = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const readJsonl = f => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/runtime.json'), 'utf8'));
const layerOf = ids => indexLayer(ids.flatMap(id => seedCircuits(id).map(c => ({name: `${id}:${c.file}`, text: c.text}))), ids.join('+'));
export const ARMS = {A: ['conversation-v1'], B: config.conversation.layers};


async function turns() {
  const messages = readJsonl(path.join(ROOT, 'eval/smalltalk-v1/messages.jsonl'));
  const chatData = ChatData.open(config, {}, ROOT);
  const memories = new BaseMemories({chatData, memory: config.memory});
  const sessions = new Sessions({chatData, memories, memory: config.memory});
  const id = `smalltalk-eval-${process.pid}`;
  sessions.create({base: config.chatData.defaultBase, user: 'smalltalk-eval', id, name: 'small-talk evaluation'});
  const theories = new TheoryCache();
  const lexicon = sessions.lexicon(id);
  const store = new SessionStore({repo: sessions.repository(id), lexicon, config: {...config, policy: {...(config.policy ?? {}), reinforce: false}}, root: path.join(sessions.dir(id), 'agent'),
    circuitRules: () => theories.get([...sessions.baseCircuits(id), ...sessions.circuits(id)]).chatRules()});
  const tierAt = args.indexOf('--tier');
  // Every formalization call through Ploinky is tagged with this evaluation's purpose (the parser would tag it `formalize`).
  const chat = harnessChat({config, tier: tierAt >= 0 ? args[tierAt + 1] : null, tags: {purpose: PURPOSE}, source: 'eval:smalltalk'});
  const parser = chat.queryParser;
  const layers = args.includes('--formalize-only') ? {} : Object.fromEntries(Object.entries(ARMS).map(([arm, ids]) => [arm, layerOf(ids)]));
  const topics = topicsOf(lexicon);
  fs.mkdirSync(OUT, {recursive: true});
  const rows = [];
  let n = 0;
  // Formalizations are kept per strategy and tiers (eval/reports/current/smalltalk/formalized-<strategy>-<tiers>.jsonl; the older
  // formalized.jsonl holds archived LLMDirect circuits): a rerun or another arm reuses them, no call repeated.
  const cacheFile = path.join(OUT, `formalized-${parser.settings.strategy}-${parser.settings.models.join('+')}.jsonl`);
  const cached = new Map(fs.existsSync(cacheFile) ? readJsonl(cacheFile).map(r => [r.message, r]) : []);
  const only = args.includes('--formalize-only');
  try {
    for (const m of messages) {
      const hit = cached.get(m.message);
      const sop = hit ? {text: hit.sop} : {}, parse = hit ? {...hit.parse} : {};
      if (only) {
        if (!hit) {
          try { const done = await parser.parse({source: 'eval:smalltalk', message: m.message, lexicon, memoryKey: lexicon.circuitsSha256 ?? null}); sop.text = done.sop; Object.assign(parse, done.parse ?? {}); }
          catch (e) { sop.text = null; parse.error = String(e.code ?? e.message).slice(0, 200); }
          fs.appendFileSync(cacheFile, JSON.stringify({message: m.message, sop: sop.text, parse: {model: parse.model ?? null, ms: parse.ms ?? null, rounds: parse.rounds ?? null, error: parse.error ?? null}}) + '\n');
          console.log(`${m.id} formalized ${parse.error ?? ''} ${String(sop.text ?? '').replace(/\n/g, ' ').slice(0, 120)}`);
        }
        continue;
      }
      // The formalization runs under the first arm's layer, whose message acts the formalizer may name: the default reply memory (B)
      // first, so the formalizer sees the collections' acts (P-2.1); `--arms B` skips the conversation-v1-only arm.
      for (const arm of (opt('arms') ?? 'B,A').split(',')) {
        setReplyLayer(layers[arm].circuits, `arm ${arm}`);
        const entry = store.get('smalltalk', `c${++n}`, BASE_NAME);
        const formalizer = {id: 'smalltalk-eval', formalize: async text => {
          if (sop.text === null) throw Object.assign(new Error(parse.error ?? 'no formalization'), {code: 'parse_failed'});
          if (sop.text === undefined) { const done = await parser.parse({source: 'eval:smalltalk', message: text, lexicon, memoryKey: lexicon.circuitsSha256 ?? null}); sop.text = done.sop; Object.assign(parse, done.parse ?? {}); }
          return sop.text;
        }};
        const started = Date.now();
        let row;
        try {
          const {result: res} = await chat.turn(entry, m.message, {lexicon, author: formalizer});
          row = {id: m.id, arm, category: m.category, label: m.label, message: m.message, ok: true, text: res.text, status: res.packet?.status ?? null,
            situations: Object.fromEntries(['opening', 'body', 'aside', 'follow_up', 'closing'].map(p => [p, res.packet?.reply?.[p]?.situation ?? null]).filter(([, v]) => v)),
            signals: (res.packet?.pragmatic ?? []).map(s => s.kind), computed: !['unclear', 'courtesy'].includes(res.packet?.status), packet: res.packet, ms: Date.now() - started};
        } catch (e) {
          row = {id: m.id, arm, category: m.category, label: m.label, message: m.message, ok: false, text: `(error: ${e.code ?? e.name})`, error: String(e.message).slice(0, 300), ms: Date.now() - started};
        } finally {
          store.agents.delete(entry.key);
          try { store.repo.discard(entry.agent.session); } catch { /* gone */ }
        }
        row.sop = sop.text ?? null;
        row.parse = {model: parse.model ?? null, ms: parse.ms ?? null, rounds: parse.rounds ?? null};
        rows.push(row);
        console.log(`${m.id} ${arm} ${row.status} ${JSON.stringify(row.situations ?? {})} ${String(row.text).replace(/\n/g, ' | ').slice(0, 140)}`);
      }
      // Arm C: B with the message's label as a pragmatic signal (oracle signal), recomposed when B computed no answer.
      const b = rows.findLast(r => r.id === m.id && r.arm === 'B');
      let c = {...b, arm: 'C'};
      if (b.ok && m.label && !b.computed && !(b.signals ?? []).includes(m.label)) {
        const packet = {status: 'courtesy', pragmatic: [...(b.packet?.pragmatic ?? []).filter(s => s.kind !== m.label), {kind: m.label, score: 1}]};
        const composed = composeReply({packet, topics, seed: Number(m.id.slice(2)) * 7919, layer: layers.B});
        c = {...b, arm: 'C', text: composed.text, situations: Object.fromEntries(Object.entries(composed.reply).filter(([k, v]) => v?.situation && ['opening', 'body', 'aside', 'follow_up', 'closing'].includes(k)).map(([k, v]) => [k, v.situation])), oracle_signal: m.label};
      }
      rows.push(c);
      console.log(`${m.id} C ${JSON.stringify(c.situations ?? {})} ${String(c.text).replace(/\n/g, ' | ').slice(0, 140)}`);
    }
  } finally {
    fs.rmSync(sessions.dir(id), {recursive: true, force: true});
    await chat.close();
  }
  if (only) return;
  fs.writeFileSync(path.join(OUT, 'turns.jsonl'), rows.map(r => JSON.stringify({...r, packet: undefined})).join('\n') + '\n');
  console.log(`wrote ${path.relative(ROOT, path.join(OUT, 'turns.jsonl'))} (${rows.length} rows)`);
}

const blindId = (m, arm) => createHash('sha256').update(`smalltalk-judge\u0000${m}\u0000${arm}`).digest('hex').slice(0, 10);

function judgeInput() {
  // `--before FILE`: the B rows of an earlier turns.jsonl (another version of the system) join as the arm `before`, judged blind with
  // the current rows, so the report pairs before and after on the same rubric.
  const before = opt('before') ? readJsonl(path.resolve(opt('before'))).filter(r => r.arm === 'B').map(r => ({...r, arm: 'before'})) : [];
  const rows = [...readJsonl(path.join(OUT, 'turns.jsonl')), ...before];
  const items = rows.map(r => ({id: blindId(r.id, r.arm), message: r.message, reply: r.text}));
  items.sort((a, b) => a.id.localeCompare(b.id));
  // Identical replies of two arms are judged once (same text, same message): the judge sees each distinct pair once.
  const seen = new Map(), unique = [];
  for (const it of items) { const k = `${it.message}\u0000${it.reply}`; if (!seen.has(k)) { seen.set(k, it.id); unique.push(it); } }
  const key = rows.map(r => ({id: r.id, arm: r.arm, category: r.category, judged_as: seen.get(`${r.message}\u0000${r.text}`)}));
  const dir = path.join(ROOT, 'state/llm-jobs');
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'smalltalk-judge-input.jsonl'), unique.map(i => JSON.stringify(i)).join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'judge-key.json'), JSON.stringify(key, null, 1));
  console.log(`${unique.length} distinct (message, reply) pairs of ${rows.length} rows -> state/llm-jobs/smalltalk-judge-input.jsonl`);
}

const DIMS = ['relevance', 'tone', 'naturalness', 'honesty', 'brevity'];
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
/** Paired bootstrap (fixed seed) of the mean difference: [low, high] at 95%. */
function bootstrap(diffs, {n = 5000, seed = 7} = {}) {
  let s = seed >>> 0;
  const rnd = () => { s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x6D2B79F5) >>> 0; return (s >>> 8) / 16777216; };
  const means = [];
  for (let i = 0; i < n; i++) { let t = 0; for (let j = 0; j < diffs.length; j++) t += diffs[Math.floor(rnd() * diffs.length)]; means.push(t / diffs.length); }
  means.sort((a, b) => a - b);
  return [means[Math.floor(n * 0.025)], means[Math.floor(n * 0.975)]];
}

function report() {
  const run = opt('run');
  if (!run) throw new Error('--run DIR (the smalltalk-judge run folder) is required');
  const scores = new Map();
  for (const r of readJsonl(path.join(ROOT, run, 'accepted.jsonl'))) {
    const rec = (r.output?.records ?? [])[0];
    if (rec) scores.set(r.id, rec);
  }
  const key = JSON.parse(fs.readFileSync(path.join(OUT, 'judge-key.json'), 'utf8'));
  const turnsRows = readJsonl(path.join(OUT, 'turns.jsonl'));
  const byKey = new Map(turnsRows.map(r => [`${r.id}:${r.arm}`, r]));
  const scored = key.map(k => {
    const s = scores.get(k.judged_as);
    const total = s ? mean(DIMS.map(d => Number(s[d]))) : null;
    return {...k, category: k.category ?? byKey.get(`${k.id}:${k.arm}`).category, total, ...(s ? Object.fromEntries(DIMS.map(d => [d, Number(s[d])])) : {}), note: s?.note ?? null};
  });
  const arms = ['before', 'A', 'B', 'C'].filter(a => key.some(k => k.arm === a));
  const base = arms.includes('before') ? 'before' : 'A';
  const lines = ['# Small-talk collections: evaluation (eval/smalltalk-v1, 40 messages)', '',
    `Judge run: ${run}. Scores 1-5 (auditor tier, blind). before = B of an earlier system version (judge-input --before); A = conversation-v1 alone; B = with the default collections; C = B with the message label as an oracle pragmatic signal.`, '',
    '| Arm | n judged | relevance | tone | naturalness | honesty | brevity | mean |', '|---|---|---|---|---|---|---|---|'];
  for (const a of arms) {
    const xs = scored.filter(r => r.arm === a && r.total != null);
    lines.push(`| ${a} | ${xs.length} | ${DIMS.map(d => mean(xs.map(r => r[d])).toFixed(2)).join(' | ')} | ${mean(xs.map(r => r.total)).toFixed(2)} |`);
  }
  lines.push('');
  for (const b of arms.filter(a => a !== base)) {
    const pairs = [...new Set(scored.map(r => r.id))].map(id => [scored.find(r => r.id === id && r.arm === base)?.total, scored.find(r => r.id === id && r.arm === b)?.total]).filter(([x, y]) => x != null && y != null);
    if (!pairs.length) continue;
    const diffs = pairs.map(([x, y]) => y - x);
    const [lo, hi] = bootstrap(diffs);
    lines.push(`${b} - ${base}: mean difference ${mean(diffs).toFixed(2)} over ${diffs.length} paired messages, 95% paired bootstrap [${lo.toFixed(2)}, ${hi.toFixed(2)}]; ${diffs.filter(d => d > 0).length} better, ${diffs.filter(d => d < 0).length} worse, ${diffs.filter(d => d === 0).length} equal.`);
  }
  lines.push('', `| Category | ${arms.join(' | ')} |`, `|---|${arms.map(() => '---').join('|')}|`);
  for (const c of [...new Set(scored.map(r => r.category))]) lines.push(`| ${c} | ${arms.map(a => mean(scored.filter(r => r.category === c && r.arm === a && r.total != null).map(r => r.total)).toFixed(2)).join(' | ')} |`);
  const text = lines.join('\n') + '\n';
  fs.writeFileSync(path.join(OUT, 'report.md'), text);
  fs.writeFileSync(path.join(OUT, 'scores.jsonl'), scored.map(r => JSON.stringify(r)).join('\n') + '\n');
  process.stdout.write(text);
}

const cmd = args.find(a => !a.startsWith('--'));
if (cmd === 'turns') await turns();
else if (cmd === 'judge-input') judgeInput();
else if (cmd === 'report') report();
else { console.error('usage: node tools/eval/conversation/smalltalk/run.mjs turns | judge-input | report --run DIR'); process.exitCode = 2; }
