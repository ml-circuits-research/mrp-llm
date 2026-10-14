/**
 * The `constraint` wire in Z3: integer variables with their bounds, requirements as assertions, the claim checked in both polarities,
 * an objective as `minimize`/`maximize`. The first model of the oracle's enumeration is the lexicographically smallest one, so the
 * variables follow the objective as lower-priority `minimize` terms (`opt.priority lex`). Integer division truncates toward zero and a
 * zero divisor makes the comparison false, as in the oracle (`tdiv`, and a validity conjunct per divisor).
 */
import {runZ3, valuesOf, intOf, smtInt, SolverStop} from './z3.mjs';

const CMP = {equal: '=', above: '>', below: '<', at_least: '>=', at_most: '<='};
const TDIV = '(define-fun tdiv ((p Int) (q Int)) Int (ite (>= p 0) (ite (> q 0) (div p q) (- (div p (- q)))) (ite (> q 0) (- (div (- p) q)) (div (- p) (- q)))))';
const v = name => 'v_' + name.replace(/^\?/, '');
const operand = x => (typeof x === 'number' ? smtInt(x) : v(x.var));

/** An expression list [a, op, b, ...] with the usual precedence -> {term, valid: [conjuncts]}. */
function expr(e) {
  const valid = [];
  const apply = (w, a, b) => {
    if (w === 'divided_by') { valid.push(`(not (= ${b} 0))`); return `(tdiv ${a} ${b})`; }
    return `(${{plus: '+', minus: '-', times: '*'}[w]} ${a} ${b})`;
  };
  const vals = [operand(e[0])], ops = [];
  for (let i = 1; i < e.length; i += 2) {
    if (e[i] === 'times' || e[i] === 'divided_by') vals[vals.length - 1] = apply(e[i], vals.at(-1), operand(e[i + 1]));
    else { ops.push(e[i]); vals.push(operand(e[i + 1])); }
  }
  return {term: ops.reduce((acc, w, i) => apply(w, acc, vals[i + 1]), vals[0]), valid};
}

function holds(c) {
  const l = expr(c.left), r = expr(c.right);
  const cmp = c.word === 'not_equal' ? `(not (= ${l.term} ${r.term}))` : `(${CMP[c.word]} ${l.term} ${r.term})`;
  const valid = [...l.valid, ...r.valid];
  return valid.length ? `(and ${valid.join(' ')} ${cmp})` : cmp;
}

export function z3Constraint(p, budget) {
  const unbounded = p.vars.find(x => x.min === null);
  if (unbounded) return {status: 'budget_exhausted', complete: false, reason: 'numeric_range', detail: `${unbounded.name} has no finite domain`};
  const t = budget.limits.timeoutMs;
  const names = p.vars.map(x => x.name);
  const model = ({claim = null, objective = null}) => {
    const L = ['(set-option :opt.priority lex)', TDIV];
    for (const x of p.vars) L.push(`(declare-const ${v(x.name)} Int)`, `(assert (and (>= ${v(x.name)} ${smtInt(x.min)}) (<= ${v(x.name)} ${smtInt(x.max)})))`);
    for (const c of p.requires) L.push(`(assert ${holds(c)})`);
    if (claim === 'yes') L.push(`(assert ${holds(p.claim)})`);
    if (claim === 'no') L.push(`(assert (not ${holds(p.claim)}))`);
    let obj = null;
    if (objective) {
      const o = expr(p.objective);
      if (o.valid.length) L.push(`(assert (and ${o.valid.join(' ')}))`);
      obj = o.term;
      L.push(`(${objective === 'max' ? 'maximize' : 'minimize'} ${obj})`);
    }
    for (const x of p.vars) L.push(`(minimize ${v(x.name)})`);
    L.push('(check-sat)', `(get-value (${[...names.map(v), ...(obj ? [obj] : [])].join(' ')}))`);
    return L.join('\n') + '\n';
  };
  const solve = opts => {
    const r = runZ3(model(opts), {timeoutMs: t});
    if (r.interrupted) throw new SolverStop('wall');
    if (r.results[0] === 'unsat') return null;
    if (r.results[0] !== 'sat') throw new SolverStop('wall');
    const values = [...r.results[1]].map(pair => intOf(pair[1]));
    return {env: Object.fromEntries(names.map((n, i) => [n, values[i]])), objective: opts.objective ? values[names.length] : null};
  };
  const witnessOf = env => Object.fromEntries((p.select ?? names).map(n => [n.replace(/^\?/, ''), env[n]]));
  try {
    const first = solve({});
    if (!first) return {status: 'inconsistent', complete: true};
    if (p.task === 'optimize') {
      const best = solve({claim: p.claim ? 'yes' : null, objective: p.direction === 'max' ? 'max' : 'min'});
      if (!best) return {status: 'impossible', complete: true};
      return {status: 'optimal', complete: true, objective: best.objective, direction: p.direction, witness: witnessOf(best.env)};
    }
    const claimed = p.claim ? solve({claim: 'yes'}) : first;
    const counter = p.claim ? solve({claim: 'no'}) : null;
    if (p.task === 'possible') return claimed ? {status: 'possible', complete: true, witness: witnessOf(claimed.env)} : {status: 'impossible', complete: true};
    if (!counter) return {status: 'entailed', complete: true, witness: witnessOf(first.env)};
    if (!claimed) return {status: 'impossible', complete: true, counterexample: witnessOf(counter.env)};
    return {status: 'possible', complete: true, witness: witnessOf(claimed.env), counterexample: witnessOf(counter.env)};
  } catch (e) {
    if (e instanceof SolverStop) return {status: 'budget_exhausted', complete: false, reason: e.reason};
    throw e;
  }
}
