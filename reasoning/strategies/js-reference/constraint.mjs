/**
 * Finite-domain integer constraints by plain enumeration (the `constraint` wire, words only): `var ?x int MIN MAX`,
 * `require A WORD B`, `claim A WORD B`, `objective EXPR`, `direction`, `task prove|possible|optimize`, `select`.
 *
 * Results: `inconsistent` (the requirements have no model: nothing follows), `entailed` (the claim holds in every model),
 * `possible` (in some but not all, or a `possible` task that succeeded), `impossible` (in none), `optimal` (the optimum over the
 * enumerated models). A variable without bounds cannot be enumerated: the answer is `budget_exhausted` with reason `numeric_range`,
 * and an exhausted assignment budget is `budget_exhausted` with reason `domain`; neither is ever read as a negative answer.
 */
import {tokens, VAR, INTEGER, COMPARATORS, ARITHMETIC} from './wires.mjs';
import {ProgramError, compareValues} from './values.mjs';
import {BudgetStop} from './budget.mjs';

const f1 = (w, k) => w.fields.find(f => f.key === k);
const fAll = (w, k) => w.fields.filter(f => f.key === k);

function parseExpr(toks, wire) {
  if (!toks.length || toks.length % 2 === 0) throw new ProgramError('bad_expression', 'malformed arithmetic', wire);
  return toks.map((t, i) => {
    if (i % 2) { if (!ARITHMETIC.includes(t)) throw new ProgramError('bad_expression', `expected an arithmetic word, got ${t}`, wire); return t; }
    if (VAR.test(t)) return {var: t};
    if (INTEGER.test(t)) return Number(t);
    throw new ProgramError('bad_expression', `bad operand ${t}`, wire);
  });
}

function parseCmp(text, wire) {
  const toks = tokens(text);
  const at = toks.findIndex(t => COMPARATORS.includes(t));
  if (at < 0) throw new ProgramError('bad_expression', 'a comparison needs a comparator word', wire);
  return {left: parseExpr(toks.slice(0, at), wire), word: toks[at], right: parseExpr(toks.slice(at + 1), wire)};
}

/** Evaluate with the usual precedence (times and divided_by before plus and minus); undefined on a zero divisor or overflow. */
function evalExpr(expr, env) {
  const val = x => (typeof x === 'number' ? x : env[x.var]);
  const apply = (word, a, b) => {
    let r;
    if (word === 'plus') r = a + b; else if (word === 'minus') r = a - b; else if (word === 'times') r = a * b;
    else { if (b === 0) return undefined; r = Math.trunc(a / b); }
    return Number.isSafeInteger(r) ? r : undefined;
  };
  const vals = [val(expr[0])], ops = [];
  for (let i = 1; i < expr.length; i += 2) {
    const word = expr[i], b = val(expr[i + 1]);
    if (word === 'times' || word === 'divided_by') {
      const r = apply(word, vals.at(-1), b);
      if (r === undefined) return undefined;
      vals[vals.length - 1] = r;
    } else { ops.push(word); vals.push(b); }
  }
  let acc = vals[0];
  for (let i = 0; i < ops.length; i++) { acc = apply(ops[i], acc, vals[i + 1]); if (acc === undefined) return undefined; }
  return acc;
}

const holds = (c, env) => {
  const a = evalExpr(c.left, env), b = evalExpr(c.right, env);
  return a !== undefined && b !== undefined && compareValues(c.word, a, b);
};

export function parseConstraint(wire) {
  const vars = fAll(wire, 'var').map(f => {
    const t = tokens(f.value);
    return {name: t[0], min: t.length === 4 ? Number(t[2]) : null, max: t.length === 4 ? Number(t[3]) : null};
  });
  const claim = f1(wire, 'claim') ? parseCmp(f1(wire, 'claim').value, wire.id) : null;
  return {
    id: wire.id, vars, requires: fAll(wire, 'require').map(f => parseCmp(f.value, wire.id)), claim,
    objective: f1(wire, 'objective') ? parseExpr(tokens(f1(wire, 'objective').value), wire.id) : null,
    direction: f1(wire, 'direction')?.value.trim() ?? 'min',
    task: f1(wire, 'task')?.value.trim() ?? (claim ? 'prove' : 'possible'),
    select: f1(wire, 'select') ? tokens(f1(wire, 'select').value) : null
  };
}

const witnessOf = (p, env) => Object.fromEntries((p.select ?? p.vars.map(v => v.name)).map(n => [n.replace(/^\?/, ''), env[n]]));

/** Solve a parsed constraint under a budget. Returns a packet fragment. */
export function solveConstraint(p, budget) {
  const unbounded = p.vars.find(v => v.min === null);
  if (unbounded) return {status: 'budget_exhausted', complete: false, reason: 'numeric_range', detail: `${unbounded.name} has no finite domain`};
  let total = 1;
  for (const v of p.vars) total *= v.max - v.min + 1;
  const env = {};
  const stats = {models: 0, claimed: 0, first: null, firstClaimed: null, counter: null, best: null, bestEnv: null};
  const visit = () => {
    budget.count('maxAssignments');
    if (!p.requires.every(c => holds(c, env))) return;
    stats.models++;
    stats.first = stats.first ?? {...env};
    if (p.claim && !holds(p.claim, env)) { stats.counter = stats.counter ?? {...env}; return; }
    stats.claimed++;
    stats.firstClaimed = stats.firstClaimed ?? {...env};
    if (p.task === 'optimize') {
      const v = evalExpr(p.objective, env);
      if (v === undefined) return;
      if (stats.best === null || (p.direction === 'max' ? v > stats.best : v < stats.best)) { stats.best = v; stats.bestEnv = {...env}; }
    }
  };
  const walk = i => {
    if (i === p.vars.length) { visit(); return; }
    const v = p.vars[i];
    for (let x = v.min; x <= v.max; x++) { env[v.name] = x; walk(i + 1); }
  };
  try { walk(0); } catch (e) {
    if (e instanceof BudgetStop) return {status: 'budget_exhausted', complete: false, reason: e.reason};
    throw e;
  }
  const checks = {assignments: budget.used.maxAssignments, total, models: stats.models};
  if (!stats.models) return {status: 'inconsistent', complete: true, checks};
  if (p.task === 'optimize') {
    if (stats.best === null) return {status: 'impossible', complete: true, checks};
    return {status: 'optimal', complete: true, objective: stats.best, direction: p.direction, witness: witnessOf(p, stats.bestEnv), checks};
  }
  if (p.task === 'possible') return stats.claimed ? {status: 'possible', complete: true, witness: witnessOf(p, stats.firstClaimed), checks} : {status: 'impossible', complete: true, checks};
  if (stats.claimed === stats.models) return {status: 'entailed', complete: true, witness: witnessOf(p, stats.first), checks};
  if (!stats.claimed) return {status: 'impossible', complete: true, counterexample: witnessOf(p, stats.counter), checks};
  return {status: 'possible', complete: true, witness: witnessOf(p, stats.firstClaimed), counterexample: witnessOf(p, stats.counter), checks};
}
