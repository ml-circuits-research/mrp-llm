#!/usr/bin/env node
/**
 * The reusable circuits of the book problems written by a strong tier (the `ceiling` arm of tools/eval/books/run.mjs): one JSON file
 * per problem under state/formalization-gold/books/ (operational, gitignored), with the message, the circuit as the formalizer returned
 * it, the executed answer, the verdict against the gold and the provenance. The formalization improver replays the correct ones as
 * reference circuits (CPU only); the reasoning cycle replays all of them after an engine, memory or language fix (`run.mjs --replay`).
 *   node tools/eval/books/gold-circuits.mjs --run <scored ceiling run dir>     store or update the run's circuits
 *   node tools/eval/books/gold-circuits.mjs --stats                             counts by book and verdict
 * A stored correct circuit is never replaced by a different circuit that is not correct; the same circuit always takes the new verdict.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const GOLD_DIR = path.join(ROOT, 'state/formalization-gold/books');
const fileOf = id => path.join(GOLD_DIR, `${String(id).replace(/[^\w.-]/g, '_')}.json`);
const opt = (args, name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };

export function readGold(id, {dir = GOLD_DIR} = {}) {
  const f = dir === GOLD_DIR ? fileOf(id) : path.join(dir, path.basename(fileOf(id)));
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

/** Stores the ceiling rows of a scored run; returns {written, kept, skipped}. */
export function storeRun(runDir, {dir = GOLD_DIR, now = () => new Date()} = {}) {
  fs.mkdirSync(dir, {recursive: true});
  const rows = fs.readFileSync(path.join(runDir, 'scored.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(r => r.arm === 'ceiling');
  let written = 0, kept = 0, skipped = 0;
  for (const r of rows) {
    const circuit = r.circuit ?? r.system?.formalization?.sop ?? null;
    if (!circuit || !r.verdict || r.verdict.outcome === 'pending') { skipped++; continue; }
    const f = path.join(dir, path.basename(fileOf(r.id)));
    const old = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
    const correct = r.verdict.outcome === 'correct';
    if (old && old.correct && old.circuit !== circuit && !correct) { kept++; continue; }
    const rec = {id: r.id, book: r.book, message: r.question, gold: r.gold, gold_kind: r.gold_kind, circuit, author_tier: r.author_tier ?? null,
      status: r.system?.status ?? null, answer_text: r.text ?? null, answers: r.system?.answers ?? [], engine: r.system?.reasoning?.engine ?? null,
      verdict: r.verdict, correct, provenance: {run: path.basename(runDir), strategy: r.replayed ? 'replay' : r.system?.understanding?.strategy ?? 'LocalLLMStepByStep', author_tier: r.author_tier ?? null,
        first_run: old && old.circuit === circuit ? old.provenance?.first_run ?? old.provenance?.run : path.basename(runDir), written_at: now().toISOString()}};
    fs.writeFileSync(f, JSON.stringify(rec, null, 1) + '\n');
    written++;
  }
  return {written, kept, skipped};
}

export function stats({dir = GOLD_DIR} = {}) {
  const out = {};
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')) : []) {
    const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const b = (out[r.book] ??= {n: 0, correct: 0});
    b.n++; if (r.correct) b.correct++;
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--stats')) console.log(JSON.stringify(stats()));
  else console.log(JSON.stringify(storeRun(path.resolve(ROOT, opt(args, '--run', '')))));
}
