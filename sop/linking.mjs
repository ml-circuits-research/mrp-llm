/**
 * Host linking of context-free model-language propositions (DS014). The small
 * model writes strings: a relation phrase, role values as written in the
 * message and temporal expressions. After the model, the host links them to the
 * reviewed lexicon deterministically. It never guesses: an unknown or ambiguous
 * relation, a role set no predicate declares, or an unreadable time expression
 * becomes a host clarification. Entity strings are resolved by the generated
 * `resolve` wires of the declarative compiler (exact and accent-folded aliases).
 */
import {line} from './replies.mjs';
import {ROLE_NAMES} from './enums.mjs';
import {fold, phraseKey} from './text-keys.mjs';
export {phraseKey};
import {formatTime} from '../lib/time.mjs';
import {defaultRelationLexicon} from './relation-lexicon.mjs';
import {predicateRoleNames, matchedForm, scoreRelation, decide, headVerbPredicates, mode} from './knowledge-linker.mjs';
export {predicateRoleNames, matchedForm};

const DAY = 86400000;

/**
 * Link a relation phrase and the role names used with it to one lexicon
 * predicate. `exact` (statements, assumptions) requires the declared role set
 * to equal the used set; otherwise (query match blocks) the used roles must be
 * declared and missing ones become fresh variables.
 */
export function linkRelation(text, used, lexicon, {exact = true, relations = defaultRelationLexicon(), values = null, headVerb = false} = {}) {
  const key = phraseKey(text);
  // The lexicon indexes every predicate form by phrase key (id, labels, lexeme forms, description).
  const declared = lexicon?.predicatesFor ? lexicon.predicatesFor(key) : Object.values(lexicon?.predicates ?? {}).filter(predicate => {
    const forms = [predicate.id, ...(predicate.aliases ?? []).map(alias => alias.surface), ...(predicate.description ? [predicate.description] : [])];
    return forms.some(form => phraseKey(form) === key);
  });
  // The relation lexicon (reviewed phrase -> predicate entries) adds only predicates the memory in use declares.
  const listed = (relations?.predicatesFor(phrase => phraseKey(phrase) === key) ?? []).map(id => lexicon?.predicates?.[id]).filter(Boolean);
  let named = [...new Map([...declared, ...listed].map(predicate => [predicate.id, predicate])).values()], via = 'lexicon';
  // A phrase that is exactly a predicate id of the memory names that predicate (a producer that knows the vocabulary, such as the coding agent, writes ids; DS022): an alias of another predicate that happens to read the same cannot make it ambiguous.
  if (typeof text === 'string' && /^[a-z][a-z0-9_]*$/.test(text) && Object.hasOwn(lexicon?.predicates ?? {}, text)) named = [lexicon.predicates[text]];
  // A query may fall back to the head verb alone ("work for" for "work at"); a stated proposition never does (DS014 "KnowledgeLinker: scoring and ambiguity").
  if (!named.length && headVerb && mode.headVerb && !exact && lexicon?.predicatesByKey) { named = headVerbPredicates(lexicon, text); via = 'headVerb'; }
  if (!named.length) return {status: 'unknown', text};
  const fits = named.filter(predicate => {
    const names = predicateRoleNames(predicate);
    return names && (exact ? names.length === used.length && used.every(name => names.includes(name)) : used.every(name => names.includes(name)));
  });
  const candidates = (list => list.map(predicate => ({id: predicate.id, roles: predicateRoleNames(predicate)})).sort((a, b) => a.id.localeCompare(b.id)));
  if (!fits.length) return {status: 'role_mismatch', text, used, candidates: candidates(named)};
  // Score every fitting predicate, then decide in named stages; an undecided tie is an ambiguity, never a guess.
  const memo = new Map();
  const outcome = decide(fits.map(predicate => scoreRelation(lexicon, predicate, text, {used, exact, values, via, memo})));
  const view = c => ({id: c.id, score: c.score, tier: c.tier, ...(c.weight !== null ? {weight: c.weight} : {}), ...(c.hard.length ? {rejected: c.hard} : {})});
  if (!outcome.chosen) return {status: 'ambiguous', text, candidates: candidates(outcome.tied.map(c => lexicon.predicates[c.id])), scored: outcome.tied.map(view)};
  const chosen = lexicon.predicates[outcome.chosen.id];
  return {status: 'bound', text, id: chosen.id, ...(outcome.chosen.converse ? {converse: true} : {}), roles: predicateRoleNames(chosen), types: chosen.args, score: outcome.chosen.score, tier: outcome.chosen.tier, decided_by: outcome.by, ...(via === 'headVerb' ? {via} : {}),
    scored_alternatives: outcome.scored.filter(c => c.id !== chosen.id).map(view)};
}

