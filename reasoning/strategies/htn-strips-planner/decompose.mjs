/**
 * Method decomposition: the continuation of a search node is a list of items (the steps still to run); this module resolves every
 * internal choice point WITHOUT performing an action, so that a node of the search always starts with a primitive step, a blind
 * `achieve` or nothing. The legal executions of a method are the ways of resolving its choice points (proposal 8.2): `choose`,
 * `optional`, `any_order` and a sub-task's method give alternatives; `if` is decided by the state reached before the step; `pick`
 * ranges over the bindings of its atom; `until ATOM max N` tests before each pass and fails when the cap is reached.
 *
 * An item is {n: step node, env: bindings of the method run, m: the method it belongs to} or a special item:
 *   verifyAtom / verifyGoal   the run is only legal if the atom (the goal) holds when the steps are done;
 *   achieveAtom / achieveGoal blind search from primitives until the atom (the goal) holds (the planner "fills the gap").
 * `state` is {decisions, extra, pref}: the choices made on the way (for `choices` and `used`), the method costs added and the
 * number of dispreferred branches taken (the tie-break of `prefer ~a over ~b`).
 */
import {unify} from '../js-reference/join.mjs';
import {isVarTerm, groundArgs} from '../js-reference/values.mjs';
import {whenEnvs} from '../modes/run-eval.mjs';

const MAX_NESTING = 200;

export const bindTerm = (t, env) => (isVarTerm(t) ? (t.var in env ? env[t.var] : t) : t);
const show = t => (isVarTerm(t) ? t.var : typeof t === 'string' && /[^A-Za-z0-9_.:\-]/.test(t) ? JSON.stringify(t) : String(t));

/** The text of a step under the bindings reached so far (`~soft_reset r7`), unbound variables kept. */
export function renderStep(n, env) {
  if (n.kind === 'prim') return ['~' + n.action, ...n.terms.map(t => show(bindTerm(t, env)))].join(' ');
  if (n.kind === 'optional') return 'optional ' + renderStep(n.item, env);
  if (['task', 'achieve'].includes(n.kind)) return (n.kind === 'achieve' ? 'achieve ' : '') + [n.p, ...n.terms.map(t => show(bindTerm(t, env)))].join(' ');
  return n.text;
}

const atomLeaf = (n, closed) => ({kind: 'atom', mode: n.neg === 'none' ? 'pos' : n.neg === 'not' && closed.has(n.p) ? 'absent' : n.neg, p: n.p, args: n.terms});

/** Rebind the items of a run (those that share `old`) to the extended bindings `next`. */
const rebind = (items, old, next) => items.map(i => (i.env === old ? {...i, env: next} : i));

export class Decomposer {
  /** `world` the planning world; `methods` the methods in force; `goal` {holds(ev)}; `stats` collects what a failed search reports. */
  constructor({world, methods, goal, stats}) {
    this.world = world;
    this.methods = methods;
    this.goal = goal;
    this.stats = stats;
    this.closed = world.closed;
  }

  holdsAtom(n, ev, env) { return [...this.world.solve([atomLeaf(n, this.closed)], ev, env)]; }

  /** Methods that achieve the task atom (p, args ground or bound) and whose guard holds: [{method, env}]. */
  applicableMethods(p, args, ev, among = this.methods) {
    const out = [];
    for (const M of among) {
      if (M.achieves.p !== p || M.achieves.terms.length !== args.length) continue;
      const env0 = unify(M.achieves.terms, args, {});
      if (!env0) continue;
      for (const env of whenEnvs(this.world, M, ev, env0)) out.push({method: M, env});
    }
    return out;
  }

  /** True when a strict method applies to the task: the engine may then not plan it from primitives. */
  strictApplies(p, args, ev) { return this.applicableMethods(p, args, ev).some(a => a.method.binding === 'strict'); }

  bodyOf(method, env, tail) {
    const goalAtom = {kind: 'achieve', p: method.achieves.p, terms: method.achieves.terms, neg: 'none'};
    return [...method.steps.map(n => ({n, env, m: method})), {special: 'verifyAtom', n: goalAtom, env}, ...tail];
  }

