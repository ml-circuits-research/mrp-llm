/**
 * Graded severity scale (DS012 "Graded severity (S0-S4, NONE)", owner direction 2026-10-01): the shades of grey between
 * pass and fail for a rewrite (input text -> output text) and for an answer or rendering against a packet or a gold. Pure data and
 * small helpers; the mechanical grader and the metrics live in this folder (the SymbolicLM-era graders were archived on 2026-10-03).
 */
export const SEVERITIES = Object.freeze(['S0', 'S1', 'S2', 'S3', 'S4', 'NONE']);
export const SCALE = Object.freeze({
  S0: 'equivalent',
  S1: 'nuance lost: mild hedge, politeness or lead-in dropped, small tense or aspect detail, focus word (also, even) that does not change truth',
  S2: 'partial: one of several requests or facts missing, one modifier or constraint dropped, "only" dropped; noticeable but not misleading',
  S3: 'wrong but noticeable: wrong question type, wrong but plausible relation, tense or modality changed, and/or or scope changed, garbled wording',
  S4: 'CATASTROPHIC: negation or polarity flip, subject/object or other role swap, wrong or invented entity, name, number or date, quantifier flip, opposite relation, condition/supposition/reported claim/question turned into an asserted fact, invented content',
  NONE: 'no interpretation: empty, unparsed or failed',
});
export const rank = s => (s === 'NONE' ? 5 : SEVERITIES.indexOf(s));
export const worst = (...list) => list.filter(Boolean).reduce((a, b) => (rank(b) > rank(a) ? b : a), 'S0');
export const isGoodEnough = s => ['S0', 'S1', 'S2'].includes(s);
export const isCatastrophic = s => s === 'S4';

/**
 * Typed negatives of the meaning-judge calibration v2 set (eval/reports/current/meaning-judge/v2/labels.jsonl) mapped to a
 * default severity. Types marked `byCase` are assigned by hand per item (eval/severity/calibration-hand.json); `default` is
 * used only when no hand assignment exists. Positives (label same) are S0.
 */
export const TYPE_MAP = Object.freeze({
  positive: {default: 'S0'},
  flip_negation: {default: 'S4'},
  swap_names: {default: 'S4'},
  replace_name: {default: 'S4'},
  change_number_date: {default: 'S4'},
  change_quantifier: {default: 'S4'},
  add_fact: {default: 'S4', note: 'an invented sentence is invented content'},
  change_question_type: {default: 'S3', byCase: true},
  drop_fact: {default: 'S2', byCase: true, note: 'S3 when the only question or the key constraint is dropped'},
  change_connective: {default: 'S3', byCase: true, note: 'if -> because makes a question an asserted fact (S4); and -> or is S3'},
  change_preposition: {default: 'S3', byCase: true, note: 'before/after or to/from reversals are S4, garbled prepositions S3'},
  change_relation: {default: 'S3', byCase: true, note: 'reversed relations (manage/report, parent/child, borrow/lend, attend/skip) are S4'},
});
