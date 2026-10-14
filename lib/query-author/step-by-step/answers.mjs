/**
 * Robust readers of the oracle's short answers (DS022 "LocalLLMStepByStep"). The model answers in plain text: a number, a list of
 * numbers, yes/no, lettered lines, dates or lines of arithmetic. Each reader returns `null` when the answer does not contain what was
 * asked; it never guesses a default, so the strategy can re-ask once or stop honestly.
 */
const strip = text => String(text ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/\*\*/g, '').trim();

/** One option number in 1..max (the first one written), or `null`. `0` is accepted when `zero` (the "none of these" option). */
export function readChoice(text, max, {zero = false} = {}) {
  for (const m of strip(text).matchAll(/(?<![\d.-])(\d{1,3})(?![\d])/g)) {
    const n = Number(m[1]);
    if ((n >= 1 && n <= max) || (zero && n === 0)) return n;
  }
  return null;
}

/** Distinct option numbers in 1..max in the order written, or `null` when none; `[0]` when only "none" (0) was answered. */
export function readChoices(text, max) {
  const picked = [];
  for (const m of strip(text).matchAll(/(?<![\d.-])(\d{1,3})(?![\d])/g)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= max && !picked.includes(n)) picked.push(n);
  }
  if (picked.length) return picked;
  return /(?<![\d.-])0(?![\d])|\bnone\b/i.test(strip(text)) ? [0] : null;
}

/** yes → true, no → false, otherwise `null`. */
export function readYesNo(text) {
  const t = strip(text).toLowerCase();
  if (/^\W*(yes|y|da|correct|true)\b/.test(t)) return true;
  if (/^\W*(no|n|nu|incorrect|false)\b/.test(t)) return false;
  return null;
}

/** Lettered assignments such as `A: 2`, `B = 1` or `A - 3` → {A: 2, B: 1}; only letters of `letters`, numbers 1..max. */
export function readLetters(text, letters, max) {
  const out = {};
  for (const m of strip(text).matchAll(/\b([A-Z])\b\s*(?:[:=\-–)]|is|->)\s*(\d{1,3})\b/g)) {
    const n = Number(m[2]);
    if (letters.includes(m[1]) && n >= 1 && n <= max && !(m[1] in out)) out[m[1]] = n;
  }
  return Object.keys(out).length === letters.length ? out : null;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const pad = n => String(n).padStart(2, '0');

/** ISO calendar dates (YYYY-MM-DD) in the text, in order and validated; "April 1, 2026" is read too. */
export function readDates(text) {
  const t = strip(text), found = [];
  const push = (y, m, d) => {
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d) found.push(`${y}-${pad(m)}-${pad(d)}`);
  };
  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) push(Number(m[1]), Number(m[2]), Number(m[3]));
  if (!found.length) {
    const year = /\b(19|20)\d{2}\b/.exec(t)?.[0];
    for (const m of t.matchAll(new RegExp(`\\b(${MONTHS.join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`, 'gi')))
      if (m[3] ?? year) push(Number(m[3] ?? year), MONTHS.indexOf(m[1].toLowerCase()) + 1, Number(m[2]));
  }
  return [...new Set(found)];
}

/** Does a message mention a calendar time (a readable date or a stand-alone year)? Decides whether the time steps run at all. */
export function mentionsTime(message) {
  return readDates(message).length > 0 || /(?<![\w-])(19|20)\d{2}(?![\w-])/.test(message);
}

const COMPARATORS = [['<=', 'at_most'], ['>=', 'at_least'], ['!=', 'not_equal'], ['≠', 'not_equal'], ['≤', 'at_most'], ['≥', 'at_least'], ['==', 'equal'], ['=', 'equal'], ['<', 'below'], ['>', 'above']];
const OPERATORS = {'+': 'plus', '-': 'minus', '−': 'minus', '*': 'times', '×': 'times', '·': 'times', '/': 'divided_by'};

/**
 * One arithmetic side (`2x + y`, `3*a - 4`) as SOP words (`2 times ?x plus ?y`), with the declared unknown names; `null` for anything
 * else (parentheses, an unknown name, a decimal). Implicit products (`2x`) are made explicit.
 */
export function readExpression(text, names) {
  const t = String(text).trim().replace(/\s+/g, '');
  if (!t || /[()]/.test(t)) return null;
  const tokens = [];
  const re = /(\d+)([a-z]\w*)?|([a-z]\w*)|([+\-−*×·/])/giy;
  let m, at = 0;
  while (at < t.length) {
    re.lastIndex = at;
    m = re.exec(t);
    if (!m) return null;
    at = re.lastIndex;
    if (m[1] !== undefined) { tokens.push(m[1]); if (m[2]) tokens.push('*', m[2]); }
    else if (m[3]) tokens.push(m[3]);
    else tokens.push(m[4]);
  }
  if (tokens[0] === '-' || tokens[0] === '−') { if (!/^\d+$/.test(tokens[1] ?? '')) return null; tokens.splice(0, 2, '-' + tokens[1]); }
  const words = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (i % 2 === 1) { if (!OPERATORS[token]) return null; words.push(OPERATORS[token]); continue; }
    if (/^-?\d+$/.test(token)) words.push(token);
    else if (names.includes(token.toLowerCase())) words.push('?' + token.toLowerCase());
    else return null;
  }
  return words.length % 2 === 1 ? words.join(' ') : null;
}

/** One line `LEFT CMP RIGHT` as `{left, comparator, right}` in SOP words, or `null`. */
export function readComparison(line, names) {
  const text = String(line).replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim();
  for (const [symbol, comparator] of COMPARATORS) {
    const at = text.indexOf(symbol);
    if (at < 0) continue;
    const left = readExpression(text.slice(0, at), names), right = readExpression(text.slice(at + symbol.length), names);
    return left && right ? {left, comparator, right} : null;
  }
  return null;
}

/** Unknown declarations `x: 0 to 10` (or `x from 0 to 10`, `0 <= x <= 10`), one per line → [{name, min, max}]. */
export function readUnknowns(text) {
  const out = [];
  for (const raw of strip(text).split('\n')) {
    const line = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '');
    let m = /^\s*([a-z]\w*)\s*(?::|from|is|in)?\s*(?:between\s+)?(-?\d+)\s*(?:to|and|-|–|\.\.)\s*(-?\d+)(?![\d-])/i.exec(line);
    if (m) { out.push({name: m[1].toLowerCase(), min: Number(m[2]), max: Number(m[3])}); continue; }
    // A line that starts like a declaration ("y: …") but does not read as one makes the whole answer unreadable (asked again).
    if (/^\s*[a-z]\w*\s*:/i.test(line)) return null;
    m = /^\s*(-?\d+)\s*<=?\s*([a-z]\w*)\s*<=?\s*(-?\d+)/i.exec(line);
    if (m) out.push({name: m[2].toLowerCase(), min: Number(m[1]), max: Number(m[3])});
  }
  const names = out.map(u => u.name);
  return out.length && new Set(names).size === names.length && out.every(u => u.min <= u.max) ? out : null;
}

