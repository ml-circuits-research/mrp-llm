/**
 * The PSM schema (config/formalize/psm-schema-v1.json) and the request it makes of the `structure` tier, plus the PSM-based sketch
 * that can be given to the LFM instead of the raw problem: the sentences of the problem that hold a logic-bearing span (rule, condition,
 * constraint, state, assumption, goal), in problem order, plus one statement per extracted relation rendered from the schema's
 * `render` template. Structure only: spans and offsets from the model, punctuation for sentences; no phrasing is interpreted here.
 */
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {sentencesOf} from '../fol/input.mjs';

const DEFAULT = fileURLToPath(new URL('../../../config/formalize/psm-schema-v1.json', import.meta.url));

export function loadSchema(file = DEFAULT) {
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!s.entities || typeof s.entities !== 'object') throw new Error(`${file}: entities missing`);
  return s;
}

/** The /v1/structure body for a problem text. */
export function schemaRequest(schema, text, {relations = true} = {}) {
  const rel = relations && schema.relations ? Object.fromEntries(Object.entries(schema.relations).map(([k, v]) => [k, {head: v.head, tail: v.tail, ...(v.description ? {description: v.description} : {})}])) : undefined;
  return {text, entities: schema.entities, ...(rel ? {relations: rel} : {}), threshold: schema.threshold ?? 0.5};
}

export const LOGIC_LABELS = Object.freeze(['rule', 'condition', 'constraint', 'state', 'assumption', 'goal']);

/** Spans of an extraction as a flat list [{label, text, start, end, confidence}] sorted by position. */
export function spansOf(extraction) {
  return Object.entries(extraction?.entities ?? {}).flatMap(([label, list]) => (list ?? []).map(s => ({label, text: s.text, start: s.start, end: s.end, confidence: s.confidence ?? null})))
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0) || a.label.localeCompare(b.label));
}

/** The sketch units [{text, question, from}] for the LFM. */
export function sketchSentences(extraction, text, schema = null) {
  const units = sentencesOf(text);
  let at = 0;
  const located = units.map(u => { const s = String(text).indexOf(u.text, at); at = s >= 0 ? s + u.text.length : at; return {...u, start: s, end: s + u.text.length}; });
  const spans = spansOf(extraction).filter(s => LOGIC_LABELS.includes(s.label) && Number.isInteger(s.start));
  const keep = located.filter(u => u.start >= 0 && spans.some(s => s.start >= u.start && s.end <= u.end));
  const out = keep.map(u => ({text: u.text, question: u.question, from: 'sentence'}));
  const relSchema = (schema ?? safeSchema())?.relations ?? {};
  for (const r of extraction?.relations ?? []) {
    const tpl = relSchema[r.type]?.render;
    if (tpl && r.head?.text && r.tail?.text && !out.some(u => u.text === tpl.replace('{head}', r.head.text).replace('{tail}', r.tail.text))) out.push({text: tpl.replace('{head}', r.head.text).replace('{tail}', r.tail.text), question: false, from: `relation:${r.type}`});
  }
  return out;
}
const safeSchema = () => { try { return loadSchema(); } catch { return null; } };

/**
 * The inventory of a problem rendered from a PSM extraction for the LFM's input (owner, 2026-10-03: a shared vocabulary from the
 * structure inventory): the named things as constant names, the quantities with their spans, the goal spans. Structure only: slugs of
 * the spans, nothing interpreted.
 */
export function inventoryText(extraction) {
  const spans = spansOf(extraction);
  const constant = t => String(t).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const uniq = xs => [...new Set(xs)];
  const lines = [];
  const things = uniq(spans.filter(s => s.label === 'entity').map(s => constant(s.text)).filter(Boolean));
  if (things.length) lines.push(`things (constants): ${things.join(', ')}`);
  const qs = uniq(spans.filter(s => s.label === 'quantity').map(s => s.text));
  if (qs.length) lines.push(`quantities: ${qs.map(q => `"${q}"`).join(', ')}`);
  const goals = uniq(spans.filter(s => s.label === 'goal').map(s => s.text));
  if (goals.length) lines.push(`asked: ${goals.map(g => `"${g}"`).join(', ')}`);
  return lines.join('\n') || '(none)';
}
