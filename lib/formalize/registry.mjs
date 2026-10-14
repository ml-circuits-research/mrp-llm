/**
 * The registry of a problem (experiments/proposal/semantic-decomposition-protocol.md, N0): the referents every later question names by
 * index instead of inventing names.
 *   numbers  v1..vn: every number of the message in order, extracted structurally (digits, decimals, thousands separators, a percent
 *            sign), each with its verbatim span and a window of the words around it (structure, not interpretation);
 *   things   e1..ek: the named things the problem compares or asks about, copied verbatim from the message by the model (each must occur
 *            in the message; the reader keeps only those).
 * `registry(message)` builds the numbers; `withThings(reg, text)` adds the things from a model's answer; `renderRegistry` gives the
 * prompt blocks (with or without labels). Used by the expression path (lib/formalize/expression-program.mjs); its first user, the
 * stage-A decomposition, is archived in probably_obsolete/formalization-experiments-2026-10/.
 */
const strip = text => String(text ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/\*\*|`/g, '').trim();
const lines = text => strip(text).split('\n').map(s => s.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim()).filter(Boolean);

/** v1..vn: [{index, name: 'vK', value, percent, span, context}] (at most `max`). */
export function extractNumbers(message, {window = 10, max = 24} = {}) {
  const text = String(message ?? ''), out = [];
  const re = /(?<![\p{L}\d.,])(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?)(\s?%)?(?![\d\p{L}])/gu;
  for (const m of text.matchAll(re)) {
    const value = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    const before = text.slice(0, m.index).trim().split(/\s+/).slice(-window).join(' '), after = text.slice(m.index + m[0].length).trim().split(/\s+/).slice(0, window).join(' ');
    out.push({index: out.length + 1, name: `v${out.length + 1}`, value, percent: Boolean(m[2]), span: m[0].trim(), context: `${before} [${m[0].trim()}] ${after}`.replace(/\s+/g, ' ').trim()});
    if (out.length >= max) break;
  }
  return out;
}

/** The named things of a model's answer, copied from the message (one per line, `eK:` prefixes allowed), or [] for "none", or null. */
export function readThings(text, message) {
  if (/^\s*none\b/i.test(strip(text))) return [];
  const folded = String(message ?? '').toLowerCase(), out = [];
  for (const line of lines(text)) {
    const name = line.replace(/^e\d+\s*[:=-]\s*/i, '').replace(/^["“]|["”]$/g, '').trim();
    if (name && folded.includes(name.toLowerCase()) && !out.some(x => x.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out.length ? out.slice(0, 12) : null;
}

/** The registry of a message: {message, numbers, things: [{index, name: 'eK', text}], labels: Map}. */
export function registry(message, options = {}) {
  return {message: String(message ?? ''), numbers: extractNumbers(message, options), things: [], labels: new Map()};
}

/** The registry with the things of a model's answer (null when the answer names nothing that occurs in the message). */
export function withThings(reg, text) {
  const names = readThings(text, reg.message);
  if (names === null) return null;
  return {...reg, things: names.map((t, i) => ({index: i + 1, name: `e${i + 1}`, text: t}))};
}

/** The prompt blocks: numbers with context (labelling), numbers with labels (later questions), things. */
export function renderRegistry(reg, {labels = reg.labels ?? new Map()} = {}) {
  return {
    numbersWithContext: reg.numbers.map(v => `v${v.index} = ${v.span}   (${v.context})`).join('\n'),
    numbers: reg.numbers.map(v => `v${v.index} = ${v.span}${labels.get(v.index) ? `: ${labels.get(v.index)}` : ''}`).join('\n'),
    things: reg.things.map(t => `e${t.index} ${t.text}`).join(', '),
  };
}
