/**
 * The canonical vocabulary of a document (ingestion v2, owner design 2026-10-03), built deterministically from the structure pass of
 * every passage, plus one model call for the conflicts it cannot decide:
 *   entities    the entries of all passages are joined when their names fold to the same symbol, or when a capitalised mention of one
 *               (a name as written: "Galileo") is the name of another; the canonical label is the fullest name, the other capitalised
 *               names and mentions are aliases; lowercase mentions (pronouns, descriptions such as "the moon") stay local to their
 *               passage and are shown to the FOL role as hints only. Conflicts asked of the model: a joined entity with different
 *               kinds (one name, two things?), and a short name that is the first or last words of a longer one ("Voyager" / "Voyager 1")
 *   predicates  one per relation: the same snake_case name and arity are one predicate; names of the same arity that share a word are
 *               paraphrase candidates, asked of the model (one predicate per relation, a canonical name)
 *   values      day dates as YYYYMMDD integers through ./dates.mjs, per passage
 * An alias claimed by two entities is dropped from both (an ambiguous name is never linked silently) and reported.
 * Identifiers fold like the FOL converter (lib/formalize/fol/to-sop.mjs `slug`), so a CamelCase predicate or a constant written by the
 * FOL role finds its canonical entry by folding alone.
 */
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {slug} from '../../formalize/fol/to-sop.mjs';
import {datesOf} from './dates.mjs';
import {parse} from '../../../sop/knowledge/index.mjs';

/**
 * The shared vocabulary every document is offered (coordinator request 2026-10-03): the document-analysis relations of
 * config/knowledge/analysis-core-v1/0002-vocabulary.sop (amount, unit_of, component_of, share_of, lower_limit, upper_limit, starts_on,
 * ends_on, precedes, ...), so that documents state totals, parts, limits, shares and dates in the relations the analysis procedures read.
 * Library-only relations (their description starts with "Library data") and the procedures' parameters are not offered.
 */
export const SHARED_VOCABULARY = Object.freeze([fileURLToPath(new URL('../../../config/knowledge/analysis-core-v1/0002-vocabulary.sop', import.meta.url))]);

/** Shared predicates of vocabulary files: [{id, fol, args, reading, names, passages: [], shared: {declaration, key, closed}}]. */
export function sharedPredicates(files = SHARED_VOCABULARY) {
  const out = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const blocks = text.split(/\n(?=@)/);
    for (const w of parse(text).wires.filter(w => w.type === 'predicate')) {
      const get = k => w.fields.find(f => f.key === k)?.value ?? null;
      let description = get('description');
      try { description = JSON.parse(description); } catch { /* kept as written */ }
      if (/^Library data/.test(description ?? '') || w.id === 'analysis_parameter') continue;
      const args = String(get('args') ?? '').split(/\s+/).filter(Boolean).map(a => a.split(':')[1] === 'value' || a.split(':')[1] === 'integer' ? 'number' : a.split(':')[1] === 'time' ? 'date' : a.split(':')[1] === 'text' ? 'text' : 'thing');
      const declaration = blocks.find(b => b.startsWith(`@${w.id} predicate`))?.trim() ?? null;
      out.push({id: w.id, fol: camel(w.id), args, reading: description ?? '', names: [w.id], passages: [], shared: {declaration, key: get('key'), closed: get('closed') === 'true'}});
    }
  }
  return out;
}

const words = s => slug(s).split('_').filter(Boolean);
const capitalised = m => /^\p{Lu}/u.test(String(m).trim());
export const camel = id => id.split('_').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join('');

class Union {
  constructor(n) { this.p = Array.from({length: n}, (_, i) => i); }
  find(i) { while (this.p[i] !== i) { this.p[i] = this.p[this.p[i]]; i = this.p[i]; } return i; }
  join(a, b) { this.p[this.find(a)] = this.find(b); }
  groups() { const g = new Map(); this.p.forEach((_, i) => { const r = this.find(i); if (!g.has(r)) g.set(r, []); g.get(r).push(i); }); return [...g.values()]; }
}
const mostCommon = xs => { const c = new Map(); for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1); return [...c].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0]?.[0]; };
const fullest = names => [...names].sort((a, b) => words(b).length - words(a).length || b.length - a.length || a.localeCompare(b))[0];

