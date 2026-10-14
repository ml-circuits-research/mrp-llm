/**
 * The host's bilingual and synonym dictionary (DS014 "Content words: host normalization and translation",
 * owner decision D1 of 2026-09-29 and its refinement). The small model may write content words (relation
 * phrases, common-noun values) either in the message's language, normalized to a lemma, or in English; the
 * knowledge and the reasoner are English-only. This module maps Romanian lemmas and inflected forms, English
 * phrases and their listed synonyms to the same entry (a synonym set), so that
 *   - host linking can translate a Romanian string, or replace an English synonym, before linking; the host
 *     lexicon decides between the candidates, the dictionary never guesses: a Romanian word it does not know is
 *     reported as `untranslated`;
 *   - evaluation can compare two strings by meaning (`sameMeaning`) in either language.
 *
 * Data: reviewable TSV files under config/dictionary/ listed in its manifest.json (source, licence, priority).
 * Columns: `id  pos  en  ro  forms  note`; `en`, `ro` and `forms` are `|`-separated; the first `en` surface is the
 * canonical English one; a form prefixed `def:` is a definite Romanian form (translated with "the"). The loaded
 * dictionary is compiled once into lookup maps and cached on disk under state/cache/dictionary/, keyed by the
 * SHA-256 of the source files, so verification stays fast.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DICTIONARY_DIR = path.join(ROOT, 'config', 'dictionary');
const CACHE_DIR = path.join(ROOT, 'state', 'cache', 'dictionary');
export const COMPILE_VERSION = 'chatsop-dictionary-compile-3';
export const COLUMNS = Object.freeze(['id', 'pos', 'en', 'ro', 'forms', 'note']);
/** Parts of speech; `relation` is a whole relation phrase (a verb with its particles and prepositions). */
export const POS = Object.freeze(['relation', 'verb', 'noun', 'adj', 'adv', 'prep', 'conj', 'pron', 'det', 'num', 'phrase']);
const RELATION_POS = new Set(['relation', 'verb', 'prep', 'adv', 'adj', 'noun', 'det', 'pron', 'phrase', 'conj']);
const VALUE_POS = new Set(['noun', 'adj', 'prep', 'det', 'num', 'phrase', 'pron', 'adv', 'conj']);

