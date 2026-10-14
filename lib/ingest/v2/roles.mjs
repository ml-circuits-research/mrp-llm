/**
 * The model roles of ingestion v2, each one prompt template (model-facing data), one deterministic check of the reply and at most one
 * re-ask with the problems named:
 *   structure   config/ingest/structure-doc-v1.md: the vocabulary of one passage (entities with every mention, relations as predicates,
 *               values, the certainty of hedged, reported and supposed sentences); mentions and values must be copied from the passage
 *   merge       config/ingest/vocabulary-merge-v1.md: one call for all the conflicts of a document's vocabulary (same name with different
 *               kinds, a short name inside a longer one, paraphrased predicates): which names mean the same thing, and the canonical name
 *   fol         config/prompts/fol-v2.md (the FOL role of the formalizer, unchanged) with the document's canonical vocabulary as its
 *               inventory (config/ingest/fol-inventory-v1.md): one FOL formula list per sentence of a passage
 * `chat` is the client of ./client.mjs. Every function returns {ok, value, problems, calls, raw}; nothing throws on a model failure.
 */
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
// The template reader and the FOL reply check of Ploinky's prompted roles (the same contract as /v1/fol).
import {parseTemplate, fill, validateFol, mergeFol} from 'pworker/prompted';
import {jsonOf} from './client.mjs';
import {parseFol} from '../../formalize/fol/parse.mjs';
import {slug} from '../../formalize/fol/to-sop.mjs';

const here = file => fileURLToPath(new URL(file, import.meta.url));
export const TEMPLATES = Object.freeze({
  structure: here('../../../config/ingest/structure-doc-v1.md'),
  merge: here('../../../config/ingest/vocabulary-merge-v1.md'),
  align: here('../../../config/ingest/align-v1.md'),
  fol: here('../../../config/prompts/fol-v2.md'),
  inventory: here('../../../config/ingest/fol-inventory-v1.md'),
});
const cache = new Map();
export function template(name) {
  if (!cache.has(name)) {
    const text = fs.readFileSync(TEMPLATES[name], 'utf8');
    cache.set(name, name === 'inventory' ? {inventory: text.split(/^<<<inventory>>>\s*$/m)[1].trim()} : parseTemplate(text));
  }
  return cache.get(name);
}

const fold = s => String(s ?? '').normalize('NFKC').replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/[–—−]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();
export const numbered = units => units.map((u, i) => `s${i + 1}: ${u.text}`).join('\n');

/** One role call with the template's options, its check, and one re-ask with the problems when the check finds any. */
async function ask({chat, tier, tpl, vars, check, maxTokens = null, extraBody = {}, merge = (a, b) => (b.problems.length <= a.problems.length ? b : a)}) {
  const opt = {...(tpl.options ?? {}), ...(maxTokens ? {maxTokens} : {})};
  const messages = [...(tpl.system ? [{role: 'system', content: fill(tpl.system, vars)}] : []), {role: 'user', content: fill(tpl.user, vars)}];
  let first = await chat({tier, messages, maxTokens: opt.maxTokens ?? 4000, temperature: opt.temperature ?? 0, extraBody});
  // A reasoning reply that spent its whole budget thinking (finish "length", no content) is asked once more with low reasoning.
  if (first.ok && !first.text && first.finish === 'length' && extraBody.reasoning_effort && extraBody.reasoning_effort !== 'low') first = await chat({tier, messages, maxTokens: opt.maxTokens ?? 4000, temperature: opt.temperature ?? 0, extraBody: {...extraBody, reasoning_effort: 'low'}});
  if (!first.ok) return {ok: false, problems: [first.reason], calls: 1, raw: []};
  let v = check(first.text);
  const raw = [first.text];
  let calls = 1;
  if (v.problems.length && tpl.again) {
    const again = await chat({tier, messages: [...messages, {role: 'assistant', content: first.text}, {role: 'user', content: fill(tpl.again, {...vars, problems: v.problems.slice(0, 10).map(p => `- ${p}`).join('\n')})}],
      maxTokens: opt.maxTokens ?? 4000, temperature: opt.temperature ?? 0, extraBody});
    calls++;
    if (again.ok) { raw.push(again.text); v = merge(v, check(again.text)); }
  }
  return {ok: !v.unreadable, value: v, problems: v.problems, calls, raw};
}

// ---------------------------------------------------------------- structure

