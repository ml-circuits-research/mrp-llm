/**
 * Shared helpers of the free-source slice builders (tools/commonsense/free-sources/<source>.mjs): each builder turns a small,
 * licence-checked selection of one external common-sense source into a candidate layer `config/knowledge/<layer>/` that no chat base
 * memory imports yet (`"chat": false` in its seed.json). The helpers:
 *   - index the names (labels and aliases) of the entities of the layers a slice links to (core-min, core-en, commonsense-v1), so a
 *     source concept becomes a fact only when it names an entity that already exists (a linkable class, occupation or element);
 *   - count how often each word occurs in the owner's problem books (token statistics only; no book text is kept or written);
 *   - rank candidate facts by book relevance and source confidence, drop duplicates of the facts the layers already hold, and write
 *     the generated circuit files (at most MAX_WIRES wires each) with a licence header;
 *   - validate a layer with the knowledge validator over its imports and check that its ids collide with no layer and no world-v1 id.
 * Sources, licences and decisions: docs/specs/DS011-source-rights.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {parse} from '../../../sop/knowledge/index.mjs';
import {validateProgram} from '../../../sop/knowledge/validate.mjs';
import {Lexicon} from '../../../sop/lexicon.mjs';
import {seedLayers, seedCircuits, seedIds, SEEDS_DIR} from '../../../lib/knowledge-seeds.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const CACHE = path.join(ROOT, 'datasets_sources/free-sources');
export const MAX_WIRES = 1800;
const BOOKS = path.join(ROOT, 'datasets_sources/books/eval/items.jsonl');
const WORLD_DIRS = [path.join(ROOT, 'chat_data/base_memories/world-v1/circuits'), path.join(ROOT, 'datasets_sources/world-kb/circuits')];
/** Entity kinds that name a kind of thing a class-level fact can be about (the same set tools/commonsense/build.mjs reuses). */
const LINKABLE = new Set(['class', 'occupation', 'element']);
/** Sexual, drug and slur vocabulary (the same data-quality filter as tools/commonsense/build.mjs). */
export const OFFENSIVE = /\b(sex|sexual|homosexual|gay|lesbian|condom|penis|vagina|prostitut\w*|whore|slut|bitch|nigg\w*|fag\w*|rape\w*|porn\w*|masturbat\w*|orgasm|fuck\w*|shit|ass|asshole|cocaine|heroin|marijuana|drunk\w*|retard\w*|kill\w*|suicid\w*)\b/;
const STOP = new Set(['a', 'an', 'the', 'your', 'his', 'her', 'their', 'its', 'my', 'our', 'some']);

