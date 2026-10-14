/** Form and content-word signatures of dataset rows (DSx008 "Content-word overlap").
 *
 * The form signature is the analysis skeleton of the symbolic-forms inventory
 * (eval/reports/current/three-datasets/symbolic-forms-inventory.md, archived generator `probably_obsolete/legacy/tools/symbolic-gate/symbolic-gate.mjs inventory`): question type,
 * root part of speech, dependents of the root and subordinate clauses. It ignores every content word. The content-word
 * signature is the set of lemmas of proper names, nouns and verbs of the stored analysis (a light tokenizer plus a
 * stop-word list where a row has no analysis, as in bad_english), so a different name, noun or verb gives a different
 * signature. Pure functions, no I/O.
 */
import {GIVEN_NAMES} from '../diversity/names.mjs';

const WH = new Set(['who', 'whom', 'whose', 'what', 'which', 'when', 'where', 'why', 'how']);
const CLAUSE_RELS = ['ccomp', 'xcomp', 'advcl', 'acl', 'acl:relcl', 'parataxis'];
const CONTENT_UPOS = new Set(['PROPN', 'NOUN', 'VERB']);

/** Analysis skeleton of one sentence (compact tokens [id, form, lemma, upos, head, deprel]); mirrors the forms inventory. */
export function skeleton(tokens) {
  const words = tokens.map(([id, form, lemma, upos, head, deprel]) => ({id, form, lemma, upos, head, deprel}));
  const content = words.filter(w => w.upos !== 'PUNCT');
  const root = words.find(w => w.deprel === 'root');
  if (!root) return 'no root';
  const kids = words.filter(w => w.head === root.id);
  const has = re => kids.some(k => re.test(k.deprel));
  const first = content[0]?.form.toLowerCase();
  const question = words.some(w => w.form === '?') || WH.has(first);
  const whWord = content.find(w => WH.has(w.form.toLowerCase()) && (w.id <= 3));
  const inverted = content[0] && content[0].head && (content[0].upos === 'AUX' || content[0].deprel === 'cop' || content[0].deprel.startsWith('aux')) && question;
  const kind = whWord ? `wh-question(${whWord.form.toLowerCase()})` : question ? (inverted ? 'yes-no question' : 'question') : (root.upos === 'VERB' && !has(/^(nsubj|csubj|expl)/) ? 'imperative/fragment' : 'statement');
  const copula = kids.some(k => k.deprel === 'cop');
  const rootType = copula ? `copular ${root.upos}` : root.upos;
  const frame = ['nsubj:pass', 'nsubj', 'csubj', 'expl', 'obj', 'iobj', 'obl', 'ccomp', 'xcomp', 'advcl', 'conj', 'parataxis'].filter(rel => kids.some(k => k.deprel === rel || (rel === 'obl' && k.deprel.startsWith('obl:')))).join(' ');
  const clauses = CLAUSE_RELS.map(rel => [rel, words.filter(w => w.deprel === rel).length]).filter(([, n]) => n).map(([rel, n]) => (n > 1 ? `${rel}x${n}` : rel)).join('+');
  const neg = words.some(w => w.deprel === 'advmod' && /^(not|n't|never)$/i.test(w.form)) ? ' neg' : '';
  return `${kind} | root ${rootType}${neg} | ${frame || 'no arguments'} | ${clauses ? 'subordination ' + clauses : 'single clause'}`;
}

/** Skeleton of a row as the inventory clusters it: the longest sentence. `null` without analysis. */
export function mainForm(analysis) {
  const sentences = analysis?.sentences ?? [];
  if (!sentences.length) return null;
  return skeleton(sentences.slice().sort((a, b) => b.tokens.length - a.tokens.length)[0].tokens);
}

/** Skeleton of every sentence joined, the full form of a multi-sentence row. */
export function fullForm(analysis) {
  const sentences = analysis?.sentences ?? [];
  return sentences.length ? sentences.map(s => skeleton(s.tokens)).join(' // ') : null;
}

const STOP = new Set(`a an the and or but if then so of to in on at by for with from as is are was were be been being am do does did has have had
 not no can could will would shall should may might must i me my we our you your he him his she her it its they them their this that these those there here
 who whom whose what which when where why how whether also please just very much many any some each every all more most than about into over under
 tell know check say ask like want wonder wondering remind ok okay yes hello hi thanks thank
 si sa sau dar ce cine care cand unde cum de la in pe cu din pentru este sunt era au a am ai are nu un o niste al ale cel cea lui lor mea meu tu eu el ea noi voi ei ele mi ti ma te se ne va le`.split(/\s+/));

/** Light content words of a plain text: lowercase word tokens of length >= 3 that are not stop words. */
export function lightWords(text) {
  const words = String(text).normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.filter(w => w.length >= 3 && !STOP.has(w)))].sort();
}

/** Sorted lemmas of the proper names, nouns and verbs of an analysis. */
export function analysisWords(analysis) {
  const out = new Set();
  for (const sentence of analysis?.sentences ?? []) for (const [, form, lemma, upos] of sentence.tokens) {
    if (CONTENT_UPOS.has(upos)) out.add(String(lemma || form).normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase());
  }
  return [...out].sort();
}

/**
 * Signature of a row: `{form, words, source}`. Rows with an analysis use it (source `analysis`); bad_english rows use the
 * clean target when one exists (`target`) and the message otherwise (`message`); the form of a bad_english row is its
 * language kind and the semantic family of its source (`ro|conjunction`), which are the only structural fields it has.
 */
export function signatureOf(row) {
  if (row.analysis?.sentences?.length) return {form: mainForm(row.analysis), full: fullForm(row.analysis), words: analysisWords(row.analysis), source: 'analysis'};
  const text = row.target ?? row.message;
  return {form: `${row.language_kind ?? row.dataset}|${row.source?.family ?? 'none'}`, full: `${row.language_kind ?? row.dataset}|${row.source?.family ?? 'none'}`, words: lightWords(text), source: row.target ? 'target' : 'message'};
}

/** Share of the words of `a` that also occur in `b`, |A ∩ B| / |A|; 0 for an empty `a`. */
export function coverage(a, b) {
  if (!a.length) return 0;
  const set = new Set(b);
  let inter = 0;
  for (const w of a) if (set.has(w)) inter++;
  return inter / a.length;
}

/** Given name -> gender (`f`, `m`, `x`) of the diversity generator's authored list. */
export const PERSON = new Map(GIVEN_NAMES.map(({name, gender}) => [name, gender]));

/** Name entities of one analysed sentence: `[{text, first, deprel, gender}]` (a head PROPN with its flat/compound name parts). */
export function nameEntities(sentence) {
  const out = [];
  for (const [id, form, , upos, , deprel] of sentence.tokens) {
    if (upos !== 'PROPN' || /^(flat|compound)/.test(deprel)) continue;
    const parts = [form];
    for (const [cid, cform, , cupos, chead, crel] of sentence.tokens) if (chead === id && cupos === 'PROPN' && /^flat/.test(crel) && cid > id) parts.push(cform);
    out.push({text: parts.join(' '), first: form, deprel, gender: PERSON.get(form) ?? null, person: PERSON.has(form)});
  }
  return out;
}

