/**
 * The Prolog text of one golog-swi solve: the tabled world of the rules in force (prolog-tabling code generator, state mode) plus the
 * data of the modes of work as clauses read by golog.pl: the initial state, the actions (preconditions as ordered leaf tests),
 * the methods as programs (the step tree of ../modes/model.mjs), the norms with their three orderings of `when`, the override
 * edges, the goal.
 *
 * Variables are shared inside one clause by name (`?r` is `V_r`), so a method's variables are bound by unification when its head meets
 * the task and flow into its steps; the clause is copied at each use.
 */
import {isVarTerm} from '../js-reference/values.mjs';
import {orderLeaves} from '../js-reference/program.mjs';
import {registry, programText, termText, leafData, q} from '../prolog-tabling/codegen.mjs';

const list = xs => '[' + xs.join(',') + ']';
const terms = ts => list(ts.map(termText));
const modeOf = neg => (neg === 'none' || neg === undefined ? 'pos' : neg);
const atomLeaf = n => ({kind: 'atom', mode: modeOf(n.neg), p: n.p, args: n.terms});
const leafAlt = n => `[[${leafData(atomLeaf(n))}]]`;

const varsOf = ts => new Set(ts.filter(isVarTerm).map(t => t.var));

/** `requires not p` over a closed fluent is absence, over an open fluent negative evidence (the planning-state rule, 4.2 item 8). */
const asPrecondition = (a, closed) => ({kind: 'atom', mode: a.neg ? (closed.has(a.p) ? 'absent' : 'not') : 'pos', p: a.p, args: a.args});

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Reorder the branches of a `choose` so that a `prefer ~better over ~worse` branch is tried first (stable otherwise). */
function preferOrder(branches, prefer) {
  const out = [...branches];
  const name = n => (n.kind === 'prim' ? n.action : null);
  for (const {better, worse} of prefer) {
    const i = out.findIndex(n => name(n) === better), j = out.findIndex(n => name(n) === worse);
    if (i > j && j >= 0) { const [b] = out.splice(i, 1); out.splice(j, 0, b); }
  }
  return out;
}

export function stepTerm(n, prefer = []) {
  switch (n.kind) {
    case 'prim': return `prim(${q(n.action)},${terms(n.terms)})`;
    case 'optional': return `optional(${stepTerm(n.item, prefer)})`;
    case 'choose': return `choose(${list(preferOrder(n.branches, prefer).map(b => stepTerm(b, prefer)))})`;
    case 'any_order': return `any_order(${list(n.items.map(b => stepTerm(b, prefer)))})`;
    case 'if': return `if(${leafAlt(n)},${list(n.then.map(b => stepTerm(b, prefer)))},${list(n.otherwise.map(b => stepTerm(b, prefer)))})`;
    case 'until': return `until(${leafAlt(n)},${n.max},${list(n.body.map(b => stepTerm(b, prefer)))})`;
    case 'pick': return `pick(${leafData(atomLeaf(n))})`;
    case 'task': return `task(${q(n.p)},${terms(n.terms)})`;
    case 'achieve': return `achieve(${q(n.p)},${terms(n.terms)})`;
    default: throw new Error('unknown step ' + n.kind);
  }
}

/** Does the step tree hold a form that needs blind search? */
export function hasForm(nodes, kind) {
  return nodes.some(n => n.kind === kind || [n.item, ...(n.branches ?? []), ...(n.items ?? []), ...(n.then ?? []), ...(n.otherwise ?? []), ...(n.body ?? [])].filter(Boolean).some(x => hasForm([x], kind)));
}

const effText = a => `eff(${a.neg},${q(a.p)},${terms(a.args)})`;

/** Atoms the data mentions (for the registry: every relation needs its tabled predicates). */
function atomsOf(ctx, goalAlts) {
  const out = [];
  const leaf = l => { if (l.kind === 'atom' || l.kind === 'timeof') out.push({p: l.p, args: l.args}); };
  const alts = as => as.forEach(alt => alt.forEach(leaf));
  const nodes = ns => ns.forEach(n => {
    if (['if', 'until', 'pick'].includes(n.kind)) out.push({p: n.p, args: n.terms});
    for (const k of ['item']) if (n[k]) nodes([n[k]]);
    for (const k of ['branches', 'items', 'then', 'otherwise', 'body']) if (n[k]) nodes(n[k]);
  });
  for (const m of ctx.methods) { alts(m.whenAlts); nodes(m.steps); }
  for (const n of ctx.norms) { alts(n.whenAlts); if (n.pat.kind === 'state') out.push({p: n.pat.p, args: n.pat.terms}); }
  for (const a of ctx.program.actions) for (const x of [...a.requires, ...a.adds, ...a.removes]) out.push({p: x.p, args: x.args});
  alts(goalAlts);
  return out;
}

