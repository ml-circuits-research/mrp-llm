/**
 * Context-free propositions of the model language (DS014). `stated`
 * and `assumed` wires, and query `match` blocks, carry strings as the model
 * understood them: a relation phrase, closed-inventory roles with values as
 * written in the message, polarity and optional temporal expressions. The host
 * links them to lexicon predicates and positional atoms (sop/linking.mjs);
 * nothing here executes, stores or trusts a proposition.
 */
import {one,parseProposition,propositionPairs,unquote} from './parser.mjs';
import {normalize,phraseKey} from './text-keys.mjs';
import {formatTime} from '../lib/time.mjs';
import {stable} from '../lib/util.mjs';
import {linkRelation,linkValidity} from './linking.mjs';
import {linkCopula} from './copula-linker.mjs';

export const PROPOSITION_TYPES = new Set(['stated', 'assumed']);
const fold = s => normalize(s).normalize('NFD').replace(/\p{M}/gu, '');

/** The authored proposition of a stated/assumed wire (strings, not yet linked). */
export function propositionOf(w) {
  const p = parseProposition(propositionPairs(w), {where: '@' + w.id + ' ' + w.type});
  return {
    id: w.id, type: w.type, ...p,
    ...(w.type === 'stated' ? {certainty: one(w, 'certainty'), speaker: w.fields.speaker && one(w, 'speaker') !== 'user' ? unquote(one(w, 'speaker')) : 'user'} : {}),
    ...(w.type === 'assumed' ? {basis: one(w, 'basis', 'unspecified')} : {}),
  };
}

/** A user supposition, a hedge or reported speech is used only conditionally. */
export const conditionalStatement = p => p.certainty !== 'asserted' || p.speaker !== 'user';

const termToken = value => typeof value === 'number' || /^\?/.test(value) ? String(value) : JSON.stringify(value);
/**
 * Link a proposition (stated, assumed or a query match) to a positional atom
 * text whose string values are still quoted for host entity resolution.
 * Returns {atomText, predicate, span?} or {issue} for a host clarification. Query
 * matches may leave declared roles unbound; `fresh()` names those variables.
 * `span` is a time variable bound to the matched fact's validity interval.
 */
export function linkProposition(p, lexicon, options = {}) {
  const shift = shiftBoundary(p, lexicon);
  const linked = linkPropositionCore(shift ? {...p, relation: shift.relation, roles: shift.roles} : p, lexicon, options);
  return shift && !linked.issue ? {...linked, boundary: {from: shift.from, to: shift.relation}} : linked;
}

/**
 * Relation/object boundary shift against the lexicon (the lexicon form of the frame level `boundary` of sop/frames.mjs): a relation phrase whose
 * object string begins with the words that finish a form of the memory ("be the head of" + "state of France": the form "be the head of state of" and the
 * entity "France") is moved across the boundary. It applies only when the whole object string names no entity, one shift is possible and the rest
 * names an entity, so it can only replace a clarification by a reading the memory itself declares.
 */
export function shiftBoundary(p, lexicon) {
  if (!lexicon?.predicatesFor || !lexicon.matching || p.relation === undefined) return null;
  const known = text => lexicon.matching(text, {language: 'auto', kind: 'entity'}).found.length > 0;
  for (const role of p.roles) {
    if (typeof role.value !== 'string' || /^[?$]/.test(role.value)) continue;
    const words = role.value.trim().split(/\s+/);
    if (words.length < 2 || known(role.value)) continue;
    const found = [];
    for (let k = 1; k < Math.min(words.length, 4); k++) {
      const relation = p.relation + ' ' + words.slice(0, k).join(' '), rest = words.slice(k).join(' ');
      if (lexicon.predicatesFor(phraseKey(relation)).length && known(rest)) found.push({relation, rest});
    }
    if (found.length !== 1) continue;
    return {from: p.relation, relation: found[0].relation, roles: p.roles.map(r => r === role ? {...r, value: found[0].rest} : r)};
  }
  return null;
}

