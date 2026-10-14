/**
 * Risk-sorted views of a layer (DS022 "Knowledge browser"). The browser is read only: there is no accept or reject step (AGENTS.md
 * direction 8, owner decision of 2026-10-02: errors are corrected systematically through tests and interactions). A FLAG marks a likely
 * problem worth a look, and a view lists the items with the most risk first.
 *
 * Items: one per vocabulary or theory wire (predicate, lexeme, rule, default, aggregate, integrity, procedure, method, norm, ...), one
 * per class entity, one per group of facts of a predicate and one per group of plain entities of a class (world-v1 holds 357k facts and
 * 55k entities: a view never lists them one by one).
 *
 * Flags (code: weight; the risk of an item is the highest weight of each of its codes plus 2 for every repeated flag):
 *   no_description 30   a predicate without a description (its meaning is only its name)
 *   form_no_evidence 30 a lexeme form with no corpus count and no Wikidata label or alias of a property its source cites
 *   shared_form 30      a form other predicates also claim, with no `restrict` or `weight` to tell them apart (15 when they declare one)
 *   undeclared 30       facts of a predicate no layer declares
 *   rule 15             a rule or default: it derives new facts from existing ones
 *   converse_frame 15   a lexeme whose frame puts the object first ("employ" for works_at)
 *   flipped_mapping 15  a world-v1 property emitted with subject and value swapped
 *   merged_mapping 15   several Wikidata properties emitted under one predicate
 *   review_dropped 10   the cross-review or the lint dropped forms of this predicate (the kept forms deserve a look too)
 *   no_lexeme 10        a predicate no English form reaches (questions cannot link to it)
 *   partial_rule 5      a rule whose conditions include comparisons, negations or exceptions
 *   class 5             a class entity (the class hierarchy)
 *   curated_values 0    a world-v1 property restricted to a curated list of values
 */
import {phraseKey} from '../../sop/text-keys.mjs';
import {fileGroup} from './target.mjs';
import {ruleShape} from './examples.mjs';

export const FLAGS = Object.freeze({
  no_description: 30, form_no_evidence: 30, shared_form: 30, undeclared: 30, rule: 15, converse_frame: 15, flipped_mapping: 15, merged_mapping: 15,
  review_dropped: 10, no_lexeme: 10, partial_rule: 5, class: 5, curated_values: 0,
});
const RULE_TYPES = new Set(['rule', 'default', 'aggregate', 'integrity']);
const field = (w, key) => w.fields.find(f => f.key === key)?.value.trim();
const unquote = s => (s?.startsWith('"') ? JSON.parse(s) : s);
const flag = (code, message, weight = FLAGS[code]) => ({code, weight, message});
/** The risk of an item: the highest weight of each flag code, plus 2 for every further occurrence (a lexeme with many weak forms ranks above one with one). */
const risk = flags => {
  const best = new Map();
  for (const f of flags) best.set(f.code, Math.max(best.get(f.code) ?? 0, f.weight));
  return [...best.values()].reduce((a, b) => a + b, 0) + 2 * (flags.length - best.size);
};

/** Does a layer hold the mechanical Wikidata build of tools/world-kb (its mapping table applies)? */
export function isWorldKb(target, layerId) {
  if (/^world-/.test(layerId)) return true;
  return target.kind === 'memory' && layerId === target.id && target.provenance().some(r => /tools\/world-kb/.test(String(r.source ?? '')));
}

