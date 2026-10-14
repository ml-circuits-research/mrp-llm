/**
 * The book answer of an item as a scorable gold (eval-side, never product code): a yes/no, numbers, or names; null for an
 * explanation answer (not scored by this probe). A numeric gold whose answer text's first sentence states none of its numbers is a
 * structural gold defect (the numbers are incidental to a text answer) and is not scored.
 */
export function goldOf(item) {
  const v = item.answer_value;
  if (item.answer_kind === 'yes_no' && typeof v === 'boolean') return {kind: 'yes_no', values: [v]};
  const list = [].concat(v ?? []);
  if (['number', 'number_text', 'list'].includes(item.answer_kind) && list.length && list.every(x => typeof x === 'number')) {
    const first = String(item.answer ?? '').split(/(?<=[.!?])\s+/)[0].replace(/(\d),(\d{3})/g, '$1$2');
    const nums = [...first.matchAll(/-?\d+(?:\.\d+)?/g)].map(m => Number(m[0]));
    const near = (a, b) => Math.abs(a - b) <= Math.max(1e-9, 0.005 * Math.abs(b));
    if (item.answer && !list.some(g => nums.some(t => near(t, g) || near(t / 100, g) || near(t * 100, g)))) return null;
    return {kind: 'number', values: list};
  }
  if (['entity', 'list'].includes(item.answer_kind) && list.length && list.every(x => typeof x === 'string' && x.trim())) return {kind: 'names', values: list.flatMap(x => x.split(/\s*,\s*/)).filter(Boolean)};
  return null;
}
