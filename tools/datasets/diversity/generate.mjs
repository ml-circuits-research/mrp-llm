/** Diversity generator core: schedules families, languages, noise and splits; realizes each case into one or
 * more independent surfaces; builds the surface IR (model target) and the canonical IR (verification world);
 * prints both; links the target strings back to the verification world; executes the verification target.
 *
 * The model input is the user's message only (`question`). `verification_context`, `ontology_sop`,
 * `setup_sop`, `verification` and `expected` are evaluation-only scaffolding and never part of the prompt.
 */
import { EntityWorld, entityRecord } from './entities.mjs';
import { PREDICATES, ontologyType, orientedPredicate } from './domains.mjs';
import { Lexicon } from '../../../sop/lexicon.mjs';
import * as linking from '../../../sop/linking.mjs';
import { usePredicatePool } from './families.mjs';
import { ALL_FAMILIES } from './families-questions.mjs';
import { EXPANSION_FAMILIES, EXPANSION_WEIGHTS } from './families-expansion.mjs';
const FAMILIES = { ...ALL_FAMILIES, ...EXPANSION_FAMILIES };
import { emptySurface, surfaceSkeleton } from './ir.mjs';
import { Mentions, assembleMessage, chooseDiscourse, questionSentence, statementClause, realizeProposition, timeQuestion, whyQuestion, renderDate, tidy, quote } from './realize.mjs';
import { addNoise, codeSwitch, typoWeights } from './noise.mjs';
import { makeUnclear } from './unclear.mjs';
import { Chooser, isHeldout, maskedTemplate, nameIsHeldout } from './quotas.mjs';
import { isOodOnly } from './heldout.mjs';
import { RO_CONSTRUCTION_EN, englishDate, englishRelation } from './english.mjs';
/** The English target phrase of construction `c` of `relation` realized in `language` (english.mjs). */
const targetPhrase = (relation, c, language) => language === 'en' ? c.rel : RO_CONSTRUCTION_EN[`${relation}.${c.id}`];
/** A proposition with its relation phrase in English; the message's own phrase is kept as `source_relation`. */
const toEnglish = (p, language) => { if (p.relation === undefined) return p; const relation = englishRelation(p.relation, language); return relation === p.relation ? p : { ...p, relation, source_relation: p.source_relation ?? p.relation }; };
import { printTarget } from './printers.mjs';
import { executeTarget } from './execute.mjs';
import { rowWorld } from '../../../lib/row-world.mjs';
import { capitalize, foldDiacritics, hash32, rng } from './text.mjs';
import { rowRights } from '../rights.mjs';
import { relationWordProblems } from './relation-words.mjs';
import { CHITCHAT, QUESTION_LEADS, SIGNOFFS, lengthTarget, listDigression } from './long.mjs';

/** Family weights of the main corpus (DS015 mix rules): operator families (joins, temporal, filters, count,
 * constraints, conjunctions, anchors, time questions, universal questions) together at least 25% of rows, each
 * formerly blocked family at least 1.5%, and quotas per question type (quotas.mjs QUESTION_TYPE_MINIMA). */
export const DEFAULT_FAMILY_WEIGHTS = {
  lookup: 1.1, wh_select: 1.1, count: 1, filter: 0.9, join: 1, temporal: 1.2, attached: 1.3, negation: 0.9, closure_assumption: 0.45, world_assumption: 0.55,
  proof_depth: 0.9, ambiguity: 1, contrast: 0.7, multi_question: 0.7, claim_check: 0.7, statement_only: 0.6, constraint: 0.9, abduction: 0.6, default_exception: 0.6, counterfactual: 0.6, planning: 0.6,
  // unclear and time questions rise with the expansion families so their quota floors keep holding.
  causal: 0.6, intention: 0.6, general_quantification: 1.3, unclear: 2.1,
  time_question: 2.8, where_question: 0.9, how_question: 0.7, why_question: 1, conjunction: 0.8, interpretation: 0.8, anchor: 0.9, ambiguity_visible: 0.9,
  // Long multi-paragraph messages composed of independently realized parts (DS015 "Long messages"): about 7% of rows.
  long_message: 2.3,
  // Expansion families (families-expansion.mjs, DS015 "Expansion families"): about 15% of rows together.
  ...EXPANSION_WEIGHTS,
};
/** The out-of-distribution suite: generic families over the held-out domains only (families.mjs usePredicatePool). */
export const OOD_FAMILY_WEIGHTS = {
  lookup: 1.2, wh_select: 1.2, count: 0.8, filter: 0.6, attached: 1.2, negation: 0.8, claim_check: 0.7, statement_only: 0.5, multi_question: 0.6, time_question: 1.4, conjunction: 0.6, unclear: 0.6,
  long_message: 0.8,
};
/** The construction axis of the OOD suite: the same generic families over the in-distribution predicates that
 * have held-out constructions (domains.mjs HELDOUT_CONSTRUCTIONS), realized only through OOD-only and
 * test-reserved constructions and frames. No `unclear` rows: they carry no construction. */
export const OOD_CONSTRUCTION_FAMILY_WEIGHTS = Object.fromEntries(Object.entries(OOD_FAMILY_WEIGHTS).filter(([family]) => family !== 'unclear'));
const LANGUAGE_TARGET = { en: 0.5, ro: 0.35, mixed: 0.15 };
const NOW = '2026-09-28T12:00:00Z';
/** Recorded on every row (`source.revision`): the generator version that composed it. */
const GENERATOR_REVISION = 'diversity-generator-v2';

function splitOf(seed, group) {
  const n = hash32(`${seed}:split:${group}`) % 20;
  return n < 14 ? 'train' : n < 17 ? 'dev' : 'test';
}

// ---------------------------------------------------------------- verification world (evaluation only)
/** Verification entities of a row: EN/RO labels and every surface used as an alias. The predicate declarations
 * and converse rules are shared by reference (lib/row-world.mjs): `row.world` names the blocks the row uses. */
