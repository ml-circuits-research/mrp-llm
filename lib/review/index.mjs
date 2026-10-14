/**
 * The knowledge browser behind `/review` (DS022 "Knowledge browser"; owner requests of 2026-10-02: "where can I review world-v1 and
 * core-en" and "search by keywords and see what the current memory knows"). Read only: it never writes knowledge, and there is no
 * accept or reject step (AGENTS.md direction 8).
 *
 *   listMemories()        every base memory with its layers, provenance summary, counts and ingestions
 *   memoryView(id)        one memory: layers with provenance and per-layer flag statistics, the world-v1 mapping table, ingestions
 *   items(target, layer)  the risk-sorted items of a layer (items.mjs) with evidence and, for the page shown, examples
 *   search(target, q)     keyword search: entities, classes, predicates (labels, aliases, lexeme forms, descriptions), rules, text facts
 *   entity / predicate / rule cards, and derive(target, entity): what the oracle derives about an entity, with proofs
 *
 * A target is a base memory or a chat session (target.mjs). Search reads the compiled lexicon's token index and the per-layer text
 * index; cards read facts through indexed lookups of the memory strategy (never a scan of all facts); derive asks the oracle
 * (`askMemory`, the StrategyRouter's exact route with proof) a bounded number of queries.
 */
import {fold, tokens as textTokens} from '../../sop/text-keys.mjs';
import {tokens as wireTokens} from '../../sop/knowledge/lexical.mjs';
import {askMemory} from '../../reasoning/slice/index.mjs';
import {renderEnglish} from '../../reasoning/slice/render-english.mjs';
import {Ingestions} from '../ingest/index.mjs';
import {seedIds, seedInfo} from '../knowledge-seeds.mjs';
import {Targets} from './target.mjs';
import {Evidence} from './evidence.mjs';
import {layerItems, selectItems, itemStats, isWorldKb, formReport} from './items.mjs';
import {formSentence, fillersFromFact, sayAtom, ruleExample, ruleShape, labelOf} from './examples.mjs';

const fail = (message, code = 'invalid_request', status = 400) => Object.assign(new Error(message), {code, status});
const RULES = ['rule', 'default', 'aggregate', 'integrity', 'procedure', 'method', 'norm'];
const VALUE_TYPES = new Set(['integer', 'time', 'text', 'value']);
const field = (w, key) => w.fields.find(f => f.key === key)?.value.trim();
const unquote = s => (s?.startsWith('"') ? JSON.parse(s) : s);
const term = v => (typeof v === 'number' ? String(v) : /^[a-z][a-z0-9_]*$/.test(v) ? v : JSON.stringify(v));
const wireSource = w => `@${w.id} ${w.type}\n${w.fields.map(f => `  ${f.key}${f.value ? ' ' + f.value : ''}\n${(f.block ?? []).map(b => ' '.repeat(b.indent ?? 4) + b.text + '\n').join('')}`).join('')}`.trimEnd();
const english = w => { try { return renderEnglish({wires: [w]}); } catch { return null; } };
const roleList = p => (p.roles?.length ? p.roles : (p.args ?? []).map((type, i) => ({name: ['subject', 'object'][i] ?? `arg${i}`, type})));

/** Groups provenance records: kind, approver and source with counts and the first and last dates. */
export function provenanceSummary(records) {
  const groups = new Map();
  for (const r of records) {
    const source = typeof r.source === 'string' ? r.source : r.source?.kind === 'document' ? `document ${r.source.title ?? r.source.document} (${r.source.rights ?? '?'})` : r.source ? JSON.stringify(r.source).slice(0, 80) : r.kind === 'import-layer' ? `import of ${r.id}` : r.kind === 'fork' ? `fork of ${r.from}` : '';
    const key = `${r.kind}\0${r.approved_by ?? ''}\0${source}`;
    const g = groups.get(key) ?? groups.set(key, {kind: r.kind, by: r.approved_by ?? null, source, records: 0, wires: 0, facts: 0, first: null, last: null, reason: r.reason ?? null}).get(key);
    const at = r.approved_at ?? r.at ?? null;
    g.records++; g.wires += r.wires ?? 0; g.facts += r.ingest?.facts_ingested ?? 0;
    if (at && (!g.first || at < g.first)) g.first = at;
    if (at && (!g.last || at > g.last)) g.last = at;
  }
  return [...groups.values()];
}

