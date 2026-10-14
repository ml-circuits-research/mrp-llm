#!/usr/bin/env node
/**
 * Builds the source-derived circuits of the common-sense layer `commonsense-v1` (config/knowledge/commonsense-v1/), mechanically:
 *   - the class hierarchy of common nouns from Princeton WordNet 3.0 (first sense, hypernym chain, Princeton licence notice kept);
 *   - part-of and substance (made-of) meronyms between the selected nouns from WordNet;
 *   - typical uses, capabilities, locations, properties and possessions from ConceptNet 5.7, only the edges whose own licence is
 *     CC BY 4.0 (dataset /d/conceptnet/4/en, the Open Mind Common Sense contributions; never the CC BY-SA DBpedia or Wiktionary edges),
 *     English to English, weight >= MIN_WEIGHT (at least two agreeing contributions).
 * The hand-written circuits of the layer (rules, integrity, defaults, units, the predicate declarations) are not touched.
 * Collisions are decided by principle: a noun whose label or alias is already a name in core-min, core-en or world-v1 is reused when
 * that entity is a class with the same head word, otherwise left out (common sense never shadows an encyclopedic name).
 * Inputs (gitignored cache): datasets_sources/wordnet-3.0/dict/, datasets_sources/commonsense/conceptnet-en-6rel.tsv,
 * datasets_sources/world-kb/circuits/. Output: config/knowledge/commonsense-v1/05NN-*.sop and
 * datasets_sources/commonsense/build-stats.json.
 *   node tools/commonsense/build.mjs [--max-nouns 3000] [--min-weight 2]
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse} from '../../sop/knowledge/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const MAX_NOUNS = Number(opt('--max-nouns', 3000));
const MIN_WEIGHT = Number(opt('--min-weight', 2));
const MAX_WIRES = 1800;
const WN = path.join(ROOT, 'datasets_sources/wordnet-3.0/dict');
const CN = path.join(ROOT, 'datasets_sources/commonsense/conceptnet-en-6rel.tsv');
const OUT = path.join(ROOT, 'config/knowledge/commonsense-v1');
const STATS = path.join(ROOT, 'datasets_sources/commonsense/build-stats.json');
/** Concrete noun files of WordNet: animal, artifact, body, food, location, object, person, plant, substance. */
const LEXFILES = new Set(['03', '05', '06', '08', '13', '15', '17', '18', '20', '27']);
/** WordNet senses mapped onto the classes of core-min / core-en (lemma, sense number). */
const ANCHORS = [['person', 1, 'person'], ['organism', 1, 'organism'], ['artifact', 1, 'artifact'], ['device', 1, 'device'], ['vehicle', 1, 'vehicle'],
  ['building', 1, 'building'], ['location', 1, 'place'], ['document', 1, 'document'], ['disease', 1, 'disease'], ['city', 1, 'city'], ['language', 1, 'language'], ['currency', 1, 'currency']];
