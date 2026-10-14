#!/usr/bin/env node
/**
 * Builds the candidate layer `config/knowledge/free-atomic2020-slice-v1/` from ATOMIC 2020 (Hwang et al., AAAI 2021; CC BY 4.0):
 * only the physical-entity relations, mapped onto the commonsense-v1 predicates:
 *   ObjectUse -> used_for (text), CapableOf -> capable_of (text), HasProperty -> typical_property (text),
 *   AtLocation -> found_at (a linked class), MadeUpOf -> typically_has (a linked class: "a bicycle is made up of wheels").
 * The social and event relations (xIntent, xWant, HinderedBy, ...) have no predicate in the layers and are not taken. ATOMIC 2020 has
 * no confidence score: a shorter tail counts more (a general use, not a situation), text tails have at most four words, a subject
 * gets at most five facts and used_for at most 60% of the slice. ATOMIC 2020 took part of its physical
 * relations from ConceptNet 5 without a per-tuple licence mark: a tuple that equals a ConceptNet edge whose own licence is CC BY-SA
 * (datasets_sources/commonsense/conceptnet-en-6rel.tsv) is left out, so no ShareAlike edge enters through ATOMIC.
 *   node tools/commonsense/free-sources/atomic2020.mjs fetch     (download the release zip into the cache, write provenance.json)
 *   node tools/commonsense/free-sources/atomic2020.mjs build [--max 1500]
 */
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {CACHE, ROOT, opt, sha256File, conceptText, textValueOk, layerIndex, linker, bookWordCounts, relevance, select, factWires, writeLayer, checkLayer, byPredicate, writeProvenance} from './common.mjs';

const LAYER = 'free-atomic2020-slice-v1';
const DIR = path.join(CACHE, 'atomic2020');
const ZIP = path.join(DIR, 'atomic2020_data-feb2021.zip');
const URL_ZIP = 'https://drive.usercontent.google.com/download?id=1uuY0Y_s8dhxdsoOe8OHRgsqf-9qJIai7&export=download&confirm=t';
const TEXT_REL = {ObjectUse: 'used_for', CapableOf: 'capable_of', HasProperty: 'typical_property'};
const ENTITY_REL = {AtLocation: 'found_at', MadeUpOf: 'typically_has'};
const CN_REL = {ObjectUse: 'UsedFor', CapableOf: 'CapableOf', HasProperty: 'HasProperty', AtLocation: 'AtLocation', MadeUpOf: 'MadeOf'};

async function fetchSource() {
  fs.mkdirSync(DIR, {recursive: true});
  const res = await fetch(URL_ZIP);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  fs.writeFileSync(ZIP, Buffer.from(await res.arrayBuffer()));
  writeProvenance(DIR, {
    source: 'ATOMIC 2020 knowledge graph (atomic2020_data-feb2021.zip), linked from the README of github.com/allenai/comet-atomic-2020',
    url: URL_ZIP, retrieved_at: new Date().toISOString(), retrieved_by: process.env.CHATSOP_ACTOR ?? 'free-sources-agent', file: path.basename(ZIP), bytes: fs.statSync(ZIP).size, sha256: sha256File(ZIP),
    licence: 'CC BY 4.0: the README of github.com/allenai/comet-atomic-2020 ("The ATOMIC 2020 dataset is licensed under CC-BY") and the LICENSE file inside the zip (Creative Commons Attribution 4.0 International, full legal code). Part of the physical relations comes from ConceptNet 5; tuples equal to a CC BY-SA ConceptNet edge are not exported. See docs/specs/DS011-source-rights.md.',
    use: `tools/commonsense/free-sources/atomic2020.mjs build -> config/knowledge/${LAYER}/`
  });
}

/** Keys "Rel head tail" of the ConceptNet edges whose own licence is CC BY-SA, and of those whose licence is CC BY. */
function conceptNetLicences() {
  const bySa = new Set(), by = new Set();
  const file = path.join(ROOT, 'datasets_sources/commonsense/conceptnet-en-6rel.tsv');
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    const [rel, s, e, meta] = line.split('\t');
    const lic = /"license": "([^"]+)"/.exec(meta)?.[1];
    const c = uri => conceptText(/^\/c\/en\/([^/]+)/.exec(uri)?.[1] ?? '');
    (lic === 'cc:by-sa/4.0' ? bySa : by).add(`${rel.slice(3)} ${c(s)} ${c(e)}`);
  }
  return {bySa, by};
}