export class KnowledgeBrowser {
  constructor({memories, sessions = null, evidence = new Evidence()}) {
    Object.assign(this, {memories, sessions, evidence});
    this.targets = new Targets({memories, sessions});
    this.ingestions = new Ingestions({memories});
    this.itemCache = new Map();
  }

  target(spec, who = {}) { return this.targets.resolve(spec, who); }

  /** The layer list of a target with kind, size and counts (no parsing of large layers beyond the cached summary). */
  layers(target) {
    return target.summary().map((s, i) => ({id: s.id, kind: target.layers[i].kind, name: target.layers[i].name, files: s.files.length, bytes: s.bytes, facts: s.facts,
      wires: s.types, entities: Object.values(s.entitiesByKind).reduce((a, b) => a + b, 0), parse_errors: s.parse_errors,
      ...(target.layers[i].kind === 'seed' ? {seed: {source: `config/knowledge/${s.id}`, description: safeSeed(s.id)?.description ?? null}} : {})}));
  }

  /** Every base memory: manifest, layers (ids only, cheap), provenance summary and ingestions. */
  listMemories() {
    const seeds = new Set(seedIds());
    return this.memories.list().map(m => ({id: m.id, name: m.name, description: m.description, created_at: m.created_at, strategy: m.strategy, circuits: m.circuits, facts: m.facts, ...this.memories.stats(m.id),
      parent: m.parent?.id ?? null, seed: seeds.has(m.id), layers: [...(m.imports ?? []).map(l => l.id), m.id],
      provenance: provenanceSummary(this.memories.provenance(m.id)), ingestions: this.ingestions.list(m.id)}));
  }

  /** One base memory in detail: layers with flag statistics, provenance, ingestions, the mapping table when a layer is the Wikidata build. */
  memoryView(id) {
    const target = this.target({memory: id});
    const layers = this.layers(target).map(l => ({...l, stats: itemStats(this.items(target, l.id))}));
    const world = target.layers.some(l => isWorldKb(target, l.id));
    return {id, name: target.name, info: target.info, layers, provenance: provenanceSummary(target.provenance()), ingestions: this.ingestions.list(id),
      evidence: {available: this.evidence.available(), reports: target.layers.some(l => l.id === 'core-en') ? ['eval/reports/current/core-en/summary.md'] : []},
      mapping: world ? this.evidence.mappingTable() : null};
  }

  /** The items of one layer, cached per target fingerprint. */
  items(target, layer) {
    const key = `${target.kind}:${target.id}:${target.fingerprint}:${layer}`;
    if (!this.itemCache.has(key)) {
      this.itemCache.set(key, layerItems(target, layer, this.evidence));
      while (this.itemCache.size > 24) this.itemCache.delete(this.itemCache.keys().next().value);
    }
    return this.itemCache.get(key);
  }

  /** A page of risk-sorted items with examples (sentences for forms and predicates, derivations for rules, sample facts for groups). */
  itemPage(target, layer, options = {}) {
    const all = this.items(target, layer);
    const page = selectItems(all, options);
    return {target: {kind: target.kind, id: target.id}, layer, stats: itemStats(all), ...page, items: page.items.map(item => ({...item, examples: this.examples(target, item)}))};
  }

  recall(target, pattern, limit = 10) {
    return target.read((repo, session) => repo.recall(session, pattern, {asof: Infinity}, {limit}).rows);
  }

  /** One real fact of a predicate as sentence fillers, or null. */
  fillers(target, predicate) {
    const arity = roleList(predicate).length;
    if (!arity || arity > 4) return null;
    const row = this.recall(target, {p: predicate.id, a: Array.from({length: arity}, (_, i) => `?v${i}`), neg: false}, 1)[0];
    return row ? fillersFromFact(target.lexicon, predicate, row.atom) : null;
  }

