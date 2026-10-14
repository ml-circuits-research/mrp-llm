/**
 * The host lexicon: reviewed forms that link strings to symbols, indexed for exact and accent-folded lookup, never fuzzy identity.
 *
 * There is one grammar. The lexicon of a base memory is compiled from its circuits (`Lexicon.fromCircuits`): the `predicate`,
 * `lexeme` and `entity` wires of the knowledge grammar (DS004 "Lexicon wires") and the `is_a` facts that give class membership.
 * Every other wire of the circuits is ignored here. A lexicon never validates: the knowledge validator is the gate
 * (`sop/knowledge/lexicon-checks.mjs`), and the compile tolerates what the validator reports as a warning.
 */
import fs from 'node:fs';
import {parse, tokens as wireTokens} from './knowledge/lexical.mjs';
import {assert, digest} from '../lib/util.mjs';
import {ARG_TYPES, CLASS_KIND, ROOT_CLASS} from './knowledge/grammar.mjs';
import {normalize, fold, tokens, phraseKey} from './text-keys.mjs';
export {normalize};

/** Version of the compiled format: part of every cache key and of the serialized form. */
export const LEXICON_FORMAT = 7;

const spans = (s, a) => { const out = []; let at = s.indexOf(a); while (at >= 0) { const end = at + a.length, left = at === 0 || !/[\p{L}\p{N}_]/u.test(s[at - 1]), right = end === s.length || !/[\p{L}\p{N}_]/u.test(s[end]); if (left && right) out.push([at, end]); at = s.indexOf(a, at + 1); } return out; };
const field = (w, key) => w.fields.find(f => f.key === key)?.value.trim();
const fieldsOf = (w, key) => w.fields.filter(f => f.key === key).map(f => f.value.trim());
const unquote = s => (s?.startsWith('"') ? JSON.parse(s) : s);
const langText = value => { const [language, ...rest] = wireTokens(value); return {language, surface: unquote(rest[0] ?? '""')}; };

const UNIT_READINGS = ['unit_amount', 'unit_dimension'];
const preferNamed = list => { const named = list.filter(e => !e.derived); return named.length ? named : list; };

export class Lexicon {
  /** `new Lexicon(text)` compiles one circuit text; `Lexicon.fromCircuits([...])` compiles the layers of a base memory. */
  constructor(source = '', {provenance = 'host-lexicon', circuits = null} = {}) {
    const parts = circuits ?? (source.trim() ? [{name: provenance, text: source}] : []);
    this.entities = {}; this.predicates = {}; this.classes = {}; this.lexemes = [];
    this.entries = []; this.index = new Map(); this.exact = new Map(); this.folded = new Map();
    this.predicatesByKey = new Map(); this.formsByKey = new Map(); this.isA = new Map(); this.factCounts = new Map(); this.unitFacts = {};
    this.version = digest(parts.map(c => c.name + '\0' + c.text).join('\0'));
    this.provenance = provenance;
    this.compile(parts);
  }

  static fromCircuits(circuits, options = {}) { return new Lexicon('', {...options, circuits}); }
  static load(file) { return new Lexicon(fs.readFileSync(file, 'utf8'), {provenance: String(file)}); }

  compile(parts) {
    const wires = [];
    for (const part of parts) {
      const parsed = parse(part.text);
      assert(!parsed.errors.length, `Lexicon circuit ${part.name}: ${parsed.errors[0]?.message} (line ${parsed.errors[0]?.line})`);
      wires.push(...parsed.wires);
    }
    for (const w of wires) if (w.type === 'predicate') this.addPredicate(w);
    for (const w of wires) if (w.type === 'entity') this.addEntity(w);
    for (const w of wires) if (w.type === 'lexeme') this.addLexeme(w);
    for (const w of wires) if (w.type === 'fact') this.addFact(w);
    for (const p of Object.values(this.predicates)) { p.factCount = this.factCounts.get(p.id) ?? 0; this.indexPredicate(p); }
    for (const e of Object.values(this.entities)) this.indexEntity(e);
  }

