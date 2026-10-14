/**
 * Equivalence of two SHORT answers, decided symbolically wherever possible (owner, 2026-10-03): a catalog of small checks, each
 * returning `equivalent`, `different` or `unknown`, tried in order; the first decisive verdict wins and names its check. The model tier
 * is the last resort, only for free-text paraphrases, only when its calibration showed no false positive; otherwise `unknown` counts as
 * not equivalent. A false "equivalent" creates a wrong verified answer, so every check prefers `unknown` to a guess.
 *
 *   structural  yes/no and true/false; numbers with the tolerance of the precision the answer states (58.89 against 58.8888), a
 *               percentage against its fraction, signs; times of day in any format (08:40 = 8:40 am; a number against a time is read as
 *               minutes since midnight); option and plan labels as exact identifiers (Plan A is never Plan B)
 *   lists       several items: a sequence when the caller says the order matters, a set otherwise, each item compared by the catalog
 *   units       a quantity with a unit against another (or against a bare number in a unit the problem names), converted through the
 *               memory's unit facts (`unit_amount`, `unit_dimension` compiled into the lexicon, sop/quantities.mjs)
 *   entities    both answers link, through the memory's lexicon (labels and aliases), to entities: the same id is equivalent, two
 *               different ids are different; no alias is written in code
 *   entailment  answers that are statements "<thing> is [not] <property>" are formalized as tiny claims and the reasoner decides
 *               A ⊨ B and B ⊨ A under the problem's rules (`entail`, injected: the caller's deduce engine)
 *   tier        the injected model check for what is left, only for answers without numbers or labels
 *
 * Structure only: numbers by their digits, times by their clock format, units and names through the memory; nothing here interprets
 * phrasing beyond the statement shape of the entailment check (the controlled-English form the formalizers already write).
 */

export const VERDICTS = Object.freeze(['equivalent', 'different', 'unknown']);
const EQ = 'equivalent', DIFF = 'different', UNK = 'unknown';

