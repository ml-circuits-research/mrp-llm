#!/usr/bin/env node
/**
 * Builds the candidate layer `config/knowledge/free-genericskb-slice-v1/` from GenericsKB-Best (Bhakthavatsalam, Anastasiades and Clark,
 * 2020; Allen Institute for AI; CC BY 4.0). GenericsKB is a collection of sentences, and a sentence is never stored as a fact: only a
 * sentence whose whole shape is one of the simple patterns below becomes a typed fact, and only its concept and value words are kept.
 * The patterns read the structure of the source rows (the row names its topical term; the sentence must begin with that term, or its
 * plural, and its quantifier, if any, must keep it typical: most, all, every, usually, always), never a user message:
 *   TERM(s) are made of/from X -> made_of_material;  TERM(s) have X -> typically_has;  TERM(s) live/grow/are found in X -> found_at;
 *   TERM(s) are (a) part of X -> part_of  (X a linked class in each);  TERM(s) can V... -> capable_of;  TERM(s) are used for/to V... ->
 *   used_for;  TERM(s) are ADJ -> typical_property (ADJ a single WordNet 3.0 adjective that is not also a noun).
 * Only rows of source "Waterloo" are taken. ARC (CC BY-SA 4.0) and SimpleWikipedia (CC BY-SA) rows carry ShareAlike text, ConceptNet rows
 * were synthesized from ConceptNet edges of unrecorded licence, TupleKB rows have no licence notice of their own that was found, and
 * WordNet rows repeat what commonsense-v1 already takes from WordNet: none of them is used. Confidence is the source's score.
 *   node tools/commonsense/free-sources/genericskb.mjs fetch   (downloads GenericsKB-Best.tsv.gz, 27 MB, writes provenance.json)
 *   node tools/commonsense/free-sources/genericskb.mjs build [--max 1500]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {CACHE, ROOT, opt, sha256File, conceptText, textValueOk, layerIndex, linker, bookWordCounts, relevance, select, factWires, writeLayer, checkLayer, byPredicate, writeProvenance} from './common.mjs';

const LAYER = 'free-genericskb-slice-v1';
const DIR = path.join(CACHE, 'genericskb');
const GZ = path.join(DIR, 'GenericsKB-Best.tsv.gz');
// the last revision of the Hugging Face dataset repository that still holds the original TSV release (later revisions hold Parquet)
const URL_GZ = 'https://huggingface.co/datasets/community-datasets/generics_kb/resolve/32a04d2f4369c26541fe5875af5a5d6fe1c221aa/data/GenericsKB-Best.tsv.gz';
const SOURCES = new Set(['Waterloo']);
/** Quantifiers of a row that keep a generic typical ("most", "usually"); "some", "many", "sometimes" do not. */
const TYPICAL_QUANTIFIERS = new Set(['most', 'all', 'every', 'usually', 'always', 'typically', 'generally', 'normally']);
/** Sentence shapes after the subject (the rest of the sentence, lowercased, without the final full stop). */
const PATTERNS = [
  [/^(?:are|is) made (?:of|from) (?:an? )?([a-z ]+)$/, 'made_of_material', 'entity'],
  [/^(?:have|has) (?:an? )?([a-z ]+)$/, 'typically_has', 'entity'],
  [/^(?:live|lives|grow|grows|are found|is found) in (?:the |an? )?([a-z ]+)$/, 'found_at', 'entity'],
  [/^(?:are|is) (?:an? )?part of (?:the |an? )?([a-z ]+)$/, 'part_of', 'entity'],
  [/^can ([a-z ]+)$/, 'capable_of', 'text'],
  [/^(?:are|is) used (?:for|to) ([a-z ]+)$/, 'used_for', 'text'],
  [/^(?:are|is) ([a-z]+)$/, 'typical_property', 'adjective']
];

async function fetchSource() {
  fs.mkdirSync(DIR, {recursive: true});
  const res = await fetch(URL_GZ);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  fs.writeFileSync(GZ, Buffer.from(await res.arrayBuffer()));
  writeProvenance(DIR, {
    source: 'GenericsKB-Best (GenericsKB-Best.tsv.gz), Hugging Face dataset community-datasets/generics_kb at the revision that still holds the original TSV files',
    url: URL_GZ, retrieved_at: new Date().toISOString(), retrieved_by: process.env.CHATSOP_ACTOR ?? 'free-sources-agent', file: path.basename(GZ), bytes: fs.statSync(GZ).size, sha256: sha256File(GZ),
    licence: 'CC BY 4.0: dataset card (README.md) of huggingface.co/datasets/community-datasets/generics_kb, section Licensing Information ("The GenericsKB is available under the Creative Commons - Attribution 4.0 International - licence"). Per part: only Waterloo rows are used; ARC (CC BY-SA 4.0), SimpleWikipedia (CC BY-SA), ConceptNet-synthesized, TupleKB and WordNet rows are not. See docs/specs/DS011-source-rights.md.',
    use: `tools/commonsense/free-sources/genericskb.mjs build -> config/knowledge/${LAYER}/`
  });
}