  addPredicate(w) {
    const argTokens = field(w, 'args') ? (field(w, 'args') === 'none' ? [] : wireTokens(field(w, 'args'))) : null;
    const named = argTokens?.length && argTokens.every(t => t.includes(':')) ? argTokens.map(t => { const [name, type] = t.split(':'); return {name, type}; }) : null;
    const roleLines = fieldsOf(w, 'role').map(line => { const [name, type] = wireTokens(line); return {name, type}; });
    // Role names and the type of each position: a class symbol of `role NAME CLASS` wins over the value type `entity` of args.
    let roles;
    if (roleLines.length) roles = roleLines;
    else if (named) roles = named;
    else if (argTokens) roles = argTokens.length <= 2 ? argTokens.map((type, i) => ({name: ['subject', 'object'][i], type})) : [];
    else roles = [];
    const types = roles.length ? roles.map(r => r.type) : (argTokens ?? []);
    const labels = {}, aliases = [];
    for (const value of fieldsOf(w, 'label')) { const {language, surface} = langText(value); aliases.push({language, surface}); labels[language] ??= surface; }
    this.predicates[w.id] = {
      id: w.id, kind: 'predicate', labels, aliases, domain: field(w, 'domain') ?? null, version: this.version, provenance: this.provenance,
      args: types, arity: types.length, namedRoles: Boolean(roleLines.length || named), roles: roles.map(r => ({name: r.name, type: r.type})),
      closed: field(w, 'closed') === 'true',
      description: unquote(field(w, 'description') ?? '') ?? '', readings: fieldsOf(w, 'reading'), describeRank: field(w, 'describe_rank') ? Number(field(w, 'describe_rank')) : null,
      lexemes: [], valueTypes: types.map(t => (ARG_TYPES.includes(t) ? t : 'entity')),
    };
  }

  addLexeme(w) {
    const predicate = this.predicates[field(w, 'of')];
    if (!predicate) return;
    const frame = wireTokens(field(w, 'frame') ?? '');
    const names = predicate.roles.map(r => r.name);
    const lexeme = {
      id: w.id, of: predicate.id, language: field(w, 'language'), pos: field(w, 'pos') ?? 'verb', forms: fieldsOf(w, 'form').map(unquote), frame,
      converse: names.length > 0 && frame.length > 0 && frame[0] !== names[0],
      restrict: fieldsOf(w, 'restrict').map(line => { const [role, cls] = wireTokens(line); return {role, class: cls}; }),
      weight: field(w, 'weight') === undefined ? null : Number(field(w, 'weight')),
    };
    predicate.lexemes.push(lexeme);
    this.lexemes.push(lexeme);
    for (const surface of lexeme.forms) if (!predicate.aliases.some(a => a.language === lexeme.language && a.surface === surface)) predicate.aliases.push({language: lexeme.language, surface});
  }

  addEntity(w) {
    const labels = {}, aliases = [];
    for (const key of ['label', 'alias']) for (const value of fieldsOf(w, key)) { const {language, surface} = langText(value); aliases.push({language, surface}); if (key === 'label') labels[language] ??= surface; }
    const entityType = field(w, 'kind') ?? ROOT_CLASS;
    // Name parts (owner decision 2026-10-01, DS014 "KnowledgeLinker: scoring and ambiguity"): a person is also found by the last word of the English label
    // ("Einstein" for "Albert Einstein"), as an alias flagged `derived: 'name_part'`; the linker ranks the claimants by notability and asks when several are notable.
    if (entityType === 'person' && labels.en) {
      const words = labels.en.trim().split(/\s+/), surname = words.at(-1)?.replace(/[.,]+$/, '');
      if (words.length >= 2 && surname && surname.length >= 3 && /^\p{Lu}/u.test(surname) && !/^(?:Jr|Sr|II|III|IV)$/i.test(surname) && !aliases.some(a => a.language === 'en' && a.surface === surname)) aliases.push({language: 'en', surface: surname, derived: 'name_part'});
    }
    this.entities[w.id] = {id: w.id, kind: 'entity', labels, aliases, domain: field(w, 'domain') ?? null, version: this.version, provenance: this.provenance, entityType, notability: field(w, 'notability') === undefined ? null : Number(field(w, 'notability'))};
    if (entityType === CLASS_KIND) this.classes[w.id] = this.entities[w.id];
  }

  addFact(w) {
    const [p, a, b] = wireTokens(field(w, 'holds') ?? '');
    // The facts of the memory per predicate: the KnowledgeLinker's evidence that a predicate can answer something (`predicate.factCount`).
    if (p) this.factCounts.set(p, (this.factCounts.get(p) ?? 0) + 1);
    // The memory's description of an entity (world-v1: the Wikidata description) tells namesakes apart in a clarification.
    if (p === 'description' && a && b && this.entities[a] && !this.entities[a].description) { try { const text = JSON.parse(b); if (typeof text === 'string' && text.trim()) this.entities[a].description = text.trim().slice(0, 160); } catch { /* not a quoted text */ } }
    // The unit facts of the memory (predicates declared `reading unit_amount` / `reading unit_dimension`): a quantity with a unit in a
    // comparison is lowered with them (sop/quantities.mjs).
    for (const reading of UNIT_READINGS) if (a && b && this.predicates[p]?.readings?.includes(reading)) (this.unitFacts[reading] ??= {})[a] ??= b;
    if (p !== 'is_a' || !a || !b || !/^[a-z]/.test(a) || !/^[a-z]/.test(b)) return;
    (this.isA.get(a) ?? this.isA.set(a, new Set()).get(a)).add(b);
  }

