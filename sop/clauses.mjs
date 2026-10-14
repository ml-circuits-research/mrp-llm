/**
 * Clauses, links, wire references and unparsed spans of the model language (DS014 "Clauses and links" and
 * "Honest partial formalization"; owner decisions L1–L4 of 2026-09-29).
 *
 * One finite clause of the message is one short wire. A subordinate or result clause is related to its main
 * clause by a keyword line `because $s2` (sop/enums.mjs LINK_KEYWORDS); a role value may be `$id`: the proposition
 * of a stated/assumed wire used as an argument, or the answers of an earlier query (`$q`, query chaining). A span
 * the model could not formalize is an `unparsed` wire; a role whose value lies in that span holds a placeholder
 * `?variable`, paired with the span by `near` and `hint`.
 *
 * This module admits those constructs (program-level checks with stable error codes) and plans what the host
 * does with them: a condition scopes the suppositions of the query that names it, a timed before/after/when link
 * bounds the query period, `$q` becomes a join, and every other link is recorded and reported `not_checked`.
 * Nothing here links strings to knowledge or executes anything.
 */
import {one, many, words, unquote, linksOf, linkTarget, roleReferences, parseProposition, propositionPairs, parseMatch, isMatch} from './parser.mjs';
import {parseCondition} from './conditions.mjs';
import {LINK_KEYWORDS, GENERIC_HINTS} from './enums.mjs';
import {normalizeTime, linkValidity} from './linking.mjs';
import {assert} from '../lib/util.mjs';

const PROPOSITION = new Set(['stated', 'assumed']);
const ROLE_HINTS = new Set(['subject', 'object', 'time', 'location']);
const isVariable = value => typeof value === 'string' && /^\?[A-Za-z][A-Za-z0-9_]*$/.test(value);

/** Placeholder ?variables of a stated/assumed wire: [{role, variable}]. */
function placeholdersOf(w) {
  if (!PROPOSITION.has(w.type)) return [];
  return parseProposition(propositionPairs(w), {where: '@' + w.id + ' ' + w.type}).roles.filter(r => isVariable(r.value)).map(r => ({role: r.name, variable: r.value}));
}
/** Non-selected ?variables of a query's match blocks, by role: [{role, variable}]. */
function queryVariables(w) {
  const selected = new Set(words(one(w, 'select', '')));
  const out = [];
  const partial = w.fields.fragment !== undefined;
  for (const text of [...many(w, 'where'), ...many(w, 'scope')]) parseCondition(text, leaf => {
    if (isMatch(leaf)) for (const r of parseMatch(leaf, 'match', {partial}).roles) if (isVariable(r.value) && !selected.has(r.value) && !out.some(o => o.variable === r.value)) out.push({role: r.name, variable: r.value});
    return leaf;
  });
  return out;
}
export const nearOf = w => (w.fields.near ? linkTarget(one(w, 'near'), '@' + w.id + ' near') : null);

/**
 * Pair each placeholder with its `unparsed` span: the unparsed wire whose `near` names the placeholder's wire and
 * whose `hint` is the placeholder's role, or else the one generic-hint (`value`, `reference`, `other`, none) span
 * near that wire. In a query, only a non-selected variable in the role named by a role hint is paired (optional).
 * Returns {byUnparsed: Map(unparsedId → {wire, role, variable}), byWire: Map(wireId → [{role, variable, unparsed}])}.
 */
export function pairPlaceholders(program, {strict = true} = {}) {
  const byUnparsed = new Map(), byWire = new Map();
  const spans = program.wires.filter(w => w.type === 'unparsed');
  const near = new Map(spans.map(u => [u.id, nearOf(u)]));
  const free = (wireId, test) => spans.filter(u => near.get(u.id) === wireId && !byUnparsed.has(u.id) && test(one(u, 'hint', null)));
  const pair = (w, role, variable, u) => {
    byUnparsed.set(u.id, {wire: w.id, role, variable});
    if (!byWire.has(w.id)) byWire.set(w.id, []);
    byWire.get(w.id).push({role, variable, unparsed: u.id});
  };
  for (const w of program.wires) {
    for (const {role, variable} of placeholdersOf(w)) {
      const exact = free(w.id, hint => hint === role);
      const generic = exact.length ? [] : free(w.id, hint => hint === null || GENERIC_HINTS.includes(hint));
      const chosen = exact.length === 1 ? exact[0] : generic.length === 1 ? generic[0] : null;
      if (!chosen) {
        if (strict) throw Error('proposition_not_ground: @' + w.id + ' role ' + role + ' ' + variable + ' is a placeholder without exactly one unparsed wire near $' + w.id + ' (hint ' + role + ' or value/reference/other); a statement states what the message says, and unknowns belong in a query');
        continue;
      }
      pair(w, role, variable, chosen);
    }
    if (w.type === 'query') for (const {role, variable} of queryVariables(w)) {
      if (!ROLE_HINTS.has(role)) continue;
      const exact = free(w.id, hint => hint === role);
      if (exact.length === 1) pair(w, role, variable, exact[0]);
    }
  }
  return {byUnparsed, byWire};
}

