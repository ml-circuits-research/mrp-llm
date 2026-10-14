#!/usr/bin/env node
/** Mechanical validation of items.jsonl: schema, unique ids, question and answer verbatim in the book text (tools/eval/books/extract.mjs). */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {docxParagraphs} from './docx.mjs';
import {BOOKS} from './extract.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const norm = s => s.replace(/\s+/g, ' ').trim();
const items = fs.readFileSync(path.join(ROOT, 'datasets_sources/books/eval/items.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const problems = [];
const ids = new Set();
for (const i of items) {
  for (const k of ['id', 'book', 'area', 'question', 'answer', 'answer_kind']) if (!i[k]) problems.push(`${i.id}: missing ${k}`);
  if (ids.has(i.id)) problems.push(`${i.id}: duplicate`); ids.add(i.id);
}
const bad = {};
for (const [book, meta] of Object.entries(BOOKS)) {
  const text = norm(docxParagraphs(path.join(ROOT, 'datasets_sources/books', meta.file)).map(p => p.text).join(' '));
  for (const i of items.filter(x => x.book === book)) {
    // Every line of the question (labels such as "Question." removed) and the answer must occur in the book text.
    const parts = [...i.question.split('\n'), ...i.answer.split('\n')].map(norm).filter(s => s.length > 12);
    const missing = parts.filter(p => !text.includes(p.replace(/^Question: /, '')));
    if (missing.length) { (bad[book] ??= []).push(i.id); if (bad[book].length <= 3) problems.push(`${i.id}: not verbatim: ${missing[0].slice(0, 80)}`); }
  }
}
const questions = new Map();
for (const i of items) { const k = norm(i.question).toLowerCase(); if (questions.has(k) && i.dup_of !== questions.get(k)) problems.push(`${i.id}: unmarked duplicate of ${questions.get(k)}`); else if (!questions.has(k)) questions.set(k, i.id); }
console.log(`${items.filter(i => i.dup_of).length} verbatim repeats marked dup_of (excluded from sampling)`);
console.log(`${items.length} items, ${problems.length} problems`);
for (const [b, l] of Object.entries(bad)) console.log(`  ${b}: ${l.length} items with a non-verbatim part`);
for (const p of problems.slice(0, 25)) console.log(' ', p);
process.exitCode = problems.length ? 1 : 0;
