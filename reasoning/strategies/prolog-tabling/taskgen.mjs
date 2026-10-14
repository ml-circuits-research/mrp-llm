/**
 * The task of one Prolog run: Prolog clauses that answer a compiled query (js-reference `planQuery`) over the tabled program and
 * print the result as JSON. The decisions about statuses (supported / refuted / both / unknown, counts, bounds, `every`) stay in
 * JavaScript (outcome.mjs): Prolog returns the facts those decisions need, goal-directed (a query is a tabled call, so only
 * the part of the program the query depends on is evaluated).
 *
 *   relational (select, exists, explain, count)
 *     q_alt(I, Row, Both, Prem)         one solution of alternative I: the projection, whether some body literal also has CONTRARY
 *                                       evidence (the row is `both`), and the premises (literals, absent markers);
 *     q_refuted(I, L)                   leaf L of alternative I has NO possible instance (N evidence on a ground positive atom, no P
 *                                       instance of a closed predicate, P evidence on a ground `not` / `absent`);
 *     q_refroot(I, L, Lit)              the contrary evidence of a ground leaf (what a refutation stands on);
 *   every: q_dom(Env), q_scope_alt(J, Env, Both, Prem), q_srefuted(J, L, Env), q_srefroot(J, L, Env, Lit)
 *   why_not: the goal as leaf data for the abductive meta-interpreter
 *   abduce: the goal as a holds test, run once per subset of the hypotheses
 */
import {q, termText, goals, leafGoals, premText} from './codegen.mjs';
import {isVarTerm} from '../js-reference/values.mjs';

const listText = xs => '[' + xs.join(',') + ']';
const argsText = args => listText(args.map(termText));
const varName = v => 'V_' + v.slice(1);

const leafAtom = l => l.kind === 'atom';

/** Goal that tests the CONTRARY evidence of a satisfied atom leaf (a positive leaf with N evidence, a `not` leaf with P evidence). */
function contraries(g, leaves) {
  const gs = leaves.filter(l => leafAtom(l) && l.mode !== 'absent').map(l => g.call(l.mode === 'pos' ? 'neg' : 'pos', l.p, l.args, '_'));
  return gs.length ? `( ( ${gs.join(' ; ')} ) -> Both = true ; Both = false )` : 'Both = false';
}

/** Is every argument fixed (a constant, or a variable of `known`)? */
const groundIn = (args, known) => args.every(a => !isVarTerm(a) || known.has(a.var));

/**
 * "This leaf has no possible instance" (`test`) and the contrary evidence of a ground leaf (`root`), under `known` variables.
 * A positive leaf is refuted by N evidence on a ground atom, or, over a CLOSED predicate, when no P instance matches the pattern
 * (variables are wildcards); a `not` or `absent` leaf only when it is ground and the atom has P evidence.
 */
function refutedClause(g, l, closed, known) {
  if (!leafAtom(l)) return null;
  const ground = groundIn(l.args, known);
  if (l.mode === 'pos') {
    const parts = [];
    if (ground) parts.push(g.call('neg', l.p, l.args, '_'));
    if (closed.has(l.p)) parts.push(`\\+ ${g.call('pos', l.p, l.args, '_')}`);
    if (!parts.length) return null;
    const root = ground ? `Lit = l(neg,${q(l.p)},${argsText(l.args)}), ${g.call('neg', l.p, l.args, '_')}` : null;
    return {test: parts.length === 1 ? parts[0] : `( ${parts.join(' ; ')} )`, root};
  }
  if (!ground) return null;
  const pos = g.call('pos', l.p, l.args, '_');
  return {test: pos, root: `Lit = l(pos,${q(l.p)},${argsText(l.args)}), ${pos}`};
}

function relational(g, qp, closed) {
  const out = [];
  qp.alts.forEach((alt, i) => {
    const {goals: gs} = leafGoals(g, alt.leaves);
    const row = qp.projection.map(varName);
    out.push(`q_alt(${i}, ${listText(row)}, Both, Prem) :- ${gs.join(', ')}${gs.length ? ', ' : ''}${contraries(g, alt.leaves)}, Prem = ${premText(alt.leaves)}.`);
    alt.leaves.forEach((l, j) => {
      const r = refutedClause(g, l, closed, new Set());
      if (r) { out.push(`q_refuted(${i}, ${j}) :- ${r.test}.`); if (r.root) out.push(`q_refroot(${i}, ${j}, Lit) :- ${r.root}.`); }
    });
  });
  if (!qp.alts.length) out.push('q_alt(_, _, _, _) :- fail.');
  out.push('q_refuted(_, _) :- fail.', 'q_refroot(_, _, _) :- fail.');
  return out;
}