function ontology(entities, aliases) {
  const lines = [];
  for (const entity of entities) {
    // Each surface is an alias in both languages (a code-switched message may use either), except a label's own language.
    lines.push(`@${entity.id} entity\n  kind ${ontologyType(entity.type)}\n  label en ${quote(entity.labels.en)}\n  label ro ${quote(entity.labels.ro)}` +
      [...new Set([entity.labels.en, entity.labels.ro, ...(entity.sharedAlias ? Object.values(entity.sharedAlias) : []), ...(entity.userAliases ?? []), ...(aliases.get(entity.id) ?? [])])].filter(Boolean)
        .flatMap(a => ['en', 'ro'].filter(language => entity.labels[language] !== a).map(language => `\n  alias ${language} ${quote(a)}`)).join(''));
  }
  return lines.join('\n\n') + '\n';
}
/** Declaration of one predicate orientation: closed-role lines and every relation phrase of its constructions. */
function predicateBlock(id, converse) {
  const spec = PREDICATES[id];
  const [[, t1], second, third] = spec.roles;
  // Romanian constructions also declare their English target phrase (english.mjs), so an English target links.
  const constructions = ['en', 'ro'].flatMap(language => spec[language].filter(c => c.converse === converse).flatMap(c => [[language, c.rel], ...(language === 'ro' && RO_CONSTRUCTION_EN[`${id}.${c.id}`] ? [['en', RO_CONSTRUCTION_EN[`${id}.${c.id}`]]] : [])]));
  if (!constructions.length) return null;
  const roles = second ? (converse ? [['subject', second[1]], [spec.closedRoles.converse, t1]] : [['subject', t1], [spec.closedRoles.direct, second[1]]]) : [['subject', t1]];
  // A three-place authored predicate (sent_to, moved) declares its third role by its closed name (`thirdRole`).
  if (third && !converse) roles.push([spec.thirdRole, third[1]]);
  const seen = new Set(), phraseLines = [];
  if (!converse) for (const language of ['en', 'ro']) for (const alias of spec.senseAliases?.[language] ?? []) constructions.push([language, alias]);
  for (const [language, rel] of constructions) {
    const key = `${language}:${rel}`;
    if (seen.has(key)) continue;
    phraseLines.push(`  ${[...seen].some(k => k.startsWith(language + ':')) ? 'alias' : 'label'} ${language} ${quote(rel)}`);
    seen.add(key);
  }
  return `@${orientedPredicate(id, converse)} predicate\n${roles.map(([name, type]) => `  role ${name} ${ontologyType(type)}`).join('\n')}\n${phraseLines.join('\n')}\n  description ${quote(converse ? `${spec.gloss} (seen from the second argument)` : spec.gloss)}`;
}
const hasConverse = id => PREDICATES[id].roles.length === 2 && ['en', 'ro'].some(l => PREDICATES[id][l].some(c => c.converse));
/** Rules that make a converse predicate equivalent to its direct predicate, both polarities. */
function converseRuleBlock(id) {
  const c = orientedPredicate(id, true);
  const rules = [[`${id} ?a ?b`, `${c} ?b ?a`], [`${c} ?b ?a`, `${id} ?a ?b`], [`not ${id} ?a ?b`, `not ${c} ?b ?a`], [`not ${c} ?b ?a`, `not ${id} ?a ?b`]];
  return rules.map(([when, then], i) => `@conv_${id}_${i + 1} rule\n  when ${when}\n  then ${then}`).join('\n\n');
}
/** The shared world of every corpus built by this generator: {predicates, rules} as Maps and as file text. */
export function sharedWorld() {
  const predicates = new Map(), rules = new Map();
  for (const id of Object.keys(PREDICATES)) for (const converse of [false, true]) { const block = predicateBlock(id, converse); if (block) predicates.set(orientedPredicate(id, converse), block); }
  for (const id of Object.keys(PREDICATES)) if (hasConverse(id)) rules.set(id, converseRuleBlock(id));
  const header = kind => `# Shared verification world of the generated corpora: ${kind}. Evaluation-only; never model input.\n# Rows reference blocks by id (row.world); lib/row-world.mjs assembles a row's world. Generated by tools/datasets/build-corpora.mjs.\n\n`;
  return { predicates, rules,
    files: { 'predicates.sop': header('predicate declarations') + [...predicates.values()].join('\n\n') + '\n', 'rules.sop': header('converse-equivalence rules') + [...rules].map(([id, text]) => `# block ${id}\n${text}`).join('\n\n') + '\n' } };
}
const SHARED = sharedWorld();
const worldOf = (predicateIds, dir) => ({ dir, predicates: predicateIds.flatMap(id => [id, ...(SHARED.predicates.has(orientedPredicate(id, true)) ? [orientedPredicate(id, true)] : [])]), rules: predicateIds.filter(id => SHARED.rules.has(id)) });
const nextDay = iso => new Date(Date.parse(iso + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
const validOf = time => !time || time.valid === 'timeless' ? 'timeless' : time.on ? `${time.on} ${nextDay(time.on)}` : `${time.from ?? 'beginning'} ${time.until ?? 'open'}`;
const factWires = (facts, prefix) => facts.map((f, i) => `@${prefix}${i + 1} fact\n  holds ${f.polarity === 'negated' ? 'not ' : ''}${f.relation} ${f.args.join(' ')}\n  valid ${validOf(f.time)}\n  source world`).join('\n\n');
const ruleWires = rules => rules.map((r, i) => `@rule${i + 1} rule\n${r.when.map(w => `  when ${w}`).join('\n')}\n  then ${r.then}`).join('\n\n');

// ---------------------------------------------------------------- one surface of one case
function realizeCase(spec, { language, questionLanguage, random, choose, switchValues = false }) {
  const mentions = new Mentions(language, random, spec.plan.styles ?? {});
  // Code-switching inside the formalized sentence: a Romanian clause names a common noun in English ("Ion predă chemistry").
  mentions.switchValues = switchValues;
  const plan = spec.plan;
  const surface = emptySurface();
  const ids = [];
  const clauseTexts = [];
  const links = [];
  const speakerMention = plan.speaker ? mentions.surface(plan.speaker, { language }) : null;
  for (const [index, clause] of (plan.clauses ?? []).entries()) {
    // Reported speech about the speaker ('Burak says he wants …') uses a pronoun for the repeated subject.
    const realized = statementClause(clause.canon, { language, random, choose, mentions, past: clause.past, pronoun: Boolean(plan.speaker) || index > 0, constructionFilter: clause.direct ? c => !c.converse : clause.exclude ? c => !clause.exclude.includes(c.rel) && !clause.exclude.includes(targetPhrase(clause.canon.relation, c, language)) : null });
    if (!realized) throw Error(`${spec.family}: no construction for ${clause.canon.relation} in ${language}`);
    clauseTexts.push(realized.text);
    ids.push(...realized.ids);
    const canon = spec.canon.stated[index];
    surface.stated.push({ ...realized.prop, certainty: canon.certainty, ...(canon.speaker ? { speaker: quote(speakerMention.value) } : {}) });
    links.push({ kind: 'stated', construction: realized.construction, canon });
  }
  let question = null, alternatives = [];
  const q = plan.question;
  const qLanguage = questionLanguage ?? language;
  const discourse = clauseTexts.length && q ? chooseDiscourse({ certainty: plan.certainty ?? 'asserted', speaker: speakerMention?.text ?? null, language, choose, statementFirst: Boolean(plan.statementFirst) }) : null;
  if (q?.custom) {
    const variants = q.custom[qLanguage];
    const chosen = choose(`custom:${q.id}:${qLanguage}`, variants.map((variant, i) => ({ id: `${q.id}.${qLanguage}.${i}`, variant })));
    const surfaces = {}, values = {};
    for (const [slot, entity] of Object.entries(q.slots)) {
      if (!entity?.id || !chosen.variant[0].includes(`{${slot}}`)) continue;
      const m = mentions.surface(entity, { language: qLanguage });
      if (!m) continue;
      surfaces[slot] = m.text; values[slot] = quote(m.value);
    }
    const [template] = chosen.variant;
    const text = capitalize(tidy(template.replace(/\{(\w+)\}/g, (_, slot) => surfaces[slot] ?? `{${slot}}`)));
    // A custom variant returns its propositions, or {props, scope, select, measure, ask} for richer query forms.
    const built = chosen.variant[1](values);
    const shape = Array.isArray(built) ? { props: built } : built;
    // Authored Romanian relation phrases become English (english.mjs, Q-DATA-6).
    const english = list => list?.map(p => toEnglish(p, qLanguage));
    shape.props = english(shape.props); if (shape.scope) shape.scope = english(shape.scope);
    // An authored message may also state propositions, ask several queries or pose a constraint (families-expansion.mjs).
    for (const p of english(shape.stated) ?? []) surface.stated.push({ certainty: 'asserted', ...p });
    const ask = shape.ask ?? q.ask;
    const extras = qs => Object.fromEntries(['compare', 'rank', 'quantifier', 'order', 'fragment', 'filter'].filter(key => qs[key] !== undefined).map(key => [key, qs[key]]));
    if (shape.props?.length) surface.query = { ask, ...(ask === 'which' || ask === 'count' ? { select: shape.select ?? q.select ?? ['?x'] } : shape.select ? { select: shape.select } : {}), props: shape.props,
      ...(shape.scope ? { scope: shape.scope } : {}), ...(shape.measure ? { measure: shape.measure } : {}), ...extras(shape) };
    if (shape.moreQueries?.length) surface.moreQueries = shape.moreQueries.map(more => ({ ask: more.ask ?? 'whether', ...(more.select ? { select: more.select } : {}), props: english(more.props), ...extras(more) }));
    if (shape.constraint) surface.constraint = shape.constraint;
    if (chosen.variant[2]?.alternatives) alternatives = chosen.variant[2].alternatives(values).map(alt => ({ ...emptySurface(), ...alt,
      stated: (alt.stated ?? []).map(p => ({ certainty: 'asserted', ...toEnglish(p, qLanguage) })), ...(alt.query ? { query: { ...alt.query, props: english(alt.query.props) } } : {}) }));
    // Inside a frame ("…, {z}") an authored question that starts with a literal word continues in lower case.
    const inner = template.startsWith('{') || /^(I|I'm|I'd)\b/.test(text) ? text : text[0].toLowerCase() + text.slice(1);
    question = { text, inner, ids: [chosen.id], frame: chosen.id, form: 'authored', qtype: chosen.variant[2]?.qtype ?? q.qtype, unclearReadings: chosen.variant[2]?.unclearReadings?.(values) ?? null };
    for (const value of chosen.variant[2]?.translated ?? []) mentions.translated.add(value);
    for (const a of chosen.variant[2]?.assumed?.(values) ?? []) surface.assumed.push(toEnglish(a, qLanguage));
  } else if (q?.customNumbers) {
    const variants = q.customNumbers[qLanguage];
    const chosen = choose(`numbers:${q.id}:${qLanguage}`, variants.map((text, i) => ({ id: `${q.id}.${qLanguage}.${i}`, text })));
    // Romanian puts "de" between a number from 20 up (or a round hundred) and its noun: "36 de locuri".
    const needsDe = n => qLanguage === 'ro' && (n % 100 >= 20 || (n >= 100 && n % 100 === 0));
    const text = chosen.text.replace(/\{(\w+)\}( (?!de\b|și\b|si\b|sau\b|până\b|pînă\b|la\b)\p{L})?/gu, (_, slot, next = '') => String(q.numbers[slot]) + (next && needsDe(q.numbers[slot]) ? ' de' + next : next));
    surface.constraint = spec.canon.constraint;
    question = { text, inner: text, ids: [chosen.id], frame: chosen.id, form: 'authored' };
  } else if (q?.timeQ) {
    question = timeQuestion({ ...q.timeQ, variable: '?t' }, { language: qLanguage, random, choose, mentions });
    if (!question) throw Error(`${spec.family}: no time question for ${q.timeQ.prop.relation} in ${qLanguage}`);
    const measure = { since: 'start', until: 'end', how_long: 'duration' }[q.timeQ.kind];
    surface.query = { ask: q.timeQ.kind === 'how_many_times' ? 'count' : 'which', select: ['?t'], props: [question.prop], ...(measure ? { measure } : {}) };
    question.qtype = { when: 'when', since: 'since_when', until: 'until_when', how_long: 'how_long', how_many_times: 'how_many_times' }[q.timeQ.kind];
    links.push({ kind: 'query', canon: spec.canon.query });
  } else if (q?.why) {
    question = whyQuestion({ prop: q.why, past: q.past }, { language: qLanguage, random, choose, mentions });
    if (!question) throw Error(`${spec.family}: no why question for ${q.why.relation} in ${qLanguage}`);
    surface.query = { ask: 'explain', props: [question.prop] };
    question.qtype = 'why';
    links.push({ kind: 'query', canon: spec.canon.query });
  } else if (q?.conj) {
    // Two ground propositions about one subject asked together: one query with an `all` group.
    const [first, second] = q.conj;
    const conjFrames = qLanguage === 'ro' ? ['{A} și {B}?', 'E adevărat că {A} și {B}?', 'Verifică dacă {A} și {B}.', 'Oare {A} și {B}?', 'Știi dacă {A} și {B}?'] : ['{A} and {B}?', 'Is it true that {a} and {b}?', 'Can you check whether {a} and {b}?', 'Do you know if {a} and {b}?', 'Both at once: {A}, and {B}?'];
    const frame = choose(`frame:conj:${qLanguage}`, conjFrames.map((text, i) => ({ id: `conj.${qLanguage}.${i}`, text })));
    const declarative = /\{a\}/.test(frame.text) || qLanguage === 'ro';
    const c1 = realizeProposition({ ...first, time: { valid: 'timeless' } }, { key: declarative ? 's' : 'q', language: qLanguage, random, choose, mentions, asQuery: true });
    const c2 = realizeProposition({ ...second, time: { valid: 'timeless' } }, { key: declarative ? 's' : 'q', language: qLanguage, random, choose, mentions, asQuery: true, pronoun: true });
    if (!c1 || !c2) throw Error(`${spec.family}: no conjunction for ${first.relation}+${second.relation}`);
    const text = frame.text.replace('{A}', c1.text).replace('{a}', c1.text).replace('{B}', c2.text).replace('{b}', c2.text);
    const props = [c1.prop, c2.prop].map(p => { const copy = { ...p }; delete copy.queryTime; return copy; });
    surface.query = { ask: 'whether', props };
    question = { text: capitalize(tidy(text)), inner: tidy(text), ids: [...c1.ids, ...c2.ids, frame.id], frame: frame.id, form: 'conjunction', qtype: 'yes_no' };
    links.push({ kind: 'query', canon: spec.canon.query });
  } else if (q) {
    // A question about a proposition the user has just stated in the same message is asked in other words.
    const distinct = q.distinctFromStated ? { constructionFilter: c => !surface.stated.some(p => p.relation === targetPhrase(q.prop.relation, c, qLanguage)) } : {};
    question = questionSentence({ ...q, ...distinct, pronoun: q.pronoun && !discourse?.questionFirst }, { language: qLanguage, random, choose, mentions, plainOnly: Boolean(discourse?.embedsQuestion) });
    const prop = question.prop;
    const variable = q.variable ?? '?x';
    surface.query = { ask: q.ask, ...(q.ask !== 'whether' ? { select: [variable] } : {}), props: [prop], ...(question.filterValue ? { filter: [`${variable} != ${question.filterValue}`] } : {}) };
    question.qtype = q.whKey ? 'where' : q.claimCheck ? 'claim_check' : { whether: 'yes_no', which: 'wh', count: 'count' }[q.ask];
    if (q.asofDate) {
      // "Going by what was known on <date>, …": the knowledge cutoff of a query (`asof`), re-expressed from query-v2.
      const d = renderDate(q.asofDate, qLanguage, random), dTarget = qLanguage === 'en' ? d : englishDate(q.asofDate);
      const lead = choose(`asof:${qLanguage}`, (qLanguage === 'ro' ? ['După ce se știa pe {d}, ', 'Cu informațiile de la {d}, ', 'Judecând după ce se știa la {d}, '] : ['Going by what was known on {d}, ', 'Based on what we knew on {d}, ', 'With what was known as of {d}, ']).map((text, i) => ({ id: `asof.${qLanguage}.${i}`, text })));
      question = { ...question, text: lead.text.replace('{d}', d) + question.inner, inner: lead.text.replace('{d}', d) + question.inner, ids: [...question.ids, lead.id] };
      surface.query.asof = quote(dTarget);
      prop.timeIso = { ...(prop.timeIso ?? {}), [dTarget]: q.asofDate };
    }
    links.push({ kind: 'query', canon: spec.canon.query });
  }
  if (plan.question2) {
    // A second question in the same message: joined as its own sentence, printed as a second query wire.
    const second = questionSentence(plan.question2, { language: qLanguage, random, choose, mentions, plainOnly: true });
    const joiner = choose(`multi:${qLanguage}`, (qLanguage === 'ro' ? [' Și ', ' Apropo, ', ' Încă ceva: ', ' '] : [' And ', ' Also, ', ' One more thing: ', ' ']).map((text, i) => ({ id: `multi.${qLanguage}.${i}`, text })));
    question = { ...question, text: `${question.text}${joiner.text}${/(^ (And|Și) $)|, $/.test(joiner.text) ? second.inner : second.text}`, ids: [...question.ids, ...second.ids, joiner.id] };
    surface.moreQueries = [{ ask: 'whether', props: [second.prop] }];
  }
  for (const a of plan.assumed ?? []) {
    if (a.meta) {
      // An interpretation assumption ("refer to", "mean"): strings the family authors from this message's mentions.
      const values = Object.fromEntries(Object.entries(a.slots ?? {}).map(([slot, entity]) => [slot, mentions.values.get(entity.id)]));
      const prop = a.meta({ language: qLanguage, values, question });
      if (prop) { surface.assumed.push({ ...toEnglish(prop, qLanguage), meta: true }); links.push({ kind: 'assumed_meta' }); }
      continue;
    }
    // An assumption about the same predicate as the question or a statement reuses its relation phrase: a world
    // assumption (the asymmetry of what the user said) the statement's, any other (closure, default) the question's.
    // The model never restates the question in another relation phrase: that would be reasoning across relations.
    const statedRelations = new Set(surface.stated.map(p => p.relation)), queryRelations = new Set((surface.query?.props ?? []).map(p => p.relation));
    const [first, second] = a.reuse === 'stated' ? [statedRelations, queryRelations] : [queryRelations, statedRelations];
    // Unbalanced choice, but never an OOD-only construction outside the OOD suite (heldout.mjs).
    const pickAny = (kind, options) => { const pool = choose.chooser?.split === 'ood' ? options : options.filter(option => !isOodOnly(option.id)); return pool.length ? pool[random.int(pool.length)] : null; };
    const key = a.canon.polarity === 'negated' ? 'n' : 's';
    // In a clause-switched message the statement is in the other language; its reversal is written in that language.
    const aLanguage = a.reuse === 'stated' && surface.stated.length ? language : qLanguage;
    const realized = realizeProposition(a.canon, { key, language: aLanguage, random, choose: pickAny, mentions, constructionFilter: c => first.has(targetPhrase(a.canon.relation, c, aLanguage)) })
      ?? realizeProposition(a.canon, { key, language: aLanguage, random, choose: pickAny, mentions, constructionFilter: c => second.has(targetPhrase(a.canon.relation, c, aLanguage)) })
      ?? realizeProposition(a.canon, { key: 's', language: aLanguage, random, choose: pickAny, mentions });
    if (!realized) throw Error(`no construction for the assumption over ${a.canon.relation} in ${aLanguage}`);
    const prop = { ...realized.prop, basis: a.basis };
    surface.assumed.push(prop);
    links.push({ kind: 'assumed', construction: realized.construction, canon: a.canon });
  }
  const message = assembleMessage({ clauses: clauseTexts, question, certainty: plan.certainty ?? 'asserted', speaker: speakerMention?.text ?? null, language, choose, discourse });
  if (spec.asUnclear) {
    // A visible ambiguity the model does not resolve: `unclear kind ambiguous` with one reading per candidate (Q-ARCH-1).
    const values = Object.fromEntries(Object.entries(plan.readingSlots ?? {}).map(([slot, entity]) => [slot, mentions.values.get(entity.id)]));
    const readings = question?.unclearReadings ?? plan.readings?.({ values, language: qLanguage }) ?? [];
    const unclear = { ...emptySurface(), unclear: { kind: 'ambiguous', readings: readings.map(quote) } };
    return { text: message.text, surface: unclear, ids: [...ids, ...(question?.ids ?? []), ...message.ids], questionFrame: question?.frame ?? message.discourse, discourse: message.discourse, shape: message.shape, form: question?.form ?? 'statement', mentions, links: [], qtype: 'ambiguous' };
  }
  const qtype = surface.constraint ? 'numeric' : !question ? 'none' : plan.question2 ? 'multi' : question.qtype ?? (surface.query?.ask === 'every' ? 'universal' : surface.query?.ask === 'explain' ? 'why' : { whether: 'yes_no', which: 'wh', count: 'count' }[surface.query?.ask] ?? 'yes_no');
  return { text: message.text, surface, ids: [...ids, ...(question?.ids ?? []), ...message.ids], questionFrame: question?.frame ?? message.discourse, discourse: message.discourse, shape: message.shape, form: question?.form ?? 'statement', mentions, links, qtype, alternatives };
}

/**
 * Accepted alternative readings of a genuinely ambiguous phrasing (owner decision Q-DATA-5, DS014/DS015): the
 * primary target formalizes one plausible reading and each alternative another; evaluation accepts any of them.
 * The table is explicit. "Pentru ce e închisă sala?" asks what the hall is closed for (`select ?x … role topic
 * ?x`) or why it is closed (`mode explain` over "be closed").
 */
const AMBIGUOUS_PHRASINGS = [
  { id: 'ro_pentru_ce_closed', test: (surface, text) => /\bpentru ce\b/i.test(text) && surface.query?.ask === 'which' && surface.query.props.length === 1 && surface.query.props[0].relation === 'be closed for',
    alternative: surface => { const subject = surface.query.props[0].roles.find(([role]) => role === 'subject'); return { ...surface, query: { ask: 'explain', props: [{ relation: 'be closed', roles: [subject], polarity: 'affirmed' }] } }; } },
];
export function alternativeReadings(surface, text) {
  return AMBIGUOUS_PHRASINGS.filter(rule => rule.test(surface, text)).map(rule => rule.alternative(surface));
}

/** Make every quoted role value match the final message verbatim (noise may fold diacritics or case). */
function alignValues(surface, text, translated = new Set()) {
  const fix = value => {
    if (!value.startsWith('"')) return value;
    const raw = JSON.parse(value);
    // A translated common noun (english.mjs) is not in the message by design.
    if (translated.has(raw)) return value;
    if (text.includes(raw)) return value;
    const folded = foldDiacritics(raw);
    if (text.includes(folded)) return quote(folded);
    const index = text.toLowerCase().indexOf(raw.toLowerCase());
    if (index >= 0) return quote(text.slice(index, index + raw.length));
    const foldedIndex = foldDiacritics(text).toLowerCase().indexOf(folded.toLowerCase());
    if (foldedIndex >= 0) return quote(text.slice(foldedIndex, foldedIndex + raw.length));
    return null;
  };
  const props = [...surface.stated, ...surface.assumed, ...(surface.query?.props ?? []), ...(surface.query?.scope ?? []), ...(surface.moreQueries ?? []).flatMap(q => q.props)];
  for (const p of props) {
    for (const pair of p.roles) {
      const fixed = fix(pair[1]);
      if (fixed === null && !p.basis) return false;
      if (fixed) pair[1] = fixed;
    }
    if (p.speaker) { const fixed = fix(p.speaker); if (!fixed) return false; p.speaker = fixed; }
  }
  if (surface.query?.filter) surface.query.filter = surface.query.filter.map(f => f.replace(/"(?:\\.|[^"\\])*"$/, v => fix(v) ?? v));
  return true;
}

// ---------------------------------------------------------------- the generator
export async function generate({ seed = 'diversity-pilot-2026', rows: target = 300, familyWeights = DEFAULT_FAMILY_WEIGHTS, inventory = null, execute = true, printer = 'strings', pool = 'main', splits = null, groupPrefix = 'dv', onProgress = null, worldDir = 'datasets_archive/formalizer-v1/world' } = {}) {
  usePredicatePool(pool);
  const random = rng(seed);
  const chooser = new Chooser(rng(`${seed}:choose`));
  const choose = chooser.bound();
  const weights = typoWeights(inventory?.typo_model_measured);
  const familyRows = Object.fromEntries(Object.keys(familyWeights).map(f => [f, 0]));
  const languageRows = { en: 0, ro: 0, mixed: 0 };
  const out = [];
  const problems = [];
  const seenMessages = new Set();
  const normalizeMessage = text => foldDiacritics(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  let caseIndex = 0;
  while (out.length < target) {
    caseIndex++;
    const family = Object.keys(familyWeights).sort((a, b) => familyRows[a] / familyWeights[a] - familyRows[b] / familyWeights[b] || hash32(`${seed}:${caseIndex}:${a}`) - hash32(`${seed}:${caseIndex}:${b}`))[0];
    const total = Math.max(1, out.length);
    const mode = Object.keys(LANGUAGE_TARGET).sort((a, b) => languageRows[a] / total - LANGUAGE_TARGET[a] - (languageRows[b] / total - LANGUAGE_TARGET[b]))[0];
    const group = `${groupPrefix}_${String(caseIndex).padStart(6, '0')}`;
    // `ood` is the out-of-distribution suite: its rows are sealed test rows, and its resource choices use the
    // OOD-only and test-reserved partitions (heldout.mjs).
    const drawn = splits ? splits(group) : splitOf(seed, group);
    chooser.setSplit(drawn);
    const split = drawn === 'ood' ? 'test' : drawn;
    const caseRandom = rng(`${seed}:${group}`);
    const allowName = name => split === 'test' ? true : !nameIsHeldout(name);
    const reserved = (kind, value) => isHeldout(`${kind}:${value}`, 99);
    const partition = (kind, test) => value => split === 'test' ? (test(value) || caseRandom.chance(0.15)) : !test(value);
    const world = new EntityWorld(caseRandom, { allowName: partition('name', nameIsHeldout), allowPlace: partition('place', place => reserved('place', place)), allowPooled: partition('pooled', label => reserved('pooled', label)) });
    const language = mode === 'mixed' ? caseRandom.pick(['en', 'ro']) : mode;
    try {
      const made = family === 'unclear' ? await unclearRows({ group, split, language, mode, random: caseRandom, choose, world, weights, seed, worldDir })
        : family === 'long_message' ? await longRows({ group, split, language, mode, random: caseRandom, choose, world, weights, execute, printer, worldDir, pool })
        : await caseRows({ family, group, split, language, mode, random: caseRandom, choose, world, weights, execute, printer, seed, worldDir });
      for (const row of made) {
        const key = normalizeMessage(row.question);
        if (seenMessages.has(key)) continue;
        seenMessages.add(key);
        out.push(row); familyRows[family] += 1; languageRows[row.code_switch ? 'mixed' : row.language] += 1;
      }
      if (!made.length) familyRows[family] += 0.5;
      if (onProgress && out.length % 1000 < made.length) onProgress(out.length);
    } catch (error) {
      problems.push({ group, family, error: String(error.message ?? error).slice(0, 300) });
      familyRows[family] += 0.5;
      if (problems.length > 200) throw Error(`Too many generation problems: ${JSON.stringify(problems.slice(0, 5))}`);
    }
  }
  return { rows: out, problems, usage: Object.fromEntries(chooser.usage) };
}

const COMMON = (row, extra) => ({
  evaluation_track: 'formalization', semantic_status: 'valid', setup_sop: '',
  review_status: 'not_reviewed', target_review_status: 'pending_review', quality_flags: { source_rows_copied: false, synthetic: true, human_reviewed: false, training_approved: false },
  ...row, ...extra,
});

async function unclearRows({ group, split, language, mode, random, choose, world, weights, worldDir }) {
  const kind = random.weighted([['gibberish', 2], ['no_request', 3]]);
  const made = makeUnclear(kind, { random, language, choose });
  let text = made.text;
  let noise = [], noiseLevel = null;
  if (random.chance(0.35)) ({ text, ops: noise, level: noiseLevel } = addNoise(text, { language, random, weights }));
  if (!noise.length) noiseLevel = null;
  let code_switch = null;
  if (mode === 'mixed' && kind === 'no_request') { const switched = codeSwitch(text, { matrix: language, random, kind: 'tag' }); if (switched) { text = switched.text; code_switch = switched.switch; } }
  const surface = { ...emptySurface(), unclear: { kind } };
  const printed = printTarget('strings', { surface });
  const e1 = world.make('person'), e2 = world.make('company'), e3 = world.make('city');
  const entities = [e1, e2, e3];
  return [COMMON({
    id: `${group}_0`, split_group_id: group, semantic_case_id: group, surface_group_id: `${group}_0`, split, language, question: text,
    family: 'unclear', variant: `${kind}_${made.method}`, structure_id: `unclear:${kind}`, question_type: 'unclear', input_mode: 'message_only', negative_of: null,
    noise, noise_level: noiseLevel, code_switch, surface_design: { question_frame: made.id, discourse: 'none', shape: 'unclear', masked_template: maskedTemplate(text), resources: [made.id] },
    ir_skeleton: surfaceSkeleton(surface), surface_ir: surface, sop_target: printed.target, target_format: printed.format, provisional_constructs: printed.provisional,
    verification_context: { now: NOW, language, model_visible: false, entities: entities.map(e => entityRecord(e, language)), predicates: [{ id: 'works_at', args: ['person', 'organization'], roles: ['employee', 'employer'], meaning: PREDICATES.works_at.gloss }] },
    ontology_sop: ontology(entities, new Map()), world: worldOf(['works_at'], worldDir),
    expected: { status: 'unclear', unclear_kind: kind }, execution: { status: 'unclear', executed: false, reason: 'unclear rows have no verification target' },
    source: { kind: 'generator_composed_scenario', revision: GENERATOR_REVISION },
    rights: rowRights([]),
  })];
}

async function caseRows({ family, group, split, language, mode, random, choose, world, weights, execute, printer, seed, worldDir }) {
  // language and mode may be narrowed by the case (see below).
  const spec = FAMILIES[family]({ random, world });
  // A case authored for some languages only (the English pronoun-referent case) keeps its language.
  if (spec.languages && !spec.languages.includes(language)) { language = spec.languages[0]; if (mode === 'mixed') mode = language; }
  const specs = [spec];
  if (spec.contrast) { const contrast = spec.contrast(); if (contrast) specs.push(contrast); }
  const rows = [];
  for (const [specIndex, s] of specs.entries()) {
    const count = s.paraphrases ?? 1;
    const seenTexts = new Set();
    for (let p = 0; p < count; p++) {
      const clauseLanguage = mode === 'mixed' && (s.plan.clauses ?? []).length && s.plan.question && random.chance(0.6) ? (language === 'en' ? 'ro' : 'en') : null;
      // Most other mixed Romanian rows that name a common noun switch inside the proposition (an English common noun), the rest at the edge.
      const switchValues = mode === 'mixed' && !clauseLanguage && random.chance(0.85);
      const realized = realizeCase(s, { language: clauseLanguage ?? language, questionLanguage: clauseLanguage ? language : null, random, choose, switchValues });
      let text = realized.text;
      if (seenTexts.has(text)) continue;
      // DS015 relation-phrase convention: every content word of a stated or asked relation phrase is in the message.
      const relationProblems = relationWordProblems(realized.surface, realized.text);
      if (relationProblems.length) throw Error(`${group}: ${relationProblems.join('; ')} in ${JSON.stringify(realized.text)}`);
      let code_switch = clauseLanguage ? { kind: 'clause_switch', matrix: language, embedded: clauseLanguage, inserted: [] }
        : realized.mentions.switched.length ? { kind: language === 'ro' ? 'ro_matrix_en_value' : 'en_matrix_ro_value', matrix: language, embedded: language === 'ro' ? 'en' : 'ro', inserted: [...new Set(realized.mentions.switched)], position: 'inside' } : null;
      const surfacesUsed = [...realized.mentions.seen.values(), ...[...realized.surface.stated, ...(realized.surface.query?.props ?? [])].flatMap(p => Object.keys(p.timeIso ?? {}))];
      if (mode === 'mixed' && !code_switch) {
        const kind = random.weighted([[language === 'ro' ? 'ro_matrix_en_insertion' : 'en_matrix_ro_insertion', 3], ['tag', 1]]);
        const relations = [...realized.surface.stated, ...(realized.surface.query?.props ?? [])].map(p => p.relation);
        const switched = codeSwitch(text, { matrix: language, random, kind, names: surfacesUsed, protectedTexts: relations, choose });
        if (switched) { text = switched.text; code_switch = switched.switch; }
      }
      let noise = [], noiseLevel = null;
      if (random.chance(0.3)) ({ text, ops: noise, level: noiseLevel } = addNoise(text, { language, random, surfaces: surfacesUsed, weights }));
      if (!noise.length) noiseLevel = null;
      if (!alignValues(realized.surface, text, realized.mentions.translated)) throw Error(`${group}: a role value is not in the message after noise`);
      seenTexts.add(realized.text);
      const surface = realized.surface;
      const printed = printTarget(printer, { surface });
      // Q-DATA-5: a genuinely ambiguous phrasing is formalized with every plausible reading, as accepted golds.
      const accepted = [...alternativeReadings(surface, text), ...(realized.alternatives ?? [])].map(alternative => printTarget(printer, { surface: alternative }).target);
      // Verification world: every entity of the case, with every surface actually used as an alias.
      const all = new Map();
      for (const e of [...(s.mentioned ?? []), ...(s.answers ?? []), ...(s.worldOnly ?? []), ...world.list()]) if (e?.id) all.set(e.id, e);
      const aliases = new Map();
      for (const [id, value] of realized.mentions.seen) {
        const set = aliases.get(id) ?? new Set();
        for (const surface of [value, ...(realized.mentions.all.get(id) ?? [])]) { set.add(surface); set.add(foldDiacritics(surface)); }
        const entity = all.get(id);
        if (entity?.type === 'person') { set.add(entity.short); set.add(entity.surname); }
        aliases.set(id, set);
      }
      for (const e of all.values()) if (e.type === 'person') { const set = aliases.get(e.id) ?? new Set(); set.add(e.short); aliases.set(e.id, set); }
      const predicates = [...new Set([...(s.predicates ?? []), ...s.canon.stated.map(p => p.relation), ...(s.canon.query?.where ?? []).map(w => w.relation), ...(s.facts ?? []).map(f => f.relation), ...(s.lateFacts ?? []).map(f => f.relation), ...(s.rules ?? []).flatMap(r => [...r.when, r.then].map(a => a.replace(/^not /, '').split(' ')[0]))])];
      const setup = [factWires(s.facts ?? [], 'fact'), ruleWires(s.rules ?? [])].filter(Boolean).join('\n\n');
      const late = factWires(s.lateFacts ?? [], 'late');
      const entityList = [...all.values()];
      const verificationContext = { now: NOW, language, model_visible: false,
        // Evaluation-only: the entities the message mentions (answers stay in ontology_sop and expected).
        // First-person entities ("the user") are named by pronouns, not by a mention; their aliases are the pronouns.
        entities: entityList.filter(e => realized.mentions.seen.has(e.id) || e.userAliases).map(e => ({ ...entityRecord(e, language), aliases: [...new Set([...(entityRecord(e, language).aliases), ...(e.userAliases ?? []), ...(aliases.get(e.id) ?? [])])].filter(Boolean) })),
        predicates: predicates.map(id => ({ id, args: PREDICATES[id].roles.map(([, t]) => ontologyType(t)), roles: PREDICATES[id].roles.map(([n]) => n), meaning: PREDICATES[id].gloss })) };
      const row = COMMON({
        id: `${group}_${specIndex}_${p}`, split_group_id: group, semantic_case_id: `${group}_${specIndex}`, surface_group_id: `${group}_${specIndex}_${p}`, split, language,
        question: text, family: s.family, variant: s.variant, structure_id: s.structure ?? `${s.family}:${s.variant.replace(/_(at|in|on|of|to|for)(?=_|$)/g, '')}`,
        input_mode: (s.plan.clauses ?? []).length ? 'assertions_query' : 'query_only', negative_of: specs.length > 1 ? `${group}_${1 - specIndex}` : null,
        noise, noise_level: noiseLevel, code_switch, depth: s.depth ?? null,
        surface_design: { question_frame: realized.questionFrame, discourse: realized.discourse, shape: realized.shape, form: realized.form, masked_template: maskedTemplate(text, surfacesUsed), resources: [...new Set(realized.ids)] },
        ir_skeleton: surfaceSkeleton(surface), surface_ir: surface, sop_target: printed.target, ...(accepted.length ? { sop_targets_accepted: accepted } : {}), target_format: printed.format, provisional_constructs: printed.provisional,
        verification_context: verificationContext, ontology_sop: ontology(entityList, aliases), world: worldOf(predicates, worldDir), setup_sop: setup, late_setup_sop: late,
        verification: { canonical_ir: { stated: s.canon.stated.map(stripBindings), assumed: s.canon.assumed.map(stripBindings), query: s.canon.query, constraint: s.canon.constraint },
          relation_links: realized.links.filter(l => l.construction).map(l => ({ construction: l.construction, predicate: l.canon.relation })), ambiguous_mention: s.ambiguousMention ?? null, answers: (s.answers ?? []).map(e => e.id) },
        question_type: realized.qtype,
        lineage: { inspired_by: s.inspired_by, family: s.family, variant: s.variant, ...(s.anchor ? { anchor: s.anchor } : {}) },
        source: { kind: 'generator_composed_scenario', revision: GENERATOR_REVISION },
        rights: rowRights(s.inspired_by ?? []),
      });
      const idOfSurface = new Map([...realized.mentions.all].flatMap(([id, texts]) => [...texts].map(text => [text, id])));
      row.verification.link_problems = linkCheck(row, surface, idOfSurface, s.ambiguousMention);
      // Data QA: execute the model target itself, exactly as printed: the host normalizes the time expressions and
      // resolves quoted filter literals (DS014), so no value is substituted. The ISO values stay recorded for review.
      const timeMap = Object.assign({}, ...[...surface.stated, ...surface.assumed, ...(surface.query?.props ?? [])].map(p => p.timeIso ?? {}));
      const executable = printed.target;
      row.verification.time_normalization = timeMap;
      if (execute && (surface.query || surface.constraint || surface.stated.length)) {
        // `expected` is what the whole target produces (for two questions: the last query's packet, as the
        // evaluator observes it); each question is also executed alone to check the family's intended status.
        const result = await executeTarget(row, executable, { shared: SHARED });
        let intendedStatus = result.status;
        if (surface.moreQueries) {
          const first = await executeTarget(row, executable.split('\n\n@q2 query')[0] + '\n', { shared: SHARED });
          const second = await executeTarget(row, printTarget(printer, { surface: { ...surface, query: surface.moreQueries[0], moreQueries: [] } }).target, { shared: SHARED });
          intendedStatus = first.status;
          row.expected_by_query = { q: { status: first.status, answers: first.answers ?? [] }, q2: { status: second.status, answers: second.answers ?? [] } };
          if (second.status !== s.expect2) row.verification.second_query_disagreement = { intended: s.expect2, observed: second.status };
        }
        row.expected = { status: result.status, answers: result.answers ?? [], ...(result.count !== undefined ? { count: result.count } : {}) };
        row.execution = { status: intendedStatus, executed: true, target: 'sop_target', intended: s.expect,
          agrees_with_intended: s.expect === null || s.expect === 'stated' ? result.status !== 'error' : intendedStatus === s.expect, ...(result.error ? { error: result.error } : {}) };
      } else row.expected = { status: s.expect, ...(surface.unclear ? { unclear_kind: surface.unclear.kind } : {}) };
      rows.push(row);
    }
  }
  return rows;
}
/**
 * Link the surface IR back to the verification world with the host's own lexicon code: every relation phrase
 * must link to the predicate of its construction and every quoted value must resolve to the entity it names
 * (or be ambiguous exactly where the case intends it). Returns a list of problems (empty = linkable).
 */
function linkCheck(row, surface, idOfSurface, ambiguousMention) {
  const problems = [];
  let lexicon;
  const full = rowWorld(row, { shared: SHARED }).ontology;
  if (!full.trim()) return [];
  try { lexicon = new Lexicon(full); } catch (error) { return [`lexicon: ${error.message}`]; }
  // Interpretation assumptions ("mean", "refer to") are reported, never linked (DS014 report policy).
  const props = [...surface.stated.map(p => [p, true]), ...surface.assumed.filter(p => !p.meta).map(p => [p, true]), ...(surface.query?.props ?? []).map(p => [p, false]), ...(surface.query?.scope ?? []).map(p => [p, false]), ...(surface.moreQueries ?? []).flatMap(q => [...q.props, ...(q.scope ?? [])]).map(p => [p, false])];
  for (const [p, exact] of props) {
    if (p.link && typeof linking.linkRelation === 'function') {
      // A query's `role time ?t` is the host span when the predicate declares no time role (DS014).
      const roles = p.roles.filter(([role, value]) => exact || !(role === 'time' && value.startsWith('?'))).map(([role]) => role);
      const linked = linking.linkRelation(p.relation, roles, lexicon, { exact });
      if (linked.status !== 'bound' || linked.id !== p.link.predicate) problems.push(`relation ${JSON.stringify(p.relation)} [${p.roles.map(([r]) => r)}] -> ${linked.status}${linked.id ? ' ' + linked.id : ''}, want ${p.link.predicate}`);
    }
    for (const [role, value] of p.roles) {
      if (!value.startsWith('"')) continue;
      // Amounts, clock times and other values written as strings (C11) are values, not entity mentions.
      if (/^"\d/.test(value)) continue;
      const text = JSON.parse(value);
      const resolved = lexicon.resolve(text, { language: row.language, kind: 'entity' });
      if (ambiguousMention && (text === ambiguousMention || (ambiguousMention === '*shared*' && resolved.status === 'ambiguous'))) { if (resolved.status !== 'ambiguous') problems.push(`${role} ${value} should be ambiguous, is ${resolved.status}`); continue; }
      const want = idOfSurface.get(text) ?? idOfSurface.get(foldDiacritics(text)) ?? [...idOfSurface].find(([surfaceText]) => surfaceText.toLowerCase() === text.toLowerCase() || foldDiacritics(surfaceText).toLowerCase() === foldDiacritics(text).toLowerCase())?.[1];
      if (resolved.status !== 'bound' || (want && resolved.id !== want)) problems.push(`${role} ${value} -> ${resolved.status}${resolved.id ? ' ' + resolved.id : ''}${want ? ', want ' + want : ''}`);
    }
  }
  return problems;
}
const stripBindings = p => { const { bindings, ...rest } = p; return rest; };

// ---------------------------------------------------------------- long messages (DS015 "Long messages")
/** Folded relation phrases each predicate declares in the shared world (both orientations). */
const PHRASES_OF = (() => {
  const out = new Map();
  for (const [oriented, block] of SHARED.predicates) {
    const id = oriented.replace(/__converse$/, '');
    const set = out.get(id) ?? new Set();
    for (const m of block.matchAll(/^\s+(?:label|alias)\s+[a-z]{2}\s+("(?:\\.|[^"\\])*")/gm)) set.add(foldDiacritics(JSON.parse(m[1])).toLowerCase());
    out.set(id, set);
  }
  return out;
})();
const phraseConflict = (a, b) => [...(PHRASES_OF.get(a) ?? [])].some(phrase => PHRASES_OF.get(b)?.has(phrase));
/** Families whose cases a long message composes: one proposition group and at most one question each. */
const LONG_PARTS = {
  main: { statements: ['statement_only', 'statement_only', 'attached'], questions: ['lookup', 'wh_select', 'count', 'attached', 'negation', 'time_question', 'where_question', 'claim_check', 'filter', 'temporal', 'closure_assumption', 'world_assumption', 'how_question', 'why_question'] },
  ood: { statements: ['statement_only', 'statement_only', 'attached'], questions: ['lookup', 'wh_select', 'count', 'attached', 'negation', 'time_question', 'claim_check', 'filter'] },
};
/**
 * A long message: statement parts, then question parts, each realized independently (its own construction,
 * frame, noise), grouped into paragraphs with chit-chat, a list digression and a lead-in before the questions.
 * The target concatenates the parts' `stated` and `assumed` wires and prints one query wire per question
 * (`@q`, `@q2`, …). Each query is also executed alone, with every statement of the message, and must agree with
 * its part's intended status.
 */
async function longRows({ group, split, language, mode, random, choose, world, weights, execute, printer, worldDir, pool }) {
  const menu = LONG_PARTS[pool === 'main' ? 'main' : 'ood'];
  const other = language === 'en' ? 'ro' : 'en';
  const targetLength = lengthTarget(random);
  const wantQueries = 2 + random.int(5);
  const parts = [];
  let length = 0, queries = 0, assumedParts = 0, switched = false;
  const usedPredicates = new Set(), usedSurfaces = new Map(), usedEntities = new Map();
  // Like any row, about 30% of long messages are noisy; a noisy one has light typing noise in some of its parts.
  const noisyRow = random.chance(0.3);
  for (let attempt = 0; attempt < 200 && (length < targetLength || queries < wantQueries) && parts.length < 60; attempt++) {
    const needQuestion = queries < wantQueries && (length >= targetLength * 0.6 || random.chance(0.25));
    const family = random.pick(needQuestion ? menu.questions : menu.statements);
    let spec;
    try { spec = FAMILIES[family]({ random, world }); } catch { continue; }
    if (!spec?.plan || spec.asUnclear || spec.plan.question2 || spec.plan.question?.customNumbers || spec.plan.question?.custom && spec.plan.assumed?.length) continue;
    if ((spec.plan.question && !needQuestion) || (spec.plan.assumed?.length && assumedParts >= 2)) continue;
    const partLanguage = spec.languages && !spec.languages.includes(language) ? null : mode === 'mixed' && random.chance(0.3) ? other : language;
    if (!partLanguage || (spec.languages && !spec.languages.includes(partLanguage))) continue;
    let realized;
    try { realized = realizeCase(spec, { language: partLanguage, questionLanguage: null, random, choose }); } catch { continue; }
    if (relationWordProblems(realized.surface, realized.text).length) continue;
    // Two predicates that share a relation phrase ("go to": studies_at and attended) would make linking ambiguous.
    const partPredicates = new Set([...(spec.predicates ?? []), ...spec.canon.stated.map(p => p.relation), ...(spec.canon.query?.where ?? []).map(w => w.relation)]);
    if ([...partPredicates].some(id => [...usedPredicates].some(other => other !== id && phraseConflict(id, other)))) continue;
    // Entities of this part (anything its case refers to); a surface shared with an entity of an earlier part
    // (pools run out in a long message: a second "Baia Mare", a second "Chloe") would make resolution ambiguous.
    const specText = JSON.stringify({ facts: spec.facts, lateFacts: spec.lateFacts, canon: spec.canon, mentioned: spec.mentioned, answers: spec.answers, worldOnly: spec.worldOnly });
    const partEntities = world.list().filter(e => specText.includes(`"${e.id}"`));
    const surfacesOf = e => [e.labels?.en, e.labels?.ro, e.short, e.surname, ...Object.values(e.sharedAlias ?? {})].filter(Boolean).map(text => foldDiacritics(text).toLowerCase().replace(/^the /, ''));
    // A surface that equals, or occurs as whole words inside, a surface of another entity ("Baia Mare" inside
    // "the tax office in Baia Mare") would make resolution ambiguous as well.
    const contains = (outer, inner) => ` ${outer} `.includes(` ${inner} `);
    const clash = (surface, id) => [...usedSurfaces].some(([other, owner]) => owner !== id && (contains(other, surface) || contains(surface, other)));
    if (partEntities.some(e => surfacesOf(e).some(surface => clash(surface, e.id)))) continue;
    for (const e of partEntities) { surfacesOf(e).forEach(surface => usedSurfaces.set(surface, e.id)); usedEntities.set(e.id, e); }
    partPredicates.forEach(id => usedPredicates.add(id));
    let text = realized.text, noise = [];
    const surfacesUsed = [...realized.mentions.seen.values()];
    if (noisyRow && random.chance(0.4)) ({ text, ops: noise } = addNoise(text, { language: partLanguage, random, surfaces: surfacesUsed, weights, level: 'light' }));
    if (!alignValues(realized.surface, text, realized.mentions.translated)) continue;
    if (partLanguage !== language) switched = true;
    parts.push({ spec, realized, text, noise, language: partLanguage, question: Boolean(realized.surface.query) });
    length += text.length + 1;
    if (realized.surface.query) queries++;
    if (realized.surface.assumed.length) assumedParts++;
  }
  if (!queries) throw Error(`${group}: a long message needs at least one question`);
  // Statements first, then the questions; chit-chat, a list and a lead-in are interleaved as their own sentences.
  const statementParts = parts.filter(part => !part.question), questionParts = parts.filter(part => part.question);
  const paragraphs = [];
  let current = [random.pick(CHITCHAT[language])];
  for (const part of statementParts) {
    current.push(part.text);
    if (random.chance(0.15)) current.push(random.pick(CHITCHAT[part.language]));
    if (current.length >= 3 + random.int(4)) { paragraphs.push(current.join(' ')); current = []; }
  }
  if (current.length) paragraphs.push(current.join(' '));
  if (random.chance(0.35)) paragraphs.push(listDigression(random, language));
  const lead = random.pick(QUESTION_LEADS[language]);
  const questionBlock = questionParts.map(part => part.text);
  paragraphs.push([...(lead ? [lead] : []), ...questionBlock].join(random.chance(0.4) ? '\n' : ' '));
  if (random.chance(0.5)) paragraphs.push(random.pick(SIGNOFFS[language]));
  const message = paragraphs.join('\n\n');
  const ordered = [...statementParts, ...questionParts];
  const surface = { ...emptySurface(), stated: ordered.flatMap(part => part.realized.surface.stated), assumed: ordered.flatMap(part => part.realized.surface.assumed) };
  const queryList = questionParts.map(part => part.realized.surface.query);
  surface.query = queryList[0];
  if (queryList.length > 1) surface.moreQueries = queryList.slice(1);
  const printed = printTarget(printer, { surface });
  // Verification world: the union of the parts' worlds.
  const all = new Map(), aliases = new Map();
  for (const part of ordered) for (const e of [...(part.spec.mentioned ?? []), ...(part.spec.answers ?? []), ...(part.spec.worldOnly ?? [])]) if (e?.id) all.set(e.id, e);
  for (const e of usedEntities.values()) all.set(e.id, e);
  for (const part of ordered) for (const [id, value] of part.realized.mentions.seen) {
    const set = aliases.get(id) ?? new Set();
    for (const text of [value, ...(part.realized.mentions.all.get(id) ?? [])]) { set.add(text); set.add(foldDiacritics(text)); }
    const entity = all.get(id);
    if (entity?.type === 'person') { set.add(entity.short); set.add(entity.surname); }
    aliases.set(id, set);
  }
  for (const e of all.values()) if (e.type === 'person') { const set = aliases.get(e.id) ?? new Set(); set.add(e.short); aliases.set(e.id, set); }
  const specs = ordered.map(part => part.spec);
  const predicates = [...new Set(specs.flatMap(s => [...(s.predicates ?? []), ...s.canon.stated.map(p => p.relation), ...(s.canon.query?.where ?? []).map(w => w.relation), ...(s.facts ?? []).map(f => f.relation), ...(s.lateFacts ?? []).map(f => f.relation), ...(s.rules ?? []).flatMap(r => [...r.when, r.then].map(a => a.replace(/^not /, '').split(' ')[0]))]))];
  const setup = [factWires(specs.flatMap(s => s.facts ?? []), 'fact'), ruleWires(specs.flatMap(s => s.rules ?? []))].filter(Boolean).join('\n\n');
  const late = factWires(specs.flatMap(s => s.lateFacts ?? []), 'late');
  const entityList = [...all.values()];
  const seen = new Map(ordered.flatMap(part => [...part.realized.mentions.seen]));
  const noise = ordered.flatMap(part => part.noise);
  const row = COMMON({
    id: `${group}_0_0`, split_group_id: group, semantic_case_id: `${group}_0`, surface_group_id: `${group}_0_0`, split, language, question: message,
    family: 'long_message', variant: `${ordered.length}_parts_${queryList.length}_questions`, structure_id: 'long_message:composed', input_mode: 'assertions_query', negative_of: null,
    noise, noise_level: noise.length ? 'light' : null, code_switch: switched ? { kind: 'clause_switch', matrix: language, embedded: other, inserted: [] } : null, depth: null,
    surface_design: { question_frame: 'long_message', discourse: 'composed', shape: 'long_composed', form: 'composed', masked_template: maskedTemplate(message, [...seen.values()]),
      resources: [...new Set(ordered.flatMap(part => part.realized.ids))], parts: ordered.map(part => ({ family: part.spec.family, variant: part.spec.variant, language: part.language, question: part.question })) },
    ir_skeleton: surfaceSkeleton(surface), surface_ir: surface, sop_target: printed.target, target_format: printed.format, provisional_constructs: printed.provisional,
    verification_context: { now: NOW, language, model_visible: false,
      entities: entityList.filter(e => seen.has(e.id)).map(e => ({ ...entityRecord(e, language), aliases: [...new Set([...(entityRecord(e, language).aliases), ...(aliases.get(e.id) ?? [])])].filter(Boolean) })),
      predicates: predicates.map(id => ({ id, args: PREDICATES[id].roles.map(([, t]) => ontologyType(t)), roles: PREDICATES[id].roles.map(([n]) => n), meaning: PREDICATES[id].gloss })) },
    ontology_sop: ontology(entityList, aliases), world: worldOf(predicates, worldDir), setup_sop: setup, late_setup_sop: late,
    verification: { canonical_ir: { parts: specs.map(s => ({ family: s.family, stated: s.canon.stated.map(stripBindings), assumed: s.canon.assumed.map(stripBindings), query: s.canon.query })) },
      relation_links: ordered.flatMap(part => part.realized.links.filter(l => l.construction).map(l => ({ construction: l.construction, predicate: l.canon.relation }))), ambiguous_mention: null, answers: specs.flatMap(s => (s.answers ?? []).map(e => e.id)) },
    question_type: queryList.length > 1 ? 'multi' : questionParts[0].realized.qtype,
    lineage: { inspired_by: ['qqp', ...new Set(specs.flatMap(s => s.inspired_by ?? []))].filter((v, i, a) => a.indexOf(v) === i), family: 'long_message', variant: `${ordered.length}_parts` },
    source: { kind: 'generator_composed_scenario', revision: GENERATOR_REVISION },
    rights: rowRights([...new Set(specs.flatMap(s => s.inspired_by ?? []))]),
  });
  const idOfSurface = new Map(ordered.flatMap(part => [...part.realized.mentions.all].flatMap(([id, texts]) => [...texts].map(text => [text, id]))));
  row.verification.link_problems = linkCheck(row, surface, idOfSurface, null);
  row.verification.time_normalization = Object.assign({}, ...[...surface.stated, ...surface.assumed, ...queryList.flatMap(q => q.props)].map(p => p.timeIso ?? {}));
  if (execute) {
    const result = await executeTarget(row, printed.target, { shared: SHARED });
    row.expected = { status: result.status, answers: result.answers ?? [], ...(result.count !== undefined ? { count: result.count } : {}) };
    // Each question alone, with every statement of the message, must give its part's intended status.
    const byQuery = {}, disagreements = [];
    for (const [index, part] of questionParts.entries()) {
      const single = printTarget(printer, { surface: { ...surface, query: part.realized.surface.query, moreQueries: [] } }).target;
      const observed = await executeTarget(row, single, { shared: SHARED });
      byQuery[index ? `q${index + 1}` : 'q'] = { status: observed.status, answers: observed.answers ?? [] };
      const intended = part.spec.expect;
      if (observed.status === 'error' || (intended && intended !== 'stated' && observed.status !== intended)) disagreements.push({ query: index ? `q${index + 1}` : 'q', intended, observed: observed.status });
    }
    row.expected_by_query = byQuery;
    if (disagreements.length) row.verification.query_disagreements = disagreements;
    row.execution = { status: result.status, executed: true, target: 'sop_target', intended: null, agrees_with_intended: result.status !== 'error' && !disagreements.length, ...(result.error ? { error: result.error } : {}) };
  } else row.expected = { status: null };
  return [row];
}
