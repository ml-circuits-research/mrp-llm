/**
 * Deterministic checks of the knowledge-mining pipeline (tools/knowledge-mining/mine.mjs). They decide by structure, never by reading
 * language: duplicates and contradictions against the memory (canonical wire keys, functional value conflicts), the problem's own names
 * and numbers in a candidate (string identity with the problem's tokens), copied book text (word n-grams, the measure of
 * tools/datasets/no-copy.mjs applied to the books), and the provenance stamp every admitted wire carries.
 */
import {parse, wireText} from '../../sop/knowledge/index.mjs';
import {tokens, ngrams, STOCK_PHRASE_DF} from '../datasets/no-copy.mjs';
import {numbersOf} from '../eval/books/extract.mjs';

/** Wire types whose truth the mining may add (declarations are support, never knowledge on their own). */
export const KNOWLEDGE_TYPES = Object.freeze(['fact', 'rule', 'default', 'integrity', 'aggregate']);
/** Wire types that take a `source` field (a predicate declaration has none: its provenance is a comment line above it). */
export const SOURCED_TYPES = Object.freeze(['fact', 'rule', 'default', 'integrity', 'aggregate', 'entity', 'lexeme', 'norm']);
const META = new Set(['source', 'label', 'description', 'alias', 'note', 'quote']);

const fieldLines = (fields, out = []) => {
  for (const f of fields) { if (!META.has(f.key)) out.push(`${f.key} ${f.value}`); if (f.block?.length) fieldLines(f.block, out); }
  return out;
};

/** Canonical key of a wire: its type and its non-metadata lines with variables renamed in order of appearance; `when` lines sorted. */
export function canonicalKey(wire) {
  const names = new Map();
  const lines = fieldLines(wire.fields).map(l => l.replace(/\?[A-Za-z_][\w]*/g, v => { if (!names.has(v)) names.set(v, `?v${names.size}`); return names.get(v); }));
  const whens = lines.filter(l => l.startsWith('when ')).sort();
  return `${wire.type}|${[...whens, ...lines.filter(l => !l.startsWith('when '))].join('|')}`;
}

/** Splits a `holds` value into terms: whitespace-separated, JSON-quoted text kept whole. */
export function terms(value) {
  return [...String(value).matchAll(/"(?:[^"\\]|\\.)*"|\S+/g)].map(m => m[0]);
}

const isNumber = t => /^-?\d+(\.\d+)?$/.test(t);

/**
 * The index of a memory's circuits: canonical keys of its knowledge wires, positive and negated fact atoms, the numeric values of
 * fact atoms by their other terms (a contradiction is the same atom with another number), the declared ids, and entity labels.
 */
export function memoryIndex(circuits) {
  const index = {keys: new Set(), atoms: new Set(), negated: new Set(), numeric: new Map(), ids: new Set(), predicates: new Set(), labels: new Map()};
  for (const c of circuits) addToIndex(index, c.text);
  return index;
}

export function addToIndex(index, text) {
  for (const w of parse(text).wires) {
    index.ids.add(w.id);
    if (w.type === 'predicate') index.predicates.add(w.id);
    if (w.type === 'entity') for (const f of w.fields) if ((f.key === 'label' || f.key === 'alias') && /^en\s/.test(f.value)) {
      const label = JSON.parse(f.value.replace(/^en\s+/, '')).toLowerCase();
      if (!index.labels.has(label)) index.labels.set(label, w.id);
    }
    if (!KNOWLEDGE_TYPES.includes(w.type)) continue;
    index.keys.add(canonicalKey(w));
    if (w.type !== 'fact') continue;
    for (const f of w.fields) if (f.key === 'holds') {
      const t = terms(f.value);
      const negated = t[0] === 'not';
      const atom = (negated ? t.slice(1) : t).join(' ');
      (negated ? index.negated : index.atoms).add(atom);
      const body = negated ? t.slice(1) : t;
      if (!negated && body.length >= 3 && isNumber(body.at(-1))) {
        const key = body.slice(0, -1).join(' ');
        (index.numeric.get(key) ?? index.numeric.set(key, new Set()).get(key)).add(Number(body.at(-1)));
      }
    }
  }
  return index;
}

/** Duplicate and contradiction of one candidate wire against the memory index: `{duplicate, conflicts: [string]}`. */
export function againstMemory(wire, index) {
  const conflicts = [];
  const duplicate = KNOWLEDGE_TYPES.includes(wire.type) && index.keys.has(canonicalKey(wire));
  if (wire.type === 'fact') for (const f of wire.fields) if (f.key === 'holds') {
    const t = terms(f.value);
    const negated = t[0] === 'not';
    const body = negated ? t.slice(1) : t;
    const atom = body.join(' ');
    if (negated && index.atoms.has(atom)) conflicts.push(`the memory holds ${atom}; the candidate denies it`);
    if (!negated && index.negated.has(atom)) conflicts.push(`the memory denies ${atom}; the candidate asserts it`);
    if (!negated && body.length >= 3 && isNumber(body.at(-1))) {
      const known = index.numeric.get(body.slice(0, -1).join(' '));
      if (known && !known.has(Number(body.at(-1)))) conflicts.push(`the memory holds ${body.slice(0, -1).join(' ')} ${[...known].join(' or ')}; the candidate says ${body.at(-1)}`);
    }
  }
  return {duplicate, conflicts};
}

/**
 * The problem's own names: capitalised tokens of the problem that are not the first word of a sentence and are not an English label of
 * the general vocabulary (core and common-sense layers). They name the problem's people, places and plans, never general knowledge.
 */
