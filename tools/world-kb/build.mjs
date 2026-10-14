/**
 * Builds the world-v1 knowledge circuits from the cached Wikidata responses (datasets_sources/world-kb/raw/), mechanically, in the
 * knowledge grammar of DS004 (predicate, lexeme, entity, fact): every mapping row (mapping.mjs) becomes a predicate with its lexemes,
 * every used item an entity wire (labels, notability, source) and every value one fact with `source "Wikidata <item> <property>"`.
 * The memory imports core-min (tools/world-kb/load.mjs); nothing here redeclares its ids.
 * Output: datasets_sources/world-kb/circuits/NNNN-<name>.sop (each below the parser's 2,048-wire limit) and build-stats.json.
 *   node tools/world-kb/build.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {RAW, qid} from './wdqs.mjs';
import {MAPPING, DERIVED, CLASSES, CLASS_VOCAB, RANGE, CLASS_PRIORITY, kindFromRanges} from './mapping.mjs';
import {loadSelection, referencedIds, SELECT} from './fetch.mjs';
import {parse} from '../../sop/knowledge/index.mjs';


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'datasets_sources', 'world-kb', 'circuits');
const MAX_WIRES = 1900;
const readRows = name => JSON.parse(fs.readFileSync(path.join(RAW, name), 'utf8')).rows;
const files = prefix => fs.readdirSync(RAW).filter(f => f.startsWith(prefix) && f.endsWith('.json')).sort();

// ---- the layers world-v1 imports (core-min, and core-en when it exists): their ids are reserved, their entities are reused ---------
const IMPORTS = ['core-min', 'core-en'].filter(d => fs.existsSync(path.join(ROOT, 'config', 'knowledge', d)));
const imported = new Map(); // id -> {type, kind, args, labels: [en labels lowercased]}
for (const layer of IMPORTS) {
  const dir = path.join(ROOT, 'config', 'knowledge', layer);
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sop')).sort()) for (const w of parse(fs.readFileSync(path.join(dir, f), 'utf8')).wires) {
    const get = key => w.fields.find(x => x.key === key)?.value.trim();
    const labels = w.fields.filter(x => x.key === 'label' || x.key === 'alias').map(x => x.value.trim()).filter(v => v.startsWith('en ')).map(v => { try { return JSON.parse(v.slice(3)).toLowerCase(); } catch { return null; } }).filter(Boolean);
    imported.set(w.id, {type: w.type, kind: get('kind'), args: get('args'), labels, plainLabel: w.fields.filter(x => x.key === 'label').map(x => x.value.trim()).find(v => v.startsWith('en '))});
  }
}
const importedByLabel = new Map(); // main English label (lowercase) -> imported entity id, per kind
for (const [id, w] of imported) if (w.type === 'entity' && w.plainLabel) { try { importedByLabel.set(`${w.kind}|${JSON.parse(w.plainLabel.slice(3)).toLowerCase()}`, id); } catch {} }

const selection = loadSelection();
const classOf = new Map(); // item -> selection class keys
for (const [k, ids] of Object.entries(selection)) for (const id of ids) (classOf.get(id) ?? classOf.set(id, new Set()).get(id)).add(k);

// ---- labels and symbols -------------------------------------------------------------------------------------------
const info = new Map(); // qid -> {en, desc, sitelinks}
for (const f of files('label-')) for (const r of readRows(f)) {
  const id = qid(r.i);
  const cur = info.get(id) ?? {en: null, desc: null, sitelinks: 0};
  cur.en ??= r.en ?? null; cur.desc ??= r.d ?? null; cur.sitelinks = Math.max(cur.sitelinks, Number(r.s) || 0);
  info.set(id, cur);
}
// Names kept only under the language code `mul` (fetch.mjs fetchMulLabels) are the English label, and the Romanian one when none exists.
for (const f of files('labelmul-')) for (const r of readRows(f)) {
  const cur = info.get(qid(r.i));
  if (cur && !cur.en && r.mul) { cur.en = r.mul; }
}
const slug = text => text.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[øØ]/g, 'o').replace(/[æÆ]/g, 'ae').replace(/ł|Ł/g, 'l').replace(/đ|Đ/g, 'd')
  .toLowerCase().replace(/&/g, ' and ').replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const predicateNames = new Set([...MAPPING.map(m => m.pred), ...DERIVED.map(d => d.pred), 'likely_speaks', 'does_not_speak']);
const CORE_IDS = ['is_a', 'class', 'entity', 'person', 'organization', 'place', 'occupation', 'property', 'unit'];
const reserved = id => imported.has(id) || predicateNames.has(id) || CORE_IDS.includes(id) || id in CLASS_VOCAB || /^(x_|wd\d|r_|d_)/.test(id) || /^wd/.test(id);
const symbolOf = new Map();
const byslug = new Map();
// A Wikidata occupation or currency whose English label is the label of an imported entity of that kind IS that entity: its facts use the imported id.
const occupationQids = new Set();
for (const f of files('prop-P106-')) for (const r of readRows(f)) if (r.v?.startsWith('http://www.wikidata.org/entity/Q')) occupationQids.add(qid(r.v));
const reused = new Map(); // qid -> imported id
for (const [kind, ids] of [['occupation', occupationQids], ['currency', new Set(selection.currency)]]) for (const id of ids) {
  const label = info.get(id)?.en?.toLowerCase();
  const hit = label && importedByLabel.get(`${kind}|${label}`);
  if (hit) reused.set(id, hit);
}
for (const [id, i] of info) {
  if (!i.en || reused.has(id)) continue;
  let s = slug(i.en);
  if (!s || !/^[a-z]/.test(s) || /^(x_|wd\d|r_|d_|lx_)/.test(s)) s = s ? `n_${s}` : '';
  if (!s) continue;
  (byslug.get(s) ?? byslug.set(s, []).get(s)).push(id);
}
for (const [s, ids] of byslug) {
  ids.sort((a, b) => info.get(b).sitelinks - info.get(a).sitelinks || Number(a.slice(1)) - Number(b.slice(1)));
  ids.forEach((id, k) => symbolOf.set(id, k === 0 && !reserved(s) ? s : `${s}_${id.toLowerCase()}`));
}
for (const [id, ent] of reused) symbolOf.set(id, ent);
const sym = id => symbolOf.get(id) ?? null;

// ---- facts ---------------------------------------------------------------------------------------------------------
const quote = s => JSON.stringify(String(s).replace(/\s+/g, ' ').trim());
const facts = new Map(); // dedupe key -> {pred, args, source}
const stats = {skipped_unlabelled: 0, skipped_range: 0, dedup: 0, self_loops: 0, by_predicate: {}};
function add(pred, args, source) {
  // A relation between two identities never relates an item to itself (Wikidata's country of France is France, `located_in france france`):
  // such a fact is no knowledge and makes the transitive search of `located_in` loop until its budget ends.
  if (args.length === 2 && args[0] === args[1] && /^[a-z][a-z0-9_]*$/.test(args[0])) { stats.self_loops++; return; }
  const key = pred + ' ' + args.join(' ');
  if (facts.has(key)) { stats.dedup++; return; }
  facts.set(key, {pred, args, source});
  stats.by_predicate[pred] = (stats.by_predicate[pred] ?? 0) + 1;
}
const order = (m, subject, value) => (m.flip ? [value, subject] : [subject, value]);
const inScope = (m, id) => m.scope.some(c => classOf.get(id)?.has(c));

// property rows grouped by pid
const rangeOf = new Map(); // symbol -> Map(class of the properties it is the value of -> occurrences)
const rowsByPid = new Map();
for (const f of files('prop-P')) {
  const pid = f.match(/^prop-(P\d+)-/)[1];
  if (pid === 'P31') continue;
  (rowsByPid.get(pid) ?? rowsByPid.set(pid, []).get(pid)).push(...readRows(f));
}
const isoYear = v => { const m = String(v).match(/^(-?\d{1,6})-(\d\d)-(\d\d)T/); return m ? {year: Number(m[1]), month: m[2], day: m[3]} : null; };
for (const m of MAPPING) {
  for (const r of rowsByPid.get(m.pid) ?? []) {
    const id = qid(r.s);
    if (!inScope(m, id) || !sym(id)) continue;
    const source = quote(`Wikidata ${id} ${m.pid}`);
    if (m.kind === 'entity') {
      const o = qid(r.v);
      if (!r.v.startsWith('http://www.wikidata.org/entity/Q')) continue;
      if (m.only && !m.only.includes(o)) continue;
      // objectClass: the value must itself be a selected item of that class (no constituent-country duplicates of a state).
      if (m.objectClass && !classOf.get(o)?.has(m.objectClass)) { stats.skipped_object_class = (stats.skipped_object_class ?? 0) + 1; continue; }
      if (!sym(o)) { stats.skipped_unlabelled++; continue; }
      add(m.pred, order(m, sym(id), sym(o)), source);
      if (RANGE[m.pid]) { const counts = rangeOf.get(sym(o)) ?? rangeOf.set(sym(o), new Map()).get(sym(o)); counts.set(RANGE[m.pid], (counts.get(RANGE[m.pid]) ?? 0) + 1); }
    } else if (m.kind === 'integer') {
      const n = Math.round(Number(r.v));
      if (!Number.isSafeInteger(n) || (m.pred === 'atomic_number' && (n < 1 || n > 118)) || (m.pred === 'population' && n < 0)) { stats.skipped_range++; continue; }
      add(m.pred, order(m, sym(id), String(n)), source);
    } else if (m.kind === 'text') {
      add(m.pred, order(m, sym(id), quote(r.v)), source);
    } else if (m.kind === 'year' || m.kind === 'date') {
      const t = isoYear(r.v);
      const pr = Number(r.pr);
      if (!t || pr < 9) { stats.skipped_range++; continue; }
      if (m.kind === 'year') { add(m.pred, [sym(id), String(t.year)], source); continue; }
      if (pr < 11 || t.year < 1 || t.year > 9999) continue;
      add(m.pred, [sym(id), quote(`${String(t.year).padStart(4, '0')}-${t.month}-${t.day}`)], source);
    }
  }
}
// ---- class membership, descriptions ----------------------------------------------------------------------------------
const classKeyOfQid = new Map([['Q5', 'person']]);
for (const [key, c] of Object.entries(SELECT)) for (const q of c.classes) if (!classKeyOfQid.has(q)) classKeyOfQid.set(q, key);
const selected = new Set(classOf.keys());
for (const f of files('prop-P31-')) for (const r of readRows(f)) {
  const id = qid(r.s), key = classKeyOfQid.get(qid(r.v));
  if (sym(id) && key) add('is_a', [sym(id), key], quote(`Wikidata ${id} P31`));
}
for (const id of selected) if (sym(id)) for (const key of classOf.get(id)) add('is_a', [sym(id), key], quote(`Wikidata ${id} P31`));
for (const id of selected) {
  const i = info.get(id);
  if (i?.desc && sym(id)) add('description', [sym(id), quote(i.desc)], quote(`Wikidata ${id} description`));
}

// ---- vocabulary: classes, predicates, lexemes, rules --------------------------------------------------------------------
fs.rmSync(OUT, {recursive: true, force: true});
fs.mkdirSync(OUT, {recursive: true});
const roleText = r => r.map(([a, b]) => `${a}:${b}`).join(' ');
const allPreds = new Map();
for (const m of MAPPING) if (!allPreds.has(m.pred)) allPreds.set(m.pred, {roles: m.roles, notes: [], pids: [], aliases: {en: new Set()}});
for (const m of MAPPING) {
  const p = allPreds.get(m.pred);
  p.pids.push(m.pid);
  if (m.note) p.notes.push(m.note);
  if (m.weight) p.weight = m.weight;
  for (const [lang, list] of Object.entries(m.aliases ?? {})) for (const a of list) p.aliases[lang].add(a);
}
for (const d of DERIVED) if (!allPreds.has(d.pred)) allPreds.set(d.pred, {roles: d.roles, notes: [d.note], pids: [d.source], aliases: {en: new Set()}});
const extra = [
  ['likely_speaks', [['subject', 'entity'], ['object', 'entity']], 'defeasible: a citizen usually speaks an official language of the country (hand-written default d_citizen_speaks, not a Wikidata statement)', ['likely speak']],
  ['does_not_speak', [['subject', 'entity'], ['object', 'entity']], 'strict exception to d_citizen_speaks; no fact in world-v1 states it', ['not speak']],
];
for (const [p, roles, d, en] of extra) allPreds.set(p, {roles, notes: [d], pids: [], aliases: {en: new Set(en)}});
const LABEL_OF = {area_km2_of: 'area of', iso_country_code: 'country code', iso_language_code: 'language code', iso_currency_code: 'currency code', uses_currency: 'currency'};
const predLabel = name => LABEL_OF[name] ?? name.replace(/_/g, ' ');
const posOf = form => (/^(be|fi) /.test(form) ? 'copula' : / of$/.test(form) ? 'noun' : 'verb');

let vocab = '# world-v1 vocabulary (generated by tools/world-kb/build.mjs): the classes on top of core-min, one predicate per mapped Wikidata property with its lexemes, then a few hand-written rules. Nothing is closed (Wikidata is open-world).\n\n';
for (const [key, c] of Object.entries(CLASS_VOCAB)) {
  if (imported.has(key)) continue; // declared by an import (core-en declares country, city, language, ...)
  vocab += `@${key} entity\n  kind class\n  label en ${quote(c.en)}\n${c.alias.map(a => `  alias en ${quote(a)}\n`).join('')}  source "world-v1 hand-written: the class of the selected Wikidata items"\n\n`;
}
for (const [name, p] of allPreds) {
  if (imported.has(name)) { // the import owns the predicate and its lexemes; its arguments must be the ones the facts use
    const have = imported.get(name).args, want = roleText(p.roles);
    if (have !== want) throw new Error(`predicate ${name}: the import declares args "${have}", the mapping emits "${want}"`);
    continue;
  }
  const pid = [...new Set(p.pids)].join(', ');
  const desc = [pid ? `Wikidata ${pid}` : 'derived', ...new Set(p.notes)].join('; ').replace(/"/g, "'");
    vocab += `@${name} predicate\n  args ${roleText(p.roles)}\n  label en ${quote(predLabel(name))}\n${name === 'located_in' ? '  transitive true\n' : ''}  description ${quote(desc)}\n\n`;
  const frame = p.roles.map(([r]) => r).join(' ');
  for (const lang of ['en']) { // English only: the core holds no other language (owner decision 2026-10-01)
    const byPos = new Map();
    for (const form of p.aliases[lang]) (byPos.get(posOf(form)) ?? byPos.set(posOf(form), []).get(posOf(form))).push(form);
    for (const [pos, forms] of byPos) vocab += `@lx_${name}_${lang}_${pos} lexeme\n  of ${name}\n  language ${lang}\n  pos ${pos}\n${forms.map(f => `  form ${quote(f)}\n`).join('')}  frame ${frame}\n${p.weight ? `  weight ${p.weight}\n` : ''}  source "world-v1 mapping (tools/world-kb/mapping.mjs)"\n\n`;
  }
}
vocab += `# Hand-written rules (source "world-v1 hand-written"): what Wikidata statements imply, no more.
@r_capital_located rule
  when capital_of ?city ?country
  then located_in ?city ?country
  source "world-v1 hand-written: the capital of a country is located in it"

@r_located_trans rule
  when located_in ?a ?b
  when located_in ?b ?c
  then located_in ?a ?c
  source "world-v1 hand-written: located in is transitive"

@r_born_in_container rule
  when born_in ?p ?place
  when located_in ?place ?country
  then born_in ?p ?country
  source "world-v1 hand-written: born in a place located in a country is born in that country"

@r_died_in_container rule
  when died_in ?p ?place
  when located_in ?place ?country
  then died_in ?p ?country
  source "world-v1 hand-written: died in a place located in a country died in that country"

@r_occupation_class rule
  when has_occupation ?p ?o
  then is_a ?p ?o
  source "world-v1 hand-written: a person with an occupation is a member of that occupation's class, so 'Is X a painter?' (the class reading of be) is answered from the occupation facts"

@d_citizen_speaks default
  when citizen_of ?p ?country
  when official_language_of ?lang ?country
  then likely_speaks ?p ?lang
  except does_not_speak ?p ?lang
  source "world-v1 hand-written: a citizen usually speaks an official language of the country"
`;
const written = [];
const write = (name, text) => { const n = String(written.length + 1).padStart(4, '0'); fs.writeFileSync(path.join(OUT, `${n}-${name}.sop`), text); written.push(`${n}-${name}.sop`); };
write('vocabulary-and-rules', vocab);

let counter = 0;
const chunked = (name, items, render) => {
  for (let i = 0, part = 1; i < items.length; i += MAX_WIRES, part++) write(`${name}-${String(part).padStart(3, '0')}`, items.slice(i, i + MAX_WIRES).map(render).join(''));
};
// class hierarchy
let hier = '';
hier += '@wdc_university_school fact\n  holds is_a university school\n  source "world-v1 hand-written: core-en describes a school as a school, college or university"\n\n';
for (const [key, c] of Object.entries(CLASS_VOCAB)) hier += `@wdc_${key} fact\n  holds is_a ${key} ${c.parent}\n  source "world-v1 hand-written: the class hierarchy"\n\n`;
write('class-hierarchy', hier);

// ---- entities: every item that is selected or appears as an argument of a fact ----------------------------------------------
const usedSymbols = new Set();
for (const f of facts.values()) for (const a of f.args) if (/^[a-z]/.test(a) && !(a in CLASS_VOCAB) && !imported.has(a)) usedSymbols.add(a);
const qidOf = new Map([...symbolOf].map(([id, s]) => [s, id]));
const occupationItems = new Set();
for (const f of facts.values()) if (f.pred === 'has_occupation') occupationItems.add(f.args[1]);
const labelsTaken = new Set([...Object.values(CLASS_VOCAB).flatMap(c => [c.en, ...c.alias]), ...[...imported.values()].flatMap(w => w.labels)].map(x => x.toLowerCase()));
// English aliases (skos:altLabel) of the selected items: an alias belongs to the most notable of its claimants and never shadows a label
const aliasesOf = new Map(); // qid -> [alias]
for (const f of files('alias-')) for (const r of readRows(f)) {
  const id = qid(r.i), a = String(r.a ?? '').trim();
  if (a && a.length <= 60 && !/^[\d\s\W]+$/.test(a)) (aliasesOf.get(id) ?? aliasesOf.set(id, []).get(id)).push(a);
}
const LEGAL_SUFFIX = /[,\s]+(inc\.?|incorporated|corporation|corp\.?|company|co\.|ltd\.?|limited|llc|plc|ag|sa|s\.a\.|gmbh|n\.v\.|nv|s\.p\.a\.|se|ab)$/i;
for (const s of usedSymbols) { // the short name of a company: its label without the legal form ("Apple Inc." -> "Apple")
  const id = qidOf.get(s), i = info.get(id);
  if (!['company', 'organization', 'university'].includes([...(classOf.get(id) ?? [])][0]) || !i?.en) continue;
  const short = i.en.replace(LEGAL_SUFFIX, '').trim();
  if (short && short !== i.en) (aliasesOf.get(id) ?? aliasesOf.set(id, []).get(id)).push(short);
}
const plainEn = new Set(labelsTaken);
for (const s of usedSymbols) { const i = info.get(qidOf.get(s)); if (i?.en && s === slug(i.en)) plainEn.add(i.en.toLowerCase()); }
const claims = new Map(); // lowercase alias -> [{s, sitelinks}]
for (const s of usedSymbols) {
  const id = qidOf.get(s), i = info.get(id);
  for (const a of new Set(aliasesOf.get(id) ?? [])) { const k = a.toLowerCase(); if (!plainEn.has(k)) (claims.get(k) ?? claims.set(k, []).get(k)).push({s, sitelinks: i.sitelinks}); }
}
const aliasClaim = new Map(); // an alias goes to its only claimant, or to a claimant at least three times as notable as the next one
for (const [k, list] of claims) {
  list.sort((a, b) => b.sitelinks - a.sitelinks || (a.s < b.s ? -1 : 1));
  if (list.length === 1 || list[0].sitelinks >= 3 * list[1].sitelinks) aliasClaim.set(k, list[0]);
}
const entities = [];
const table = {};
for (const s of [...usedSymbols].sort()) {
  const id = qidOf.get(s), i = info.get(id);
  if (!i?.en) continue;
  const desc = i.desc ? ` (${i.desc})` : ` (${id})`;
  const plain = s === slug(i.en) && !labelsTaken.has(i.en.toLowerCase());
  const kind = occupationItems.has(s) ? 'occupation' : [...(classOf.get(id) ?? [])][0] ?? kindFromRanges(rangeOf.get(s));
  let w = `@${s} entity\n`;
  if (kind) w += `  kind ${kind}\n`;
  w += `  label en ${quote(plain ? i.en : `${i.en}${desc}`)}\n`;
  if (plain) for (const a of new Set((aliasesOf.get(id) ?? []).filter(a => aliasClaim.get(a.toLowerCase())?.s === s)).values()) w += `  alias en ${quote(a)}\n`;
  w += `  notability ${i.sitelinks}\n  source ${quote(`Wikidata ${id}`)}\n\n`;
  entities.push(w);
  table[s] = {qid: id, en: i.en, desc: i.desc, sitelinks: i.sitelinks, plain, kind: kind ?? null};
}
chunked('entities', entities, w => w);

// ---- facts grouped by predicate, in vocabulary order, chunked ----------------------------------------------------------------
const byPred = new Map();
for (const f of facts.values()) (byPred.get(f.pred) ?? byPred.set(f.pred, []).get(f.pred)).push(f);
const predOrder = [...allPreds.keys()].filter(p => byPred.has(p));
for (const p of predOrder) {
  const list = byPred.get(p);
  chunked(`facts-${p}`, list, f => `@wd${++counter} fact\n  holds ${f.pred} ${f.args.join(' ')}\n  source ${f.source}\n\n`);
}
const bytes = written.reduce((a, f) => a + fs.statSync(path.join(OUT, f)).size, 0);
Object.assign(stats, {facts: facts.size + Object.keys(CLASS_VOCAB).length, entities: entities.length, circuits: written.length, bytes, entities_selected: selected.size, symbols: symbolOf.size,
  per_class: Object.fromEntries(Object.entries(selection).map(([k, v]) => [k, v.length])), predicates: allPreds.size, predicates_declared: [...allPreds.keys()].filter(p => !imported.has(p)).length, predicates_from_imports: [...allPreds.keys()].filter(p => imported.has(p)).length});
fs.writeFileSync(path.join(ROOT, 'datasets_sources', 'world-kb', 'build-stats.json'), JSON.stringify(stats, null, 2));
fs.writeFileSync(path.join(ROOT, 'datasets_sources', 'world-kb', 'entities.json'), JSON.stringify(table));
console.log(JSON.stringify({facts: stats.facts, entities: stats.entities, circuits: stats.circuits, MB: (bytes / 1e6).toFixed(1), selected: stats.entities_selected, skipped_unlabelled: stats.skipped_unlabelled}));
