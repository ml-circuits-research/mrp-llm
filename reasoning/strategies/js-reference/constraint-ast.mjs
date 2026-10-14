/**
 * The runtime's typed integer constraint (sop/lower.mjs `lowerConstraint`: variables with bounds, a Boolean AST over add, sub, mul by a
 * constant, comparisons and and/or/not, a claim, an optional objective) decided by plain enumeration of the finite domains. This is
 * the finite JavaScript profile of the retired `reference` route, now part of the oracle; `constraint.mjs` is the same decision for
 * the words-only `constraint` wire of the knowledge language.
 *
 * Results keep the runtime vocabulary: `task prove` is `entailed` (the claim holds in every model), `refuted` (in none) or `unknown`
 * (in some models only); `task possible` is `possible` or `impossible`; no model of the requirements is `inconsistent`; an
 * optimization is `optimal` with the optimum and its models. A domain that is not finite or too large is `unsupported`
 * (`finite_domain_required`) or incomplete (`unknown`, `complete: false`), never a negative answer.
 */
import {assert} from '../../../lib/util.mjs';

const OPS = {
  add: [a => a[0] + a[1], 'Int', 'Int'], sub: [a => a[0] - a[1], 'Int', 'Int'], mul: [a => a[0] * a[1], 'Int', 'Int'],
  eq: [a => a[0] === a[1], 'Int', 'Bool'], ne: [a => a[0] !== a[1], 'Int', 'Bool'], lt: [a => a[0] < a[1], 'Int', 'Bool'], le: [a => a[0] <= a[1], 'Int', 'Bool'],
  gt: [a => a[0] > a[1], 'Int', 'Bool'], ge: [a => a[0] >= a[1], 'Int', 'Bool']
};

/** The allowlisted typed AST is checked before anything runs; LLM-supplied code is never evaluated. */
export function validateConstraint(problem) {
  const vars = problem.vars;
  assert(vars && typeof vars === 'object' && !Array.isArray(vars), 'vars object expected');
  const names = Object.keys(vars);
  assert(names.length <= 64, 'At most 64 variables');
  let nodes = 0;
  for (const name of names) {
    assert(/^[a-z][a-z0-9_]{0,31}$/.test(name), 'Invalid variable name');
    const v = vars[name];
    assert(v && v.sort === 'Int', 'Only Int variables are supported');
    assert(Object.keys(v).every(k => ['sort', 'min', 'max'].includes(k)), 'Unknown variable field');
    for (const k of ['min', 'max']) if (v[k] !== undefined) assert(Number.isSafeInteger(v[k]), 'Integer bound expected');
    if (v.min !== undefined && v.max !== undefined) assert(v.min <= v.max, 'Contradictory variable bounds');
  }
  const check = (x, type) => {
    assert(++nodes <= 4000, 'Expression too large');
    if (Number.isSafeInteger(x)) { assert(type === 'Int', 'Expected Boolean expression'); return; }
    if (typeof x === 'string') { assert(type === 'Int' && names.includes(x), 'Undeclared variable or sort mismatch'); return; }
    assert(x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).every(k => ['op', 'a'].includes(k)) && Array.isArray(x.a), 'Invalid expression');
    if (OPS[x.op]) {
      const [, input, output] = OPS[x.op];
      assert(type === output && x.a.length === 2, 'Wrong operator arity/type');
      if (x.op === 'mul') assert(x.a.some(Number.isSafeInteger), 'Only multiplication by an integer constant is allowed');
      x.a.forEach(a => check(a, input));
      return;
    }
    assert(type === 'Bool' && ['and', 'or', 'not'].includes(x.op), 'Unsupported operator');
    assert(x.op === 'not' ? x.a.length === 1 : x.a.length >= 1 && x.a.length <= 32, 'Invalid Boolean arity');
    x.a.forEach(a => check(a, 'Bool'));
  };
  assert(Array.isArray(problem.constraints) && problem.constraints.length <= 256, 'Invalid constraint list');
  problem.constraints.forEach(x => check(x, 'Bool'));
  if (problem.claim !== undefined) check(problem.claim, 'Bool');
  if (problem.objective !== undefined) check(problem.objective, 'Int');
}

/** Value of a typed expression under an assignment; integers stay safe integers. */
export function valueOf(x, env) {
  if (Number.isSafeInteger(x)) return x;
  if (typeof x === 'string') { assert(Object.hasOwn(env, x), 'Missing constraint variable'); return env[x]; }
  const a = x.a.map(v => valueOf(v, env));
  switch (x.op) {
    case 'and': return a.every(Boolean);
    case 'or': return a.some(Boolean);
    case 'not': return !a[0];
    default: {
      const [fn, , output] = OPS[x.op] ?? assert(false, 'Unknown constraint operator');
      const out = fn(a);
      if (output === 'Bool') return out;
      assert(Number.isSafeInteger(out), 'JS integer overflow; use Z3');
      return out;
    }
  }
}

