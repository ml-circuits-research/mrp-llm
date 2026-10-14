/**
 * Norms over a run: the temporal qualifiers of proposal 8.2 evaluated over a finite run (a plan prefix, a whole plan or a recorded
 * trace). One function serves the planner (monitors while it searches: hard violations prune, soft ones cost), `check(plan)` and
 * `conform(trace)`, so planning and auditing cannot disagree. The conform lowering (`../conform/`) states the same definitions as
 * core rules; the shadow test compares the two.
 *
 * A run has steps 1..n and states 0..n (state i is the state after step i; step i is performed in state i-1). A norm is judged
 * at the moment of each step (`inForce(norm, i)`, so a trace is judged against the versions in force when each step was done).
 * Definitions (each norm INSTANCE, a norm with a binding of its pattern variables, is violated at most once, at its first step):
 *   forbid ~a        an occurrence at step i whose `when` holds in state i-1 and that no override blocks; `before ~b` only while no b
 *                    has occurred at a step < i, `after ~b` only once one has, `at_most_once` from the second occurrence on;
 *   forbid ATOM      the state atom holds with `when` in some state m (the initial state included); `before`/`after` count the b steps <= m;
 *   oblige           an instance is triggered at the first state k where `when` holds for a binding whose values are relevant (the goal's
 *                    constants or parameters of steps <= k+1, the next step binds them; `standing` waives the test), then
 *     sometime       an occurrence at a step i > k (a state m >= k for an atom), else violated at the end of the run;
 *     within N       an occurrence at a step i with k < i <= k+N (a state k..k+N for an atom; N days for a timestamped trace), else violated
 *                    when the deadline passes or, if the run ends first, at the end;
 *     before ~b      a b at step j > k needs an occurrence at a step i with k < i < j, else violated at j;
 *     after ~b       after the last b at a step > k there must be an occurrence, else violated at the end;
 *     always (atom)  violated at the first state m >= k where the atom does not hold.
 * Unmet obligations at the end are violations only when `final` is true; before that they are `pending`.
 */
import {unify} from '../js-reference/join.mjs';
import {orderLeaves} from '../js-reference/program.mjs';
import {NotExpressibleError, groundArgs} from '../js-reference/values.mjs';
import {instanceName} from './model.mjs';

function orderedAlts(norm, bound, extra = null) {
  const key = (extra ? 'S' : 'A') + [...bound].sort().join(',');
  norm.ordered ??= new Map();
  let r = norm.ordered.get(key);
  if (!r) {
    r = norm.whenAlts.map(alt => orderLeaves(extra ? [extra, ...alt] : alt, norm.id, new Set(bound)).leaves);
    norm.ordered.set(key, r);
  }
  return r;
}

/** Environments in which the `when` of a norm holds in the closure `ev`, extending `env`. */
export function* whenEnvs(world, norm, ev, env = {}) {
  for (const leaves of orderedAlts(norm, Object.keys(env))) yield* world.solve(leaves, ev, env);
}
export const whenHolds = (world, norm, ev, env = {}) => !whenEnvs(world, norm, ev, env).next().done;

const patternLeaf = norm => ({kind: 'atom', mode: 'pos', p: norm.pat.p, args: norm.pat.terms});

/** Solutions of a state-atom norm in a state: the pattern atom joined with `when`. */
function* stateEnvs(world, norm, ev) {
  for (const leaves of orderedAlts(norm, [], patternLeaf(norm))) yield* world.solve(leaves, ev, {});
}

const sameValues = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The norm that overrides `norm` for step i (its pattern matches the same action, its `when` holds before the step), or null. */
function overrider(world, norm, edges, byId, i, step, states, inForce) {
  for (const e of edges) {
    if (e.target !== norm.id) continue;
    const o = byId.get(e.over);
    if (!o || o.pat.kind !== 'action' || o.pat.action !== step.action || !inForce(o, i)) continue;
    const env = unify(o.pat.terms, step.args, {});
    if (env && whenHolds(world, o, states[i - 1].ev, env)) return o;
  }
  return null;
}

/**
 * Evaluate the norms over a run. `run` = {states: [{ev}] (n+1), steps: [{action, args}] (n)}; `days` (optional) = the day number of each
 * step 1..n for a fully timestamped trace (index 0 repeats step 1). Returns {violations, triggered, pending, used, summary}.
 */
