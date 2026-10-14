/**
 * The universal lowering for `conditional` (round 3, MUST-FIX 2 of review round 2: per ROW and verified).
 *
 * A strategy need not know about suppositions. The host finds the ASSUMPTION WIRES of a case (facts whose status is
 * supposed, hedged or reported, in the knowledge or the query circuit; governed wires of approval proposed or rejected
 * that the query supposes with `if`; a contested wire binds and is flagged, it is not an assumption) and runs the strategy on the full case.
 *
 * `conditional` is PER ROW (the renderer says "Ann, if she works there, and Bob."), and the packet's list is the union.
 * For every unit (a row of a select, or the whole answer when there are no rows):
 *   1. leave-one-out: S = the assumptions whose removal alone makes the unit disappear (or the answer change);
 *   2. VERIFICATION run: the case with observed facts plus S only (every other assumption removed). If the unit still
 *      holds, S is exact: the unit is conditional on S (an empty S with a passing verification means unconditional).
 *   3. If the verification fails, leave-one-out was not exact (the counterexample: facts a, b, c where the row needs c
 *      and (a or b): leave-one-out gives [c] although "if c" is wrong when neither a nor b holds). The unit is then
 *      conditional on ALL assumptions and carries `conditional_unknown: true`: the list is sound but not minimal.
 *      (A greedy growth of S would give one sufficient set; the minimal set is not unique, so the host does not pretend.)
 * "Exact for monotone programs" is NOT claimed: leave-one-out is exact only when the verification passes.
 * Under negation as failure the effect of an assumption can be to remove a row, so if a row of the observed-only run is
 * absent from the full run the packet says `nonmonotone: true` (the renderer must not say "and also").
 * Conditional answers are never promoted to evidence or stored.
 */
import {parse} from '../validator.mjs';
import {wireText} from './desugar.mjs';

const f1 = (w, k) => w.fields.find(f => f.key === k)?.value.trim();
const isAssumption = w => w.type === 'fact' && ['supposed', 'hedged', 'reported'].includes(f1(w, 'status'));

export function assumptionIds(c) {
  const kn = parse(c.knowledge).wires, qw = parse(c.query).wires;
  const facts = [...kn, ...qw].filter(isAssumption).map(w => w.id);
  // a governed wire or an amendment the query supposes with `if` is an assumption too (cases 30c and 36), under the id written after the `if`
  const supposed = qw.filter(w => w.type === 'query').flatMap(w => w.fields.filter(f => f.key === 'if').map(f => f.value.trim().slice(1))).filter(id => kn.some(w => w.id === id && w.type !== 'fact'));
  return [...new Set([...facts, ...supposed])];
}

export function without(text, ids) {
  const {wires} = parse(text);
  const keep = wires.filter(w => !ids.includes(w.id));
  for (const w of keep) w.fields = w.fields.filter(f => !(f.key === 'if' && ids.includes(f.value.trim().slice(1))));
  return keep.map(wireText).join('\n\n') + '\n';
}

const rowKey = x => JSON.stringify(Object.entries(x).sort());
const sig = r => JSON.stringify({status: r.status, rows: (r.rows ?? []).map(rowKey).sort(), count: r.count});
const rowKeys = r => new Set((r.rows ?? []).map(rowKey));

export async function runConditional(run, c) {
  const ids = assumptionIds(c);
  const full = await run(c);
  if (!ids.length) return {...full, conditional: undefined};
  const variant = rm => run({...c, knowledge: without(c.knowledge, rm), query: without(c.query, rm)});
  const loo = new Map();
  for (const id of ids) loo.set(id, await variant([id]));
  const observed = await variant(ids);
  const keepOnly = async S => variant(ids.filter(i => !S.includes(i)));
  const rows = (full.rows ?? []);
  const units = rows.length ? rows.map(r => ({row: r, key: rowKey(r)})) : [{row: null}];
  const holds = (res, u) => (u.row ? rowKeys(res).has(u.key) && res.status === full.status : sig(res) === sig(full));
  const perRow = [];
  let anyUnknown = false;
  for (const u of units) {
    const S = ids.filter(id => !holds(loo.get(id), u));
    let unknown = false, list = S;
    const verified = S.length === ids.length ? true : holds(await keepOnly(S), u);
    if (!verified) { list = ids; unknown = true; anyUnknown = true; }
    perRow.push({...(u.row ? {row: u.row} : {}), conditional: list, ...(unknown ? {conditional_unknown: true} : {})});
  }
  const nonmonotone = [...rowKeys(observed)].some(k => !rowKeys(full).has(k)) || (observed.status === 'supported' && full.status === 'refuted');
  const out = {...full};
  const union = [...new Set(perRow.flatMap(p => p.conditional))];
  // a supposition that REMOVES a row (negation as failure) changes the answer without being needed by any remaining row:
  // the packet list still names it, because the answer as a whole depends on it
  if (nonmonotone) for (const id of ids) if (!union.includes(id) && sig(loo.get(id)) !== sig(full)) union.push(id);
  if (full.conditional && !union.length) out.conditional = ids; // the strategy itself said conditional: keep its claim
  else out.conditional = union.length ? union : undefined;
  if (rows.length) out.row_conditional = perRow;
  if (nonmonotone) out.nonmonotone = true;
  if (anyUnknown) out.conditional_unknown = true;
  return out;
}