/** Folding key: NFC, lower case, cedilla to comma letters, diacritics removed, whitespace collapsed. */
export const fold = text => String(text).normalize('NFC').toLocaleLowerCase('ro').replace(/[şţ]/g, c => (c === 'ş' ? 'ș' : 'ț'))
  .normalize('NFD').replace(/\p{M}/gu, '').replace(/[’`]/g, "'").replace(/\s+/g, ' ').trim();
const tokenize = text => String(text).match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [];
const ROMANIAN_LETTERS = /[ăâîșşțţ]/i;
/** Romanian function words that mark a string as Romanian (ASCII-folded; words shared with English are left out). */
const RO_FUNCTION = new Set(['de', 'la', 'din', 'pe', 'cu', 'si', 'sau', 'al', 'ale', 'ai', 'lui', 'unui', 'unei', 'pentru', 'catre', 'despre',
  'fara', 'sub', 'peste', 'intre', 'pana', 'dupa', 'inainte', 'fi', 'este', 'sunt', 'era', 'un', 'o', 'niste', 'cel', 'cea', 'cei', 'cele', 'nu', 'mai', 'foarte', 'acest', 'aceasta', 'acel', 'acea', 'meu', 'mea', 'tau', 'ta', 'sa', 'se', 'isi', 'il', 'ii', 'le']);
const EN_FUNCTION = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'from', 'by', 'with', 'about', 'into', 'onto', 'over', 'under', 'between', 'after', 'before', 'until',
  'and', 'or', 'not', 'no', 'be', 'is', 'are', 'was', 'were', 'been', 'being', 'am', 'do', 'does', 'did', 'have', 'has', 'had', 'can', 'could', 'may', 'might', 'must', 'should', 'would', 'will',
  'shall', 'up', 'down', 'out', 'off', 'as', 'that', 'this', 'these', 'those', 'my', 'his', 'her', 'its', 'our', 'their', 'your', 'user', "user's", 'who', 'what', 'which', 'it', 'he', 'she', 'they', 'we', 'you', 'i']);

/** English verbs that take a to-infinitive complement (used when a Romanian verb chain is translated). */
const CONTROL_VERBS = new Set(['want', 'wish', 'plan', 'intend', 'hope', 'try', 'decide', 'need', 'prefer', 'start', 'begin', 'continue', 'refuse', 'agree', 'manage', 'fail', 'like', 'love', 'learn', 'mean', 'expect', 'promise', 'offer']);
const FIRST_PERSON_RO = new Set(['eu', 'mie', 'mine', 'ma', 'imi']);
const POSSESSIVE_RO = new Set(['meu', 'mea', 'mei', 'mele']);

/** Parse one TSV source. Blank lines and lines starting with `#` are ignored; the header line is required. */
export function parseTsv(text, file = 'dictionary.tsv') {
  const lines = String(text).split('\n');
  const entries = [];
  let header = null;
  lines.forEach((line, index) => {
    if (!line.trim() || line.startsWith('#')) return;
    const cells = line.split('\t');
    if (!header) {
      header = cells.map(cell => cell.trim());
      if (COLUMNS.some((column, i) => header[i] !== column)) throw Error(`${file}:${index + 1}: header must be ${COLUMNS.join(' ')}`);
      return;
    }
    const [id, pos, en, ro, forms = '', note = ''] = cells;
    const list = value => String(value ?? '').split('|').map(item => item.trim()).filter(Boolean);
    if (!/^[a-z][a-z0-9_:.-]*$/.test(id ?? '')) throw Error(`${file}:${index + 1}: invalid id ${JSON.stringify(id)}`);
    if (!POS.includes(pos)) throw Error(`${file}:${index + 1}: pos must be one of ${POS.join(', ')}`);
    if (!list(en).length && !list(ro).length) throw Error(`${file}:${index + 1}: an entry needs an en or ro surface`);
    entries.push({id, pos, en: list(en), ro: list(ro), forms: list(forms), note: note.trim(), file: path.basename(file), line: index + 1});
  });
  return entries;
}
/** Serialize entries as a TSV source (the CLI writes files through this). */
export function formatTsv(entries, comment = '') {
  const head = comment ? comment.split('\n').map(line => '# ' + line).join('\n') + '\n' : '';
  return head + COLUMNS.join('\t') + '\n' + entries.map(e => [e.id, e.pos, e.en.join('|'), e.ro.join('|'), e.forms.join('|'), e.note ?? ''].join('\t')).join('\n') + (entries.length ? '\n' : '');
}

/** The manifest: {files: [{path, source, licence, priority}], review: path}. */
export function readManifest(dir = DICTIONARY_DIR) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
}

/**
 * Compile entries into lookup maps. `ro` and `en` map a folded surface to `[[entryIndex, flags]]`; flags: `l`
 * lemma/canonical surface, `f` inflected form, `d` definite form. Entries keep their source priority (lower wins).
 */
export function compileEntries(entries) {
  // Prototype-free maps: surfaces such as "constructor" or "__proto__" are ordinary keys.
  const ro = Object.create(null), en = Object.create(null);
  const add = (map, surface, index, flag) => {
    const key = fold(surface);
    if (!key) return;
    (map[key] ??= []);
    if (!map[key].some(([i, f]) => i === index && f === flag)) map[key].push([index, flag]);
  };
  entries.forEach((entry, index) => {
    entry.en.forEach(surface => add(en, surface, index, 'l'));
    entry.ro.forEach(surface => add(ro, surface, index, 'l'));
    for (const form of entry.forms) form.startsWith('def:') ? add(ro, form.slice(4), index, 'd') : add(ro, form, index, 'f');
    // A Romanian relation form with an inflected copula ("e antrenorul de la", "este căsătorită cu") also answers to
    // the lemma form a formalizer writes ("fi antrenorul de la", DS014 "Input languages and content words").
    if (entry.pos === 'relation') for (const form of [...entry.ro, ...entry.forms]) {
      const lemma = String(form).replace(/^(?:e|este|era|a fost|sunt|erau|au fost)\s+/u, 'fi ');
      if (lemma !== form && !form.startsWith('def:')) add(ro, lemma, index, 'f');
    }
  });
  const enTokens = new Set(), roTokens = new Set();
  for (const key of Object.keys(en)) for (const token of tokenize(key)) enTokens.add(token);
  for (const key of Object.keys(ro)) if (!key.includes(' ')) roTokens.add(key);
  return {entries: entries.map(({file, line, ...entry}) => ({...entry, file})), ro, en, enTokens: [...enTokens], roTokens: [...roTokens]};
}

const digestFiles = files => {
  const hash = crypto.createHash('sha256');
  for (const file of files) hash.update(file + '\0').update(fs.existsSync(file) ? fs.readFileSync(file) : '').update('\0');
  return hash.digest('hex');
};

/** Source files of a manifest, in priority order (lower priority number first). */
export function sourceFiles(dir = DICTIONARY_DIR) {
  const manifest = readManifest(dir);
  return [...manifest.files].sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100)).map(item => ({...item, file: path.join(dir, item.path)}));
}

