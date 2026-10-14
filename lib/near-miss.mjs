/**
 * Near misses for a turn that found no answer ("never a dry refusal"): the entities of ONE memory closest to a name the memory does not
 * know, and the relations the memory holds around each of them, as structured data for the renderer (the phrasing lives in SOP data).
 *
 *   fuzzyEntities(name, lexicon, {max})   the closest entities to a name: exact, accent-folded, doubled-letter-squeezed, then
 *                                         Damerau-Levenshtein (optimal string alignment) within a length-relative threshold, over the
 *                                         full labels and aliases and over the single tokens of multi-word ones
 *   linkFuzzy(name, lexicon, {max})       the same as a link result: {status: bound|ambiguous|unknown, id, distance, candidates}
 *   nearMiss({text, mentions, lexicon, repo, session, circuits, max})
 *                                         the candidates for the given mentions (or, without mentions, for the name-like spans of the
 *                                         message that the memory's own name index matches) with their description and relations
 *
 * An algorithm over the memory's data only: Unicode folding (NFKD, marks stripped, case folded), punctuation and spaces normalised,
 * doubled letters collapsed, an edit distance; no word list and no per-language table. The fuzzy index is built once per lexicon.
 */
import {normalize, fold, phraseKey} from '../sop/text-keys.mjs';
import {parse, tokens as wireTokens} from '../sop/knowledge/lexical.mjs';

/** Edit budget by length of the squeezed name: none below 4 letters, 1 up to 5, 2 up to 10, 3 above. */
export const editBudget = length => (length < 4 ? 0 : length <= 5 ? 1 : length <= 10 ? 2 : 3);
/** Single tokens of a multi-word label shorter than this are not indexed (they cannot carry an edit budget). */
const MIN_TOKEN = 4;
const BAG = 32;

/** The comparison key of a name: NFKD-folded, case-folded, punctuation as spaces, doubled letters collapsed. */
export const nameKey = text => plainKey(text).replace(/(\p{L})\1+/gu, '$1');
/** The same key before doubled letters are collapsed: the distance reported is measured on it. */
const plainKey = text => normalize(String(text).normalize('NFKD')).normalize('NFD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Damerau-Levenshtein distance (optimal string alignment) of two code-point arrays, or Infinity when it exceeds `max`. */
export function editDistance(a, b, max = Infinity) {
  if (Math.abs(a.length - b.length) > max) return Infinity;
  if (!a.length || !b.length) return Math.max(a.length, b.length) <= max ? Math.max(a.length, b.length) : Infinity;
  let prev2 = null, prev = Array.from({length: b.length + 1}, (_, j) => j), cur = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let low = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < low) low = v;
    }
    if (low > max) return Infinity;
    [prev2, prev, cur] = [prev, cur, prev2 ?? new Array(b.length + 1)];
  }
  return prev[b.length] <= max ? prev[b.length] : Infinity;
}

const bagOf = chars => { const bag = new Uint8Array(BAG); for (const c of chars) { const i = c.codePointAt(0) % BAG; if (bag[i] < 255) bag[i]++; } return bag; };
// Each edit changes the letter multiset by at most 2 (a substitution removes one and adds one): half the L1 bag distance bounds the edit distance from below.
const bagGap = (x, y) => { let d = 0; for (let i = 0; i < BAG; i++) d += x[i] > y[i] ? x[i] - y[i] : y[i] - x[i]; return d; };

const bigrams = chars => { const padded = ['\u0002', ...chars, '\u0003'], out = new Set(); for (let i = 0; i + 1 < padded.length; i++) out.add(padded[i] + padded[i + 1]); return out; };

const indexes = new WeakMap();
/**
 * The fuzzy name index of a lexicon, built once: the squeezed keys of every entity surface (and of the long words of multi-word ones), with
 * a bigram inverted index for candidate generation, a letter bag per key for a cheap lower bound, and the hits (entry index, word flag).
 */
