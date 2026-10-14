/**
 * The planning world shared by the planner and by the state replay of the conform lowering: a state is a set of ground literals
 * `+p a` / `-p a` (polarity-explicit, proposal 4.2 item 8), the derived relations are the closure of the program's rules over the
 * literals of the state, and an action is a STRIPS transition. Same semantics as the oracle's `plan.mjs` (preconditions need
 * positive evidence, `requires not p` needs negative evidence for an open fluent and the absence of `p` for a closed one; `removes`
 * on an open fluent records the negative literal), kept here as a small class so a node of a search can ask "what holds" and
 * "which actions apply" without re-compiling anything.
 */
import {saturate} from '../js-reference/engine.mjs';
import {join} from '../js-reference/join.mjs';
import {orderLeaves} from '../js-reference/program.mjs';
import {READ_BUDGET} from '../js-reference/query.mjs';
import {BudgetStop} from '../js-reference/budget.mjs';
import {argsKey, groundArgs, atomText, ProgramError, isVarTerm} from '../js-reference/values.mjs';

export const litKey = (neg, p, args) => `${neg ? '-' : '+'}${p}|${argsKey(args)}`;

/** `not p` over a closed fluent is absence, over an open fluent it is negative evidence. */
const asPrecondition = (a, closed) => ({kind: 'atom', mode: a.neg ? (closed.has(a.p) ? 'absent' : 'not') : 'pos', p: a.p, args: a.args});

export class World {
  /** `program` is a compiled program (wires in force, desugared); `budget` the strategy budget (one child per closure). */
  constructor(program, budget) {
    this.program = program;
    this.budget = budget;
    this.closed = program.closed;
    this.cache = new Map();
    this.actions = new Map();
    for (const a of program.actions) {
      const leaves = orderLeaves(a.requires.map(r => asPrecondition(r, this.closed)), a.id);
      for (const v of a.params) if (!leaves.bound.has(v)) throw new ProgramError('action_parameter_unbound', `parameter ${v} of ${a.id} is not bound by a positive precondition`, a.id);
      for (const e of [...a.adds, ...a.removes]) for (const t of e.args) if (isVarTerm(t) && !leaves.bound.has(t.var)) throw new ProgramError('unsafe_action', `an effect of ${a.id} uses an unbound variable`, a.id);
      this.actions.set(a.id, {...a, leaves: leaves.leaves});
    }
  }

  initial(facts = this.program.facts) {
    const lits = new Map();
    for (const f of facts) lits.set(litKey(f.neg, f.p, f.args), {neg: f.neg, p: f.p, args: f.args});
    return lits;
  }

  stateKey(lits) { return [...lits.keys()].sort().join(';'); }

  /**
   * The predicates whose NEGATIVE evidence anything reads (a `not` leaf of a precondition, rule, goal, norm or method condition). The
   * negative literals of every other predicate cannot change what happens next, so the search leaves them out of the key it
   * deduplicates on: an open fluent that is moved (`removes at r a` records `-at r a`) would otherwise make every path a new state.
   */
  watchNegatives(extra = []) {
    const out = new Set(extra);
    for (const a of this.actions.values()) for (const r of a.requires) if (r.neg && !this.closed.has(r.p)) out.add(r.p);
    for (const r of this.program.rules) for (const alt of r.alts) for (const l of alt.leaves) if (l.kind === 'atom' && l.mode === 'not') out.add(l.p);
    for (const g of this.program.aggregates) for (const alt of g.alts) for (const l of alt.leaves) if (l.kind === 'atom' && l.mode === 'not') out.add(l.p);
    this.negWatched = out;
    return out;
  }

  /** The key of a state for deduplication: its positive literals and the negative ones somebody reads. */
  dedupeKey(lits) {
    const w = this.negWatched;
    return [...lits.keys()].filter(k => k[0] === '+' || !w || w.has(k.slice(1, k.indexOf('|')))).sort().join(';');
  }

  /** The closure of a state: {ev, exhausted}. Cached by the state's literals. */
  close(lits) {
    const key = this.stateKey(lits);
    let hit = this.cache.get(key);
    if (hit) return hit;
    const facts = [...lits.values()].map(l => ({neg: l.neg, p: l.p, args: l.args, claim: {id: 'state', version: 1}, status: 'observed', speaker: null, valid: null}));
    const closure = saturate({strata: this.program.strata}, facts, this.budget.child());
    if (closure.exhausted) throw new BudgetStop(closure.exhausted.key);
    hit = {ev: closure.ev, key};
    this.cache.set(key, hit);
    return hit;
  }

  ctx(ev) { return {ev, stored: new Map(), budget: READ_BUDGET, notes: new Set()}; }

  /** Solutions (environments) of an ordered leaf list in the closure `ev`, starting from `env`. */
  *solve(leaves, ev, env = {}) {
    for (const {env: e} of join(leaves, 0, env, [], this.ctx(ev))) yield e;
  }

  /** Ground instances of an action applicable in the state, optionally restricted by a partial binding of its parameters. */
  applicable(ev, only = null, preEnv = null) {
    const out = [];
    for (const a of this.actions.values()) {
      if (only && a.id !== only) continue;
      const seen = new Set();
      for (const env of this.solve(a.leaves, ev, preEnv ? {...preEnv} : {})) {
        const params = a.params.map(v => env[v]);
        const k = argsKey(params);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({action: a, env, params});
      }
    }
    return out;
  }

  /** The first unmet precondition of a ground action in a closure, as text (for `blocked.requirement`), or null when it applies. */
  unmetRequirement(action, params, ev) {
    const env = Object.fromEntries(action.params.map((v, i) => [v, params[i]]));
    for (const l of action.leaves) {
      const g = l.kind === 'atom' ? groundArgs(l.args, env) : null;
      if (l.kind === 'atom' && g) {
        const has = l.mode === 'absent' ? !ev.get(false, l.p, g) : l.mode === 'not' ? ev.get(true, l.p, g) : ev.get(false, l.p, g);
        if (!has) return (l.mode === 'pos' ? '' : l.mode + ' ') + atomText(false, l.p, g);
      }
    }
    return null;
  }

  /** Apply the effects of a ground action: removes first, then adds (an atom both removed and added ends up present). */
  effect(lits, action, env) {
    const next = new Map(lits);
    for (const r of action.removes) {
      const args = groundArgs(r.args, env);
      next.delete(litKey(r.neg, r.p, args));
      if (!r.neg && !this.closed.has(r.p)) next.set(litKey(true, r.p, args), {neg: true, p: r.p, args});
    }
    for (const x of action.adds) {
      const args = groundArgs(x.args, env);
      next.set(litKey(x.neg, x.p, args), {neg: x.neg, p: x.p, args});
      next.delete(litKey(!x.neg, x.p, args));
    }
    return next;
  }

  /** Bind the parameters of a ground step (the action name and its argument values) to an applicable instance, or null. */
  instance(actionId, args, ev) {
    const a = this.actions.get(actionId);
    if (!a || a.params.length !== args.length) return null;
    const env = Object.fromEntries(a.params.map((v, i) => [v, args[i]]));
    return {action: a, env, params: args, applicable: this.unmetRequirement(a, args, ev) === null};
  }
}

/** Ordered leaves of a condition alternative, with `not` over a closed fluent mapped to absence like a precondition. */
export function goalLeaves(alts, closed, wireId) {
  return alts.map(alt => orderLeaves(alt.map(l => (l.kind === 'atom' && l.mode === 'not' ? asPrecondition({neg: true, p: l.p, args: l.args}, closed) : l)), wireId).leaves);
}
