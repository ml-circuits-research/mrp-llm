/**
 * Retrieval for the query author (DS022 "codingAgentQuery: vocabulary"): instead of dumping the memory's vocabulary, select the few
 * predicates a message can mean and the few entities its names can denote, from the lexicon of ONE base memory. Language data and the
 * memory's own forms only; no predicate or entity name is written here.
 *
 *   candidatePredicates(message, lexicon, {k})  ranked predicates: forms (lexeme forms incl. converse frames, labels, aliases), id tokens and
 *                                                glosses scored by IDF-weighted token match plus a phrase bonus, plus a fixed core set
 *   entityHints(message, lexicon, {perMention})  per name mention of the message: 2-3 candidate entities (id, label, class, description,
 *                                                notability) found in the lexicon by exact and accent-folded surface
 *
 * The retrieval is reported with every parse (`retrieval`), and `predicateRecall(retrieved, goldIds)` measures how often the gold predicate
 * was in the set.
 */
import {fold, phraseKey} from '../../sop/text-keys.mjs';

/** Predicates that most questions about the world need whatever the message says (instance of, location, occupation, descriptions). */
export const CORE_PREDICATES = Object.freeze(['is_a', 'located_in', 'part_of', 'has_occupation', 'has_property', 'description']);

const STOP = new Set(['a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'has', 'have', 'had', 'of', 'in', 'on', 'at', 'to', 'by', 'for', 'with', 'from', 'and', 'or', 'not', 'no',
  'what', 'which', 'who', 'whom', 'whose', 'where', 'when', 'why', 'how', 'many', 'much', 'that', 'this', 'these', 'those', 'it', 'its', 'there', 'than', 'then', 'as', 'about', 'also', 'any', 'all', 'me', 'i', 'you', 'we', 'they', 'he', 'she',
  'tell', 'give', 'list', 'name', 'please', 'can', 'could', 'would', 'will', 'shall', 'should', 'may', 'might', 'most', 'some']);
// English irregular forms that suffix stripping cannot reach (language data).
const IRREGULAR = Object.freeze({wrote: 'write', written: 'write', born: 'bear', bore: 'bear', died: 'die', began: 'begin', begun: 'begin', won: 'win', led: 'lead', held: 'hold', built: 'build', made: 'make', took: 'take', taken: 'take', gave: 'give',
  given: 'give', sold: 'sell', bought: 'buy', paid: 'pay', ran: 'run', went: 'go', gone: 'go', came: 'come', saw: 'see', seen: 'see', knew: 'know', known: 'know', founded: 'found', taught: 'teach', thought: 'think', brought: 'bring',
  sang: 'sing', sung: 'sing', spoke: 'speak', spoken: 'speak', met: 'meet', left: 'leave', lost: 'lose', chose: 'choose', chosen: 'choose', fell: 'fall', grew: 'grow', grown: 'grow', drew: 'draw', drawn: 'draw', flew: 'fly', children: 'child',
  people: 'person', men: 'man', women: 'woman', older: 'old', oldest: 'old', younger: 'young', youngest: 'young', bigger: 'big', biggest: 'big', larger: 'large', largest: 'large', higher: 'high', highest: 'high', longer: 'long', longest: 'long'});

/** Light, deterministic stem: irregular table, then ies/ing/ed/es/s/e stripped, a doubled final consonant undoubled. */
export function stem(raw) {
  let t = fold(raw);
  if (IRREGULAR[t]) t = IRREGULAR[t];
  if (t.length <= 3) return t;
  if (/ies$/.test(t)) return t.slice(0, -3) + 'y';
  for (const suffix of ['ing', 'ed', 'es', 's', 'e']) {
    if (t.endsWith(suffix) && t.length - suffix.length >= 3) { t = t.slice(0, -suffix.length); break; }
  }
  return /([^aeiou])\1$/.test(t) ? t.slice(0, -1) : t;
}
const words = text => fold(String(text).replaceAll('_', ' ')).match(/[\p{L}\p{N}]+/gu) ?? [];
const contentStems = text => words(text).filter(w => !STOP.has(w)).map(stem);

