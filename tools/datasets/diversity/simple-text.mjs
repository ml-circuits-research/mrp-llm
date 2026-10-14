/** Oracle "simple text" renderer: surface IR → short simple sentences (DS015 "Simple-text rendering").
 *
 * The simple text is what a dedicated simplifier model would write in front of the symbolic UD → SOP path: the
 * message's content, normalized, one short clause per line. It is rendered deterministically from the surface IR,
 * so it is an oracle (an upper bound for the symbolic path), never model input. Conventions:
 *   - one grammatical clause per line, explicit subject–verb–object, present tense (past forms when the
 *     proposition carries a time), the message language per proposition (English, or Romanian when the
 *     proposition has a Romanian source phrase);
 *   - proper names and values exactly as in the message (a Romanian row's English common-noun label is mapped
 *     back to the alias the message uses);
 *   - one question per line; conjunctive queries continue with "And: …" / "Și: …" lines;
 *   - non-assertive status is a connective label at the start of the line: "Maybe:", "Suppose:", "<speaker>
 *     says:", "Assumption:" (Romanian "Poate:", "Să presupunem:", "<speaker> spune:", "Presupunere:"); query
 *     modifiers are labelled lines too ("Except:", "Condition:", "Rank:", "Order:", "As of:", "Group:", "Check <q>:");
 *   - chit-chat is dropped: `unclear no_request` renders as an empty text; `gibberish` keeps the message verbatim;
 *     `ambiguous` renders "Ambiguous." and one "Reading: …" line per reading.
 * The realization reuses the generator's construction forms (domains.mjs) when the proposition carries its
 * construction; otherwise a small generic conjugator is used and the line is counted in `fallbacks`.
 */
import { PREDICATES } from './domains.mjs';
import { MONTHS } from './frames.mjs';
import { GIVEN_NAMES } from './names.mjs';
import { fillTemplate, invertRo, tidy } from './realize.mjs';
import { capitalize, foldDiacritics } from './text.mjs';
import { expressionWords } from './printers.mjs';

const GENDER = new Map(GIVEN_NAMES.map(entry => [entry.name, entry.gender]));
const fold = text => foldDiacritics(String(text)).toLowerCase();
const unq = value => (typeof value === 'string' && value.startsWith('"') ? JSON.parse(value) : value);
const isVar = value => typeof value === 'string' && value.startsWith('?');

const LABELS = {
  en: { maybe: 'Maybe:', suppose: 'Suppose:', says: 'says:', thinks: 'thinks:', assumption: 'Assumption:', and: 'And:', except: 'Except:', condition: 'Condition:', rank: 'Rank:', order: 'Order:', asof: 'As of:', group: 'Group:', check: 'Check', ambiguous: 'Ambiguous.', options: 'Options:', reading: 'Reading:', number: 'Number', between: 'is between', require: 'Condition:', possible: 'Is it possible that', prove: 'Prove that', first: 'the first', second: 'the second', highest: 'highest', lowest: 'lowest', someone: 'someone', something: 'something', each: 'each one' },
  ro: { maybe: 'Poate:', suppose: 'Să presupunem:', says: 'spune:', thinks: 'crede:', assumption: 'Presupunere:', and: 'Și:', except: 'Excepție:', condition: 'Condiție:', rank: 'Clasament:', order: 'Ordine:', asof: 'Conform datelor din:', group: 'Grup:', check: 'Verifică', ambiguous: 'Ambiguu.', options: 'Variante:', reading: 'Variantă:', number: 'Numărul', between: 'este între', require: 'Condiție:', possible: 'Este posibil ca', prove: 'Demonstrează că', first: 'primul', second: 'al doilea', highest: 'cel mai mare', lowest: 'cel mai mic', someone: 'cineva', something: 'ceva', each: 'fiecare' },
};
const COMPARE = { en: { above: 'above', below: 'below', at_least: 'at least', at_most: 'at most', equal: 'equal to', not_equal: 'not equal to' }, ro: { above: 'peste', below: 'sub', at_least: 'cel puțin', at_most: 'cel mult', equal: 'egal cu', not_equal: 'diferit de' } };
const ORDER = { en: { before: 'before', after: 'after', same_time: 'at the same time as' }, ro: { before: 'înainte de', after: 'după', same_time: 'în același timp cu' } };
const QUANT = { en: { all: 'all', none: 'none', not_all: 'not all', most: 'most', half: 'half' }, ro: { all: 'toți', none: 'niciunul', not_all: 'nu toți', most: 'majoritatea', half: 'jumătate' } };
const WH_TIME = { en: { at: 'when', start: 'since when', end: 'until when', duration: 'how long' }, ro: { at: 'când', start: 'de când', end: 'până când', duration: 'cât timp' } };
const COUNT_LABEL = { en: 'Count:', ro: 'Numără:' };
const varWord = v => v.replace(/^\?/, '').replace(/\d+$/, '') || 'x';

