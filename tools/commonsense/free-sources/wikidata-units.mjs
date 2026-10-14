#!/usr/bin/env node
/**
 * Builds the candidate layer `config/knowledge/free-wikidata-units-slice-v1/` from Wikidata (structured data, CC0): units of
 * measurement with a "conversion to SI unit" (P2370) whose SI unit is the metre, kilogram, second, square metre or cubic metre, that
 * commonsense-v1 and core-en lack, that are common (at least MIN_SITELINKS Wikipedia articles) and whose name occurs in the owner's problem
 * books (token statistics only). Per unit:
 *   - an entity of kind unit (the English label, a plural alias, the English aliases and symbols that are no English word and no name
 *     of the layers below);
 *   - `dimension_of` (mass, length, duration, surface area, volume) and `base_amount` (the integer of commonsense-v1's fine base units:
 *     mg, micrometre, ms, square millimetre, microlitre) when the rounding error is at most 0.5 %;
 *   - `si_factor` (new, declared here): the exact decimal factor to the coherent SI unit, as Wikidata states it (a rational term).
 * A label that names two Wikidata units (the US and the imperial gallon) is ambiguous and left out. "Conversion to standard unit"
 * (P2442) is read too and recorded in the statistics; it adds no unit here because every unit of the five dimensions it names also has
 * P2370 or a non-SI target.
 *   node tools/commonsense/free-sources/wikidata-units.mjs fetch   (two SPARQL queries to query.wikidata.org, raw JSON in the cache)
 *   node tools/commonsense/free-sources/wikidata-units.mjs build [--max 120]
 */
import fs from 'node:fs';
import path from 'node:path';
import {CACHE, ROOT, opt, sha256File, layerIndex, bookWordCounts, factWires, writeLayer, checkLayer, takenIds, writeProvenance} from './common.mjs';
import {RATIONAL} from '../../../sop/knowledge/numeric-action.mjs';

const LAYER = 'free-wikidata-units-slice-v1';
const DIR = path.join(CACHE, 'wikidata-units');
const ENDPOINT = 'https://query.wikidata.org/sparql';
const UA = 'ChatSOP-free-sources/1.0 (ChatSOP research tool; contact research@axiologic.net)';
/** SI unit (Wikidata item) -> the dimension entity of commonsense-v1 and the number of its fine base units in one SI unit. */
/** The fewest Wikipedia sitelinks of a unit taken (a common unit; the light-minute and the board foot have fewer). */
const MIN_SITELINKS = 20;
/** The fewest book occurrences of the rarest word of the unit's best name. */
const MIN_BOOK_COUNT = 20;
const SI = {Q11573: ['length', 1e6], Q11570: ['mass', 1e6], Q11574: ['duration_dimension', 1e3], Q25343: ['surface_area', 1e6], Q25517: ['volume', 1e9]};
const query = prop => `SELECT ?u ?uLabel ?f ?si ?links (GROUP_CONCAT(DISTINCT ?alt; separator="|") AS ?alts) (GROUP_CONCAT(DISTINCT ?sym; separator="|") AS ?syms) WHERE {
  ?u p:${prop} ?st . ?st psv:${prop} ?v . ?v wikibase:quantityAmount ?f ; wikibase:quantityUnit ?si .
  ?st wikibase:rank ?rank . FILTER(?rank != wikibase:DeprecatedRank)
  ?u rdfs:label ?uLabel . FILTER(LANG(?uLabel) = "en")
  OPTIONAL { ?u skos:altLabel ?alt . FILTER(LANG(?alt) = "en") }
  OPTIONAL { ?u wdt:P5061 ?sym }
  ?u wikibase:sitelinks ?links .
} GROUP BY ?u ?uLabel ?f ?si ?links`;

