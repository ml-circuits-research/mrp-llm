#!/usr/bin/env node
/**
 * Builds the separate layer `config/knowledge/conceptnet-bysa-v1/` from the ConceptNet 5.7 edges whose own licence is CC BY-SA 4.0
 * (the Wiktionary and DBpedia imports, and a few Open Mind Common Sense edges so marked), which commonsense-v1 does not take. The edges
 * come from the cache that tools/commonsense/build.mjs reads (datasets_sources/commonsense/conceptnet-en-6rel.tsv, English to English,
 * relations IsA, PartOf, UsedFor, CapableOf, AtLocation, HasProperty, HasA, MadeOf); of those, only IsA, PartOf and AtLocation carry
 * CC BY-SA edges. Mapping: IsA -> is_a, PartOf -> part_of, AtLocation -> found_at, when both concepts name a linkable class of core-min,
 * core-en or commonsense-v1 (no new class is declared; the DBpedia edges, which are about named things, are left out), the fact is not already held, and an is_a does not invert one already held.
 * The layer is ShareAlike: it is `"chat": false`, no base memory imports it, and whether ShareAlike data may enter a base memory is the
 * owner's question Q-DATA-8 in questions.md.
 *   node tools/commonsense/free-sources/conceptnet-bysa.mjs build [--min-weight 0.5]
 */
import fs from 'node:fs';
import path from 'node:path';
import {CACHE, ROOT, opt, sha256File, conceptText, layerIndex, linker, bookWordCounts, relevance, factWires, writeLayer, checkLayer, byPredicate, writeProvenance} from './common.mjs';

const LAYER = 'conceptnet-bysa-v1';
const DIR = path.join(CACHE, 'conceptnet-bysa');
const CN = path.join(ROOT, 'datasets_sources/commonsense/conceptnet-en-6rel.tsv');
const REL = {IsA: 'is_a', PartOf: 'part_of', AtLocation: 'found_at'};

function build() {
  const minWeight = Number(opt('--min-weight', 0.5));
  const index = layerIndex(), link = linker(index), rel = relevance(index, bookWordCounts());
  const seen = new Set(), facts = [];
  const datasets = {};
  let read = 0, bySa = 0;
  for (const line of fs.readFileSync(CN, 'utf8').split('\n')) {
    if (!line) continue;
    read++;
    const [r, s, e, meta] = line.split('\t');
    const m = JSON.parse(meta);
    if (m.license !== 'cc:by-sa/4.0' || m.weight < minWeight) continue;
    bySa++;
    // DBpedia edges are about named things (the band "Animal" is a band, the book "Abyss" is a book), never about a class
    if (m.dataset.startsWith('/d/dbpedia')) continue;
    const name = r.slice(3), pred = REL[name];
    if (!pred) continue;
    const a = conceptText(/^\/c\/en\/([^/]+)/.exec(s)?.[1] ?? ''), b = conceptText(/^\/c\/en\/([^/]+)/.exec(e)?.[1] ?? '');
    const subj = link(a), obj = link(b);
    if (!subj || !obj || subj === obj) continue;
    const key = `${pred} ${subj} ${obj}`;
    if (seen.has(key) || index.holds.has(key) || (pred === 'is_a' && index.holds.has(`is_a ${obj} ${subj}`)) || (pred === 'is_a' && seen.has(`is_a ${obj} ${subj}`))) continue;
    seen.add(key);
    datasets[m.dataset] = (datasets[m.dataset] ?? 0) + 1;
    facts.push({pred, subj, obj, conf: m.weight, rel: Math.max(rel(subj), rel(obj)), source: `ConceptNet 5.7 /r/${name} ${s} ${e} weight ${m.weight} dataset ${m.dataset} (CC BY-SA 4.0)`});
  }
  const notice = [
    'Derived from ConceptNet 5.7 (https://conceptnet.io), only edges whose own licence is CC BY-SA 4.0 (the English, French and German Wiktionary imports',
    'and a few Open Mind Common Sense edges so marked; DBpedia edges, about named things, are left out). ConceptNet 5 by Robyn Speer, Joshua Chin and Catherine Havasi (Luminoso / MIT Media',
    'Lab), with data from Wiktionary (Wikimedia contributors). Licence: Creative Commons Attribution-ShareAlike 4.0 International',
    '(https://creativecommons.org/licenses/by-sa/4.0/). ShareAlike: this file and any adaptation of it may be shared only under CC BY-SA 4.0 or a compatible licence.',
    `Changes: relations IsA, PartOf, AtLocation mapped onto is_a, part_of, found_at; weight >= ${minWeight}; both concepts restricted to classes of core-min, core-en`,
    'and commonsense-v1; facts already held and inverted is_a removed.'];
  const files = writeLayer(LAYER, {
    name: 'ConceptNet 5.7 CC BY-SA edges (separate, ShareAlike)',
    description: 'Separate ShareAlike layer, not loaded by any chat base memory and not imported by world-v1: class hierarchy (is_a), parts and typical places between the common-noun classes from the ConceptNet 5.7 edges whose own licence is CC BY-SA 4.0 (Wiktionary imports). ConceptNet 5 by Robyn Speer, Joshua Chin and Catherine Havasi; data from Wiktionary contributors. Licence CC BY-SA 4.0: attribution and ShareAlike pass to every adaptation; modified (relations mapped onto ChatSOP predicates, filtered). Whether it may enter a base memory is the owner question Q-DATA-8 (questions.md). Sources and licences in docs/specs/DS011-source-rights.md.',
    imports: ['core-min', 'core-en', 'commonsense-v1'], chat: false, licence: 'CC BY-SA 4.0'
  }, [{base: '0100-conceptnet-bysa', title: 'is_a, part_of and found_at between common-noun classes from the CC BY-SA 4.0 edges of ConceptNet 5.7', generator: 'tools/commonsense/free-sources/conceptnet-bysa.mjs', notice, wires: factWires(facts, 'cnsa_')}]);
  writeProvenance(DIR, {
    source: 'the cached ConceptNet 5.7 extract of commonsense-v1 (no new download): datasets_sources/commonsense/conceptnet-en-6rel.tsv, see datasets_sources/commonsense/provenance.json',
    url: 'https://s3.amazonaws.com/conceptnet/downloads/2019/edges/conceptnet-assertions-5.7.0.csv.gz', retrieved_at: '2026-10-02T09:52:00Z (by commonsense-agent; reused)', file: path.relative(ROOT, CN), bytes: fs.statSync(CN).size, sha256: sha256File(CN),
    licence: 'per edge (metadata field license); this layer takes only cc:by-sa/4.0 edges. ConceptNet README: the whole is available under CC BY-SA 4.0. See docs/specs/DS011-source-rights.md.',
    use: `tools/commonsense/free-sources/conceptnet-bysa.mjs build -> config/knowledge/${LAYER}/`
  });
  const stats = {source: 'ConceptNet 5.7 CC BY-SA edges', lines_read: read, by_sa_edges: bySa, selected: facts.length, by_predicate: byPredicate(facts), by_dataset: datasets, files, check: checkLayer(LAYER)};
  fs.writeFileSync(path.join(DIR, 'build-stats.json'), JSON.stringify(stats, null, 1) + '\n');
  console.log(JSON.stringify(stats, null, 1));
  if (!stats.check.ok) process.exit(1);
}

if (process.argv[2] === 'build') build();
else { console.error('usage: conceptnet-bysa.mjs build [--min-weight 0.5]'); process.exit(2); }