function everyTask(g, qp, closed) {
  const out = [];
  const union = new Set(qp.alts.flatMap(a => [...a.bound]));
  qp.alts.forEach(alt => {
    const {goals: gs} = leafGoals(g, alt.leaves);
    const env = [...alt.bound].sort().map(v => `${q(v.slice(1))}-${varName(v)}`);
    out.push(`q_dom(Env) :- ${gs.join(', ')}${gs.length ? ', ' : ''}Env = ${listText(env)}.`);
  });
  const prelude = [...union].sort().map(v => `rt_envget(Env, ${q(v.slice(1))}, ${varName(v)})`).join(', ');
  qp.scopeAlts.forEach((alt, j) => {
    const {goals: gs} = leafGoals(g, alt.leaves);
    out.push(`q_scope_alt(${j}, Env, Both, Prem) :- ${prelude}${prelude ? ', ' : ''}${gs.join(', ')}${gs.length ? ', ' : ''}${contraries(g, alt.leaves)}, Prem = ${premText(alt.leaves)}.`);
    alt.leaves.forEach((l, k) => {
      const r = refutedClause(g, l, closed, union);
      if (!r) return;
      out.push(`q_srefuted(${j}, ${k}, Env) :- ${prelude}${prelude ? ', ' : ''}${r.test}.`);
      if (r.root) out.push(`q_srefroot(${j}, ${k}, Env, Lit) :- ${prelude}${prelude ? ', ' : ''}${r.root}.`);
    });
  });
  out.push('q_dom(_) :- fail.', 'q_scope_alt(_, _, _, _) :- fail.', 'q_srefuted(_, _, _) :- fail.', 'q_srefroot(_, _, _, _) :- fail.');
  const js = qp.scopeAlts.map((_, j) => j);
  out.push(`q_members(Ms) :- findall(Env, q_dom(Env), E0), sort(E0, Envs), findall(m(Env, R), ( member(Env, Envs), q_member(Env, R) ), Ms).`);
  out.push(`q_member(Env, holds(Both, Prem)) :- member(J, ${listText(js)}), once(q_scope_alt(J, Env, Both, Prem)), !.`);
  out.push(`q_member(Env, refuted(Roots)) :- forall(member(J, ${listText(js)}), once(q_srefuted(J, _, Env))), !, findall(Lit, ( member(J, ${listText(js)}), q_srefroot(J, _, Env, Lit) ), Roots).`);
  out.push(`q_member(_, unknown).`);
  return out;
}

const TASK_PROVE = `
:- discontiguous q_alt/4, q_refuted/2, q_refroot/3, q_dom/1, q_scope_alt/4, q_srefuted/3, q_srefroot/4.
q_prove(Lits) :- forall(member(L, Lits), ( L = l(_, _, _) -> rt_prove(L) ; true )).
q_prove_any(Lits) :- forall(member(L, Lits), ( L = l(_, _, _) -> rt_prove_any(L, []) ; true )).
q_lits_json(Lits, Js) :- maplist(rt_lit_json, Lits, Js).
`;

/** rt_task for a relational query (select, exists, explain, count). `prove`: also build the proof nodes (not under a height ceiling). */
export function relationalTask(g, qp, closed, {prove, exceeds = false}) {
  // the shortest derivation (a height computation) is only worth its cost for an explanation; `used` needs one sufficient proof
  const proveRows = qp.mode === 'explain' ? 'q_prove' : 'q_prove_any', proveOne = qp.mode === 'explain' ? 'rt_prove(Lit)' : 'rt_prove_any(Lit, [])';
  const clauses = relational(g, qp, closed);
  const taskBody = `
rt_task(D) :-
    findall(r(I, Row, Both, Prem, Und), ( call_delays(q_alt(I, Row, Both, Prem), Del), ( Del == true -> Und = false ; Und = true ) ), Rows),
    findall(I-L, q_refuted(I, L), Ref),
    findall(I-L-Lit, q_refroot(I, L, Lit), Roots),
    ${prove ? `catch(( forall(( member(r(_, _, _, Prem, false), Rows) ), ${proveRows}(Prem)), forall(member(_-_-Lit, Roots), ${proveOne}), Trunc = false ), rt_proof_cap, Trunc = true), ( Trunc == true -> Nodes = [] ; rt_nodes_json(Nodes) )` : 'Nodes = [], Trunc = false'},
    findall(_{alt: I, row: RowJ, both: Both, prem: PremJ, undefined: Und}, ( member(r(I, Row, Both, Prem, Und), Rows), rt_vals(Row, RowJ), ( Und == true -> PremJ = [] ; q_lits_json(Prem, PremJ) ) ), RowsJ),
    findall([I, L], member(I-L, Ref), RefJ),
    findall(_{alt: I, leaf: L, lit: LitJ}, ( member(I-L-Lit, Roots), rt_lit_json(Lit, LitJ) ), RootsJ),
    ${exceeds ? '( rt_exceeds -> Exh = true ; Exh = false )' : 'Exh = false'},
    D = _{rows: RowsJ, refuted: RefJ, roots: RootsJ, nodes: Nodes, exceeded: Exh, truncated: Trunc}.`;
  return [...clauses, TASK_PROVE, taskBody].join('\n');
}

