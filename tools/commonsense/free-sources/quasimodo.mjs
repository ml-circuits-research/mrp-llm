#!/usr/bin/env node
/**
 * Builds the candidate layer `config/knowledge/free-quasimodo-slice-v1/` from Quasimodo v1.2 (Romero, Razniewski, Pal, Pan, Sakhadeo and
 * Weikum, CIKM 2019; Max Planck Institute for Informatics; CC BY 2.0): positive statements with the predicates that map onto the
 * commonsense-v1 vocabulary: can -> capable_of; has_property, has_color, has_trait -> typical_property; be used for -> used_for (text);
 * has_body_part -> typically_has; be made of -> made_of_material; live in, be found in -> found_at (the object a linked class).
 * Confidence is the source's plausibility score; a property has at most two words and no leading preposition (a place phrase is not a quality); the evidence sentences of the release (query-log and forum text) are never kept.
 *   node tools/commonsense/free-sources/quasimodo.mjs fetch   (downloads the 110 MB zip, keeps only the filtered TSV, deletes the zip)
 *   node tools/commonsense/free-sources/quasimodo.mjs build [--max 1500]
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {spawn} from 'node:child_process';
import {CACHE, opt, sha256File, conceptText, textValueOk, layerIndex, linker, bookWordCounts, relevance, select, factWires, writeLayer, checkLayer, byPredicate, writeProvenance} from './common.mjs';

const LAYER = 'free-quasimodo-slice-v1';
const DIR = path.join(CACHE, 'quasimodo');
const ZIP = path.join(DIR, 'quasimodo-v1.2.zip');
const OUT = path.join(DIR, 'quasimodo-v1.2-mapped.tsv');
const URL_ZIP = 'https://www.mpi-inf.mpg.de/fileadmin/inf/d5/research/quasimodo/quasimodo-v1.2.zip';
const TEXT_PRED = {'can': 'capable_of', 'has_property': 'typical_property', 'has_color': 'typical_property', 'has_trait': 'typical_property', 'be used for': 'used_for'};
const ENTITY_PRED = {'has_body_part': 'typically_has', 'be made of': 'made_of_material', 'live in': 'found_at', 'be found in': 'found_at'};

async function fetchSource() {
  fs.mkdirSync(DIR, {recursive: true});
  if (!fs.existsSync(ZIP)) {
    const res = await fetch(URL_ZIP);
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    fs.writeFileSync(ZIP, Buffer.from(await res.arrayBuffer()));
  }
  const zipBytes = fs.statSync(ZIP).size, zipSha = sha256File(ZIP);
  const out = fs.createWriteStream(OUT);
  out.write('subject\tpredicate\tobject\tscore\n');
  let lines = 0, kept = 0;
  const unzip = spawn('unzip', ['-p', ZIP, 'quasimodo-v1.2.tsv']);
  for await (const line of readline.createInterface({input: unzip.stdout, crlfDelay: Infinity})) {
    lines++;
    // columns: subject, predicate, object, modality, is_negative, score, evidence sentences, local sigma, tau
    const f = line.split('\t');
    if (f[4] !== '0' || !(TEXT_PRED[f[1]] || ENTITY_PRED[f[1]])) continue;
    out.write([f[0], f[1], f[2], f[5]].join('\t') + '\n');
    kept++;
  }
  await new Promise(resolve => out.end(resolve));
  fs.rmSync(ZIP);
  writeProvenance(DIR, {
    source: 'Quasimodo v1.2 full KB (quasimodo-v1.2.zip), linked from https://www.mpi-inf.mpg.de/departments/databases-and-information-systems/research/yago-naga/commonsense/quasimodo; filtered locally, the zip was deleted after filtering',
    url: URL_ZIP, retrieved_at: new Date().toISOString(), retrieved_by: process.env.CHATSOP_ACTOR ?? 'free-sources-agent', archive_bytes: zipBytes, archive_sha256: zipSha,
    filter: `positive statements (is_negative 0) with predicate in ${[...Object.keys(TEXT_PRED), ...Object.keys(ENTITY_PRED)].join(', ')}; columns subject, predicate, object, score (evidence sentences dropped)`,
    file: path.basename(OUT), lines_read: lines, lines_kept: kept, bytes: fs.statSync(OUT).size, sha256: sha256File(OUT),
    licence: 'CC BY 2.0: the Quasimodo page of the Max Planck Institute for Informatics ("All data and code are released under CC-BY 2.0"). Statements were mined from search-engine query logs and question-answering forums; only the short statement phrases are taken, never the evidence sentences. See docs/specs/DS011-source-rights.md.',
    use: `tools/commonsense/free-sources/quasimodo.mjs build -> config/knowledge/${LAYER}/`
  });
  console.log(JSON.stringify({lines, kept}));
}

function build() {
  const max = Number(opt('--max', 1500));
  const index = layerIndex(), link = linker(index), rel = relevance(index, bookWordCounts());
  const cands = [];
  let read = 0;
  for (const line of fs.readFileSync(OUT, 'utf8').split('\n').slice(1)) {
    const [s, p, o, sc] = line.split('\t');
    if (!o) continue;
    read++;
    const head = conceptText(s), tail = conceptText(o), conf = Number(sc);
    if (!(conf >= 0.6)) continue;
    const subj = link(head);
    if (!subj) continue;
    let obj;
    if (TEXT_PRED[p]) { if (!textValueOk(tail) || tail.split(' ').length > (TEXT_PRED[p] === 'typical_property' ? 2 : 4) || /^(in|on|at|of|for|to|from|with) /.test(tail)) continue; obj = JSON.stringify(tail); }
    else { obj = link(tail); if (!obj || obj === subj) continue; }
    cands.push({pred: TEXT_PRED[p] ?? ENTITY_PRED[p], subj, obj, conf, source: `Quasimodo v1.2 '${head}' '${p}' '${tail}' score ${conf.toFixed(3)} (CC BY 2.0)`});
  }
  const facts = select(cands, {index, rel, max, perSubject: 6, share: {typical_property: 0.45, capable_of: 0.35}});
  const notice = [
    'Derived from Quasimodo v1.2 (https://www.mpi-inf.mpg.de/departments/databases-and-information-systems/research/yago-naga/commonsense/quasimodo):',
    'Julien Romero, Simon Razniewski, Koninika Pal, Jeff Z. Pan, Archit Sakhadeo and Gerhard Weikum, "Commonsense Properties from Query Logs and Question',
    'Answering Forums", CIKM 2019. Max Planck Institute for Informatics. Licence: Creative Commons Attribution 2.0 (https://creativecommons.org/licenses/by/2.0/).',
    'Changes: positive statements of the predicates can, has_property, has_color, has_trait, be used for, has_body_part, be made of, live in, be found in only,',
    'mapped onto ChatSOP predicates; score >= 0.6; subjects (and entity objects) restricted to classes of core-min, core-en and commonsense-v1; selected by book relevance and score (max ' + max + ').'];
  const files = writeLayer(LAYER, {
    name: 'Quasimodo slice (candidate)',
    description: 'Candidate common-sense layer, not loaded by any chat base memory: typical abilities, properties, colours, uses, body parts, materials and places of common things from Quasimodo v1.2 (Romero et al., CIKM 2019, Max Planck Institute for Informatics), CC BY 2.0, attribution required; modified (predicates mapped onto ChatSOP predicates, filtered and selected). Provenance on every wire; sources and licences in docs/specs/DS011-source-rights.md.',
    imports: ['core-min', 'core-en', 'commonsense-v1'], chat: false, licence: 'CC BY 2.0'
  }, [{base: '0100-quasimodo', title: 'typical abilities, properties, uses, parts, materials and places from Quasimodo v1.2 (CC BY 2.0)', generator: 'tools/commonsense/free-sources/quasimodo.mjs', notice, wires: factWires(facts, 'qsm_')}]);
  const stats = {source: 'Quasimodo v1.2', rows_read: read, candidates: cands.length, selected: facts.length, by_predicate: byPredicate(facts), files, check: checkLayer(LAYER)};
  fs.writeFileSync(path.join(DIR, 'build-stats.json'), JSON.stringify(stats, null, 1) + '\n');
  console.log(JSON.stringify(stats, null, 1));
  if (!stats.check.ok) process.exit(1);
}

const cmd = process.argv[2];
if (cmd === 'fetch') await fetchSource();
else if (cmd === 'build') build();
else { console.error('usage: quasimodo.mjs fetch|build [--max 1500]'); process.exit(2); }
