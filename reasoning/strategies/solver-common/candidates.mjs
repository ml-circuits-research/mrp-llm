/**
 * Candidate EDB atoms for why_not (proposal 4.4): base atoms (a predicate that is not derived, or has stored facts) over the
 * constants of the slice and the goal, respecting the declared argument types. A negative candidate (`not p a`) is offered only for
 * predicates that some body reads through `not`.
 */
import {isVarTerm} from '../js-reference/values.mjs';

export function candidateAtoms(program, facts, goalAlts, {maxCandidates = 4096} = {}) {
  const derived = new Set([...program.rules.map(r => r.head.p), ...program.aggregates.map(a => a.yields.p)]);
  const hasFacts = new Set(facts.map(f => f.p));
  const abducible = p => !p.startsWith('x_') && (!derived.has(p) || hasFacts.has(p)) && program.slice?.has(p);
  const constants = new Set();
  const preds = new Map();
  const negUsed = new Set();
  const seeLeaves = leaves => {
    for (const l of leaves) if (l.kind === 'atom') {
      preds.set(l.p, l.args.length);
      for (const t of l.args) if (!isVarTerm(t)) constants.add(t);
      if (l.mode === 'not') negUsed.add(l.p);
    }
  };
  for (const f of facts) { preds.set(f.p, f.args.length); f.args.forEach(a => constants.add(a)); }
  for (const r of program.rules) { for (const t of r.head.args) if (!isVarTerm(t)) constants.add(t); r.alts.forEach(a => seeLeaves(a.leaves)); }
  for (const a of program.aggregates) a.alts.forEach(x => seeLeaves(x.leaves));
  for (const alt of goalAlts) seeLeaves(alt.leaves ?? alt);
  const typeOf = (p, i) => program.predicates.get(p)?.args[i]?.type;
  const out = [];
  for (const [p, arity] of preds) {
    if (!abducible(p)) continue;
    const domains = Array.from({length: arity}, (_, i) => {
      const ty = typeOf(p, i);
      return [...constants].filter(c => (ty === 'integer' ? typeof c === 'number' : ty === 'entity' || ty === 'text' ? typeof c === 'string' : true));
    });
    const tuples = domains.reduce((acc, d) => acc.flatMap(t => d.map(c => [...t, c])), [[]]);
    for (const args of tuples) for (const neg of negUsed.has(p) ? [false, true] : [false]) {
      out.push({neg, p, args});
      if (out.length > maxCandidates) return {atoms: out, truncated: true};
    }
  }
  return {atoms: out, truncated: false};
}
