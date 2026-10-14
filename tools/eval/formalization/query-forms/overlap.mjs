#!/usr/bin/env node
/**
 * Evaluation hygiene of the query-forms dev set (AGENTS.md direction 9): the dev questions are the same forms as the sealed KBQA
 * test questions with different words. Fails closed (exit 1) when a dev question is a normalized duplicate of a KBQA test question or
 * shares (nearly) all its content words with one; the offending rows are listed and written to --drop so the dev set can be pruned.
 *   node tools/eval/formalization/query-forms/overlap.mjs --dev dev.jsonl [--drop ids.json] [--min-words 3] [--jaccard 0.7]
 * Reads the sealed test files only as a validator does (the dev generator never sees them).
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readJsonlShardedSync, jsonlExists} from '../../../../lib/jsonl-shards.mjs';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const STOP = new Set('a an the of in on at to is are was were be been do does did how many much what which who whom whose where when why and or for with by from as it its this that these those has have had can could would should will not no there their his her he she they them than more most'.split(' '));
const words = text => String(text).toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(w => w && !STOP.has(w));
const norm = text => String(text).toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const dev = fs.readFileSync(opt('--dev'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const minWords = Number(opt('--min-words', 3)), jaccard = Number(opt('--jaccard', 0.7));
const tests = [];
for (const name of fs.readdirSync(path.join(ROOT, 'eval/suites')).filter(n => n.startsWith('kbqa-'))) {
  const file = path.join(ROOT, 'eval/suites', name, 'test.jsonl');
  if (jsonlExists(file)) for (const r of readJsonlShardedSync(file)) tests.push({suite: name, id: r.id, question: r.question, norm: norm(r.question), words: new Set(words(r.question))});
}
const byNorm = new Map(tests.map(t => [t.norm, t]));
const hits = [];
for (const row of dev) {
  const n = norm(row.question);
  if (byNorm.has(n)) { hits.push({id: row.id, kind: 'duplicate', question: row.question, test: byNorm.get(n).id}); continue; }
  const w = new Set(words(row.question));
  if (w.size < minWords) continue;
  for (const t of tests) {
    if (t.words.size < minWords) continue;
    let both = 0;
    for (const x of w) if (t.words.has(x)) both++;
    const j = both / (w.size + t.words.size - both);
    if (j >= jaccard) { hits.push({id: row.id, kind: 'lexical', question: row.question, test: t.id, test_question: t.question, jaccard: Math.round(j * 100) / 100}); break; }
  }
}
if (opt('--drop')) fs.writeFileSync(opt('--drop'), JSON.stringify(hits.map(h => h.id)));
console.log(JSON.stringify({dev: dev.length, kbqa_test_questions: tests.length, overlapping: hits.length, hits: hits.slice(0, 20)}, null, 1));
process.exit(hits.length ? 1 : 0);