  addEntry(item, alias) {
    const entry = {...alias, id: item.id, kind: item.kind, type: item.entityType, domain: item.domain, norm: normalize(alias.surface), folded: fold(alias.surface), version: this.version, provenance: this.provenance};
    const ix = this.entries.length;
    this.entries.push(entry);
    for (const [index, key] of [[this.exact, entry.norm], [this.folded, entry.folded]]) { if (!index.has(key)) index.set(key, []); index.get(key).push(ix); }
    for (const t of new Set(tokens(entry.folded))) { if (!this.index.has(t)) this.index.set(t, new Set()); this.index.get(t).add(ix); }
  }

  indexEntity(e) { for (const a of [...e.aliases, {language: 'und', surface: e.id}]) this.addEntry(e, a); }

  indexPredicate(p) {
    for (const a of [...p.aliases, {language: 'und', surface: p.id}]) this.addEntry(p, a);
    // The forms the relation linker compares by phrase key: the id, every label and lexeme form, and the description.
    const forms = [p.id, ...p.aliases.map(a => a.surface), ...(p.description ? [p.description] : [])];
    for (const key of new Set(forms.map(phraseKey))) (this.predicatesByKey.get(key) ?? this.predicatesByKey.set(key, new Set()).get(key)).add(p.id);
    for (const lexeme of p.lexemes) for (const form of lexeme.forms) { const key = phraseKey(form); (this.formsByKey.get(key) ?? this.formsByKey.set(key, []).get(key)).push({predicate: p.id, lexeme: lexeme.id, form, language: lexeme.language}); }
  }

  /** Predicates whose id, label, lexeme form or description has the phrase key. */
  predicatesFor(key) { return [...(this.predicatesByKey.get(key) ?? [])].map(id => this.predicates[id]); }

  /** The classes an entity belongs to: its kind and the `is_a` facts about it, closed over `is_a` between classes. */
  classesOf(id) {
    const direct = [this.entities[id]?.entityType, ...(this.isA.get(id) ?? [])].filter(Boolean);
    const out = new Set(), queue = [...direct];
    while (queue.length) { const c = queue.pop(); if (out.has(c)) continue; out.add(c); queue.push(...(this.isA.get(c) ?? [])); }
    return out;
  }

  isClass(id) { return Boolean(this.classes[id]); }

  /** Entries with the surface; a `type` admits an entity of that class or of any subclass (`classesOf`). */
  matching(surface, {language, kind, type, domain}) {
    // A name part (`derived: 'name_part'`, the surname of a person) is only a fallback: where an entity carries the surface as a label, id or alias, the name parts are not candidates.
    const matches = (index, key) => preferNamed([...new Map((index.get(key) ?? []).map(i => this.entries[i]).filter(e => (language === 'auto' || e.language === language || e.language === 'und') && e.kind === kind && (!type || e.type === type || (e.kind === 'entity' && this.classesOf(e.id).has(type))) && (!domain || e.domain === domain)).map(e => [e.id, e])).values()]);
    const exact = matches(this.exact, normalize(surface));
    const result = {found: exact.length ? exact : matches(this.folded, fold(surface)), match: exact.length ? 'exact' : 'accent-folded'};
    // A leading English article is not part of a name unless the memory's own label carries it ("the United Kingdom" for the label "United Kingdom"): tried only after the whole surface found nothing.
    const bare = result.found.length || kind !== 'entity' ? null : String(surface).replace(/^(?:the|an?)\s+(?=\S)/i, '');
    if (bare && bare !== surface) { const retry = this.matching(bare, {language, kind, type, domain}); if (retry.found.length) return {found: retry.found, match: retry.match === 'exact' ? 'article-stripped' : 'article-stripped, accent-folded'}; }
    // An English possessive ending is not part of a name ("Napoleon's" for the label "Napoleon"), again only after the whole surface found nothing.
    const owner = result.found.length || kind !== 'entity' ? null : String(surface).replace(/(?:['’]s|s['’])$/i, m => m.length === 2 && /s/i.test(m[0]) ? m[0] : '');
    if (owner && owner !== surface && owner.trim()) { const retry = this.matching(owner, {language, kind, type, domain}); if (retry.found.length) return {found: retry.found, match: retry.match === 'exact' ? 'possessive-stripped' : 'possessive-stripped, ' + retry.match}; }
    return result;
  }

