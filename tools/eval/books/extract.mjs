#!/usr/bin/env node
/**
 * Extraction of the owner's problem books (datasets_sources/books/*.docx, rights `owner-provided`) into evaluation items:
 *   node tools/eval/books/extract.mjs [--books dir] [--out datasets_sources/books/eval/items.jsonl]
 * One JSON line per problem with its answer: {id, book, book_title, chapter, section, area, grade, tags, number, question, answer,
 * answer_value, answer_kind, solution}. DOCX files are read with Node built-ins (tools/eval/books/docx.mjs). The output and everything
 * derived from the books' text stays under the gitignored datasets_sources/ and is never committed. The design handbook
 * Small_Models_Compiled_Context_SOP_Lang_EN.docx has no problems and is skipped.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {docxParagraphs} from './docx.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const opt = (args, name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const clean = s => s.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
const oneLine = s => clean(s).replace(/\n+/g, ' ');

export const BOOKS = {
  math: {file: 'Mathematical_Thinking_1000_Problems_Grades_1-4_EN.docx', title: 'Mathematical Thinking'},
  science: {file: '1000_Scientific_Reasoning_Problems_Grades_1-4_EN.docx', title: 'Scientific Reasoning'},
  world: {file: 'World_as_a_System_1000_Reasoning_Problems_Grades_1-4_EN.docx', title: 'World as a System'},
  commonsense: {file: 'Common_Sense_for_Adults_1000_Problems.docx', title: 'Common Sense for Adults'},
  decompose: {file: 'Decompose_to_Solve_1000_Problems.docx', title: 'Decompose to Solve'},
  adult: {file: 'Adult_Reasoning_and_Everyday_Knowledge_Course.docx', title: 'Adult Reasoning and Everyday Knowledge'},
  logic: {file: 'Logical_Reasoning_Types_Course.docx', title: 'Logical Reasoning Types'},
};

const stripLead = (s, re) => clean(s.replace(re, ''));

/** Splits the paragraphs into blocks that start at a problem marker; `ctx` carries the headings seen so far. */
function blocks(paras, isStart) {
  const out = [];
  let ctx = {h1: '', h2: '', h1s: []}, cur = null;
  for (const p of paras) {
    if (p.style === 'Heading1') { ctx = {...ctx, h1: p.text, h2: ''}; cur = null; continue; }
    if (p.style === 'Heading2' && !isStart(p)) { ctx = {...ctx, h2: p.text}; cur = null; continue; }
    if (isStart(p)) { cur = {head: p, ctx: {...ctx}, body: []}; out.push(cur); continue; }
    if (cur) cur.body.push(p);
  }
  return out;
}

const GRADE_OF_CHAPTER = ch => (ch <= 5 ? 1 : ch <= 10 ? 2 : ch <= 15 ? 3 : 4);