/** The program of a solve. `goal` = {alts (ordered leaf lists), consts}. `extra` = more clauses (the task). */
export function worldText(ctx, goal) {
  const program = ctx.program;
  const reg = registry(program, atomsOf(ctx, goal ? goal.alts.map(a => a) : []));
  const out = [programText({program, view: [], reg, heights: null, stateMode: true})];
  const closed = program.closed;

  const lits = program.facts.map(f => `l(${f.neg ? 'neg' : 'pos'},${q(f.p)},${terms(f.args)})`);
  out.push(`rt_init(S) :- sort(${list(lits)}, S).`);

  for (const a of program.actions) {
    const leaves = orderLeaves(a.requires.map(r => asPrecondition(r, closed)), a.id).leaves;
    out.push(`rt_action(${q(a.id)},${a.source.version},${a.cost},${list(a.params.map(v => 'V_' + v.slice(1)))},${list(leaves.map(leafData))},${list(a.adds.map(effText))},${list(a.removes.map(effText))}).`);
  }

  for (const m of ctx.methods) {
    const headVars = varsOf(m.achieves.terms);
    const guard = m.whenAlts.map(alt => orderLeaves(alt, m.id, new Set(headVars)).leaves);
    const onf = m.onFailure === null ? 'none' : m.onFailure.method ? `method(${q(m.onFailure.method)})` : q(m.onFailure);
    out.push(`rt_method(${q(m.id)},${m.version},${q(m.binding)},${m.cost},${onf},${q(m.achieves.p)},${terms(m.achieves.terms)},${list(guard.map(l => list(l.map(leafData))))},${list(m.steps.map(s => stepTerm(s, m.prefer)))}).`);
  }

  for (const n of ctx.norms) {
    const pv = n.patVars;
    const pat = n.pat.kind === 'action' ? `pat(action,${q(n.pat.action)},${terms(n.pat.terms)})` : `pat(state,${q(n.pat.p)},${terms(n.pat.terms)})`;
    const qual = n.qual === null ? 'none' : n.qual.kind === 'within' ? `q(within,${n.qual.n})` : ['before', 'after'].includes(n.qual.kind) ? `q(${n.qual.kind},${q(n.qual.ref)})` : `q(${n.qual.kind})`;
    const alts = (bound, extra = null) => list(n.whenAlts.map(alt => list(orderLeaves(extra ? [extra, ...alt] : alt, n.id, new Set(bound)).leaves.map(leafData))));
    const patternLeaf = n.pat.kind === 'state' ? {kind: 'atom', mode: 'pos', p: n.pat.p, args: n.pat.terms} : null;
    // only the ordering a norm is evaluated with is generated (an `absent` over a pattern variable is safe only once the pattern binds it)
    const wb = n.pat.kind === 'action' && n.modality !== 'oblige' ? alts(pv) : '[]';
    const wf = n.modality === 'oblige' ? alts([]) : '[]';
    const ws = patternLeaf && n.modality !== 'oblige' ? alts([], patternLeaf) : '[]';
    out.push(`rt_norm(${q(n.id)},${n.version},${n.modality},${pat},${qual},${n.standing},${n.severity},${n.cost},${n.priority},${n.binding},${n.message ? q(n.message) : 'null'},${list(pv.map(v => 'V_' + v.slice(1)))},${wb},${wf},${ws}).`);
  }
  for (const e of ctx.edges) out.push(`rt_edge(${q(e.over)},${q(e.target)}).`);

  if (goal) {
    out.push(`rt_goal(${list(goal.alts.map(ls => list(ls.map(leafData))))}).`);
    out.push(`rt_goal_consts(${list([...goal.consts].map(c => termText(c)))}).`);
  }
  return out.join('\n') + '\n';
}

export {cmp};
