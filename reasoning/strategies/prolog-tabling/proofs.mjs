/**
 * The proof variant of the program: for every DERIVED predicate (and polarity) a second tabled predicate hp_<rel> / hn_<rel> carrying the
 * derivation HEIGHT as its last argument, tabled in the `min` mode. The height of an atom is 0 for a stored fact and 1 + the largest
 * height of the derived atoms its cheapest rule instance rests on: the round at which the oracle's naive evaluation first derives it and
 * the depth of its explanation. Proofs (runtime.pl rt_prove) are then built from minimal-height instances, so the node graph is acyclic
 * and the explanation is the shortest derivation. The variant calls the plain predicates for base relations, so no fact is duplicated;
 * `absent` is tested on the variant itself (a lower stratum, complete by then).
 *
 * An aggregate has no per-group height: its height is one above the largest height of any derived atom its rows rest on (acyclic, and
 * the depth of an explanation through an aggregate over DERIVED relations may then exceed the oracle's).
 */
import {q, termText, leafGoals, vars, listText} from './codegen.mjs';
import {isVarTerm} from '../js-reference/values.mjs';

const plain = pol => (pol === 'pos' ? 'p_' : 'n_');
const hname = pol => (pol === 'pos' ? 'hp_' : 'hn_');

function proofGoals(reg) {
  const withH = (pol, p) => reg.derived.has(pol + '|' + p);
  const build = (pol, p, args, h, forHead) => {
    const a = args.map(termText);
    if (withH(pol, p)) { a.push(h); return a.length ? `${hname(pol)}${p}(${a.join(',')})` : `${hname(pol)}${p}`; }
    return a.length ? `${plain(pol)}${p}(${a.join(',')})` : `${plain(pol)}${p}`;
  };
  return {withH, call: (pol, p, args, hv = '_') => build(pol, p, args, hv), head: (pol, p, args, h) => build(pol, p, args, h)};
}

export function proofVariantText({program, view, reg}) {
  const g = proofGoals(reg);
  const clauses = new Map();
  const add = (name, text) => { if (!clauses.has(name)) clauses.set(name, []); clauses.get(name).push(text); };
  const everyDerived = () => true;
  const data = [];

  for (const f of view) {
    const pol = f.neg ? 'neg' : 'pos';
    if (g.withH(pol, f.p)) add(hname(pol) + f.p, g.head(pol, f.p, f.args, '0') + '.');
  }
  for (const r of program.rules) {
    const pol = r.head.neg ? 'neg' : 'pos';
    for (const alt of r.alts) {
      const {goals: gs, hvars} = leafGoals(g, alt.leaves, everyDerived, reg);
      const body = `${gs.join(', ')}${gs.length ? ', ' : ''}rt_hmax(${listText(hvars)},HM), H is HM+1`;
      add(hname(pol) + r.head.p, `${g.head(pol, r.head.p, r.head.args, 'H')} :- ${body}.`);
    }
  }
  for (const a of program.aggregates) {
    const rowIdx = new Map(a.rowVars.map((v, i) => [v, i]));
    const alts = a.alts.map(alt => {
      const {goals: gs, hvars} = leafGoals(g, alt.leaves, everyDerived, reg);
      const row = a.rowVars.map(v => (vars(alt.leaves).has(v) ? 'V_' + v.slice(1) : "'$unbound'"));
      return `( ${gs.join(', ')}${gs.length ? ', ' : ''}Row = ${listText(row)}, HL = ${listText(hvars)} )`;
    });
    const gidx = a.group.map(v => rowIdx.get(v));
    const fieldIdx = a.field ? rowIdx.get(a.field) : -1;
    const gv = listText(a.group.map(v => 'V_' + v.slice(1)));
    add(hname('pos') + a.yields.p, `${g.head('pos', a.yields.p, a.yields.args, 'H')} :- findall(Row-HL, ( ${alts.join(' ; ')} ), L0), pairs_keys_values(L0, Ks, HLs), sort(Ks, Rows), append(HLs, Hs), rt_hmax(Hs, HM), H is HM+1, rt_groups(Rows, ${listText(gidx)}, Groups), member(GK-Members, Groups), GK = ${gv}, rt_agg_fn(${a.fn}, ${fieldIdx}, Members, AggOut), V_${a.out.slice(1)} = AggOut.`);
  }
  const decls = [];
  for (const key of reg.derived) {
    const [pol, p] = key.split('|');
    const n = reg.arity.get(p) ?? 0;
    decls.push(`:- table ${hname(pol)}${p}(${[...Array(n).fill('_'), 'min'].join(',')}).`);
    data.push(`rt_hpred(${pol},${q(p)},${q(hname(pol) + p)}).`);
    if (!clauses.has(hname(pol) + p)) add(hname(pol) + p, `${hname(pol)}${p}(${Array(n + 1).fill('_').join(',')}) :- fail.`);
  }
  return [...decls, ...[...clauses.values()].map(cs => cs.join('\n')), ...data].join('\n') + '\n';
}
export {isVarTerm};