const indexes = new WeakMap();
function indexOf(lexicon) {
  if (indexes.has(lexicon)) return indexes.get(lexicon);
  const docs = [];
  const df = new Map();
  for (const p of Object.values(lexicon?.predicates ?? {})) {
    const weight = new Map();
    const add = (text, w) => { for (const s of contentStems(text)) weight.set(s, Math.max(weight.get(s) ?? 0, w)); };
    add(p.id, 1.5);
    for (const a of p.aliases ?? []) add(a.surface, 2);
    for (const l of p.lexemes ?? []) for (const f of l.forms) add(f, 2);
    for (const label of Object.values(p.labels ?? {})) add(label, 2);
    add(p.description ?? '', 0.6);
    for (const roleType of (p.roles ?? []).map(r => r.type)) add(roleType ?? '', 0.4);
    for (const s of weight.keys()) df.set(s, (df.get(s) ?? 0) + 1);
    docs.push({id: p.id, weight, size: weight.size});
  }
  const index = {docs, df, n: Math.max(1, docs.length)};
  indexes.set(lexicon, index);
  return index;
}

const ngrams = (parts, max) => { const out = []; for (let n = Math.min(max, parts.length); n >= 1; n--) for (let i = 0; i + n <= parts.length; i++) out.push(parts.slice(i, i + n)); return out; };

