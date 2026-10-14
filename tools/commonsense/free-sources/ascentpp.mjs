#!/usr/bin/env node
/**
 * Builds the candidate layer `config/knowledge/free-ascentpp-slice-v1/` from Ascent++ (Nguyen, Razniewski, Romero and Weikum, TKDE 2022;
 * Max Planck Institute for Informatics; CC BY 4.0): assertions in the ConceptNet schema about primary subjects, mapped onto the
 * commonsense-v1 predicates (UsedFor -> used_for, CapableOf -> capable_of, HasProperty -> typical_property as text; AtLocation ->
 * found_at, HasA -> typically_has, PartOf -> part_of, MadeOf -> made_of_material when the object is a linked class). Confidence is
 * the source's typicality score; subgroup and aspect subjects and the facets are not taken.
 *   node tools/commonsense/free-sources/ascentpp.mjs fetch   (streams the 68 MB archive, keeps only the filtered TSV, writes provenance.json)
 *   node tools/commonsense/free-sources/ascentpp.mjs build [--max 1500]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import {Readable} from 'node:stream';
import {CACHE, opt, conceptText, textValueOk, layerIndex, linker, bookWordCounts, relevance, select, factWires, writeLayer, checkLayer, byPredicate, writeProvenance} from './common.mjs';

const LAYER = 'free-ascentpp-slice-v1';
const DIR = path.join(CACHE, 'ascentpp');
const OUT = path.join(DIR, 'ascentpp-7rel-primary.tsv');
const URL_TGZ = 'https://www.mpi-inf.mpg.de/fileadmin/inf/d5/research/ascentpp/ascentpp.csv.tar.gz';
const TEXT_REL = {UsedFor: 'used_for', CapableOf: 'capable_of', HasProperty: 'typical_property'};
const ENTITY_REL = {AtLocation: 'found_at', HasA: 'typically_has', PartOf: 'part_of', MadeOf: 'made_of_material'};

/** One CSV record (RFC 4180 quoting) as fields. */
function csvFields(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

async function fetchSource() {
  fs.mkdirSync(DIR, {recursive: true});
  const res = await fetch(URL_TGZ);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const hash = crypto.createHash('sha256');
  let bytes = 0, header = null, rest = '', lines = 0, kept = 0, cols = null;
  const out = fs.createWriteStream(OUT);
  out.write('subject\trelation\tobject\tsaliency\ttypicality\n');
  const raw = Readable.fromWeb(res.body);
  raw.on('data', chunk => { hash.update(chunk); bytes += chunk.length; });
  const handle = line => {
    if (!line || line.includes('\0')) return;
    const f = csvFields(line);
    if (!cols) { cols = Object.fromEntries(f.map((c, i) => [c, i])); return; }
    lines++;
    const rel = f[cols.relation];
    if (f[cols.subject_type] !== 'primary' || !(TEXT_REL[rel] || ENTITY_REL[rel])) return;
    out.write([f[cols.head], rel, f[cols.tail], f[cols.saliency], f[cols.typicality]].map(v => String(v).replace(/[\t\n]/g, ' ')).join('\t') + '\n');
    kept++;
  };
  // a tar archive with one member: a 512-byte header, then the file
  for await (const chunk of raw.pipe(zlib.createGunzip())) {
    let text = chunk;
    if (!header) { header = chunk.subarray(0, 512); text = chunk.subarray(512); }
    const parts = (rest + text.toString('utf8')).split('\n');
    rest = parts.pop();
    parts.forEach(handle);
  }
  handle(rest);
  await new Promise(resolve => out.end(resolve));
  writeProvenance(DIR, {
    source: 'Ascent++ KB (ascentpp.csv.tar.gz), linked from https://ascentpp.mpi-inf.mpg.de/; streamed and filtered on the fly, the full dump was never stored',
    url: URL_TGZ, retrieved_at: new Date().toISOString(), retrieved_by: process.env.CHATSOP_ACTOR ?? 'free-sources-agent', archive_bytes: bytes, archive_sha256: hash.digest('hex'),
    filter: 'subject_type primary; relation in UsedFor, CapableOf, HasProperty, AtLocation, HasA, PartOf, MadeOf; columns head, relation, tail, saliency, typicality (facets dropped)',
    file: path.basename(OUT), lines_read: lines, lines_kept: kept, bytes: fs.statSync(OUT).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(OUT)).digest('hex'),
    licence: 'CC BY 4.0: footer of https://ascentpp.mpi-inf.mpg.de/ ("This work is licensed under a Creative Commons Attribution 4.0 International License"). Extracted from the C4 web crawl; only short assertion phrases are taken, never source sentences. See docs/specs/DS011-source-rights.md.',
    use: `tools/commonsense/free-sources/ascentpp.mjs build -> config/knowledge/${LAYER}/`
  });
  console.log(JSON.stringify({lines, kept}));
}

