/** Metrics of the graded severity evaluation (DS012 "Graded severity"): Wilson intervals, confusion matrices, S4 recall and false-S4 rate, severity distributions. */
import {SEVERITIES, isGoodEnough} from './scale.mjs';

export function wilson(k, n, z = 1.96) {
  if (!n) return {k, n, rate: null, lo: null, hi: null};
  const p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return {k, n, rate: +p.toFixed(4), lo: +Math.max(0, c - h).toFixed(4), hi: +Math.min(1, c + h).toFixed(4)};
}
export const fmt = w => (w.rate === null ? 'n/a' : `${(w.rate * 100).toFixed(1)}% [${(w.lo * 100).toFixed(1)}, ${(w.hi * 100).toFixed(1)}] (${w.k}/${w.n})`);

/** Confusion matrix rows = gold, columns = predicted over SEVERITIES; pairs [{gold, pred}] (pred null counts as `unjudged`). */
export function confusion(pairs) {
  const m = Object.fromEntries(SEVERITIES.map(g => [g, Object.fromEntries([...SEVERITIES, 'unjudged'].map(p => [p, 0]))]));
  for (const {gold, pred} of pairs) m[gold][pred ?? 'unjudged']++;
  return m;
}
/** Recall of S4 and false-S4 rate; the grader's S4 for a gold below S4 is a false alarm. `adjacent`: share of exact-or-one-step predictions. */
export function summaryMetrics(pairs) {
  const s4 = pairs.filter(p => p.gold === 'S4'), notS4 = pairs.filter(p => p.gold !== 'S4');
  const exact = pairs.filter(p => p.pred === p.gold).length;
  const rank = x => SEVERITIES.indexOf(x);
  const within1 = pairs.filter(p => p.pred && Math.abs(rank(p.pred) - rank(p.gold)) <= 1).length;
  const goodGold = pairs.filter(p => isGoodEnough(p.gold));
  return {
    n: pairs.length,
    exact: wilson(exact, pairs.length), within_one_step: wilson(within1, pairs.length),
    s4_recall: wilson(s4.filter(p => p.pred === 'S4').length, s4.length),
    s4_missed_as_good: wilson(s4.filter(p => isGoodEnough(p.pred ?? '')).length, s4.length),
    false_s4: wilson(notS4.filter(p => p.pred === 'S4').length, notS4.length),
    s4_precision: wilson(pairs.filter(p => p.pred === 'S4' && p.gold === 'S4').length, pairs.filter(p => p.pred === 'S4').length),
    good_enough_agreement: wilson(pairs.filter(p => isGoodEnough(p.gold) === isGoodEnough(p.pred ?? '')).length, pairs.length),
    good_enough_called_catastrophic: wilson(goodGold.filter(p => p.pred === 'S4').length, goodGold.length),
  };
}
export const distribution = list => { const c = Object.fromEntries(SEVERITIES.map(s => [s, 0])); for (const s of list) c[s]++; return c; };
/** Distribution table with Wilson intervals and the headline shares: good enough (S0+S1+S2), catastrophic, NONE. */
export function distributionStats(list) {
  const n = list.length, c = distribution(list);
  return {n, counts: c, shares: Object.fromEntries(SEVERITIES.map(s => [s, wilson(c[s], n)])), good_enough: wilson(c.S0 + c.S1 + c.S2, n), catastrophic: wilson(c.S4, n), none: wilson(c.NONE, n), nuance_or_better: wilson(c.S0 + c.S1, n)};
}
export const matrixMarkdown = m => {
  const cols = [...SEVERITIES, 'unjudged'];
  return ['| gold \\ judged | ' + cols.join(' | ') + ' |', '| --- |' + cols.map(() => ' ---:').join(' |') + ' |', ...SEVERITIES.map(g => `| ${g} | ${cols.map(c => m[g][c]).join(' | ')} |`)].join('\n');
};