/** Compile the dictionary of `dir`, reusing the on-disk cache when the source files are unchanged. */
export function compileDictionary(dir = DICTIONARY_DIR, {cache = true} = {}) {
  const files = sourceFiles(dir);
  // The compiled format version is part of the key, so a change of the compile code never reads a stale cache.
  const digest = digestFiles([COMPILE_VERSION, path.join(dir, 'manifest.json'), ...files.map(item => item.file)]);
  const cacheFile = path.join(CACHE_DIR, digest + '.json');
  if (cache && fs.existsSync(cacheFile)) {
    try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { /* recompile below */ }
  }
  const entries = [];
  for (const item of files) {
    if (!fs.existsSync(item.file)) continue;
    for (const entry of parseTsv(fs.readFileSync(item.file, 'utf8'), item.file)) entries.push({...entry, priority: item.priority ?? 100, source: item.source});
  }
  const compiled = {format: 'chatsop-dictionary-v1', digest, ...compileEntries(entries)};
  if (cache) {
    try {
      fs.mkdirSync(CACHE_DIR, {recursive: true});
      fs.writeFileSync(cacheFile, JSON.stringify(compiled));
      // Keep the few most recent compilations; older ones belong to replaced sources.
      const old = fs.readdirSync(CACHE_DIR).filter(name => name.endsWith('.json')).map(name => ({name, time: fs.statSync(path.join(CACHE_DIR, name)).mtimeMs})).sort((a, b) => b.time - a.time).slice(4);
      for (const {name} of old) fs.rmSync(path.join(CACHE_DIR, name), {force: true});
    } catch { /* a read-only checkout still works */ }
  }
  return compiled;
}

const product = (lists, limit) => {
  let out = [[]];
  for (const list of lists) {
    const next = [];
    for (const prefix of out) for (const item of list) { next.push([...prefix, item]); if (next.length >= limit) break; }
    out = next;
    if (out.length >= limit) break;
  }
  return out;
};
const stripArticle = text => String(text).replace(/^(?:the|a|an)\s+/i, '');
/** Base forms a Romanian word may have lost an article or an ending from (lookup fallback only; the dictionary decides). */
function romanianBases(token) {
  const out = [];
  const t = token;
  const rule = (re, repl, definite) => { if (re.test(t)) out.push({base: t.replace(re, repl), definite}); };
  rule(/ul$/, '', true); rule(/le$/, '', true); rule(/a$/, 'ă', true); rule(/ia$/, 'ie', true); rule(/ua$/, 'uă', true);
  rule(/ului$/, '', true); rule(/ei$/, 'ă', true); rule(/ii$/, 'e', true); rule(/ile$/, 'i', true); rule(/ele$/, 'e', true);
  rule(/ează$/, 'a', false); rule(/eaza$/, 'a', false); rule(/ește$/, 'i', false); rule(/este$/, 'i', false); rule(/esc$/, 'i', false); rule(/ă$/, 'a', false);
  return out;
}