export const opt = (name, fallback) => { const args = process.argv.slice(2); const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
export const sha256File = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
/** A source phrase as a lowercase concept text: underscores to spaces, leading articles and possessives removed. */
export const conceptText = s => String(s).toLowerCase().replace(/_/g, ' ').trim().split(/\s+/).filter((w, i) => !(i === 0 && STOP.has(w))).join(' ');
/** A phrase that is safe and short enough as a text value (at most five plain words). */
export const textValueOk = s => /^[a-z][a-z' -]*$/.test(s) && s.split(' ').length <= 5 && !OFFENSIVE.test(s);

const wireField = (w, key) => w.fields.find(f => f.key === key)?.value.trim();

/** Names and ids of the linked layers, every layer id and the world-v1 ids. */
export function layerIndex(layers = ['commonsense-v1']) {
  const names = new Map(); // lowercased label or alias -> [{id, kind, label}]
  const holds = new Set(); // "pred a b" of every fact the linked layers hold
  const predicates = new Set();
  for (const layer of layers) for (const c of seedLayers(layer)) for (const w of parse(c.text).wires) {
    if (w.type === 'predicate') predicates.add(w.id);
    if (w.type === 'fact') holds.add(wireField(w, 'holds'));
    if (w.type !== 'entity') continue;
    const kind = wireField(w, 'kind') ?? 'entity';
    const en = f => { const m = /^en\s+(".*")$/.exec(f.value.trim()); return m ? JSON.parse(m[1]).toLowerCase() : null; };
    const label = w.fields.filter(f => f.key === 'label').map(en).find(Boolean) ?? null;
    for (const f of w.fields.filter(f => f.key === 'label' || f.key === 'alias')) {
      const name = en(f);
      if (!name) continue;
      // an inflection of the label (an alias that extends it: "apples" of "apple") is as good as the label; a synonym alias is weaker
      const inflection = f.key === 'label' || (label !== null && name.startsWith(label) && name.length - label.length <= 2);
      (names.get(name) ?? names.set(name, []).get(name)).push({id: w.id, kind, label: f.key === 'label', inflection});
    }
  }
  return {names, holds, predicates};
}

/** Every wire id of every seed layer (chat or not, except `skip`) and of world-v1, with the world-v1 names. */
export function takenIds(skip) {
  const ids = new Set(), worldNames = new Map();
  for (const id of seedIds({all: true}).filter(id => id !== skip)) for (const c of seedCircuits(id)) for (const w of parse(c.text).wires) ids.add(w.id);
  for (const dir of WORLD_DIRS.filter(d => fs.existsSync(d))) for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sop'))) {
    for (const w of parse(fs.readFileSync(path.join(dir, f), 'utf8')).wires) {
      ids.add(w.id);
      if (w.type !== 'entity') continue;
      const notability = Number(wireField(w, 'notability') ?? 0);
      for (const fl of w.fields.filter(fl => fl.key === 'label')) { const m = /^en\s+(".*")$/.exec(fl.value.trim()); if (m) worldNames.set(JSON.parse(m[1]).toLowerCase(), Math.max(notability, worldNames.get(JSON.parse(m[1]).toLowerCase()) ?? 0)); }
    }
  }
  return {ids, worldNames};
}

/**
 * The linkable entity a concept text names, or null: a class, occupation or element of the linked layers whose label (or an inflection
 * of it) is the text. A synonym alias ("wind" of the wind instrument, "subject" of the subject field) is not enough for source text,
 * whose words have no sense mark; ambiguous names are left out.
 */
export function linker(index) {
  return text => {
    const t = conceptText(text);
    const hits = (index.names.get(t) ?? []).filter(h => LINKABLE.has(h.kind) && h.inflection);
    const ids = [...new Set(hits.map(h => h.id))];
    return ids.length === 1 ? ids[0] : null;
  };
}

/** Word counts over the problem texts of the owner's books (lowercase alphabetic tokens; the texts themselves are never kept). */
export function bookWordCounts() {
  const counts = new Map();
  for (const line of fs.readFileSync(BOOKS, 'utf8').split('\n')) {
    if (!line) continue;
    for (const w of String(JSON.parse(line).question ?? '').toLowerCase().match(/[a-z]+/g) ?? []) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return counts;
}

/** Book relevance of an entity: over its names, the count of the rarest word of the name; the best name counts. */
export function relevance(index, counts) {
  const byId = new Map();
  for (const [name, hits] of index.names) {
    const words = name.toLowerCase().match(/[a-z]+/g);
    if (!words) continue;
    const c = Math.min(...words.map(w => counts.get(w) ?? 0));
    for (const h of hits) byId.set(h.id, Math.max(byId.get(h.id) ?? 0, c));
  }
  return id => byId.get(id) ?? 0;
}

/**
 * Chooses at most `max` candidate facts ({pred, subj, obj, conf, source}; obj already a symbol or a JSON string): facts the linked
 * layers hold and repeats are dropped, a subject must occur in the books, and the order is book relevance times confidence, with at
 * most `perSubject` facts of one subject so the slice spreads over many concepts, and at most `share[pred]` (a fraction of `max`) of one predicate.
 */
export function select(cands, {index, rel, max = 1500, perSubject = 8, share = {}}) {
  const seen = new Set(), best = new Map();
  for (const c of cands) {
    const key = `${c.pred} ${c.subj} ${c.obj}`;
    if (index.holds.has(key) || rel(c.subj) === 0) continue;
    if (!seen.has(key) || best.get(key).conf < c.conf) { seen.add(key); best.set(key, c); }
  }
  const score = c => Math.log(1 + rel(c.subj)) * (0.25 + c.conf);
  const perSubj = new Map(), perPred = new Map(), out = [];
  for (const c of [...best.values()].sort((x, y) => score(y) - score(x) || (x.subj + x.obj < y.subj + y.obj ? -1 : 1))) {
    if ((perSubj.get(c.subj) ?? 0) >= perSubject || (perPred.get(c.pred) ?? 0) >= (share[c.pred] ?? 1) * max) continue;
    perSubj.set(c.subj, (perSubj.get(c.subj) ?? 0) + 1);
    perPred.set(c.pred, (perPred.get(c.pred) ?? 0) + 1);
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

/** Fact wires of the selected facts, sorted, with ids `<prefix><n>`. */
export const factWires = (facts, prefix) => facts.slice().sort((x, y) => (x.pred + ' ' + x.subj + ' ' + x.obj < y.pred + ' ' + y.subj + ' ' + y.obj ? -1 : 1))
  .map((f, i) => [`@${prefix}${i + 1} fact`, `  holds ${f.pred} ${f.subj} ${f.obj}`, `  source ${JSON.stringify(f.source)}`, ''].join('\n'));

/**
 * Writes a candidate layer: seed.json and the generated files (each part at most MAX_WIRES wires, a header with the title, the
 * licence notice and the modification notice). Generated `.sop` files of an earlier build are replaced; nothing else is touched.
 */
export function writeLayer(layer, seed, parts) {
  const dir = path.join(SEEDS_DIR, layer);
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'seed.json'), JSON.stringify(seed, null, 2) + '\n');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sop'))) fs.rmSync(path.join(dir, f));
  const written = [];
  for (const {base, title, generator, notice, wires} of parts) {
    for (let i = 0, n = 1; i < wires.length; i += MAX_WIRES, n++) {
      const name = wires.length > MAX_WIRES ? `${base}-${String(n).padStart(2, '0')}` : base;
      const text = [`# ${layer}: ${title} (generated by ${generator}; do not edit by hand).`, ...notice.map(l => '# ' + l), '', ...wires.slice(i, i + MAX_WIRES)].join('\n') + '\n';
      fs.writeFileSync(path.join(dir, `${name}.sop`), text);
      written.push({file: `${name}.sop`, wires: Math.min(MAX_WIRES, wires.length - i), bytes: Buffer.byteLength(text)});
    }
  }
  return written;
}

/** The knowledge validator over the layer and its imports, the lexicon build, and the id-collision check against every layer and world-v1. */
export function checkLayer(layer) {
  const files = seedLayers(layer).map(c => ({name: c.name, text: c.text, role: 'knowledge'}));
  const r = validateProgram(files, {authoring: true});
  const errors = r.problems.filter(p => p.severity !== 'warning'), warnings = r.problems.filter(p => p.severity === 'warning');
  let lexicon = null;
  try { lexicon = Lexicon.fromCircuits(files.map(({name, text}) => ({name, text}))); } catch (error) { errors.push({code: 'lexicon_failed', message: error.message}); }
  const own = seedCircuits(layer).flatMap(c => parse(c.text).wires.map(w => w.id));
  const {ids} = takenIds(layer);
  const collisions = own.filter(id => ids.has(id));
  const group = list => Object.entries(list.reduce((m, p) => ((m[p.code] ??= []).push(p), m), {})).map(([code, ps]) => ({code, count: ps.length, examples: ps.slice(0, 3).map(p => `${p.file ?? ''}:${p.line ?? '?'} ${p.message}`)}));
  return {layer, wires: own.length, errors: group(errors), warnings: group(warnings), id_collisions: collisions.slice(0, 20), id_collision_count: collisions.length, lexicon_entities: lexicon ? Object.keys(lexicon.entities).length : null, ok: errors.length === 0 && collisions.length === 0};
}

/** Counts by predicate of the selected facts. */
export const byPredicate = facts => facts.reduce((m, f) => ({...m, [f.pred]: (m[f.pred] ?? 0) + 1}), {});

/** The provenance record of a cached source folder (DS011 rule 7). */
export function writeProvenance(dir, record) {
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'provenance.json'), JSON.stringify(record, null, 1) + '\n');
}
