/**
 * Forward state-space search over polarity-explicit states with method decomposition (proposal 7 and 8.7). Uniform-cost, so the
 * first goal reached is the cheapest legal run:
 *   - a node is a state (literals and their closure under the rules), the run so far, and a continuation (the method steps still to
 *     run, see decompose.mjs); a node always starts with a primitive step, a blind `achieve` or nothing;
 *   - norms are monitored over the whole run (../modes/run-eval.mjs): a hard norm that is violated PRUNES the node (and is remembered
 *     as a blocker), a soft one adds its cost; unmet obligations are violations only when the run ends, so a node that satisfies the
 *     goal is a terminal candidate whose cost includes the end-of-run penalties, and it stays expandable while an obligation is
 *     pending or a requested `via` step has not happened;
 *   - states are deduplicated on (literals, continuation, norm-monitor summary, via flag), keeping the cheapest;
 *   - a plan longer than `maxDepth` steps is never explored: if that cut anything the answer is `budget_exhausted` (horizon),
 *     never `no_plan`; an `until` loop that reaches its cap with the condition still false is a failed run, and the cap is reported.
 */
import {unify} from '../js-reference/join.mjs';
import {isVarTerm, atomText} from '../js-reference/values.mjs';
import {ProgramError} from '../js-reference/values.mjs';
import {evaluateRun, whenHolds} from '../modes/run-eval.mjs';
import {Decomposer, bindTerm, renderStep} from './decompose.mjs';

class Heap {
  constructor(cmp) { this.a = []; this.cmp = cmp; }
  get size() { return this.a.length; }
  push(x) {
    const a = this.a; a.push(x);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (this.cmp(a[i], a[p]) >= 0) break; [a[i], a[p]] = [a[p], a[i]]; i = p; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && this.cmp(a[l], a[m]) < 0) m = l;
        if (r < a.length && this.cmp(a[r], a[m]) < 0) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]]; i = m;
      }
    }
    return top;
  }
}