  examples(target, item) {
    const lexicon = target.lexicon;
    try {
      if (item.type === 'lexeme') {
        const p = lexicon.predicates[item.of];
        const lexeme = p?.lexemes.find(l => l.id === item.id);
        if (!lexeme) return [];
        const fillers = this.fillers(target, p);
        return lexeme.forms.slice(0, 3).map(form => formSentence({lexicon, predicate: p, lexeme, form, fillers}));
      }
      if (item.type === 'predicate') return this.predicateSentences(target, lexicon.predicates[item.id]);
      if (['rule', 'default', 'aggregate', 'integrity'].includes(item.type)) {
        const found = target.wire(item.id);
        return found ? [this.derivationExample(target, found.wire)] : [];
      }
      if (item.type === 'facts') {
        const p = lexicon.predicates[item.id];
        const arity = p ? roleList(p).length : 2;
        return this.recall(target, {p: item.id, a: Array.from({length: arity}, (_, i) => `?v${i}`), neg: false}, 3).map(r => this.factView(target, r));
      }
      if (item.type === 'entities') return Object.values(lexicon.entities).filter(e => e.entityType === item.id).slice(0, 3).map(e => ({entity: e.id, label: e.labels?.en ?? e.id, description: e.description ?? null}));
    } catch (error) { return [{error: String(error.message).slice(0, 200)}]; }
    return [];
  }

  predicateSentences(target, p) {
    if (!p) return [];
    const fillers = this.fillers(target, p);
    return p.lexemes.filter(l => l.language === 'en').slice(0, 3).map(lexeme => formSentence({lexicon: target.lexicon, predicate: p, lexeme, form: lexeme.forms[0], fillers}));
  }

  derivationExample(target, wire) {
    const ex = ruleExample(wire, {lexicon: target.lexicon, recall: (pattern, limit) => this.recall(target, pattern, limit).map(r => r.atom)});
    const say = a => ({atom: `${a.neg ? 'not ' : ''}${a.p} ${a.a.map(term).join(' ')}`, sentence: sayAtom(target.lexicon, a)});
    return {derivation: true, real: ex.real.map(d => ({facts: d.facts.map(say), head: say(d.head)})), hypothetical: ex.hypothetical ? {facts: ex.hypothetical.facts.map(say), head: say(ex.hypothetical.head)} : null, note: ex.note};
  }

  /** A stored fact as the browser shows it: atom, sentence, source, quote and the layer it comes from. */
  factView(target, row) {
    const atom = row.atom;
    return {atom: `${atom.neg ? 'not ' : ''}${atom.p} ${atom.a.map(term).join(' ')}`, p: atom.p, args: atom.a, neg: Boolean(atom.neg), sentence: sayAtom(target.lexicon, atom),
      source: row.source ?? row.claim?.source ?? null, quote: row.quote || null, layer: target.layerOfFact(atom)};
  }

  // ---- search --------------------------------------------------------------------------------------------------------------

