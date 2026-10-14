#!/usr/bin/env node
/**
 * Collects review items (lib/llm-review) from work a model produced.
 *
 *   node tools/eval/review/collect.mjs ingestion --model "Qwen3.8 27b" [--root chat_data/base_memories] > items.jsonl
 *       one item per non-predicate wire of every chunk knowledge.sop of an ingestion whose ingestion.json names the model;
 *       material: the wire's quote plus the declarations of the predicates it uses; context: the chunk's source passage (from TASK.md).
 *   node tools/eval/review/collect.mjs circuits --file a.jsonl [--file b.jsonl ...] > items.jsonl
 *       one item per row with a circuit: query-parser rows ({id, question, model_sop}) and books-eval records
 *       ({id, question, system.formalization.sop}); material: the message; work: the circuit.
 */
import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {join, basename} from 'node:path';

const args = process.argv.slice(2);
const opts = name => args.flatMap((a, i) => (a === '--' + name ? [args[i + 1]] : []));
const opt = (name, d) => opts(name)[0] ?? d;

/** Splits SOP text into wires: {id, type, text}. Comment lines are dropped. */
export function splitWires(text) {
  const wires = [];
  let cur = null;
  for (const line of String(text).split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const m = /^@([A-Za-z0-9_:-]+)\s+(\S+)/.exec(line);
    if (m) { cur = {id: m[1], type: m[2], lines: [line]}; wires.push(cur); continue; }
    if (cur && line.trim()) cur.lines.push(line);
  }
  return wires.map(w => ({id: w.id, type: w.type, text: w.lines.join('\n')}));
}

const between = (text, begin) => {
  const i = text.indexOf(`=== BEGIN ${begin}`);
  if (i < 0) return null;
  const start = text.indexOf('\n', i) + 1;
  const end = text.indexOf('=== END ', start);
  return text.slice(start, end < 0 ? undefined : end).trim();
};

function predicateDecls(...texts) {
  const out = new Map();
  for (const t of texts) for (const w of splitWires(t ?? '')) if (w.type === 'predicate') out.set(w.id, w.text.split('\n').filter(l => !/^\s+(label|alias|source)\b/.test(l)).join('\n'));
  return out;
}

function quoteOf(wireText) {
  const m = /^\s+quote\s+(.*)$/m.exec(wireText);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return m[1]; }
}

function usedPredicates(wireText, decls) {
  const used = new Set();
  for (const line of wireText.split('\n')) {
    const m = /^\s+(?:holds|when|then|except|unless)\s+(?:not\s+)?([a-z][a-z0-9_]*)/.exec(line);
    if (m && decls.has(m[1])) used.add(m[1]);
    const n = /^\s{4,}(?:not\s+)?([a-z][a-z0-9_]*)\s/.exec(line); // atoms inside any/all groups
    if (n && decls.has(n[1])) used.add(n[1]);
  }
  return [...used];
}

function ingestionItems() {
  const root = opt('root', 'chat_data/base_memories');
  const model = opt('model');
  const items = [];
  for (const mem of readdirSync(root)) {
    const ingDir = join(root, mem, 'ingestions');
    if (!existsSync(ingDir)) continue;
    for (const ing of readdirSync(ingDir)) {
      const meta = join(ingDir, ing, 'ingestion.json');
      if (!existsSync(meta)) continue;
      const info = JSON.parse(readFileSync(meta, 'utf8'));
      if (model && !String(info.model ?? '').endsWith(model)) continue;
      const chunksDir = join(ingDir, ing, 'chunks');
      if (!existsSync(chunksDir)) continue;
      for (const chunk of readdirSync(chunksDir)) {
        const ks = join(chunksDir, chunk, 'knowledge.sop');
        const task = join(chunksDir, chunk, 'TASK.md');
        if (!existsSync(ks) || !existsSync(task)) continue;
        const knowledge = readFileSync(ks, 'utf8');
        const taskText = readFileSync(task, 'utf8');
        // Inputs are inlined in TASK.md (=== BEGIN input/... ===) or attached as files under input/.
        const inputDir = join(chunksDir, chunk, 'input');
        const inputFile = name => (existsSync(join(inputDir, name)) ? readFileSync(join(inputDir, name), 'utf8') : null);
        const vocab = between(taskText, 'input/existing-vocabulary.sop') ?? inputFile('existing-vocabulary.sop') ?? '';
        const passageKey = (taskText.match(/=== BEGIN (input\/[^\n]*\.md) ===/g) ?? []).map(s => s.slice(10, -4)).find(k => !/vocabulary/.test(k));
        const passageFile = existsSync(inputDir) ? readdirSync(inputDir).find(n => n.endsWith('.md')) : null;
        const passage = passageKey ? between(taskText, passageKey) : passageFile ? inputFile(passageFile) : null;
        const decls = predicateDecls(vocab, knowledge);
        const cid = `${ing}/${chunk}`;
        const allDecls = [...decls.values()].join('\n');
        for (const w of splitWires(knowledge)) {
          if (w.type === 'predicate') continue;
          const used = usedPredicates(w.text, decls);
          const quote = quoteOf(w.text);
          const material = `QUOTE: ${quote ?? '(none; check the wire against the CONTEXT)'}${used.length ? `\nPREDICATES USED:\n${used.map(p => decls.get(p)).join('\n')}` : ''}`;
          // The context carries the passage and every predicate declared for it, so a repair can use a predicate the wire lacks.
          items.push({id: `${chunk}/${w.id}`, material, work: w.text, context_id: cid, context: `${passage ?? '(passage not found)'}\n\nPREDICATES DECLARED FOR THIS PASSAGE:\n${allDecls}`, meta: {source: ks, wire: w.id, type: w.type, model: info.model, vocabulary: allDecls}});
        }
      }
    }
  }
  return items;
}

function circuitItems() {
  const items = [];
  for (const f of opts('file')) {
    const tag = basename(f).replace(/\.jsonl$/, '');
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      const sop = r.model_sop ?? r.system?.formalization?.sop ?? null;
      const question = r.question ?? r.message ?? null;
      if (!sop || !question) continue;
      items.push({id: `${tag}/${r.id}`, material: question, work: sop, meta: {source: f, row: r.id, outcome: r.outcome ?? r.system?.status ?? null}});
    }
  }
  return items;
}

const cmd = args[0];
const items = cmd === 'ingestion' ? ingestionItems() : cmd === 'circuits' ? circuitItems() : null;
if (!items) { console.error('usage: collect.mjs ingestion|circuits ... (see the header of this file)'); process.exit(2); }
for (const it of items) console.log(JSON.stringify(it));
console.error(`${items.length} items`);