/**
 * Program-level admission of links, `$id` role references and unparsed spans. Throws with a stable code:
 * link_reference_unknown, link_self_reference, link_target_type, link_condition_not_supposed, link_conflict,
 * link_cycle, reference_unknown, reference_self, reference_target_type, reference_query_not_single,
 * unparsed_near_unknown, unparsed_near_type, unparsed_duplicate, proposition_not_ground (an unpaired placeholder).
 * `definitions` (id -> type of the output's session definitions): `if $r` on a query may name a session rule or default (Q-LANG-10),
 * which is then in force only in that query's runs.
 */
export function checkModelLinks(program, {definitions = new Map()} = {}) {
  const byId = new Map(program.wires.map(w => [w.id, w]));
  const edges = new Map();
  const conditionKind = new Map();
  for (const w of program.wires) {
    const targets = [];
    if (w.type === 'unparsed') {
      const target = nearOf(w);
      if (target !== null) {
        assert(target !== w.id, 'unparsed_near_type: @' + w.id + ' near names itself');
        assert(byId.has(target), 'unparsed_near_unknown: @' + w.id + ' near $' + target + ' names no wire of this output');
        assert(!['unparsed', 'unclear'].includes(byId.get(target).type), 'unparsed_near_type: @' + w.id + ' near names a ' + byId.get(target).type + ' wire; name the stated, assumed, query or constraint wire the span belongs to');
      }
      continue;
    }
    if (w.type === 'pragmatic') {
      // An advisory signal may name the wire its span belongs to; it is never a link target or an argument.
      const target = nearOf(w);
      if (target !== null) assert(target !== w.id && byId.has(target) && byId.get(target).type !== 'pragmatic', 'pragmatic_near_unknown: @' + w.id + ' near $' + target + ' must name another, non-pragmatic wire of this output');
      continue;
    }
    for (const {keyword, target} of linksOf(w)) {
      assert(target !== w.id, 'link_self_reference: @' + w.id + ' ' + keyword + ' $' + target + ' names its own wire');
      const t = byId.get(target);
      if (!t && ['rule', 'default'].includes(definitions.get(target))) {
        assert(w.type === 'query' && keyword === 'if', 'link_target_type: @' + w.id + ' ' + keyword + ' $' + target + ' names a session ' + definitions.get(target) + '; only `if` on a query may suppose a rule');
        continue;
      }
      assert(t, 'link_reference_unknown: @' + w.id + ' ' + keyword + ' $' + target + ' names no wire of this output');
      assert(PROPOSITION.has(t.type), 'link_target_type: @' + w.id + ' ' + keyword + ' $' + target + ' must name a stated or assumed wire (the clause), not a ' + t.type);
      if (LINK_KEYWORDS[keyword].target === 'supposed') assert(t.type === 'stated' && one(t, 'certainty') === 'supposed', 'link_condition_not_supposed: @' + w.id + ' ' + keyword + ' $' + target + ' names a clause that is not asserted to hold; write it as stated with certainty supposed');
      if (keyword === 'if' || keyword === 'unless') {
        const previous = conditionKind.get(target);
        assert(!previous || previous === keyword, 'link_conflict: $' + target + ' is used both with if and with unless');
        conditionKind.set(target, keyword);
      }
      targets.push(target);
    }
    for (const {role, target} of roleReferences(w)) {
      assert(target !== w.id, 'reference_self: @' + w.id + ' role ' + role + ' $' + target + ' names its own wire');
      const t = byId.get(target);
      assert(t, 'reference_unknown: @' + w.id + ' role ' + role + ' $' + target + ' names no wire of this output');
      if (w.type === 'query') assert(PROPOSITION.has(t.type) || t.type === 'query', 'reference_target_type: @' + w.id + ' role ' + role + ' $' + target + ' names a ' + t.type + '; a query takes the proposition of a stated/assumed wire or the answers of another query');
      else assert(PROPOSITION.has(t.type), 'reference_target_type: @' + w.id + ' role ' + role + ' $' + target + ' names a ' + t.type + '; a statement takes the proposition of a stated or assumed wire (the answers of a query belong in a query)');
      if (t.type === 'query') assert(words(one(t, 'select', '')).length === 1 && one(t, 'mode', 'select') === 'select' && !t.fields.scope, 'reference_query_not_single: $' + target + ' must be a query that selects exactly one ?variable (mode select)');
      targets.push(target);
    }
    if (w.type === 'constraint') for (const text of [...many(w, 'require'), ...many(w, 'claim'), ...many(w, 'objective')]) for (const m of unquotedText(text).matchAll(/\$([A-Za-z][A-Za-z0-9_]*)/g)) {
      const t = byId.get(m[1]);
      if (!t) continue; // a projected scalar of a query's select (DS004), checked by the compiler
      assert(t.type === 'query' && words(one(t, 'select', '')).length === 1, 'reference_query_not_single: @' + w.id + ' $' + m[1] + ' must name a query that selects exactly one ?variable');
      targets.push(m[1]);
    }
    edges.set(w.id, targets);
  }
  // Links and references form no cycle (a clause cannot explain itself through others).
  const state = new Map();
  const visit = (id, path) => {
    if (state.get(id) === 'done') return;
    assert(state.get(id) !== 'open', 'link_cycle: links or references form a cycle through ' + [...path, id].map(x => '@' + x).join(' → '));
    state.set(id, 'open');
    for (const next of edges.get(id) ?? []) visit(next, [...path, id]);
    state.set(id, 'done');
  };
  for (const id of edges.keys()) visit(id, []);
  const spans = program.wires.filter(w => w.type === 'unparsed').map(w => unquote(one(w, 'span')).trim().toLowerCase());
  assert(new Set(spans).size === spans.length, 'unparsed_duplicate: two unparsed wires carry the same span');
  pairPlaceholders(program);
  return program;
}
const unquotedText = text => String(text).replace(/"(?:\\.|[^"\\])*"/g, '""');