/**
 * Do lookup hits read `text` as a definite form? Folding removes diacritics, so a definite form can fold to its
 * own lemma ("sala" / "sală"); then the exact (unfolded) spelling decides: definite when it is written as a
 * listed `def:` form, or when it is not written as the lemma or a plain form of the same entry.
 */
function definiteHit(text, hits) {
  if (!hits.some(hit => hit.flag === 'd')) return false;
  if (!hits.some(hit => hit.flag !== 'd')) return true;
  const exact = s => String(s).normalize('NFC').toLocaleLowerCase('ro').replace(/[şţ]/g, c => (c === 'ş' ? 'ș' : 'ț')).replace(/\s+/g, ' ').trim();
  const written = exact(text);
  if (hits.some(hit => hit.flag === 'd' && hit.entry.forms.some(f => f.startsWith('def:') && exact(f.slice(4)) === written))) return true;
  return !hits.some(hit => hit.flag !== 'd' && [...hit.entry.ro, ...hit.entry.forms.filter(f => !f.startsWith('def:'))].some(f => exact(f) === written));
}

export class Dictionary {
  constructor(compiled) {
    this.compiled = compiled;
    this.entries = compiled.entries;
    this.ro = new Map(Object.entries(compiled.ro));
    this.en = new Map(Object.entries(compiled.en));
    this.enTokens = new Set(compiled.enTokens);
    this.roTokens = new Set(compiled.roTokens);
    this.digest = compiled.digest;
  }
  static load(dir = DICTIONARY_DIR, options = {}) { return new Dictionary(compileDictionary(dir, options)); }
  static fromEntries(entries) { return new Dictionary({format: 'chatsop-dictionary-v1', digest: 'inline', ...compileEntries(entries.map(e => ({en: [], ro: [], forms: [], note: '', ...e})))}); }

  /** Entries whose surface (either language, any form) folds to `text`: [{entry, language, flag, priority}]. */
  lookup(text, language = null) {
    const key = fold(text), out = [];
    for (const [lang, map] of [['ro', this.ro], ['en', this.en]]) {
      if (language && language !== lang) continue;
      for (const [index, flag] of map.get(key) ?? []) out.push({entry: this.entries[index], index, language: lang, flag, priority: this.entries[index].priority ?? 100});
    }
    const best = Math.min(...out.map(hit => hit.priority));
    return out.filter(hit => hit.priority === best);
  }
  /** Is a (folded) token Romanian evidence: Romanian letters, a Romanian function word, or a Romanian-only dictionary word? */
  romanianToken(token) {
    const key = fold(token);
    return ROMANIAN_LETTERS.test(token) || RO_FUNCTION.has(key) || (this.roTokens.has(key) && !this.englishToken(token));
  }
  englishToken(token) { const key = fold(token); return EN_FUNCTION.has(key) || this.enTokens.has(key); }
  /** Does a string contain Romanian evidence? Proper names (capitalized tokens) never count. */
  isRomanian(text) { return tokenize(text).some(token => !/^\p{Lu}/u.test(token) && this.romanianToken(token)); }