function build() {
  const max = Number(opt('--max', 1500));
  const index = layerIndex(), link = linker(index), rel = relevance(index, bookWordCounts());
  const cn = conceptNetLicences();
  const text = execFileSync('unzip', ['-p', ZIP, 'atomic2020_data-feb2021/train.tsv', 'atomic2020_data-feb2021/dev.tsv', 'atomic2020_data-feb2021/test.tsv'], {maxBuffer: 1 << 28}).toString('utf8');
  const cands = [];
  let read = 0, physical = 0, droppedBySa = 0;
  for (const line of text.split('\n')) {
    const [h, r, t] = line.split('\t');
    if (!t) continue;
    read++;
    if (!TEXT_REL[r] && !ENTITY_REL[r]) continue;
    physical++;
    const head = conceptText(h), tail = conceptText(t);
    if (!tail || tail === 'none' || /person[xyz]|___/i.test(head + ' ' + tail)) continue;
    const key = `${CN_REL[r]} ${head} ${tail}`;
    if (cn.bySa.has(key) && !cn.by.has(key)) { droppedBySa++; continue; }
    const subj = link(head);
    if (!subj) continue;
    let obj;
    if (TEXT_REL[r]) { if (!textValueOk(tail) || tail.split(' ').length > 4) continue; obj = JSON.stringify(tail); }
    else { obj = link(tail); if (!obj || obj === subj) continue; }
    cands.push({pred: TEXT_REL[r] ?? ENTITY_REL[r], subj, obj, conf: 1 / tail.split(' ').length, source: `ATOMIC 2020 ${r} "${head}" "${tail}" (CC BY 4.0)`.replace(/"/g, "'")});
  }
  const facts = select(cands, {index, rel, max, perSubject: 5, share: {used_for: 0.6}});
  const notice = [
    'Derived from ATOMIC 2020 (https://allenai.org/data/atomic-2020): Jena D. Hwang, Chandra Bhagavatula, Ronan Le Bras, Jeff Da, Keisuke Sakaguchi,',
    'Antoine Bosselut and Yejin Choi, "(Comet-) Atomic 2020: On Symbolic and Neural Commonsense Knowledge Graphs", AAAI 2021. Allen Institute for AI.',
    'Licence: Creative Commons Attribution 4.0 International (https://creativecommons.org/licenses/by/4.0/).',
    'Changes: only the physical relations ObjectUse, CapableOf, HasProperty, AtLocation, MadeUpOf; mapped onto ChatSOP predicates; subjects (and entity objects)',
    'restricted to classes of core-min, core-en and commonsense-v1; tuples equal to a CC BY-SA ConceptNet edge removed; selected by book relevance (max ' + max + ').'];
  const files = writeLayer(LAYER, {
    name: 'ATOMIC 2020 slice (candidate)',
    description: 'Candidate common-sense layer, not loaded by any chat base memory: typical uses, abilities, properties, places and parts of common things from ATOMIC 2020 (Hwang et al., AAAI 2021, Allen Institute for AI), CC BY 4.0, attribution required; modified (relations mapped onto ChatSOP predicates, filtered and selected). Provenance on every wire; sources and licences in docs/specs/DS011-source-rights.md.',
    imports: ['core-min', 'core-en', 'commonsense-v1'], chat: false, licence: 'CC BY 4.0'
  }, [{base: '0100-atomic2020', title: 'typical uses, abilities, properties, places and parts from ATOMIC 2020 (CC BY 4.0)', generator: 'tools/commonsense/free-sources/atomic2020.mjs', notice, wires: factWires(facts, 'at20_')}]);
  const stats = {source: 'ATOMIC 2020', tuples_read: read, physical_tuples: physical, dropped_conceptnet_by_sa: droppedBySa, candidates: cands.length, selected: facts.length, by_predicate: byPredicate(facts), files, check: checkLayer(LAYER)};
  fs.writeFileSync(path.join(DIR, 'build-stats.json'), JSON.stringify(stats, null, 1) + '\n');
  console.log(JSON.stringify(stats, null, 1));
  if (!stats.check.ok) process.exit(1);
}

const cmd = process.argv[2];
if (cmd === 'fetch') await fetchSource();
else if (cmd === 'build') build();
else { console.error('usage: atomic2020.mjs fetch|build [--max 1500]'); process.exit(2); }