// ---------------------------------------------------------------- construction lookup
const baseId = predicate => String(predicate ?? '').replace(/__converse$/, '');
/** The generator construction a proposition was realized with, in `language`, or null. */
function constructionOf(prop, language) {
  const spec = PREDICATES[baseId(prop.link?.predicate)];
  const phrase = language === 'ro' ? prop.source_relation : prop.relation;
  if (spec && phrase) {
    const c = spec[language]?.find(candidate => candidate.rel === phrase && candidate.forms && Object.keys(candidate.forms).length);
    if (c) return c;
  }
  // Wild golds carry no link: an English relation phrase that names exactly one construction is still usable.
  if (language === 'en' && !prop.link && prop.relation) {
    const hits = Object.values(PREDICATES).flatMap(p => p.en.filter(c => c.rel === prop.relation && c.forms && Object.keys(c.forms).length && c.O));
    const nonSubject = prop.roles.filter(([role]) => role !== 'subject');
    if (hits.length === 1 && nonSubject.length === 1 && nonSubject[0][0] === hits[0].Orole) return hits[0];
  }
  return null;
}

/** Proposition language: Romanian when it has a Romanian source phrase (or its phrase is a Romanian construction). */
function propLanguage(prop, rowLanguage) {
  if (prop.source_relation) return 'ro';
  if (rowLanguage === 'ro' && prop.relation && !prop.link) return 'en';
  return rowLanguage === 'ro' && constructionOf(prop, 'ro') ? 'ro' : 'en';
}

// ---------------------------------------------------------------- values
/** A role value as the simple text writes it: the message's own alias for a translated common noun. */
function surfaceValue(value, { language, message, entities }) {
  const text = unq(value);
  if (language !== 'ro' || !entities?.length || fold(message).includes(fold(text))) return text;
  const entity = entities.find(e => e.label === text || e.aliases?.includes(text));
  const alias = entity && [entity.label, ...(entity.aliases ?? [])].find(a => fold(message).includes(fold(a)));
  return alias ?? text;
}
const genderOf = name => GENDER.get(String(name).split(/[\s-]/)[0]) ?? 'm';

function roDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  if (!m) return String(y);
  return `${d} ${MONTHS.ro[m - 1]} ${y}`;
}
/** A time value in the proposition's language (Romanian dates rendered from the ISO map). */
function timeText(value, prop, language) {
  const text = unq(value);
  if (language !== 'ro') return text;
  const iso = prop.timeIso?.[text];
  return iso ? roDate(iso) : text;
}
function timeSuffix(prop, language) {
  const t = { ...(prop.valid ?? {}), ...(prop.queryTime ?? {}) };
  const ro = language === 'ro';
  const x = key => timeText(t[key], prop, language);
  if (t.on || t.at) { const v = x(t.on ? 'on' : 'at'); return DATE_LIKE.test(v) ? (ro ? `pe ${v}` : /^\d{4}$/.test(v) ? `in ${v}` : `on ${v}`) : v; }
  if (t.from && t.until) return ro ? `din ${x('from')} până pe ${x('until')}` : `from ${x('from')} until ${x('until')}`;
  if (t.from) return ro ? `din ${x('from')}` : `since ${x('from')}`;
  if (t.until) return ro ? `până pe ${x('until')}` : `until ${x('until')}`;
  if (t.during) return ro ? `în perioada ${x('during')}` : `during ${x('during')}`;
  return '';
}
/** A time value that takes "on"/"pe": a date or a weekday; relative expressions ("yesterday", "last year") stand alone. */
const DATE_LIKE = /^(\d|(January|February|March|April|May|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b|(ianuarie|februarie|martie|aprilie|mai|iunie|iulie|august|septembrie|octombrie|noiembrie|decembrie)\b)/;
const hasTime = prop => Boolean(prop.valid && Object.keys(prop.valid).length) || Boolean(prop.queryTime && Object.keys(prop.queryTime).length);

// ---------------------------------------------------------------- generic conjugation (fallback)
const EN_IRREGULAR_3SG = { be: 'is', have: 'has', do: 'does', go: 'goes' };
const EN_MODALS = new Set(['can', 'could', 'may', 'might', 'must', 'should', 'shall', 'will', 'would']);
const en3sg = verb => EN_IRREGULAR_3SG[verb] ?? (/(s|sh|ch|x|z|o)$/.test(verb) ? verb + 'es' : /[^aeiou]y$/.test(verb) ? verb.slice(0, -1) + 'ies' : verb + 's');
const RO_IRREGULAR_3SG = { fi: 'este', avea: 'are', vrea: 'vrea', putea: 'poate', da: 'dă', sta: 'stă', lua: 'ia', juca: 'joacă', bea: 'bea', ști: 'știe', face: 'face', zice: 'zice', spune: 'spune', merge: 'merge', trebui: 'trebuie' };
function ro3sg(verb) {
  if (RO_IRREGULAR_3SG[verb]) return RO_IRREGULAR_3SG[verb];
  if (/[ae]$/.test(verb) && verb.endsWith('ea')) return verb.slice(0, -2) + 'e';
  if (verb.endsWith('a')) return verb.slice(0, -1) + 'ează';
  if (verb.endsWith('i')) return verb + 'ește';
  if (verb.endsWith('î')) return verb.slice(0, -1) + 'ăște';
  return verb;
}
const ROLE_PREP = { en: { recipient: 'to', location: 'in', source: 'from', destination: 'to', instrument: 'with', topic: 'about' }, ro: { recipient: 'lui', location: 'în', source: 'din', destination: 'la', instrument: 'cu', topic: 'despre' } };

/** Generic clause from a lemma phrase: {statement, question, wh(role)} strings in `language`. */
function genericClause(prop, { language, fill, negated, ask = null, focusRole = null, measure = null }) {
  const L = LABELS[language];
  const phrase = (language === 'ro' ? prop.source_relation ?? prop.relation : prop.relation) ?? '';
  const [verb, ...rest] = phrase.split(/\s+/);
  const tail = rest.join(' ');
  const roles = prop.roles.filter(([role]) => role !== 'subject' && role !== focusRole);
  const endsWithPrep = /\b(to|at|in|on|of|for|with|from|by|about|into|la|în|pe|cu|din|de|despre|pentru|lui)$/.test(phrase);
  let first = true;
  const args = roles.map(([role, value]) => {
    const v = isVar(value) ? (role === 'time' ? '' : L.something) : fill(value, role);
    if (!v) return '';
    if (role === 'time') return /^(\d|on |in |at |during |since |until |pe |în |din |până )/i.test(v) || /^\p{Lu}/u.test(v) ? (/^\d/.test(v) ? (language === 'ro' ? `pe ${v}` : `on ${v}`) : v) : v;
    const direct = first && (role === 'object' || endsWithPrep);
    first = false;
    if (direct) return v;
    return `${ROLE_PREP[language][role] ?? ''} ${v}`.trim();
  }).filter(Boolean).join(' ');
  const subjectValue = prop.roles.find(([role]) => role === 'subject')?.[1];
  const subject = subjectValue === undefined ? '' : isVar(subjectValue) ? L.someone : fill(subjectValue, 'subject');
  if (language === 'ro') {
    const v = ro3sg(verb);
    const core = `${negated ? 'nu ' : ''}${v} ${tail} ${args}`.replace(/\s+/g, ' ').trim();
    if (ask === 'wh') {
      const wh = focusRole === 'subject' ? 'cine' : focusRole === 'location' || focusRole === 'destination' ? 'unde' : focusRole === 'source' ? 'de unde' : focusRole === 'time' ? { start: 'de când', end: 'până când', duration: 'cât timp' }[measure] ?? 'când' : 'ce';
      return focusRole === 'subject' ? `${wh} ${core}` : `${wh} ${core.replace(new RegExp(`^(nu )?${v}`), m => `${m} ${subject}`)}`;
    }
    return `${subject} ${core}`.trim();
  }
  const modal = EN_MODALS.has(verb), be = verb === 'be';
  const plainSubject = /^(i|we|you|they)$/i.test(subject);
  const finite = modal ? verb : be ? (/^i$/i.test(subject) ? 'am' : plainSubject ? 'are' : 'is') : plainSubject ? verb : en3sg(verb);
  const statement = () => negated ? (modal || be ? `${subject} ${finite} not ${tail} ${args}` : `${subject} ${plainSubject ? 'do' : 'does'} not ${verb} ${tail} ${args}`) : `${subject} ${finite} ${tail} ${args}`;
  if (!ask) return statement();
  if (ask === 'wh' && focusRole === 'subject') return `who ${negated ? (modal || be ? `${finite} not` : `does not ${verb}`) : finite} ${tail} ${args}`;
  const aux = modal || be ? finite : plainSubject ? 'do' : 'does';
  const bare = modal || be ? '' : verb;
  const inverted = `${aux} ${subject}${negated ? ' not' : ''} ${bare} ${tail} ${args}`;
  if (ask === 'wh') {
    const wh = ['location', 'destination', 'source'].includes(focusRole) ? 'where' : focusRole === 'time' ? { start: 'since when', end: 'until when', duration: 'how long' }[measure] ?? 'when' : 'what';
    return `${wh} ${inverted}${focusRole === 'source' ? ' from' : focusRole === 'destination' && !/\bto$/.test(inverted.trim()) ? ' to' : ''}`;
  }
  return inverted;
}

// ---------------------------------------------------------------- clauses
function makeFill(ctx, language, prop) {
  return (value, role) => role === 'time' ? timeText(value, prop, language) : surfaceValue(value, { ...ctx, language });
}
/** Construction-based clause for a form key, or null. */
function constructionClause(prop, key, language, ctx, { focus = null, invert = false } = {}) {
  const c = constructionOf(prop, language);
  if (!c) return null;
  const fullKey = focus ? `${key}${focus}` : key;
  const template = c.forms?.[fullKey]?.[0];
  if (!template) return null;
  const fill = makeFill(ctx, language, prop);
  const names = {}, genders = {};
  const subject = prop.roles.find(([role]) => role === 'subject')?.[1];
  const object = prop.roles.find(([role]) => role !== 'subject' && role !== 'time')?.[1];
  if (subject !== undefined && !isVar(subject)) { names.S = fill(subject, 'subject'); genders.S = genderOf(names.S); }
  if (object !== undefined && !isVar(object)) { names.O = fill(object, 'object'); genders.O = genderOf(names.O); }
  if (/\{S\}/.test(template) && !names.S) return null;
  if (/\{O\}/.test(template) && !names.O) return null;
  // Romanian direct questions put the verb group before the subject ("când a lucrat Ana la Acme").
  if (invert) { const inverted = invertRo(template, names, genders); if (inverted) return inverted; }
  return tidy(fillTemplate(template, names, genders));
}

function statementText(prop, language, ctx) {
  const negated = prop.polarity === 'negated', past = hasTime(prop);
  const key = negated ? (past ? 'np' : 'n') : (past ? 'sp' : 's');
  let text = constructionClause(prop, key, language, ctx), fallback = false;
  if (!text) { text = genericClause(prop, { language, fill: makeFill(ctx, language, prop), negated }); fallback = true; }
  const suffix = timeSuffix(prop, language);
  return { text: tidy(`${text} ${suffix}`), fallback };
}

function questionText(prop, q, language, ctx) {
  const negated = prop.polarity === 'negated', past = hasTime(prop);
  const vars = prop.roles.filter(([, v]) => isVar(v));
  const selected = (q.select ?? []).find(v => prop.roles.some(([, value]) => value === v));
  const fill = makeFill(ctx, language, prop);
  let text = null, fallback = false;
  if (q.ask === 'whether' || q.ask === 'explain' || !selected) {
    const key = negated ? (past ? 'nqp' : 'nq') : (past ? 'qp' : 'q');
    text = vars.length ? null : constructionClause(prop, key, language, ctx);
    if (!text) { text = genericClause(prop, { language, fill, negated, ask: 'yn' }); fallback = true; }
    if (language === 'ro') {
      // Romanian yes/no questions keep the declarative order; the question mark carries the question.
      const s = vars.length ? null : constructionClause(prop, negated ? (past ? 'np' : 'n') : (past ? 'sp' : 's'), language, ctx);
      if (s) { text = s; fallback = false; } else text = genericClause(prop, { language, fill, negated });
    }
    if (q.ask === 'explain') text = language === 'ro' ? `de ce ${text}` : `why ${text}`;
  } else {
    const role = prop.roles.find(([, v]) => v === selected)[0];
    const focus = role === 'subject' ? 'S' : role === 'time' ? null : 'O';
    if (role === 'time') {
      // "When / since when / until when / how long" + the yes/no core without the time role.
      const wh = WH_TIME[language][q.measure] ?? WH_TIME[language].at;
      const base = { ...prop, roles: prop.roles.filter(([r]) => r !== 'time') };
      const key = language === 'ro' ? (negated ? (past ? 'np' : 'n') : (past ? 'sp' : 's')) : (negated ? (past ? 'nqp' : 'nq') : (past ? 'qp' : 'q'));
      const core = base.roles.some(([, v]) => isVar(v)) ? null : constructionClause(base, key, language, ctx, { invert: language === 'ro' });
      if (core) text = `${wh} ${core}`;
    } else if (q.ask === 'count') text = focus && constructionClause(prop, 'cnt', language, ctx, { focus });
    else if ((role === 'location' || role === 'destination') && focus) text = constructionClause(prop, past ? 'wherep' : 'where', language, ctx, { focus }) ?? constructionClause(prop, past ? 'whp' : 'wh', language, ctx, { focus });
    else if (focus) text = constructionClause(prop, past ? 'whp' : 'wh', language, ctx, { focus });
    if (text && negated) text = null; // construction wh-forms are affirmative only
    if (!text) {
      text = genericClause(prop, { language, fill, negated, ask: 'wh', focusRole: role, measure: q.measure });
      fallback = true;
      if (q.ask === 'count') return { text: capitalize(tidy(`${text} ${timeSuffix(prop, language)}`)) + '?', fallback, countLabel: true };
    }
  }
  const suffix = timeSuffix(prop, language);
  return { text: capitalize(tidy(`${text} ${suffix}`)) + '?', fallback };
}

// ---------------------------------------------------------------- rendering
function statusLabel(prop, language, ctx) {
  const L = LABELS[language];
  if (prop.speaker) return `${surfaceValue(prop.speaker, { ...ctx, language })} ${prop.certainty === 'hedged' ? L.thinks : L.says}`;
  if (prop.certainty === 'hedged') return L.maybe;
  if (prop.certainty === 'supposed') return L.suppose;
  return '';
}
const sentence = (label, text, end = '.') => `${label ? label + ' ' : ''}${label ? text : capitalize(text)}${/[.?!]$/.test(text) ? '' : end}`;

function queryLines(q, rowLanguage, ctx, out) {
  const lang0 = q.props[0] ? propLanguage(q.props[0], rowLanguage) : rowLanguage;
  if (q.asof) out.push(sentence(LABELS[lang0].asof, timeText(q.asof, q.props[0] ?? {}, lang0)));
  if (q.fragment) {
    const values = q.props.flatMap(p => p.roles.filter(([, v]) => !isVar(v)).map(([role, v]) => surfaceValue(v, { ...ctx, language: rowLanguage })));
    out.push(`${rowLanguage === 'ro' ? 'Și' : 'And'} ${values.join(' ')}?`);
    return;
  }
  if (q.ask === 'every') {
    const lang = propLanguage(q.props[0], rowLanguage), L = LABELS[lang];
    q.props.forEach((p, i) => { const r = questionText(p, { ...q, ask: 'which', select: q.select?.length ? q.select : p.roles.filter(([, v]) => isVar(v)).map(([, v]) => v) }, lang, ctx); out.push(sentence(i ? L.and : L.group, r.text)); if (r.fallback) ctx.fallbacks++; });
    for (const p of q.scope) {
      const lp = propLanguage(p, rowLanguage), Lp = LABELS[lp];
      const each = { ...p, roles: p.roles.map(([role, v]) => [role, isVar(v) && role === 'subject' ? JSON.stringify(Lp.each) : v]) };
      const r = statementText(each, lp, { ...ctx, message: ctx.message + ' ' + Lp.each });
      if (r.fallback) ctx.fallbacks++;
      out.push(sentence(`${Lp.check} ${QUANT[lp][q.quantifier] ?? q.quantifier ?? QUANT[lp].all}:`, r.text));
    }
    return;
  }
  q.props.forEach((p, i) => {
    const lang = propLanguage(p, rowLanguage);
    // A query-level time ("at"/"during") belongs to every question line.
    const timed = q.time ? { ...p, queryTime: { ...(p.queryTime ?? {}), ...q.time } } : p;
    const r = questionText(timed, i && q.ask === 'count' ? { ...q, ask: 'which' } : q, lang, ctx);
    if (r.fallback) ctx.fallbacks++;
    out.push(i ? `${LABELS[lang].and} ${r.text}` : r.countLabel ? `${COUNT_LABEL[lang]} ${r.text}` : r.text);
  });
  const lang = propLanguage(q.props[0], rowLanguage), L = LABELS[lang];
  for (const filter of q.filter ?? []) { const m = /("(?:\\.|[^"\\])*")\s*$/.exec(filter); if (m) out.push(sentence(L.except, surfaceValue(m[1], { ...ctx, language: lang }))); }
  if (q.options?.length) out.push(sentence(L.options, q.options.map(o => surfaceValue(o, { ...ctx, language: lang })).join(', ')));
  for (const [v, cmp, operand] of q.compare ?? []) out.push(sentence(L.condition, `${varWord(v)} ${COMPARE[lang][cmp] ?? cmp} ${isVar(operand) ? varWord(operand) : unq(operand)}`));
  if (q.rank) out.push(sentence(L.rank, `${L[q.rank[0]]} ${varWord(q.rank[1])}`));
  if (q.order) out.push(sentence(L.order, `${L.first} ${ORDER[lang][q.order[1]] ?? q.order[1]} ${L.second}`));
}

/**
 * Render a surface IR as simple text. `ctx`: {language: row language 'en'|'ro'|'mixed', message, entities}.
 * Returns {text, lines, fallbacks, kind} where `kind` is 'content' | 'empty' (no_request) | 'verbatim' (gibberish).
 */
export function renderSimpleText(ir, { language = 'en', message = '', entities = [] } = {}) {
  const rowLanguage = language === 'ro' ? 'ro' : 'en';
  const ctx = { message, entities, fallbacks: 0 };
  const out = [];
  if (ir.unclear) {
    if (ir.unclear.kind === 'no_request') return { text: '', lines: [], fallbacks: 0, kind: 'empty' };
    if (ir.unclear.kind === 'gibberish') return { text: message.trim(), lines: [message.trim()], fallbacks: 0, kind: 'verbatim' };
    const L = LABELS[rowLanguage];
    out.push(L.ambiguous, ...(ir.unclear.readings ?? []).map(r => sentence(L.reading, unq(r))));
    return { text: out.join('\n'), lines: out, fallbacks: 0, kind: 'content' };
  }
  for (const p of ir.stated ?? []) {
    const lang = propLanguage(p, rowLanguage);
    const r = statementText(p, lang, ctx);
    if (r.fallback) ctx.fallbacks++;
    out.push(sentence(statusLabel(p, lang, ctx), r.text));
  }
  for (const p of ir.assumed ?? []) {
    const lang = propLanguage(p, rowLanguage);
    const r = statementText(p, lang, ctx);
    if (r.fallback) ctx.fallbacks++;
    out.push(sentence(LABELS[lang].assumption, r.text));
  }
  if (ir.constraint) {
    const c = ir.constraint, L = LABELS[rowLanguage];
    for (const [name, lo, hi] of c.vars ?? []) out.push(sentence('', `${L.number} ${varWord(name)} ${L.between} ${lo} ${rowLanguage === 'ro' ? 'și' : 'and'} ${hi}`));
    for (const e of c.require ?? []) out.push(sentence(L.require, expressionWords(e).replace(/\?/g, '')));
    const claim = expressionWords(c.claim).replace(/\?/g, '');
    out.push(c.task === 'prove' ? sentence('', `${L.prove} ${claim}`) : `${L.possible} ${claim}?`);
  }
  for (const q of [ir.query, ...(ir.moreQueries ?? [])].filter(Boolean)) queryLines(q, rowLanguage, ctx, out);
  const lines = out.map(line => tidy(line)).filter(Boolean);
  return { text: lines.join('\n'), lines, fallbacks: ctx.fallbacks, kind: 'content' };
}