/** Abstract WordNet tops never used as classes. */
const TOPS = new Set(['entity', 'physical_entity', 'abstraction', 'object', 'whole', 'thing', 'matter', 'group', 'unit', 'part', 'piece', 'relation', 'attribute', 'measure', 'causal_agent', 'living_thing', 'instrumentality', 'artefact', 'portion', 'component', 'item', 'stuff', 'material']);
/** Nouns that are also frequent function words or verbs of questions: as entity mentions they would match inside almost every question. */
const FUNCTION_WORDS = new Set(['can', 'will', 'may', 'might', 'must', 'does', 'have', 'who', 'why', 'what', 'how', 'when', 'where', 'which', 'here', 'there', 'now', 'then', 'yes', 'all', 'any', 'some', 'back', 'well', 'right', 'left', 'more', 'most', 'less', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'hundred', 'thousand', 'million', 'first', 'last', 'way', 'kind', 'sort', 'type', 'part', 'lot', 'time', 'times', 'name', 'like', 'use', 'need', 'want', 'make', 'get', 'take', 'give', 'say', 'see', 'know', 'think', 'come', 'look', 'find', 'tell', 'ask', 'work', 'call', 'try', 'feel', 'become', 'leave', 'put', 'mean', 'keep', 'let', 'begin', 'seem', 'help', 'show', 'hear', 'play', 'run', 'move', 'live', 'believe', 'bring', 'happen', 'write', 'sit', 'stand', 'lose', 'pay', 'meet', 'include', 'continue', 'set', 'learn', 'change', 'lead', 'understand', 'watch', 'follow', 'stop', 'create', 'speak', 'read', 'spend', 'grow', 'open', 'walk', 'win', 'offer', 'remember', 'love', 'consider', 'appear', 'buy', 'wait', 'serve', 'die', 'send', 'expect', 'build', 'stay', 'fall', 'cut', 'reach', 'kill', 'remain', 'old', 'older', 'young', 'big', 'small', 'large', 'long', 'high', 'low', 'same', 'other', 'many', 'much', 'each', 'every', 'both', 'few', 'near', 'born', 'age', 'year', 'years', 'day', 'days', 'number', 'capital']);
const STOP = new Set(['a', 'an', 'the', 'your', 'his', 'her', 'their', 'its', 'my', 'our', 'some', 'one']);

// ---- WordNet ---------------------------------------------------------------------------------------------------------------------
const header = fs.readFileSync(path.join(WN, 'data.noun'), 'utf8').split('\n').filter(l => l.startsWith('  ')).map(l => l.replace(/^\s+\d+\s?/, '').trimEnd());
const synsets = new Map();
for (const line of fs.readFileSync(path.join(WN, 'data.noun'), 'utf8').split('\n')) {
  if (!line || line.startsWith('  ')) continue;
  const [data, gloss = ''] = line.split(' | ');
  const t = data.trim().split(' ');
  const off = t[0], lex = t[1], nw = parseInt(t[3], 16);
  const raw = [];
  for (let i = 0; i < nw; i++) raw.push(t[4 + 2 * i].replace(/\(.*\)$/, ''));
  const words = raw.map(w => w.toLowerCase());
  let k = 4 + 2 * nw;
  const np = parseInt(t[k], 10); k++;
  const ptr = [];
  for (let i = 0; i < np; i++, k += 4) ptr.push({sym: t[k], off: t[k + 1], pos: t[k + 2]});
  // a proper noun (a capitalized lemma) or an instance (an @i pointer: "Paris" is an instance of city) is a name, never a common noun
  const proper = /[A-Z]/.test(raw[0]) || ptr.some(p => p.sym === '@i');
  synsets.set(off, {off, lex, words, proper, hyponyms: ptr.filter(p => p.sym === '~' && p.pos === 'n').length, hyper: ptr.filter(p => p.sym === '@' && p.pos === 'n').map(p => p.off), parts: ptr.filter(p => p.sym === '%p').map(p => p.off), substances: ptr.filter(p => p.sym === '%s').map(p => p.off), gloss: gloss.trim()});
}
const senses = new Map(); // lemma -> [offsets by frequency]
for (const line of fs.readFileSync(path.join(WN, 'index.noun'), 'utf8').split('\n')) {
  if (!line || line.startsWith('  ')) continue;
  const t = line.trim().split(' ');
  const synCnt = parseInt(t[2], 10);
  senses.set(t[0], t.slice(t.length - synCnt));
}
// irregular plurals (the WNdb archive has no noun.exc; the common irregular English plurals, authored)
const plurals = new Map(Object.entries({man: 'men', woman: 'women', child: 'children', mouse: 'mice', goose: 'geese', foot: 'feet', tooth: 'teeth', person: 'people', ox: 'oxen', sheep: 'sheep', deer: 'deer', fish: 'fish', louse: 'lice', knife: 'knives', wife: 'wives', leaf: 'leaves', wolf: 'wolves', life: 'lives', calf: 'calves', half: 'halves', loaf: 'loaves', shelf: 'shelves', thief: 'thieves', potato: 'potatoes', tomato: 'tomatoes', hero: 'heroes', cactus: 'cacti', fungus: 'fungi', bus: 'buses'}));
const plural = w => plurals.get(w.replace(/ /g, '_'))?.replace(/_/g, ' ') ?? (/(s|x|z|ch|sh)$/.test(w) ? w + 'es' : /[^aeiou]y$/.test(w) ? w.slice(0, -1) + 'ies' : w + 's');
// the tagged frequency of each noun sense (index.sense: sense key, offset, sense number, tag count): WordNet orders the senses of a lemma
// by it, so senses with the same count are in no meaningful order
const tagCount = new Map(); // `${lemma}|${offset}` -> tag count
for (const line of fs.readFileSync(path.join(WN, 'index.sense'), 'utf8').split('\n')) {
  const [key, off, , count] = line.split(' ');
  if (!key || !/%1:/.test(key)) continue;
  tagCount.set(`${key.split('%')[0]}|${off}`, Number(count));
}
const firstSense = lemma => senses.get(lemma.replace(/ /g, '_'))?.[0] ?? null;