export function evaluateRun({world, norms, edges = [], run, goalConsts = new Set(), final = false, inForce = () => true, days = null}) {
  const {states, steps} = run;
  const n = steps.length;
  const byId = new Map(norms.map(x => [x.id, x]));
  // a value is relevant at state m when it is a goal constant or a parameter of a step up to the NEXT one (the step about to be performed binds it)
  const rel = [];
  for (let m = 0; m <= n; m++) rel.push(new Set([...goalConsts, ...steps.slice(0, m + 1).flatMap(s => s.args)]));
  const stepsNamed = name => steps.flatMap((s, i) => (s.action === name ? [i + 1] : []));
  const violations = [], triggered = [], pending = [], used = new Set(), summary = [];
  const unscoped = new Set();
  const violate = (norm, values, step, why) => violations.push({norm, id: norm.id, version: norm.version, severity: norm.severity, binding: norm.binding, cost: norm.severity === 'soft' ? norm.cost : 0, inst: instanceName(norm.id, values), values, step, why, message: norm.message});

  for (const N of norms) {
    if (N.modality === 'permit') continue;
    if (N.modality === 'forbid' && N.pat.kind === 'action') {
      const done = new Set(), occurrences = new Map();
      for (let i = 1; i <= n; i++) {
        const step = steps[i - 1];
        if (step.action !== N.pat.action || step.args.length !== N.pat.terms.length || !inForce(N, i)) continue;
        const env = unify(N.pat.terms, step.args, {});
        if (!env || !whenHolds(world, N, states[i - 1].ev, env)) continue;
        used.add(N.id);
        const values = N.patVars.map(v => env[v]);
        const by = overrider(world, N, edges, byId, i, step, states, inForce);
        if (by) { used.add(by.id); continue; }
        const b = N.qual.ref ? stepsNamed(N.qual.ref) : [];
        const bBefore = b.some(j => j < i);
        if (N.qual.kind === 'before' && bBefore) continue;
        if (N.qual.kind === 'after' && !bBefore) continue;
        const key = instanceName(N.id, values);
        if (N.qual.kind === 'at_most_once') {
          const c = (occurrences.get(key) ?? 0) + 1;
          occurrences.set(key, c);
          if (c < 2) continue;
        }
        if (!done.has(key)) { done.add(key); violate(N, values, i, 'forbidden step performed'); }
      }
      summary.push([N.id, [...done].sort(), [...occurrences].sort(), N.qual.ref ? stepsNamed(N.qual.ref).length > 0 : null]);
      continue;
    }
    if (N.modality === 'forbid') {
      if (N.qual.kind === 'at_most_once') throw new NotExpressibleError(['temporal_norms'], `at_most_once over the state atom of ${N.id}`);
      const done = new Set();
      for (let m = 0; m <= n; m++) {
        if (!inForce(N, m)) continue;
        const bSeen = N.qual.ref ? stepsNamed(N.qual.ref).some(j => j <= m) : false;
        if (N.qual.kind === 'before' && bSeen) continue;
        if (N.qual.kind === 'after' && !bSeen) continue;
        for (const env of stateEnvs(world, N, states[m].ev)) {
          used.add(N.id);
          const values = N.patVars.map(v => env[v]);
          const key = instanceName(N.id, values);
          if (!done.has(key)) { done.add(key); violate(N, values, m, 'forbidden state reached'); }
        }
      }
      summary.push([N.id, [...done].sort(), N.qual.ref ? stepsNamed(N.qual.ref).length > 0 : null]);
      continue;
    }
    // oblige: find the instances
    const instances = new Map();
    for (let m = 0; m <= n; m++) {
      if (!inForce(N, m)) continue;
      for (const env of whenEnvs(world, N, states[m].ev)) {
        const values = N.patVars.map(v => env[v]);
        if (values.some(v => v === undefined)) throw new NotExpressibleError(['norms_hard'], `a variable of the obligation ${N.id} is bound by no when atom`);
        if (!N.standing && !values.every(v => rel[m].has(v))) continue;
        const key = instanceName(N.id, values);
        if (!instances.has(key)) instances.set(key, {values, k: m});
      }
    }
    const state = [];
    for (const [key, {values, k}] of [...instances].sort(([a], [b]) => (a < b ? -1 : 1))) {
      used.add(N.id);
      triggered.push({id: N.id, key, values, severity: N.severity});
      if (N.standing && N.patVars.length) unscoped.add(N.id);
      const env = Object.fromEntries(N.patVars.map((v, i) => [v, values[i]]));
      const outcome = obligationOutcome({world, N, env, values, k, n, steps, states, stepsNamed, final, days});
      if (outcome.violation) violate(N, values, outcome.violation.step, outcome.violation.why);
      else if (outcome.pending) pending.push({norm: N, id: N.id, key, remaining: outcome.pending.remaining});
      state.push([key, outcome.violation ? 'v' : outcome.pending ? 'p' + (outcome.pending.remaining ?? '') : 'm']);
    }
    summary.push([N.id, state]);
  }
  // the relevant constants only matter for the triggers of scoped obligations that may still come
  if (norms.some(x => x.modality === 'oblige' && !x.standing)) summary.push(['rel', [...rel[n]].map(String).sort()]);
  return {violations, triggered, pending, used, unscoped: [...unscoped], summary: JSON.stringify(summary)};
}