  /**
   * Keyword search over a target. Every word must match (the last one also as a prefix). Groups: entities, classes, predicates,
   * rules, facts (text values); each group is ranked and paged (`kind` pages one group, `offset`/`limit`).
   */
  search(target, q, {kind = null, offset = 0, limit = 10} = {}) {
    const query = fold(String(q ?? '')).trim();
    const words = textTokens(query);
    if (!words.length) return {q, groups: {}, total: 0};
    if (words.length > 12 || query.length > 200) throw fail('A search has at most 12 words and 200 characters', 'invalid_parameter');
    const lexicon = target.lexicon;
    const groups = {entities: [], classes: [], predicates: [], rules: [], facts: []};
    // 1. lexicon entries (labels, aliases, lexeme forms and ids of entities and predicates)
    const sets = words.map((w, i) => {
      const hits = new Set(lexicon.index.get(w) ?? []);
      if (i === words.length - 1 && w.length >= 2) {
        let keys = 0;
        for (const [key, ix] of lexicon.index) { if (key !== w && key.startsWith(w)) { for (const x of ix) hits.add(x); if (++keys >= 400) break; } }
      }
      return hits;
    }).sort((a, b) => a.size - b.size);
    const best = new Map();
    for (const ix of sets[0] ?? []) {
      if (!sets.every(s => s.has(ix))) continue;
      const e = lexicon.entries[ix];
      let score = e.folded === query ? 100 : e.folded.startsWith(query) ? 80 : 60 - Math.max(0, textTokens(e.folded).length - words.length) * 3;
      if (e.derived) score -= 10;
      const item = e.kind === 'entity' ? lexicon.entities[e.id] : lexicon.predicates[e.id];
      if (item?.notability) score += Math.min(15, Math.log2(1 + item.notability) * 2);
      const prev = best.get(e.kind + ':' + e.id);
      if (!prev || prev.score < score) best.set(e.kind + ':' + e.id, {kind: e.kind, id: e.id, score, matched: e.surface});
    }
    for (const hit of best.values()) {
      if (hit.kind === 'predicate') {
        const p = lexicon.predicates[hit.id];
        groups.predicates.push({id: p.id, label: p.labels?.en ?? p.id, description: p.description, matched: hit.matched, score: hit.score, facts: p.factCount ?? null});
      } else {
        const e = lexicon.entities[hit.id];
        const row = {id: e.id, label: e.labels?.en ?? e.id, class: e.entityType, description: e.description ?? null, notability: e.notability, matched: hit.matched, score: hit.score, layer: target.layerOfEntity(e.id)};
        (e.entityType === 'class' ? groups.classes : groups.entities).push(row);
      }
    }
    // 2. predicate descriptions (not in the token index)
    for (const p of Object.values(lexicon.predicates)) {
      if (best.has('predicate:' + p.id) || !p.description) continue;
      const toks = new Set(textTokens(fold(p.description)));
      if (words.every((w, i) => toks.has(w) || (i === words.length - 1 && [...toks].some(t => t.startsWith(w))))) groups.predicates.push({id: p.id, label: p.labels?.en ?? p.id, description: p.description, matched: 'description', score: 40, facts: p.factCount ?? null});
    }
    // 3. rules and procedures: id, description, source and the predicates they use
    for (const {wire: w, layer, file} of target.wires(RULES)) {
      const shape = ['procedure', 'method', 'norm'].includes(w.type) ? null : ruleShape(w);
      const text = fold([w.id.replace(/_/g, ' '), unquote(field(w, 'description') ?? '') ?? '', unquote(field(w, 'source') ?? '') ?? '', shape?.head?.p ?? '', ...(shape?.body ?? []).map(a => a.p)].join(' ').replace(/_/g, ' '));
      const toks = new Set(textTokens(text));
      if (words.every((x, i) => toks.has(x) || (i === words.length - 1 && [...toks].some(t => t.startsWith(x))))) groups.rules.push({id: w.id, type: w.type, layer, file, head: shape?.head?.p ?? null, body: shape?.body.map(a => a.p) ?? [], description: unquote(field(w, 'description') ?? '') ?? null, score: toks.has(words[0]) ? 50 : 40});
    }
    // 4. text values of facts (descriptions, codes, symbols, dates)
    for (const s of target.summary()) {
      const lists = words.map((w, i) => {
        const refs = new Set(s.textIndex.get(w) ?? []);
        if (i === words.length - 1 && w.length >= 2) { let keys = 0; for (const [key, r] of s.textIndex) { if (key !== w && key.startsWith(w)) { for (const x of r) refs.add(x); if (++keys >= 200) break; } } }
        return refs;
      }).sort((a, b) => a.size - b.size);
      for (const ref of lists[0] ?? []) {
        if (!lists.every(l => l.has(ref))) continue;
        const f = s.textFacts[ref];
        const value = fold(f.texts.join(' '));
        const exact = value === query ? 60 : words.every(w => textTokens(value).includes(w)) ? 40 : 30;
        groups.facts.push({atom: `${f.neg ? 'not ' : ''}${f.p} ${f.a.map(term).join(' ')}`, p: f.p, args: f.a, sentence: sayAtom(lexicon, f), layer: s.id, subject: typeof f.a[0] === 'string' && lexicon.entities[f.a[0]] ? f.a[0] : null, score: exact});
        if (groups.facts.length >= 2000) break;
      }
    }
    for (const g of Object.values(groups)) g.sort((a, b) => b.score - a.score || String(a.label ?? a.id ?? a.atom).localeCompare(String(b.label ?? b.id ?? b.atom)));
    const page = {};
    let total = 0;
    for (const [name, list] of Object.entries(groups)) {
      total += list.length;
      const from = kind === name ? offset : 0;
      if (!kind || kind === name) page[name] = {total: list.length, offset: from, items: list.slice(from, from + limit)};
    }
    return {q, target: {kind: target.kind, id: target.id}, total, groups: page};
  }

