/**
 * Fetches the world-v1 subset from the Wikidata Query Service (CC0) into datasets_sources/world-kb/raw/ (gitignored).
 * Stages (all cached, so a rerun resumes): 1 selection of entities per class, 2 property values per mapping row,
 * 3 labels/descriptions/sitelinks of every selected or referenced item. CPU only, one request at a time, no LLM.
 *   node tools/world-kb/fetch.mjs [--stage select|props|labels|all] [--only <key>]
 */
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {sparql, qid, RAW} from './wdqs.mjs';
import {MAPPING, PEOPLE_OCCUPATIONS} from './mapping.mjs';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const stage = arg('--stage', 'all');
const only = arg('--only', null);
const h = q => createHash('sha1').update(q).digest('hex').slice(0, 8);
const v = list => list.map(q => `wd:${q}`).join(' ');

/** Item classes whose direct instances are selected (P31), with the notability floor (Wikipedia editions). */
export const SELECT = {
  country: {classes: ['Q3624078'], where: 'FILTER NOT EXISTS {?e wdt:P576 []}', min: 0},
  continent: {classes: ['Q5107'], min: 0},
  city: {classes: ['Q515', 'Q1549591', 'Q174844', 'Q1637706'], where: '?e wdt:P1082 ?pop. FILTER(?pop >= 150000)', min: 0},
  language: {classes: ['Q34770', 'Q33742', 'Q1288568', 'Q33273'], where: '?e wdt:P218 [].', min: 0},
  currency: {classes: ['Q8142'], where: '?e wdt:P498 []. FILTER NOT EXISTS {?e wdt:P582 []} FILTER NOT EXISTS {?e wdt:P576 []}', min: 0},
  element: {classes: ['Q11344'], where: '?e wdt:P1086 [].', min: 0},
  planet: {classes: ['Q634', 'Q128207'], query: 'SELECT ?e ?s WHERE { ?e wdt:P31/wdt:P279* wd:Q634; wdt:P397 wd:Q525; wikibase:sitelinks ?s. }'},
  company: {classes: ['Q4830453', 'Q891723', 'Q6881511', 'Q783794'], min: [25, 35, 45]},
  university: {classes: ['Q3918', 'Q875538', 'Q902104'], min: [20, 30, 45]},
  organization: {classes: ['Q484652', 'Q245065'], min: [30, 45, 60]},
  literary_work: {classes: ['Q7725634', 'Q47461344', 'Q116476516', 'Q179461', 'Q8261', 'Q25379', 'Q49084', 'Q1318295'], perClass: true, min: [25, 30, 40, 55]},
  film: {classes: ['Q11424'], min: [35, 45, 60]},
  painting: {classes: ['Q3305213'], min: [25, 35, 50]},
};
/** Notability floors (Wikipedia editions) per occupation: a list is tried from the lowest floor up until WDQS answers within its time limit. */
const PEOPLE_MIN = {physicist: [20, 30, 45], chemist: [20, 30, 45], mathematician: [20, 30, 45], biologist: [20, 30, 45], astronomer: [20, 30, 45],
  philosopher: [25, 35, 55], economist: [25, 35, 50], engineer: [30, 45, 60], inventor: [30, 45, 55], physician: [30, 45, 60], computer_scientist: [20, 30, 40],
  writer: [70, 100, 130], poet: [40, 55, 70], novelist: [35, 50, 60], playwright: [30, 45, 60], painter: [35, 50, 70], sculptor: [30, 45, 60],
  architect: [30, 45, 60], composer: [30, 45, 65], explorer: [20, 30, 40], politician: [50, 70, 90], monarch: [40, 60, 80], military_leader: [40, 60, 80],
  film_director: [35, 50, 70], actor: [80, 110, 150], singer: [80, 110, 150], theologian: [30, 45, 60], historian: [30, 45, 55]};

/** Tries the notability floors from the lowest; a query WDQS cannot finish within its limit falls back to the next floor, and none left skips the class. */
async function tiered(name, floors, make) {
  for (const min of floors) {
    try { const rows = await sparql(`${name}`, make(min), {timeoutMs: 75000, retries: 0}); log(name, 'floor', min); return rows; }
    catch { log(name, 'floor', min, 'timed out'); }
  }
  log('FAILED', name, 'skipped');
  fs.writeFileSync(path.join(RAW, `${name}.json`), JSON.stringify({name, failed: true, rows: []}));
  return [];
}
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
const readRows = name => JSON.parse(fs.readFileSync(path.join(RAW, `${name}.json`), 'utf8')).rows;