/** How one triggered obligation instance stands: {violation: {step, why}} | {pending: {remaining}} | {} (met, or nothing owed yet). */
function obligationOutcome({world, N, env, values, k, n, steps, states, stepsNamed, final, days}) {
  const q = N.qual;
  const unmetEnd = why => (final ? {violation: {step: n, why}} : {pending: {remaining: null}});
  if (N.pat.kind === 'action') {
    const occ = [];
    for (let i = Math.max(k + 1, 1); i <= n; i++) {
      const s = steps[i - 1];
      if (s.action !== N.pat.action || s.args.length !== N.pat.terms.length) continue;
      const e = unify(N.pat.terms, s.args, {});
      if (e && sameValues(N.patVars.map(v => e[v]), values)) occ.push(i);
    }
    if (q.kind === 'sometime') return occ.length ? {} : unmetEnd('obligation not met by the end');
    if (q.kind === 'within') {
      if (days) {
        const tk = days[Math.max(k, 1)];
        if (occ.some(i => days[i] - tk <= q.n)) return {};
        const late = steps.findIndex((_, j) => j + 1 > k && days[j + 1] - tk > q.n);
        if (late >= 0) return {violation: {step: late + 1, why: `not met within ${q.n} days`}};
        return unmetEnd(`not met within ${q.n} days`);
      }
      const deadline = k + q.n;
      if (occ.some(i => i <= deadline)) return {};
      if (n >= deadline) return {violation: {step: deadline, why: `not met within ${q.n} steps`}};
      return final ? {violation: {step: n, why: 'run ended before the obligation was met'}} : {pending: {remaining: deadline - n}};
    }
    if (q.kind === 'before') {
      const bj = stepsNamed(q.ref).find(j => j > k);
      if (bj === undefined) return {};
      return occ.some(i => i < bj) ? {} : {violation: {step: bj, why: `${q.ref} happened before the obligation was met`}};
    }
    if (q.kind === 'after') {
      const last = stepsNamed(q.ref).filter(j => j > k).at(-1);
      if (last === undefined || occ.some(i => i > last)) return {};
      return unmetEnd(`no follow-up after ${q.ref}`);
    }
    return {};
  }
  // state atom pattern
  const args = groundArgs(N.pat.terms, env);
  const holdsAt = m => Boolean(states[m].ev.get(false, N.pat.p, args));
  if (q.kind === 'always') {
    for (let m = k; m <= n; m++) if (!holdsAt(m)) return {violation: {step: m, why: 'the state to maintain does not hold'}};
    return {};
  }
  if (q.kind === 'sometime') { for (let m = k; m <= n; m++) if (holdsAt(m)) return {}; return unmetEnd('state never reached'); }
  if (q.kind === 'within') {
    for (let m = k; m <= Math.min(n, k + q.n); m++) if (holdsAt(m)) return {};
    if (n >= k + q.n) return {violation: {step: k + q.n, why: `state not reached within ${q.n} steps`}};
    return final ? {violation: {step: n, why: 'run ended before the state was reached'}} : {pending: {remaining: k + q.n - n}};
  }
  throw new NotExpressibleError(['temporal_norms'], `${q.kind} over the state atom of ${N.id}`);
}