// ---- names already taken in the layers below and above (core-min, core-en, world-v1) ------------------------------------------------
const taken = new Map(); // lowercased label/alias -> [{id, kind, label (true for a label, false for an alias), notability, core}]
const takenIds = new Set();
const layerFiles = [
  ...['core-min', 'core-en'].flatMap(l => fs.readdirSync(path.join(ROOT, 'config/knowledge', l)).filter(f => f.endsWith('.sop')).map(f => path.join(ROOT, 'config/knowledge', l, f))),
  ...fs.readdirSync(path.join(ROOT, 'datasets_sources/world-kb/circuits')).filter(f => f.endsWith('.sop')).map(f => path.join(ROOT, 'datasets_sources/world-kb/circuits', f)),
];
for (const file of layerFiles) for (const w of parse(fs.readFileSync(file, 'utf8')).wires) {
  takenIds.add(w.id);
  if (w.type !== 'entity') continue;
  const get = key => w.fields.find(f => f.key === key)?.value.trim();
  const kind = get('kind') ?? 'entity', notability = Number(get('notability') ?? 0), core = !file.includes('world-kb');
  for (const f of w.fields.filter(f => f.key === 'label' || f.key === 'alias')) {
    const m = /^en\s+(".*")$/.exec(f.value.trim());
    if (!m) continue;
    try { const name = JSON.parse(m[1]).toLowerCase(); (taken.get(name) ?? taken.set(name, []).get(name)).push({id: w.id, kind, label: f.key === 'label', notability, core}); } catch { /* not a JSON string */ }
  }
}
/** Kinds of a layer entity that are the same concept as a common noun with the same head word (reused, never redeclared). */
const REUSE = new Set(['class', 'entity', 'occupation', 'element']);
/**
 * The notability of a common-noun class (DS022 KnowledgeLinker scoring: a namesake wins alone only when four times as notable as the
 * next): a basic common noun is known to every speaker, so it outranks a namesake below 100 (a film "Milk", an alias "bird" of a
 * musician) and ties with a more notable one (the company "Apple", the planet "Earth"), where the role's class or a clarification decides.
 */
const COMMON_NOUN_NOTABILITY = 400;
/** World descriptions (Wikidata, CC0) of the world-v1 entities: a reused world entity must share a content word with the WordNet sense. */
const worldInfo = JSON.parse(fs.readFileSync(path.join(ROOT, 'datasets_sources/world-kb/entities.json'), 'utf8'));
const contentWords = text => new Set(String(text).toLowerCase().split(/[^a-z]+/).filter(w => w.length > 3));
/** The content words a world description shares with a WordNet sense (its gloss and its hypernyms up to depth 3). */
function sharedWords(hit, synset) {
  const mine = contentWords(synset.gloss + ' ' + [...ancestorDepth(synset.off)].filter(([, d]) => d <= 3).map(([w]) => w).join(' '));
  return [...contentWords(worldInfo[hit.id]?.desc ?? '')].filter(w => mine.has(w) || mine.has(w.replace(/s$/, ''))).length;
}
function sameSense(hit, synset) {
  if (hit.core || !worldInfo[hit.id]?.desc) return true;
  return sharedWords(hit, synset) > 0;
}