/** The flags and evidence of one lexeme form. */
export function formReport({lexicon, predicate, lexeme, form, evidence, source}) {
  const ev = evidence.form(form, {source});
  const flags = [];
  if (!ev.evidenced && evidence.available().mined) flags.push(flag('form_no_evidence', `"${form}" has no corpus count and is no Wikidata label or alias of ${ev.cites.join(', ') || 'a cited property'}`));
  // A form shared with a role-set variant (another frame length, e.g. sends / sends_without_recipient) is told apart by the roles of
  // the sentence; only predicates that claim the form with the same number of roles compete.
  const arity = lexeme.frame?.length || predicate.roles?.length || 0;
  const claimants = (lexicon.formsByKey.get(phraseKey(form)) ?? []).map(x => x.predicate).filter(p => p !== predicate.id);
  const others = [...new Set(claimants.filter(p => lexicon.predicates[p]?.lexemes.some(l => l.forms.some(f => phraseKey(f) === phraseKey(form)) && (l.frame?.length || lexicon.predicates[p].roles?.length || 0) === arity)))];
  const variants = [...new Set(claimants.filter(p => !others.includes(p)))];
  if (others.length) {
    const toldApart = lexeme.restrict?.length || lexeme.weight !== null || others.some(p => lexicon.predicates[p]?.lexemes.some(l => l.forms.some(f => phraseKey(f) === phraseKey(form)) && (l.restrict?.length || l.weight !== null)));
    flags.push(flag('shared_form', `"${form}" is also a form of ${others.join(', ')}${toldApart ? ' (a restrict or weight tells them apart)' : ''}`, toldApart ? 15 : FLAGS.shared_form));
  }
  return {form, flags, evidence: ev, shared_with: others, role_variants: variants};
}