  /** Resolve the head of `cont` (and what follows) into continuations that start with a primitive, a blind step or nothing. */
  *normalize(ev, cont, state, depth = 0) {
    if (depth > MAX_NESTING) { this.stats.capHit = this.stats.capHit ?? 'nesting'; return; }
    if (!cont.length) { yield {cont, state}; return; }
    const [h, ...rest] = cont;
    const kind = h.special ?? h.n.kind;
    const next = (items, st = state) => this.normalize(ev, items, st, depth + 1);
    const add = (st, d, extra = 0, pref = 0) => ({decisions: [...st.decisions, ...(d ? [d] : [])], extra: st.extra + extra, pref: st.pref + pref});
    switch (kind) {
      case 'prim': case 'achieveGoal': yield {cont, state}; return;
      case 'achieveAtom':
        if (this.holdsAtom(h.n, ev, h.env).length) yield* next(rest);
        else yield {cont, state};
        return;
      case 'verifyAtom':
        if (this.holdsAtom(h.n, ev, h.env).length) yield* next(rest);
        else this.stats.verifyFailed = h.n.text ?? h.n.p;
        return;
      case 'verifyGoal':
        if (this.goal.holds(ev)) yield* next(rest);
        return;
      case 'optional':
        yield* next(rest, add(state, {kind: 'optional', chosen: 'skip', alternatives: [renderStep(h.n.item, h.env)]}));
        yield* next([{n: h.n.item, env: h.env, m: h.m}, ...rest], add(state, {kind: 'optional', chosen: renderStep(h.n.item, h.env), alternatives: ['skip']}));
        return;
      case 'choose': {
        const texts = h.n.branches.map(b => renderStep(b, h.env));
        const prefs = h.n.branches.map(b => (b.kind === 'prim' && h.m ? h.m.prefer.filter(p => p.worse === b.action && h.n.branches.some(o => o.kind === 'prim' && o.action === p.better)).length : 0));
        for (const [i, b] of h.n.branches.entries()) {
          const d = {kind: 'choose', chosen: texts[i], alternatives: texts.filter((_, j) => j !== i), alts: h.n.branches.filter((_, j) => j !== i).map(n => ({n, env: h.env}))};
          yield* next([{n: b, env: h.env, m: h.m}, ...rest], add(state, d, 0, prefs[i]));
        }
        return;
      }
      case 'any_order': {
        const items = h.n.items;
        if (!items.length) { yield* next(rest); return; }
        const texts = items.map(b => renderStep(b, h.env));
        for (const [i, b] of items.entries()) {
          const left = items.filter((_, j) => j !== i);
          const d = {kind: 'any_order', chosen: texts[i], alternatives: texts.filter((_, j) => j !== i), alts: items.filter((_, j) => j !== i).map(n => ({n, env: h.env}))};
          yield* next([{n: b, env: h.env, m: h.m}, ...(left.length ? [{n: {kind: 'any_order', items: left}, env: h.env, m: h.m}] : []), ...rest], add(state, items.length > 1 ? d : null));
        }
        return;
      }
      case 'if': {
        const hit = this.holdsAtom(h.n, ev, h.env);
        const branch = hit.length ? h.n.then : h.n.otherwise;
        const env = hit.length ? hit[0] : h.env;
        yield* next([...branch.map(n => ({n, env, m: h.m})), ...rebind(rest, h.env, env)], state);
        return;
      }
      case 'until': {
        const count = h.count ?? 0;
        if (this.holdsAtom(h.n, ev, h.env).length) { yield* next(rest); return; }
        if (count >= h.n.max) { this.stats.capHit = 'until'; this.stats.untilCap = {step: h.n.text, max: h.n.max}; return; }
        yield* next([...h.n.body.map(n => ({n, env: h.env, m: h.m})), {...h, count: count + 1}, ...rest], state);
        return;
      }
      case 'pick': {
        for (const env of this.holdsAtom(h.n, ev, h.env)) yield* next(rebind(rest, h.env, env), state);
        return;
      }
      case 'task': {
        const args = groundArgs(h.n.terms, h.env);
        if (!args) { this.stats.verifyFailed = h.n.text; return; }
        const cands = this.applicableMethods(h.n.p, args, ev);
        if (!cands.length) { this.stats.noMethod = h.n.text; return; }
        for (const {method, env} of cands) {
          const d = {kind: 'method', id: method.id, version: method.version, task: renderStep(h.n, h.env)};
          yield* next(this.bodyOf(method, env, rest), add(state, d, method.cost));
        }
        return;
      }
      case 'achieve': {
        const args = groundArgs(h.n.terms, h.env);
        if (args && this.holdsAtom(h.n, ev, h.env).length) { yield* next(rest); return; }
        const cands = args ? this.applicableMethods(h.n.p, args, ev) : [];
        for (const {method, env} of cands) {
          const d = {kind: 'method', id: method.id, version: method.version, task: renderStep(h.n, h.env)};
          yield* next(this.bodyOf(method, env, rest), add(state, d, method.cost));
        }
        if (!cands.some(c => c.method.binding === 'strict')) yield* next([{special: 'achieveAtom', n: h.n, env: h.env}, ...rest], state);
        return;
      }
      default: throw new Error('unknown continuation item ' + kind);
    }
  }
}