// ---- ConceptNet (CC BY 4.0 edges only) ----------------------------------------------------------------------------------------------
const concept = uri => {
  const m = /^\/c\/en\/([^/]+)(?:\/(\w))?/.exec(uri);
  if (!m) return null;
  return {text: m[1].replace(/_/g, ' ').split(' ').filter(w => !STOP.has(w)).join(' ').trim(), pos: m[2] ?? null};
};
const edges = [];
const cnIsa = new Map(); // word -> the words ConceptNet says it is a kind of (used only to choose the WordNet sense, never copied)
/** Sexual, drug and slur vocabulary: the OMCS contributions contain jokes and insults that are not common sense. */
const OFFENSIVE = /\b(sex|sexual|homosexual|gay|lesbian|condom|penis|vagina|prostitut\w*|whore|slut|bitch|nigg\w*|fag\w*|rape\w*|porn\w*|masturbat\w*|orgasm|fuck\w*|shit|ass|asshole|cocaine|heroin|marijuana|drunk\w*|retard\w*)\b/;
let cnRead = 0;
for (const line of fs.readFileSync(CN, 'utf8').split('\n')) {
  if (!line) continue;
  cnRead++;
  const [rel, s, e, meta] = line.split('\t');
  const m = JSON.parse(meta);
  // IsA edges of any CC BY 4.0 dataset only choose the WordNet sense; the copied edges are the OMCS ones of weight >= MIN_WEIGHT
  if (m.license !== 'cc:by/4.0' || (rel !== '/r/IsA' && (m.dataset !== '/d/conceptnet/4/en' || m.weight < MIN_WEIGHT))) continue;
  const a = concept(s), b = concept(e);
  if (!a?.text || !b?.text || a.text === b.text) continue;
  if (OFFENSIVE.test(a.text) || OFFENSIVE.test(b.text)) continue;
  // WordNet's own IsA edges list every sense of a word, so they cannot choose one
  if (rel === '/r/IsA' && m.dataset.startsWith('/d/wordnet')) continue;
  if (rel === '/r/IsA') { const m2 = cnIsa.get(a.text) ?? cnIsa.set(a.text, new Map()).get(a.text); m2.set(b.text, (m2.get(b.text) ?? 0) + 1); continue; }
  edges.push({rel: rel.slice(3), a: a.text, b: b.text, bpos: b.pos, weight: m.weight, surface: m.surfaceText ?? null});
}

// ---- the selected nouns: a concrete WordNet noun (first sense) that is the subject of a kept edge, by edge count -----------------------
const anchorOf = new Map(); // offset -> core id
for (const [lemma, n, id] of ANCHORS) { const off = senses.get(lemma)?.[n - 1]; if (off) anchorOf.set(off, id); }
/**
 * The WordNet sense of a ConceptNet word, decided in this order:
 *   1. the memory already names the word as the same kind of concept (a world entity labelled with it, a class, element or occupation, with a
 *      description): the sense that shares at least DESCRIPTION_MARGIN more words with that description than any other sense ("gold" is the chemical
 *      element of world-v1, not the coins);
 *   2. the sense (in frequency order) whose hypernym closure best contains the words ConceptNet says the word is a kind of ("weasel" IsA
 *      "animal" picks the animal, not the first sense "a person regarded as treacherous");
 *   3. the most frequent sense; among senses with the same non-zero tag count (WordNet's order between them means nothing), the one with
 *      the most hyponyms, the more general concept ("hammer": the hand tool with seven kinds, not the part of a gunlock).
 */