/**
 * Entity and predicate candidates of the passages, and the conflict cases for the merge call.
 * `passages`: [{key, units, structure: {entities, relations, values, certainty}}]. `reserved`: ids the memory already declares.
 */
export function collect(passages) {
  const ents = [], preds = [];
  for (const p of passages) {
    for (const e of p.structure?.entities ?? []) ents.push({...e, passage: p.key, id0: slug(e.name)});
    for (const r of p.structure?.relations ?? []) preds.push({...r, passage: p.key, id0: slug(r.name)});
  }
  const eu = new Union(ents.length);
  const byId = new Map();
  ents.forEach((e, i) => { if (!e.id0) return; if (byId.has(e.id0)) eu.join(i, byId.get(e.id0)); else byId.set(e.id0, i); });
  ents.forEach((e, i) => { for (const m of e.mentions) if (capitalised(m) && byId.has(slug(m)) && slug(m) !== e.id0) eu.join(i, byId.get(slug(m))); });
  const clusters = eu.groups().map(ix => ix.map(i => ents[i])).filter(c => c.some(e => e.id0));
  const pu = new Union(preds.length);
  const pKey = new Map();
  preds.forEach((r, i) => { const k = `${r.id0}/${r.args.length}`; if (pKey.has(k)) pu.join(i, pKey.get(k)); else pKey.set(k, i); });
  const pclusters = pu.groups().map(ix => ix.map(i => preds[i]));
  return {clusters, pclusters};
}

