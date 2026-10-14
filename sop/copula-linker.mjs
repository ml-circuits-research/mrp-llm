/**
 * The copula in the KnowledgeLinker (DS014 "KnowledgeLinker: the copula and the relation lexicon").
 *
 * A circuit author may write the verb "be" as the relation string `be` (also `be a` / `be an`, and
 * `be in` / `be located in`; also `be` with a `location` role, "Where is Paris?"), with the roles as written in the message. This module reads it as one of five closed
 * readings (class, occupation, attribute, identity, location) or as a description question ("Who is Ana?"). It names
 * no predicate: a base memory declares which of its predicates carry a reading (`reading NAME` on a predicate wire,
 * `describe_rank` for the order of the description predicates), and the code looks those up in the lexicon of the
 * memory in use. The language data (verb forms, articles, locative phrases, occupation nouns, attribute adjectives) is
 * the reviewed relation lexicon (sop/relation-lexicon.mjs).
 *
 * Deterministic and explainable: the result carries the readings tried, in order, and the predicates they found. In a
 * statement the first reading with exactly one declared predicate binds; in a question the readings that fit are kept
 * as alternatives (an `any` group), so the knowledge decides. When no declared reading fits, the answer is a precise
 * clarification, never "unknown relation be".
 */
import {phraseKey, predicateRoleNames} from './linking.mjs';
import {defaultRelationLexicon, relationTokens} from './relation-lexicon.mjs';

const isVariable = value => typeof value === 'string' && value.startsWith('?');
const isText = value => typeof value === 'string' && !isVariable(value);
const termToken = value => typeof value === 'number' || isVariable(value) ? String(value) : JSON.stringify(value);
const show = value => isVariable(value) ? 'it' : JSON.stringify(String(value));
const FIRST_WORD = /^\S+\s+/u;

/** Predicates of the lexicon that declare a reading, in a stable order (`describe` by rank, then id). */
export function declaredPredicates(lexicon, reading) {
  return Object.values(lexicon?.predicates ?? {}).filter(predicate => predicate.readings?.includes(reading))
    .sort((a, b) => reading === 'describe' ? (a.describeRank ?? 1e9) - (b.describeRank ?? 1e9) || a.id.localeCompare(b.id) : a.id.localeCompare(b.id));
}

/**
 * The shape of a copula relation phrase: `{form: 'bare', article}` for be / be a / be an (the article, when the
 * phrase carries it, is `indefinite`), `{form: 'locative'}` for be in / be located in, or null: any other phrase is not
 * the plain copula and the ordinary lexicon path decides.
 */
export function copulaForm(relation, relations = defaultRelationLexicon()) {
  const tokens = relationTokens(relation);
  for (const verb of [...relations.verbs].sort((a, b) => b.length - a.length)) {
    const head = verb.split(' ');
    if (head.every((token, index) => tokens[index] === token)) {
      const rest = tokens.slice(head.length).join(' ');
      if (!rest) return {form: 'bare', article: 'none'};
      if (relations.indefinite.has(rest)) return {form: 'bare', article: 'indefinite'};
      if (relations.locative.has(rest)) return {form: 'locative'};
    }
  }
  return null;
}

/** The noun phrase of an object string: article kind and the noun as written without the article. */
export function nounPhrase(text, relations = defaultRelationLexicon(), carried = 'none') {
  const written = String(text).trim(), tokens = relationTokens(written), first = tokens[0];
  const written_article = tokens.length > 1 ? (relations.indefinite.has(first) ? 'indefinite' : relations.definite.has(first) ? 'definite' : null) : null;
  const article = written_article ?? carried;
  const noun = written_article ? written.replace(FIRST_WORD, '') : written;
  return {article, noun, key: relationTokens(noun).join(' '), proper: article === 'none' && /^\p{Lu}/u.test(written)};
}

const rename = (usedName, roleNames) => roleNames.includes(usedName) ? usedName : roleNames[1];
/** Positional atom text of a predicate from role-name -> value; undeclared roles become fresh variables. */
function atomOf(predicate, values, fresh) {
  const names = predicateRoleNames(predicate);
  return predicate.id + ' ' + names.map(name => values.has(name) ? termToken(values.get(name)) : fresh()).join(' ');
}
const candidatesOf = predicates => predicates.map(predicate => ({id: predicate.id, roles: predicateRoleNames(predicate)}));

// Clarification questions and the readings they offer, in English: the core renders English only and the output edge translates (DS014 "English-only core").
const QUESTIONS = {
  describeNone: S => `I have no relation that says who or what ${S} is. Do you mean what ${S} does, or who ${S} is related to?`,
  noReading: (S, O) => `The knowledge in use declares no meaning for "be" between ${S} and ${O}. How else would you phrase it?`,
  choose: options => 'Do you mean: ' + options.join(' or ') + '?',
  where: S => `The knowledge in use declares no relation for where ${S} is. Which relation do you mean?`,
};
const OPTION = {
  class: (S, O) => `${S} is a kind of ${O}`,
  occupation: (S, O) => `${S} works as ${O}`,
  attribute: (S, O) => `${S} has the property ${O}`,
  identity: (S, O) => `${S} is the same as ${O}`,
};
const issue = (text, question, extra = {}) => ({issue: {kind: 'relation', status: 'copula_unclear', text, question, candidates: [], ...extra}});

/**
 * Link a copula proposition. Returns null when the relation is not a plain copula (the ordinary lexicon path decides),
 * `{issue}` for a clarification, or `{atomText, predicate, alternatives?, reading}`; `alternatives` ({atomText,
 * predicate} each) is set only for a question whose readings all fit.
 */
