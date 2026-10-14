/** Relation-phrase convention of the generated corpora (DS015 "Relation phrases").
 *
 * A relation phrase is the message's own predicate words with the role fillers removed, lemmatized: an English
 * verb in its base form ("coached" → "coach", "flew" → "fly"), a copula as "be" ("is married to" → "be married
 * to"), a Romanian verb in its short infinitive ("lucrează" → "lucra", "e înscrisă" → "fi înscris"), reflexive
 * and particle words kept ("se baza pe", "check out"). Only inflection, tense, agreement and spelling are
 * normalized: a content word is never replaced by a synonym or added ("handed in her notice" is "hand in
 * notice", never "resign"). Function words may be restored or dropped: a preposition that a wh-word absorbs
 * ("where did Ana fly" → "fly to", "cu ce merge" → "merge la serviciu cu"), articles, auxiliaries and a
 * classifier noun before a name ("autorul cărții X" → "fi autorul").
 *
 * Targets are canonical English (owner decision Q-DATA-6): for English input the relation phrase is the message's
 * own words as above; for Romanian input it is the English phrase of the construction's meaning
 * (english.mjs RO_CONSTRUCTION_EN), and the convention applies to the Romanian source phrase it translates.
 *
 * `relationWordProblems` checks that every content word of each stated/query relation phrase occurs in the
 * message as an inflected form. The generator applies it to the realized message before noise, so a
 * construction that paraphrases can never reach a corpus; `tests/data/relation-phrases.test.mjs` re-checks the
 * clean rows of the built corpora.
 */
import { foldDiacritics } from './text.mjs';

/** Words a relation phrase may add or drop: copulas, auxiliaries, articles, prepositions, particles, clitics. */
const FUNCTION = new Set(('be is are was were been being a an the to at in into on of for with from by about as ' +
  'do does did have has had ' +
  // Light "have" verbs: "cu sediul în" is formalized "avea sediul în", "has a job at" "have a job at".
  'avea are au avut ' +
  'fi e este sunt era fost a al ale ai la în in pe cu din de spre despre pentru lui să se și îl o l i își').split(' ').map(word => foldDiacritics(word)));

/** Irregular or suppletive inflections: lemma → forms that do not share its stem (folded, lower case). */
const IRREGULAR = {
  go: ['goes', 'went', 'gone'], make: ['made'], fly: ['flew', 'flown', 'flies'], take: ['took', 'taken'], teach: ['taught'], bring: ['brought'],
  hold: ['held'], buy: ['bought'], pay: ['paid', 'pays'], sell: ['sold'], write: ['wrote', 'written'], grow: ['grew', 'grown'], sing: ['sang', 'sung'],
  leave: ['left'], get: ['got', 'gets', 'gotten'], quit: ['quits'], give: ['gave', 'given'], lend: ['lent'], meet: ['met'], see: ['saw', 'seen'], ride: ['rode'], drive: ['drove'],
  keep: ['kept'], run: ['ran'], lead: ['led'], feel: ['felt'], win: ['won'], sit: ['sat'], spend: ['spent'], tell: ['told'], think: ['thought'],
  avea: ['are', 'au', 'avut', 'aveau', 'avea'], lua: ['ia', 'iau', 'luat'], juca: ['joaca', 'joc', 'joaca', 'jucat'], merge: ['mers', 'merg'],
  vrea: ['vor', 'vrut', 'vreau', 'vrei'], face: ['fac', 'facut'], cadea: ['cazut', 'cade', 'cad'], sta: ['sta', 'stat', 'stau'], da: ['dat', 'da', 'dau'],
  vinde: ['vand', 'vandut'], insemna: ['inseamna'], trimite: ['trimis'], muta: ['muta', 'mutat'], putea: ['poate', 'pot', 'putut'], creste: ['crescut'], cere: ['cerut'],
};

const tokens = text => foldDiacritics(String(text)).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const commonPrefix = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };

/** Does message word `word` inflect relation word `lemma`? A shared stem, or a listed irregular form. */
export function inflects(lemma, word) {
  if (lemma === word || IRREGULAR[lemma]?.includes(word)) return true;
  const shared = commonPrefix(lemma, word);
  if (lemma.length <= 3) return shared === lemma.length;
  // Endings change with tense, person and (in Romanian) gender and article: "antrenorul" / "antrenoarea".
  return shared >= Math.max(3, Math.min(lemma.length, word.length) - 3) && shared >= lemma.length / 2;
}

/** Content words of a relation phrase that have no inflected form in `text`. */
export function missingRelationWords(relation, text) {
  const words = tokens(text);
  return tokens(relation).filter(lemma => !FUNCTION.has(lemma) && !words.some(word => inflects(lemma, word)));
}

/** Problems of a surface IR against its message: one line per relation phrase with a missing content word. */
export function relationWordProblems(surface, text) {
  const props = [...(surface.stated ?? []), ...(surface.query?.props ?? []), ...(surface.query?.scope ?? []), ...(surface.moreQueries ?? []).flatMap(q => q.props ?? [])];
  const problems = [];
  for (const prop of props) {
    // A Romanian realization carries its English target phrase in `relation` and the message's own phrase in
    // `source_relation` (english.mjs, Q-DATA-6): the message words are checked on the source phrase.
    const phrase = prop.source_relation ?? prop.relation;
    if (!phrase) continue; // a fragment block without a relation (Q-LANG-4)
    const missing = missingRelationWords(phrase, text);
    if (missing.length) problems.push(`relation ${JSON.stringify(phrase)} lacks ${missing.join(', ')}`);
  }
  return problems;
}
