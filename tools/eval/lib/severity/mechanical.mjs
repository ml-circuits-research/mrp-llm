/**
 * Mechanical layer of the severity cascade (DS012 "Graded severity", layer 1): text-only checks of a rewrite against its original, no parser, no model.
 * `mechanicalChecks(original, rewrite)` returns {exact, flags}: `exact` is true when both texts are the same after normalising case, spacing and punctuation;
 * each flag is {kind, severity, certain, detail}. A `certain` S4 flag decides the pair (names, numbers, quantifiers replaced; a condition, supposition or
 * reported claim lost; a cause invented; an invented sentence); the other flags are hints for the analysis layer and the judge. Spelling noise in the original
 * (typos in names) makes name checks conservative: a name only counts when it is capitalised mid-sentence in the text that has it.
 */
import {rawNumbers, fold} from './text-features.mjs';

export const MECHANICAL_VERSION = 'severity-mechanical-v1';
const set = s => new Set(s.split(/\s+/));
const WORDS = text => String(text ?? '').match(/[\p{L}\p{N}'’-]+|[.?!:;,—–()"“”]/gu) ?? [];
const norm = t => fold(String(t)).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

const STARTERS = set('. ? ! : ; — – ( " “');
const NOT_NAMES = set('i i\'m i\'d i\'ll i\'ve mr mrs ms miss dr prof sir madam background question hi hello hey okay ok so also plus quick just honestly sorry please thanks yes no true false given suppose supposing assume assuming let\'s other apart besides aside up until since check verify confirm tell name list can could would should do does did is are was were has have had will who whom whose what which where when why how if unless although though because and or but not nobody none nothing everyone everybody someone anyone must may might shall doesnt dont isnt arent wasnt werent didnt hasnt havent wont wouldnt shouldnt couldnt cant');
/** Distinct names: words capitalised after the first word of a sentence, plus capitalised first words that are followed by another capitalised word. */
export function namesOf(text) {
  const w = WORDS(text), out = new Set();
  for (let i = 0; i < w.length; i++) {
    const t = w[i];
    if (!/^\p{Lu}/u.test(t)) continue;
    const f = fold(t).replace(/['’]s$/i, '').replace(/[^\p{L}\p{N}]/gu, '');
    if (!f || NOT_NAMES.has(f)) continue;
    const prev = w[i - 1], next = w[i + 1];
    const initial = i === 0 || STARTERS.has(prev);
    if (!initial || (next && /^\p{Lu}/u.test(next) && !NOT_NAMES.has(fold(next)))) out.add(f);
  }
  return out;
}

const QUANT = {
  all: 'all', every: 'all', each: 'all', everyone: 'all', everybody: 'all', everything: 'all',
  some: 'some', someone: 'some', somebody: 'some', something: 'some',
  any: 'any', anyone: 'any', anybody: 'any', anything: 'any',
  none: 'none', nobody: 'none', no: 'none', nothing: 'none', nowhere: 'none',
  most: 'most', few: 'few', many: 'many', both: 'both', never: 'never', always: 'always',
};
const quantsOf = text => { const out = []; const w = (String(text).toLowerCase().replace(/\bhow (many|much)\b/g, ' ').match(/\p{L}+/gu) ?? []); for (let i = 0; i < w.length; i++) { const q = QUANT[w[i]]; if (!q) continue; if (w[i] === 'no' && /^(more|less|longer)$/.test(w[i + 1] ?? '')) continue; out.push(q); } return out; };
const NEG = /\b(not|never|no|none|nobody|nothing|nowhere|neither|nor|without|cannot|can't|cant)\b|n['’]t\b/gi;
const negCount = text => (String(text).match(NEG) ?? []).length;
const WH = /\b(who|whom|whose|what|which|where|when|why|how many|how much|how long|how far|how old|how often|how)\b/gi;
const isQuestion = text => /\?/.test(text) || /\b(whether|tell me|let me know|need to know|want to know|like to know|wonder(ing)?|check|verify|confirm|find out|true or false|name the|list the)\b/i.test(text);
const whWords = text => (String(text).toLowerCase().match(WH) ?? []).map(x => x.replace(/^how .+/, 'how')).sort();
const WRAPPER = /\b(wonder|wondering|know|check|see|tell|ask|whether|confirm|verify|sure|curious|idea|find out|trying to find out|need to know|want to know|like to know)\b(?:\W+\w+){0,4}?\W+if\b/i;
const CONDITIONAL = /\b(unless|suppose|supposing|assuming|assume|let's say|imagine|hypothetically|in case|provided that|what if)\b|\bif\b/i;
const hasConditional = text => /\b(unless|suppose|supposing|assuming|assume|let['’]s say|imagine|hypothetically|in case|provided that|what if|even if|only if|as if)\b/i.test(text) || /(^|[.!?:;—]\s*|,\s*)if\b/i.test(text);
const REPORTED_RE = /\b(says?|said|claims|claimed|told|tells|according to|reportedly|rumou?rs?|alleged(ly)?|thinks|believes|heard that)\b/i;
const REPORTED = {test: t => REPORTED_RE.test(String(t).replace(/\b(the|this|that|a|your|his|her) claim\b/gi, ''))};
const CAUSE = /\b(because|due to|as a result|so that)\b/i;
const STOP = set('the a an of to in on at for with by from and or but is are was were be been being do does did has have had will would shall should can could may might must it its this that these those there here he she they him her them his their i you we me us my your our who whom whose what which where when why how if whether not no also just quick okay so hi hello please can tell know check wonder wondering need want like ask sure curious any one some than then too very really about as into out up down over under again still already yet back background question given');
const stem = w => fold(w).replace(/(ing|ed|es|s|ly)$/, '');
const contentOf = text => new Set((String(text).toLowerCase().match(/\p{L}{3,}/gu) ?? []).filter(w => !STOP.has(w)).map(stem));
const sentencesOf = text => String(text).split(/(?<=[.?!])\s+/).map(s => s.trim()).filter(Boolean);

/** The two sides of a `because` in a text as [effect, cause] content sets (a leading `Because X, Y` has the cause first). */
function becauseSides(text) {
  const t = String(text), m = /\bbecause\b/i.exec(t);
  if (!m) return null;
  const before = t.slice(0, m.index), after = t.slice(m.index + m[0].length);
  if (/^\W*$/.test(before)) { const k = after.indexOf(','); return k < 0 ? null : {effect: contentOf(after.slice(k + 1)), cause: contentOf(after.slice(0, k))}; }
  return {effect: contentOf(before), cause: contentOf(after)};
}
const overlap = (a, b) => [...a].filter(x => b.has(x)).length;
function causeReversed(original, rewrite) {
  const a = becauseSides(original), b = becauseSides(rewrite);
  if (!a || !b || a.effect.size < 1 || a.cause.size < 1) return null;
  const straight = overlap(a.effect, b.effect) + overlap(a.cause, b.cause), crossed = overlap(a.effect, b.cause) + overlap(a.cause, b.effect);
  return crossed > straight ? 'effect and cause exchanged around because' : null;
}
const diff = (a, b) => ({onlyA: a.filter(x => !b.includes(x)), onlyB: b.filter(x => !a.includes(x))});

export function mechanicalChecks(original, rewrite) {
  const flags = [], add = (kind, severity, certain, detail) => flags.push({kind, severity, certain, detail});
  if (!String(rewrite ?? '').trim()) return {exact: false, flags: [{kind: 'empty', severity: 'NONE', certain: true, detail: 'empty rewrite'}]};
  const exact = norm(original) === norm(rewrite);
  if (exact) return {exact, flags};

  const na = namesOf(original), nb = namesOf(rewrite);
  const bare = w => fold(w).replace(/['’]s$/i, '').replace(/[^\p{L}\p{N}]/gu, '');
  const lowerB = new Set(WORDS(rewrite).map(bare)), lowerA = new Set(WORDS(original).map(bare));
  const lostNames = [...na].filter(n => !lowerB.has(n)), newNames = [...nb].filter(n => !lowerA.has(n));
  if (lostNames.length && newNames.length) add('name_replaced', 'S4', true, `${lostNames} -> ${newNames}`);
  else if (newNames.length) add('name_invented', 'S4', true, `${newNames}`);
  else if (lostNames.length) add('name_lost', 'S2', false, `${lostNames}`);

  const numA = [...new Set(rawNumbers(original))], numB = [...new Set(rawNumbers(rewrite))];
  const nd = diff(numA, numB);
  if (nd.onlyA.length && nd.onlyB.length) add('number_replaced', 'S4', true, `${nd.onlyA} -> ${nd.onlyB}`);
  else if (nd.onlyB.length) add('number_invented', 'S4', true, `${nd.onlyB}`);
  else if (nd.onlyA.length) add('number_lost', 'S2', false, `${nd.onlyA}`);

  const qa = quantsOf(original), qb = quantsOf(rewrite);
  const qd = diff([...new Set(qa)], [...new Set(qb)]);
  const STRONG = new Set(['all', 'none', 'both', 'never', 'always']);
  const strong = [...qd.onlyA, ...qd.onlyB].some(x => STRONG.has(x));
  const anySome = qd.onlyA.every(x => ['any', 'some'].includes(x)) && qd.onlyB.every(x => ['any', 'some'].includes(x));
  if (qd.onlyA.length && qd.onlyB.length && !anySome) add('quantifier_replaced', strong ? 'S4' : 'S3', strong, `${qd.onlyA} -> ${qd.onlyB}`);
  else if (qd.onlyB.length && !anySome) add('quantifier_invented', strong || qd.onlyB.includes('most') ? 'S4' : 'S3', strong || qd.onlyB.includes('most'), `${qd.onlyB}`);
  else if (qd.onlyA.length) add('quantifier_lost', 'S3', false, `${qd.onlyA}`);

  const ca = negCount(original), cb = negCount(rewrite);
  if (ca !== cb) add(cb > ca ? 'negation_added' : 'negation_lost', 'S4', cb > ca || !(sentencesOf(original).filter(isQuestion).length > sentencesOf(rewrite).filter(isQuestion).length), `${ca} -> ${cb} negation words`);

  if (hasConditional(original) && !hasConditional(rewrite) && !isQuestion(rewrite) ) add('condition_lost', 'S4', true, 'if/unless/suppose in the original, none in the rewrite');
  else if (hasConditional(original) && !hasConditional(rewrite) && !isQuestion(original)) add('condition_lost', 'S4', true, 'a condition became part of a question or statement');
  if (REPORTED.test(original) && !REPORTED.test(rewrite) && !isQuestion(rewrite)) add('reported_lost', 'S4', true, 'reported claim became an asserted statement');
  if (CAUSE.test(rewrite) && !CAUSE.test(original)) add('cause_invented', 'S4', true, 'cause word only in the rewrite');
  const cr = causeReversed(original, rewrite);
  if (cr) add('cause_reversed', 'S4', true, cr);
  if (!hasConditional(original) && hasConditional(rewrite)) add('condition_invented', 'S4', false, 'condition word only in the rewrite');

  const wa = whWords(original), wb = whWords(rewrite);
  const wd = diff(wa, wb);
  if (wd.onlyA.length && wd.onlyB.length) add('question_word_changed', 'S3', false, `${wd.onlyA} -> ${wd.onlyB}`);
  const qsA = sentencesOf(original).filter(isQuestion).length, qsB = sentencesOf(rewrite).filter(isQuestion).length;
  if (isQuestion(original) && !isQuestion(rewrite)) add('question_lost', 'S3', false, 'the original asks, the rewrite does not');
  else if (qsA > qsB) add('question_dropped', 'S2', false, `${qsA} -> ${qsB} questions`);
  else if (!isQuestion(original) && isQuestion(rewrite)) add('question_invented', 'S3', false, 'the original is a statement, the rewrite asks');

  const ca2 = contentOf(original);
  for (const s of sentencesOf(rewrite)) {
    const c = contentOf(s);
    if (c.size >= 2 && [...c].every(x => !ca2.has(x))) { add('invented_sentence', 'S4', true, s.slice(0, 80)); break; }
  }
  const lenRatio = String(rewrite).length / Math.max(1, String(original).length);
  if (lenRatio < 0.35 && String(original).length > 30) add('much_shorter', 'S2', false, `length ratio ${lenRatio.toFixed(2)}`);
  return {exact, flags};
}

/** The mechanical decision: {severity, decided, flags}. A certain S4/NONE flag decides; an exact match decides S0. */
export function mechanicalSeverity(original, rewrite) {
  const r = mechanicalChecks(original, rewrite);
  if (r.exact) return {severity: 'S0', decided: true, flags: []};
  const hard = r.flags.filter(f => f.certain);
  if (hard.length) return {severity: hard.some(f => f.severity === 'NONE') ? 'NONE' : 'S4', decided: true, flags: r.flags};
  return {severity: null, decided: false, flags: r.flags};
}
