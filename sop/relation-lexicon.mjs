/**
 * The relation lexicon (DS014 "KnowledgeLinker: the copula and the relation lexicon"): reviewed language data the
 * KnowledgeLinker reads next to the predicates of the chosen base memory. It holds the words of the copula (verb forms,
 * articles, locative phrases), the occupation nouns and attribute adjectives used to classify "be a X" / "be X", and
 * `relations`, extra relation phrases a base memory maps to its own predicates. It names no predicate of its own:
 * copula readings are declared on predicate wires (`reading`), and `relations` entries are inert unless the memory
 * declares the predicate. A phrase that no lexicon entry covers stays unknown; nothing is guessed.
 */
import fs from 'node:fs';
import {assert} from '../lib/util.mjs';
import {normalize} from './text-keys.mjs';

const fold = s => normalize(s).normalize('NFD').replace(/\p{M}/gu, '');
const tokens = s => fold(String(s).replaceAll('_', ' ')).match(/[\p{L}\p{N}]+/gu) ?? [];
const list = (value, where) => { assert(Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim()), `${where} must be a list of non-empty strings`); return value.map(item => tokens(item).join(' ')); };
const both = (value, where) => { assert(value && typeof value === 'object', `${where} needs en and ro lists`); return new Set([...list(value.en ?? [], where + '.en'), ...list(value.ro ?? [], where + '.ro')]); };

export class RelationLexicon {
  constructor(data, {provenance = 'relation-lexicon'} = {}) {
    assert(data?.version === 1, 'relation lexicon version must be 1');
    const copula = data.copula ?? {};
    this.provenance = provenance;
    this.verbs = new Set(list(copula.verbs ?? [], 'copula.verbs'));
    this.indefinite = new Set(list(copula.indefinite ?? [], 'copula.indefinite'));
    this.definite = new Set(list(copula.definite ?? [], 'copula.definite'));
    this.locative = new Set(list(copula.locative ?? [], 'copula.locative'));
    this.occupations = both(data.occupations ?? {}, 'occupations');
    this.attributes = both(data.attributes ?? {}, 'attributes');
    this.relations = (data.relations ?? []).map((entry, index) => {
      assert(typeof entry?.relation === 'string' && typeof entry?.predicate === 'string' && /^[a-z]{2,3}$/.test(entry.lang ?? ''), `relations[${index}] needs relation, lang and predicate`);
      return {relation: entry.relation, lang: entry.lang, predicate: entry.predicate, key: tokens(entry.relation).join(' ')};
    });
  }
  /** The same data with the entries of another lexicon added (a base memory's own file extends the default). */
  extend(other) {
    const merged = new RelationLexicon({version: 1});
    for (const name of ['verbs', 'indefinite', 'definite', 'locative', 'occupations', 'attributes']) merged[name] = new Set([...this[name], ...other[name]]);
    merged.relations = [...this.relations, ...other.relations];
    merged.provenance = `${this.provenance}+${other.provenance}`;
    return merged;
  }
  /** Predicate ids the reviewed `relations` list gives to a relation phrase key (folded tokens joined by a space; compare with the linker's own key). */
  predicatesFor(matches) { return [...new Set(this.relations.filter(entry => matches(entry.relation)).map(entry => entry.predicate))]; }
  static load(file) { return new RelationLexicon(JSON.parse(fs.readFileSync(file, 'utf8')), {provenance: String(file)}); }
}
let defaultLexicon = null;
/** The shipped language data (config/relation-lexicon.json), loaded once. */
export const defaultRelationLexicon = () => defaultLexicon ??= RelationLexicon.load(new URL('../config/relation-lexicon.json', import.meta.url));
export {tokens as relationTokens, fold as relationFold};