async function selectEntities() {
  const out = {};
  for (const [key, c] of Object.entries(SELECT)) {
    if (only && only !== key) continue;
    const make = classes => min => c.query ?? `SELECT ?e ?s WHERE { VALUES ?cls { ${v(classes)} } ?e wdt:P31 ?cls. ${c.where ?? ''} ?e wikibase:sitelinks ?s. FILTER(?s >= ${min}) }`;
    // perClass: one query per class (a union of heavy classes can exceed the WDQS time limit); the per-class files are merged into select-<key>.json
    let rows;
    if (c.perClass) {
      rows = [];
      for (const cls of c.classes) rows.push(...await tiered(`select-${key}-${cls}`, [].concat(c.min), make([cls])));
      fs.writeFileSync(path.join(RAW, `select-${key}.json`), JSON.stringify({name: `select-${key}`, rows}));
    } else rows = await tiered(`select-${key}`, [].concat(c.min ?? 0), make(c.classes));
    out[key] = [...new Map(rows.map(r => [qid(r.e), Number(r.s)])).keys()];
    log('select', key, out[key].length);
  }
  const people = new Map();
  for (const [name, q] of Object.entries(PEOPLE_OCCUPATIONS)) {
    if (only && only !== 'person' && only !== name) continue;
    const rows = await tiered(`select-person-${name}`, PEOPLE_MIN[name], min => `SELECT ?e ?s WHERE { ?e wdt:P31 wd:Q5; wdt:P106 wd:${q}; wikibase:sitelinks ?s. FILTER(?s >= ${min}) }`);
    for (const r of rows) people.set(qid(r.e), Number(r.s));
    log('select person', name, rows.length, 'total', people.size);
  }
  out.person = [...people.keys()];
  return out;
}

/** The saved selection (rebuilt from the cached stage-1 files). */
export function loadSelection() {
  const out = {};
  for (const key of Object.keys(SELECT)) out[key] = [...new Set(readRows(`select-${key}`).map(r => qid(r.e)))];
  const people = new Set();
  for (const name of Object.keys(PEOPLE_OCCUPATIONS)) for (const r of readRows(`select-person-${name}`)) people.add(qid(r.e));
  out.person = [...people];
  return out;
}

const TIME_PIDS = new Set(MAPPING.filter(m => m.kind === 'year' || m.kind === 'date').map(m => m.pid));
const BATCH = 250;
function propQuery(pid, ids, only) {
  const sub = `VALUES ?s { ${v(ids)} }`;
  if (TIME_PIDS.has(pid)) return `SELECT ?s ?v ?pr WHERE { ${sub} ?s wdt:${pid} ?v. ?s p:${pid} ?st. ?st ps:${pid} ?v; psv:${pid}/wikibase:timePrecision ?pr. }`;
  const restrict = only ? `VALUES ?v { ${v(only)} }` : '';
  return `SELECT ?s ?v WHERE { ${sub} ${restrict} ?s wdt:${pid} ?v. }`;
}

async function fetchProps(selection) {
  const byPid = new Map();
  for (const m of MAPPING) {
    const g = byPid.get(m.pid) ?? {ids: new Set(), only: null};
    for (const c of m.scope) for (const id of selection[c] ?? []) g.ids.add(id);
    if (m.only) g.only = m.only;
    byPid.set(m.pid, g);
  }
  for (const [pid, g] of byPid) {
    if (only && only !== pid) continue;
    const ids = [...g.ids];
    for (let i = 0, n = 0; i < ids.length; i += BATCH, n++) {
      const q = propQuery(pid, ids.slice(i, i + BATCH), g.only);
      await sparql(`prop-${pid}-${String(n).padStart(3, '0')}-${h(q)}`, q);
    }
    log('props', pid, 'ids', ids.length);
  }
  // P31 restricted to the selection classes (is_a)
  const classes = [...new Set([...Object.values(SELECT).flatMap(c => c.classes), 'Q5'])];
  const all = [...new Set(Object.values(selection).flat())];
  for (let i = 0, n = 0; i < all.length; i += BATCH * 2, n++) {
    const q = `SELECT ?s ?v WHERE { VALUES ?s { ${v(all.slice(i, i + BATCH * 2))} } VALUES ?v { ${v(classes)} } ?s wdt:P31 ?v. }`;
    await sparql(`prop-P31-${String(n).padStart(3, '0')}-${h(q)}`, q);
  }
  log('props P31 ids', all.length);
}