export function problemNames(question, labels) {
  const out = new Set();
  for (const sentence of String(question).split(/(?<=[.!?:;\n])\s+/)) {
    const words = sentence.match(/[\p{L}][\p{L}'-]*/gu) ?? [];
    words.slice(1).forEach(w => { if (/^\p{Lu}/u.test(w) && w.length > 1 && !labels.has(w.toLowerCase())) out.add(w); });
  }
  return [...out];
}

/** The problem's names and numbers that occur in a candidate wire (its text without the source line). */
export function problemOverlap(wire, {names, numbers}) {
  const text = wireText(wire).split('\n').filter(l => !/^\s*source\s/.test(l)).join('\n');
  const words = new Set(text.toLowerCase().split(/[^\p{L}']+/u));
  const usedNames = names.filter(n => words.has(n.toLowerCase()));
  const own = new Set(numbersOf(text));
  const usedNumbers = numbers.filter(n => own.has(n));
  return {names: usedNames, numbers: [...new Set(usedNumbers)]};
}

/**
 * The n-gram index of the books for the copy check: 8-grams of every item text, and the document frequency of 4-grams (a 4-gram found in
 * at least STOCK_PHRASE_DF items is a stock phrase, as in tools/datasets/no-copy.mjs).
 */
export function booksGramIndex(items) {
  const eight = new Set(), df = new Map();
  for (const it of items) {
    const words = tokens([it.question, it.answer, it.solution].filter(Boolean).join('\n'));
    for (const g of ngrams(words, 8)) eight.add(g);
    for (const g of ngrams(words, 4)) df.set(g, (df.get(g) ?? 0) + 1);
  }
  return {eight, df};
}

/** Copied book text in a wire: shared 8-grams with any book item, and distinctive 4-grams shared with its own problem. */
export function copyFindings(wire, problemText, books) {
  const words = tokens(wireText(wire).split('\n').filter(l => !/^\s*source\s/.test(l)).join('\n'));
  const long = [...ngrams(words, 8)].filter(g => books.eight.has(g)).length;
  const own = ngrams(tokens(problemText), 4);
  const distinctive = [...ngrams(words, 4)].filter(g => own.has(g) && (books.df.get(g) ?? 0) < STOCK_PHRASE_DF).length;
  return {long_spans: long, distinctive_4grams: distinctive, copied: long > 0 || distinctive > 0};
}

/** The provenance line of an admitted wire: book, problem, model, reviewer, date; never book text. */
export function provenance({book, problem, model, reviewer, date}) {
  return `mined for commonsense-books-v1 (tools/knowledge-mining): book ${book}, problem ${problem}, proposed by ${model}, reviewed by ${reviewer}, ${date}; general knowledge, no book text`;
}

/** The wire with its `source` replaced by the provenance (a predicate gets a comment line instead). */
export function stamp(wire, prov) {
  if (!SOURCED_TYPES.includes(wire.type)) return `# provenance @${wire.id}: ${prov}\n${wireText(wire)}`;
  const fields = wire.fields.filter(f => f.key !== 'source');
  return wireText({...wire, fields: [...fields, {key: 'source', value: JSON.stringify(prov), block: []}]});
}

/** Renames knowledge-wire ids (never referenced by other wires) to a prefix unique to their problem, so groups never collide. */
export function uniqueIds(wires, prefix) {
  return wires.map(w => (KNOWLEDGE_TYPES.includes(w.type) ? {...w, id: `${prefix}_${w.id.replace(/^kmb_/, '')}`.slice(0, 80)} : w));
}

/**
 * Rewrites references to a candidate entity whose English label is already an entity of the memory to that existing entity, and drops
 * the duplicate declaration (common sense never declares a second "week"). Returns `{wires, merged: [[candidate, existing]]}`.
 */
export function mergeKnownEntities(wires, labels) {
  const map = new Map();
  for (const w of wires) if (w.type === 'entity') {
    const label = w.fields.find(f => f.key === 'label' && /^en\s/.test(f.value));
    if (!label) continue;
    const existing = labels.get(JSON.parse(label.value.replace(/^en\s+/, '')).toLowerCase());
    if (existing && existing !== w.id) map.set(w.id, existing);
  }
  if (!map.size) return {wires, merged: []};
  const swap = value => terms(value).map(t => map.get(t) ?? t).join(' ');
  const rewrite = fields => fields.map(f => ({...f, value: META.has(f.key) ? f.value : swap(f.value), block: rewrite(f.block ?? [])}));
  return {wires: wires.filter(w => !map.has(w.id)).map(w => ({...w, fields: rewrite(w.fields)})), merged: [...map]};
}

/**
 * Constants of a fact that no declaration names: neither an id of the memory or of the candidate set, nor a number or quoted text. A
 * general fact is about classes, units and kinds the vocabulary declares; an undeclared constant is an entity of the problem's story.
 */
export function undeclaredConstants(wire, ids) {
  if (wire.type !== 'fact') return [];
  const out = [];
  for (const f of wire.fields) if (f.key === 'holds') {
    const t = terms(f.value);
    const args = (t[0] === 'not' ? t.slice(2) : t.slice(1));
    for (const a of args) if (!a.startsWith('"') && !/^-?\d/.test(a) && !a.startsWith('?') && !ids.has(a)) out.push(a);
  }
  return out;
}

/** Drops the declarations (predicates, lexemes, entities) that no kept knowledge wire uses, directly or through a lexeme's predicate. */
export function pruneDeclarations(wires) {
  const used = new Set();
  for (const w of wires) if (KNOWLEDGE_TYPES.includes(w.type)) for (const l of fieldLines(w.fields)) for (const t of l.split(/\s+/)) used.add(t);
  return wires.filter(w => {
    if (KNOWLEDGE_TYPES.includes(w.type)) return true;
    if (w.type === 'lexeme') { const of = w.fields.find(f => f.key === 'of'); return of ? used.has(of.value.trim()) : false; }
    return used.has(w.id);
  });
}