/** Checks a structure reply against the passage: mentions and values must occur in it; sentence numbers in range. */
export function checkStructure(text, units) {
  const json = jsonOf(text);
  if (!json || !Array.isArray(json.entities) || !Array.isArray(json.relations)) return {unreadable: true, problems: ['the reply is not a JSON object with "entities" and "relations" lists'], entities: [], relations: [], values: [], certainty: []};
  const passage = fold(units.map(u => u.text).join('\n'));
  const n = units.length, problems = [];
  const inRange = xs => (Array.isArray(xs) ? xs : []).map(Number).filter(k => Number.isInteger(k) && k >= 1 && k <= n);
  const entities = [];
  for (const e of json.entities) {
    const name = String(e?.name ?? '').trim();
    if (!name) { problems.push('an entity has no name'); continue; }
    const mentions = [...new Set([name, ...(Array.isArray(e.mentions) ? e.mentions : [])].map(m => String(m ?? '').trim()).filter(Boolean))];
    const found = mentions.filter(m => passage.includes(fold(m)));
    const missing = mentions.filter(m => !found.includes(m) && m !== name);
    if (missing.length) problems.push(`entity "${name}": the mentions ${missing.slice(0, 3).map(m => JSON.stringify(m)).join(', ')} are not copied exactly from the sentences`);
    if (!found.length) { problems.push(`entity "${name}" is not mentioned in the sentences`); continue; }
    entities.push({name, kind: String(e.kind ?? '').trim().toLowerCase() || 'thing', mentions: found, s: inRange(e.s)});
  }
  const relations = [];
  for (const r of json.relations) {
    const name = String(r?.name ?? '').trim();
    const args = Array.isArray(r?.args) ? r.args.map(a => String(a ?? '').trim().toLowerCase() || 'thing') : [];
    if (!/^[a-z][a-z0-9_]*$/.test(name)) { problems.push(`relation "${name}" is not a snake_case name of words`); continue; }
    if (!args.length || args.length > 6) { problems.push(`relation ${name} needs 1 to 6 argument kinds`); continue; }
    relations.push({name, args, reading: String(r.reading ?? '').trim(), s: inRange(r.s), ...(typeof r.one_value === 'boolean' ? {one_value: r.one_value} : {})});
  }
  const values = [];
  for (const v of Array.isArray(json.values) ? json.values : []) {
    const t = String(v?.text ?? '').trim();
    if (!t) continue;
    if (!passage.includes(fold(t))) { problems.push(`value ${JSON.stringify(t)} is not copied exactly from the sentences`); continue; }
    values.push({text: t, type: String(v.type ?? '').toLowerCase(), unit: String(v.unit ?? '')});
  }
  const certainty = (Array.isArray(json.certainty) ? json.certainty : []).map(c => ({s: Number(c?.s), status: String(c?.status ?? '')}))
    .filter(c => Number.isInteger(c.s) && c.s >= 1 && c.s <= n && ['hedged', 'reported', 'supposed'].includes(c.status));
  return {problems, entities, relations, values, certainty};
}

export async function structurePass({chat, tier = 'small', title, section, units, known = '(none)', extraBody = {}}) {
  const r = await ask({chat, tier, tpl: template('structure'), extraBody, vars: {title, section, sentences: numbered(units), known}, check: text => checkStructure(text, units),
    // The better reply is the one with fewer problems; entities and relations only the other reply has are added.
    merge: (a, b) => {
      if (a.unreadable) return b;
      if (b.unreadable) return a;
      const base = b.problems.length <= a.problems.length ? b : a, other = base === a ? b : a;
      const names = new Set(base.entities.map(e => fold(e.name))), rels = new Set(base.relations.map(x => x.name));
      return {...base, entities: [...base.entities, ...other.entities.filter(e => !names.has(fold(e.name)))], relations: [...base.relations, ...other.relations.filter(x => !rels.has(x.name))]};
    }});
  return r;
}

// ---------------------------------------------------------------- merge

/** Checks a merge reply: every case answered, every name in exactly one group. `cases`: [{case, names: [..]}]. */
export function checkMerge(text, cases) {
  const json = jsonOf(text);
  if (!json || !Array.isArray(json.cases)) return {unreadable: true, problems: ['the reply is not a JSON object with a "cases" list'], decisions: new Map()};
  const problems = [], decisions = new Map();
  for (const c of cases) {
    const got = json.cases.find(x => Number(x?.case) === c.case);
    if (!got || !Array.isArray(got.groups)) { problems.push(`case ${c.case} has no groups`); continue; }
    const seen = new Map();
    const groups = [];
    for (const g of got.groups) {
      const members = (Array.isArray(g?.members) ? g.members : []).map(m => String(m ?? '').trim()).filter(m => c.names.includes(m));
      if (!members.length) continue;
      for (const m of members) seen.set(m, (seen.get(m) ?? 0) + 1);
      groups.push({canonical: String(g.canonical ?? '').trim() || members[0], members});
    }
    const missing = c.names.filter(m => !seen.has(m)), twice = [...seen].filter(([, k]) => k > 1).map(([m]) => m);
    if (missing.length || twice.length) { problems.push(`case ${c.case}: ${missing.length ? `${missing.map(m => JSON.stringify(m)).join(', ')} not in any group` : ''}${twice.length ? ` ${twice.map(m => JSON.stringify(m)).join(', ')} in two groups` : ''}`.trim()); continue; }
    decisions.set(c.case, groups);
  }
  return {problems, decisions};
}

export async function mergePass({chat, tier = 'medium', title, cases, extraBody = {}}) {
  if (!cases.length) return {ok: true, value: {problems: [], decisions: new Map()}, problems: [], calls: 0, raw: []};
  const text = cases.map(c => `Case ${c.case} (${c.type}):\n${c.lines.join('\n')}`).join('\n\n');
  return ask({chat, tier, tpl: template('merge'), extraBody, vars: {title, cases: text}, check: reply => checkMerge(reply, cases),
    merge: (a, b) => (a.unreadable ? b : b.unreadable ? a : {problems: b.problems, decisions: new Map([...a.decisions, ...b.decisions])})});
}