/** The single-word lemmas of a WordNet 3.0 index file. */
const wordnetWords = file => new Set(fs.readFileSync(path.join(ROOT, 'datasets_sources/wordnet-3.0/dict', file), 'utf8').split('\n').filter(l => l && !l.startsWith('  ')).map(l => l.split(' ')[0]).filter(w => /^[a-z]+$/.test(w)));
/** Single-word WordNet adjectives that are not nouns (a quality word, never a thing: "nocturnal", not "giant"). */
function adjectives() {
  const nouns = wordnetWords('index.noun');
  return new Set([...wordnetWords('index.adj')].filter(w => !nouns.has(w)));
}

const plurals = term => [term, term + 's', term + 'es', term.replace(/y$/, 'ies'), term.replace(/(?:f|fe)$/, 'ves')];

function build() {
  const max = Number(opt('--max', 1500));
  const index = layerIndex(), link = linker(index), rel = relevance(index, bookWordCounts());
  const adj = adjectives(), adv = wordnetWords('index.adv');
  const cands = [];
  let read = 0, fromSources = 0, shaped = 0;
  for (const line of zlib.gunzipSync(fs.readFileSync(GZ)).toString('utf8').split('\n').slice(1)) {
    const [source, term, quantifier, sentence, score] = line.split('\t');
    if (!sentence) continue;
    read++;
    const q = /'(number|frequency)': '(\w+)'/.exec(quantifier ?? '');
    if (!SOURCES.has(source) || (quantifier && !(q && TYPICAL_QUANTIFIERS.has(q[2].toLowerCase())))) continue;
    fromSources++;
    const t = conceptText(term);
    let s = sentence.toLowerCase().replace(/\.$/, '').trim();
    // the quantifier the row names is removed from the sentence: a leading number word ("most owls are ..."), or one frequency word
    if (q?.[1] === 'number') s = s.replace(new RegExp(`^${q[2].toLowerCase()} `), '');
    if (q?.[1] === 'frequency') s = s.replace(new RegExp(` ${q[2].toLowerCase()} `), ' ');
    const form = plurals(t).find(p => s.startsWith(p + ' '));
    if (!form) continue;
    const restText = s.slice(form.length + 1);
    for (const [re, pred, kind] of PATTERNS) {
      const m = re.exec(restText);
      if (!m) continue;
      const value = conceptText(m[1].trim());
      const subj = link(t);
      if (!subj) break;
      let obj;
      if (kind === 'entity') { obj = link(value); if (!obj || obj === subj) break; }
      else if (kind === 'adjective') { if (!adj.has(value)) break; obj = JSON.stringify(value); }
      // an ability or a use starts with its verb: not "be" (a state, "can be found"), not an adverb ("can also ...", "can therefore ...")
      else { if (!textValueOk(value) || value.split(' ').length > 4 || value.startsWith('be ') || adv.has(value.split(' ')[0])) break; obj = JSON.stringify(value); }
      shaped++;
      cands.push({pred, subj, obj, conf: Number(score), source: `GenericsKB-Best ${source} term '${t}' ${pred} '${value}' score ${Number(score).toFixed(3)} (CC BY 4.0)`});
      break;
    }
  }
  const facts = select(cands, {index, rel, max, perSubject: 6});
  const notice = [
    'Derived from GenericsKB-Best (https://allenai.org/data/genericskb): Sumithra Bhakthavatsalam, Chloe Anastasiades and Peter Clark, "GenericsKB: A Knowledge',
    'Base of Generic Statements", 2020 (arXiv:2005.00660). Allen Institute for AI. Licence: Creative Commons Attribution 4.0 International',
    '(https://creativecommons.org/licenses/by/4.0/). Changes: only rows of the Waterloo source without a quantifier or with a typical one whose sentence has one of seven simple',
    'shapes; each such sentence reduced to a typed fact (subject class, ChatSOP predicate, value); no sentence is kept; subjects (and entity objects)',
    'restricted to classes of core-min, core-en and commonsense-v1; selected by book relevance and score (max ' + max + ').'];
  const files = writeLayer(LAYER, {
    name: 'GenericsKB slice (candidate)',
    description: 'Candidate common-sense layer, not loaded by any chat base memory: typical properties, abilities, uses, parts, materials and places of common things reduced to typed facts from simple generic sentences of GenericsKB-Best (Bhakthavatsalam, Anastasiades and Clark, 2020, Allen Institute for AI), CC BY 4.0, attribution required; modified (sentences reduced to facts, filtered and selected; no sentence kept). Provenance on every wire; sources and licences in docs/specs/DS011-source-rights.md.',
    imports: ['core-min', 'core-en', 'commonsense-v1'], chat: false, licence: 'CC BY 4.0'
  }, [{base: '0100-genericskb', title: 'typical properties, abilities, uses, parts, materials and places from GenericsKB-Best (CC BY 4.0)', generator: 'tools/commonsense/free-sources/genericskb.mjs', notice, wires: factWires(facts, 'gkb_')}]);
  const stats = {source: 'GenericsKB-Best', rows_read: read, rows_of_used_sources: fromSources, shaped_rows: shaped, candidates: cands.length, selected: facts.length, by_predicate: byPredicate(facts), files, check: checkLayer(LAYER)};
  fs.writeFileSync(path.join(DIR, 'build-stats.json'), JSON.stringify(stats, null, 1) + '\n');
  console.log(JSON.stringify(stats, null, 1));
  if (!stats.check.ok) process.exit(1);
}

const cmd = process.argv[2];
if (cmd === 'fetch') await fetchSource();
else if (cmd === 'build') build();
else { console.error('usage: genericskb.mjs fetch|build [--max 1500]'); process.exit(2); }
