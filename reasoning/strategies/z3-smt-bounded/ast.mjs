/**
 * The runtime's typed integer constraint (sop/lower.mjs `lowerConstraint`) in Z3 (QF_LIA), with domains that may be unbounded:
 * the decision of a claim in both polarities, the output projection of a scalar port, and optimization with an independent
 * optimality check. This is the explicit `backend z3` of the runtime and of the retired `z3-lia` route; the typed AST is the one
 * `js-reference/constraint-ast.mjs` enumerates, so the two decide the same problems. Z3 integers are unbounded: a value outside the
 * safe integers is a range stop (`numeric_range`), never a rounded number.
 *
 * Unlike the finite constraint wire of `constraint.mjs`, nothing here needs a bound on a variable: `var ?x int` is an integer.
 */
import {runZ3, intOf, smtInt, SolverStop} from './z3.mjs';
import {validateConstraint} from '../js-reference/constraint-ast.mjs';

const BINARY = {add: '+', sub: '-', mul: '*', eq: '=', ne: 'distinct', lt: '<', le: '<=', gt: '>', ge: '>='};

/** The SMT-LIB prefix (logic, declarations, bounds, requirements) and the claim of a validated typed problem. */
export function compile(problem, extraVars = {}) {
  validateConstraint(problem);
  const vars = {...problem.vars, ...extraVars}, names = Object.keys(vars);
  const decl = [];
  for (const name of names) {
    decl.push(`(declare-const ${name} Int)`);
    for (const [k, op] of [['min', '>='], ['max', '<=']]) if (vars[name][k] !== undefined) decl.push(`(assert (${op} ${name} ${smtInt(vars[name][k])}))`);
  }
  const term = x => {
    if (Number.isSafeInteger(x)) return smtInt(x);
    if (typeof x === 'string') return x;
    return BINARY[x.op] ? `(${BINARY[x.op]} ${x.a.map(term).join(' ')})` : `(${x.op} ${x.a.map(term).join(' ')})`;
  };
  return {names, term, decl};
}

/** One satisfiability check of the problem plus extra assertions: 'sat', 'unsat' or 'unknown'; `values` are asked from a model. */
function check(problem, extra, {timeoutMs, ask = [], vars}) {
  const {term, decl} = compile(problem, vars);
  const lines = ['(set-logic QF_LIA)', ...decl, ...problem.constraints.map(c => `(assert ${term(c)})`), ...extra.map(e => `(assert ${typeof e === 'string' ? e : term(e)})`), '(check-sat)'];
  if (ask.length) lines.push(`(get-value (${ask.join(' ')}))`);
  const r = runZ3(lines.join('\n') + '\n', {timeoutMs});
  if (r.interrupted) throw new SolverStop('wall');
  const status = ['sat', 'unsat', 'unknown'].includes(r.results[0]) ? r.results[0] : 'unknown';
  const values = status === 'sat' && ask.length && Array.isArray(r.results[1]) ? new Map(r.results[1].map(p => [p[0], p[1]])) : new Map();
  return {status, values};
}

