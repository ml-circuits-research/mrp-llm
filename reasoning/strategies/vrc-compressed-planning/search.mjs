/**
 * Breadth-first search over (logical state, numeric state) with exact rational arithmetic, after VRC's `planner.mjs`
 * (`vrc.search.v1`): unit cost, one visited table per task, states with equal key merge. With a certified encoding the numeric
 * part of the key is the encoded state E(x), sound because E(T(x)) = G(E(x)) and the guards and the observation factor through E.
 * The returned plan is always replayed in the ORIGINAL laws (`replay`), never in the reduced ones.
 */
import {performance} from 'node:perf_hooks';
import {compileExactPolynomials, exactRelation} from './vendor/exact-runtime.mjs';
import {Rat} from './vendor/vrc/rational.mjs';

export const MAX_HORIZON = 64;

/** Exact runtime of the original laws (`model`) or of a certified reduced model (`reduced` = {E, G: per action, D, guards}). */
export function makeRuntime(model, reduced = null) {
  const acts = model.actions.map((a, i) => ({
    step: compileExactPolynomials(reduced ? reduced.actions[i].G : a.T),
    guards: (reduced ? reduced.actions[i].guards : a.guards).map(g => ({op: g.op, code: compileExactPolynomials([g.poly])}))
  }));
  const observation = compileExactPolynomials(reduced ? reduced.D : [model.goal.H]);
  const encoder = reduced ? compileExactPolynomials(reduced.E) : null;
  return {
    dimension: reduced ? reduced.E.length : model.variables.length,
    operations: acts.reduce((s, a) => s + a.step.operations, 0),
    encode: x => (encoder ? encoder.evaluate(x) : x.slice()),
    observe: z => observation.evaluate(z)[0],
    advance(z, i) {
      const a = acts[i];
      for (const g of a.guards) if (!exactRelation(g.op, g.code.evaluate(z)[0])) return null;
      return a.step.evaluate(z);
    }
  };
}

const stateKey = (logic, z, maxBits) => {
  for (const r of z) if (r.n.toString(2).length > maxBits + 1 || r.d.toString(2).length > maxBits) throw new RangeError('rational-bit-limit');
  return logic + '#' + z.map(r => r.toString()).join(',');
};

const logicKey = set => [...set].sort().join(';');

function logicalStep(set, a) {
  for (const r of a.requires) if (r.neg ? set.has(r.key) : !set.has(r.key)) return null;
  const next = new Set(set);
  for (const r of a.removes) next.delete(r.key);
  for (const x of a.adds) next.add(x.key);
  return next;
}

const goalLogic = (set, goal) => goal.atoms.every(a => (a.neg ? !set.has(a.key) : set.has(a.key)));

/**
 * One search. Returns {status: 'FOUND'|'NOT_FOUND'|'BUDGET', reason?, path?, depth, expanded, generated, merged, unique, ms, dimension}.
 * NOT_FOUND means the whole reachable quotient was explored within the horizon without reaching the goal AND the frontier emptied
 * (a finite closed state space); a frontier still alive at the horizon is BUDGET `horizon`.
 */
export function search(model, runtime, {maxDepth = 20, maxNodes = 2_000_000, maxMilliseconds = 30000, maxBits = 8192, keepPath = true} = {}) {
  const start = performance.now();
  const threshold = model.goal.threshold;
  const holds = (logic, z) => goalLogic(logic, model.goal) && exactRelation(model.goal.op, runtime.observe(z).sub(threshold));
  const initialZ = runtime.encode(model.initial);
  const nodes = [{logic: model.logic, z: initialZ, parent: -1, action: null, depth: 0}];
  const seen = new Set([stateKey(logicKey(model.logic), initialZ, maxBits)]);
  let frontier = [0], expanded = 0, generated = 0, merged = 0;
  const finish = (status, reason = null, goalIndex = null) => {
    let path = null;
    if (goalIndex !== null && keepPath) {
      path = [];
      for (let i = goalIndex; nodes[i].parent >= 0; i = nodes[i].parent) path.push(model.actions[nodes[i].action].id);
      path.reverse();
    }
    return {status, reason, path, depth: goalIndex === null ? null : nodes[goalIndex].depth, expanded, generated, merged, unique: seen.size, ms: performance.now() - start, dimension: runtime.dimension};
  };
  if (holds(model.logic, initialZ)) return finish('FOUND', null, 0);
  for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
    const next = [];
    for (const i of frontier) {
      if (performance.now() - start >= maxMilliseconds) return finish('BUDGET', 'wall');
      const node = nodes[i];
      expanded++;
      for (let k = 0; k < model.actions.length; k++) {
        const logic = logicalStep(node.logic, model.actions[k]);
        if (!logic) continue;
        const z = runtime.advance(node.z, k);
        if (!z) continue;
        generated++;
        let key;
        try { key = stateKey(logicKey(logic), z, maxBits); } catch { return finish('BUDGET', 'numeric_range'); }
        if (seen.has(key)) { merged++; continue; }
        if (seen.size >= maxNodes) return finish('BUDGET', 'nodes');
        const idx = nodes.length;
        nodes.push({logic, z, parent: keepPath ? i : -1, action: keepPath ? k : null, depth: depth + 1});
        seen.add(key);
        next.push(idx);
        if (holds(logic, z)) return finish('FOUND', null, idx);
      }
    }
    frontier = next;
  }
  return frontier.length ? finish('BUDGET', 'horizon') : finish('NOT_FOUND');
}

/** Replay a plan in the original laws (exact rationals, original guards); returns {verified, value, depth, why?}. */
export function replay(model, path) {
  const rt = makeRuntime(model);
  let z = model.initial.map(r => Rat.of(r)), logic = model.logic;
  for (let i = 0; i < path.length; i++) {
    const k = model.actions.findIndex(a => a.id === path[i]);
    if (k < 0) return {verified: false, why: 'unknown action', at: i};
    const l = logicalStep(logic, model.actions[k]);
    if (!l) return {verified: false, why: 'logical precondition false', at: i};
    const nz = rt.advance(z, k);
    if (!nz) return {verified: false, why: 'numeric guard false', at: i};
    logic = l; z = nz;
  }
  const value = rt.observe(z);
  return {verified: goalLogic(logic, model.goal) && exactRelation(model.goal.op, value.sub(model.goal.threshold)), value: value.toString(), depth: path.length};
}
