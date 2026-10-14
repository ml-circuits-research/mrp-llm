/**
 * Planning: uniform-cost search (bounded Dijkstra) over polarity-explicit states.
 *
 * A state is a set of ground literals `+p a` / `-p a`. A precondition `requires p a` needs P evidence, `requires not p a` needs N
 * evidence when `p` is open and the ABSENCE of `p a` when `p` is declared closed (unknown is never true for an open fluent).
 * Effects: `adds p a` sets `+p a` (and clears `-p a`), `adds not p a` the opposite, `removes p a` clears `+p a` and, for an open
 * fluent, records `-p a`. Derived relations are recomputed from the state's literals by the program's rules (naive closure per
 * state), so preconditions and goals may use rules.
 *
 * `no_plan` is returned only when the whole finite state space was explored; a search cut by the horizon (`maxDepth` steps) or by
 * the node budget is `budget_exhausted` with reason `horizon` or `nodes`, never a negative answer.
 */
import {saturate} from './engine.mjs';
import {join} from './join.mjs';
import {conditionAlts, orderLeaves} from './program.mjs';
import {readBudget} from './query.mjs';
import {BudgetStop} from './budget.mjs';
import {ProgramError, argsKey, groundArgs, atomText} from './values.mjs';

const litKey = (neg, p, args) => `${neg ? '-' : '+'}${p}|${argsKey(args)}`;

/** `not p` over a closed fluent is absence, over an open fluent it is negative evidence. */
const asPrecondition = (a, closed) => ({kind: 'atom', mode: a.neg ? (closed.has(a.p) ? 'absent' : 'not') : 'pos', p: a.p, args: a.args});

class MinQueue {
  constructor() { this.items = []; this.seq = 0; }
  push(cost, value) { this.items.push({cost, seq: this.seq++, value}); this.items.sort((a, b) => a.cost - b.cost || a.seq - b.seq); }
  pop() { return this.items.shift(); }
  get size() { return this.items.length; }
}

/** Search for the cheapest plan. `goalWire` is the query wire (its `where` is the goal). */
export function planSearch({program, facts, goalWire, budget}) {
  const closed = program.closed;
  const goalAlts = conditionAlts(goalWire.fields.filter(f => f.key === 'where'), goalWire.id)
    .map(alt => orderLeaves(alt.map(l => (l.kind === 'atom' && l.mode === 'not' ? asPrecondition({neg: true, p: l.p, args: l.args}, closed) : l)), goalWire.id).leaves);
  const actions = program.actions.map(a => {
    const leaves = orderLeaves(a.requires.map(r => asPrecondition(r, closed)), a.id);
    for (const v of a.params) if (!leaves.bound.has(v)) throw new ProgramError('action_parameter_unbound', `parameter ${v} of ${a.id} is not bound by a positive precondition`, a.id);
    for (const e of [...a.adds, ...a.removes]) for (const t of e.args) if (typeof t === 'object' && !leaves.bound.has(t.var)) throw new ProgramError('unsafe_action', `an effect of ${a.id} uses an unbound variable`, a.id);
    return {...a, leaves: leaves.leaves};
  });
  const rulesProgram = {strata: program.strata};
  const closeState = lits => {
    const facts2 = [...lits.values()].map(l => ({neg: l.neg, p: l.p, args: l.args, claim: {id: 'state', version: 1}, status: 'observed', speaker: null, valid: null}));
    return saturate(rulesProgram, facts2, budget.child());
  };
  const initial = new Map();
  for (const f of facts) initial.set(litKey(f.neg, f.p, f.args), {neg: f.neg, p: f.p, args: f.args});
  const stateKey = lits => [...lits.keys()].sort().join(';');

  const reaches = ev => {
    const ctx = {ev, stored: new Map(), budget: readBudget(budget), notes: new Set()};
    return goalAlts.some(leaves => !join(leaves, 0, {}, [], ctx).next().done);
  };
  const applicable = (lits, ev) => {
    const ctx = {ev, stored: new Map(), budget: readBudget(budget), notes: new Set()};
    const out = [];
    for (const a of actions) {
      const seen = new Set();
      for (const {env} of join(a.leaves, 0, {}, [], ctx)) {
        const params = a.params.map(v => env[v]);
        const k = argsKey(params);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({action: a, env, params});
      }
    }
    return out;
  };
  const effect = (lits, a, env) => {
    const next = new Map(lits);
    for (const r of a.removes) {
      const args = groundArgs(r.args, env);
      next.delete(litKey(r.neg, r.p, args));
      if (!r.neg && !closed.has(r.p)) next.set(litKey(true, r.p, args), {neg: true, p: r.p, args});
    }
    for (const x of a.adds) {
      const args = groundArgs(x.args, env);
      next.set(litKey(x.neg, x.p, args), {neg: x.neg, p: x.p, args});
      next.delete(litKey(!x.neg, x.p, args));
    }
    return next;
  };

  const queue = new MinQueue();
  const best = new Map();
  queue.push(0, {lits: initial, steps: [], cost: 0});
  best.set(stateKey(initial), 0);
  let cut = false, expanded = 0;
  try {
    while (queue.size) {
      const {cost, value} = queue.pop();
      budget.node();
      expanded++;
      const closure = closeState(value.lits);
      if (closure.exhausted) throw new BudgetStop(closure.exhausted.key);
      if (reaches(closure.ev)) {
        return {status: 'plan_found', complete: true, guarantee: cut ? 'bounded' : 'exact', plan: {steps: value.steps.length, cost, names: value.steps.map(s => s.action), sequence: value.steps}, used: [...new Set(value.steps.map(s => s.action))].map(id => ({id, version: 1})), expanded, ...(cut ? {notes: ['optimality_bounded_by_horizon']} : {})};
      }
      const moves = applicable(value.lits, closure.ev);
      if (value.steps.length >= budget.limits.maxDepth) { if (moves.length) cut = true; continue; }
      for (const m of moves) {
        const next = effect(value.lits, m.action, m.env);
        const k = stateKey(next);
        const c = cost + m.action.cost;
        if (best.has(k) && best.get(k) <= c) continue;
        best.set(k, c);
        queue.push(c, {lits: next, cost: c, steps: [...value.steps, {action: m.action.id, args: m.params.map(String), text: atomText(false, m.action.id, m.params), binding: Object.fromEntries(m.action.params.map((v, i) => [v, m.params[i]])), adds: m.action.adds.map(x => atomText(x.neg, x.p, groundArgs(x.args, m.env))), removes: m.action.removes.map(x => atomText(x.neg, x.p, groundArgs(x.args, m.env))), cost: m.action.cost}]});
      }
    }
  } catch (e) {
    if (e instanceof BudgetStop) return {status: 'budget_exhausted', complete: false, reason: e.reason, expanded};
    throw e;
  }
  if (cut) return {status: 'budget_exhausted', complete: false, reason: 'horizon', expanded};
  return {status: 'no_plan', complete: true, expanded};
}