function fuzzyIndex(lexicon) {
  let index = indexes.get(lexicon);
  if (index) return index;
  const keys = new Map(), recs = [], postings = new Map();
  const put = (key, ix, token) => {
    let rec = keys.get(key);
    if (!rec) {
      const chars = Array.from(key);
      rec = {n: recs.length, key, chars, bag: bagOf(chars), hits: []};
      keys.set(key, rec);
      recs.push(rec);
      for (const g of bigrams(chars)) (postings.get(g) ?? postings.set(g, []).get(g)).push(rec.n);
    }
    rec.hits.push(ix * 2 + (token ? 1 : 0));
  };
  lexicon.entries.forEach((entry, ix) => {
    if (entry.kind !== 'entity' || lexicon.isClass?.(entry.id)) return;
    // The id is a name only for an entity without a label or alias.
    if (entry.language === 'und' && entry.surface === entry.id && lexicon.entities[entry.id]?.aliases?.length) return;
    const key = nameKey(entry.surface);
    if (!key) return;
    put(key, ix, false);
    const parts = key.split(' ');
    if (parts.length > 1) for (const part of new Set(parts)) if (Array.from(part).length >= MIN_TOKEN) put(part, ix, true);
  });
  index = {keys, recs, postings: new Map([...postings].map(([g, list]) => [g, Int32Array.from(list)])), counts: new Int32Array(recs.length)};
  indexes.set(lexicon, index);
  return index;
}

/**
 * The keys within `budget` edits of the query: candidates share at least |bigrams(query)| - 3 * budget distinct bigrams with it (an edit,
 * a transposition included, touches at most three bigrams), pass the letter-bag bound, then the bounded edit distance decides.
 */
function nearKeys(index, chars, budget) {
  const {recs, postings, counts} = index, grams = bigrams(chars), need = Math.max(1, grams.size - 3 * budget), touched = [], bag = bagOf(chars), out = [];
  for (const g of grams) for (const n of postings.get(g) ?? []) { if (counts[n]++ === 0) touched.push(n); }
  for (const n of touched) {
    const count = counts[n];
    counts[n] = 0;
    if (count < need) continue;
    const rec = recs[n];
    if (Math.abs(rec.chars.length - chars.length) > budget || bagGap(bag, rec.bag) > 2 * budget) continue;
    const d = editDistance(chars, rec.chars, budget);
    if (d !== Infinity) out.push([rec, d]);
  }
  return out;
}

const MATCH_RANK = {exact: 0, folded: 1, squeezed: 2, edit: 3};
function matchKind(name, surface, distance) {
  if (normalize(name) === normalize(surface)) return 'exact';
  if (fold(name) === fold(surface)) return 'folded';
  return distance === 0 ? 'squeezed' : 'edit';
}

/**
 * The closest entities of the lexicon to `name`, best first: `[{id, label, class, description, notability, distance, matched, surface,
 * word, token, derived}]`. `matched` is exact | folded | squeezed | edit; `token` marks a match on `word`, one word of a multi-word
 * label or alias. `distance` is the edit distance of the folded forms (doubled letters kept; a doubled-letter-only difference still admits
 * a candidate). Order: distance, a full label before a word of one (or a derived name part), match kind, notability, label.
 * `exact: true` skips the edit-distance search (folded and squeezed equality only).
 */
