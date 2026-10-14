/**
 * The KBQA base memories (tools/eval/kbqa/cli.mjs `build`): the Wikidata slice of a suite stage (slice.mjs) is turned mechanically into
 * knowledge circuits and loaded through the product library (lib/chat-data/memories.mjs: validation, SQLite facts, provenance) into the
 * base memory `kbqa-<suite>-<stage>` of the private chat data root datasets_sources/kbqa/chat_data (gitignored; never the product's
 * chat_data). The memory imports `core-min` like every memory.
 *
 * Mechanical mapping, no per-question authoring:
 *   entity     one `entity` wire per item `q<number>`: English label, English aliases (question entities, answers, classes), notability =
 *              Wikipedia editions; kind `class` for every item that is the value of an instance-of statement;
 *   instance of  P31 -> `is_a` facts (the core-min predicate with the class/describe copula readings); P279 is the ordinary predicate "subclass of";
 *   property   P -> two predicates: `p<N>_<label>` (Wikidata direction: subject = the item that carries the statement) and
 *              `p<N>_<label>_of` (the converse: subject = the value; "X is the director of Y"), both with their facts, because the
 *              KnowledgeLinker binds role names to predicate positions and does not yet apply a lexeme's `frame` converse (backlog).
 *              Linking forms come only from the property's English label and aliases: the label gives "<label> of" (converse) and
 *              "has <label>" (direct); an alias that ends in a preposition ("directed by", "born in") is a direct form with and without "be".
 *              Verb lemmas ("direct", "write") cannot be derived mechanically; their absence is a measured lexicon-coverage failure.
 *   value types  items -> entity; quantity, time and string -> value (a time is the ISO date, a quantity the number).
 */
import fs from 'node:fs';
import path from 'node:path';
import {ChatData} from '../../../lib/chat-data/index.mjs';
import {BaseMemories} from '../../../lib/chat-data/memories.mjs';
import {Sessions} from '../../../lib/chat-data/sessions.mjs';
import {ensureSeedMemories, seedLexicon, CORE_SEED} from '../../../lib/knowledge-seeds.mjs';
import {phraseKey} from '../../../sop/text-keys.mjs';
import {CACHE, ROOT} from './benchmarks.mjs';
import {readSuite} from './suites.mjs';
import {fetchSlice} from './slice.mjs';

// KBQA_CHAT_ROOT: another private chat data root (a fresh one, e.g. to rerun a stage on the current seeds without touching the cached root).
export const CHAT_ROOT = process.env.KBQA_CHAT_ROOT ? path.resolve(process.env.KBQA_CHAT_ROOT) : path.join(CACHE, 'chat_data');
export const memoryId = (suite, stage, variant = '') => `kbqa-${suite}-${stage}${variant ? `-${variant}` : ''}`;
export const sliceFile = (suite, stage) => path.join(CACHE, 'slices', `${suite}-${stage}.json`);
const MAX_WIRES = 1800;
const PREPOSITION = /\b(?:by|in|at|from|to|on|with|for|of)$/;
const slug = text => String(text).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const quote = text => JSON.stringify(String(text).replace(/\s+/g, ' ').trim());
const symbol = qid => qid.toLowerCase();

export function openData() {
  fs.mkdirSync(CHAT_ROOT, {recursive: true});
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'runtime.json'), 'utf8'));
  config.chatData = {...config.chatData, root: CHAT_ROOT};
  const chatData = ChatData.open(config, {}, ROOT);
  const memories = new BaseMemories({chatData, memory: config.memory});
  const sessions = new Sessions({chatData, memories, memory: config.memory});
  ensureSeedMemories(memories);
  return {config, chatData, memories, sessions};
}

/** The slice (cached as JSON) of a suite stage. */
export async function loadSlice(suite, stage, {log = console.error} = {}) {
  const file = sliceFile(suite, stage);
  if (fs.existsSync(file)) return reviveSlice(JSON.parse(fs.readFileSync(file, 'utf8')));
  const slice = await fetchSlice(readSuite(suite, stage), {log});
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify({triples: slice.triples, items: [...slice.items], properties: [...slice.properties], perQuestion: slice.perQuestion}));
  return slice;
}
const reviveSlice = data => ({...data, items: new Map(data.items), properties: new Map(data.properties)});

