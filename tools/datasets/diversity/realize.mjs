/** Surface realization: canonical propositions → message text AND the string propositions the model writes.
 *
 * Every proposition is realized through one construction of the lexicon (domains.mjs); the construction fixes
 * the relation phrase and which closed role (subject, object, location, ...) each surface position fills. The
 * realizer returns both the text and the string proposition, so the target always quotes exactly what the
 * message says. Every choice goes through `choose(kind, options)` (balanced usage, split partitions).
 */
import { PREDICATES, orientedPredicate } from './domains.mjs';

import { surfaceOf } from './entities.mjs';
const mapValues = (object, f) => Object.fromEntries(Object.entries(object).map(([k, v]) => [k, f(v)]));
import { YES_NO, WH, CLAIM_CHECK, DISCOURSE, JOINERS, MONTHS, TIME_FRAMES, WHY_FRAMES } from './frames.mjs';
import { capitalize } from './text.mjs';
import { COMMON_NOUN_TYPES, RO_CONSTRUCTION_EN, englishDate, targetValue } from './english.mjs';

/** Fill {S}/{O} and {g:S|O:masc:fem} slots. */
export function fillTemplate(template, names, genders) {
  return template
    .replace(/\{g:([A-Za-z_]+):([^:}]*):([^}]*)\}/g, (_, slot, masc, fem) => (genders[slot] === 'f' ? fem : masc))
    .replace(/\{([A-Za-z_]+)\}/g, (match, slot) => (slot in names ? names[slot] : match));
}