const MONTHS = {january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  // Abbreviations, written with or without a final dot. English only (DS014 "English-only core").
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12};
const RELATIVE = {today: 0, yesterday: -1, tomorrow: 1};
const utc = (y, m = 1, d = 1) => Date.UTC(y, m - 1, d);
/**
 * Normalize a temporal expression to a period {from, until} (until exclusive),
 * relative to the runtime clock `now`. Accepted: ISO dates and UTC timestamps,
 * `YYYY`, `YYYY-MM`, a month name or abbreviation with a year, a day,
 * month and year ("3 March 2025", "March 3, 2025", "the 3rd of March 2025",
 * "03.03.2025"), ranges "A – B" or "A to B" (a trailing year may be shared), `now`,
 * today/yesterday/tomorrow and last/this/next year, with an optional leading in/on/at/during/since/from/throughout.
 * Anything else returns null and the runtime asks.
 */
/** True when a temporal expression is an explicit range ("A to B", "A – B"), the form `at`/`asof` must not take. */
export function isTimeRange(text) {
  const t = fold(String(text)).replace(/^(?:in|on|at|during|since|from|throughout)\s+/, '').replace(/^the\s+/, '').trim();
  return /^(.+?)\s+(?:to|[–—-])\s+(.+)$/.test(t) || /^(.+?)[–—](.+)$/.test(t);
}

export function normalizeTime(text, now = Date.now()) {
  let t = fold(text).replace(/^(?:in|on|at|during|since|from|throughout)\s+/, '').replace(/^the\s+/, '').trim();
  // Ranges end at the start of B, never at the end of B's day or month.
  const range = t.match(/^(.+?)\s+(?:to|[–—-])\s+(.+)$/) ?? t.match(/^(.+?)[–—](.+)$/);
  if (range) {
    const year = range[2].match(/(?:^|[\s,])(\d{4})$/)?.[1];
    const bare = range[1].match(/^(?:\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?)?([a-z]+)\.?(?:\s+\d{1,2}(?:st|nd|rd|th)?)?$/);
    const first = year && bare && MONTHS[bare[1]] ? `${range[1]} ${year}` : range[1];
    const a = normalizeTime(first, now), b = normalizeTime(range[2], now);
    return a && b && a.from < b.from ? {from: a.from, until: b.from} : null;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(t.toUpperCase())) { const at = Date.parse(t.toUpperCase()); return Number.isFinite(at) ? {from: at, until: at + 1} : null; }
  let m;
  if ((m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/))) { const from = utc(+m[1], +m[2], +m[3]); return new Date(from).getUTCDate() === +m[3] ? {from, until: from + DAY} : null; }
  if ((m = t.match(/^(\d{4})-(\d{2})$/)) && +m[2] >= 1 && +m[2] <= 12) return {from: utc(+m[1], +m[2]), until: utc(+m[1], +m[2] + 1)};
  if ((m = t.match(/^(\d{4})$/))) return {from: utc(+m[1]), until: utc(+m[1] + 1)};
  if ((m = t.match(/^([a-z]+)\.?\s+(\d{4})$/)) && MONTHS[m[1]]) return {from: utc(+m[2], MONTHS[m[1]]), until: utc(+m[2], MONTHS[m[1]] + 1)};
  // Day, month and year: "3 March 2025", "the 3rd of March 2025", "March 3, 2025", "3 mar. 2025", "03.03.2025".
  const day = (y, mo, d) => { const from = utc(y, mo, d); return mo >= 1 && mo <= 12 && new Date(from).getUTCDate() === d ? {from, until: from + DAY} : null; };
  if ((m = t.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+)\.?,?\s+(\d{4})$/)) && MONTHS[m[2]]) return day(+m[3], MONTHS[m[2]], +m[1]);
  if ((m = t.match(/^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/)) && MONTHS[m[1]]) return day(+m[3], MONTHS[m[1]], +m[2]);
  if ((m = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/))) return day(+m[3], +m[2], +m[1]);
  if (t === 'now') return {from: now, until: now + 1};
  // Relative years ("last year" for a follow-up such as "but last year?"): the calendar year of the host clock, shifted.
  const YEARS = {'last year': -1, 'this year': 0, 'next year': 1};
  if (Object.hasOwn(YEARS, t)) { const y = new Date(now).getUTCFullYear() + YEARS[t]; return {from: utc(y), until: utc(y + 1)}; }
  if (Object.hasOwn(RELATIVE, t)) { const d = new Date(now); const from = utc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate() + RELATIVE[t]); return {from, until: from + DAY}; }
  return null;
}