  resolve(surface, {language, kind, type, domain} = {}) {
    assert(typeof surface === 'string' && surface.length > 0 && Buffer.byteLength(surface) <= 1600, 'resolve text must be bounded');
    assert(/^[a-z]{2,3}$/.test(language ?? ''), 'resolve requires explicit language');
    assert(['entity', 'predicate'].includes(kind), 'resolve requires symbolic kind');
    assert(!type || kind === 'entity', 'resolve type only applies to entities');
    const {found, match} = this.matching(surface, {language, kind, type, domain});
    const base = {surface, language, kind, version: this.version, provenance: this.provenance};
    if (found.length === 1) { const e = found[0]; return {...base, status: 'bound', id: e.id, type: e.type, domain: e.domain, match}; }
    return {...base, status: found.length ? 'ambiguous' : 'unknown', candidates: found.map(e => ({id: e.id, type: e.type, domain: e.domain})).sort((a, b) => a.id.localeCompare(b.id))};
  }

  candidates(text, {language = 'auto', maxEntities = 12, maxPredicates = 10} = {}) {
    assert(typeof text === 'string' && Buffer.byteLength(text) <= 1600, 'Lexical input size limit');
    const norm = normalize(text), folded = fold(text), seen = new Set();
    for (const t of tokens(folded)) for (const i of this.index.get(t) ?? []) seen.add(i);
    // Resolve every actual mention before ranking IDs. A longer match shadows a
    // nested short alias only at that occurrence, not at another occurrence.
    const positions = new Map();
    for (const i of seen) { const e = this.entries[i]; if (language !== 'auto' && !['und', language].includes(e.language)) continue; for (const [start, end] of spans(folded, e.folded)) positions.set(start + ':' + end, {start, end}); }
    assert(positions.size <= 512, 'Too many lexical mentions');
    const maximal = [...positions.values()].filter(a => ![...positions.values()].some(b => b.start <= a.start && a.end <= b.end && b.end - b.start > a.end - a.start));
    const best = new Map(), ambiguities = [];
    for (const {start, end} of maximal) {
      const surface = norm.slice(start, end);
      for (const kind of ['entity', 'predicate']) {
        const {found, match} = this.matching(surface, {language, kind});
        if (!found.length) continue;
        if (found.length > 1) ambiguities.push({kind, surface, ids: found.map(e => e.id).sort()});
        for (const e of found) { const score = (match === 'exact' ? 100 : 85) + Math.min(tokens(e.folded).length, 8), prev = best.get(e.id); if (!prev || prev.score < score) best.set(e.id, {id: e.id, kind: e.kind, score, surface: e.surface, language: e.language}); }
      }
    }
    const ranked = [...best.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return {entities: ranked.filter(x => x.kind === 'entity').slice(0, maxEntities), predicates: ranked.filter(x => x.kind === 'predicate').slice(0, maxPredicates), ambiguities, polarityCues: tokens(norm).filter(t => ['nu', 'not', 'never', 'kein', 'nicht', 'fără', 'fara', 'nunca', 'non'].includes(t)), truncated: ranked.filter(x => x.kind === 'entity').length > maxEntities || ranked.filter(x => x.kind === 'predicate').length > maxPredicates};
  }

  /** The compiled lexicon as JSON (the on-disk cache of a base memory's lexicon); `Lexicon.revive` rebuilds the indexes. */
  serialize() {
    return {format: LEXICON_FORMAT, version: this.version, provenance: this.provenance, entities: this.entities, predicates: this.predicates, isA: [...this.isA].map(([k, v]) => [k, [...v]]), unitFacts: this.unitFacts};
  }

  static revive(data) {
    assert(data?.format === LEXICON_FORMAT, 'Stale lexicon cache');
    const lexicon = new Lexicon('', {provenance: data.provenance});
    lexicon.version = data.version;
    lexicon.entities = data.entities; lexicon.predicates = data.predicates;
    for (const p of Object.values(lexicon.predicates)) lexicon.lexemes.push(...p.lexemes);
    for (const e of Object.values(lexicon.entities)) if (e.entityType === CLASS_KIND) lexicon.classes[e.id] = e;
    lexicon.isA = new Map(data.isA.map(([k, v]) => [k, new Set(v)]));
    lexicon.unitFacts = data.unitFacts ?? {};
    for (const p of Object.values(lexicon.predicates)) lexicon.indexPredicate(p);
    for (const e of Object.values(lexicon.entities)) lexicon.indexEntity(e);
    return lexicon;
  }
}
