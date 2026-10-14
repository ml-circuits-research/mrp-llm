/**
 * Host rule R-P2 at wire level (round 2): a count or an `every` over a predicate that is not declared `closed` cannot be an
 * exact answer. A count over an open predicate is a LOWER BOUND (`bound: at_least`, the retrieval view is complete but the world is
 * open). An `every` whose domain (the `where` predicates) is open that finds no counterexample is `unknown` (reason
 * `open_domain`), never `supported`; a counterexample still refutes it (monotone). The strategies stay unaware of this: the host
 * applies the rule to every strategy's result alike.
 */
import {parse, parseCondition, leaves} from '../validator.mjs';

export function applyClosedPolicy(c, got) {
  const q = parse(c.query).wires.find(w => w.type === 'query');
  if (!q) return got;
  const mode = q.fields.find(f => f.key === 'mode')?.value.trim() ?? 'select';
  if (!['count', 'every'].includes(mode)) return got;
  const closed = new Set(parse(c.knowledge).wires.filter(w => w.type === 'predicate' && w.fields.some(f => f.key === 'closed' && f.value.trim() === 'true')).map(w => w.id));
  const preds = q.fields.filter(f => f.key === 'where').flatMap(f => leaves(parseCondition(f, []))).filter(l => l.kind === 'atom' && l.neg !== 'absent').map(l => l.p);
  if (preds.every(p => closed.has(p))) return got;
  if (mode === 'count' && got.status === 'supported') return {...got, bound: 'at_least'};
  if (mode === 'every' && got.status === 'supported') return {...got, status: 'unknown', reason: 'open_domain'};
  return got;
}