/** Validity of a proposition from its `valid on|from|until` strings; absent means timeless. */
export function linkValidity(valid, now) {
  const issues = [];
  const period = form => { const p = normalizeTime(valid[form], now); if (!p) issues.push({kind: 'time', text: valid[form], status: 'unknown'}); return p; };
  let interval = {from: -Infinity, until: Infinity};
  if (valid.on) { const p = period('on'); if (p) interval = p; }
  else {
    const from = valid.from ? period('from') : null, until = valid.until ? period('until') : null;
    interval = {from: from ? from.from : -Infinity, until: until ? until.from : Infinity};
    if (from && until && !(interval.from < interval.until)) issues.push({kind: 'time', text: valid.from + ' … ' + valid.until, status: 'empty_interval'});
  }
  return {interval, issues, text: interval.from === -Infinity && interval.until === Infinity ? 'timeless' : formatTime(interval.from) + ' ' + formatTime(interval.until)};
}

/** The clarification question for unlinked strings, in English (the output edge translates it, DS014 "English-only core"); the sentences are `line_ask_*` replies of the conversation layer (DS023). */
export function linkQuestion(issues) {
  return issues.map(issue => {
    if (issue.kind === 'entity') {
      // An ambiguous surface names its options (label and class) so the user can pick one.
      // The memory's own description of each namesake ("capital and largest city of France") when it has one, else the class.
      const options = (issue.candidates ?? []).filter(c => c.label).slice(0, 5).map(c => c.description || c.class ? line('option_described', {label: c.label, description: c.description || c.class}) : c.label).join(line('options_separator'));
      if (issue.status === 'ambiguous' && options) return line('ask_entity_options', {text: JSON.stringify(issue.text), options});
      return line('ask_entity', {text: JSON.stringify(issue.text)});
    }
    // The copula and other readings carry their own precise question (sop/copula-linker.mjs).
    if (issue.question) return issue.question;
    if (issue.kind === 'time' && issue.status === 'not_an_interval') return line('ask_time_measure', {text: issue.text});
    if (issue.kind === 'time') return line('ask_time', {text: JSON.stringify(issue.text)});
    const choices = (issue.candidates ?? []).map(c => line('option_described', {label: c.id, description: c.roles.join(', ')})).join(line('options_separator'));
    if (issue.status === 'ambiguous') return line('ask_relation_options', {text: JSON.stringify(issue.text), options: choices});
    if (issue.status === 'type_mismatch') return line(issue.expected ? 'ask_relation_type_expected' : 'ask_relation_type', {text: JSON.stringify(issue.text), value: JSON.stringify(issue.value), role: issue.role, expected: issue.expected});
    if (issue.status === 'role_mismatch') return line('ask_relation_roles', {text: JSON.stringify(issue.text), options: choices});
    return line('ask_relation_unknown', {text: JSON.stringify(issue.text)});
  }).join(' ');
}