export function everyTaskText(g, qp, closed, {prove, exceeds = false}) {
  const clauses = everyTask(g, qp, closed);
  const taskBody = `
rt_task(D) :-
    q_members(Ms),
    ${prove ? `catch(( forall(member(m(_, holds(_, Prem)), Ms), q_prove_any(Prem)), forall(member(m(_, refuted(Rs)), Ms), q_prove_any(Rs)), Trunc = false ), rt_proof_cap, Trunc = true), ( Trunc == true -> Nodes = [] ; rt_nodes_json(Nodes) )` : 'Nodes = [], Trunc = false'},
    findall(_{env: EnvJ, r: R, both: Both, prem: PremJ, roots: RootsJ},
        ( member(m(Env, Res), Ms), rt_env_json(Env, EnvJ),
          ( Res = holds(Both, Prem) -> R = "holds", q_lits_json(Prem, PremJ), RootsJ = []
          ; Res = refuted(Rs) -> R = "refuted", Both = false, PremJ = [], q_lits_json(Rs, RootsJ)
          ; R = "unknown", Both = false, PremJ = [], RootsJ = [] ) ),
        MsJ),
    ${exceeds ? '( rt_exceeds -> Exh = true ; Exh = false )' : 'Exh = false'},
    D = _{members: MsJ, nodes: Nodes, exceeded: Exh, truncated: Trunc}.`;
  return [...clauses, TASK_PROVE, taskBody].join('\n');
}

/** Leaf data of the alternatives of the goal, for the abductive meta-interpreter. */
const dataLeaf = l => {
  switch (l.kind) {
    case 'atom': return `l(${l.mode},${q(l.p)},${argsText(l.args)})`;
    case 'compare': return `l(cmp,${l.word},${termText(l.left)},${termText(l.right)})`;
    case 'compute': return `l(compute,${l.word},${varName(l.out)},${termText(l.left)},${termText(l.right)})`;
    case 'order': return `l(order,${l.word},${varName(l.left)},${varName(l.right)})`;
    default: return `l(timeof,${l.which},${varName(l.out)},${q(l.p)},${argsText(l.args)})`;
  }
};

export function whyNotTask(g, qp, closed) {
  const clauses = relational(g, qp, closed);
  const alts = listText(qp.alts.map(a => listText(a.leaves.map(dataLeaf))));
  const body = `
rt_task(D) :-
    findall(r(I, Row, Both, Prem), q_alt(I, Row, Both, Prem), Rows),
    findall(I-L, q_refuted(I, L), Ref),
    wn_goal(${alts}, Sets),
    findall(b(Why, Lit), wn_blocker(Why, Lit, _), Bs),
    forall(member(b(_, Lit), Bs), rt_prove(Lit)),
    rt_nodes_json(Nodes),
    findall(SJ, ( member(S, Sets), findall(J, ( member(lit(N, P, A), S), rt_vals(A, AJ), J = _{neg: N, p: P, args: AJ} ), SJ) ), SetsJ),
    findall(_{why: Why, lit: LJ}, ( member(b(Why, Lit), Bs), rt_lit_json(Lit, LJ) ), BsJ),
    findall(_{alt: I, row: RowJ, both: Both, prem: []}, ( member(r(I, Row, Both, _), Rows), rt_vals(Row, RowJ) ), RowsJ),
    findall([I, L], member(I-L, Ref), RefJ),
    D = _{sets: SetsJ, blockers: BsJ, nodes: Nodes, rows: RowsJ, refuted: RefJ, roots: []}.`;
  return [...clauses, TASK_PROVE, body].join('\n');
}

export function abduceTask(g, qp, closed, ids) {
  const clauses = relational(g, qp, closed);
  const body = `
q_goal :- once(q_alt(_, _, _, _)).
rt_task(D) :-
    rt_abduce(${listText(ids.map(q))}, q_goal, ${ids.length}, Found),
    retractall(rt_on(_)), abolish_all_tables,
    D = _{found: Found}.`;
  return [...clauses, body].join('\n');
}

/** `rt_exceeds`: under the ceiling N+1, does some derived atom still get a round-(N+1) derivation? (the oracle's `maxRounds` stop) */
export function exceedsClause(reg, g, bound) {
  const alts = [];
  for (const key of reg.derived) {
    const [pol, p] = key.split('|');
    const n = reg.arity.get(p) ?? 0;
    alts.push(`( ${g.call(pol, p, Array.from({length: n}, (_, i) => ({var: '?_' + i})), 'H')}, H =:= ${bound + 1} )`);
  }
  const body = alts.length ? alts.join(' ; ') : 'fail';
  return `rt_exceeds :- abolish_all_tables, retractall(rt_bound(_)), assertz(rt_bound(${bound + 1})), once(( ${body} )).`;
}
