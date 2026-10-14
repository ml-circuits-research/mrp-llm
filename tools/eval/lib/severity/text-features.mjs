/** Text features the mechanical severity checks compare (numbers, dates, accent-folded words). Plain string processing; no analysis, no model. */
const DATE_WORDS = new Set('january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday'.split(' '));

export const fold = text => String(text).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** The numbers (and date words) written in a text, normalized. */
export function rawNumbers(text) {
  const out = [];
  for (const d of String(text ?? '').match(/\d+(?:[.,]\d+)*/g) ?? []) out.push(String(Number(d.replace(/,(?=\d{3}\b)/g, '').replace(',', '.'))));
  for (const w of String(text ?? '').toLowerCase().match(/\p{L}+/gu) ?? []) if (DATE_WORDS.has(w) && !(w === 'may' && !/\bMay\b/.test(text))) out.push('date:' + w.slice(0, 3));
  return out;
}