export function fuzzyEntities(name, lexicon, {max = 3, exact: exactOnly = false} = {}) {
  if (!lexicon?.entries || typeof name !== 'string') return [];
  const query = nameKey(name);
  if (!query) return [];
  const index = fuzzyIndex(lexicon);
  const chars = Array.from(query), budget = editBudget(chars.length), single = !query.includes(' ');
  const exact = index.keys.get(query);
  const found = budget === 0 || exactOnly ? (exact ? [[exact, 0]] : []) : nearKeys(index, chars, budget);
  const plain = Array.from(plainKey(name)), best = new Map();
  for (const [rec, squeezed] of found) for (const hit of rec.hits) {
    const token = (hit & 1) === 1;
    if (token && (!single || chars.length < MIN_TOKEN)) continue;
    const entry = lexicon.entries[hit >> 1], entity = lexicon.entities[entry.id];
    if (!entity) continue;
    const word = token ? (entry.surface.split(/[^\p{L}\p{N}]+/u).find(w => nameKey(w) === rec.key) ?? entry.surface) : entry.surface;
    const measured = editDistance(plain, Array.from(plainKey(word)), budget), distance = measured === Infinity ? Math.max(1, budget) : measured;
    const matched = matchKind(name, word, squeezed);
    const partial = token || Boolean(entry.derived);
    const sort = [distance, partial ? 1 : 0, MATCH_RANK[matched]];
    const prev = best.get(entity.id);
    if (prev && !(sort[0] < prev.sort[0] || (sort[0] === prev.sort[0] && (sort[1] < prev.sort[1] || (sort[1] === prev.sort[1] && sort[2] < prev.sort[2]))))) continue;
    best.set(entity.id, {sort, id: entity.id, label: entity.labels?.en ?? Object.values(entity.labels ?? {})[0] ?? entity.id, class: entity.entityType ?? null,
      description: entity.description ?? null, notability: entity.notability ?? null, distance, matched, surface: entry.surface, ...(token ? {word} : {}), token, derived: entry.derived ?? null});
  }
  return [...best.values()].sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1] || a.sort[2] - b.sort[2]
    || (b.notability ?? 0) - (a.notability ?? 0) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
    .slice(0, max).map(({sort, ...rest}) => rest);
}

/**
 * A fallback link for a name that exact linking did not find: `{status, id, distance, matched, candidates}`. `bound` when one entity is
 * strictly best (closer, or a full label against only words of labels); `ambiguous` when several tie; `unknown` when nothing is near.
 */
export function linkFuzzy(name, lexicon, {max = 3} = {}) {
  const candidates = fuzzyEntities(name, lexicon, {max: Math.max(2, max)});
  if (!candidates.length) return {status: 'unknown', id: null, distance: null, matched: null, candidates: []};
  const [first, second] = candidates, partial = c => c.token || Boolean(c.derived);
  const unique = !second || second.distance > first.distance || (!partial(first) && partial(second));
  const shown = candidates.slice(0, max).map(({id, label, class: cls, distance, matched}) => ({id, label, class: cls, distance, matched}));
  return unique ? {status: 'bound', id: first.id, distance: first.distance, matched: first.matched, candidates: shown}
    : {status: 'ambiguous', id: null, distance: first.distance, matched: first.matched, candidates: shown};
}

// ---- name-like spans of a message -------------------------------------------------------------------------------------------------

const shape = word => (/\p{L}/u.test(word) && word.length > 1 && word === word.toUpperCase() && word !== word.toLowerCase() ? 'upper'
  : /^\p{Lu}/u.test(word) ? 'capital' : 'lower');

/**
 * Does the casing of the message's span agree with the casing the memory gives the matched surface (or word)? In a message without casing
 * (all lower or all upper case) only an all-capitals surface written otherwise disagrees.
 */
function caseAgrees(words, candidate, initial, cased) {
  const theirs = (candidate.word ?? candidate.surface).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const pairs = words.length === theirs.length ? words.map((w, i) => [w, theirs[i]]) : [[words[0], theirs[0] ?? '']];
  return pairs.every(([mine, other], i) => {
    const a = shape(mine), b = shape(other);
    if (!cased) return b !== 'upper' || a === 'upper';
    return a === b || (i === 0 && initial && a === 'capital' && b === 'lower');
  });
}

/** Is a span a relation word of the memory (a predicate's label, alias or lexeme form)? Such a span is never a fuzzy name. */
const relationWord = (lexicon, surface) => (lexicon.folded?.get(fold(surface)) ?? []).some(i => lexicon.entries[i].kind === 'predicate') || lexicon.formsByKey?.has(phraseKey(surface));

/**
 * The name-like spans of a message, by structure: the maximal runs of words the memory's own name index matches exactly or fuzzily, the
 * longest first and without overlap. A span that is a relation word of the memory is matched exactly only. Spans whose casing disagrees
 * with the memory's surfaces are dropped when another span agrees, and spans matched only through a word of a longer label or a name part
 * are dropped when another span matches a full label. In a cased message only spans with a capitalised word that does not start a sentence
 * are names ("What do you know?" has none).
 */