/** Every item that is selected or used as a value. */
export function referencedIds(selection) {
  const ids = new Set(Object.values(selection).flat());
  for (const f of fs.readdirSync(RAW)) {
    if (!/^prop-P\d+-\d+-[0-9a-f]+\.json$/.test(f)) continue;
    for (const r of readRows(f.replace('.json', ''))) if (r.v?.startsWith('http://www.wikidata.org/entity/Q')) ids.add(qid(r.v));
  }
  for (const m of MAPPING) for (const q of m.only ?? []) ids.add(q);
  return [...ids];
}

async function fetchLabels(selection) {
  const ids = referencedIds(selection);
  for (let i = 0, n = 0; i < ids.length; i += 300, n++) {
    const batch = ids.slice(i, i + 300);
    // the ?ro label stays in the query only to keep the cache keys of the fetched batches; the build ignores it (English-only core)
    const q = `SELECT ?i ?en ?ro ?d ?s WHERE { VALUES ?i { ${v(batch)} } ?i wikibase:sitelinks ?s. OPTIONAL { ?i rdfs:label ?en FILTER(lang(?en)="en") } OPTIONAL { ?i rdfs:label ?ro FILTER(lang(?ro)="ro") } OPTIONAL { ?i schema:description ?d FILTER(lang(?d)="en") } }`;
    await sparql(`label-${String(n).padStart(4, '0')}-${h(q)}`, q);
    if (n % 10 === 0) log('labels', i, '/', ids.length);
  }
  log('labels done', ids.length);
}

/**
 * Wikidata keeps the label of many names (people, places) in the language code `mul` ("multiple languages") and no `en` row, so the
 * `rdfs:label@en` read above returns nothing for them (Albert Einstein, Marie Curie, ...). For every id without an English label
 * the `mul` label is read; build.mjs uses it as the English label and, when no Romanian label exists, as the Romanian one.
 */
async function fetchMulLabels() {
  const withEn = new Set(), ids = new Set();
  for (const f of fs.readdirSync(RAW).filter(f => /^label-\d+-[0-9a-f]+\.json$/.test(f))) for (const r of readRows(f.replace('.json', ''))) { ids.add(qid(r.i)); if (r.en) withEn.add(qid(r.i)); }
  const missing = [...ids].filter(id => !withEn.has(id));
  for (let i = 0, n = 0; i < missing.length; i += 300, n++) {
    const q = `SELECT ?i ?mul WHERE { VALUES ?i { ${v(missing.slice(i, i + 300))} } ?i rdfs:label ?mul FILTER(lang(?mul)="mul") }`;
    await sparql(`labelmul-${String(n).padStart(4, '0')}-${h(q)}`, q);
  }
  log('mul labels for', missing.length, 'ids without an English label');
}

/** English aliases (skos:altLabel) of the selected items: the short and common names a question uses ("Apple" for Apple Inc.). */
async function fetchAliases(selection) {
  const ids = [...new Set(Object.values(selection).flat())];
  for (let i = 0, n = 0; i < ids.length; i += 300, n++) {
    const q = `SELECT ?i ?a WHERE { VALUES ?i { ${v(ids.slice(i, i + 300))} } ?i skos:altLabel ?a FILTER(lang(?a)="en") }`;
    await sparql(`alias-${String(n).padStart(4, '0')}-${h(q)}`, q);
    if (n % 20 === 0) log('aliases', i, '/', ids.length);
  }
  log('aliases done', ids.length);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (stage === 'select' || stage === 'all') await selectEntities();
  const selection = loadSelection();
  if (stage === 'props' || stage === 'all') await fetchProps(selection);
  if (stage === 'labels' || stage === 'all') await fetchLabels(selection);
  if (stage === 'mul' || stage === 'all') await fetchMulLabels();
  if (stage === 'alias' || stage === 'all') await fetchAliases(selection);
  log('done');
}
