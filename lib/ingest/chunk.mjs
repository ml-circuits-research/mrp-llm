/**
 * Chunking of a long document for ingestion (DS022 "Ingesting documents into a base memory"; skill sop-wire-authoring "Splitting long
 * texts"): the split follows the document's own structure. Markdown headings open sections; consecutive sections are packed into a
 * chunk while it stays under `maxBytes`; a section that is larger alone is cut at blank lines (paragraph boundaries), so a paragraph or
 * a table (no blank lines inside) is never cut. Every chunk records its coordinates: the heading path at its start and its 1-based line
 * range in the document, and the SHA-256 of its text, which makes re-ingestion idempotent.
 */
import {createHash} from 'node:crypto';

const sha = text => createHash('sha256').update(text).digest('hex');
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/** Sections `{level, title, path, start, end, lines}` (0-based line indices, `end` exclusive); text before the first heading is a section too. */
export function sections(text) {
  const lines = String(text).split('\n');
  const out = [];
  const stack = [];
  let current = {level: 0, title: null, path: [], start: 0};
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING.exec(lines[i]);
    if (!m) continue;
    if (i > current.start || current.title) out.push({...current, end: i});
    const level = m[1].length;
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({level, title: m[2]});
    current = {level, title: m[2], path: stack.map(s => s.title), start: i};
  }
  out.push({...current, end: lines.length});
  return out.filter(s => lines.slice(s.start, s.end).some(l => l.trim())).map(s => ({...s, lines: lines.slice(s.start, s.end)}));
}

/** Cuts a too-large section at blank lines into pieces of at most `maxBytes` (a single paragraph larger than that stays whole). */
function splitSection(section, maxBytes) {
  const pieces = [];
  let from = 0;
  let last = 0;
  const bytes = (a, b) => Buffer.byteLength(section.lines.slice(a, b).join('\n'));
  for (let i = 0; i <= section.lines.length; i++) {
    const boundary = i === section.lines.length || !section.lines[i].trim();
    if (!boundary) continue;
    if (bytes(from, i) > maxBytes && last > from) { pieces.push([from, last]); from = last; }
    last = i;
  }
  if (from < section.lines.length) pieces.push([from, section.lines.length]);
  return pieces.map(([a, b]) => ({...section, start: section.start + a, end: section.start + b, lines: section.lines.slice(a, b)}));
}

/**
 * Chunks `[{index, path, start_line, end_line, text, bytes, sha256}]` of a document (lines 1-based, inclusive). `maxBytes` bounds a
 * chunk except for a single paragraph that is larger alone.
 */
export function chunkDocument(text, {maxBytes = 7000} = {}) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const parts = sections(text).flatMap(s => Buffer.byteLength(s.lines.join('\n')) > maxBytes ? splitSection(s, maxBytes) : [s]);
  const chunks = [];
  let group = [];
  const flush = () => {
    if (!group.length) return;
    const body = group.flatMap(s => s.lines).join('\n').replace(/\n+$/, '') + '\n';
    chunks.push({index: chunks.length + 1, path: group[0].path, start_line: group[0].start + 1, end_line: group[group.length - 1].end, text: body, bytes: Buffer.byteLength(body), sha256: sha(body)});
    group = [];
  };
  for (const part of parts) {
    const size = Buffer.byteLength([...group, part].flatMap(s => s.lines).join('\n'));
    if (group.length && size > maxBytes) flush();
    group.push(part);
  }
  flush();
  return chunks;
}

/** The document's title: its first level-1 heading, else the given name. */
export function documentTitle(text, fallback) {
  const m = /^#\s+(.+?)\s*$/m.exec(String(text));
  return m ? m[1] : fallback;
}
