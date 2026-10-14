/**
 * Dates of ingestion v2 as typed values (owner design 2026-10-03: dates are values, not symbols). The knowledge language has no date
 * term, so a calendar date is the integer YYYYMMDD (comparable, and computable by the integer `compute` words); a year alone is the
 * year. Normalisation reuses the runtime's time reader (sop/linking.mjs `normalizeTime`); ISO dates are found by their digits. The date
 * functions of the FOL inventory are lowered here to `compute` lines over plus, minus, times and whole_divided_by only (the integer
 * words every engine reproduces):
 *   months_between(a, b)  complete calendar months from a to b: (yb*12 + mb) - (ya*12 + ma), minus 1 when the day of b is before the
 *                         day of a ((da - db + 99) whole_divided_by 100 is 1 exactly then, for days 1..31)
 *   years_between(a, b)   months_between whole_divided_by 12
 *   add_months(d, n)      t = y*12 + (m - 1) + n; the date (t whole_divided_by 12)*10000 + (t - 12*(t whole_divided_by 12) + 1)*100 + day
 *   add_years(d, n)       add_months(d, 12n)
 * Structure only: digits and calendar arithmetic, no phrasing is interpreted.
 */
import {normalizeTime} from '../../../sop/linking.mjs';

const DAY = 86_400_000;
const ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const pad = (n, k = 2) => String(n).padStart(k, '0');

/** A date text as {text, value, kind: 'day'|'year'} (value YYYYMMDD for a day, the year for a year), or null. */
export function dateValue(text) {
  const t = String(text ?? '').trim();
  const p = normalizeTime(t, Date.UTC(2000, 0, 1));
  if (!p || !Number.isFinite(p.from)) return null;
  const d = new Date(p.from);
  if (p.until - p.from === DAY) return {text: t, value: Number(`${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`), kind: 'day'};
  if (/^\d{4}$/.test(t)) return {text: t, value: d.getUTCFullYear(), kind: 'year'};
  return null;
}

/** The day dates of a text: ISO dates by their digits, plus the given candidate spans (the structure pass's date values). */
export function datesOf(text, candidates = []) {
  const out = new Map();
  for (const m of String(text ?? '').matchAll(ISO)) { const v = dateValue(m[0]); if (v) out.set(v.text, v); }
  for (const c of candidates) { const v = dateValue(c); if (v?.kind === 'day') out.set(v.text, v); }
  return [...out.values()];
}

/** YYYYMMDD back to ISO (for reports). */
export const isoOf = n => { const s = String(n); return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : s; };

export const DATE_FUNCTIONS = Object.freeze(['months_between', 'years_between', 'add_months', 'add_years']);

/**
 * `compute` lines for a date function: fn(name), args (SOP terms: ?vars or integers), out (?var), fresh() → a new ?var.
 * Returns the condition lines (without the `when ` prefix).
 */
export function dateCompute(name, args, out, fresh) {
  const lines = [];
  const c = (word, a, b, v = fresh()) => { lines.push(`compute ${v} ${a} ${word} ${b}`); return v; };
  const parts = d => {
    const y = c('whole_divided_by', d, 10000), ym = c('whole_divided_by', d, 100);
    const m = c('minus', ym, c('times', y, 100)), day = c('minus', d, c('times', ym, 100));
    return {y, m, day};
  };
  const months = (a, b, v) => {
    const A = parts(a), B = parts(b);
    const ia = c('plus', c('times', A.y, 12), A.m), ib = c('plus', c('times', B.y, 12), B.m);
    const borrow = c('whole_divided_by', c('plus', c('minus', A.day, B.day), 99), 100);
    return c('minus', c('minus', ib, ia), borrow, v);
  };
  const addMonths = (d, n, v) => {
    const D = parts(d);
    const t = c('plus', c('plus', c('times', D.y, 12), c('minus', D.m, 1)), n);
    const y2 = c('whole_divided_by', t, 12), m2 = c('plus', c('minus', t, c('times', y2, 12)), 1);
    return c('plus', c('plus', c('times', y2, 10000), c('times', m2, 100)), D.day, v);
  };
  if (name === 'months_between') months(args[0], args[1], out);
  else if (name === 'years_between') c('whole_divided_by', months(args[0], args[1]), 12, out);
  else if (name === 'add_months') addMonths(args[0], args[1], out);
  else if (name === 'add_years') addMonths(args[0], c('times', args[1], 12), out);
  else throw new Error(`unknown date function ${name}`);
  return lines;
}

/** The same functions on numbers (a ground term is evaluated at conversion time). */
export function dateEval(name, args) {
  const parts = d => ({y: Math.trunc(d / 10000), m: Math.trunc(d / 100) % 100, day: d % 100});
  const months = (a, b) => { const A = parts(a), B = parts(b); return (B.y * 12 + B.m) - (A.y * 12 + A.m) - Math.trunc((A.day - B.day + 99) / 100); };
  const addMonths = (d, n) => { const D = parts(d); const t = D.y * 12 + D.m - 1 + n; return Math.trunc(t / 12) * 10000 + (t % 12 + 1) * 100 + D.day; };
  if (name === 'months_between') return months(args[0], args[1]);
  if (name === 'years_between') return Math.trunc(months(args[0], args[1]) / 12);
  if (name === 'add_months') return addMonths(args[0], args[1]);
  if (name === 'add_years') return addMonths(args[0], 12 * args[1]);
  throw new Error(`unknown date function ${name}`);
}