const fold = s => String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[“”"'`*]/g, '').replace(/\s+/g, ' ').trim();
const stripArticles = s => s.replace(/^(?:the|a|an)\s+/, '').replace(/[.!]+$/, '').trim();

// ---------------------------------------------------------------- readers (structure)

/** yes/no from an answer (a boolean, or text that starts with yes/no/true/false and says nothing else but a reason), or null. */
export function yesNoOf(x) {
  if (typeof x === 'boolean') return x;
  const m = /^\W*(yes|no|true|false)\b(.*)$/i.exec(fold(x));
  if (!m) return null;
  return /^(yes|true)$/i.test(m[1]);
}

/** A number with its stated precision: {value, step} (step = half a unit of the last stated decimal; 0 for a whole or computed number). */
export function numberOf(x) {
  if (typeof x === 'number') return Number.isFinite(x) ? {value: x, step: 0, percent: false} : null;
  const s = fold(x).replace(/(\d),(\d{3})\b/g, '$1$2');
  const m = /^([-+−]?\d+(?:\.\d+)?)\s*(%|percent)?\s*([a-z][a-z ]*)?$/.exec(s);
  if (!m) return null;
  const text = m[1].replace('−', '-'), dec = (text.split('.')[1] ?? '').length;
  // A stated decimal carries its precision (58.89: ±0.005); a whole number is exact (59 is not 58.4, 2 hours is not 150 minutes).
  return {value: Number(text), step: dec ? 0.5 * 10 ** -dec : 0, percent: Boolean(m[2]), unit: m[3]?.trim() || null};
}

/** A time of day in minutes since midnight ("08:40", "8:40 am", "20:40", "8.40 pm"), or null. */
export function timeOf(x) {
  const m = /^(\d{1,2})[:.h](\d{2})\s*(a\.?m\.?|p\.?m\.?)?$/.exec(fold(x));
  if (!m) return null;
  let h = Number(m[1]); const min = Number(m[2]);
  if (min > 59 || h > 24) return null;
  if (m[3]) { if (h > 12) return null; h = h % 12 + (/^p/.test(m[3]) ? 12 : 0); }
  return h * 60 + min;
}

/** The labels of an answer: single letters or letter-digit identifiers (A, B2) and bare numbers after a label word. */
const labelsOf = x => (typeof x === 'string' ? [...String(x).matchAll(/(?<![\p{L}\d.,])([A-Z]\d*|\d+)(?![\p{L}\d.,%])/gu)].map(m => m[1]) : []);

/** The items of a list answer (an array, or text split at commas, semicolons and a final "and"); one item → null. */
export function itemsOf(x) {
  if (Array.isArray(x)) return x.length > 1 ? x : null;
  if (typeof x !== 'string') return null;
  const parts = x.split(/\s*[;,]\s*(?:and\s+)?|\s+and\s+/).map(s => s.trim()).filter(Boolean);
  return parts.length > 1 ? parts : null;
}

// ---------------------------------------------------------------- checks

/** yes/no against yes/no; a yes/no against a number or a time is different. */
function checkYesNo(a, b) {
  const x = yesNoOf(a), y = yesNoOf(b);
  if (x === null && y === null) return UNK;
  if (x !== null && y !== null) {
    if (x !== y) return DIFF;
    // "yes, 28" against "yes, 30": the stated numbers must agree too; a bare yes against "yes, 28" is the asked part.
    const num = v => (typeof v === 'string' ? [...v.matchAll(/-?\d+(?:\.\d+)?/g)].map(m => Number(m[0])) : []);
    const na = num(a), nb = num(b);
    return na.length && nb.length && !na.some(p => nb.includes(p)) ? DIFF : EQ;
  }
  const other = x === null ? a : b;
  return numberOf(other) || timeOf(other) ? DIFF : UNK;
}

/** Times of day; a time against a number is read as minutes since midnight. */
function checkTime(a, b) {
  const x = timeOf(a), y = timeOf(b);
  if (x === null && y === null) return UNK;
  if (x !== null && y !== null) return x === y ? EQ : DIFF;
  const n = numberOf(x === null ? a : b);
  if (!n || n.unit) return UNK;
  return Math.abs(n.value - (x ?? y)) <= Math.max(n.step, 1e-9) ? EQ : UNK;
}

/** Numbers with the tolerance of the stated precision, a percentage against its fraction; different units are left to `units`. */
function checkNumber(a, b) {
  const x = numberOf(a), y = numberOf(b);
  if (!x || !y) return UNK;
  if (x.unit && y.unit && x.unit !== y.unit) return UNK;
  const tol = Math.max(x.step, y.step, 1e-9 * Math.max(1, Math.abs(x.value), Math.abs(y.value)));
  const close = (p, q) => Math.abs(p - q) <= tol + 1e-12;
  if (close(x.value, y.value)) return EQ;
  if (x.percent !== y.percent) {
    // In fraction units: the percentage's value and its stated precision divided by 100.
    const [p, f] = x.percent ? [x, y] : [y, x];
    const t = Math.max(p.step / 100, f.step, 1e-9);
    if (Math.abs(p.value / 100 - f.value) <= t + 1e-12) return EQ;
    return p.unit || f.unit ? UNK : DIFF;
  }
  return x.unit || y.unit ? UNK : DIFF;
}

/** Option and plan labels: two answers that each name labels name the same labels exactly, or they are different. */
function checkLabels(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return UNK;
  const la = labelsOf(a), lb = labelsOf(b);
  if (!la.length || !lb.length) return UNK;
  const same = la.length === lb.length && [...la].sort().join() === [...lb].sort().join();
  if (!same) return DIFF;
  const rest = s => stripArticles(fold(s).replace(/(?<![\p{L}\d])([a-z]\d*|\d+)(?![\p{L}\d])/gu, '').replace(/\s+/g, ' ').trim());
  return rest(a) === rest(b) || !rest(a) || !rest(b) ? EQ : UNK;
}

/** A quantity with a unit (the memory's unit entities and facts) against another, or against a bare number in a unit the problem names. */
function checkUnits(a, b, {lexicon, problem = ''}) {
  const facts = lexicon?.unitFacts ?? {};
  const amount = facts.unit_amount ?? {}, dim = facts.unit_dimension ?? {};
  if (!lexicon?.matching || !Object.keys(amount).length) return UNK;
  const unitId = words => { const r = lexicon.matching(words, {language: 'auto', kind: 'entity', type: 'unit'}); return r.found.length === 1 && amount[r.found[0].id] ? r.found[0].id : null; };
  const q = x => { const n = numberOf(x); if (!n) return null; const u = n.unit ? unitId(n.unit) : null; return {...n, uid: u}; };
  const x = q(a), y = q(b);
  if (!x || !y || (!x.uid && !y.uid)) return UNK;
  const base = v => Number(v.value) * Number(amount[v.uid]);
  const close = (p, q2, tol) => Math.abs(p - q2) <= tol + 1e-9 * Math.max(1, Math.abs(p), Math.abs(q2));
  if (x.uid && y.uid) {
    if (dim[x.uid] !== dim[y.uid]) return DIFF;
    const tol = Math.max(x.step * Number(amount[x.uid]), y.step * Number(amount[y.uid]));
    return close(base(x), base(y), tol) ? EQ : DIFF;
  }
  // A bare number against a quantity: the bare number is read in each unit of the same dimension the problem names.
  const withUnit = x.uid ? x : y, bare = x.uid ? y : x;
  const named = [...new Set(String(problem).toLowerCase().split(/[^a-z]+/).filter(w => w.length > 1).map(unitId).filter(Boolean))].filter(u => dim[u] === dim[withUnit.uid]);
  for (const u of named) if (close(Number(bare.value) * Number(amount[u]), base(withUnit), Math.max(bare.step * Number(amount[u]), withUnit.step * Number(amount[withUnit.uid])))) return EQ;
  return UNK;
}

/** Both answers link to entities of the memory: the same id is equivalent, two different ids are different. */
function checkEntities(a, b, {lexicon}) {
  if (!lexicon?.matching || typeof a !== 'string' || typeof b !== 'string') return UNK;
  const link = s => { const r = lexicon.matching(stripArticles(fold(s)), {language: 'auto', kind: 'entity'}); return r.found.length === 1 ? r.found[0].id : null; };
  const x = link(a), y = link(b);
  if (!x || !y) return UNK;
  return x === y ? EQ : DIFF;
}

/** "<thing> is [not] <property>" → {thing, property, negated}, or null. */
export function statementOf(x) {
  const m = /^(.+?)\s+(?:is|are)\s+(not\s+)?(.+?)\.?$/i.exec(String(x ?? '').trim());
  if (!m) return null;
  return {thing: stripArticles(fold(m[1])), negated: Boolean(m[2]), property: stripArticles(fold(m[3])).replace(/\s+/g, '_')};
}

/** Mutual entailment of two statements under the problem's rules (the injected reasoner). */
async function checkEntailment(a, b, {entail, rules = []}) {
  if (!entail) return UNK;
  const x = statementOf(a), y = statementOf(b);
  if (!x || !y || x.thing !== y.thing) return UNK;
  const atom = s => `${s.negated ? 'not ' : ''}${s.property} ${JSON.stringify(s.thing)}`;
  const ab = await entail([atom(x)], rules, atom(y)), ba = await entail([atom(y)], rules, atom(x));
  if (ab === true && ba === true) return EQ;
  const negate = s => ({...s, negated: !s.negated});
  const contra = await entail([atom(x)], rules, atom(negate(y)));
  return contra === true ? DIFF : UNK;
}

/** Lists: sequences when ordered, sets otherwise; each item by the catalog (without the tier). */
async function checkLists(a, b, ctx) {
  const x = itemsOf(a), y = itemsOf(b);
  if (!x && !y) return UNK;
  if (!x || !y) return UNK;
  if (x.length !== y.length) return DIFF;
  const one = async (p, q) => (await decide(p, q, {...ctx, tier: null, nested: true})).verdict;
  const same = async (p, q) => (await one(p, q)) === EQ || stripArticles(fold(p)) === stripArticles(fold(q));
  const left = [...y];
  for (const p of x) { let k = -1; for (let i = 0; i < left.length; i++) if (await same(p, left[i])) { k = i; break; } if (k < 0) return UNK; left.splice(k, 1); }
  if (!ctx.ordered) return EQ;
  // The same items: in order they are equivalent, in another order different.
  for (let i = 0; i < x.length; i++) if (!(await same(x[i], y[i]))) return DIFF;
  return EQ;
}

/** The model tier for free text only (no digits, no labels), when injected (the caller injects it only after a clean calibration). */
async function checkTier(a, b, {tier}) {
  if (!tier || typeof a !== 'string' || typeof b !== 'string' || /\d/.test(a + b) || labelsOf(a).length || labelsOf(b).length) return UNK;
  const r = await tier(a, b);
  return r === true ? EQ : r === false ? DIFF : UNK;
}

export const CHECKS = Object.freeze([
  ['yes_no', checkYesNo], ['time', checkTime], ['units', checkUnits], ['number', checkNumber], ['labels', checkLabels],
  ['lists', checkLists], ['text', (a, b) => (typeof a === 'string' && typeof b === 'string' && stripArticles(fold(a)) === stripArticles(fold(b)) ? EQ : UNK)],
  ['entities', checkEntities], ['entailment', checkEntailment], ['tier', checkTier]]);

/**
 * The verdict of two short answers: {verdict, check}. `ctx`: {lexicon, problem (text, for the units it names), ordered, entail
 * (async (facts, rules, atom) → true|false|null), rules, tier (async (a, b) → true|false|null), stats (an object counting deciding checks)}.
 */
export async function decide(a, b, ctx = {}) {
  for (const [name, check] of CHECKS) {
    if (name === 'tier' && ctx.nested) continue;
    const v = await check(a, b, ctx);
    if (v !== UNK) { if (ctx.stats && !ctx.nested) ctx.stats[name] = (ctx.stats[name] ?? 0) + 1; return {verdict: v, check: name}; }
  }
  if (ctx.stats && !ctx.nested) ctx.stats.unknown = (ctx.stats.unknown ?? 0) + 1;
  return {verdict: UNK, check: null};
}

/** Equivalent or not (an `unknown` is not equivalent). */
export const equivalent = async (a, b, ctx = {}) => (await decide(a, b, ctx)).verdict === EQ;