  // ---- cards ---------------------------------------------------------------------------------------------------------------

  /** Stored facts about an entity in both directions (keyed lookups per declared predicate and position), grouped by predicate. */
  entityFacts(target, id, {perLookup = 50} = {}) {
    const lexicon = target.lexicon;
    const rows = new Map();
    target.read((repo, session) => {
      for (const p of Object.values(lexicon.predicates)) {
        const roles = roleList(p);
        if (!roles.length || roles.length > 4) continue;
        roles.forEach((role, i) => {
          if (VALUE_TYPES.has(role.type)) return;
          const pattern = {p: p.id, a: roles.map((_, j) => (j === i ? id : `?v${j}`)), neg: false};
          for (const neg of [false, true]) for (const row of repo.recall(session, {...pattern, neg}, {asof: Infinity}, {limit: perLookup}).rows) rows.set(row.id ?? JSON.stringify(row.atom), {row, position: i});
        });
      }
    });
    const groups = new Map();
    for (const {row, position} of rows.values()) {
      const key = `${row.atom.p}\0${position}`;
      const g = groups.get(key) ?? groups.set(key, {predicate: row.atom.p, position, role: roleList(lexicon.predicates[row.atom.p] ?? {})[position]?.name ?? `arg${position}`, facts: []}).get(key);
      g.facts.push(this.factView(target, row));
    }
    return [...groups.values()].sort((a, b) => a.position - b.position || a.predicate.localeCompare(b.predicate));
  }

  entity(target, id) {
    const lexicon = target.lexicon;
    const e = lexicon.entities[id];
    if (!e) throw fail(`No entity ${JSON.stringify(id)} in ${target.kind} ${target.id}`, 'unknown_entity', 404);
    const facts = this.entityFacts(target, id);
    const used = new Set(facts.map(g => g.predicate));
    const rules = target.wires(['rule', 'default']).map(({wire, layer}) => ({wire, layer, shape: ruleShape(wire)}))
      .filter(r => r.shape.body.some(a => used.has(a.p))).slice(0, 40)
      .map(r => ({id: r.wire.id, type: r.wire.type, layer: r.layer, head: r.shape.head?.p ?? null, body: r.shape.body.map(a => a.p)}));
    const isClass = e.entityType === 'class';
    const subclasses = isClass ? [...lexicon.isA].filter(([child, parents]) => parents.has(id) && lexicon.classes[child]).map(([child]) => child).slice(0, 50) : [];
    const members = isClass ? this.recall(target, {p: 'is_a', a: ['?x', id], neg: false}, 20).map(r => ({id: r.atom.a[0], label: labelOf(lexicon, r.atom.a[0])})) : [];
    return {kind: 'entity', target: {kind: target.kind, id: target.id}, id, label: e.labels?.en ?? id, aliases: e.aliases.map(a => ({surface: a.surface, language: a.language, ...(a.derived ? {derived: a.derived} : {})})),
      class: e.entityType, classes: [...lexicon.classesOf(id)].map(c => ({id: c, label: lexicon.entities[c]?.labels?.en ?? c})), description: e.description ?? null, notability: e.notability,
      layer: target.layerOfEntity(id), facts, facts_total: facts.reduce((n, g) => n + g.facts.length, 0), rules, subclasses, members,
      note: 'Facts are the stored facts in both directions (at most 50 per predicate and direction); derive asks the oracle what the rules add.'};
  }

