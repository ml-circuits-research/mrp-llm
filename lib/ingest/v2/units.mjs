/**
 * The units of a document chunk for ingestion v2: the sentences of its paragraphs and the rows of its tables, each with its location
 * (1-based line) and its quote (the exact words of the document the unit comes from). Structure only: headings give the section,
 * sentence punctuation and line breaks split sentences (lib/formalize/fol/input.mjs `sentencesOf`), a Markdown table row becomes one
 * unit whose text pairs each header cell with the row's cell ("Name: Alice Chen; Department: Workshop") and whose quote is the row line.
 */
import {sentencesOf} from '../../formalize/fol/input.mjs';

const HEADING = /^#{1,6}\s+/;
const TABLE = /^\s*\|.*\|\s*$/;
const RULE_ROW = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
/**
 * A line without its Markdown emphasis marks (`**`, `__`), with the position in the line of every kept character, so a sentence of
 * the plain text can be quoted with the line's own characters (the quote check reads the document as written).
 */
function plain(raw) {
  let text = '';
  const at = [];
  for (let i = 0; i < raw.length; i++) {
    if ((raw[i] === '*' || raw[i] === '_') && raw[i + 1] === raw[i]) { i++; continue; }
    text += raw[i];
    at.push(i);
  }
  return {text, at};
}

/**
 * Units of a chunk `{text, start_line, path}`: [{index, line, text, quote, table?, section}]. `index` counts from 1 within the chunk;
 * lines are document lines. Horizontal rules and headings are not units.
 */
export function chunkUnits(chunk) {
  const lines = String(chunk.text).split('\n');
  const out = [];
  let section = chunk.path?.length ? chunk.path[chunk.path.length - 1] : '';
  let header = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = chunk.start_line + i;
    if (!raw.trim() || /^\s*(-{3,}|\*{3,})\s*$/.test(raw)) { header = null; continue; }
    if (HEADING.test(raw)) { section = raw.replace(HEADING, '').trim(); header = null; continue; }
    if (TABLE.test(raw)) {
      if (RULE_ROW.test(raw)) continue;
      const row = cells(raw);
      if (!header) { header = row; continue; }
      const text = row.map((c, k) => `${header[k] ?? `column ${k + 1}`}: ${c}`).join('; ') + '.';
      out.push({index: out.length + 1, line, text, quote: raw.trim(), table: true, section});
      continue;
    }
    header = null;
    const p = plain(raw);
    let from = 0;
    for (const s of sentencesOf(p.text)) {
      const start = p.text.indexOf(s.text, from);
      from = start + s.text.length;
      const quote = start >= 0 ? raw.slice(p.at[start], p.at[start + s.text.length - 1] + 1) : s.text;
      out.push({index: out.length + 1, line, text: s.text.trim(), quote, section, ...(s.question ? {question: true} : {})});
    }
  }
  return out;
}
