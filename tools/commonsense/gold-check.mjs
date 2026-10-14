#!/usr/bin/env node
/**
 * Knowledge-level check of experiment eval-commonsense-v1: executes the reviewed gold circuits (eval/commonsense/gold-circuits.mjs) on a
 * base memory through the product path (askMemory) and judges them against the gold of eval/commonsense/questions.jsonl. No author is
 * involved: this measures what the memory can answer when the question is formalized correctly. `--arm with|without` picks the circuit.
 *   QF_CHAT_ROOT=<chat data root> node tools/commonsense/gold-check.mjs --arm with|without [--base world-v1] [--out file.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openSession} from '../eval/lib/session.mjs';
import {askMemory} from '../../reasoning/slice/index.mjs';
import {GOLD_CIRCUITS} from '../../eval/commonsense/gold-circuits.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const arm = opt('--arm', 'with');
const questions = fs.readFileSync(path.join(ROOT, 'eval/commonsense/questions.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const s = openSession({base: opt('--base', 'world-v1'), id: `cs-gold-${arm}-${process.pid}`});
const session = s.store.get('cs', 'g', 'main').agent.session;
const theory = s.theories.get([...s.sessions.baseCircuits(s.id), ...s.sessions.circuits(s.id)]);
const DEFINITE = new Set(['supported', 'refuted']);
const out = [];
for (const q of questions) {
  const g = GOLD_CIRCUITS[q.id];
  if (!g) continue;
  const circuit = g[arm];
  const expect = g.expect ?? q.gold;
  if (!circuit) { out.push({id: q.id, form: q.form, outcome: 'not_expressible', status: null, ms: 0}); continue; }
  const t0 = Date.now();
  let r;
  try { r = askMemory({theory, repo: s.sessions.repository(s.id), session, query: circuit, limits: {maxLookups: 300000, maxProbes: 600000, maxFacts: 60000, retrievalMs: 60000}, budget: {timeoutMs: 120000}}); }
  catch (error) { r = {status: 'error', error: error.message}; }
  const values = (r.rows ?? []).map(x => Object.values(x)[0]).map(v => (typeof v === 'number' ? v : String(v).toLowerCase()));
  const pass = typeof expect === 'boolean' ? r.status === (expect ? 'supported' : 'refuted') : r.status === 'supported' && values.length === expect.length && expect.every(v => values.includes(v));
  out.push({id: q.id, form: q.form, outcome: pass ? 'correct' : DEFINITE.has(r.status) ? 'wrong' : r.status === 'error' ? 'error' : 'honest_unknown', status: r.status, values: values.slice(0, 8), ms: Date.now() - t0, ...(r.error ? {error: r.error.slice(0, 200)} : {})});
  console.error(q.id, out.at(-1).outcome, r.status, values.slice(0, 4).join(','), Date.now() - t0 + 'ms');
}
s.close();
const count = k => out.filter(r => r.outcome === k).length;
const summary = {arm, base: opt('--base', 'world-v1'), n: out.length, correct: count('correct'), wrong: count('wrong'), honest_unknown: count('honest_unknown'), not_expressible: count('not_expressible'), error: count('error'), median_ms: out.map(r => r.ms).sort((a, b) => a - b)[Math.floor(out.length / 2)]};
if (opt('--out', null)) { fs.mkdirSync(path.dirname(path.resolve(opt('--out'))), {recursive: true}); fs.writeFileSync(path.resolve(opt('--out')), JSON.stringify({summary, rows: out}, null, 1) + '\n'); }
console.log(JSON.stringify(summary));
process.exit(0);