const finite = p => Object.values(p.vars).every(v => Number.isSafeInteger(v.min) && Number.isSafeInteger(v.max));

/** The number of assignments of the declared domains; `Infinity` when a variable has no finite domain. */
export const assignmentsOf = p => Object.values(p.vars).reduce((n, v) => (Number.isSafeInteger(v.min) && Number.isSafeInteger(v.max) ? n * (v.max - v.min + 1) : Infinity), 1);

/** Project the models onto the output ports: `one` (a value only when unique), `many` (the distinct values), `rows` (the models). */
function projection(project, base, complete, models, empty = 'inconsistent') {
  const out = {};
  for (const p of project) {
    const values = [...new Set(models.map(m => m[p.name]))];
    out['?' + p.name] = !complete ? {status: 'incomplete'} : !base ? {status: empty} : p.mode === 'rows' ? {status: 'bound', value: models} : p.mode === 'many' ? {status: 'bound', value: values} : values.length === 1 ? {status: 'bound', value: values[0]} : {status: 'ambiguous', candidates: values.length};
  }
  return out;
}

/** Decide `task prove` or `possible` over the finite domains. */
export function enumerateConstraint(problem, {maxAssignments = 100000, project = []} = {}) {
  validateConstraint(problem);
  assert(finite(problem), 'JS constraints require finite integer domains');
  const names = Object.keys(problem.vars), total = assignmentsOf(problem);
  let seen = 0, base = 0, yes = 0, no = 0, witness = null, counterexample = null;
  const env = {}, models = [], keepModels = project.length > 0;
  const visit = i => {
    if (seen >= maxAssignments) return;
    if (i < names.length) { const name = names[i], v = problem.vars[name]; for (let n = v.min; n <= v.max && seen < maxAssignments; n++) { env[name] = n; visit(i + 1); } return; }
    seen++;
    if (!problem.constraints.every(c => valueOf(c, env))) return;
    base++;
    if (keepModels) models.push({...env});
    if (valueOf(problem.claim, env)) { yes++; witness ??= {...env}; } else { no++; counterexample ??= {...env}; }
  };
  visit(0);
  const complete = seen >= total;
  let status;
  if (!base && complete) status = 'inconsistent';
  else if (problem.task === 'possible') status = yes ? 'possible' : complete ? 'impossible' : 'unknown';
  else status = yes && no ? 'unknown' : !complete ? 'unknown' : yes ? 'entailed' : no ? 'refuted' : 'unknown';
  return {status, kind: 'constraint', task: problem.task, backend: 'js', complete, witness, counterexample, outputProjection: projection(project, base, complete, models),
    checks: {assignments: seen, total, baseModels: base, claimModels: yes, negatedClaimModels: no}, unit: problem.unit, assurance: 'Relative to the declared domains and admitted constraints.'};
}

/** Optimize the objective over the finite domains: the optimum, one witness and the number of optimal models. */
export function optimizeConstraint(problem, {maxAssignments = 100000, project = [], timeoutMs = 3000} = {}) {
  validateConstraint(problem);
  if (!finite(problem)) return {kind: 'constraint', status: 'unsupported', code: 'finite_domain_required', detail: 'Reference optimizer requires explicit finite integer domains', backend: 'js', complete: false};
  const names = Object.keys(problem.vars), started = performance.now(), total = assignmentsOf(problem);
  let checked = 0, best = null, models = [], cutoff = false;
  const env = {};
  const walk = i => {
    if (checked >= maxAssignments || performance.now() - started > timeoutMs) { cutoff = true; return; }
    if (i < names.length) { const n = names[i], v = problem.vars[n]; for (let x = v.min; x <= v.max; x++) { env[n] = x; walk(i + 1); if (cutoff) break; } return; }
    checked++;
    if (!problem.constraints.every(x => valueOf(x, env)) || !valueOf(problem.claim, env)) return;
    const value = valueOf(problem.objective, env), better = best === null || (problem.direction === 'max' ? value > best : value < best);
    if (better) { best = value; models = [{...env}]; } else if (value === best) models.push({...env});
  };
  walk(0);
  const complete = !cutoff && checked === total;
  return {kind: 'constraint', task: 'optimize', status: best === null ? (complete ? 'inconsistent' : 'unknown') : (complete ? 'optimal' : 'feasible_bound'), complete, backend: 'js', objective: best, direction: problem.direction,
    witness: models[0] ?? null, outputProjection: projection(project, best !== null, complete, models, 'no_answer'), checks: {assignments: checked, total, optimalModels: models.length}, epistemic: 'model-relative'};
}
