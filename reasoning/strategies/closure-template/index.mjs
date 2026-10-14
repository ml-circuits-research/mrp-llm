/**
 * closure-template: the NATIVE CLOSURE TEMPLATE of the proposal (sections 7 and 10.2), a router-rule component and not a strategy.
 * It recognises a transitive-closure rule pair (`recognize.mjs`) and, when an argument of the query is bound, answers with one
 * breadth-first search and a witness path (`bfs.mjs`) instead of firing the recursive rules. It produces answers, so it passes the
 * shadow gate against `js-oracle` like a strategy before the router may use it.
 *
 * It applies to a narrow shape and says so: anything else (another rule shape, a negative fact about the edge, a validity interval,
 * time, `if` suppositions, both arguments free, modes other than select, exists and count) throws NotExpressibleError. The router rule is
 *   `matches(problem)` -> the recognised template (or null) without running the search.
 * Evidence (inventory V03, S11): 17x to 1,382x on 5 of 13 benchmark cases, 1.0x to 1.26x on the rest, and the large ratios compare
 * query-directed search with broad bottom-up materialisation; it is not a new graph algorithm. The measurement on this repository's
 * reach cases is in `eval/reports/current/closure-template/`.
 */
import {parse, selectInForce, desugar} from '../../../sop/knowledge/index.mjs';
import {compileProgram} from '../js-reference/program.mjs';
import {ProgramError, NotExpressibleError, isVarTerm} from '../js-reference/values.mjs';
import {Budget, BudgetStop, CEILINGS} from '../js-reference/budget.mjs';
import {recognizeClosure} from './recognize.mjs';
import {adjacency, reach, pathTo} from './bfs.mjs';
import {conditionAlts} from '../js-reference/program.mjs';

export {recognizeClosure, ProgramError, NotExpressibleError};

export const capabilities = {
  id: 'closure-template',
  kind: 'router-rule component',
  features: ['facts', 'rules', 'recursion', 'conjunction', 'select', 'exists', 'count', 'open_world', 'closed_world', 'used', 'budget', 'versions'],
  delivery: 'slice',
  limits: {max_wires: Infinity, max_arity: 2, integer_range: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]},
  guarantee: 'exact',
  provides: ['used', 'witness'],
  budgetKeys: ['maxJoins', 'maxRounds'],  // maxJoins counts edges examined (not the oracle's probes: `budget_probes` is not declared); maxRounds caps the BFS levels
  determinism: 'deterministic',
  isolation: false
};

export async function available() { return {ok: true}; }

const f1 = (w, k) => w.fields.find(f => f.key === k);
const decline = (m, features = ['recursion']) => { throw new NotExpressibleError(features, `closure-template: ${m}`); };

function readWires(text, what) {
  const {wires, errors} = parse(text ?? '');
  if (errors.length) throw new ProgramError(errors[0].code, `${what}: ${errors[0].message} (line ${errors[0].line})`);
  return wires;
}

export function prepare(theory) {
  const knowledge = typeof theory === 'string' ? theory : theory?.knowledge ?? '';
  return {kind: 'closure-handle', knowledge, wires: theory?.wires ?? readWires(knowledge, 'knowledge'), adjCache: new Map()};
}

/** Compile the circuits in force; returns {program, query, qp-ish pieces}. */
function compile(handle, queryText) {
  const qWires = readWires(queryText, 'query');
  const query = qWires.find(w => w.type === 'query');
  if (!query) decline('no query wire', ['select']);
  for (const k of ['at', 'during', 'overlaps', 'asof', 'if', 'scope', 'limit', 'order', 'rank', 'filter', 'quantifier', 'except', 'measure', 'compare', 'via', 'trace', 'candidate']) if (f1(query, k)) decline(`query field ${k}`);
  const mode = f1(query, 'mode')?.value.trim() ?? 'select';
  if (!['select', 'exists', 'count'].includes(mode)) decline(`mode ${mode}`, [mode]);
  const inForce = selectInForce(handle.wires, {asof: null, include: []});
  const {wires, origin} = desugar([...inForce, ...qWires.filter(w => w.type === 'fact')]);
  return {program: compileProgram(wires, {origin}), query, mode, qWires};
}

/** The router rule: does the circuit hold a closure template that this query can use? Returns the template or null. */
export function matches(problem) {
  try {
    const handle = problem.handle ?? prepare(problem.theory ?? '');
    const {program, query} = compile(handle, problem.query);
    return plan(program, query)?.template ?? null;
  } catch (e) {
    if (e instanceof NotExpressibleError) return null;
    throw e;
  }
}

/** The single where atom of the query and the template of its predicate. */
function plan(program, query) {
  const alts = conditionAlts(query.fields.filter(f => f.key === 'where'), query.id);
  if (alts.length !== 1 || alts[0].length !== 1) decline('the query is not a single atom');
  const atom = alts[0][0];
  if (atom.kind !== 'atom' || atom.mode !== 'pos' || atom.args.length !== 2) decline('the query is not one positive atom of arity 2');
  const template = recognizeClosure(program, atom.p);
  if (!template) decline(`no transitive-closure template for ${atom.p}`);
  const [a, b] = atom.args;
  const bound = [!isVarTerm(a), !isVarTerm(b)];
  if (!bound[0] && !bound[1]) decline('both arguments free: no bound argument, the template does not pay');
  if (isVarTerm(a) && isVarTerm(b) && a.var === b.var) decline('repeated variable');
  return {atom, template, bound};
}