const parsers = {
  math(paras) {
    const out = [];
    for (const b of blocks(paras, p => p.style === 'Heading2' && /^\d+\.\d+\./.test(p.text))) {
      const body = b.body.find(p => p.style === 'ProblemBody'), ans = b.body.find(p => p.style === 'Answer');
      if (!body || !ans) continue;
      const m = b.head.text.match(/^(\d+)\.(\d+)\.\s*(.*)$/), chapter = Number(m[1]);
      out.push({number: `${chapter}.${m[2]}`, chapter: b.ctx.h1, section: m[3], area: `${chapter}. ${b.ctx.h1.replace(/^Chapter \d+\.\s*/, '')}`,
        grade: chapter <= 20 ? GRADE_OF_CHAPTER(chapter) : GRADE_OF_CHAPTER(chapter - 20), tags: [m[3].replace(/\s*\d+$/, '')],
        question: stripLead(body.text, /^Problem\.\s*/), answer: stripLead(ans.text, /^Answer:?\s*/),
        solution: b.body.filter(p => p.style === 'SolutionStep').map(p => p.text).join('\n')});
    }
    return out;
  },
  science(paras) {
    const out = [];
    for (const b of blocks(paras, p => p.style === 'Heading3' && /^Problem \d+/.test(p.text))) {
      const meta = b.body.find(p => p.style === 'ProblemMeta')?.text ?? '', ans = b.body.find(p => p.style === 'Answer');
      const question = b.body.filter(p => p.style === 'Box' || /^Question\./.test(p.text)).map(p => p.text);
      if (!ans || !question.length) continue;
      const m = b.head.text.match(/^Problem (\d+)\.\s*(.*)$/), mm = meta.match(/Domains?:\s*(.*?)\s*•\s*Grade\s*(\d)/);
      out.push({number: m[1], chapter: b.ctx.h1, section: b.ctx.h2, area: mm?.[1] ?? b.ctx.h2, grade: mm ? Number(mm[2]) : null, tags: [m[2]],
        question: question.map(t => stripLead(t, /^(Problem world|Case data|Question)\.\s*/)).join('\n'), answer: stripLead(ans.text, /^Answer\.?\s*/),
        solution: b.body.filter(p => p.style === 'SolutionStep').map(p => p.text).join('\n')});
    }
    return out;
  },
  world(paras) {
    const out = [];
    let grade = null;
    for (const p of paras) if (p.style === 'Heading1' && /^GRADE \d/.test(p.text)) { grade = Number(p.text.match(/\d/)[0]); p.grade = grade; }
    let g = null;
    for (const p of paras) { if (p.grade) g = p.grade; p.g = g; }
    for (const b of blocks(paras, p => p.style === 'ProblemTitle')) {
      const f = key => b.body.find(p => p.style === 'Field' && p.text.startsWith(key))?.text;
      const given = f('Given facts.'), rules = f('Rules.'), task = f('Task.'), ans = f('Answer.');
      if (!task || !ans) continue;
      const m = b.head.text.match(/^Problem (\d+)\.\s*(.*)$/), fam = b.ctx.h2.match(/^([A-Z]\d+)\.\s*(.*)$/);
      out.push({number: m[1], chapter: b.ctx.h1, section: b.ctx.h2, area: b.ctx.h2, grade: b.head.g ?? null, tags: [fam?.[1] ?? '', m[2]].filter(Boolean),
        question: [f('Knowledge context.'), given, rules, task].filter(Boolean).map(t => t.replace(/^[A-Z][A-Za-z ]+\.\s/, '')).join('\n'), answer: stripLead(ans, /^Answer\.\s*/),
        solution: stripLead(f('Step-by-step solution.') ?? '', /^Step-by-step solution\.\s*/)});
    }
    return out;
  },
  commonsense(paras) {
    const out = [];
    for (const b of blocks(paras, p => p.style === 'Heading3' && /^Problem \d+\.\d+\.\d+/.test(p.text))) {
      const i = b.body.findIndex(p => p.style === 'AnswerBox');
      if (i < 0) continue;
      const m = b.head.text.match(/^Problem ([\d.]+)\s*[—-]\s*(.*)$/), chapter = Number(m[1].split('.')[0]);
      out.push({number: m[1], chapter: b.ctx.h1, section: b.ctx.h2, area: b.ctx.h1, grade: null, tags: [m[2], b.ctx.h2.replace(/^[\d.]+\s*/, '')],
        question: b.body.slice(0, i).filter(p => ['BodyText', 'CompactBullet'].includes(p.style)).map(p => p.text.replace(/^Question\.\s*/, 'Question: ')).join('\n'),
        answer: stripLead(b.body[i].text, /^Answer\.\s*/), solution: b.body.slice(i + 1).map(p => p.text).join('\n'), chapter_no: chapter});
    }
    return out;
  },
  decompose(paras) {
    const out = [];
    for (const b of blocks(paras, p => p.style === 'ProblemTitle')) {
      const sc = b.body.find(p => /^Scenario\./.test(p.text)), q = b.body.find(p => /^Main question\./.test(p.text)), a = b.body.find(p => /^Combined answer\./.test(p.text));
      if (!sc || !q || !a) continue;
      const m = b.head.text.match(/^Problem ([\d.]+)\s*[—-]\s*(.*)$/);
      out.push({number: m[1], chapter: b.ctx.h1, section: b.ctx.h2, area: b.ctx.h1.replace(/^Chapter \d+\s*[—-]\s*/, `${m[1].split('.')[0]}. `), grade: null, tags: [m[2]],
        question: `${stripLead(sc.text, /^Scenario\.\s*/)}\n${stripLead(q.text, /^Main question\.\s*/)}`, answer: stripLead(a.text, /^Combined answer\.\s*/),
        solution: b.body.filter(p => p.style === 'Subproblem' || /^(Best |Decomposition lesson)/.test(p.text)).map(p => p.text).join('\n')});
    }
    return out;
  },
};

/** Adult and Logical courses: STEM / QUESTION / ANSWER / explanation paragraphs under each Heading3 problem. */
function course(paras) {
  const out = [];
  for (const b of blocks(paras, p => p.style === 'Heading3' && /^Problem \d+/.test(p.text))) {
    const parts = {}; let key = null;
    for (const p of b.body) {
      const t = p.text.trim();
      if (/^(STEM|QUESTION|ANSWER|LOGICAL EXPLANATION|STEP-BY-STEP REASONING)$/.test(t)) { key = t; parts[key] = []; continue; }
      if (key) parts[key].push(p.text);
    }
    if (!parts.STEM || !parts.QUESTION || !parts.ANSWER) continue;
    const m = b.head.text.match(/^Problem (\d+)\.\s*(.*)$/), ch = b.ctx.h1.match(/^Chapter (\d+)\.\s*(.*)$/);
    out.push({number: m[1], chapter: b.ctx.h1, section: b.ctx.h2, area: ch ? `${ch[1]}. ${ch[2]}` : b.ctx.h1, grade: null, tags: [m[2].replace(/\s*—\s*variant \d+$|\s*—\s*case \d+$/, ''), b.ctx.h2.replace(/^[\d.]+\s*/, '')],
      question: `${parts.STEM.join('\n')}\n${parts.QUESTION.join('\n')}`, answer: parts.ANSWER.join('\n'), solution: (parts['LOGICAL EXPLANATION'] ?? parts['STEP-BY-STEP REASONING'] ?? []).join('\n')});
  }
  return out;
}
parsers.adult = course; parsers.logic = course;

