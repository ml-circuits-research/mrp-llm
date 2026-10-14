/**
 * The `constraint` wire in ASP: every variable is a choice over its finite domain, every requirement an integrity constraint over a
 * `holds_N` atom (an arithmetic instance that is undefined, such as a zero divisor, derives no `holds_N`, so the comparison is false
 * exactly as in the oracle), an objective is a `#minimize`. The first model of the oracle's enumeration is the lexicographically
 * smallest one, so it is reproduced by lower-priority `#minimize` statements on the variables in declaration order.
 */
import {runClingo, SolverStop} from './clingo.mjs';
import {NotExpressibleError} from '../js-reference/values.mjs';

const OPS = {plus: '+', minus: '-', times: '*', divided_by: '/'};
const CMP = {equal: '==', not_equal: '!=', above: '>', below: '<', at_least: '>=', at_most: '<='};
const v = name => 'V_' + name.replace(/^\?/, '');
const operand = x => (typeof x === 'number' ? (x < 0 ? `(${x})` : String(x)) : v(x.var));
const expr = e => e.map((t, i) => (i % 2 ? OPS[t] : operand(t))).join(' ');
const names = e => e.filter((t, i) => i % 2 === 0 && typeof t === 'object').map(t => t.var);

function modelText(p, {claim = null, objective = null, lexOrder = true}) {
  const lines = [];
  p.vars.forEach(x => lines.push(`1 { val("${x.name}",V) : V = ${x.min}..${x.max} } 1.`));
  const holds = (id, c) => {
    const used = [...new Set([...names(c.left), ...names(c.right)])];
    const body = [...used.map(n => `val("${n}",${v(n)})`), `${expr(c.left)} ${CMP[c.word]} ${expr(c.right)}`];
    lines.push(`${id} :- ${body.join(', ')}.`);
  };
  p.requires.forEach((c, i) => { holds(`holds_req${i}`, c); lines.push(`:- not holds_req${i}.`); });
  if (claim) { holds('holds_claim', p.claim); lines.push(claim === 'yes' ? ':- not holds_claim.' : ':- holds_claim.'); }
  const levels = p.vars.length + (objective ? 1 : 0);
  let level = levels;
  if (objective) {
    const used = [...new Set(names(p.objective))];
    lines.push(`objective(O) :- ${[...used.map(n => `val("${n}",${v(n)})`), `O = ${expr(p.objective)}`].join(', ')}.`);
    lines.push(':- not objective(_).');
    lines.push(`#minimize { ${objective === 'max' ? '-O' : 'O'}@${level},0 : objective(O) }.`);
    level--;
  }
  if (lexOrder) for (const x of p.vars) { lines.push(`#minimize { V@${level},"${x.name}" : val("${x.name}",V) }.`); level--; }
  return lines.join('\n') + '\n';
}

const envOf = (p, witness) => {
  const env = {};
  for (const a of witness.atoms) { const m = /^val\("(.+)",(-?\d+)\)$/.exec(a); if (m) env[m[1]] = Number(m[2]); }
  return env;
};
const INT32 = 2 ** 31 - 1;

/** Interval bound of an expression over the variable domains; gringo wraps at 32 bits silently, so a possible overflow is refused. */
function assertRange(p) {
  const dom = Object.fromEntries(p.vars.map(x => [x.name, [x.min, x.max]]));
  const val = x => (typeof x === 'number' ? [x, x] : dom[x.var]);
  const guard = ([lo, hi]) => { if (Math.abs(lo) > INT32 || Math.abs(hi) > INT32) throw new NotExpressibleError(['integer_range'], 'an expression of the constraint can leave the 32-bit range of clingo'); return [lo, hi]; };
  const apply = (w, [a, b], [c, d]) => {
    if (w === 'plus') return guard([a + c, b + d]);
    if (w === 'minus') return guard([a - d, b - c]);
    if (w === 'times') { const ps = [a * c, a * d, b * c, b * d]; return guard([Math.min(...ps), Math.max(...ps)]); }
    const m = Math.max(Math.abs(a), Math.abs(b));
    return [-m, m];
  };
  const range = e => {
    const vals = [val(e[0])], ops = [];
    for (let i = 1; i < e.length; i += 2) {
      if (e[i] === 'times' || e[i] === 'divided_by') vals[vals.length - 1] = apply(e[i], vals.at(-1), val(e[i + 1]));
      else { ops.push(e[i]); vals.push(val(e[i + 1])); }
    }
    return ops.reduce((acc, w, i) => apply(w, acc, vals[i + 1]), vals[0]);
  };
  for (const c of [...p.requires, ...(p.claim ? [p.claim] : [])]) { guard(range(c.left)); guard(range(c.right)); }
  if (p.objective) guard(range(p.objective));
}

const witnessOf = (p, env) => Object.fromEntries((p.select ?? p.vars.map(x => x.name)).map(n => [n.replace(/^\?/, ''), env[n]]));

export function aspConstraint(p, budget) {
  const unbounded = p.vars.find(x => x.min === null);
  if (unbounded) return {status: 'budget_exhausted', complete: false, reason: 'numeric_range', detail: `${unbounded.name} has no finite domain`};
  assertRange(p);
  const t = budget.limits.timeoutMs;
  const solve = opts => {
    const r = runClingo(modelText(p, opts), {timeoutMs: t, optMode: 'opt'});
    if (r.interrupted) throw new SolverStop('wall');
    return r.result === 'UNSAT' ? null : envOf(p, r.witnesses.at(-1));
  };
  try {
    const first = solve({});
    if (!first) return {status: 'inconsistent', complete: true};
    if (p.task === 'optimize') {
      const best = solve({claim: p.claim ? 'yes' : null, objective: p.direction === 'max' ? 'max' : 'min'});
      if (!best) return {status: 'impossible', complete: true};
      const value = objectiveValue(p, best);
      return {status: 'optimal', complete: true, objective: value, direction: p.direction, witness: witnessOf(p, best)};
    }
    const claimed = p.claim ? solve({claim: 'yes'}) : first;
    const counter = p.claim ? solve({claim: 'no'}) : null;
    if (p.task === 'possible') return claimed ? {status: 'possible', complete: true, witness: witnessOf(p, claimed)} : {status: 'impossible', complete: true};
    if (!counter) return {status: 'entailed', complete: true, witness: witnessOf(p, first)};
    if (!claimed) return {status: 'impossible', complete: true, counterexample: witnessOf(p, counter)};
    return {status: 'possible', complete: true, witness: witnessOf(p, claimed), counterexample: witnessOf(p, counter)};
  } catch (e) {
    if (e instanceof SolverStop) return {status: 'budget_exhausted', complete: false, reason: e.reason};
    throw e;
  }
}

/** The objective value of a model, computed with the same truncating arithmetic. */
function objectiveValue(p, env) {
  const val = x => (typeof x === 'number' ? x : env[x.var]);
  const apply = (w, a, b) => (w === 'plus' ? a + b : w === 'minus' ? a - b : w === 'times' ? a * b : Math.trunc(a / b));
  const e = p.objective;
  const vals = [val(e[0])], ops = [];
  for (let i = 1; i < e.length; i += 2) {
    if (e[i] === 'times' || e[i] === 'divided_by') vals[vals.length - 1] = apply(e[i], vals.at(-1), val(e[i + 1]));
    else { ops.push(e[i]); vals.push(val(e[i + 1])); }
  }
  return ops.reduce((acc, w, i) => apply(w, acc, vals[i + 1]), vals[0]);
}
