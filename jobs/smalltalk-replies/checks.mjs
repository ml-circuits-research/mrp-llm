/**
 * Checks of smalltalk-replies (pure functions over the parsed JSON lines; structure only, never a reading of the user's words):
 * every requested register has at least `count` variants and no other register appears; each text is non-empty, within the
 * length, uses only the placeholders the situation allows and all it requires (and ends as the situation's shape says); no
 * URL, no long digit run (a phone number or a date would be an invented fact), no braces besides placeholders, no exact
 * duplicate inside the item. The meaning (tone, honesty, safety) is the auditor's job.
 */
const SLOT = /\{\{([a-z][a-z0-9_]*)\}\}/g;
export const norm = text => String(text ?? '').toLowerCase().replace(/[^a-z0-9{} ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** The problems of one variant (empty when it is usable); the builder drops a variant with problems, the same rule. */
export function variantProblems(d, r) {
  const text = String(r.text ?? '').trim();
  const p = [];
  if (!d.registerNames.includes(r.register)) return [`register ${r.register} was not requested (${d.registerNames.join(', ')})`];
  if (!text) return ['empty text'];
  if (text.length > d.maxLen) p.push(`${text.length} characters, the limit is ${d.maxLen}`);
  const used = [...text.matchAll(SLOT)].map(m => m[1]);
  for (const s of used) if (!d.allowed.includes(s)) p.push(`placeholder {{${s}}} is not allowed here${d.allowed.length ? ` (allowed: ${d.allowed.join(', ')})` : ' (none is allowed)'}`);
  for (const s of d.required) if (!used.includes(s)) p.push(`the placeholder {{${s}}} is required`);
  if (/[{}]/.test(text.replace(SLOT, ''))) p.push('braces outside a placeholder');
  if (d.ends && !text.endsWith(d.ends)) p.push(`must end with ${JSON.stringify(d.ends)}`);
  if (/https?:|www\.|\.(com|org|net)\b/i.test(text)) p.push('no web addresses');
  if (/\d[\d\s-]{2,}\d/.test(text.replace(SLOT, ''))) p.push('no numbers of three or more digits (no phone numbers, dates or figures)');
  return p;
}

/** At least this many usable, distinct variants per requested register (one fewer than asked, never below two, never above the count). */
export const needed = d => Math.min(d.count, Math.max(2, d.count - 1));

export function check(item, output) {
  const d = item.data ?? item;
  const problems = [];
  const seen = new Set();
  const per = {};
  for (const r of (output.records ?? []).filter(x => x && typeof x.text === 'string')) {
    const ps = variantProblems(d, r);
    const key = norm(r.text);
    if (seen.has(key)) ps.push('exact duplicate of another variant');
    seen.add(key);
    if (ps.length) { problems.push(`${r.register}: "${String(r.text).trim().slice(0, 60)}": ${ps.join('; ')}`); continue; }
    per[r.register] = (per[r.register] ?? 0) + 1;
  }
  const short = d.registerNames.filter(reg => (per[reg] ?? 0) < needed(d));
  // Unusable variants are dropped by the builder; the item fails only when a register has too few usable ones.
  if (!short.length) return {ok: true, value: Object.values(per).reduce((a, b) => a + b, 0)};
  return {ok: false, problems: [...short.map(reg => `register ${reg}: ${per[reg] ?? 0} usable variants, ${d.count} are asked`), ...problems].slice(0, 12),
    hint: `Write exactly ${d.count} variants for each of: ${d.registerNames.join(', ')}; use only the placeholders listed; stay within ${d.maxLen} characters.`};
}