/** Period of a clause from its quoted `role time` or its `valid` lines; null when it has none the host can read. */
export function clausePeriod(w, now) {
  if (!PROPOSITION.has(w.type)) return null;
  const p = parseProposition(propositionPairs(w), {where: '@' + w.id});
  const time = p.roles.find(r => r.name === 'time' && typeof r.value === 'string' && !isVariable(r.value));
  if (time) return normalizeTime(time.value, now);
  if (Object.keys(p.valid).length) {
    const v = linkValidity(p.valid, now);
    return v.issues.length ? null : v.interval;
  }
  return null;
}

/**
 * The host plan of every link (owner decision L4): `if`/`unless` on a query scope the named supposition to that
 * query (applied); `before`/`after`/`when`/`while` on a query whose target clause has a readable time bound the
 * query period to until/from/during that time (applied); every other link — cause, concession, purpose, links on
 * statements, untimed temporal links — is recorded with status `not_checked` and the atomic propositions still
 * execute. Returns {links, conditions: Map(queryId → [targetId]), scoped: Set(targetId), negated: Set(targetId),
 * periods: Map(queryId → {from, until})}.
 */
export function planLinks(wires, {now = Date.now()} = {}) {
  const byId = new Map(wires.map(w => [w.id, w]));
  const links = [], conditions = new Map(), scoped = new Set(), negated = new Set(), periods = new Map();
  for (const w of wires) for (const {keyword, target} of linksOf(w)) {
    const {type} = LINK_KEYWORDS[keyword];
    const entry = {from: w.id, keyword, type, to: target, status: 'not_checked'};
    const t = byId.get(target);
    if (w.type === 'query' && (type === 'condition' || type === 'negative_condition')) {
      if (!conditions.has(w.id)) conditions.set(w.id, []);
      conditions.get(w.id).push(target);
      scoped.add(target);
      if (type === 'negative_condition') negated.add(target);
      Object.assign(entry, {status: 'applied', effect: type === 'condition' ? 'condition_scoped' : 'negated_condition_scoped'});
    } else if (w.type === 'query' && ['before', 'after', 'during'].includes(type)) {
      const period = t ? clausePeriod(t, now) : null;
      if (!period) entry.reason = 'untimed';
      else if (w.fields.at || w.fields.during) entry.reason = 'query_has_time';
      else {
        const bound = type === 'before' ? {from: -Infinity, until: period.from} : type === 'after' ? {from: period.from, until: Infinity} : {from: period.from, until: period.until};
        const previous = periods.get(w.id) ?? {from: -Infinity, until: Infinity};
        const merged = {from: Math.max(previous.from, bound.from), until: Math.min(previous.until, bound.until)};
        if (!(merged.from < merged.until)) entry.reason = 'empty_period';
        else { periods.set(w.id, merged); Object.assign(entry, {status: 'applied', effect: type === 'before' ? 'until' : type === 'after' ? 'from' : 'during'}); }
      }
    } else entry.reason = w.type === 'query' ? 'no_engine' : 'statement_link';
    links.push(entry);
  }
  return {links, conditions, scoped, negated, periods};
}

