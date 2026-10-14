/**
 * Verification by agreement (owner decision 2026-10-03): two DIFFERENT formalizations of the same problem that give the same answers on
 * the problem's own numbers verify each other; a direct model answer is verified when a symbolic formalization gives an equivalent
 * answer (lib/formalize/equivalence.mjs, symbolic checks first; its model tier is not used).
 *
 *   sameValue / valuesAgree   two values (numbers with a relative tolerance of 1e-6, text folded) and two answer sets (the distinct
 *                             values of each side, nonempty, the same size, every value of one side matched on the other)
 *   agreementGroups           the answered path results clustered by agreement, in priority order
 *   decideAgreement           verified (a group of two or more), unverified (one answered path), unresolved (several, none agree), or
 *                             none (nothing answered); the answer comes from the first path of the chosen group
 *   directVerdicts            the equivalence verdict of a direct answer against each symbolic path
 * Structure only: values and the equivalence catalog's checks.
 */
import {decide} from '../formalize/equivalence.mjs';

const fold = v => (typeof v === 'string' ? v.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ') : v);
export const sameValue = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a)) : fold(a) === fold(b));

const distinct = values => values.reduce((out, v) => (out.some(x => sameValue(x, v)) ? out : [...out, v]), []);

/** Whether two value lists say the same (as sets of distinct values). */
export function valuesAgree(a, b) {
  const x = distinct(a ?? []), y = distinct(b ?? []);
  return x.length > 0 && x.length === y.length && x.every(v => y.some(w => sameValue(v, w)));
}

/** The answered results (values present) clustered by agreement with each cluster's first member, in the given order. */
export function agreementGroups(results) {
  const groups = [];
  for (const r of results.filter(x => x?.values?.length)) {
    const g = groups.find(group => valuesAgree(group[0].values, r.values));
    if (g) g.push(r); else groups.push([r]);
  }
  return groups;
}

/**
 * The verification of symbolic path results (priority order: the first is the primary formalization):
 * {status: verified|unverified|unresolved|none, chosen, paths (agreeing), alternatives: [{path, values}], sameCall}.
 */
export function decideAgreement(results) {
  const answered = results.filter(r => r && ['ok'].includes(r.status));
  const groups = agreementGroups(answered);
  const best = groups.reduce((b, g) => (!b || g.length > b.length ? g : b), null);
  const alt = except => answered.filter(r => !except.includes(r)).map(r => ({path: r.path, values: r.values}));
  if (best && best.length >= 2) {
    // Languages of one engineCode reply agreeing are two formalizations from one model call (reported, still verified).
    const calls = new Set(best.map(r => (r.path.startsWith('engineCode:') ? 'engineCode' : r.path)));
    return {status: 'verified', chosen: best[0], paths: best.map(r => r.path), alternatives: alt(best), sameCall: calls.size === 1};
  }
  // An answered path without values (an empty `which` list) is an answer too, but it cannot agree with another.
  if (answered.length === 1) return {status: 'unverified', chosen: answered[0], paths: [answered[0].path], alternatives: [], sameCall: false};
  if (answered.length > 1) return {status: 'unresolved', chosen: answered[0], paths: [answered[0].path], alternatives: alt([answered[0]]), sameCall: false};
  return {status: 'none', chosen: null, paths: [], alternatives: [], sameCall: false};
}

/** The text of a path's values for the equivalence check (one value, or the values joined as a list). */
export const valuesText = values => (values.length === 1 ? values[0] : values.map(v => (typeof v === 'string' ? v : String(v))).join(', '));

/** The verdict of a direct answer (text) against a symbolic path: {verdict: equivalent|different|unknown, check}. */
export async function directVerdict(directText, result, ctx = {}) {
  if (!result?.values?.length || directText == null) return {verdict: 'unknown', check: null};
  return decide(directText, valuesText(result.values), {ordered: false, ...ctx, tier: null});
}