export function linkCopula(p, lexicon, {exact = true, fresh = () => '?host_any', relations = defaultRelationLexicon()} = {}) {
  const shape = copulaForm(p.relation, relations);
  if (!shape || !lexicon) return null;
  if (p.roles.some(role => typeof role.value === 'object')) return null; // a clause as an argument has no engine here
  const used = new Map(p.roles.map(role => [role.name, role.value]));
  const trace = {relation: p.relation, form: shape.form, tried: []};
  const result = (list, reading) => ({atomText: list[0].atomText, predicate: list[0].predicate, ...(list.length > 1 ? {alternatives: list} : {}), reading: {...trace, ...reading}});

  // "Where is Paris?" is the bare copula with a `location` role (the answer's place), the same reading as "be in".
  const bareWhere = shape.form === 'bare' && shape.article === 'none' && used.has('subject') && used.has('location') && p.roles.length === 2;
  if (shape.form === 'locative' || bareWhere) {
    const other = ['location', 'object', 'destination'].find(name => used.has(name));
    if (!used.has('subject') || !other || p.roles.some(role => !['subject', other].includes(role.name))) return null;
    const predicates = declaredPredicates(lexicon, 'location');
    trace.tried.push({reading: 'location', predicates: predicates.map(x => x.id)});
    if (!predicates.length) return issue(p.relation, QUESTIONS.where(show(used.get('subject'))));
    if (exact && predicates.length > 1) return issue(p.relation, QUESTIONS.choose(predicates.map(x => x.id)), {status: 'ambiguous', candidates: candidatesOf(predicates)});
    const list = predicates.map(predicate => {
      const names = predicateRoleNames(predicate);
      return {predicate: predicate.id, atomText: atomOf(predicate, new Map([['subject', used.get('subject')], [rename(other, names), used.get(other)]]), fresh)};
    });
    return result(list, {kind: 'location'});
  }

  // Bare copula: exactly a subject and an object.
  if (p.roles.some(role => !['subject', 'object'].includes(role.name))) return null;
  const subject = used.get('subject'), object = used.get('object');
  if (subject === undefined || object === undefined || (isVariable(subject) && isVariable(object))) return issue(p.relation, QUESTIONS.noReading(show(subject ?? '?'), show(object ?? '?')));
  const S = show(subject), O = show(object);

  // "Who/what is X?": the facts about X, in the order the knowledge itself ranks its describing predicates.
  if (isVariable(object)) {
    if (exact) return null;
    const predicates = declaredPredicates(lexicon, 'describe').filter(predicate => predicateRoleNames(predicate).length >= 2);
    trace.tried.push({reading: 'describe', predicates: predicates.map(x => x.id)});
    if (!predicates.length) return issue(p.relation, QUESTIONS.describeNone(S));
    const list = predicates.map(predicate => ({predicate: predicate.id, atomText: atomOf(predicate, new Map([['subject', subject], [predicateRoleNames(predicate)[1], object]]), fresh)}));
    return result(list, {kind: 'describe', subject: String(subject)});
  }
  if (!isText(object)) return null;

  const phrase = nounPhrase(object, relations, shape.article);
  // An arity-1 predicate named after the adjective, when the memory declares one ("tall ana").
  const named = phrase.article === 'none' && !phrase.proper ? Object.values(lexicon.predicates).filter(predicate => predicate.arity === 1
    && [predicate.id, ...(predicate.aliases ?? []).map(alias => alias.surface)].some(form => phraseKey(form) === phraseKey(phrase.noun))) : [];
  const order = [];
  if (phrase.article === 'indefinite') order.push(...(relations.occupations.has(phrase.key) ? ['occupation', 'class'] : ['class']));
  else if (phrase.article === 'none' && phrase.proper) order.push('identity');
  else if (phrase.article === 'none') order.push(...(relations.occupations.has(phrase.key) && !relations.attributes.has(phrase.key) ? ['occupation', 'attribute'] : ['attribute']));
  const found = [];
  if (named.length === 1) {
    trace.tried.push({reading: 'named', predicates: [named[0].id]});
    found.push({kind: 'attribute', predicates: [named[0]], named: true});
  }
  for (const kind of order) {
    const predicates = declaredPredicates(lexicon, kind);
    trace.tried.push({reading: kind, predicates: predicates.map(x => x.id)});
    if (predicates.length) found.push({kind, predicates});
  }
  const fitting = exact ? found.slice(0, 1) : found;
  if (!fitting.length) {
    const options = ['class', 'occupation', 'attribute', 'identity'].filter(kind => declaredPredicates(lexicon, kind).length).map(kind => OPTION[kind](S, O));
    return issue(p.relation, options.length ? QUESTIONS.choose(options) : QUESTIONS.noReading(S, O));
  }
  if (exact && fitting[0].predicates.length > 1) return issue(p.relation, QUESTIONS.choose(fitting[0].predicates.map(x => x.id)), {status: 'ambiguous', candidates: candidatesOf(fitting[0].predicates)});
  const list = fitting.flatMap(({kind, predicates, named: byName}) => predicates.map(predicate => {
    if (byName) return {predicate: predicate.id, atomText: atomOf(predicate, new Map([['subject', subject]]), fresh)};
    const value = kind === 'identity' ? String(object).trim() : phrase.noun;
    return {predicate: predicate.id, atomText: atomOf(predicate, new Map([['subject', subject], ['object', value]]), fresh)};
  }));
  return result(list, {kind: fitting[0].kind, article: phrase.article, noun: phrase.noun, order: found.map(item => item.kind)});
}