const ROLE_OF_PREPOSITION = {in: 'location', at: 'location', on: 'location', near: 'location', from: 'source', to: 'destination', into: 'destination', with: 'instrument'};
/** The role SymbolicLM gives the complement of a verbal relation phrase that ends in a preposition; nominal "... of" and everything else is `object`. */
const roleOfForm = form => ROLE_OF_PREPOSITION[form.split(' ').at(-1)] ?? 'object';

function valueText(t) {
  const v = String(t.o);
  if (t.type === 'Time') { const m = v.match(/^(-?\d{4,6}-\d\d-\d\d)T/); return m ? m[1] : v; }
  if (t.type === 'Quantity') return v.replace(/^\+/, '');
  return v;
}

/** The slice -> circuits [{name, text}] and a statistics object. */
/**
 * The gradable adjectives of the Wikidata quantity properties (variant `qf`, experiment eval-query-forms-v1): "the largest country", "the most
 * populous city", "which is taller" ask for the highest value of a quantity. This is general knowledge of the property, authored once from the
 * property ids and labels (never from a benchmark question): the rules of SymbolicLM write the adjective as a relation phrase with a value,
 * and this lexeme says which property it measures (the same declaration as config/knowledge/core-en/0200-measures.sop for the product).
 */
export const GRADABLE = Object.freeze({P1082: ['be populous'], P2046: ['be large', 'be big'], P2048: ['be tall', 'be high'], P2043: ['be long'], P2044: ['be high'], P2067: ['be heavy'], P2049: ['be wide'], P2234: ['be big'], P2073: ['be far'], P1129: []});