const cmpPri = (x, y) => { for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
const envKey = env => JSON.stringify(Object.entries(env).sort(([a], [b]) => (a < b ? -1 : 1)));
const contKey = cont => cont.map(i => `${i.special ?? i.n.nid ?? i.n.kind + (i.n.items?.map(x => x.nid).join('.') ?? '')}:${i.count ?? ''}:${envKey(i.env)}`).join('|');
const softCostOf = violations => violations.reduce((s, v) => s + (v.severity === 'soft' ? v.cost : 0), 0);

/** The search problem: everything fixed for a query; `run` is one search under a set of waived norms and a way to start. */
export class PlanSearch {
  constructor({world, goal, methods, norms, edges, via, objective, budget}) {
    Object.assign(this, {world, goal, methods, norms, edges, via, objective, budget});
    const reads = [...(goal.negPreds ?? [])];
    const leafNots = alts => alts.forEach(alt => alt.forEach(l => { if (l.kind === 'atom' && l.mode === 'not') reads.push(l.p); }));
    for (const n of norms) leafNots(n.whenAlts);
    const stepNots = nodes => nodes.forEach(x => {
      if (x.neg === 'not' && x.p) reads.push(x.p);
      if (x.item) stepNots([x.item]);
      for (const k of ['branches', 'items', 'then', 'otherwise', 'body']) if (x[k]) stepNots(x[k]);
    });
    for (const m of methods) { leafNots(m.whenAlts); stepNots(m.steps); }
    world.watchNegatives(reads);
  }

  priority(total, violationCount, pref) {
    return this.objective === 'cost' ? [total, pref] : [violationCount, total, pref];
  }

  /** One search. `top` = {methods: [{method, env}]} (decompose the goal by these) or {blind: true}. */
  run({waived = new Set(), top, extraLits = null}) {
    const {world, budget} = this;
    const norms = this.norms.filter(n => !waived.has(n.id));
    const stats = {cut: false, capHit: null, pruned: new Map(), conflicts: [], deepest: null, verifyFailed: null, noMethod: null, expanded: 0};
    const dec = new Decomposer({world, methods: this.methods, goal: this.goal, stats});
    const maxDepth = budget.limits.maxDepth;
    let seq = 0;
    const queue = new Heap((a, b) => cmpPri(a.pri, b.pri) || a.seq - b.seq);
    const best = new Map();

    const evalNode = (states, steps, final) => evaluateRun({world, norms, edges: this.edges, run: {states, steps}, goalConsts: this.goal.consts, final});
    const hardOf = ev => ev.violations.filter(v => v.severity === 'hard');

    const record = (violations, steps, stepText) => {
      for (const v of violations) {
        if (!stats.pruned.has(v.id)) stats.pruned.set(v.id, {norm: v.norm, id: v.id, step: stepText, why: v.why, message: v.message});
      }
    };

    /** The hard obligations that demand the very action a forbid just pruned, with no override between them (equal strength). */
    const conflictsOf = (violations, step, stateBefore) => {
      for (const v of violations) {
        if (v.norm.modality !== 'forbid' || v.norm.pat.kind !== 'action') continue;
        for (const o of norms) {
          if (o.modality !== 'oblige' || o.severity !== 'hard' || o.pat.kind !== 'action' || o.pat.action !== step.action) continue;
          if (this.edges.some(e => (e.over === o.id && e.target === v.id) || (e.over === v.id && e.target === o.id))) continue;
          const env = unify(o.pat.terms, step.args, {});
          if (env && whenHolds(world, o, stateBefore.ev, env) && !stats.conflicts.some(c => c.forbid === v.id && c.oblige === o.id)) stats.conflicts.push({forbid: v.id, oblige: o.id});
        }
      }
    };

    const viaHit = step => this.via && step.action === this.via.action && step.args.length === this.via.terms.length && unify(this.via.terms, step.args, {}) !== null;

    const enqueue = (parent, base, cont, state) => {
      for (const d of state.decisions) if (d.at === undefined) d.at = base.steps.length + 1;
      const mon = evalNode(base.states, base.steps, false);
      const hard = hardOf(mon);
      if (hard.length) { record(hard, base.steps, base.lastText); if (base.steps.length) conflictsOf(hard, base.steps.at(-1), base.states.at(-2)); return; }
      const soft = softCostOf(mon.violations);
      const total = base.cost + state.extra + soft;
      const node = {...base, cont, state, mon, soft, total, viaSeen: base.viaSeen};
      const key = `${world.dedupeKey(base.lits)}#${contKey(cont)}#${mon.summary}#${node.viaSeen ? 1 : 0}`;
      const pri = this.priority(total, mon.violations.length, state.pref);
      const old = best.get(key);
      if (old && cmpPri(old, pri) <= 0) return;
      best.set(key, pri);
      node.pri = pri; node.seq = seq++; node.key = key;
      // a terminal candidate: the goal holds (or the method is done), a requested via step happened, and no hard norm is violated at the end
      const goalHolds = cont.length === 0 || (cont.length === 1 && cont[0].special === 'achieveGoal' && this.goal.holds(base.ev));
      if (goalHolds && (!this.via || node.viaSeen)) {
        const fin = evalNode(base.states, base.steps, true);
        if (!hardOf(fin).length) {
          const finalTotal = base.cost + state.extra + softCostOf(fin.violations);
          queue.push({terminal: true, node, fin, pri: this.priority(finalTotal, fin.violations.length, state.pref), seq: seq++});
        } else record(hardOf(fin), base.steps, 'end of the run');
      }
      const expandable = cont.length > 0 && !(goalHolds && cont.length === 1 && cont[0].special === 'achieveGoal' && !mon.pending.length && !(this.via && !node.viaSeen));
      if (expandable) queue.push({node, pri, seq: node.seq});
    };

    const startState = {decisions: [], extra: 0, pref: 0};
    const lits0 = extraLits ? new Map([...world.initial(), ...extraLits]) : world.initial();
    const clo0 = world.close(lits0);
    const root = {lits: lits0, ev: clo0.ev, states: [{ev: clo0.ev, lits: lits0}], steps: [], cost: 0, viaSeen: false, lastText: 'the initial state'};
    const starts = top.blind ? [{cont: [{special: 'achieveGoal', env: {}}], state: startState}]
      : top.methods.map(({method, env}) => ({cont: dec.bodyOf(method, env, []), state: {...startState, decisions: [{kind: 'method', id: method.id, version: method.version, task: top.task ?? method.achieves.p}], extra: method.cost}}));
    for (const s of starts) for (const {cont, state} of dec.normalize(root.ev, s.cont, s.state)) enqueue(null, root, cont, state);

    while (queue.size) {
      const e = queue.pop();
      if (e.terminal) return {kind: 'plan', node: e.node, fin: e.fin, stats};
      const node = e.node;
      budget.node();
      stats.expanded++;
      const head = node.cont[0];
      let moves = [];
      if (head.special === 'achieveAtom' || head.special === 'achieveGoal') moves = world.applicable(node.ev).map(m => ({...m, env2: head.env, rest: node.cont}));
      else {
        const p = head.n;
        const action = world.actions.get(p.action);
        if (!action) throw new ProgramError('unknown_action', `the step ~${p.action} names no action`, head.m?.id);
        if (action.params.length !== p.terms.length) throw new ProgramError('step_arity', `~${p.action} has ${p.terms.length} term(s), the action takes ${action.params.length}`, head.m?.id);
        const pre = {};
        p.terms.forEach((t, i) => { const v = bindTerm(t, head.env); if (!isVarTerm(v)) pre[action.params[i]] = v; });
        const found = world.applicable(node.ev, p.action, pre);
        if (!found.length) {
          const params = p.terms.map(t => bindTerm(t, head.env));
          const text = renderStep(p, head.env);
          if (!params.some(isVarTerm) && (!stats.deepest || node.steps.length > stats.deepest.depth)) stats.deepest = {depth: node.steps.length, step: text, requirement: world.unmetRequirement(action, params, node.ev), method: head.m?.id ?? null};
          continue;
        }
        moves = found.map(m => {
          const env2 = {...head.env};
          p.terms.forEach((t, i) => { if (isVarTerm(t)) env2[t.var] = m.params[i]; });
          return {...m, env2, rest: node.cont.slice(1).map(it => (it.env === head.env ? {...it, env: env2} : it))};
        });
      }
      if (!moves.length) continue;
      if (node.steps.length >= maxDepth) { stats.cut = true; continue; }
      for (const m of moves) {
        const lits = world.effect(node.lits, m.action, m.env);
        const clo = world.close(lits);
        const step = {action: m.action.id, version: m.action.source.version, args: m.params, text: atomText(false, m.action.id, m.params).replace(/^/, '~'), cost: m.action.cost};
        const base = {
          lits, ev: clo.ev, states: [...node.states, {ev: clo.ev, lits}], steps: [...node.steps, step], cost: node.cost + m.action.cost,
          viaSeen: node.viaSeen || viaHit(step), lastText: step.text
        };
        for (const {cont, state} of dec.normalize(clo.ev, m.rest, node.state)) enqueue(node, base, cont, state);
      }
    }
    return {kind: 'none', stats};
  }
}