function linkPropositionCore(p, lexicon, {exact = true, fresh = null, relations = undefined} = {}) {
  let roles = p.roles, span = null;
  const valuesOf = list => new Map(list.map(role => [role.name, role.value]));
  let link = linkRelation(p.relation, roles.map(role => role.name), lexicon, {exact, relations, values: valuesOf(roles), headVerb: !exact});
  // The copula ("be", "be in"): the readings the base memory declares, tried in order (sop/copula-linker.mjs).
  if (link.status !== 'bound') {
    const copula = linkCopula(p, lexicon, {exact, fresh: fresh ?? (() => '?host_any'), relations});
    if (copula) return copula.issue ? {issue: copula.issue} : {atomText: (p.polarity === 'negated' ? 'not ' : '') + copula.atomText, predicate: copula.predicate, reading: copula.reading,
      ...(copula.alternatives ? {alternatives: copula.alternatives.map(item => ({...item, atomText: (p.polarity === 'negated' ? 'not ' : '') + item.atomText}))} : {})};
  }
  // A query's `role time ?t` on a relation that declares no time role asks for the validity interval of
  // the matched fact (a "when" question): the role is dropped from the atom and ?t becomes the host span.
  const timeVariable = !exact && p.roles.find(role => role.name === 'time' && typeof role.value === 'string' && role.value.startsWith('?'));
  if (link.status !== 'bound' && timeVariable) {
    const without = p.roles.filter(role => role !== timeVariable);
    const retry = linkRelation(p.relation, without.map(role => role.name), lexicon, {exact, relations, values: valuesOf(without), headVerb: true});
    if (retry.status === 'bound') { link = retry; roles = without; span = timeVariable.value; }
  }
  // Single-oblique relabeling (DS014 "KnowledgeLinker: scoring and ambiguity"): the memory names the roles of its predicates ("died_in" takes a
  // `location`, "death_year" a `time`), the circuit author names them by the preposition it saw. When the phrase reaches predicates whose roles do not fit
  // only by ONE used role name that is not declared and ONE declared role that is not used (neither the subject), that role is renamed, and the
  // rename counts only when exactly one renaming links. It is reported as `relabeled`.
  let relabeled = null;
  if (link.status === 'role_mismatch') {
    const used = roles.map(role => role.name);
    const targets = new Map();
    for (const candidate of link.candidates ?? []) {
      const unknown = used.filter(name => !candidate.roles.includes(name)), free = candidate.roles.filter(name => !used.includes(name));
      if (unknown.length === 1 && free.length === 1 && unknown[0] !== 'subject' && free[0] !== 'subject') targets.set(unknown[0] + '\0' + free[0], {from: unknown[0], to: free[0]});
    }
    const bound = [...targets.values()].map(({from, to}) => {
      const renamed = roles.map(role => role.name === from ? {...role, name: to} : role);
      return {from, to, renamed, link: linkRelation(p.relation, renamed.map(role => role.name), lexicon, {exact, relations, values: valuesOf(renamed), headVerb: !exact})};
    }).filter(item => item.link.status === 'bound');
    if (bound.length === 1) { link = bound[0].link; roles = bound[0].renamed; relabeled = {from: bound[0].from, to: bound[0].to}; }
  }
  if (link.status !== 'bound') return {issue: {kind: 'relation', ...link}};
  // A converse lexeme ("name of", "description of": the object role comes first in the surface) swaps the clause subject and object before the atom is built.
  let converse = false;
  if (link.converse && link.roles.length === 2 && roles.length === 2 && new Set(roles.map(role => role.name)).size === 2 && roles.every(role => ['subject', 'object'].includes(role.name))) {
    const swapped = roles.map(role => ({...role, name: role.name === 'subject' ? 'object' : 'subject'}));
    // The constraints (role classes) are read again with the values in their new roles; the swap stands only when the same predicate still binds.
    const again = linkRelation(p.relation, swapped.map(role => role.name), lexicon, {exact, relations, values: valuesOf(swapped), headVerb: !exact});
    if (again.status === 'bound' && again.id === link.id) { link = again; roles = swapped; converse = true; }
  }
  let byName = new Map(roles.map(role => [role.name, role.value]));
  // A value that does not fit the type the predicate declares for its role. First the same single-oblique reading as above: a role whose value
  // clashes with its declared type moves to the ONE declared role that is still free ("Population of Qena": the name goes to the subject, the
  // integer role stays open). What is left is a precise clarification, never a failure when the atom is built.
  const clash = (names, types, values) => {
    const number = names.findIndex((name, index) => types?.[index] === 'integer' && typeof values.get(name) === 'string' && !/^[?$]/.test(values.get(name)) && !/^-?\d+$/.test(values.get(name).trim()));
    if (number >= 0) return {role: names[number], expected: 'integer'};
    return null;     // a class clash of an entity role is asked about as an entity ("Which entity do you mean by …"), not here
  };
  let clashed = clash(link.roles, link.types, byName);
  if (clashed) {
    const free = link.roles.filter(name => !byName.has(name) && name !== clashed.role);
    if (free.length === 1 && link.types?.[link.roles.indexOf(free[0])] !== 'integer') {
      const renamed = roles.map(role => role.name === clashed.role ? {...role, name: free[0]} : role);
      const retry = linkRelation(p.relation, renamed.map(role => role.name), lexicon, {exact, relations, values: valuesOf(renamed), headVerb: !exact});
      if (retry.status === 'bound' && !clash(retry.roles, retry.types, new Map(renamed.map(role => [role.name, role.value])))) {
        relabeled = {from: clashed.role, to: free[0], reason: 'type'};
        link = retry; roles = renamed; byName = new Map(roles.map(role => [role.name, role.value])); clashed = null;
      }
    }
  }
  if (clashed) return {issue: {kind: 'relation', status: 'type_mismatch', text: p.relation, role: clashed.role, value: byName.get(clashed.role), expected: clashed.expected, candidates: [{id: link.id, roles: link.roles}]}};
  const terms = link.roles.map((name, index) => {
    if (!byName.has(name)) return fresh();
    const value = byName.get(name), type = link.types?.[index];
    // A numeral written as a string fills an integer argument as a number.
    if (type === 'integer' && typeof value === 'string' && /^-?\d+$/.test(value.trim())) return String(Number(value.trim()));
    return termToken(value);
  });
  return {predicate: link.id, atomText: (p.polarity === 'negated' ? 'not ' : '') + link.id + ' ' + terms.join(' '), ...(span ? {span} : {}),
    scoring: {score: link.score, tier: link.tier, decided_by: link.decided_by, ...(link.via ? {via: link.via} : {}), alternatives: link.scored_alternatives ?? []},
    ...(relabeled ? {relabeled} : {}), ...(converse ? {converse} : {})};
}

