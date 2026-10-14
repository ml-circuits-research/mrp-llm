/**
 * `conditional`: the assumptions an answer rests on, PER ROW, verified (the two-run lowering of 4.2 item 6 as revised in round 3).
 *
 * Assumptions are the facts with status supposed, hedged or reported (knowledge or query circuit) and the governed wires the
 * query supposes with `if`. For every unit (a row of the answer, or the whole answer when there are no rows):
 *   1. leave-one-out: S = the assumptions whose removal alone makes the unit disappear (or the answer change);
 *   2. verification run: observed facts plus S only. If the unit still holds, S is exact;
 *   3. otherwise leave-one-out was not exact (a row needing c and (a or b) gives [c]); the unit is then conditional on ALL
 *      assumptions with `conditional_unknown: true` (sound, not minimal).
 * The packet list is the union over the units. A supposition that REMOVES a row (negation as failure) marks the packet
 * `nonmonotone`. Conditional answers are never promoted to evidence.
 * Same algorithm as eval/smoke-reasoning/lib/conditional.mjs, run natively on the strategy's own solver instead of through the
 * text of the circuits.
 */
const rowKey = x => JSON.stringify(Object.entries(x).sort());
const sig = r => JSON.stringify({status: r.status, rows: (r.rows ?? []).map(rowKey).sort(), count: r.count, plan: r.plan?.names, hypotheses: r.hypotheses?.map(h => [...h].sort()).sort(), effects: r.effects?.map(e => e.candidate + ':' + e.effect)});
const rowKeys = r => new Set((r.rows ?? []).map(rowKey));

/** `solve(excluded: Set<string>)` returns a packet; `ids` are the assumption ids in a stable order. */
export function withConditional(ids, solve) {
  const full = solve(new Set());
  if (!ids.length || ['budget_exhausted', 'not_expressible'].includes(full.status)) return full;
  const loo = new Map(ids.map(id => [id, solve(new Set([id]))]));
  const observed = solve(new Set(ids));
  const keepOnly = S => solve(new Set(ids.filter(i => !S.includes(i))));
  const rows = full.rows ?? [];
  const units = rows.length ? rows.map(r => ({row: r, key: rowKey(r)})) : [{row: null}];
  const holds = (res, u) => (u.row ? rowKeys(res).has(u.key) && res.status === full.status : sig(res) === sig(full));
  const perRow = [];
  let anyUnknown = false;
  for (const u of units) {
    const S = ids.filter(id => !holds(loo.get(id), u));
    const verified = S.length === ids.length ? true : holds(keepOnly(S), u);
    perRow.push({...(u.row ? {row: u.row} : {}), conditional: verified ? S : ids, ...(verified ? {} : {conditional_unknown: true})});
    if (!verified) anyUnknown = true;
  }
  const nonmonotone = [...rowKeys(observed)].some(k => !rowKeys(full).has(k)) || (observed.status === 'supported' && full.status === 'refuted');
  const union = [...new Set(perRow.flatMap(p => p.conditional))];
  if (nonmonotone) for (const id of ids) if (!union.includes(id) && sig(loo.get(id)) !== sig(full)) union.push(id);
  const out = {...full};
  if (union.length) out.conditional = union;
  if (rows.length) out.row_conditional = perRow;
  if (nonmonotone) out.nonmonotone = true;
  if (anyUnknown) out.conditional_unknown = true;
  return out;
}
