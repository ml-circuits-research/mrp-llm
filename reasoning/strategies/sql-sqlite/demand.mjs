/**
 * Demand from the query, the cheap half of magic sets: when a select, exists, count or explain query reads a recursive relation R only
 * through atoms that all carry the same constants (`path n0 ?t`), and nothing else in the slice reads R, then only the tuples of R with
 * those constants are ever needed. If a linear recursion KEEPS those argument positions (left-linear closure: `path ?x ?z :- path ?x ?y,
 * edge ?y ?z` keeps position 0), the recursive CTE can be seeded and filtered on them, so it walks one component instead of building every
 * pair. A right-linear step (`reach ?x ?y :- edge ?x ?m, reach ?m ?y`) changes position 0, so a bound first argument gives no demand and
 * the closure is computed in full (that is what the full magic-set rewriting adds; it is not done here).
 *
 * Soundness: the restricted relation holds exactly the tuples of the full relation that agree with the constants, because every step
 * keeps the constants; every other consumer is excluded, so nobody can see the difference. `closed` and refutation tests of the query only
 * ask about tuples with those constants, so they are unchanged.
 */
import {isVarTerm} from '../js-reference/values.mjs';

const MODES = ['select', 'exists', 'count', 'explain'];

/** Map('p/arity' -> [{i, value}]) of the constants the query demands of each relation; empty when nothing qualifies. */
export function queryDemand(sp, qp) {
  const out = new Map();
  if (!MODES.includes(qp.mode)) return out;
  const seen = new Map(); // 'p/arity' -> {sig, ok}
  for (const alt of qp.alts) for (const l of alt.leaves) {
    if (l.kind !== 'atom' || l.mode === 'not') continue;
    const k = `${l.p}/${l.args.length}`;
    const consts = l.args.map((a, i) => (isVarTerm(a) ? null : {i, value: a})).filter(Boolean);
    const sig = JSON.stringify(consts);
    const prev = seen.get(k);
    if (!prev) seen.set(k, {consts, sig, ok: l.mode === 'pos' && consts.length > 0});
    else if (prev.sig !== sig || l.mode !== 'pos') prev.ok = false;
  }
  for (const [k, v] of seen) {
    if (!v.ok) continue;
    const [p, arity] = [k.slice(0, k.lastIndexOf('/')), Number(k.slice(k.lastIndexOf('/') + 1))];
    // every reader of p/arity must be a rule that derives p/arity itself (its own recursive step); no aggregate may read it
    const own = r => r.head.p === p && r.head.args.length === arity && !r.head.neg;
    const reads = (alts, pred) => alts.some(a => a.leaves.some(l => (l.kind === 'atom' && l.p === p && l.args.length === arity && l.mode !== 'not') && pred()));
    const foreign = sp.rules.some(r => !own(r) && reads(r.alts, () => true)) || sp.aggregates.some(a => reads(a.alts, () => true));
    if (!foreign) out.set(k, v.consts);
  }
  return out;
}

/** The positions a set of step alternatives (one recursive atom each) keeps: head argument i is the recursive atom's argument i. */
export function preservedPositions(rules, occs, arity) {
  let keep = null;
  rules.forEach((rule, ri) => rule.alts.forEach((alt, ai) => {
    const [j] = occs[ri][ai];
    if (j === undefined) return;
    const rec = alt.leaves[j].args;
    const here = new Set();
    for (let i = 0; i < arity; i++) {
      const h = rule.head.args[i], r = rec[i];
      if (isVarTerm(h) ? isVarTerm(r) && r.var === h.var : !isVarTerm(r) && r === h) here.add(i);
    }
    keep = keep === null ? here : new Set([...keep].filter(i => here.has(i)));
  }));
  return keep ?? new Set();
}
