#!/usr/bin/env node
/**
 * Regression check of experiment eval-commonsense-v1 without an author: replays the circuits a recorded run of the coding agent wrote for
 * the world-kb questions (eval/reports/current/query-parsers/world30-<run>.jsonl, field model_sop) through the chat turn of ChatSOPAdapter
 * (tools/eval/lib/chat-turn.mjs, the recorded circuit as the turn's circuit author: no model call) on a base memory, and judges each answer as tools/eval/formalization/query-parsers.mjs does (judgeWorld). Run once per chat data root (with and without
 * commonsense-v1) and compare: the same circuit must give the same verdict, so any difference is the layer's doing.
 *   QF_CHAT_ROOT=<root> node tools/commonsense/replay.mjs --run <world30 jsonl> [--base world-v1] [--out file.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openSession} from '../eval/lib/session.mjs';
import {harnessChat} from '../eval/lib/chat-turn.mjs';
import {judgeWorld} from '../eval/formalization/query-parsers.mjs';
import {BASE_NAME} from '../../lib/chat-data/memories.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const recorded = fs.readFileSync(path.resolve(opt('--run')), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(r => r.model_sop);
const questions = new Map(JSON.parse(fs.readFileSync(path.join(ROOT, 'eval/world-kb/questions.json'), 'utf8')).map(q => [q.id, q]));
const labels = JSON.parse(fs.readFileSync(path.join(ROOT, 'datasets_sources/world-kb/entities.json'), 'utf8'));
const s = openSession({base: opt('--base', 'world-v1'), id: 'cs-replay-' + process.pid});
const chat = harnessChat({config: s.config, source: 'eval:commonsense-replay'});
const out = [];
for (const r of recorded) {
  const q = questions.get(r.id);
  if (!q) continue;
  const entry = s.store.get('cs', 'r-' + r.id, BASE_NAME);
  const t0 = Date.now();
  let res = null, error = null;
  try { res = (await chat.turn(entry, r.question, {lexicon: s.lexicon, author: {id: 'replay', formalize: async () => r.model_sop}})).result; } catch (e) { error = e; }
  const pass = !error && judgeWorld(q, res?.packet, res?.text ?? '', labels);
  out.push({id: r.id, recorded_outcome: r.outcome, pass, status: res?.packet?.status ?? null, ms: Date.now() - t0, error: error ? String(error.message).slice(0, 200) : null});
  console.error(r.id, pass ? 'pass' : 'fail', res?.packet?.status ?? '-', Date.now() - t0 + 'ms');
}
s.close();
await chat.close();
const summary = {n: out.length, pass: out.filter(r => r.pass).length, median_ms: out.map(r => r.ms).sort((a, b) => a - b)[Math.floor(out.length / 2)]};
if (opt('--out', null)) { fs.mkdirSync(path.dirname(path.resolve(opt('--out'))), {recursive: true}); fs.writeFileSync(path.resolve(opt('--out')), JSON.stringify({summary, rows: out}, null, 1) + '\n'); }
console.log(JSON.stringify(summary));
process.exit(0);