/** The conflict cases: [{case, type, names, lines, members}] (members: name → the clusters it stands for). */
export function conflictCases({clusters, pclusters}) {
  const cases = [];
  const add = (type, items) => { if (items.length > 1 && items.length <= 12) cases.push({case: cases.length + 1, type, names: items.map(x => x.name), lines: items.map(x => `- "${x.name}" (${x.detail}); example: ${JSON.stringify(x.example)}`), items}); };
  // One name, several kinds: are they one thing?
  for (const c of clusters) {
    const variants = new Map();
    for (const e of c) { const k = `${e.name} [${e.kind}]`; if (!variants.has(k)) variants.set(k, {name: k, detail: `kind ${e.kind}`, example: e.mentions.join(' / ').slice(0, 120), entities: []}); variants.get(k).entities.push(e); }
    const kinds = new Set(c.map(e => slug(e.kind)));
    if (kinds.size > 1) add('entities: the same name with different kinds; group the names that are the same thing', [...variants.values()]);
  }
  // A capitalised short name that is the first or last words of another cluster's name.
  const named = clusters.map(c => ({c, name: fullest(c.map(e => e.name)), w: words(fullest(c.map(e => e.name)))})).filter(x => capitalised(x.name));
  const seen = new Set();
  for (const a of named) for (const b of named) {
    if (a === b || a.w.length >= b.w.length || !a.w.length) continue;
    const head = b.w.slice(0, a.w.length).join('_') === a.w.join('_'), tail = b.w.slice(-a.w.length).join('_') === a.w.join('_');
    if (!head && !tail) continue;
    const key = `${a.name}|${b.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    add('entities: a short name inside a longer one; group them only if they are the same thing', [a, b].map(x => ({name: x.name, detail: `kind ${mostCommon(x.c.map(e => e.kind))}`, example: x.c.flatMap(e => e.mentions).slice(0, 4).join(' / '), cluster: x.c})));
  }
  // Paraphrased predicates: same arity, a shared word of the name.
  const pw = pclusters.map(pc => ({pc, name: pc[0].id0, n: pc[0].args.length, w: new Set(words(pc[0].id0).filter(w => w.length > 2))}));
  const pu = new Union(pw.length);
  for (let i = 0; i < pw.length; i++) for (let j = i + 1; j < pw.length; j++) {
    if (pw[i].n !== pw[j].n) continue;
    const shared = [...pw[i].w].filter(w => pw[j].w.has(w)).length;
    const union = new Set([...pw[i].w, ...pw[j].w]).size;
    if (shared && shared / union >= 0.34) pu.join(i, j);
  }
  for (const g of pu.groups()) if (g.length > 1) add('predicates: group the names that state the same relation with the same argument order', g.map(i => ({name: pw[i].name, detail: `args ${pw[i].pc[0].args.join(', ')}; reading ${JSON.stringify(pw[i].pc[0].reading)}`, example: pw[i].pc[0].reading, pcluster: pw[i].pc})));
  return cases;
}

/**
 * The canonical vocabulary from the clusters and the merge decisions (Map case → [{canonical, members}]; a case without a decision is
 * left as the deterministic merge made it and reported). Returns {entities, predicates, aliases, local, dates, report}.
 */
export function canonical({clusters, pclusters}, cases, decisions, passages, {reserved = new Set()} = {}) {
  const report = {entity_conflicts: [], ambiguous_aliases: [], predicate_merges: [], undecided: []};
  // Entities: start from the clusters; split or join them by the decisions.
  let groups = clusters.map(c => ({members: [...c], canonical: null}));
  const groupOf = e => groups.find(g => g.members.includes(e));
  for (const k of cases) {
    if (!k.type.startsWith('entities')) continue;
    const d = decisions.get(k.case);
    if (!d) { report.undecided.push({case: k.case, names: k.names}); continue; }
    if (k.items[0].entities) {
      // Split one cluster into the decided groups.
      const g = groupOf(k.items[0].entities[0]);
      if (!g) continue;
      const fresh = d.map(x => ({members: x.members.flatMap(m => k.items.find(i => i.name === m)?.entities ?? []), canonical: x.canonical}));
      if (fresh.length > 1) report.entity_conflicts.push({case: k.case, split: d.map(x => x.canonical)});
      groups = [...groups.filter(x => x !== g), ...fresh.filter(x => x.members.length)];
    } else {
      // Join the clusters a decision groups together.
      for (const x of d) {
        if (x.members.length < 2) continue;
        const gs = [...new Set(x.members.flatMap(m => k.items.find(i => i.name === m)?.cluster ?? []).map(groupOf).filter(Boolean))];
        if (gs.length < 2) continue;
        const joined = {members: gs.flatMap(g => g.members), canonical: x.canonical};
        groups = [...groups.filter(g => !gs.includes(g)), joined];
        report.entity_conflicts.push({case: k.case, joined: x.members, canonical: x.canonical});
      }
    }
  }
  // A capitalised mention is a name only when the passages also write it capitalised inside a sentence: a word capitalised only because
  // it opens a sentence ("It", "They") is not a name (structure: position and case, no word list).
  const text = passages.flatMap(p => p.units.map(u => u.text)).join('\n');
  const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const named = m => new RegExp(`[^.!?:;\\s"“(]\\s+${esc(m)}(?![\\p{L}\\p{N}])`, 'u').test(text);
  const entities = [];
  const taken = new Set(reserved);
  for (const g of groups) {
    const names = g.members.map(e => e.name);
    const label = g.canonical && names.some(n => slug(n) === slug(g.canonical)) ? g.canonical : g.canonical ?? fullest(names);
    let id = slug(label) || slug(names[0]);
    if (!id) continue;
    if (!/^[a-z]/.test(id)) id = `n_${id}`;
    while (taken.has(id) && !reserved.has(id)) id += '_2';
    taken.add(id);
    // Aliases: every name the passages gave the thing, and its capitalised mentions (names as written); lowercase mentions stay local.
    const proper = [...new Set([...names, ...g.members.flatMap(e => e.mentions).filter(capitalised).filter(named)].filter(m => slug(m) !== slug(label)))];
    entities.push({id, label, kind: slug(mostCommon(g.members.map(e => e.kind))) || 'thing', aliases: proper, passages: [...new Set(g.members.map(e => e.passage))],
      local: g.members.flatMap(e => e.mentions.filter(m => !capitalised(m)).map(m => ({passage: e.passage, text: m})))});
  }
  // An alias two entities claim is ambiguous: dropped from both.
  const claims = new Map();
  for (const e of entities) for (const a of [e.label, ...e.aliases]) { const k = slug(a); if (!claims.has(k)) claims.set(k, new Set()); claims.get(k).add(e.id); }
  for (const e of entities) e.aliases = e.aliases.filter(a => { const owners = claims.get(slug(a)); if (owners.size > 1 && slug(a) !== slug(e.label)) { report.ambiguous_aliases.push({alias: a, entities: [...owners]}); return false; } return true; });
  // Predicates: the clusters, joined by the decisions.
  let pgroups = pclusters.map(pc => ({members: [...pc], canonical: null}));
  for (const k of cases) {
    if (!k.type.startsWith('predicates')) continue;
    const d = decisions.get(k.case);
    if (!d) { report.undecided.push({case: k.case, names: k.names}); continue; }
    for (const x of d) {
      const gs = [...new Set(x.members.flatMap(m => k.items.find(i => i.name === m)?.pcluster ?? []).map(r => pgroups.find(g => g.members.includes(r))).filter(Boolean))];
      if (gs.length < 2) continue;
      pgroups = [...pgroups.filter(g => !gs.includes(g)), {members: gs.flatMap(g => g.members), canonical: slug(x.canonical)}];
      report.predicate_merges.push({case: k.case, joined: x.members, canonical: slug(x.canonical)});
    }
  }
  const predicates = [];
  const ptaken = new Set();
  for (const g of pgroups) {
    const n = g.members[0].args.length;
    let id = g.canonical && g.members.every(r => r.args.length === n) ? g.canonical : mostCommon(g.members.map(r => r.id0));
    if (!/^[a-z]/.test(id)) id = `p_${id}`;
    while (ptaken.has(`${id}/${n}`) || entities.some(e => e.id === id)) id += '_rel';
    ptaken.add(`${id}/${n}`);
    const lead = g.members.find(r => r.id0 === id) ?? g.members[0];
    const single = g.members.filter(r => r.one_value === true).length > g.members.length / 2;
    predicates.push({id, fol: camel(id), args: lead.args, reading: lead.reading, names: [...new Set(g.members.map(r => r.id0))], passages: [...new Set(g.members.map(r => r.passage))], ...(single && n >= 2 ? {key: 1} : {})});
  }
  // Day dates per passage.
  const dates = Object.fromEntries(passages.map(p => [p.key, datesOf(p.units.map(u => u.text).join('\n'), (p.structure?.values ?? []).filter(v => v.type === 'date').map(v => v.text))]));
  return {entities, predicates, dates, report};
}

/** Lookup maps of a vocabulary: predicate name (any spelling) → canonical predicate; constant → canonical entity. */
export function lookups(vocab) {
  const pred = new Map(), ent = new Map();
  for (const p of vocab.predicates) for (const n of [p.id, ...p.names]) { const k = `${slug(n)}/${p.args.length}`; if (!pred.has(k)) pred.set(k, p); }
  for (const e of vocab.entities) for (const n of [e.id, e.label, ...e.aliases]) { const k = slug(n); if (k && !ent.has(k)) ent.set(k, e); }
  return {predicate: (name, arity) => pred.get(`${slug(name)}/${arity}`) ?? null, entity: name => ent.get(slug(name)) ?? null};
}

/** The FOL role's inventory for a passage: the document's predicates, its things (all of them up to `max`), the passage's dates. */
export function inventoryText(vocab, passageKey, tpl, {title, section, max = 150}) {
  const predicates = vocab.predicates.map(p => `  ${p.fol}(${p.args.join(', ')})${p.reading ? `: ${p.reading}` : ''}`).join('\n') || '  (none yet)';
  const mine = vocab.entities.filter(e => e.passages.includes(passageKey));
  const rest = vocab.entities.filter(e => !e.passages.includes(passageKey));
  const shown = [...mine, ...rest].slice(0, max);
  const constants = shown.map(e => {
    const local = mine.includes(e) ? [...new Set(e.local.filter(l => l.passage === passageKey).map(l => l.text))] : [];
    const also = [...e.aliases, ...local].slice(0, 6);
    return `  ${e.id}: ${e.kind.replace(/_/g, ' ')} "${e.label}"${also.length ? `; also ${also.map(a => JSON.stringify(a)).join(', ')}` : ''}`;
  }).join('\n') || '  (none)';
  const dates = (vocab.dates[passageKey] ?? []).map(d => `${d.text} = ${d.value}`).join(', ') || '(none)';
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => ({title, section, predicates, constants, dates})[k] ?? '');
}