async function fetchSource() {
  fs.mkdirSync(DIR, {recursive: true});
  const files = [];
  for (const prop of ['P2370', 'P2442']) {
    const res = await fetch(ENDPOINT, {method: 'POST', headers: {'Accept': 'application/sparql-results+json', 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({query: query(prop)})});
    if (!res.ok) throw new Error(`${prop}: ${res.status}`);
    const file = path.join(DIR, `${prop}.json`);
    fs.writeFileSync(file, await res.text());
    files.push({file: path.basename(file), property: prop, bytes: fs.statSync(file).size, sha256: sha256File(file), rows: JSON.parse(fs.readFileSync(file, 'utf8')).results.bindings.length});
    await new Promise(resolve => setTimeout(resolve, 2500));
  }
  writeProvenance(DIR, {
    source: 'Wikidata Query Service: units with P2370 (conversion to SI unit) and P2442 (conversion to standard unit), with English labels, aliases and symbols (P5061)',
    url: ENDPOINT, retrieved_at: new Date().toISOString(), retrieved_by: process.env.CHATSOP_ACTOR ?? 'free-sources-agent', files, queries: {P2370: query('P2370'), P2442: query('P2442')},
    licence: 'CC0 1.0: Wikidata:Licensing ("All structured data (i.e. the main, Property, Lexeme, and EntitySchema namespaces) is released into the public domain under Creative Commons Zero"). See docs/specs/DS011-source-rights.md.',
    use: `tools/commonsense/free-sources/wikidata-units.mjs build -> config/knowledge/${LAYER}/`
  });
}

const qid = uri => uri.replace('http://www.wikidata.org/entity/', '');
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const wordnet = (files = ['index.noun', 'index.verb', 'index.adj', 'index.adv']) => new Set(files.flatMap(f => fs.readFileSync(path.join(ROOT, 'datasets_sources/wordnet-3.0/dict', f), 'utf8').split('\n').filter(l => l && !l.startsWith('  ')).map(l => l.split(' ')[0])));
/** Plural of a unit name: the head noun takes the plural ("square inch" -> "square inches", "foot-candle" stays regular). */
const plural = name => /(s|x|z|ch|sh)$/.test(name) ? name + 'es' : /[^aeiou]y$/.test(name) ? name.slice(0, -1) + 'ies' : name + 's';

function build() {
  const max = Number(opt('--max', 120));
  const index = layerIndex(), counts = bookWordCounts(), english = wordnet(), verbs = wordnet(['index.verb']), {ids: taken, worldNames} = takenIds(LAYER);
  const rows = JSON.parse(fs.readFileSync(path.join(DIR, 'P2370.json'), 'utf8')).results.bindings;
  const p2442 = JSON.parse(fs.readFileSync(path.join(DIR, 'P2442.json'), 'utf8')).results.bindings;
  // the 300 most frequent book words ("are", "day", "per") are never a unit name of their own
  const frequent = new Set([...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 300).map(([w]) => w));
  const byLabel = new Map();
  for (const r of rows) {
    if (!SI[qid(r.si.value)] || !RATIONAL.test(r.f.value) || Number(r.f.value) <= 0) continue;
    const label = r.uLabel.value.toLowerCase();
    (byLabel.get(label) ?? byLabel.set(label, []).get(label)).push(r);
  }
  const units = [];
  const skipped = {rare: 0, ambiguous: 0, in_layers: 0, not_in_books: 0, common_word: 0, world_name: 0};
  for (const [label, rs] of byLabel) {
    const items = new Set(rs.map(r => r.u.value));
    if (items.size > 1) { skipped.ambiguous++; continue; }
    const r = rs[0];
    if (index.names.has(label) || index.names.has(plural(label))) { skipped.in_layers++; continue; }
    if ((worldNames.get(label) ?? 0) >= 100) { skipped.world_name++; continue; }
    if (!/^[a-z][a-z -]*[a-z]$/.test(label)) continue;
    // a common unit has its own article in many Wikipedias; a rare historical or technical unit does not
    if (Number(r.links.value) < MIN_SITELINKS) { skipped.rare++; continue; }
    // a one-word name must be a word of its own ("micrometre", "century"), not a short or common word ("sol", "link", "step", "are")
    if (!label.includes(' ') && !label.includes('-') && (label.length < 5 || verbs.has(label) || frequent.has(label))) { skipped.common_word++; continue; }
    // book relevance over the label and the aliases (the books may spell "cubic meter"): the rarest word of the best name
    const names = [label, ...r.alts.value.split('|').filter(Boolean).map(a => a.toLowerCase())];
    const rel = Math.max(...names.map(n => { const w = n.match(/[a-z]+/g) ?? []; return w.length ? Math.min(...w.map(x => Math.max(counts.get(x) ?? 0, counts.get(plural(x)) ?? 0))) : 0; }));
    if (rel < MIN_BOOK_COUNT) { skipped.not_in_books++; continue; }
    units.push({q: qid(r.u.value), label, f: r.f.value, si: qid(r.si.value), rel, links: Number(r.links.value), alts: r.alts.value.split('|').filter(Boolean), syms: r.syms.value.split('|').filter(Boolean)});
  }
  units.sort((a, b) => b.links - a.links || (a.label < b.label ? -1 : 1));
  const chosen = units.slice(0, max);
  const usedNames = new Set(chosen.flatMap(u => [u.label, plural(u.label)]));
  const aliasOk = a => !index.names.has(a.toLowerCase()) && !usedNames.has(a.toLowerCase()) && !worldNames.has(a.toLowerCase());
  const entityWires = [], factList = [];
  for (const u of chosen) {
    let id = `wdu_${slug(u.label)}`;
    if (taken.has(id)) id = `wdu_${u.q.toLowerCase()}`;
    const aliases = /us$/.test(u.label) ? [] : [plural(u.label)];
    // an alias names the unit when it shares a word stem with the label ("cubic meter" of "cubic metre"); "centennial" of the century does not
    const stems = new Set(u.label.split(/[\s-]+/).map(w => w.slice(0, 5)));
    for (const a of u.alts) if (a.split(' ').length <= 3 && /^[A-Za-z][A-Za-z .-]*$/.test(a) && a.length >= 3 && a.toLowerCase().split(/[\s.-]+/).some(w => stems.has(w.slice(0, 5))) && aliasOk(a)) aliases.push(a);
    // a symbol is kept when it carries a power sign ("cm²", "km³") or has at least three letters and is no English word ("nmi"; "st", "fs", "in" stay out)
    for (const s of u.syms) if (/^[A-Za-z0-9²³ .\/-]+$/.test(s) && (/[²³]/.test(s) || (s.length >= 3 && !english.has(s.toLowerCase()))) && aliasOk(s)) aliases.push(s);
    const unique = [...new Set(aliases)].filter(a => a !== u.label);
    unique.forEach(a => usedNames.add(a.toLowerCase()));
    entityWires.push([`@${id} entity`, '  kind unit', `  label en ${JSON.stringify(u.label)}`, ...unique.map(a => `  alias en ${JSON.stringify(a)}`), `  source "Wikidata ${u.q}"`, ''].join('\n'));
    const [dimension, scale] = SI[u.si];
    factList.push({pred: 'dimension_of', subj: id, obj: dimension, source: `Wikidata ${u.q} P2370 (unit ${u.si})`});
    factList.push({pred: 'si_factor', subj: id, obj: u.f, source: `Wikidata ${u.q} P2370 ${u.f} ${u.si}`});
    const exact = Number(u.f) * scale, rounded = Math.round(exact);
    if (rounded >= 1 && Number.isSafeInteger(rounded) && Math.abs(rounded - exact) / exact <= 0.005) factList.push({pred: 'base_amount', subj: id, obj: String(rounded), source: `Wikidata ${u.q} P2370 ${u.f} ${u.si}, in the fine base unit of commonsense-v1${rounded === exact ? '' : ' (rounded)'}`});
  }
  const vocabulary = [
    ['@si_factor predicate', '  args subject:entity object:rational', '  role subject unit', '  role object rational', '  label en "SI factor"',
      '  description "One of the unit equals exactly this decimal number of the coherent SI unit of its dimension (metre, kilogram, second, square metre, cubic metre), as Wikidata states it (P2370, conversion to SI unit); base_amount is the integer form in the fine base units."', ''].join('\n'),
    ['@lx_si_factor_en_copula lexeme', '  of si_factor', '  language en', '  pos copula', '  form "be equal in SI units to"', '  frame subject object', '  source "authored (free-sources-agent): Wikidata P2370 conversion to SI unit"', ''].join('\n')];
  const notice = ['Derived from Wikidata (https://www.wikidata.org/), structured data released into the public domain under CC0 1.0 (https://creativecommons.org/publicdomain/zero/1.0/);',
    'no attribution duty, provenance kept for honesty. Changes: units with P2370 to the metre, kilogram, second, square metre or cubic metre that the layers lack',
    'and whose name occurs in the problem books; labels lowercased; base_amount computed in commonsense-v1 base units (rounded when within 0.5 %).'];
  const files = writeLayer(LAYER, {
    name: 'Wikidata units slice (candidate)',
    description: 'Candidate units layer, not loaded by any chat base memory: common units of length, mass, duration, area and volume missing from core-en and commonsense-v1, with their dimension, their integer amount in the fine base units of commonsense-v1 and their exact decimal factor to SI (new predicate si_factor), from Wikidata (CC0). Provenance on every wire; sources and licences in docs/specs/DS011-source-rights.md.',
    imports: ['core-min', 'core-en', 'commonsense-v1'], chat: false, licence: 'CC0 1.0'
  }, [
    {base: '0001-vocabulary', title: 'the predicate si_factor and its English lexeme (authored)', generator: 'tools/commonsense/free-sources/wikidata-units.mjs', notice: ['Authored by free-sources-agent; repository licence.'], wires: vocabulary},
    {base: '0100-units', title: 'unit entities from Wikidata (CC0)', generator: 'tools/commonsense/free-sources/wikidata-units.mjs', notice, wires: entityWires},
    {base: '0110-unit-facts', title: 'dimensions, base amounts and SI factors of the units from Wikidata (CC0)', generator: 'tools/commonsense/free-sources/wikidata-units.mjs', notice, wires: factWires(factList, 'wduf_')}]);
  const p2442Dims = p2442.filter(r => SI[qid(r.si.value)]).length;
  const stats = {source: 'Wikidata units', p2370_rows: rows.length, p2442_rows: p2442.length, p2442_rows_to_the_five_si_units: p2442Dims, candidates: units.length, skipped, units: chosen.map(u => `${u.label} (${u.q}, sitelinks ${u.links}, books ${u.rel})`), by_predicate: factList.reduce((m, f) => ({...m, [f.pred]: (m[f.pred] ?? 0) + 1}), {entity: entityWires.length}), files, check: checkLayer(LAYER)};
  fs.writeFileSync(path.join(DIR, 'build-stats.json'), JSON.stringify(stats, null, 1) + '\n');
  console.log(JSON.stringify(stats, null, 1));
  if (!stats.check.ok) process.exit(1);
}

const cmd = process.argv[2];
if (cmd === 'fetch') await fetchSource();
else if (cmd === 'build') build();
else { console.error('usage: wikidata-units.mjs fetch|build [--max 120]'); process.exit(2); }