/** The items of one layer of a target, with flags and evidence (no examples: see `withExamples`). */
export function layerItems(target, layerId, evidence) {
  const summary = target.summary().find(s => s.id === layerId);
  if (!summary) throw Object.assign(new Error(`Unknown layer ${JSON.stringify(layerId)}`), {code: 'unknown_layer', status: 404});
  const lexicon = target.lexicon;
  const world = isWorldKb(target, layerId);
  const factTotals = {};
  for (const s of target.summary()) for (const [p, n] of Object.entries(s.factsByPredicate)) factTotals[p] = (factTotals[p] ?? 0) + n;
  const items = [];
  for (const {w, file} of summary.wires) {
    const base = {key: `${w.type}:${w.id}`, type: w.type, id: w.id, layer: layerId, file, group: fileGroup(file)};
    if (w.type === 'predicate') {
      const p = lexicon.predicates[w.id] ?? {id: w.id, lexemes: [], roles: []};
      const flags = [];
      const description = unquote(field(w, 'description') ?? '') ?? '';
      if (!description) flags.push(flag('no_description', 'no description: the meaning is only the name'));
      if (!p.lexemes.some(l => l.language === 'en')) flags.push(flag('no_lexeme', 'no English form links a question to it'));
      const dropped = evidence.dropped?.get(w.id) ?? [];
      if (dropped.length) flags.push(flag('review_dropped', `${dropped.length} form(s) dropped by the build: ${dropped.slice(0, 3).map(d => `"${d.form}" (${d.why})`).join('; ')}`));
      const mapping = world ? evidence.mapping(w.id) : [];
      items.push({...base, summary: description, roles: p.roles, closed: p.closed, readings: p.readings, facts: factTotals[w.id] ?? 0, flags, evidence: {dropped, mapping}});
    } else if (w.type === 'lexeme') {
      const p = lexicon.predicates[field(w, 'of')];
      const lexeme = p?.lexemes.find(l => l.id === w.id);
      if (!p || !lexeme) { items.push({...base, summary: `lexeme of ${field(w, 'of')}`, flags: [flag('undeclared', `its predicate ${field(w, 'of')} is not declared`)], evidence: {}}); continue; }
      const source = `${unquote(field(w, 'source') ?? '') ?? ''} ${p.description ?? ''}`;
      const forms = lexeme.forms.map(form => formReport({lexicon, predicate: p, lexeme, form, evidence, source}));
      const flags = forms.flatMap(f => f.flags);
      if (lexeme.converse) flags.push(flag('converse_frame', `frame ${lexeme.frame.join(' ')}: the sentence names the ${lexeme.frame[0]} first`));
      if ((evidence.dropped?.get(p.id) ?? []).some(d => /^review/.test(d.why))) flags.push(flag('review_dropped', `the cross-review dropped other forms of ${p.id}`));
      items.push({...base, of: p.id, summary: `${lexeme.pos} of ${p.id}: ${lexeme.forms.map(f => `"${f}"`).join(', ')}`, pos: lexeme.pos, frame: lexeme.frame, forms, flags,
        evidence: {source: unquote(field(w, 'source') ?? '') ?? null}});
    } else if (RULE_TYPES.has(w.type)) {
      const shape = ruleShape(w);
      const flags = [flag('rule', `${w.type}: concludes ${shape.head?.p ?? '?'} from ${shape.body.map(a => a.p).join(', ') || 'conditions'}`)];
      if (shape.extra) flags.push(flag('partial_rule', `${shape.extra} condition(s) besides plain relations`));
      const source = unquote(field(w, 'source') ?? '') ?? '';
      if (/^generated/.test(source)) flags[0].weight = 5;
      items.push({...base, summary: `${shape.body.map(a => a.p).join(' + ') || '…'} → ${shape.head?.p ?? '?'}`, head: shape.head?.p ?? null, body: shape.body.map(a => a.p), flags, evidence: {source, quote: unquote(field(w, 'quote') ?? '') ?? null}});
    } else {
      items.push({...base, summary: unquote(field(w, 'description') ?? '') || w.type, flags: [], evidence: {source: unquote(field(w, 'source') ?? '') ?? null}});
    }
  }
  for (const c of summary.classes) {
    const e = lexicon.entities[c.id];
    items.push({key: `class:${c.id}`, type: 'class', id: c.id, layer: layerId, file: c.file, group: fileGroup(c.file), summary: `class "${e?.labels?.en ?? c.id}"${[...(lexicon.isA.get(c.id) ?? [])].length ? ` under ${[...lexicon.isA.get(c.id)].join(', ')}` : ''}`, flags: [flag('class', 'part of the class hierarchy')], evidence: {}});
  }
  for (const [p, count] of Object.entries(summary.factsByPredicate)) {
    const flags = [];
    if (!lexicon.predicates[p]) flags.push(flag('undeclared', `no layer declares ${p}`));
    const mapping = world ? evidence.mapping(p) : [];
    const pids = [...new Set(mapping.map(m => m.pid))];
    if (mapping.some(m => m.flip)) flags.push(flag('flipped_mapping', `emitted flipped (subject and value swapped): ${[...new Set(mapping.filter(m => m.flip).map(m => m.pid))].join(', ')}`));
    if (pids.length > 1) flags.push(flag('merged_mapping', `${pids.length} properties under one predicate: ${pids.join(', ')}`));
    if (mapping.some(m => m.curated)) flags.push(flag('curated_values', 'values restricted to a curated list'));
    items.push({key: `facts:${p}`, type: 'facts', id: p, layer: layerId, group: `facts of ${p}`, summary: `${count} fact(s) of ${p}`, count, flags, evidence: {mapping}});
  }
  for (const [kind, count] of Object.entries(summary.entitiesByKind)) {
    if (kind === 'class') continue;
    items.push({key: `entities:${kind}`, type: 'entities', id: kind, layer: layerId, group: `entities of ${kind}`, summary: `${count} entit${count === 1 ? 'y' : 'ies'} of class ${kind}`, count, flags: lexicon.classes[kind] || kind === 'entity' ? [] : [flag('undeclared', `class ${kind} is not declared`)], evidence: {}});
  }
  for (const item of items) item.risk = risk(item.flags);
  return items.sort((a, b) => b.risk - a.risk || a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
}

/** Filters and pages the items of a layer: `type`, `flag`, `group`, `q` (substring of id or summary). */
export function selectItems(items, {type = null, flag: code = null, group = null, q = null, offset = 0, limit = 50} = {}) {
  const needle = q ? String(q).toLowerCase() : null;
  const chosen = items.filter(i => (!type || i.type === type) && (!code || i.flags.some(f => f.code === code)) && (!group || i.group === group) && (!needle || i.id.toLowerCase().includes(needle) || String(i.summary).toLowerCase().includes(needle)));
  return {total: chosen.length, offset, limit, items: chosen.slice(offset, offset + limit)};
}

/** Per layer: counts per flag, per type and per group (the overview of a risk view). */
export function itemStats(items) {
  const flags = {}, types = {}, groups = {};
  for (const i of items) {
    types[i.type] = (types[i.type] ?? 0) + 1;
    groups[i.group] = (groups[i.group] ?? 0) + 1;
    for (const f of new Set(i.flags.map(x => x.code))) flags[f] = (flags[f] ?? 0) + 1;
  }
  return {items: items.length, flagged: items.filter(i => i.risk > 0).length, flags, types, groups};
}