const renameVariables = (text, map) => String(text).replace(/"(?:\\.|[^"\\])*"|\?[A-Za-z][A-Za-z0-9_]*/g, token => (token.startsWith('?') && map.has(token) ? map.get(token) : token));
const variablesIn = text => new Set(unquotedText(text).match(/\?[A-Za-z][A-Za-z0-9_]*/g) ?? []);

/**
 * Query chaining (owner decision L3): a query match role `$q` naming another query is its answers. The host inlines
 * q's `where` conditions, renamed apart, into the referencing query and puts a fresh variable in place of `$q` (a
 * join); a constraint's `$q` becomes q's selected scalar (`$<selected variable>`, DS004 projected output). A `$s`
 * role value naming a stated/assumed wire is a proposition used as an argument: no engine decides it, so such a
 * query is not computable and such a statement is reported only. Returns {wires, joins, eventQueries, eventStatements}.
 */
export function expandReferences(wires) {
  const byId = new Map(wires.map(w => [w.id, w]));
  const joins = [], eventQueries = new Set(), eventStatements = new Set();
  const used = new Set(wires.flatMap(w => [...variablesIn(Object.values(w.fields).flat().join('\n'))]));
  let serial = 0;
  const fresh = base => { let name; do { name = '?' + base + '_' + serial++; } while (used.has(name)); used.add(name); return name; };
  const out = wires.map(w => {
    if (PROPOSITION.has(w.type)) { if (roleReferences(w).length) eventStatements.add(w.id); return w; }
    if (w.type === 'constraint') {
      const fields = Object.fromEntries(Object.entries(w.fields).map(([key, values]) => [key, values.map(text => String(text).replace(/"(?:\\.|[^"\\])*"|\$([A-Za-z][A-Za-z0-9_]*)/g, (token, name) => {
        const q = name && byId.get(name);
        if (!q || q.type !== 'query') return token;
        joins.push({from: w.id, to: name, kind: 'scalar'});
        return '$' + words(one(q, 'select', ''))[0].slice(1);
      }))]));
      return {...w, fields};
    }
    if (w.type !== 'query') return w;
    const refs = roleReferences(w);
    if (!refs.length) return w;
    const [{target}] = refs;
    const q = byId.get(target);
    if (!q || q.type !== 'query') { eventQueries.add(w.id); return w; }
    const selected = words(one(q, 'select', ''))[0];
    const variable = fresh(target);
    const map = new Map([...variablesIn(many(q, 'where').join('\n'))].map(v => [v, v === selected ? variable : fresh(v.slice(1))]));
    const where = many(w, 'where').map(text => String(text).replace(new RegExp('(^|\\s)\\$' + target + '(?=\\s|$)', 'gm'), '$1' + variable));
    const fields = {...w.fields, where: [...where, ...many(q, 'where').map(text => renameVariables(text, map))]};
    joins.push({from: w.id, to: target, kind: 'join', variable});
    return {...w, fields};
  });
  return {wires: out, joins, eventQueries, eventStatements};
}

/** One-line rendering of a wire with its `$id` values shown as "[…]" of the referenced reading (for understood_as). */
export function readingWithReferences(w, byId) {
  const line = wire => Object.entries(wire.fields).flatMap(([k, vs]) => vs.map(v => k + ' ' + String(v).split('\n').map(s => s.trim()).join(' '))).join('; ');
  return line(w).replace(/\$([A-Za-z][A-Za-z0-9_]*)/g, (token, name) => (byId.has(name) ? '[' + (unquote(one(byId.get(name), 'relation', '""')) ?? name) + ']' : token));
}
