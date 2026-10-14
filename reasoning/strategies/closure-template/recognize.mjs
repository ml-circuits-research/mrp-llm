/**
 * Recognise a transitive-closure rule pair in a compiled program (VRC `reach.mjs` `discoverReach`, soplab `graph` wire):
 *
 *   base   P(X,Y) :- E(X,Y)
 *   step   P(X,Y) :- E(X,M), P(M,Y)        (right linear)
 *          P(X,Y) :- P(X,M), E(M,Y)        (left linear)
 *          P(X,Y) :- P(X,M), P(M,Y)        (non-linear: the same closure)
 *
 * with E extensional (facts only, no rule derives it), P defined by exactly these two rules and no facts of its own, E and P without
 * negative facts and without validity intervals. Any other shape returns null: the template never partially applies.
 */
import {isVarTerm} from '../js-reference/values.mjs';

const plainAtom = l => l.kind === 'atom' && l.mode === 'pos' && l.args.length === 2 && l.args.every(isVarTerm);
const v = t => t.var;

/** Does the body `leaves` with head variables (x, y) have the shape of the base rule over some E? Returns E or null. */
function baseShape(rule) {
  if (rule.alts.length !== 1 || rule.head.neg || rule.head.args.length !== 2) return null;
  const [hx, hy] = rule.head.args.map(a => (isVarTerm(a) ? a.var : null));
  const leaves = rule.alts[0].leaves;
  if (!hx || !hy || hx === hy || leaves.length !== 1 || !plainAtom(leaves[0])) return null;
  const [bx, by] = leaves[0].args.map(v);
  return bx === hx && by === hy ? leaves[0].p : null;
}

/** The step rule: returns {kind: 'right'|'left'|'both', edge} or null. */
function stepShape(rule, P) {
  if (rule.alts.length !== 1 || rule.head.neg || rule.head.args.length !== 2) return null;
  const [hx, hy] = rule.head.args.map(a => (isVarTerm(a) ? a.var : null));
  const leaves = rule.alts[0].leaves;
  if (!hx || !hy || hx === hy || leaves.length !== 2 || !leaves.every(plainAtom)) return null;
  for (const [p, q] of [[leaves[0], leaves[1]], [leaves[1], leaves[0]]]) {
    const [a, m] = p.args.map(v), [c, d] = q.args.map(v);
    if (a !== hx || c !== m || d !== hy || m === hx || m === hy) continue;
    if (p.p === P && q.p === P) return {kind: 'both', edge: null};
    if (p.p !== P && q.p === P) return {kind: 'right', edge: p.p};
    if (p.p === P && q.p !== P) return {kind: 'left', edge: q.p};
  }
  return null;
}

/**
 * Find the closure template for predicate P in `program` (compileProgram output after governance and desugaring).
 * Returns {P, E, kind, baseRule, stepRule} or null.
 */
export function recognizeClosure(program, P) {
  const rules = program.rules.filter(r => r.head.p === P);
  if (rules.length !== 2) return null;
  if (program.aggregates.some(a => a.yields.p === P)) return null;
  let base = null, step = null, E = null, kind = null;
  for (const r of rules) {
    const b = baseShape(r);
    if (b && b !== P) { if (base) return null; base = r; E = b; continue; }
    const s = stepShape(r, P);
    if (s) { if (step) return null; step = r; kind = s.kind; if (s.edge) { if (E && E !== s.edge) return null; E = E ?? s.edge; } continue; }
    return null;
  }
  if (!base || !step || !E || E === P) return null;
  if (kind !== 'both' && stepShape(step, P).edge !== E) return null;
  if (program.rules.some(r => r.head.p === E) || program.aggregates.some(a => a.yields.p === E)) return null;
  const factsOf = p => program.facts.filter(f => f.p === p);
  if (factsOf(P).length) return null;
  if (factsOf(E).some(f => f.neg || f.valid !== null || f.args.length !== 2)) return null;
  return {P, E, kind, baseRule: base, stepRule: step};
}