  predicate(target, id) {
    const lexicon = target.lexicon;
    const p = lexicon.predicates[id];
    if (!p) throw fail(`No predicate ${JSON.stringify(id)} in ${target.kind} ${target.id}`, 'unknown_predicate', 404);
    const declared = target.wire(id);
    const perLayer = target.summary().map(s => ({layer: s.id, facts: s.factsByPredicate[id] ?? 0})).filter(x => x.facts);
    const arity = roleList(p).length;
    const examples = arity && arity <= 4 ? this.recall(target, {p: id, a: Array.from({length: arity}, (_, i) => `?v${i}`), neg: false}, 6).map(r => this.factView(target, r)) : [];
    const all = target.wires(['rule', 'default', 'aggregate', 'integrity']).map(({wire, layer}) => ({wire, layer, shape: ruleShape(wire)}));
    const brief = r => ({id: r.wire.id, type: r.wire.type, layer: r.layer, head: r.shape.head?.p ?? null, body: r.shape.body.map(a => a.p)});
    const world = target.layers.some(l => isWorldKb(target, l.id) && perLayer.some(x => x.layer === l.id));
    return {kind: 'predicate', target: {kind: target.kind, id: target.id}, id, label: p.labels?.en ?? id, description: p.description, roles: roleList(p), closed: p.closed, readings: p.readings, describe_rank: p.describeRank,
      layer: declared?.layer ?? null, file: declared?.file ?? null, facts: perLayer, facts_total: perLayer.reduce((n, x) => n + x.facts, 0),
      lexemes: p.lexemes.map(l => {
        const wire = target.wire(l.id)?.wire;
        const src = `${unquote(wire ? field(wire, 'source') ?? '' : '') ?? ''} ${p.description ?? ''}`;
        return {id: l.id, language: l.language, pos: l.pos, frame: l.frame, converse: l.converse, restrict: l.restrict, weight: l.weight, source: wire ? unquote(field(wire, 'source') ?? '') ?? null : null,
          forms: l.forms.map(form => formReport({lexicon, predicate: p, lexeme: l, form, evidence: this.evidence, source: src}))};
      }),
      sentences: this.predicateSentences(target, p), examples,
      concluded_by: all.filter(r => r.shape.head?.p === id).map(brief), used_by: all.filter(r => r.shape.body.some(a => a.p === id)).map(brief),
      dropped: this.evidence.dropped?.get(id) ?? [], mapping: world ? this.evidence.mapping(id) : []};
  }

  rule(target, id) {
    const found = target.wire(id);
    if (!found || !RULES.includes(found.wire.type)) throw fail(`No rule ${JSON.stringify(id)} in ${target.kind} ${target.id}`, 'unknown_rule', 404);
    const w = found.wire;
    const shape = ['procedure', 'method', 'norm'].includes(w.type) ? null : ruleShape(w);
    return {kind: 'rule', target: {kind: target.kind, id: target.id}, id, type: w.type, layer: found.layer, file: found.file, sop: wireSource(w), english: english(w),
      head: shape?.head?.p ?? null, body: shape?.body.map(a => a.p) ?? [], source: unquote(field(w, 'source') ?? '') ?? null, quote: unquote(field(w, 'quote') ?? '') ?? null,
      description: unquote(field(w, 'description') ?? '') ?? null, example: shape ? this.derivationExample(target, w) : null};
  }

  // ---- derive --------------------------------------------------------------------------------------------------------------