const lowerFirst = text => text && !/^(I|I'm|I'd|I've)\b/.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
const stripEnd = text => text.replace(/[.?!]+$/, '');
export const tidy = text => text.replace(/\s+([,.?!;:])/g, '$1').replace(/\s{2,}/g, ' ').replace(/([?!.])\1+/g, '$1').replace(/\(\s+/g, '(').trim();
export const quote = text => JSON.stringify(text);

// ---------------------------------------------------------------- dates and time adverbials
const pad = n => String(n).padStart(2, '0');
/** A date as a user writes it; `format` (an option index) keeps both ends of one range in the same format. */
export function renderDate(iso, language, random, format = null) {
  const [y, m, d] = iso.split('-').map(Number);
  const month = MONTHS[language][m - 1];
  const ordinal = [1, 21, 31].includes(d) ? 'st' : [2, 22].includes(d) ? 'nd' : [3, 23].includes(d) ? 'rd' : 'th';
  const options = language === 'ro'
    ? [[`${d} ${month} ${y}`, 6], [`${pad(d)}.${pad(m)}.${y}`, 2], [month.length > 4 ? `${d} ${month.slice(0, 3)}. ${y}` : `${d} ${month} ${y}`, 1]]
    : [[`${d} ${month} ${y}`, 4], [`${month} ${d}, ${y}`, 3], [iso, 1], [`the ${d}${ordinal} of ${month} ${y}`, 1]];
  const index = format ?? random.weighted(options.map((option, i) => [i, option[1]]));
  return options[Math.min(index, options.length - 1)][0];
}

/**
 * Time adverbial for a proposition time {valid|on|from|until} or a query time {at|during}. Returns
 * {text, valid: {on|from|until: "as written"}, query: {at|during: "as written"}} or null for timeless / now.
 */
export function timePhrase(time, language, random) {
  if (!time || time.valid === 'timeless' || time.at === 'now') return null;
  // One format per phrase: "between 2019-05-01 and July 1, 2022" mixes two.
  const format = random.weighted((language === 'ro' ? [6, 2, 1] : [4, 3, 1, 1]).map((weight, i) => [i, weight]));
  const date = iso => renderDate(iso, language, random, format);
  // The target writes dates in English whatever the message language (english.mjs, Q-DATA-6).
  const target = (iso, written) => language === 'en' ? written : englishDate(iso);
  const ro = language === 'ro';
  const from = time.from ?? time.during?.[0], until = time.until ?? time.during?.[1];
  const isYear = from?.endsWith('-01-01') && until?.endsWith('-01-01') && Number(until.slice(0, 4)) === Number(from.slice(0, 4)) + 1;
  if (time.on || time.at) {
    const d = date(time.on ?? time.at), t = target(time.on ?? time.at, d);
    return { text: ro ? random.pick([`pe ${d}`, `la data de ${d}`, `în ziua de ${d}`]) : random.pick([`on ${d}`, `on ${d}`, `as of ${d}`]), valid: { on: t }, query: { at: t }, iso: { [t]: time.on ?? time.at } };
  }
  if (isYear) {
    const y = from.slice(0, 4);
    return { text: ro ? random.pick([`în ${y}`, `în anul ${y}`, `pe parcursul lui ${y}`]) : random.pick([`in ${y}`, `during ${y}`, `at some point in ${y}`]), valid: { on: y }, query: { during: y }, iso: { [y]: y } };
  }
  if (from && until) {
    const a = date(from), b = date(until), ta = target(from, a), tb = target(until, b);
    return { text: ro ? random.pick([`din ${a} până pe ${b}`, `între ${a} și ${b}`, `de la ${a} până la ${b}`]) : random.pick([`from ${a} until ${b}`, `between ${a} and ${b}`, `from ${a} to ${b}`]), valid: { from: ta, until: tb }, query: { during: `${ta} – ${tb}` }, iso: { [ta]: from, [tb]: until } };
  }
  if (from) { const a = date(from), ta = target(from, a); return { text: ro ? random.pick([`din ${a}`, `începând cu ${a}`]) : random.pick([`since ${a}`, `from ${a} on`, `starting ${a}`]), valid: { from: ta }, query: { at: ta }, iso: { [ta]: from } }; }
  if (until) { const b = date(until), tb = target(until, b); return { text: ro ? random.pick([`până pe ${b}`, `până la ${b}`]) : random.pick([`until ${b}`, `up to ${b}`]), valid: { until: tb }, query: { at: tb }, iso: { [tb]: until } }; }
  return null;
}

// ---------------------------------------------------------------- mentions: surfaces, styles and pronouns
const PRONOUN = { en: { S: { f: 'she', m: 'he', n: 'it' }, O: { f: 'her', m: 'him', n: 'it' } } };
/** Tracks how each entity was first mentioned, so later mentions stay consistent or become pronouns. */
/**
 * `seen` holds the first surface of each entity in the message; `values` its target value: the surface as
 * written for a proper name, the English label for a common noun mentioned in Romanian (english.mjs, Q-DATA-6).
 * `translated` collects the target values that are translations, so value alignment does not look for them in
 * the message.
 */
export class Mentions {
  constructor(language, random, styles = {}) { this.language = language; this.random = random; this.styles = { ...styles }; this.seen = new Map(); this.all = new Map(); this.values = new Map(); this.translated = new Set(); this.switched = []; this.switchedIds = new Set(); this.switchValues = false; }
  surface(entity, { slot = 'S', pronoun = false, language = this.language } = {}) {
    if (!entity || entity.id?.startsWith('?')) return null;
    if (pronoun && this.seen.has(entity.id) && language === 'en') return { text: PRONOUN.en[slot][entity.type === 'person' ? entity.gender : 'n'] ?? 'they', value: this.values.get(entity.id), pronoun: true };
    if (pronoun && this.seen.has(entity.id) && language === 'ro' && slot === 'S') return { text: '', value: this.values.get(entity.id), pronoun: true };
    const style = this.styles[entity.id] ?? (entity.type === 'person' ? this.random.weighted(language === 'ro' ? [['short', 7], ['full', 3]] : [['short', 7], ['full', 2], ['title', 1]]) : 'short');
    this.styles[entity.id] = style;
    let text = surfaceOf(entity, language, style);
    let value = targetValue(entity, text, language);
    // Inside-proposition code switch: the English noun without its article, the English label as the value.
    // An English clause may likewise name it in Romanian ("Ion teaches chimie"); the value stays English.
    if (this.switchValues && COMMON_NOUN_TYPES.has(entity.type) && entity.labels.ro !== entity.labels.en && (this.switchedIds.has(entity.id) || (!this.seen.has(entity.id) && this.random.chance(0.85)))) {
      text = language === 'ro' ? entity.labels.en.replace(/^(the|a|an) /i, '') : entity.labels.ro;
      value = entity.labels.en;
      this.switched.push(text);
      this.switchedIds.add(entity.id);
    }
    if (value !== text) this.translated.add(value);
    if (!this.seen.has(entity.id)) { this.seen.set(entity.id, text); this.values.set(entity.id, value); }
    // Every surface used for an entity (a code-switched message may name it once per language).
    if (!this.all.has(entity.id)) this.all.set(entity.id, new Set());
    this.all.get(entity.id).add(text);
    return { text, value, pronoun: false };
  }
}

// ---------------------------------------------------------------- constructions
const hasForm = (c, key) => Array.isArray(c.forms[key]) && c.forms[key].length > 0;
/** Closed role of the domain role `role` in construction `c`. */
export const closedRoleOf = (c, role) => role === c.S ? 'subject' : role === c.O ? c.Orole : null;

/**
 * Realize one canonical proposition {relation, bindings, polarity, time} with a form key: s|n|sp|np|q|nq|qp|nqp
 * or wh/emb/cnt focused on a domain role. Returns {text, prop (string proposition), ids}.
 */
export function realizeProposition(canon, { key, focus = null, language, random, choose, mentions, pronoun = false, time = canon.time, variable = '?x', constructionFilter = null, asQuery = false, split = false, rewrite = null }) {
  const spec = PREDICATES[canon.relation];
  const wanted = c => {
    if (constructionFilter && !constructionFilter(c)) return null;
    if (!focus) return key;
    const position = focus === c.S ? 'S' : focus === c.O ? 'O' : null;
    return position ? `${key}${position}` : null;
  };
  // `split` needs a template that starts with the subject slot; `rewrite` maps a template to another form or null.
  const usable = text => (!split || text.startsWith('{S} ')) && (!rewrite || rewrite(text) !== null);
  const options = spec[language].map(c => ({ id: `${canon.relation}.${c.id}`, c, form: wanted(c) })).filter(o => o.form && hasForm(o.c, o.form) && o.c.forms[o.form].some(usable));
  if (!options.length) return null;
  const chosen = choose(`construction:${canon.relation}:${language}:${key}${focus ? ':' + focus : ''}`, options);
  // A split may have no usable construction here (every option is reserved for another partition).
  if (!chosen) return null;
  const c = chosen.c;
  const template = choose(`form:${chosen.id}:${chosen.form}`, c.forms[chosen.form].map((text, index) => ({ id: `${chosen.id}.${chosen.form}.${index}`, text })).filter(t => usable(t.text)));
  if (rewrite) template.text = rewrite(template.text);
  const names = {}, genders = {}, values = {};
  for (const [slot, role] of [['S', c.S], ['O', c.O]]) {
    if (!role) continue;
    const filler = canon.bindings[role];
    if (!filler || filler.id?.startsWith('?')) { values[slot] = filler?.id ?? variable; continue; }
    const mention = mentions.surface(filler, { slot, pronoun: pronoun && slot === 'S', language });
    names[slot] = mention.text;
    values[slot] = quote(mention.value);
    genders[slot] = filler.gender;
  }
  const phrase = timePhrase(time, language, random);
  // Romanian genitive of a titled name: "copilul lui doamna X" is "copilul doamnei X" (the value no longer matches
  // the mention, so such a realization is dropped by the value alignment; the title style is rare in Romanian).
  let text = fillTemplate(template.text, names, genders);
  if (language === 'ro') text = text.replace(/\blui doamna /g, 'doamnei ').replace(/\blui domnul /g, 'domnului ');
  const parts = split ? { subject: names.S, rest: tidy(fillTemplate(template.text.slice(4), names, genders)), inverted: invertRo(template.text, names, genders) } : null;
  const questionLike = asQuery || /^(wh|cnt|emb|q|nq)/.test(key);
  if (phrase) text = `${text} ${phrase.text}`;
  const roles = [['subject', values.S]];
  if (c.O) roles.push([c.Orole, values.O]);
  // The target relation phrase is English whatever the message language (english.mjs, Q-DATA-6); `source_relation`
  // keeps the message's own phrase for the relation-phrase convention check.
  const english = language === 'en' ? c.rel : RO_CONSTRUCTION_EN[chosen.id];
  if (!english) throw Error(`no English phrase for construction ${chosen.id} ("${c.rel}")`);
  const prop = { relation: english, ...(english !== c.rel ? { source_relation: c.rel } : {}), roles, polarity: canon.polarity ?? 'affirmed', ...(phrase && !questionLike ? { valid: mapValues(phrase.valid, quote) } : {}),
    ...(phrase && questionLike ? { queryTime: mapValues(phrase.query, quote) } : {}), link: { predicate: orientedPredicate(canon.relation, c.converse), converse: c.converse }, ...(phrase ? { timeIso: phrase.iso } : {}) };
  return { text: tidy(text), prop, ids: [chosen.id, template.id], construction: chosen.id, parts };
}

/**
 * Romanian direct wh-questions put the verb group before the subject: "{S} a lucrat la {O}" → "a lucrat {S} la {O}"
 * ("De câte ori a vizitat Ana Clujul?"). The verb group is an optional "nu", an auxiliary or clitic ("a", "au",
 * "s-a", "e", "a fost", "l-a"…) with the following word, or the single finite verb. Returns null when the template
 * does not start with the subject.
 */
const RO_COPULA = /^(e|este|sunt|a fost|au fost)$/;
const RO_AUX = /^(a|au|s-a|s-au|și-a|și-au|l-a|i-a|\{g:O:l-a:a\}|\{g:O:îl:o\})$/;
export function invertRo(template, names, genders) {
  if (!template.startsWith('{S} ')) return null;
  // Slots such as {g:S:angajat:angajată} contain spaces, so they are single tokens here.
  const tokens = template.slice(4).match(/\{[^}]*\}\S*|\S+/g) ?? [];
  let i = tokens[0] === 'nu' ? 1 : 0, take;
  if (RO_COPULA.test(tokens.slice(i, i + 2).join(' '))) take = i + 2;            // "a fost": the copula only
  else if (RO_COPULA.test(tokens[i] ?? '')) take = i + 1;                          // "e", "este", "sunt"
  else if (RO_AUX.test(tokens[i] ?? '') && tokens.length > i + 1) take = i + 2;   // "a vizitat", "s-a îmbolnăvit"
  else take = i + 1;                                                                // the finite verb
  const verb = tokens.slice(0, take).join(' '), rest = tokens.slice(take).join(' ');
  return tidy(fillTemplate(`${verb} {S} ${rest}`, names, genders));
}

/** A declarative clause. Timed or explicitly past propositions use past forms. */
export function statementClause(canon, options) {
  const past = options.past ?? Boolean(canon.time && canon.time.valid !== 'timeless');
  const key = canon.polarity === 'negated' ? (past ? 'np' : 'n') : (past ? 'sp' : 's');
  return realizeProposition(canon, { ...options, key }) ?? realizeProposition(canon, { ...options, key: canon.polarity === 'negated' ? 'n' : 's' });
}

/** The question sentence for a plan {ask, prop, focus, time, past, claimCheck, prefix, suffix, exclude}. */
export function questionSentence(plan, { language, random, choose, mentions, plainOnly = false }) {
  const canon = { ...plan.prop, time: plan.time ?? { valid: 'timeless' } };
  const past = plan.past ?? Boolean(plan.time && plan.time.at !== 'now');
  let core, frame, textSlots = {};
  if (plan.ask === 'whether') {
    const negated = canon.polarity === 'negated';
    const qKey = negated ? (past ? 'nqp' : 'nq') : (past ? 'qp' : 'q');
    const sKey = negated ? (past ? 'np' : 'n') : (past ? 'sp' : 's');
    const plain = plainOnly || Boolean(plan.prefix);
    frame = plan.frames ? choose(`frame:custom:${plan.frames.id}:${language}`, plan.frames[language].map((text, i) => ({ id: `${plan.frames.id}.${language}.${i}`, text, form: 'authored' })))
      : plan.claimCheck ? choose(`frame:claim:${language}`, CLAIM_CHECK[language]) : choose(`frame:yn:${language}`, // Negated propositions avoid frames whose particle or tag already carries a negation ("or not", "nu cumva", ", nu?").
      YES_NO[language].filter(option => !(negated && (option.id.includes('_or_not') || option.id.includes('sau_nu') || option.id.includes('cumva') || option.id.includes('tag'))) && (!plain || PLAIN_QUESTION_FORMS.has(option.form))));
    const usesS = /\{S\}/.test(frame.text);
    // `constructionFilter` (for example: not the phrase of a statement in the same message) is a preference.
    const realizeCore = filter => realizeProposition(canon, { key: usesS ? sKey : qKey, language, random, choose, mentions, pronoun: plan.pronoun, asQuery: true, constructionFilter: filter });
    core = (plan.constructionFilter && realizeCore(plan.constructionFilter)) || realizeCore(null);
    textSlots = usesS ? { S: core.text } : { Q: core.text };
  } else {
    // `whKey: 'where'` asks with where-forms (a location or destination role); other wh-questions use wh/cnt forms.
    const key = plan.whKey ? (past ? 'wherep' : 'where') : plan.ask === 'count' ? 'cnt' : past ? 'whp' : 'wh';
    // Embedded wh-forms are present tense only, so a past question takes a direct frame; a "besides X" lead takes
    // no frame that already opens with its own marker ("Quick one:").
    // After "Besides X," a bare wh-word reads as a relative clause about X ("Besides Ana, who teaches Spanish?"),
    // so an excluded filler takes a frame with its own lead ("Besides Ana, can you tell me who …").
    const whOptions = WH[language].filter(option => (!(plainOnly || plan.prefix) || PLAIN_QUESTION_FORMS.has(option.form)) && !(plan.ask === 'count' && option.text.includes('{E}'))
      && !(past && option.text.includes('{E}')));
    const leadOptions = plan.exclude ? whOptions.filter(option => !option.text.startsWith('{W}') && !['prefixed', 'colloquial'].includes(option.form)) : whOptions;
    frame = choose(`frame:wh:${language}`, leadOptions.length ? leadOptions : whOptions);
    const embedded = /\{E\}/.test(frame.text) && plan.ask !== 'count';
    const variable = plan.variable ?? '?x';
    const embKey = plan.whKey ? (past ? 'wherepemb' : 'whereemb') : 'emb';
    core = realizeProposition(canon, { key: embedded ? embKey : key, focus: plan.focus, language, random, choose, mentions, pronoun: plan.pronoun, asQuery: true, variable })
      ?? realizeProposition(canon, { key, focus: plan.focus, language, random, choose, mentions, pronoun: plan.pronoun, asQuery: true, variable });
    textSlots = { W: core.text, E: core.text };
  }
  let text = frame.text.replace(/\{([QSWE])\}/g, (_, slot) => textSlots[slot] ?? '');
  const literalStart = !frame.text.startsWith('{');
  if (plan.exclude) {
    const x = mentions.surface(plan.exclude, { language });
    const pattern = choose(`filter:${language}`, (language === 'ro' ? ['În afară de {X}, ', 'Pe lângă {X}, ', 'Fără să-l pun la socoteală pe {X}, '] : ['Besides {X}, ', 'Apart from {X}, ', 'Other than {X}, ', 'Not counting {X}, ']).map((p, i) => ({ id: `filter.${language}.${i}`, text: p })));
    const lead = plan.exclude.gender === 'f' ? pattern.text.replace("să-l pun", "s-o pun") : pattern.text;
    text = lead.replace('{X}', x.text) + (literalStart ? lowerFirst(text) : text);
    core.filterValue = quote(x.value);
  }
  if (plan.prefix?.[language]) text = `${plan.prefix[language]} ${literalStart && !/[.!?:]$/.test(plan.prefix[language]) ? lowerFirst(text) : text}`;
  if (plan.prefix?.[language] && /[.!?]$/.test(plan.prefix[language])) { const at = plan.prefix[language].length + 1; text = text.slice(0, at) + capitalize(text.slice(at)); }
  const raw = tidy(text);
  const inner = plan.prefix?.[language] || plan.exclude || !literalStart ? raw : lowerFirst(raw);
  return { text: capitalize(raw), inner, prop: core.prop, filterValue: core.filterValue ?? null, ids: [...core.ids, frame.id], frame: frame.id, form: frame.form ?? 'claim_check' };
}

/** Join several assertion clauses into one sentence. */
export function joinClauses(clauses, { language, choose, inline = false }) {
  let text = clauses[0];
  const ids = [];
  for (const next of clauses.slice(1)) {
    // "…, iar nu este …" is not Romanian for "but not": a negated clause takes another joiner.
    const negatedNext = /^(nu|n-)/i.test(next.trim());
    const joiner = choose(`join:${language}:${inline}`, JOINERS[language].filter(j => (!inline || !j.text.includes('.')) && !(negatedNext && j.notBeforeNegation)));
    ids.push(joiner.id);
    text = joiner.text.replace('{x}', text).replace('{y}', next);
  }
  return { text, ids };
}

/** Assemble the message: assertion clauses + question with a discourse frame that matches certainty/speaker. */
/** Choose the discourse frame first, so the question can adapt: no pronoun before its antecedent, and only
 * plain question frames inside a frame that embeds the question after a clause ("Given that …, {z}"). */
export function chooseDiscourse({ certainty = 'asserted', speaker = null, language, choose, statementFirst = false }) {
  const first = option => Math.min(...['{A}', '{a}'].map(t => option.text.indexOf(t)).filter(i => i >= 0)) < Math.min(...['{Z}', '{z}'].map(t => option.text.indexOf(t)).filter(i => i >= 0));
  const options = DISCOURSE[language].filter(option => option.certainty === certainty && Boolean(option.speaker) === Boolean(speaker) && (!statementFirst || first(option)));
  const frame = choose(`discourse:${language}:${certainty}:${speaker ? 'speaker' : 'user'}`, options);
  const q = Math.min(...['{Z}', '{z}'].map(t => frame.text.indexOf(t)).filter(i => i >= 0));
  const a = Math.min(...['{A}', '{a}'].map(t => frame.text.indexOf(t)).filter(i => i >= 0));
  return { frame, questionFirst: q < a, embedsQuestion: frame.text.includes('{z}') };
}
export const PLAIN_QUESTION_FORMS = new Set(['yes_no', 'wh', 'declarative_question', 'particle', 'is_it_true', 'embedded_question', 'request_embedded', 'claim_check', 'authored']);

export function assembleMessage({ clauses, question, certainty = 'asserted', speaker = null, language, choose, discourse = null }) {
  if (!clauses.length) return { text: question.text, ids: [], discourse: 'question_only', shape: 'single_question' };
  const frame0 = question ? (discourse?.frame ?? null) : null;
  const joined = joinClauses(clauses, { language, choose, inline: Boolean(frame0 && frame0.text.includes('{a}')) });
  if (!question) return { text: tidy(capitalize(stripEnd(joined.text)) + '.'), ids: joined.ids, discourse: 'statement_only', shape: 'statement_only' };
  const frame = discourse?.frame ?? chooseDiscourse({ certainty, speaker, language, choose }).frame;
  const a = stripEnd(joined.text);
  const A = capitalize(a) + '.';
  const text = frame.text.replace('{A}', A).replace('{a}', a).replace('{Z}', question.text).replace('{z}', question.inner ?? question.text).replace('{P}', speaker ?? '');
  return { text: tidy(capitalize(text)), ids: [...joined.ids, frame.id], discourse: frame.id, shape: frame.shape };
}

// ---------------------------------------------------------------- question words (DS014 question forms)
// "When did Ana start to work at Acme?": the English present question core with "start to" (a start measure).
const startRewrite = text => /^does \{S\} /.test(text) ? text.replace(/^does \{S\} /, 'did {S} start to ') : /^is \{S\} /.test(text) ? text.replace(/^is \{S\} /, 'did {S} start to be ') : null;
const startClause = text => /^\{S\} (is|was) /.test(text) ? text.replace(/^\{S\} (is|was) /, '{S} be ') : null;
/**
 * A time question over a proposition: when / since when / until when / how long / how many times. The model
 * target asks for `role time ?t` (a host span); `measure` and `mode count` come from the question word.
 * Returns {text, prop, ids, frame} with the time role appended to the proposition.
 */
export function timeQuestion(plan, { language, random, choose, mentions }) {
  const frames = TIME_FRAMES[plan.kind][language];
  const frame = choose(`frame:time:${plan.kind}:${language}`, frames.filter(option => !plan.noStart || !option.start));
  const past = Boolean(frame.past);
  const canon = { ...plan.prop, time: { valid: 'timeless' } };
  const needsQ = frame.text.includes('{Q}') || frame.text.includes('{B}');
  const split = frame.text.includes('{T}') || frame.text.includes('{I}');
  let core = null;
  if (frame.start && frame.text.includes('{B}')) core = realizeProposition(canon, { key: 'q', language, random, choose, mentions, asQuery: true, rewrite: startRewrite });
  else if (frame.start) core = realizeProposition(canon, { key: 's', language, random, choose, mentions, asQuery: true, split: true, rewrite: text => { const base = realizeBase(text); return base; } });
  else core = realizeProposition(canon, { key: needsQ ? (past ? 'qp' : 'q') : (past ? 'sp' : 's'), language, random, choose, mentions, asQuery: true, split });
  if (!core) return frame.start ? timeQuestion({ ...plan, noStart: true }, { language, random, choose, mentions }) : null;
  if (frame.text.includes('{I}') && !core.parts?.inverted) return timeQuestion({ ...plan, noStart: true }, { language, random, choose, mentions });
  const text = frame.text.replace('{Q}', core.text).replace('{B}', core.text).replace('{S}', core.text).replace('{T}', core.parts?.subject ?? '').replace('{V}', core.parts?.rest ?? '').replace('{I}', core.parts?.inverted ?? '');
  const prop = { ...core.prop, roles: [...core.prop.roles, ['time', plan.variable ?? '?t']] };
  delete prop.queryTime;
  return { text: capitalize(tidy(text)), inner: tidy(text), prop, ids: [...core.ids, frame.id], frame: frame.id, form: 'time_question' };
}
// English base-form clause for "{T} started to {V}": "{S} works at {O}" -> "{S} work at {O}" is not derivable from
// the inflected template in general, so only copular clauses ("{S} is employed by") qualify, as "{S} be employed by".
function realizeBase(text) { return startClause(text); }

/** A "why" question (mode explain) over a ground proposition, possibly negated. */
export function whyQuestion(plan, { language, random, choose, mentions }) {
  const frame = choose(`frame:why:${language}`, WHY_FRAMES[language]);
  const negated = plan.prop.polarity === 'negated';
  const past = Boolean(plan.past);
  const needsQ = frame.text.includes('{Q}');
  const key = needsQ ? (negated ? (past ? 'nqp' : 'nq') : (past ? 'qp' : 'q')) : (negated ? (past ? 'np' : 'n') : (past ? 'sp' : 's'));
  const core = realizeProposition({ ...plan.prop, time: { valid: 'timeless' } }, { key, language, random, choose, mentions, asQuery: true, split: frame.text.includes('{T}') || frame.text.includes('{I}') });
  if (!core || (frame.text.includes('{I}') && !core.parts?.inverted)) return null;
  const text = frame.text.replace('{Q}', core.text).replace('{S}', core.text).replace('{T}', core.parts?.subject ?? '').replace('{V}', core.parts?.rest ?? '').replace('{I}', core.parts?.inverted ?? '');
  const prop = { ...core.prop };
  delete prop.queryTime;
  return { text: capitalize(tidy(text)), inner: tidy(text), prop, ids: [...core.ids, frame.id], frame: frame.id, form: 'why_question' };
}