const ancestorDepth = off => { // word -> the smallest hypernym depth it appears at (0: the synset itself)
  const out = new Map(); const q = [[off, 0]];
  while (q.length) { const [o, d] = q.shift(); const s = synsets.get(o); if (!s) continue; for (const w of s.words) { const k = w.replace(/_/g, ' '); if (!out.has(k)) out.set(k, d); } if (d < 20) q.push(...s.hyper.map(h => [h, d + 1])); }
  return out;
};
/** Words of a world description a sense must share beyond any other sense to replace the most frequent sense. */
const DESCRIPTION_MARGIN = 3;
const senseCache = new Map();
function senseOf(text) {
  if (senseCache.has(text)) return senseCache.get(text);
  const all = senses.get(text.replace(/ /g, '_')) ?? [];
  const hints = cnIsa.get(text);
  let best = all[0] ?? null, top = 0;
  const named = (taken.get(text) ?? []).filter(h => h.label && !h.core && REUSE.has(h.kind) && worldInfo[h.id]?.desc);
  if (named.length && all.length > 1) {
    // the sense sharing the most words with the description replaces the most frequent one only by a clear margin (a description shares a
    // word or two with several senses: the photographic and the television camera)
    const sharedBy = off => Math.max(...named.map(h => sharedWords(h, synsets.get(off))));
    const shared = all.map(off => ({off, n: sharedBy(off)})).sort((a, b) => b.n - a.n);
    if (shared[0].n - shared[1].n >= DESCRIPTION_MARGIN && shared[0].n - sharedBy(all[0]) >= DESCRIPTION_MARGIN) { senseCache.set(text, shared[0].off); return shared[0].off; }
  }
  if (hints && all.length > 1) {
    // a hint near the sense counts more than a far one (the flora sense of "plant" is an organism at depth 1, the stooge sense at depth 4)
    // each hint weighs by how many ConceptNet edges state it ("hammer IsA tool" from several sources outweighs one "ear bone")
    for (const off of all) { const anc = ancestorDepth(off); let score = 0; for (const [h, n] of hints) if (anc.has(h) && anc.get(h) > 0) score += n / anc.get(h); if (score > top + 1e-9) { top = score; best = off; } }
  }
  if (!top && all.length > 1) {
    const lemma = text.replace(/ /g, '_'), count = off => tagCount.get(`${lemma}|${off}`) ?? 0, most = count(all[0]);
    const tied = most > 0 ? all.filter(off => count(off) === most) : [];
    if (tied.length > 1) best = tied.reduce((a, b) => (synsets.get(b).hyponyms > synsets.get(a).hyponyms ? b : a));
  }
  senseCache.set(text, best);
  return best;
}
const nounOk = text => { const off = senseOf(text); return off && LEXFILES.has(synsets.get(off).lex) && !synsets.get(off).proper ? off : null; };
const subjectCount = new Map();
const isaWords = cnIsa.size;
for (const e of edges) if (nounOk(e.a)) subjectCount.set(e.a, (subjectCount.get(e.a) ?? 0) + 1);
const attested = new Set([...edges.flatMap(e => [e.a, e.b]), ...cnIsa.keys(), ...[...cnIsa.values()].flatMap(v => [...v.keys()])]);
const idOf = new Map(); // offset -> symbol
const declared = new Map(); // symbol -> {off, label, aliases}
const skipped = {collision: [], namesakes: [], top: 0};
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
function symbolFor(off) {
  if (idOf.has(off)) return idOf.get(off);
  if (anchorOf.has(off)) { idOf.set(off, anchorOf.get(off)); return anchorOf.get(off); }
  const s = synsets.get(off);
  const head = s.words[0].replace(/_/g, ' ');
  if (TOPS.has(s.words[0]) || s.proper || FUNCTION_WORDS.has(s.words[0]) || s.words[0].length < 3) { skipped.top++; idOf.set(off, null); return null; }
  const hits = taken.get(head) ?? [];
  // the same concept: a class, generic entity, occupation or element labelled with the head word, or an occupation of the core with it as alias
  const same = hits.find(h => ((h.label && REUSE.has(h.kind)) || (h.core && h.kind === 'occupation') || h.kind === 'element') && sameSense(h, s));
  if (same) { idOf.set(off, same.id); return same.id; }
  // a core name of another kind (a unit "foot", a property "white") stays the core's; a core class with the head word as alias ("car" of
  // vehicle) gets the finer class next to it (is_a links them); a world name becomes a namesake
  if (hits.some(h => h.core && !(h.kind === 'class' && !h.label))) { skipped.collision.push(`${head}|${hits[0].id}|${hits[0].kind}`); idOf.set(off, null); return null; }
  // a notable named entity labelled with the word keeps it alone (the planet "Earth", the country "Turkey"): a tie would turn its answers into clarifications
  if (hits.some(h => h.label && !h.core && h.notability >= 100)) { skipped.collision.push(`${head}|${hits[0].id}|${hits[0].kind}`); idOf.set(off, null); return null; }
  if (hits.length) skipped.namesakes.push(`${head}|${hits.map(h => `${h.id}:${h.kind}:${h.notability}${h.label ? '' : ':alias'}`).join(',')}`);
  let id = slug(head);
  if (!/^[a-z]/.test(id) || takenIds.has(id) || id.startsWith('x_')) id = 'cs_' + id;
  let label = head;
  if (declared.has(id) && declared.get(id).off !== off) { id = id + '_' + off; label = `${head} (${s.gloss.split(/[;(]/)[0].trim().replace(/"/g, "'").slice(0, 60)})`; }
  // another lemma of the synset is an alias only where this synset is that lemma's own sense ("metal" names the metallic element,
  // not the alloy whose synset also lists it; "machine" names the device, not the car): an alias never shares a word with a commoner sense
  const ownLemma = w => senseOf(w.replace(/_/g, ' ')) === off;
  const aliases = [...new Set([plural(head), ...s.words.slice(1).filter(ownLemma).map(w => w.replace(/_/g, ' '))].filter(a => a !== head && !taken.has(a)))];
  declared.set(id, {off, label, aliases: label === head ? aliases : [], namesake: hits.length > 0, gloss: s.gloss.split(';')[0].replace(/"/g, "'").trim()});
  idOf.set(off, id);
  return id;
}
const nouns = [...subjectCount.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, MAX_NOUNS).map(([t]) => t);
const chosen = new Set();
for (const t of nouns) { const id = symbolFor(senseOf(t)); if (id) chosen.add(senseOf(t)); }

// ---- the hierarchy: each chosen noun is_a, along each of its direct hypernyms (WordNet has multiple inheritance: an edible fruit is both
// produce and a fruit), the nearest hypernym that is an anchor or a ConceptNet-attested concrete noun ------------------------------------
const isA = new Map(); // child symbol -> Set of parent symbols
const classOff = off => anchorOf.has(off) || (!synsets.get(off).proper && attested.has(synsets.get(off).words[0].replace(/_/g, ' ')) && LEXFILES.has(synsets.get(off).lex) && !TOPS.has(synsets.get(off).words[0]));
const queue = [...chosen];
for (let i = 0; i < queue.length; i++) {
  const off = queue[i];
  const child = symbolFor(off);
  if (!child || anchorOf.has(off) || isA.has(child)) continue;
  isA.set(child, new Set());
  for (const first of synsets.get(off).hyper) {
    let cur = first, depth = 0;
    while (cur && depth < 12 && !classOff(cur)) { cur = synsets.get(cur).hyper[0]; depth++; }
    if (!cur) continue;
    const parent = symbolFor(cur);
    if (!parent || parent === child) continue;
    isA.get(child).add(parent);
    if (!chosen.has(cur)) { chosen.add(cur); queue.push(cur); }
  }
}
// the anchors themselves hang under core classes already (core-en 0001-classes); world-v1 classes too

// ---- meronyms between chosen nouns (WordNet) ---------------------------------------------------------------------------------------
const symOfOff = off => (chosen.has(off) ? idOf.get(off) : null);
const partOf = [], madeOf = [];
for (const off of chosen) {
  const whole = symOfOff(off);
  if (!whole) continue;
  for (const p of synsets.get(off).parts) { const part = symOfOff(p); if (part && part !== whole) partOf.push([part, whole, 'WordNet 3.0 part meronym']); }
  for (const p of synsets.get(off).substances) { const sub = symOfOff(p); if (sub && sub !== whole) madeOf.push([whole, sub, 'WordNet 3.0 substance meronym']); }
}

// ---- ConceptNet edges onto predicates -----------------------------------------------------------------------------------------------
const symOfText = text => { const off = senseOf(text); return off && chosen.has(off) ? idOf.get(off) : null; };
const TEXT_REL = {UsedFor: 'used_for', CapableOf: 'capable_of', HasProperty: 'typical_property'};
const ENTITY_REL = {AtLocation: 'found_at', HasA: 'typically_has', PartOf: 'part_of', MadeOf: 'made_of_material'};
const cnFacts = [];
const seenFact = new Set();
edges.sort((x, y) => y.weight - x.weight);
for (const e of edges) {
  const subj = symOfText(e.a);
  if (!subj) continue;
  let pred, obj;
  if (TEXT_REL[e.rel]) { pred = TEXT_REL[e.rel]; if (e.b.split(' ').length > 5 || !/^[a-z][a-z ' -]*$/.test(e.b)) continue; obj = JSON.stringify(e.b); }
  else if (ENTITY_REL[e.rel]) { pred = ENTITY_REL[e.rel]; obj = symOfText(e.b); if (!obj || obj === subj) continue; }
  else continue;
  // one fact per meaning: "drive nails", "driving nails" and "drive nail" are one value (the first kept is the heaviest edge, see the sort above)
  const key = `${pred} ${subj} ${TEXT_REL[e.rel] ? e.b.split(' ').map(w => w.replace(/(ing|s)$/, '').replace(/e$/, '')).join(' ') : obj}`;
  if (seenFact.has(key)) continue;
  seenFact.add(key);
  cnFacts.push({pred, subj, obj, weight: e.weight, rel: e.rel, a: e.a, b: e.b});
}

// ---- writing ------------------------------------------------------------------------------------------------------------------------
const wnNotice = ['# Derived from Princeton WordNet 3.0. WordNet 3.0 Copyright 2006 by Princeton University. All rights reserved.', ...header.slice(0, 40).filter(Boolean).map(l => '# ' + l)];
const cnNotice = ['# Derived from ConceptNet 5.7 (https://conceptnet.io), only edges whose own licence is CC BY 4.0: the Open Mind Common Sense',
  '# contributions (dataset /d/conceptnet/4/en). Licence: Creative Commons Attribution 4.0 (https://creativecommons.org/licenses/by/4.0/).',
  '# Attribution: ConceptNet 5 by Robyn Speer, Joshua Chin and Catherine Havasi (Luminoso / MIT Media Lab), with contributions from the Open Mind',
  '# Common Sense project. Changes: filtered to English, weight >= ' + MIN_WEIGHT + ', relations mapped onto ChatSOP predicates, concepts restricted to WordNet nouns.'];
const files = [];
function emit(base, title, notice, wires) {
  for (let i = 0, part = 1; i < wires.length; i += MAX_WIRES, part++) {
    const chunk = wires.slice(i, i + MAX_WIRES);
    const name = wires.length > MAX_WIRES ? `${base}-${String(part).padStart(2, '0')}` : base;
    files.push({name, text: [`# commonsense-v1: ${title} (generated by tools/commonsense/build.mjs; do not edit by hand).`, ...notice, '', ...chunk].join('\n') + '\n'});
  }
}
const entityWires = [...declared.entries()].filter(([, d]) => chosen.has(d.off)).sort().map(([id, d]) =>
  [`@${id} entity`, '  kind class', `  label en ${JSON.stringify(d.label)}`, ...d.aliases.map(a => `  alias en ${JSON.stringify(a)}`), `  notability ${COMMON_NOUN_NOTABILITY}`, `  source "WordNet 3.0 synset ${d.off}-n"`, ''].join('\n'));
const descWires = [...declared.entries()].filter(([, d]) => chosen.has(d.off) && d.gloss).sort().map(([id, d]) =>
  [`@csd_${id} fact`, `  holds description ${id} ${JSON.stringify(d.gloss)}`, `  source "WordNet 3.0 synset ${d.off}-n gloss"`, ''].join('\n'));
const isaWires = [...isA.entries()].sort().flatMap(([c, ps]) => [...ps].sort().map((p, i) => [`@csi_${c}${i ? '_' + (i + 1) : ''} fact`, `  holds is_a ${c} ${p}`, '  source "WordNet 3.0 hypernym of the chosen sense"', ''].join('\n')));
const merWires = [...partOf.map(([a, b, s]) => ['part_of', a, b, s]), ...madeOf.map(([a, b, s]) => ['made_of_material', a, b, s])].sort().map(([p, a, b, s], i) => [`@csm_${i + 1} fact`, `  holds ${p} ${a} ${b}`, `  source "${s}"`, ''].join('\n'));
const cnWires = cnFacts.sort((x, y) => (x.pred + x.subj + x.obj < y.pred + y.subj + y.obj ? -1 : 1)).map((f, i) => [`@csc_${i + 1} fact`, `  holds ${f.pred} ${f.subj} ${f.obj}`, `  source "ConceptNet 5.7 /r/${f.rel} /c/en/${f.a.replace(/ /g, '_')} /c/en/${f.b.replace(/ /g, '_')} weight ${f.weight} (CC BY 4.0)"`, ''].join('\n'));
emit('0500-wordnet-classes', 'common-noun classes from WordNet', wnNotice, entityWires);
emit('0510-wordnet-hierarchy', 'the class hierarchy of the common nouns (is_a) from WordNet hypernyms', wnNotice, isaWires);
emit('0520-wordnet-descriptions', 'one-line descriptions of the common-noun classes (WordNet glosses)', wnNotice, descWires);
emit('0530-wordnet-parts', 'part-of and made-of between the common nouns (WordNet meronyms)', wnNotice, merWires);
emit('0540-conceptnet', 'typical uses, capabilities, locations, properties and parts of the common nouns (ConceptNet, CC BY 4.0)', cnNotice, cnWires);
for (const f of fs.readdirSync(OUT).filter(f => /^05\d\d-/.test(f))) fs.rmSync(path.join(OUT, f));
files.forEach((f, i) => fs.writeFileSync(path.join(OUT, `${f.name}.sop`), f.text));
const byPred = cnFacts.reduce((m, f) => ({...m, [f.pred]: (m[f.pred] ?? 0) + 1}), {});
const stats = {built_at: new Date().toISOString(), max_nouns: MAX_NOUNS, min_weight: MIN_WEIGHT, conceptnet_lines_read: cnRead, conceptnet_edges_kept: edges.length, conceptnet_isa_words_for_sense_choice: isaWords, classes_declared: entityWires.length,
  classes_reused: [...new Set([...chosen].map(o => idOf.get(o)).filter(id => id && !declared.has(id)))].length, is_a: isaWires.length, descriptions: descWires.length, part_of: partOf.length, made_of_material: madeOf.length,
  conceptnet_facts: byPred, skipped_collisions: skipped.collision.length, skipped_collision_examples: skipped.collision, namesakes: skipped.namesakes.length, namesake_list: skipped.namesakes, files: files.map(f => f.name)};
fs.writeFileSync(STATS, JSON.stringify(stats, null, 1) + '\n');
console.log(JSON.stringify(stats, null, 1));