// ---------------------------------------------------------------- fol

/** The FOL of a passage's units: {perInput: [[line]], problems}. `inventory` is the rendered canonical vocabulary. */
export async function folPass({chat, tier = 'small', units, inventory, maxTokens = 6000, extraBody = {}}) {
  const body = {inputs: units.map(u => u.text)};
  const tpl = template('fol');
  return ask({chat, tier, tpl, maxTokens, extraBody, vars: {sentences: numbered(units), inventory, sentence: ''}, check: text => validateFol(text, body), merge: (a, b) => mergeFol(a, b, body)});
}

/** A repair of some units of a passage: the converter's reasons are given and the formulas of those sentences written again. */
export async function folRepair({chat, tier = 'small', units, inventory, previous, reasons, maxTokens = 6000, extraBody = {}}) {
  const body = {inputs: units.map(u => u.text)};
  const tpl = template('fol');
  const messages = [...(tpl.system ? [{role: 'system', content: tpl.system}] : []), {role: 'user', content: fill(tpl.user, {sentences: numbered(units), inventory, sentence: ''})},
    {role: 'assistant', content: previous}, {role: 'user', content: fill(tpl.again, {problems: reasons.slice(0, 40).map(p => `- ${p}`).join('\n')})}];
  let r = await chat({tier, messages, maxTokens, temperature: 0, extraBody});
  let calls = 1;
  // A reasoning reply that spent its whole budget thinking (finish "length", no content) is asked once more with low reasoning.
  if (r.ok && !r.text && r.finish === 'length' && extraBody.reasoning_effort && extraBody.reasoning_effort !== 'low') { r = await chat({tier, messages, maxTokens, temperature: 0, extraBody: {...extraBody, reasoning_effort: 'low'}}); calls++; }
  if (!r.ok) return {ok: false, problems: [r.reason], calls, raw: []};
  const v = validateFol(r.text, body);
  return {ok: !v.unreadable, value: v, problems: r.text ? v.problems : [...v.problems, `empty reply (finish ${r.finish ?? 'unknown'})`], calls, raw: [r.text]};
}

// ---------------------------------------------------------------- align

/** The quote as written in the document (folded match), or null. */
export function findQuote(quote, documentText) {
  const q = fold(quote);
  if (!q) return null;
  const doc = String(documentText);
  const at = fold(doc).indexOf(q);
  return at < 0 ? null : quote;
}

/**
 * Checks an alignment reply: each definition parses, concludes one of the dangling conditions (by folded name), and quotes the
 * document. `dangling`: [{id, fol}].
 */
export function checkAlign(text, dangling, documentText) {
  const json = jsonOf(text);
  if (!json || !Array.isArray(json.definitions)) return {unreadable: true, problems: ['the reply is not a JSON object with a "definitions" list'], definitions: []};
  const problems = [], definitions = [];
  const ids = new Set(dangling.map(d => d.id));
  for (const d of json.definitions) {
    const fol = String(d?.fol ?? '').trim(), quote = String(d?.quote ?? '').trim(), condition = slug(d?.condition ?? '');
    if (!ids.has(condition)) { problems.push(`"${d?.condition}" is not one of the listed conditions`); continue; }
    const parsed = parseFol(fol);
    if (!parsed.ok) { problems.push(`${d.condition}: the rule does not parse (${parsed.why})`); continue; }
    // A definition must conclude the condition from other relations (a rule that only restates the condition defines nothing).
    const preds = new Set([...fol.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map(m => slug(m[1])).filter(x => !/^(forall|exists|not)/.test(x) && !['and', 'or', 'implies', 'iff', 'xor'].includes(x)));
    if (![...preds].some(x => x !== condition)) { problems.push(`${d.condition}: the rule uses no relation other than the condition itself; leave it out if the document does not define it`); continue; }
    if (!findQuote(quote, documentText)) { problems.push(`${d.condition}: the quote ${JSON.stringify(quote.slice(0, 80))} is not copied exactly from the document`); continue; }
    definitions.push({condition, fol, quote});
  }
  return {problems, definitions};
}

export async function alignPass({chat, tier = 'medium', title, dangling, grounded, documentText, extraBody = {}}) {
  if (!dangling.length) return {ok: true, value: {problems: [], definitions: []}, problems: [], calls: 0, raw: []};
  const lines = dangling.map(d => `- ${d.fol}: used in ${d.rule}; sentence: ${JSON.stringify(d.sentence.slice(0, 200))}`).join('\n');
  return ask({chat, tier, tpl: template('align'), extraBody, vars: {title, dangling: lines, grounded: grounded.join('\n') || '(none)'}, check: reply => checkAlign(reply, dangling, documentText),
    merge: (a, b) => (a.unreadable ? b : b.unreadable ? a : {problems: b.problems, definitions: [...b.definitions, ...a.definitions.filter(x => !b.definitions.some(y => y.condition === x.condition))]})});
}
