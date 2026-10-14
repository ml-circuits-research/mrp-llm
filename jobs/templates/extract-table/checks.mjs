/**
 * Checks of extract-table: each record has exactly the requested columns; its quote is an exact passage of the chunk; every non-null
 * value occurs in its quote (whitespace and case folded), so nothing is computed or invented.
 */
const fold = s => String(s).toLowerCase().replace(/\s+/g, ' ').trim();

export function check(item, output, ctx = {}) {
  const columns = ctx.params?.columns ?? [];
  const recs = (output.records ?? []).filter(r => !r.none);
  const problems = [];
  for (const [i, r] of recs.entries()) {
    const keys = Object.keys(r.record ?? {});
    const missing = columns.filter(c => !keys.includes(c)), extra = keys.filter(k => !columns.includes(k));
    if (missing.length || extra.length) problems.push(`record ${i + 1}: columns must be exactly ${columns.join(', ')}${missing.length ? ` (missing ${missing.join(', ')})` : ''}${extra.length ? ` (extra ${extra.join(', ')})` : ''}`);
    if (!fold(item.text).includes(fold(r.quote ?? ''))) problems.push(`record ${i + 1}: the quote is not an exact passage of the text`);
    for (const [k, v] of Object.entries(r.record ?? {})) if (v != null && String(v).trim() && !fold(r.quote ?? '').includes(fold(v))) problems.push(`record ${i + 1}: the value of ${k} (${JSON.stringify(String(v).slice(0, 40))}) is not in its quote`);
  }
  return problems.length ? {ok: false, problems: problems.slice(0, 10), hint: 'Copy values and quotes exactly from the text; use null for a column the text does not give.'} : {ok: true, value: recs.length};
}