/** Validity of a stated/assumed proposition, normalized by the host clock. */
export const propositionValidity = (p, now) => linkValidity(p.valid ?? {}, now);

/**
 * Lexicon-free identity of an authored proposition for duplicate checks and
 * metrics: folded relation phrase, sorted folded role values, polarity and
 * the validity strings. `basis` and `certainty` are not part of it.
 */
export function propositionKey(p) {
  const value = v => typeof v === 'string' && !v.startsWith('?') ? fold(v) : v && typeof v === 'object' && v.ref ? '$' + v.ref : v;
  return stable({relation: fold(p.relation), roles: p.roles.map(r => [r.name, value(r.value)]).sort((a, b) => a[0].localeCompare(b[0])), polarity: p.polarity, valid: Object.entries(p.valid ?? {}).map(([k, v]) => [k, fold(v)]).sort()});
}

/** The phrases of the host-rendered sentences, in English: the core renders English only (DS014 "English-only core"). */
const PHRASES = {asserted: 'You stated', hedged: 'You stated tentatively', supposed: 'You supposed', speaker: 'According to', assumed: 'The model assumed', not: 'not', basis: 'basis'};
/**
 * Host-rendered sentence for an authored proposition. It repeats the model's
 * own strings; the model never writes this prose, so the sentence cannot claim
 * a reading that was not declared.
 */
/** A role value as shown to the user: a `$id` reference in brackets, other values as written. */
const shownValue = value => (value && typeof value === 'object' && value.ref ? '[$' + value.ref + ']' : String(value));
/** The body of a host-rendered sentence: relation, roles and validity as the model wrote them. */
export function propositionBody(p) {
  const m = PHRASES;
  const roles = p.roles.map(({name, value}) => name + ': ' + shownValue(value)).join('; ');
  const time = Object.entries(p.valid ?? {}).map(([form, text]) => form + ' ' + text).join(', ');
  return (p.polarity === 'negated' ? m.not + ' ' : '') + p.relation + ' (' + roles + ')' + (time ? ' [' + time + ']' : '');
}
/** Conjunction words of the link keywords (the keywords themselves are English). */
export const LINK_PHRASES = {because: 'because', so: 'so', if: 'if', unless: 'unless', although: 'although', so_that: 'so that', before: 'before', after: 'after', when: 'when', while: 'while'};
export function explainProposition(p) {
  const m = PHRASES;
  const body = propositionBody(p);
  if (p.type === 'assumed') return m.assumed + ': ' + body + (p.basis && p.basis !== 'unspecified' ? ' (' + m.basis + ': ' + p.basis + ')' : '') + '.';
  const lead = p.speaker && p.speaker !== 'user' ? m.speaker + ' ' + p.speaker : m[p.certainty] ?? m.asserted;
  return lead + ': ' + body + '.';
}
/**
 * The host sentence of a proposition with its clause links (DS014 "Clauses and links"): "You stated: fail (…), because:
 * be idempotent (…) [not checked]." `links` are [{keyword, status, target}] with the target proposition.
 */
export function explainWithLinks(p, links = []) {
  const base = explainProposition(p);
  if (!links.length) return base;
  const words = LINK_PHRASES, note = 'not checked';
  const parts = links.map(link => words[link.keyword] + ': ' + (link.target ? propositionBody(link.target) : '$' + link.to) + (link.status === 'not_checked' ? ' [' + note + ']' : ''));
  return base.slice(0, -1) + ', ' + parts.join(', ') + '.';
}

/** Report entry shared by the packet and the HTTP trace. */
export function reportProposition(p, {atom = null, predicate = null, validity = null, extra = {}, links = null} = {}) {
  return {
    id: p.id, relation: p.relation, roles: p.roles, polarity: p.polarity, valid_text: p.valid ?? {},
    valid: validity ? {from: formatTime(validity.from), until: formatTime(validity.until)} : null,
    predicate, atom,
    ...(p.type === 'stated' ? {certainty: p.certainty, speaker: p.speaker} : {basis: p.basis}),
    statement: links?.length ? explainWithLinks(p, links) : explainProposition(p),
    ...(links?.length ? {links: links.map(({target, ...link}) => link)} : {}), ...extra,
  };
}