const tokensOf = s => fold(String(s)).match(/[\p{L}\p{N}]+/gu) ?? [];
/** Optimal string alignment distance: insertions, deletions, substitutions and adjacent transpositions. */
function distance(a, b) {
  const d = Array.from({length: a.length + 1}, (_, i) => Array.from({length: b.length + 1}, (_, j) => i ? (j ? 0 : i) : j));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
// Tokens match after folding when equal, within a small edit distance (0 up to 3
// characters, 1 up to 7, else 2), or as an inflection sharing all but the last
// character of a token of at least four characters.
function near(a, b) {
  if (a === b) return true;
  const allowed = a.length <= 3 ? 0 : a.length <= 7 ? 1 : 2;
  if (allowed && Math.abs(a.length - b.length) <= allowed && distance(a, b) <= allowed) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short.slice(0, -1)) && long.length <= short.length + 3;
}
/**
 * Is a value (a quoted string or a number from a model proposition) mentioned
 * in the message? Consecutive message tokens must match every value token
 * after case, whitespace and accent folding, tolerating small typos and
 * inflections. Deterministic; no lexicon is involved.
 */
export function mentionedIn(value, message) {
  const wanted = tokensOf(value), text = tokensOf(message);
  if (!wanted.length) return false;
  for (let i = 0; i + wanted.length <= text.length; i++) if (wanted.every((token, j) => near(token, text[i + j]))) return true;
  return false;
}

/**
 * Cross-lingual anchoring (DS014 "Input languages and content words"): a `stated` value written in
 * English for a common noun of a non-English message ("the gym" for "sala de sport") is anchored when the host
 * lexicon knows an entity with that surface and another surface of the same entity (any language) is mentioned
 * in the message. The host's own reviewed labels decide; no dictionary or model is involved.
 */
export function mentionedThroughLexicon(value, message, lexicon) {
  if (!lexicon?.folded) return false;
  const entries = (lexicon.folded.get(fold(String(value))) ?? []).map(index => lexicon.entries[index]).filter(entry => entry.kind === 'entity');
  for (const id of new Set(entries.map(entry => entry.id))) {
    for (const alias of lexicon.entities[id]?.aliases ?? []) if (mentionedIn(alias.surface, message)) return true;
  }
  return false;
}

const FIRST_PERSON = /(?<![\p{L}])(?:i|i'm|i've|i'd|me|my|mine|myself|we|our|us)(?![\p{L}])/iu;
const FUNCTION_TOKENS = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'from', 'by', 'with', 's']);
/**
 * Anchoring through the English dictionary view (DS014 "Content words", "English-only core"): the message is English, and a
 * content word may be written as an English synonym of a word of the message. A value is anchored when a surface of a
 * dictionary entry it belongs to is mentioned in the message; a multiword value is anchored
 * when each of its content words is (directly or through the dictionary). "the user" is anchored by a first-person
 * word (Q-LANG-5).
 */
export function mentionedThroughDictionary(value, message, dictionary) {
  if (!dictionary || typeof value !== 'string') return false;
  const surfacesOf = text => dictionary.lookup(text).flatMap(hit => [...hit.entry.ro, ...hit.entry.forms.map(form => form.replace(/^def:/, '')), ...hit.entry.en]);
  const anchored = text => mentionedIn(text, message) || surfacesOf(text).some(surface => mentionedIn(surface, message)) || surfacesOf(text.replace(/^(?:the|a|an)\s+/i, '')).some(surface => mentionedIn(surface, message));
  if (anchored(value)) return true;
  const tokens = tokensOf(value).filter(token => !FUNCTION_TOKENS.has(token));
  if (!tokens.length) return false;
  return tokens.every(token => (token === 'user' || token === "user's") ? FIRST_PERSON.test(String(message)) : anchored(token));
}

export {ROLE_NAMES};