  /**
   * English candidates of a content string. `kind` is `relation` or `value`. Proper names (a capitalized token or
   * a token with a digit) are kept as written; English words are kept; Romanian words are translated through the
   * longest phrase entry, a lemma, a listed inflected form or an article-less base found in the dictionary.
   * Returns {status, candidates, untranslated, sources}: `unchanged` (no Romanian word), `translated`, or
   * `untranslated` (a Romanian word the dictionary does not know; never guessed).
   */
  candidates(text, kind = 'relation', {limit = 16} = {}) {
    const allowed = kind === 'relation' ? RELATION_POS : VALUE_POS;
    const tokens = tokenize(text);
    // First person (DS014 Q-LANG-5): "eu" is the user; "<noun> meu/mea/mei/mele" is "the user's <noun>".
    if (kind === 'value') {
      const folded = tokens.map(fold);
      if (folded.length === 1 && FIRST_PERSON_RO.has(folded[0])) return {status: 'translated', candidates: ['the user'], untranslated: [], sources: ['manual']};
      if (folded.length >= 2 && POSSESSIVE_RO.has(folded.at(-1))) {
        const owned = this.candidates(tokens.slice(0, -1).join(' '), 'value', {limit});
        if (owned.status === 'translated') return {...owned, candidates: owned.candidates.map(c => "the user's " + stripArticle(c))};
        if (owned.status === 'untranslated') return owned;
      }
    }
    const whole = this.lookup(stripArticle(text), 'ro').filter(hit => kind === 'relation' ? ['relation', 'verb', 'phrase'].includes(hit.entry.pos) : allowed.has(hit.entry.pos) && hit.entry.pos !== 'prep');
    if (whole.length) {
      const definite = definiteHit(stripArticle(text), whole);
      const list = [...new Set(whole.flatMap(hit => hit.entry.en.slice(0, kind === 'relation' ? undefined : 1)).map(en => kind === 'value' && definite && !/^(the|a|an) /i.test(en) && !/^\p{Lu}/u.test(en) ? 'the ' + en : en))];
      if (list.length) return {status: 'translated', candidates: list, untranslated: [], sources: [...new Set(whole.map(hit => hit.entry.source ?? hit.entry.file))]};
    }
    const segments = [], untranslated = [], unknown = [], sources = new Set(), verbSegments = new Map();
    let romanian = false, definiteHead = false;
    for (let i = 0; i < tokens.length;) {
      const token = tokens[i];
      if (/^\p{Lu}/u.test(token) || /\d/.test(token)) { segments.push([token]); i++; continue; }
      let matched = false;
      for (let n = Math.min(6, tokens.length - i); n >= 1 && !matched; n--) {
        const span = tokens.slice(i, i + n);
        if (span.some(t => /^\p{Lu}/u.test(t))) continue;
        const phrase = span.join(' ');
        if (n === 1 && this.englishToken(phrase) && !ROMANIAN_LETTERS.test(phrase) && !RO_FUNCTION.has(fold(phrase))) { segments.push([phrase]); i++; matched = true; break; }
        let hits = this.lookup(phrase, 'ro').filter(hit => allowed.has(hit.entry.pos));
        let definite = definiteHit(phrase, hits);
        if (!hits.length && n === 1) for (const {base, definite: d} of romanianBases(fold(phrase))) {
          const found = this.lookup(base, 'ro').filter(hit => allowed.has(hit.entry.pos) && hit.flag === 'l');
          if (found.length) { hits = found; definite = d && found.some(hit => hit.entry.pos === 'noun'); break; }
        }
        if (!hits.length) continue;
        romanian = true;
        if (segments.length === 0 && definite) definiteHead = true;
        hits.forEach(hit => sources.add(hit.entry.source ?? hit.entry.file));
        const alternatives = [...new Set(hits.flatMap(hit => hit.entry.en.slice(0, kind === 'relation' && hit.entry.pos !== 'relation' ? 3 : undefined)))];
        segments.push(alternatives.length ? alternatives : ['']);
        verbSegments.set(segments.length - 1, hits.every(hit => hit.entry.pos === 'verb') ? 'verb' : hits.every(hit => ['verb', 'relation'].includes(hit.entry.pos)) ? 'relation' : null);
        i += n; matched = true;
      }
      if (matched) continue;
      if (this.romanianToken(token)) { romanian = true; untranslated.push(token); }
      else if (!this.englishToken(token)) unknown.push(token);
      segments.push([token]); i++;
    }
    if (!romanian) return {status: 'unchanged', candidates: [text], untranslated: [], sources: []};
    // In a Romanian string, a word the dictionary knows in neither language is reported, never passed through as English.
    untranslated.push(...unknown);
    if (untranslated.length) return {status: 'untranslated', candidates: [], untranslated, sources: [...sources]};
    // A Romanian verb chain written with the short infinitive ("vrea învăța", "plănui studia") is an English control
    // verb with a to-infinitive ("want to learn", "plan to study"); modals ("putea semna" → "can sign") take none.
    if (kind === 'relation') segments.forEach((alternatives, i) => {
      if (verbSegments.get(i) === 'verb' && verbSegments.get(i + 1)) segments[i] = alternatives.map(a => (CONTROL_VERBS.has(a) ? a + ' to' : a));
    });
    const joined = product(segments, limit).map(parts => parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
    const list = [...new Set(joined.map(c => kind === 'value' && definiteHead && !/^(the|a|an) /i.test(c) && !/^\p{Lu}/u.test(c) ? 'the ' + c : c))];
    return {status: list.length ? 'translated' : 'untranslated', candidates: list, untranslated: list.length ? [] : tokens, sources: [...sources]};
  }

  /** English synonyms of an English phrase (the other surfaces of its entries), best first; excludes the phrase. */
  synonyms(text, kind = 'relation') {
    const allowed = kind === 'relation' ? new Set(['relation', 'verb', 'phrase']) : VALUE_POS;
    const key = fold(text);
    return [...new Set(this.lookup(text, 'en').filter(hit => allowed.has(hit.entry.pos)).flatMap(hit => hit.entry.en))].filter(s => fold(s) !== key);
  }

  /** Entry ids a string means (phrase level, either language); empty when unknown. */
  meanings(text, kind = 'relation') {
    const allowed = kind === 'relation' ? new Set(['relation', 'verb', 'phrase']) : VALUE_POS;
    const hits = [...this.lookup(text), ...this.lookup(stripArticle(text))].filter(hit => allowed.has(hit.entry.pos));
    return new Set(hits.map(hit => hit.entry.id));
  }

  /**
   * Do two content strings mean the same by the dictionary? Equal after folding (articles ignored for values), or
   * sharing an entry at phrase level, or translating to a common English candidate. Evaluation only compares; it
   * never rewrites a target.
   */
  sameMeaning(a, b, kind = 'relation') {
    if (typeof a !== 'string' || typeof b !== 'string') return a === b;
    const norm = s => fold(kind === 'value' ? stripArticle(s) : s);
    if (norm(a) === norm(b)) return true;
    const ma = this.meanings(a, kind), mb = this.meanings(b, kind);
    for (const id of ma) if (mb.has(id)) return true;
    const english = s => { const c = this.candidates(s, kind); return new Set((c.status === 'translated' ? c.candidates : [s]).map(norm)); };
    const ea = english(a), eb = english(b);
    for (const s of ea) if (eb.has(s)) return true;
    // An English synonym of either side.
    const syn = s => new Set([...english(s)].flatMap(x => [x, ...this.synonyms(x, kind).map(norm)]));
    const sa = syn(a);
    for (const s of eb) if (sa.has(s)) return true;
    return false;
  }
}

let loaded = null;
/** The dictionary of config/dictionary (memoized per process). */
export function defaultDictionary() {
  if (!loaded) loaded = Dictionary.load();
  return loaded;
}

/** The English view: content strings are never translated (the core receives English only), synonyms still apply. */
class EnglishDictionary extends Dictionary {
  candidates(text) { return {status: 'unchanged', candidates: [text], untranslated: [], sources: []}; }
}

let loadedEnglish = null;
/**
 * The dictionary the product linking path uses (owner decision of 2026-10-01, DS014 "English-only core"): the English
 * surfaces and synonym sets of config/dictionary only. The core never receives a Romanian content word (the input edge
 * translates first), so no Romanian surface, form or first-person word is compiled into this view: `candidates` of a
 * string returns the string unchanged and `synonyms` lists English synonyms. The full dictionary (`defaultDictionary`)
 * stays for the edges and for evaluation: language identification, the gloss translator backend and tolerant scoring.
 */
export function englishDictionary() {
  if (!loadedEnglish) {
    const entries = defaultDictionary().entries.filter(e => e.en.length).map(e => ({...e, ro: [], forms: []}));
    loadedEnglish = new EnglishDictionary({format: 'chatsop-dictionary-v1', digest: 'english', ...compileEntries(entries.map(e => ({note: '', ...e})))});
  }
  return loadedEnglish;
}