export function nameSpans(text, lexicon, {maxWords = 5, max = 4} = {}) {
  const message = String(text ?? '');
  const words = [], starts = [];
  for (const m of message.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu)) { const w = m[0].replace(/[.'’-]+$/u, ''); words.push(w); starts.push(m.index); }
  const initialAt = i => i === 0 || /[.?!:;]\s*$/.test(message.slice(0, starts[i]));
  const taken = new Array(words.length).fill(false), spans = [];
  const cased = message !== message.toLowerCase() && message !== message.toUpperCase();
  for (let n = Math.min(maxWords, words.length); n >= 1; n--) {
    for (let i = 0; i + n <= words.length; i++) {
      if (taken.slice(i, i + n).some(Boolean)) continue;
      const gram = words.slice(i, i + n), surface = gram.join(' ');
      const relation = relationWord(lexicon, surface) || relationWord(lexicon, gram[0]) || relationWord(lexicon, gram.at(-1));
      const candidates = fuzzyEntities(surface, lexicon, {max: 8, exact: relation});
      if (!candidates.length) continue;
      const initial = initialAt(i);
      const agreeing = candidates.filter(c => caseAgrees(gram, c, initial, cased));
      // A span whose casing disagrees with every candidate ("is Socrates" read as "Isocrates"; "me" read as the abbreviation "ME") is not
      // a name: its words stay free for a shorter span.
      if (!agreeing.length) continue;
      for (let j = i; j < i + n; j++) taken[j] = true;
      const list = agreeing.length ? agreeing : candidates;
      // In a cased message a name is written with a capital letter somewhere other than at the start of a sentence (structure, not words).
      const capitalised = gram.some((w, k) => /^\p{Lu}/u.test(w) && !(k === 0 && initial));
      spans.push({surface, at: i, initial, capitalised, caseAgrees: agreeing.length > 0, distance: list[0].distance, full: list.some(c => !c.token && !c.derived), candidates: list});
    }
  }
  // Without casing a span is a name only when it matches a whole label or alias ("something" is not "There's Something About Mary").
  let kept = cased ? spans.filter(s => s.capitalised) : spans.filter(s => s.full);
  kept = kept.some(s => s.caseAgrees) ? kept.filter(s => s.caseAgrees) : kept;
  if (kept.some(s => s.full)) kept = kept.filter(s => s.full);
  return kept.sort((a, b) => Number(b.caseAgrees) - Number(a.caseAgrees) || a.distance - b.distance || b.surface.length - a.surface.length || a.at - b.at).slice(0, max);
}

// ---- relations around an entity ---------------------------------------------------------------------------------------------------

const factIndexes = new WeakMap();
/** Entity -> [{p, position, atom}] over the fact wires of a circuits array (the development path without a repository). */
function circuitFacts(circuits) {
  let index = factIndexes.get(circuits);
  if (index) return index;
  index = new Map();
  for (const c of circuits) for (const w of parse(c.text).wires) {
    if (w.type !== 'fact') continue;
    const parts = wireTokens(w.fields.find(f => f.key === 'holds')?.value ?? '');
    const neg = parts[0] === 'not', p = parts[neg ? 1 : 0], args = parts.slice(neg ? 2 : 1);
    if (!p || neg) continue;
    args.forEach((a, position) => { if (!a.startsWith('"')) (index.get(a) ?? index.set(a, []).get(a)).push({p, position, args}); });
  }
  factIndexes.set(circuits, index);
  return index;
}

const roleName = (predicate, position) => predicate?.roles?.[position]?.name ?? ['subject', 'object'][position] ?? `arg${position + 1}`;

/**
 * The relations the memory holds around an entity: `[{predicate, label, roles, facts, complete, examples}]`, most facts first. With a
 * repository, one bounded keyed recall per (predicate with facts, argument position); otherwise the fact wires of `circuits`.
 */
export function entityRelations(id, {lexicon, repo = null, session = null, circuits = null, perLookup = 50, maxLookups = 1200, maxRelations = 12, examples = 2} = {}) {
  const schemas = lexicon?.predicates ?? {};
  const out = new Map();
  const add = (p, position, args, complete = true) => {
    let rel = out.get(p);
    if (!rel) out.set(p, rel = {predicate: p, label: schemas[p]?.labels?.en ?? p, roles: [], facts: 0, complete: true, examples: []});
    const role = roleName(schemas[p], position);
    if (!rel.roles.includes(role)) rel.roles.push(role);
    rel.facts++;
    rel.complete &&= complete;
    if (rel.examples.length < examples) rel.examples.push(args);
  };
  let lookups = 0, truncated = false;
  if (repo && session) {
    // The compiled lexicon counts the facts of each predicate (kept when a cached lexicon is revived): only those predicates are probed.
    const all = Object.values(schemas), counted = all.filter(p => p.factCount > 0), known = counted.length ? counted : all;
    outer: for (const schema of known) {
      const arity = schema.arity || schema.roles?.length || 0;
      if (!arity || arity > 4) continue;
      for (let i = 0; i < arity; i++) {
        if (lookups >= maxLookups) { truncated = true; break outer; }
        lookups++;
        const pattern = {p: schema.id, a: Array.from({length: arity}, (_, j) => (j === i ? id : `?v${j}`)), neg: false};
        const result = repo.recall(session, pattern, {asof: Infinity}, {limit: perLookup, maxProbes: perLookup * 40});
        for (const row of result.rows) add(schema.id, i, row.atom.a, result.complete);
      }
    }
  } else if (circuits?.length) {
    for (const {p, position, args} of circuitFacts(circuits).get(id) ?? []) add(p, position, args.map(a => (a.startsWith('"') ? JSON.parse(a) : a)));
  }
  const relations = [...out.values()].sort((a, b) => b.facts - a.facts || a.predicate.localeCompare(b.predicate));
  return {relations: relations.slice(0, maxRelations), total: relations.length, lookups, truncated};
}

/** The `describe` facts of an entity (predicates whose `reading describe` the memory declares), by the memory's describe rank. */
const describeFacts = (relations, lexicon) => relations
  .filter(r => lexicon.predicates?.[r.predicate]?.readings?.includes('describe'))
  .sort((a, b) => (lexicon.predicates[a.predicate].describeRank ?? 99) - (lexicon.predicates[b.predicate].describeRank ?? 99))
  .map(r => ({predicate: r.predicate, examples: r.examples}));

/**
 * The near misses of a turn without an answer: `{candidates, mentions}`. `mentions` are the strings the linker could not resolve; without
 * them, the name-like spans of `text` (`nameSpans`). Each candidate: `{id, label, class, description, notability, distance, matched,
 * surface, token, mention, relations: [{predicate, label, roles, facts, complete, examples}], describe, relationsTotal}`.
 */
export function nearMiss({text = '', mentions = [], lexicon, repo = null, session = null, circuits = null, max = 3, maxMentions = 4, maxRelations = 12} = {}) {
  if (!lexicon) return {candidates: [], mentions: []};
  const given = (mentions ?? []).map(m => (typeof m === 'string' ? m : m?.surface ?? m?.text)).filter(s => typeof s === 'string' && s.trim());
  const spans = given.length
    ? given.slice(0, maxMentions).map(surface => ({surface, source: 'given', candidates: fuzzyEntities(surface, lexicon, {max})}))
    : nameSpans(text, lexicon, {max: maxMentions}).map(s => ({surface: s.surface, source: 'text', at: s.at, caseAgrees: s.caseAgrees, candidates: s.candidates.slice(0, max)}));
  const candidates = [], seen = new Set();
  for (const span of spans) for (const c of span.candidates) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const {relations, total, truncated} = entityRelations(c.id, {lexicon, repo, session, circuits, maxRelations});
    candidates.push({...c, mention: span.surface, relations, relationsTotal: total, ...(truncated ? {relationsTruncated: true} : {}), describe: describeFacts(relations, lexicon)});
  }
  return {candidates, mentions: spans.map(({candidates: list, ...span}) => ({...span, candidates: list.map(c => c.id)}))};
}