const NUM = /(?<![\w.])-?\d+(?:[.,]\d+)?(?:\/\d+)?%?/g;
const toNumber = s => { const t = s.replace(/,(?=\d{3}\b)/g, '').replace(',', '.'); if (t.includes('/')) { const [a, b] = t.split('/'); return Number(a) / Number(b); } return Number(t.replace('%', '')); };
export const numbersOf = text => [...String(text).matchAll(NUM)].map(m => toNumber(m[0])).filter(Number.isFinite);

/**
 * The answer kind and a normalised value: yes_no | number | list | entity | text. A yes/no answer that also gives numbers the question
 * does not contain ("Yes, overlap 28 years.") keeps those numbers in `numbers`: the score requires them next to the polarity. The bare
 * words "Da"/"Nu" of a translated book that kept its source language are yes/no.
 */
export function classifyAnswer(answer, question = '') {
  const a = oneLine(answer).replace(/^(da|nu)\b(?=[.!]?\s*$)/i, w => (/^da$/i.test(w) ? 'Yes' : 'No')), first = a.split(/[.;:!?]/)[0].toLowerCase();
  const nums = numbersOf(a), words = a.replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const asked = new Set(numbersOf(question));
  const extra = () => { const n = [...new Set(nums.filter(x => !asked.has(x)))]; return n.length ? {numbers: n} : {}; };
  if (/^(yes|no)\b/i.test(a) && words.length <= 25) return {kind: 'yes_no', value: /^yes/i.test(a), ...extra()};
  if (/^(true|false)\b/i.test(a) && words.length <= 25) return {kind: 'yes_no', value: /^true/i.test(a), ...extra()};
  if (/^(not enough|insufficient|cannot be determined|it cannot be|unknown|the data do not|the text is silent)/i.test(first)) return {kind: 'unknown', value: null};
  if (nums.length === 1 && words.length <= 6) return {kind: 'number', value: nums[0], unit: words.join(' ') || null};
  if (nums.length > 1 && words.length <= 14) return {kind: 'list', value: nums};
  if (!nums.length && words.length <= 4) return {kind: 'entity', value: a.replace(/[.\s]+$/, '').toLowerCase()};
  if (nums.length && words.length <= 25) return {kind: 'number_text', value: nums};
  return {kind: 'text', value: null};
}

const slug = k => k;
export function extractAll({dir = path.join(ROOT, 'datasets_sources/books')} = {}) {
  const items = [], stats = {};
  for (const [key, book] of Object.entries(BOOKS)) {
    const rows = parsers[key](docxParagraphs(path.join(dir, book.file)));
    for (const r of rows) {
      const answer = clean(r.answer), cls = classifyAnswer(answer, clean(r.question));
      items.push({id: `${slug(key)}:${r.number}`, book: key, book_title: book.title, chapter: r.chapter, section: r.section, area: r.area, grade: r.grade, tags: r.tags, number: r.number,
        question: clean(r.question), answer, answer_value: cls.value, answer_kind: cls.kind, ...(cls.unit ? {answer_unit: cls.unit} : {}), ...(cls.numbers ? {answer_numbers: cls.numbers} : {}), solution: clean(r.solution)});
    }
    stats[key] = rows.length;
  }
  // The books repeat a few problems verbatim (cases of one form); the later copies are marked and never sampled.
  const seen = new Map();
  for (const i of items) { const k = i.question.replace(/\s+/g, ' ').toLowerCase(); if (seen.has(k)) i.dup_of = seen.get(k); else seen.set(k, i.id); }
  const ids = new Set(items.map(i => i.id));
  if (ids.size !== items.length) throw new Error(`duplicate ids: ${items.length - ids.size}`);
  return {items, stats};
}

export function main(args = process.argv.slice(2)) {
  const out = path.resolve(ROOT, opt(args, '--out', 'datasets_sources/books/eval/items.jsonl'));
  const {items, stats} = extractAll({dir: path.resolve(ROOT, opt(args, '--books', 'datasets_sources/books'))});
  fs.mkdirSync(path.dirname(out), {recursive: true});
  fs.writeFileSync(out, items.map(i => JSON.stringify(i)).join('\n') + '\n');
  console.log(`${items.length} items -> ${path.relative(ROOT, out)}`);
  for (const [k, n] of Object.entries(stats)) {
    const kinds = {}; for (const i of items.filter(i => i.book === k)) kinds[i.answer_kind] = (kinds[i.answer_kind] ?? 0) + 1;
    const areas = new Set(items.filter(i => i.book === k).map(i => i.area));
    console.log(`  ${k.padEnd(12)} ${String(n).padStart(5)}  areas=${areas.size}  ${JSON.stringify(kinds)}`);
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