export function sliceToCircuits(slice, {authored = null, gradable = false} = {}) {
  const stats = {unlabelled_items_dropped: 0, facts_dropped_unlabelled: 0, forms_dropped_shared: 0, items: 0, labelled: 0, predicates: 0, facts: 0, skipped_unlabelled_item_predicates: 0};
  const classes = new Set(slice.triples.filter(t => t.p === 'P31').map(t => t.o));
  const itemIds = new Set();
  for (const t of slice.triples) { if (/^Q\d+$/.test(t.s)) itemIds.add(t.s); if (t.item && /^Q\d+$/.test(t.o)) itemIds.add(t.o); }
  for (const id of slice.items.keys()) itemIds.add(id);

  // predicates
  const used = new Map();
  for (const t of slice.triples) if (t.p !== 'P31') used.set(t.p, (used.get(t.p) ?? 0) + 1);
  const names = new Map();
  const taken = new Set();
  for (const [pid] of [...used].sort((a, b) => b[1] - a[1])) {
    const info = slice.properties.get(pid);
    if (!info?.label) continue;
    let base = `p${pid.slice(1)}_${slug(info.label) || 'property'}`.slice(0, 60);
    while (taken.has(base)) base += '_x';
    taken.add(base); taken.add(`${base}_of`);
    names.set(pid, {direct: base, converse: `${base}_of`, info});
  }
  const decls = [];
  // The knowledge validator refuses one form shared by two predicates: the more used property keeps the form, the others lose it (counted).
  const claimed = new Set([...seedLexicon(CORE_SEED).predicatesByKey.keys()]);
  const claim = forms => { const mine = new Set(); return [...forms].filter(f => { const k = phraseKey(f); if (mine.has(k)) return false; if (claimed.has(k)) { stats.forms_dropped_shared++; return false; } mine.add(k); return true; }).map(f => { claimed.add(phraseKey(f)); return f; }); };
  for (const [pid, n] of names) {
    const type = n.info.type === 'WikibaseItem' ? 'entity' : 'value';
    const label = n.info.label.toLowerCase();
    const aliases = [...new Set(n.info.aliases.map(a => a.toLowerCase().trim()).filter(a => a && a.length < 60))].slice(0, 12);
    const verbal = aliases.filter(a => PREPOSITION.test(a));
    const nominal = [label, ...aliases.filter(a => !PREPOSITION.test(a))];
    // Authored phrases (tag lex, lexicon.mjs) come first; the mechanical forms from the label and aliases always follow.
    const own = authored?.[pid] ?? {direct: [], converse: []};
    const directForms = claim(new Set([...own.direct, `has ${label}`, ...verbal, ...verbal.map(a => `be ${a}`)]));
    const converseForms = claim(new Set([...own.converse, ...nominal.map(a => `${a} of`)]));
    const labelOf = (forms, fallback) => (forms.length ? forms[0] : fallback);
    // A prepositional form carries the role SymbolicLM gives its complement ("born in" -> location); the linker binds role names to
    // predicate positions, so such forms live on a variant predicate whose second role has that name (same facts; backlog: the lexeme
    // frame should map the surface role onto the declared role).
    const split = forms => { const by = new Map(); for (const f of forms) { const role = authored ? roleOfForm(f) : 'object'; (by.get(role) ?? by.set(role, []).get(role)).push(f); } return by; };
    n.variants = [];
    for (const [orientation, forms, base, sentence] of [['direct', directForms, n.direct, 'the subject has this value'], ['converse', converseForms, n.converse, 'the subject is the value of the object']]) {
      const by = split(forms);
      const main = by.get('object') ?? [];
      const signature = role => (orientation === 'direct' ? `subject:entity ${role}:${type}` : `subject:${type} ${role}:entity`);
      decls.push(`@${base} predicate\n  args ${signature('object')}\n  label en ${quote(labelOf(main, `${orientation === 'direct' ? 'has ' + label : label + ' of'} (${pid})`))}\n  description ${quote(`${n.info.label} (Wikidata ${pid}): ${sentence}`)}\n`);
      const lex = (id, of, list, role = 'object') => `@${id} lexeme\n  of ${of}\n  language en\n  pos ${orientation === 'direct' ? 'verb' : 'noun'}\n${list.map(f => `  form ${quote(f)}\n`).join('')}  frame subject ${role}\n  source ${quote(`Wikidata ${pid} label and aliases`)}\n`;
      if (main.length) decls.push(lex(`lx_${base}`, base, main));
      for (const [role, list] of by) {
        if (role === 'object') continue;
        const name = `${base}__${role}`;
        decls.push(`@${name} predicate\n  args ${signature(role)}\n  label en ${quote(list[0])}\n  description ${quote(`${n.info.label} (Wikidata ${pid}): ${sentence}; the object is given as ${role}`)}\n`);
        decls.push(lex(`lx_${name}`, name, list, role));
        n.variants.push({name, orientation});
        stats.predicates++;
      }
    }
    if (gradable && type === 'value' && GRADABLE[pid]?.length) {
      const forms = claim(new Set(GRADABLE[pid]));
      if (forms.length) decls.push(`@lx_${n.direct}_gradable lexeme\n  of ${n.direct}\n  language en\n  pos copula\n${forms.map(f => `  form ${quote(f)}\n`).join('')}  frame subject object\n  source "authored: the gradable adjective of a Wikidata quantity property (tools/eval/kbqa/memory.mjs GRADABLE)"\n`);
    }
    stats.predicates += 2;
  }

  // entities
  const entityWires = [];
  const unlabelledOk = new Set();
  for (const id of [...itemIds].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))) {
    const info = slice.items.get(id);
    stats.items++;
    // An entity without an English label cannot be resolved (the validator refuses it); it and its statements are left out (counted).
    if (!info?.label) { stats.unlabelled_items_dropped++; continue; }
    unlabelledOk.add(id);
    let text = `@${symbol(id)} entity\n`;
    if (classes.has(id)) text += '  kind class\n';
    if (info?.label) {
      stats.labelled++;
      text += `  label en ${quote(info.label)}\n`;
      for (const alias of info.aliases ?? []) if (alias.toLowerCase() !== info.label.toLowerCase()) text += `  alias en ${quote(alias)}\n`;
    }
    if (info?.sitelinks) text += `  notability ${Math.round(info.sitelinks)}\n`;
    text += `  source ${quote(`Wikidata ${id}`)}\n`;
    entityWires.push(text);
  }

  // facts
  const factWires = [];
  const seen = new Set();
  let counter = 0;
  const addFact = (pred, s, o, source) => {
    const key = `${pred} ${s} ${o}`;
    if (seen.has(key)) return;
    seen.add(key);
    factWires.push(`@f${++counter} fact\n  holds ${pred} ${s} ${o}\n  source ${quote(source)}\n`);
    stats.facts++;
  };
  for (const t of slice.triples) {
    if (!/^Q\d+$/.test(t.s)) continue;
    if (!unlabelledOk.has(t.s) || (t.item && !unlabelledOk.has(t.o))) { stats.facts_dropped_unlabelled++; continue; }
    if (t.p === 'P31') { if (/^Q\d+$/.test(t.o)) addFact('is_a', symbol(t.s), symbol(t.o), `Wikidata ${t.s} P31`); continue; }
    const n = names.get(t.p);
    if (!n) { stats.skipped_unlabelled_item_predicates++; continue; }
    const source = `Wikidata ${t.s} ${t.p}`;
    if (t.item) {
      if (!/^Q\d+$/.test(t.o)) continue;
      addFact(n.direct, symbol(t.s), symbol(t.o), source);
      addFact(n.converse, symbol(t.o), symbol(t.s), source);
      for (const v of n.variants) addFact(v.name, ...(v.orientation === 'direct' ? [symbol(t.s), symbol(t.o)] : [symbol(t.o), symbol(t.s)]), source);
    } else {
      const v = quote(valueText(t));
      addFact(n.direct, symbol(t.s), v, source);
      addFact(n.converse, v, symbol(t.s), source);
      for (const x of n.variants) addFact(x.name, ...(x.orientation === 'direct' ? [symbol(t.s), v] : [v, symbol(t.s)]), source);
    }
  }

  const circuits = [];
  const chunk = (name, wires) => { for (let i = 0, part = 1; i < wires.length; i += MAX_WIRES, part++) circuits.push({name: `${name}-${String(part).padStart(2, '0')}`, text: wires.slice(i, i + MAX_WIRES).join('\n')}); };
  chunk('vocabulary', decls.flatMap(d => d.startsWith('@lx_') ? [d] : [d]));
  chunk('entities', entityWires);
  chunk('facts', factWires);
  return {circuits, stats};
}