/** Decide `task prove` / `possible` (and project the scalar ports); a stop is incomplete, never a verdict. */
export function z3Decide(problem, {timeoutMs = 3000, project = []} = {}) {
  try {
    const base = check(problem, [], {timeoutMs});
    if (base.status === 'unsat') return {status: 'inconsistent', kind: 'constraint', backend: 'z3', complete: true, checks: {base: 'unsat'}};
    if (base.status !== 'sat') return {status: 'unknown', kind: 'constraint', backend: 'z3', complete: false, checks: {base: base.status}};
    const yes = check(problem, [problem.claim], {timeoutMs}), no = check(problem, [{op: 'not', a: [problem.claim]}], {timeoutMs});
    const status = problem.task === 'possible' ? (yes.status === 'sat' ? 'possible' : yes.status === 'unsat' ? 'impossible' : 'unknown')
      : (no.status === 'unsat' ? 'entailed' : yes.status === 'unsat' ? 'refuted' : 'unknown');
    const outputProjection = {};
    for (const p of project) {
      if (p.mode !== 'one') { outputProjection['?' + p.name] = {status: 'unsupported_projection'}; continue; }
      if (!Object.hasOwn(problem.vars, p.name)) throw new Error('Unknown projected variable');
      // a model is one possible assignment: a scalar is exported only when the stated conditions entail that same value
      const model = check(problem, [], {timeoutMs, ask: [p.name]}).values.get(p.name);
      if (model === undefined) { outputProjection['?' + p.name] = {status: 'incomplete'}; continue; }
      const value = intOf(model);
      const different = check(problem, [`(not (= ${p.name} ${smtInt(value)}))`], {timeoutMs});
      outputProjection['?' + p.name] = different.status === 'unsat' ? {status: 'bound', value} : different.status === 'sat' ? {status: 'ambiguous'} : {status: 'incomplete'};
    }
    return {status, kind: 'constraint', task: problem.task, backend: 'z3', complete: [yes.status, no.status].every(x => ['sat', 'unsat'].includes(x)), unit: problem.unit, outputProjection,
      checks: {base: base.status, withClaim: yes.status, withNegatedClaim: no.status}, assurance: 'Logical result relative to the declared constraints; satisfiable does not mean entailed.'};
  } catch (e) {
    if (e instanceof SolverStop) return {status: 'unknown', kind: 'constraint', backend: 'z3', complete: false, reason: e.reason};
    throw e;
  }
}

/** Optimize with Z3, then prove independently that no strictly better feasible objective exists. */
export function z3Optimize(problem, {timeoutMs = 3000, project = []} = {}) {
  let objectiveVar = 'sopobjective';
  while (Object.hasOwn(problem.vars, objectiveVar)) objectiveVar += 'x';
  const vars = {[objectiveVar]: {sort: 'Int'}};
  const link = {op: 'eq', a: [objectiveVar, problem.objective]};
  try {
    const {term, decl} = compile(problem, vars);
    const lines = ['(set-logic QF_LIA)', ...decl, ...problem.constraints.map(c => `(assert ${term(c)})`), `(assert ${term(problem.claim)})`, `(assert ${term(link)})`,
      `(${problem.direction === 'max' ? 'maximize' : 'minimize'} ${objectiveVar})`, '(check-sat)', `(get-value (${objectiveVar}))`];
    const r = runZ3(lines.join('\n') + '\n', {timeoutMs});
    if (r.interrupted) throw new SolverStop('wall');
    if (r.results[0] === 'unsat') return {kind: 'constraint', task: 'optimize', status: 'inconsistent', backend: 'z3', complete: true};
    const got = r.results[0] === 'sat' && Array.isArray(r.results[1]) ? r.results[1].find(p => p[0] === objectiveVar)?.[1] : undefined;
    if (got === undefined) return {kind: 'constraint', task: 'optimize', status: 'unknown', backend: 'z3', complete: false};
    let optimum;
    try { optimum = intOf(got); } catch { return {kind: 'constraint', task: 'optimize', status: 'unsupported', code: 'unrepresentable_objective', detail: 'Objective is outside the portable integer representation', backend: 'z3', complete: false}; }
    const base = {...problem, vars: {...problem.vars, ...vars}, constraints: [...problem.constraints, problem.claim, link]};
    // independent proof: no feasible model has a strictly better objective (`impossible`)
    const better = z3Decide({...base, task: 'possible', claim: {op: problem.direction === 'max' ? 'gt' : 'lt', a: [objectiveVar, optimum]}}, {timeoutMs});
    const proven = better.status === 'impossible';
    const fixed = {...base, constraints: [...base.constraints, {op: 'eq', a: [objectiveVar, optimum]}], claim: {op: 'eq', a: [objectiveVar, optimum]}, task: 'prove'};
    const projected = z3Decide(fixed, {timeoutMs, project});
    return {...projected, kind: 'constraint', task: 'optimize', status: proven ? 'optimal' : 'feasible_bound', objective: optimum, direction: problem.direction, complete: proven && projected.complete, backend: 'z3', optimalityCheck: better.status};
  } catch (e) {
    if (e instanceof SolverStop) return {kind: 'constraint', task: 'optimize', status: 'unknown', backend: 'z3', complete: false, reason: e.reason};
    throw e;
  }
}
