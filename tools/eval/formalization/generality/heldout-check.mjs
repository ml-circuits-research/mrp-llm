#!/usr/bin/env node
/**
 * Held-out check of the level-b forms of eval-generality-v1 (AGENTS.md direction 7): each form's phrasing signature must
 * appear in no development question, author guide, author prompt, example or test. Questions are taken from JSONL
 * `question` fields, from question-like string literals (ending in "?") of code and from every line of guides and
 * examples. Exit 1 lists every hit; the form then counts as known, not held out.
 *   node tools/eval/formalization/generality/heldout-check.mjs [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
/** Phrasing signatures of the held-out forms (case-insensitive, matched on one question or line). */
export const SIGNATURES = {
  'which-has-no': /\bwhich\b[^?]*\b(?:have|has) no\b/i,
  'same-value': /\b(?:do|does|are|is)\b[^?]*\band\b[^?]*\bthe same\b/i,
  'before-event': /\bdid\b[^?]*\bbefore\b[^?]*\bdid\b/i,
  'group-threshold': /\bwhich\b[^?]*\b(?:have|has) more than \d+\b/i,
  'fewest-hops': /\b(?:smallest|fewest|minimum) number of\b|\bshortest (?:route|path)\b|\bhow many hops\b/i,
  'anyone-both': /\bis there anyone\b/i,
  'counterfactual-closure': /\bif\b[^?]*\bwere\b[^?]*\bcould\b|\bcould\b[^?]*\bstill\b/i,
  'between-range': /\bbetween \d{3,4} and \d{3,4}\b/i,
  'count-difference': /\bhow many more\b/i,
  'shared-by-both': /\bwhich\b[^?]*\bdo both\b|\bboth\b[^?]*\band\b[^?]*\bhave\?/i
};
const SOURCES = [
  // The one-shot author guide (archived 2026-10-02) stays a development source: its forms were seen during development.
  {kind: 'guide', glob: 'probably_obsolete/one-shot-formalization/skills/coding-agent-query', ext: /\.md$/},
  {kind: 'author-prompt', glob: 'lib/query-author', ext: /\.mjs$/},
  {kind: 'author-prompt', glob: 'config/knowledge/formalizer-protocol-v1', ext: /\.sop$/},
  {kind: 'dev', glob: 'datasets_sources/query-forms', ext: /\.jsonl$/, depth: 1},
  {kind: 'dev', glob: 'eval/smoke-reasoning/bench/manifest.jsonl'},
  {kind: 'dev', glob: 'eval/reports/current/omp-tasks/t6-coverage/corrected-240.jsonl'},
  {kind: 'dev', glob: 'eval/reports/current/symbolic-vs-llm/t5-inputs/dev.jsonl'},
  {kind: 'dev', glob: 'eval/smoke-reasoning/cases', ext: /source\.md$/},
  {kind: 'example', glob: 'examples', ext: /\.(md|sop|json|jsonl|mjs)$/},
  {kind: 'example', glob: 'docs/wire_typs', ext: /\.html$/},
  {kind: 'test', glob: 'tests', ext: /\.(mjs|json|jsonl|sop|md)$/}
];

function* files(target, ext, depth = 8) {
  const abs = path.join(ROOT, target);
  if (!fs.existsSync(abs)) return;
  if (fs.statSync(abs).isFile()) { yield abs; return; }
  if (depth < 0) return;
  for (const entry of fs.readdirSync(abs, {withFileTypes: true})) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) yield* files(child, ext, depth - 1);
    else if (!ext || ext.test(entry.name)) yield path.join(ROOT, child);
  }
}

/** The candidate questions or lines of one file. */
function candidates(file, kind) {
  const text = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.jsonl')) return text.split('\n').filter(Boolean).flatMap(line => { try { const r = JSON.parse(line); return [r.question, r.new_question, r.text].filter(x => typeof x === 'string'); } catch { return []; } });
  // Prose: one sentence or quoted example at a time (tags removed), so a signature never spans a whole paragraph.
  // Outside the guide only questions count: a statement sharing words with a form does not teach it.
  if (kind === 'guide' || file.endsWith('.md') || file.endsWith('.sop') || file.endsWith('.html')) return text.replace(/<[^>]+>/g, ' ').split(/\n|(?<=[.?!])\s+|["“”]/).filter(x => kind === 'guide' || x.trim().endsWith('?'));
  return text.split('\n').filter(l => l.includes('?')).flatMap(l => [...l.matchAll(/"([^"\n]{8,400}\?)"|'([^'\n]{8,400}\?)'|`([^`\n]{8,400}\?)`/g)].map(m => m[1] ?? m[2] ?? m[3]));
}

export function heldoutCheck({signatures = SIGNATURES} = {}) {
  const hits = [], scanned = {};
  for (const source of SOURCES) for (const file of files(source.glob, source.ext, source.depth ?? 8)) {
    const relative = path.relative(ROOT, file);
    if (relative.startsWith('tools/eval/formalization/generality') || relative.includes('generality')) continue;
    scanned[source.kind] = (scanned[source.kind] ?? 0) + 1;
    for (const line of candidates(file, source.kind)) for (const [form, re] of Object.entries(signatures)) if (re.test(line)) hits.push({form, kind: source.kind, file: relative, text: line.trim().slice(0, 200)});
  }
  return {scanned, forms: Object.keys(signatures).length, hits};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = heldoutCheck();
  console.log(JSON.stringify({...result, held_out: Object.keys(SIGNATURES).filter(f => !result.hits.some(h => h.form === f))}, null, 1));
  process.exitCode = result.hits.length ? 1 : 0;
}