/** Builds (replaces) the base memory of a suite stage. */
export async function buildMemory(suite, {stage = '100', variant = '', log = console.error} = {}) {
  const t0 = Date.now();
  const slice = await loadSlice(suite, stage, {log});
  let authored = null;
  // `lex`: the authored property phrases; `lexqf`: the same plus the gradable adjectives of the quantity properties (eval-query-forms-v1)
  if (variant === 'lex' || variant === 'lexqf') { const {authorLexicon} = await import('./lexicon.mjs'); authored = await authorLexicon(slice, {log}); }
  const {circuits, stats} = sliceToCircuits(slice, {authored, gradable: variant === 'lexqf'});
  const {memories} = openData();
  const id = memoryId(suite, stage, variant);
  if (memories.list().some(m => m.id === id)) memories.delete(id);
  memories.create({id, name: `KBQA ${suite} stage ${stage}`, imports: [CORE_SEED],
    description: `Wikidata slice for the ${stage} first questions of the KBQA suite ${suite} (tools/eval/kbqa). Evaluation material; not product knowledge.`});
  let warnings = 0, skipped = 0;
  for (const c of circuits) {
    const r = memories.addKnowledge(id, {circuits: [c], approvedBy: 'kbqa-eval-agent', reason: 'mechanical Wikidata slice (evaluation)', source: 'Wikidata (CC0) via WDQS, tools/eval/kbqa'});
    warnings += r.warnings.length;
    for (const a of r.added) skipped += a.ingest.facts_skipped.length;
    if (r.warnings.length) log(`[memory] ${c.name}: ${r.warnings.length} warnings, first: ${JSON.stringify(r.warnings[0]).slice(0, 200)}`);
  }
  return {id, ...stats, circuits: circuits.length, warnings, facts_skipped: skipped, seconds: (Date.now() - t0) / 1000};
}
