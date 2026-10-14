/**
 * Method deviation in conformance (proposal 8.4, rule 2): leaving a strict method (a step the method does not allow, a step
 * skipped, an order broken) is non-compliance and the method is listed in `compliance.deviations`; under `binding advisory` the
 * deviation is only reported.
 *
 * Which part of a trace a method judges. A method is ENGAGED by an instance: a binding A of the variables of its `achieves` taken
 * from a trace step that matches one of its primitive steps (variables that step does not bind range over the constants of the
 * trace). The SCOPE of the instance is the trace steps, performed while the method is in force, that mention a value of A (all steps
 * for a method without variables). The method's `when` must hold in the state before the first scope step. The instance conforms iff
 * the scope, read as one sequence, is exactly one legal run of the method's steps: `choose` picks a branch, `optional` may be skipped,
 * `any_order` accepts every order, `if` tests the state, `until ATOM max N` tests before each pass and fails when the cap is
 * reached with the condition still false, `pick` binds a variable by a state atom. The state tested at a position is the state
 * right after the last consumed scope step (the state before the first scope step at the start). `achieve` and a sub-task step
 * (which fill the gap with arbitrary steps) are not checked: the method is then `not_expressible` for conformance.
 */
import {unify} from '../js-reference/join.mjs';
import {NotExpressibleError} from '../js-reference/values.mjs';
import {primitivesOf, varsOfTerms} from './model.mjs';
import {whenEnvs} from './run-eval.mjs';

function* permutations(items, k = items.length) {
  if (items.length <= 1) { yield items; return; }
  for (let i = 0; i < items.length; i++) for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)])) yield [items[i], ...rest];
}

/**
 * Does the step tree contain a form the conformance check cannot decide? `achieve` and sub-tasks fill the gap with arbitrary steps;
 * the variables of an `if` or `until` condition and of a `pick` atom must be bound before the node (the achieves variables, plus the
 * picked variable) so that the test is a plain lookup of the state.
 */
export function unsupportedForm(nodes, allowed) {
  for (const n of nodes) {
    if (n.kind === 'achieve' || n.kind === 'task') return n.kind;
    const vars = n.terms ? varsOfTerms(n.terms) : [];
    if (['if', 'until'].includes(n.kind) && vars.some(v => !allowed.has(v))) return `${n.kind} on a variable the method does not bind first`;
    if (n.kind === 'pick' && vars.some(v => v !== n.variable && !allowed.has(v))) return 'pick on a variable the method does not bind first';
    const inner = [n.item, ...(n.branches ?? []), ...(n.items ?? []), ...(n.then ?? []), ...(n.otherwise ?? []), ...(n.body ?? [])].filter(Boolean);
    const u = unsupportedForm(inner, n.kind === 'pick' ? new Set([...allowed, n.variable]) : allowed);
    if (u) return u;
  }
  return null;
}

/** A method that a trace could engage (a step in force that performs one of its primitives) and that has a form conformance cannot check. */
export function conformanceBlocker(method, steps, inForceAt) {
  const A = new Set(varsOfTerms(method.achieves.terms));
  const bad = unsupportedForm(method.steps, A);
  if (!bad) return null;
  const names = new Set(primitivesOf(method.steps).map(p => p.action));
  return steps.some((s, k) => names.has(s.action) && inForceAt(method, k + 1)) ? bad : null;
}

/** Recognise the scope sequence by the method's steps. `at(p)` = the closure of the state tested at position p; `S` = scope step indices. */
export function recognises({world, method, S, steps, at, env0}) {
  const len = S.length;
  const atomEnv = (node, p, env) => {
    const leaf = {kind: 'atom', mode: node.neg === 'none' ? 'pos' : node.neg, p: node.p, args: node.terms};
    return [...world.solve([leaf], at(p), env)];
  };
  function* seq(nodes, p, env) {
    if (!nodes.length) { yield [p, env]; return; }
    for (const [p2, e2] of one(nodes[0], p, env)) yield* seq(nodes.slice(1), p2, e2);
  }
  function* one(node, p, env) {
    switch (node.kind) {
      case 'prim': {
        if (p >= len) return;
        const s = steps[S[p] - 1];
        if (s.action !== node.action || s.args.length !== node.terms.length) return;
        const e2 = unify(node.terms, s.args, env);
        if (e2) yield [p + 1, e2];
        return;
      }
      case 'optional': yield* one(node.item, p, env); yield [p, env]; return;
      case 'choose': for (const b of node.branches) yield* one(b, p, env); return;
      case 'any_order': for (const perm of permutations(node.items)) yield* seq(perm, p, env); return;
      case 'if': {
        const holds = atomEnv(node, p, env);
        if (holds.length) yield* seq(node.then, p, holds[0]);
        else yield* seq(node.otherwise, p, env);
        return;
      }
      case 'until': {
        const pass = function* (c, q, e) {
          const done = atomEnv(node, q, e);
          if (done.length) { yield [q, done[0]]; return; }
          if (c >= node.max) return;
          for (const [q2, e2] of seq(node.body, q, e)) yield* pass(c + 1, q2, e2);
        };
        yield* pass(0, p, env);
        return;
      }
      case 'pick': {
        for (const e2 of atomEnv(node, p, env)) yield [p, e2];
        return;
      }
      default: throw new NotExpressibleError(['conform_deviation'], `method ${method.id}: the step form ${node.kind} is not checked in conformance`);
    }
  }
  for (const [p] of seq(method.steps, 0, env0)) if (p === len) return true;
  return false;
}

/**
 * Check the methods against a trace. `methodsInForce(j)` = the methods in force at step j. Returns {engaged: [{method, instance}],
 * deviations: [{method, instance, binding}]} (one record per method instance).
 */
export function checkMethods({world, methods, steps, states, inForceAt}) {
  const dom = [...new Set(steps.flatMap(s => s.args))];
  const engaged = [], deviations = [];
  for (const M of methods) {
    const bad = conformanceBlocker(M, steps, inForceAt);
    if (bad) throw new NotExpressibleError(['conform_deviation'], `method ${M.id}: ${bad} steps are not checked in conformance`);
    const A = varsOfTerms(M.achieves.terms);
    const instances = new Map();
    for (const P of primitivesOf(M.steps)) {
      steps.forEach((s, idx) => {
        const j = idx + 1;
        if (!inForceAt(M, j) || s.action !== P.action || s.args.length !== P.terms.length) return;
        const e = unify(P.terms, s.args, {});
        if (!e) return;
        const options = A.map(v => (v in e ? [e[v]] : dom));
        const cross = options.reduce((acc, o) => acc.flatMap(a => o.map(x => [...a, x])), [[]]);
        for (const vals of cross) instances.set(JSON.stringify(vals), vals);
      });
    }
    for (const vals of instances.values()) {
      const S = steps.flatMap((s, idx) => (inForceAt(M, idx + 1) && (A.length === 0 || s.args.some(x => vals.includes(x))) ? [idx + 1] : []));
      if (!S.length) continue;
      const env0 = Object.fromEntries(A.map((v, i) => [v, vals[i]]));
      const at = p => states[p === 0 ? S[0] - 1 : S[p - 1]].ev;
      const guard = whenEnvs(world, M, at(0), env0).next();
      if (guard.done) continue;
      const instance = [M.id, ...vals].join(' ');
      engaged.push({method: M, instance, binding: M.binding});
      if (!recognises({world, method: M, S, steps, at, env0})) deviations.push({method: M, id: M.id, version: M.version, instance, binding: M.binding});
    }
  }
  return {engaged, deviations};
}