export function ask(problem, budgetArg = {}) {
  const t0 = performance.now();
  const handle = problem.handle ?? prepare(problem.theory ?? '');
  const {program, query, mode} = compile(handle, problem.query);
  const {atom, template, bound} = plan(program, query);
  const policy = readWires(problem.query, 'query').find(w => w.type === 'policy');
  const limits = {};
  for (const f of policy?.fields ?? []) if (f.key in CEILINGS) limits[f.key] = Number(f.value);
  for (const [k, v] of Object.entries(budgetArg)) limits[k] = k in limits ? Math.min(limits[k], v) : v;
  const budget = new Budget(limits);
  const maxProbes = budget.limits.maxJoins;

  const edgeFacts = program.facts.filter(f => f.p === template.E);
  const adj = adjacency(edgeFacts);
  const closed = program.closed.has(template.P);
  const [a, b] = atom.args;
  const forward = bound[0];
  const start = forward ? a : b;
  const res = reach(forward ? adj.fwd : adj.bwd, start, maxProbes, budget.limits.maxRounds);
  const route = {requested: problem.requested ?? null, chosen: 'closure-template', reason: `${template.kind}-linear closure of ${template.E}, ${forward ? 'first' : 'second'} argument bound`, fallback: null};
  const notes = [];
  const common = {strategy: 'closure-template', guarantee: 'exact', route, ignored: [], notes, retrieval: {complete: true, truncated: false, keyed: false, steps: 0, wires: edgeFacts.length, probes: res.probes ?? maxProbes}};
  const finish = packet => ({...common, ...packet, timings: {ask: Math.round(performance.now() - t0), total: Math.round(performance.now() - t0)}});
  if (res.stop) return finish({status: 'budget_exhausted', complete: false, reason: 'probes', budget: {...budget.snapshot(true), exhausted: true, reason: 'probes'}, used: []});
  budget.used.maxJoins = res.probes;

  // rows: for each reached node t, the row binds the free variable(s); a ground target needs reachability only
  const target = forward ? b : a;
  const groundTarget = !isVarTerm(target);
  const matchesNodes = groundTarget ? (res.depth.has(target) ? [target] : []) : [...res.depth.keys()];
  const nameOf = isVarTerm(target) ? target.var.replace(/^\?/, '') : null;
  let rows = matchesNodes.map(n => (nameOf ? {[nameOf]: n} : {}));
  const select = (f1(query, 'select')?.value.trim() ?? '').split(/\s+/).filter(Boolean);
  if (select.length && nameOf && !select.every(s => s.replace(/^\?/, '') === nameOf)) decline('select projects other variables');
  if (groundTarget && select.length) decline('select over a ground query');
  rows = [...new Map(rows.map(r => [JSON.stringify(r), r])).values()];

  const supportFacts = new Set();
  let deep = false;
  for (const n of matchesNodes) {
    const p = pathTo(res, start, n);
    if (p.facts.length > 1) deep = true;
    if (mode !== 'exists' || !supportFacts.size) p.facts.forEach(x => supportFacts.add(x));
  }
  const used = matchesNodes.length
    ? [...[...supportFacts].map(id => ({id, version: 1})), {id: template.baseRule.source.id, version: template.baseRule.source.version}, ...(deep ? [{id: template.stepRule.source.id, version: template.stepRule.source.version}] : [])]
    : [];
  const witness = groundTarget && matchesNodes.length ? {path: pathTo(res, start, target).nodes} : undefined;

  const bud = budget.snapshot(false);
  if (res.cut) {
    const exhausted = {...bud, exhausted: true, reason: 'rounds', partial: mode === 'select' && rows.length > 0};
    // a positive existential found before the cut stays supported (sound subset); a count, a negative or an empty result is not decided
    if (mode !== 'count' && rows.length) return finish({status: 'supported', complete: false, reason: 'rounds', ...(mode === 'select' ? {rows} : {}), budget: exhausted, used});
    return finish({status: 'budget_exhausted', complete: false, reason: 'rounds', budget: exhausted, used: []});
  }
  if (!rows.length) {
    if (mode === 'count') return finish({status: closed ? 'supported' : 'unknown', complete: true, count: 0, ...(closed ? {} : {bound: 'at_least'}), budget: bud, used: []});
    return finish({status: closed ? 'refuted' : 'unknown', complete: true, ...(mode === 'select' ? {rows: []} : {}), budget: bud, used: []});
  }
  const base = {status: 'supported', complete: true, budget: bud, used, ...(witness ? {witness} : {})};
  if (mode === 'select') return finish({...base, rows});
  if (mode === 'count') return finish({...base, count: rows.length, ...(closed ? {} : {bound: 'at_least'})});
  return finish(base);
}

export const closureTemplate = {...capabilities, capabilities, available, prepare, ask, matches, recognize: recognizeClosure};
export default closureTemplate;