function build() {
  const max = Number(opt('--max', 1500));
  const index = layerIndex(), link = linker(index), rel = relevance(index, bookWordCounts());
  const cands = [];
  let read = 0;
  for (const line of fs.readFileSync(OUT, 'utf8').split('\n').slice(1)) {
    const [s, r, o, sal, typ] = line.split('\t');
    if (!o) continue;
    read++;
    const head = conceptText(s), tail = conceptText(o), conf = Number(typ);
    if (!(conf >= 0.5)) continue;
    const subj = link(head);
    if (!subj) continue;
    let obj;
    if (TEXT_REL[r]) { if (!textValueOk(tail) || tail.split(' ').length > 4) continue; obj = JSON.stringify(tail); }
    else { obj = link(tail); if (!obj || obj === subj) continue; }
    cands.push({pred: TEXT_REL[r] ?? ENTITY_REL[r], subj, obj, conf, source: `Ascent++ ${r} '${head}' '${tail}' typicality ${conf.toFixed(3)} saliency ${Number(sal).toFixed(3)} (CC BY 4.0)`});
  }
  const facts = select(cands, {index, rel, max, perSubject: 6, share: {typical_property: 0.4, capable_of: 0.3, used_for: 0.3}});
  const notice = [
    'Derived from Ascent++ (https://ascentpp.mpi-inf.mpg.de/): Tuan-Phong Nguyen, Simon Razniewski, Julien Romero and Gerhard Weikum, "Refined Commonsense',
    'Knowledge from Large-Scale Web Contents", IEEE TKDE 2022. Max Planck Institute for Informatics.',
    'Licence: Creative Commons Attribution 4.0 International (https://creativecommons.org/licenses/by/4.0/).',
    'Changes: primary subjects only; relations UsedFor, CapableOf, HasProperty, AtLocation, HasA, PartOf, MadeOf mapped onto ChatSOP predicates; typicality >= 0.5;',
    'subjects (and entity objects) restricted to classes of core-min, core-en and commonsense-v1; facets dropped; selected by book relevance and typicality (max ' + max + ').'];
  const files = writeLayer(LAYER, {
    name: 'Ascent++ slice (candidate)',
    description: 'Candidate common-sense layer, not loaded by any chat base memory: typical uses, abilities, properties, places, parts and materials of common things from Ascent++ (Nguyen, Razniewski, Romero and Weikum, TKDE 2022, Max Planck Institute for Informatics), CC BY 4.0, attribution required; modified (relations mapped onto ChatSOP predicates, filtered and selected). Provenance on every wire; sources and licences in docs/specs/DS011-source-rights.md.',
    imports: ['core-min', 'core-en', 'commonsense-v1'], chat: false, licence: 'CC BY 4.0'
  }, [{base: '0100-ascentpp', title: 'typical uses, abilities, properties, places, parts and materials from Ascent++ (CC BY 4.0)', generator: 'tools/commonsense/free-sources/ascentpp.mjs', notice, wires: factWires(facts, 'ascpp_')}]);
  const stats = {source: 'Ascent++', rows_read: read, candidates: cands.length, selected: facts.length, by_predicate: byPredicate(facts), files, check: checkLayer(LAYER)};
  fs.writeFileSync(path.join(DIR, 'build-stats.json'), JSON.stringify(stats, null, 1) + '\n');
  console.log(JSON.stringify(stats, null, 1));
  if (!stats.check.ok) process.exit(1);
}

const cmd = process.argv[2];
if (cmd === 'fetch') await fetchSource();
else if (cmd === 'build') build();
else { console.error('usage: ascentpp.mjs fetch|build [--max 1500]'); process.exit(2); }
