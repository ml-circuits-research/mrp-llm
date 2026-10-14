/**
 * PSM extraction (GLiNER JSON of the structure tier) → the inventory part of SOP-IR, deterministically (owner decision 2026-10-03).
 * The PSM writes no logic; it names the referents the logic is about:
 *   numbers     every registry number (lib/formalize/registry.mjs, v1..vn) with the PSM quantity span that covers it (its unit/count
 *               words), or none; a quantity span without digits is kept apart (a number in words, or not a number)
 *   names       the entity spans, folded to a slug (Map slug → text as written), so the FOL's constants link to the problem's own
 *               names and an answer is shown as written
 *   goals       the goal spans, with whether they lie in a question unit of the problem (a sentence ending with `?`, else the last one)
 *   parts       the other labels (event, state, condition, rule, constraint, assumption) as spans, for the obligation report
 *   relations   the extracted relations, de-duplicated by (type, head, tail)
 * Structure only: offsets, digits, punctuation; no phrasing is interpreted.
 */
import {extractNumbers} from '../registry.mjs';
import {sentencesOf} from '../fol/input.mjs';
import {spansOf} from './schema.mjs';
import {slug} from '../fol/to-sop.mjs';

/** Registry numbers with their character offsets in the text: [{index, value, percent, start, end}]. */
export function numbersWithOffsets(text) {
  let at = 0;
  return extractNumbers(text).map(v => { const s = text.indexOf(v.span, at); at = s >= 0 ? s + v.span.length : at; return {index: v.index, value: v.value, percent: v.percent, span: v.span, start: s, end: s + v.span.length}; });
}

/** Character ranges of the question units: sentences ending with `?`, else the last sentence. */
export function questionRanges(text) {
  const units = sentencesOf(text);
  let at = 0;
  const located = units.map(u => { const s = text.indexOf(u.text, at); at = s >= 0 ? s + u.text.length : at; return {...u, start: s, end: s + u.text.length}; });
  const qs = located.filter(u => u.question);
  return (qs.length ? qs : located.slice(-1)).map(u => [u.start, u.end]);
}

const overlaps = (a, b) => a.start < b.end && b.start < a.end;

export function structureToIr(extraction, text) {
  const spans = spansOf(extraction);
  const quantities = spans.filter(s => s.label === 'quantity');
  const numbers = numbersWithOffsets(text).map(n => {
    const q = quantities.find(s => overlaps(s, n));
    return {...n, quantity: q ? {text: q.text, start: q.start, end: q.end} : null};
  });
  const qr = questionRanges(text);
  const inQuestion = s => qr.some(([a, b]) => s.start >= a && s.end <= b);
  const names = new Map();
  for (const s of spans.filter(x => x.label === 'entity')) { const k = slug(s.text); if (k && !names.has(k)) names.set(k, s.text); }
  const seen = new Set();
  const relations = (extraction?.relations ?? []).filter(r => { const k = `${r.type}|${slug(r.head?.text)}|${slug(r.tail?.text)}`; if (seen.has(k) || !r.head || !r.tail) return false; seen.add(k); return true; })
    .map(r => ({type: r.type, head: r.head.text, tail: r.tail.text, confidence: r.confidence ?? null}));
  return {
    numbers,
    wordQuantities: quantities.filter(q => !/\d/.test(q.text)).map(q => q.text),
    digitQuantities: quantities.filter(q => /\d/.test(q.text)).map(q => ({text: q.text, start: q.start, end: q.end, registry: numbers.filter(n => overlaps(q, n)).map(n => n.index)})),
    names,
    goals: spans.filter(s => s.label === 'goal').map(s => ({text: s.text, start: s.start, end: s.end, inQuestion: inQuestion(s)})),
    parts: Object.fromEntries(['event', 'state', 'condition', 'rule', 'constraint', 'assumption'].map(l => [l, spans.filter(s => s.label === l).map(s => s.text)])),
    relations,
  };
}

/** Links the constants of a FOL IR to the PSM names: {linked: [slug], unlinked: [slug]}. */
export function linkConstants(folIr, names) {
  const consts = new Set();
  const walk = t => { if (t.const) consts.add(slug(t.const)); if (t.fn) t.args.forEach(walk); };
  const queryLits = q => [...(q.lit ? [q.lit, ...(q.also ?? [])] : []), ...(q.alts ?? []).flat(), ...(q.where ?? []), ...(q.scope ?? [])];
  for (const l of [...folIr.facts, ...folIr.rules.flatMap(r => [...r.when, r.then]), ...folIr.queries.flatMap(queryLits)]) (l.args ?? []).forEach(walk);
  const all = [...consts].filter(c => !/^sk\d+$/.test(c));
  return {linked: all.filter(c => names.has(c)), unlinked: all.filter(c => !names.has(c))};
}