  /**
   * What the oracle derives about an entity: for the rules whose bodies use the entity's stored predicates, the head predicate is asked
   * with the entity in each admissible position (at most `maxQueries` queries); answers that are not stored facts are derived facts, and
   * the first `maxProofs` are explained (proof tree from the oracle). Read only.
   */
  derive(target, entity, {predicate = null, maxQueries = 12, maxProofs = 8} = {}) {
    const lexicon = target.lexicon;
    if (!lexicon.entities[entity]) throw fail(`No entity ${JSON.stringify(entity)} in ${target.kind} ${target.id}`, 'unknown_entity', 404);
    const facts = this.entityFacts(target, entity);
    const stored = new Set(facts.flatMap(g => g.facts.map(f => f.atom)));
    const used = new Set(facts.map(g => g.predicate));
    const heads = new Set();
    for (const {wire} of target.wires(['rule', 'default'])) {
      const shape = ruleShape(wire);
      if (shape.head && (predicate ? shape.head.p === predicate : shape.body.some(a => used.has(a.p)))) heads.add(shape.head.p);
    }
    if (predicate && !lexicon.predicates[predicate]) throw fail(`No predicate ${JSON.stringify(predicate)}`, 'unknown_predicate', 404);
    const theory = this.targets.theory(target);
    const derived = [], asked = [];
    target.read((repo, session) => {
      for (const p of heads) {
        const roles = roleList(lexicon.predicates[p] ?? {roles: []});
        if (!roles.length || roles.length > 4) continue;
        for (let i = 0; i < roles.length && asked.length < maxQueries; i++) {
          if (VALUE_TYPES.has(roles[i].type)) continue;
          const vars = roles.map((_, j) => (j === i ? entity : `?v${j}`));
          const query = `@q query\n  where ${p} ${vars.join(' ')}\n  select ${vars.filter(v => v.startsWith('?')).join(' ')}\n`;
          let answer;
          try { answer = askMemory({theory, repo, session, query}); } catch (error) { asked.push({predicate: p, position: i, error: String(error.message).slice(0, 200)}); continue; }
          asked.push({predicate: p, position: i, status: answer.status, rows: answer.rows?.length ?? 0, route: answer.route?.chosen ?? null});
          for (const row of answer.rows ?? []) {
            const atom = {p, a: vars.map(v => (v.startsWith('?') ? row[v.slice(1)] : v)), neg: false};
            const text = `${p} ${atom.a.map(term).join(' ')}`;
            if (!stored.has(text) && !derived.some(d => d.atom === text)) derived.push({atom: text, p, args: atom.a, sentence: sayAtom(lexicon, atom)});
          }
        }
      }
      for (const d of derived.slice(0, maxProofs)) {
        try {
          const answer = askMemory({theory, repo, session, query: `@q query\n  mode explain\n  where ${d.atom}\n`});
          d.status = answer.status;
          d.proof = (answer.proof?.nodes ?? []).map(n => {
            const t = wireTokens(n.atom);
            const atom = {p: t[0], a: t.slice(1).map(x => (x.startsWith('"') ? JSON.parse(x) : /^-?\d+$/.test(x) ? Number(x) : x)), neg: false};
            return {id: n.id, atom: n.atom, sentence: sayAtom(lexicon, atom), kind: n.kind, source: n.source?.id ?? null, premises: n.premises ?? [], ...(n.kind === 'fact' ? {layer: target.layerOfFact(atom)} : {})};
          });
          d.roots = answer.proof?.roots ?? [];
        } catch (error) { d.proof_error = String(error.message).slice(0, 200); }
      }
    });
    return {kind: 'derive', target: {kind: target.kind, id: target.id}, entity, label: labelOf(lexicon, entity), heads: [...heads], asked, derived, explained: Math.min(maxProofs, derived.length),
      note: 'Derived facts are what the oracle concludes from the stored facts and the rules; they are not stored. Queries are bounded.'};
  }
}

function safeSeed(id) { try { return seedInfo(id); } catch { return null; } }