/** `[{id, score, why}]`, best first: at most `k` predicates by message match, then the core set (appended when the memory declares them). */
export function candidatePredicates(message, lexicon, {k = 24, core = CORE_PREDICATES} = {}) {
  const {docs, df, n} = indexOf(lexicon);
  const query = [...new Set(contentStems(message))];
  const parts = words(message);
  const phrases = new Map();
  for (const gram of ngrams(parts, 4)) {
    if (gram.every(w => STOP.has(w))) continue;
    for (const id of lexicon.predicatesByKey?.get(phraseKey(gram.join(' '))) ?? []) phrases.set(id, Math.max(phrases.get(id) ?? 0, gram.length));
  }
  const scored = docs.map(doc => {
    let score = 0;
    const hits = [];
    for (const s of query) {
      const w = doc.weight.get(s);
      if (!w) continue;
      score += w * (Math.log(1 + n / (df.get(s) ?? 1)));
      hits.push(s);
    }
    if (phrases.has(doc.id)) { score += 3 * phrases.get(doc.id); hits.push('phrase'); }
    score /= 1 + 0.12 * Math.log(1 + doc.size);
    const facts = lexicon.predicates[doc.id].factCount;
    if (lexicon.factCounts?.size && !facts) score *= 0.5;
    return {id: doc.id, score: Math.round(score * 100) / 100, why: hits.join(' ')};
  }).filter(c => c.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const chosen = scored.slice(0, k);
  for (const id of core) if (lexicon.predicates?.[id] && !chosen.some(c => c.id === id)) chosen.push({id, score: 0, why: 'core'});
  return chosen;
}

/** Share of `goldIds` that are in the retrieved set (null when there is no gold). */
export function predicateRecall(retrieved, goldIds) {
  const gold = [...new Set(goldIds)];
  if (!gold.length) return null;
  const have = new Set(retrieved.map(c => c.id ?? c));
  return gold.filter(id => have.has(id)).length / gold.length;
}

/**
 * Name mentions of the message with their candidate entities. The longest n-gram wins (no overlap); a single stop word never counts; a
 * unigram that only names a class ("country") is not a mention. Up to `max` mentions and `perMention` candidates, by notability.
 */
export function entityHints(message, lexicon, {perMention = 3, max = 12, maxWords = 6, classes = false} = {}) {
  if (!lexicon?.folded) return [];
  const original = String(message).match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu) ?? [];
  const parts = original.map(w => fold(w.replace(/['’]s$/, '')));
  const taken = new Array(parts.length).fill(false);
  const mentions = [];
  // Sentence-initial: capitalisation there says nothing about a name ("Care este …", "Which …").
  const initial = i => i === 0 || /[.?!:;]$/.test(original[i - 1]) || /[.?!]\s*$/.test(String(message).slice(0, String(message).indexOf(original[i])));
  const lookup = gram => (lexicon.folded.get(fold(gram.join(' '))) ?? []).map(i => lexicon.entries[i]).filter(e => e.kind === 'entity');
  for (let n = Math.min(maxWords, parts.length); n >= 1; n--) {
    for (let i = 0; i + n <= parts.length; i++) {
      if (taken.slice(i, i + n).some(Boolean)) continue;
      const gram = parts.slice(i, i + n);
      if (gram.every(w => STOP.has(w))) continue;
      const entries = lookup(gram);
      if (!entries.length) continue;
      let ids = [...new Set(entries.map(e => e.id))];
      // A capitalised single word may also be a part of a longer name ("Newton" for "Isaac Newton"): add the entities that contain the token.
      if (n === 1 && /^\p{Lu}/u.test(original[i])) {
        const more = [...(lexicon.index?.get(gram[0]) ?? [])].map(ix => lexicon.entries[ix]).filter(e => e.kind === 'entity').map(e => e.id);
        if (more.length <= 500) ids = [...new Set([...ids, ...more])];
      }
      const entities = ids.map(id => lexicon.entities[id]).filter(Boolean);
      // A lone common noun that only names classes is not a hint in free text; `classes` keeps it (a name the model listed itself).
      if (!classes && n === 1 && entities.every(e => lexicon.isClass?.(e.id))) continue;
      for (let j = i; j < i + n; j++) taken[j] = true;
      const ranked = entities.sort((a, b) => (b.notability ?? 0) - (a.notability ?? 0) || a.id.localeCompare(b.id)).slice(0, perMention);
      mentions.push({at: i, initial: initial(i), surface: original.slice(i, i + n).join(' '), candidates: ranked.map(e => ({id: e.id, label: e.labels?.en ?? e.id, class: e.entityType ?? null, ...(e.description ? {description: e.description} : {}), ...(e.notability != null ? {notability: e.notability} : {})})), total: ids.length});
    }
  }
  // A capitalised word that matched no surface may be a part of a longer name ("Einstein" for "Albert Einstein"): the entities that contain the token.
  for (let i = 0; i < parts.length; i++) {
    if (taken[i] || STOP.has(parts[i]) || !/^\p{Lu}/u.test(original[i]) || (i === 0 && lexicon.predicatesByKey?.has(phraseKey(parts[i])))) continue;
    const ids = [...new Set([...(lexicon.index?.get(parts[i]) ?? [])].map(ix => lexicon.entries[ix]).filter(e => e.kind === 'entity').map(e => e.id))];
    if (!ids.length || ids.length > 500) continue;
    const ranked = ids.map(id => lexicon.entities[id]).filter(Boolean).sort((a, b) => (b.notability ?? 0) - (a.notability ?? 0) || a.id.localeCompare(b.id)).slice(0, perMention);
    mentions.push({at: i, initial: initial(i), surface: original[i], partial: true, candidates: ranked.map(e => ({id: e.id, label: e.labels?.en ?? e.id, class: e.entityType ?? null, ...(e.description ? {description: e.description} : {}), ...(e.notability != null ? {notability: e.notability} : {})})), total: ids.length});
  }
  return mentions.sort((a, b) => a.at - b.at).slice(0, max);
}

/** The predicates nearest to a string the model wrote where an id was expected (for the repair message). */
export function nearestPredicates(text, lexicon, k = 5) {
  return candidatePredicates(String(text), lexicon, {k, core: []}).map(c => c.id);
}
