/**
 * Bounded planning as satisfiability with norms over a horizon (proposal 4.3, 8.2, 7.1 Z3 column).
 *
 * Grounding. The possible state literals are found by relaxed reachability (deletes ignored, `absent` ignored, comparisons and
 * `compute` evaluated), which also grounds the rule instances and the action instances (parameters over the constants that can
 * occur). Over that finite set, for every step t = 0..H:
 *
 *   s_i_t    state literal i holds in the state t (polarity-explicit, like the oracle: an open fluent's removed atom is recorded as
 *            negative evidence, a closed fluent's is simply absent);
 *   c_i_t    the closure of the state under the program's rules (the completion of the ground instances, non-recursive only);
 *   o_j_t    action instance j is executed at step t; at most one per step; the steps form a prefix and the plan ends at end_t,
 *            where the goal must hold (end_t -> goal_t); frame axioms give s_i_{t+1} from the effects of the executed action.
 *
 * Norms are VIOLATION BOOLEANS, never hard assertions inside the encoding (proposal 4.3): a hard norm is enforced by a "no violation"
 * assertion in stage A; when that is unsatisfiable the assertion is LIFTED and the violations are MINIMISED lexicographically (the
 * MaxSAT view), which names the blockers (an unsat core cannot, and the proposal records that round 1 had it wrong):
 *   A  every hard norm enforced                                  -> plan_found, compliance.hard ok
 *   B  hard advisory norms relaxable (fewest relaxations first)  -> plan_found, `relaxed`, compliance.hard relaxed
 *   C  hard strict norms lifted, their violations minimised      -> blocked, `blocked_by`
 * Soft norms add their cost to the objective. A deontic conflict (a forbidden instance executed while an equal-strength obligation on the
 * same action is triggered) marks both norms. The semantics of every qualifier is the one of asp-clingo/plan.mjs and the table of 8.2.
 *
 * Bounded negatives are never `no_plan`: unsat within the horizon is `budget_exhausted` with `reason horizon` unless it is proved
 * complete (Markov norms and no `via`: no plan within H, and no loopless path of H actions either, so none at all). The optimum is
 * certified the same way or by the cost bound. A grounded domain that grows past `maxCandidates` is `budget_exhausted`, `reason domain`.
 */
import {runZ3, valuesOf, intOf, SolverStop} from './z3.mjs';
import {unify} from '../js-reference/join.mjs';
import {groundArgs, termIn, compareValues, argsKey, isVarTerm, ProgramError, NotExpressibleError, showValue} from '../js-reference/values.mjs';
import {exactCompute as compute} from '../solver-common/exact-rational.mjs';
import {tokens} from '../../../sop/knowledge/index.mjs';
import {actionModel, isMarkov, orderedGoal, planPacket, blockedPacket, costBoundProves} from '../solver-common/planmodel.mjs';

const keyOf = (neg, p, args) => `${neg ? 'n' : 'p'}|${p}|${argsKey(args)}`;
const conj = xs => (xs.length === 0 ? 'true' : xs.length === 1 ? xs[0] : `(and ${xs.join(' ')})`);
const disj = xs => (xs.length === 0 ? 'false' : xs.length === 1 ? xs[0] : `(or ${xs.join(' ')})`);
const sum = xs => (xs.length ? `(+ ${xs.join(' ')})` : '0');
const ite = (v, w) => `(ite ${v} ${w} 0)`;
const sameArgs = (a, b) => argsKey(a) === argsKey(b);

// ------------------------------------------------------------------------------------------------------------ the grounding

class PlanGround {
  constructor(program, facts, actions) {
    this.program = program; this.facts = facts; this.actions = actions; this.closed = program.closed;
    this.recs = []; this.map = new Map(); this.rels = new Map();
    this.ruleInst = []; this.actInst = [];
  }

  rec(neg, p, args) {
    const key = keyOf(neg, p, args);
    let r = this.map.get(key);
    if (!r) {
      r = {id: this.recs.length, neg, p, args, key, state: false};
      this.recs.push(r);
      this.map.set(key, r);
      const rel = `${neg ? 'n' : 'p'}|${p}`;
      if (!this.rels.has(rel)) this.rels.set(rel, []);
      this.rels.get(rel).push(r);
    }
    return r;
  }

  get(neg, p, args) { return this.map.get(keyOf(neg, p, args)); }
  list(neg, p) { return this.rels.get(`${neg ? 'n' : 'p'}|${p}`) ?? []; }

  /** A join over the possible atoms. `absent` adds a literal only when the atom is possible (the final pass), and is lenient otherwise. */
  * body(leaves, i, env, lits) {
    if (i === leaves.length) { yield {env, lits}; return; }
    const l = leaves[i];
    if (l.kind === 'compare') { if (compareValues(l.word, termIn(l.left, env), termIn(l.right, env))) yield* this.body(leaves, i + 1, env, lits); return; }
    if (l.kind === 'compute') {
      const v = compute(l.word, termIn(l.left, env), termIn(l.right, env));
      if (v === undefined) return;
      if (l.out in env) { if (env[l.out] === v) yield* this.body(leaves, i + 1, env, lits); return; }
      yield* this.body(leaves, i + 1, {...env, [l.out]: v}, lits);
      return;
    }
    if (l.kind !== 'atom') throw new NotExpressibleError([l.kind === 'timeof' ? 'time_vars' : l.kind], `${l.kind} leaves are not lowered by z3-smt-bounded`);
    const g = groundArgs(l.args, env);
    if (l.mode === 'absent') {
      const r = g ? this.get(false, l.p, g) : null;
      yield* this.body(leaves, i + 1, env, r ? [...lits, {rec: r, k: 'a'}] : lits);
      return;
    }
    const neg = l.mode === 'not';
    if (g) {
      const r = this.get(neg, l.p, g);
      if (r) yield* this.body(leaves, i + 1, env, [...lits, {rec: r, k: neg ? 'n' : 'p'}]);
      return;
    }
    for (const r of [...this.list(neg, l.p)]) {
      const e2 = unify(l.args, r.args, env);
      if (e2) yield* this.body(leaves, i + 1, e2, [...lits, {rec: r, k: neg ? 'n' : 'p'}]);
    }
  }

  effects(a, env) {
    const at = (list, neg) => list.filter(e => e.neg === neg).map(e => this.rec(neg, e.p, groundArgs(e.args, env)));
    const addPos = at(a.adds, false), addNeg = at(a.adds, true), delNeg = at(a.removes, true);
    const delPos = at(a.removes, false);
    const recNeg = delPos.filter(r => !this.closed.has(r.p) && !addPos.includes(r)).map(r => this.rec(true, r.p, r.args));
    return {addPos, addNeg, delPos, delNeg, recNeg};
  }

  /** Relaxed reachability to a fixpoint, then the instances of the final pass. */
  saturate(limit) {
    for (const f of this.facts) this.rec(f.neg, f.p, f.args).state = true;
    for (let changed = true; changed;) {
      changed = false;
      const before = this.recs.length;
      for (const r of this.program.rules) for (const alt of r.alts) for (const {env} of this.body(alt.leaves, 0, {}, [])) this.rec(r.head.neg, r.head.p, groundArgs(r.head.args, env));
      for (const a of this.actions) {
        for (const {env} of this.body(a.leaves, 0, {}, [])) {
          const e = this.effects(a, env);
          for (const r of [...e.addPos, ...e.addNeg, ...e.recNeg]) r.state = true;
          for (const r of e.recNeg) r.state = true;
        }
      }
      if (this.recs.length !== before) changed = true;
      if (this.recs.length > limit) throw new ProgramError('domain', 'the grounded domain is larger than the limit', null);
    }
    const seen = new Set();
    for (const r of this.program.rules) {
      for (const alt of r.alts) for (const {env, lits} of this.body(alt.leaves, 0, {}, [])) {
        const head = this.rec(r.head.neg, r.head.p, groundArgs(r.head.args, env));
        const k = head.id + '|' + lits.map(l => l.k + l.rec.id).sort().join(',');
        if (!seen.has(k)) { seen.add(k); this.ruleInst.push({head, lits}); }
      }
    }
    const seenA = new Set();
    for (const a of this.actions) {
      for (const {env, lits} of this.body(a.leaves, 0, {}, [])) {
        const params = a.params.map(v => env[v]);
        const k = a.id + '|' + argsKey(params);
        if (seenA.has(k)) continue;
        seenA.add(k);
        this.actInst.push({j: this.actInst.length, action: a, params, pre: lits, ...this.effects(a, env)});
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------------ the SMT model

class Model {
  constructor() { this.decls = []; this.lines = []; this.n = 0; this.meta = new Map(); }
  bool(name) { this.decls.push(`(declare-const ${name} Bool)`); return name; }
  fresh(prefix, meta = null) { const v = this.bool(`${prefix}${this.n++}`); if (meta) this.meta.set(v, meta); return v; }
  def(v, f) { this.lines.push(`(assert (= ${v} ${f}))`); return v; }
  assert(f) { this.lines.push(`(assert ${f})`); }
  /** a named Boolean defined by a formula */
  as(prefix, f, meta = null) { return this.def(this.fresh(prefix, meta), f); }
}

function encode({H, g, actions, goal, norms, via, goalRequired = true}) {
  const M = new Model();
  const c = (r, t) => `c${r.id}_${t}`, s = (r, t) => `s${r.id}_${t}`, o = (j, t) => `o${j.j}_${t}`;
  const litAt = (l, t) => (l.k === 'a' ? `(not ${c(l.rec, t)})` : c(l.rec, t));
  const holdsAt = (lits, t) => conj(lits.map(l => litAt(l, t)));
  const formsAt = (forms, t) => disj(forms.map(lits => holdsAt(lits, t)));
  const facts = new Set(g.facts.map(f => keyOf(f.neg, f.p, f.args)));
  const T = Array.from({length: H + 1}, (_, t) => t), S = Array.from({length: H}, (_, t) => t);
  for (const r of g.recs) for (const t of T) { M.bool(c(r, t)); if (r.state) M.bool(s(r, t)); }
  for (const j of g.actInst) for (const t of S) M.bool(o(j, t));
  for (const t of S) M.bool(`act${t}`);
  for (const t of T) M.bool(`end${t}`);
  for (const r of g.recs) if (r.state) M.assert(`(= ${s(r, 0)} ${facts.has(r.key) ? 'true' : 'false'})`);
  const byHead = new Map();
  for (const ri of g.ruleInst) { if (!byHead.has(ri.head.id)) byHead.set(ri.head.id, []); byHead.get(ri.head.id).push(ri); }
  for (const r of g.recs) for (const t of T) M.assert(`(= ${c(r, t)} ${disj([...(r.state ? [s(r, t)] : []), ...(byHead.get(r.id) ?? []).map(ri => holdsAt(ri.lits, t))])})`);
  for (const t of S) {
    for (const j of g.actInst) M.assert(`(=> ${o(j, t)} ${holdsAt(j.pre, t)})`);
    if (g.actInst.length > 1) M.assert(`((_ at-most 1) ${g.actInst.map(j => o(j, t)).join(' ')})`);
    M.assert(`(= act${t} ${disj(g.actInst.map(j => o(j, t)))})`);
    if (t + 1 < H) M.assert(`(=> act${t + 1} act${t})`);
    M.assert(`(= end${t} ${t === 0 ? '(not act0)' : `(and (not act${t}) act${t - 1})`})`);
  }
  M.assert(`(= end${H} act${H - 1})`);
  for (const r of g.recs) {
    if (!r.state) continue;
    const opposite = g.get(!r.neg, r.p, r.args);
    for (const t of S) {
      const adds = g.actInst.filter(j => (r.neg ? j.addNeg.includes(r) || j.recNeg.includes(r) : j.addPos.includes(r))).map(j => o(j, t));
      const dels = g.actInst.filter(j => (r.neg ? j.delNeg.includes(r) || (opposite && j.addPos.includes(opposite)) : j.delPos.includes(r) || (opposite && j.addNeg.includes(opposite)))).map(j => o(j, t));
      M.assert(`(= ${s(r, t + 1)} ${disj([disj(adds), conj([s(r, t), `(not ${disj(dels)})`])])})`);
    }
  }
  const goalForms = [];
  for (const alt of goal) for (const {lits} of g.body(alt, 0, {}, [])) goalForms.push(lits);
  if (goalRequired) for (const t of T) M.assert(`(=> end${t} ${formsAt(goalForms, t)})`);
  for (const v of via) {
    const tk = tokens(v);
    if (!tk[0]?.startsWith('~')) throw new ProgramError('bad_via', `via needs ~action terms, got ${v}`);
    const terms = tk.slice(1).map(x => (x.startsWith('?') ? {var: x} : /^-?\d+$/.test(x) ? Number(x) : x.startsWith('"') ? JSON.parse(x) : x));
    const hits = g.actInst.filter(j => j.action.id === tk[0].slice(1) && unify(terms, j.params, {}));
    M.assert(disj(hits.flatMap(j => S.map(t => o(j, t)))));
  }
  const upto = t => disj(T.filter(e => e >= t).map(e => `end${e}`));
  const goalConsts = new Set(goal.flatMap(alt => alt.filter(l => l.kind === 'atom').flatMap(l => l.args.filter(x => !isVarTerm(x)))));
  const paramUsed = (cst, t) => disj(g.actInst.filter(j => j.params.includes(cst)).flatMap(j => S.filter(t0 => t0 <= t).map(t0 => o(j, t0))));
  const when = (n, env0) => n.alts.flatMap(alt => [...g.body(alt.leaves, 0, env0, [])]);
  const permittedAt = (n, j) => {
    const forms = [];
    for (const q of norms) {
      if (q.modality !== 'permit' || !q.overrides.includes(n.id) || q.pattern.kind !== 'action' || q.pattern.name !== j.action.id) continue;
      const env1 = unify(q.pattern.args, j.params, {});
      if (env1) forms.push(when(q, env1).map(x => x.lits));
    }
    return t => disj(forms.map(f => formsAt(f, t)));
  };
  const projection = (p, j) => { const e = unify(p.args, j.params, {}); return e ? groundArgs(p.args, e) : null; };
  const violBy = new Map(), softVars = [], trigd = new Map(), active = new Map(), firsts = [], violAt = new Map();
  const note = (n, v, key = null) => { if (!violBy.has(n.id)) violBy.set(n.id, []); violBy.get(n.id).push(v); if (key) violAt.set(key, v); if (n.severity === 'soft') softVars.push({v, cost: n.cost, id: n.id}); };
  const whenForms = n => when(n, {}).map(x => x.lits);
  for (const n of norms) {
    const p = n.pattern;
    if (n.modality === 'permit') { active.set(n.id, M.as('act_', disj(T.map(t => conj([upto(t), formsAt(whenForms(n), t)]))))); continue; }
    if (n.modality === 'forbid') {
      const q = n.qualifier;
      if (p.kind === 'state') {
        for (const r of g.list(p.neg, p.p)) {
          const env0 = unify(p.args, r.args, {});
          if (!env0) continue;
          const forms = when(n, env0).map(x => x.lits);
          for (const t of T) note(n, M.as('viol_', conj([c(r, t), formsAt(forms, t), upto(t)])));
        }
      } else {
        for (const j of g.actInst.filter(x => x.action.id === p.name)) {
          const env0 = unify(p.args, j.params, {});
          if (!env0) continue;
          const forms = when(n, env0).map(x => x.lits);
          const perm = permittedAt(n, j);
          for (const t of S) {
            let extra = [];
            if (q.kind === 'at_most_once') {
              const mine = argsKey(projection(p, j));
              const same = g.actInst.filter(k => k.action.id === p.name && projection(p, k) && argsKey(projection(p, k)) === mine);
              extra = [disj(same.flatMap(k => S.filter(t1 => t1 < t).map(t1 => o(k, t1))))];
            } else if (q.kind === 'before' || q.kind === 'after') {
              const refArgs = [...q.ref.args, ...Array.from({length: Math.max(0, (actions.find(a => a.id === q.ref.name)?.params.length ?? q.ref.args.length) - q.ref.args.length)}, (_, i) => ({var: `?_w${i}`}))];
              const prior = disj(g.actInst.filter(r => r.action.id === q.ref.name && unify(refArgs, r.params, env0)).flatMap(r => S.filter(t0 => t0 < t).map(t0 => o(r, t0))));
              extra = [q.kind === 'before' ? `(not ${prior})` : prior];
            }
            note(n, M.as('viol_', conj([o(j, t), formsAt(forms, t), ...extra, `(not ${perm(t)})`])), `${n.id}|${j.j}|${t}`);
          }
        }
      }
      active.set(n.id, M.as('act_', disj(T.map(t => conj([upto(t), formsAt(whenForms(n), t)])))));
      continue;
    }
    const bindings = new Map();
    for (const {env, lits} of when(n, {})) {
      const values = groundArgs(p.args, env);
      if (!values) throw new ProgramError('unsafe_variable', `a variable of the oblige pattern of ${n.id} is bound by no when atom`, n.id);
      const k = argsKey(values);
      if (!bindings.has(k)) bindings.set(k, {values, forms: []});
      bindings.get(k).forms.push(lits);
    }
    const mine = [];
    for (const {values, forms} of bindings.values()) {
      const bound = t => (n.standing ? [] : values.map(x => (goalConsts.has(x) ? 'true' : paramUsed(x, t))));
      const trig = S.map(t => M.as('trig_', conj([`act${t}`, formsAt(forms, t), ...bound(t)])));
      const first = S.map((t, i) => M.as('first_', conj([trig[i], `(not ${disj(trig.slice(0, i))})`])));
      first.forEach((v, t) => firsts.push({v, norm: n.id, values, t}));
      trigd.set(n.id + '|' + argsKey(values), M.as('trigd_', disj(first)));
      const q = n.qualifier;
      if (q.kind === 'always') {
        if (p.kind !== 'state') throw new ProgramError('qualifier_unsupported', 'oblige always needs a state pattern', n.id);
        const r = g.get(p.neg, p.p, values);
        for (const t2 of T) note(n, M.as('viol_', conj([disj(first.filter((_, t) => t <= t2)), upto(t2), r ? `(not ${c(r, t2)})` : 'true'])));
      } else {
        const within = q.kind === 'within';
        const dis = first.map((_, t) => {
          if (p.kind === 'action') {
            const hi = within ? Math.min(H - 1, t + q.n - 1) : H - 1;
            return disj(g.actInst.filter(j => j.action.id === p.name && sameArgs(j.params, values)).flatMap(j => S.filter(t2 => t2 >= t && t2 <= hi).map(t2 => o(j, t2))));
          }
          const r = g.get(p.neg, p.p, values);
          const hi = within ? Math.min(H, t + q.n) : H;
          return r ? disj(T.filter(t2 => t2 >= t && t2 <= hi).map(t2 => conj([c(r, t2), upto(t2)]))) : 'false';
        });
        note(n, M.as('viol_', disj(first.map((f, t) => conj([f, `(not ${dis[t]})`])))));
      }
      mine.push(...forms);
    }
    active.set(n.id, M.as('act_', disj(T.map(t => conj([upto(t), formsAt(mine, t)])))));
  }
  const confl = [];
  for (const f of norms.filter(x => x.modality === 'forbid' && x.pattern.kind === 'action' && x.severity === 'hard')) {
    for (const o2 of norms.filter(x => x.modality === 'oblige' && x.pattern.kind === 'action' && x.pattern.name === f.pattern.name && x.severity === f.severity && x.binding === f.binding)) {
      if (f.overrides.includes(o2.id) || o2.overrides.includes(f.id)) continue;
      const parts = [];
      for (const j of g.actInst.filter(x => x.action.id === f.pattern.name)) {
        const trg = trigd.get(o2.id + '|' + argsKey(j.params));
        const vs = S.map(t => violAt.get(`${f.id}|${j.j}|${t}`)).filter(Boolean);
        if (trg && vs.length) parts.push(conj([disj(vs), trg]));
      }
      confl.push({f: f.id, o: o2.id, v: M.as('confl_', disj(parts))});
    }
  }
  const terms = {
    cost: sum([...g.actInst.flatMap(j => S.map(t => ite(o(j, t), j.action.cost))), ...softVars.filter(x => x.cost).map(x => ite(x.v, x.cost))]),
    steps: sum(S.map(t => ite(`act${t}`, 1)))
  };
  return {M, c, s, o, S, T, g, violBy, softVars, active, confl, firsts, terms};
}

// ------------------------------------------------------------------------------------------------------------- solving

const exhausted = (budget, reason) => ({status: 'budget_exhausted', complete: false, reason, budget: {...budget.snapshot(false), exhausted: true, reason}});

/** Run an encoding with stage constraints and lexicographic objectives; returns the values of the wanted names, or null if unsat. */
function solve(E, {assertions = [], objectives, wanted, timeoutMs}) {
  const lines = ['(set-option :opt.priority lex)', ...E.M.decls, ...E.M.lines, ...assertions.map(a => `(assert ${a})`), ...objectives.map(t => `(minimize ${t})`),
    '(check-sat)', wanted.length ? `(get-value (${wanted.join(' ')}))` : ''];
  const r = runZ3(lines.join('\n') + '\n', {timeoutMs});
  if (r.interrupted) throw new SolverStop('wall');
  if (r.results[0] === 'unsat') return null;
  if (r.results[0] !== 'sat') throw new SolverStop('wall');
  return valuesOf(r.results[1]);
}

function summary(E, values, normById, extra = {}) {
  const on = name => values.get(name) === 'true';
  const steps = [];
  for (const t of E.S) for (const j of E.g.actInst) if (on(E.o(j, t))) steps.push({T: t, action: j.action.id, params: j.params});
  const cost = steps.reduce((x, st) => x + (E.g.actInst.find(j => j.action.id === st.action)?.action.cost ?? 1), 0);
  const softViol = E.softVars.filter(x => on(x.v)).map(x => ({id: x.id, cost: x.cost}));
  const obligations = E.firsts.filter(f => on(f.v)).map(f => `${f.norm} ${f.values.map(showValue).join(' ')}`.trim());
  const active = [...E.active].filter(([, v]) => v === 'true' || on(v)).map(([id]) => id);
  return {steps, cost, softViol, obligations, active, ...extra};
}

const wantedNames = (E, more = []) => [
  ...E.g.actInst.flatMap(j => E.S.map(t => E.o(j, t))), ...E.softVars.map(x => x.v), ...E.firsts.map(f => f.v), ...[...E.active.values()].filter(v => v !== 'false' && v !== 'true'), ...more
];

function looplessExists({E, stageA, timeoutMs}) {
  const states = E.g.recs.filter(r => r.state);
  const lines = [];
  for (let t1 = 0; t1 <= E.S.length; t1++) for (let t2 = t1 + 1; t2 <= E.S.length; t2++) lines.push(disj(states.map(r => `(xor ${E.s(r, t1)} ${E.s(r, t2)})`)));
  return solve(E, {assertions: [...stageA, ...lines, `end${E.S.length}`], objectives: [], wanted: [], timeoutMs}) !== null;
}

export function z3Plan({program, facts, goalAlts, norms, via, mode, budget, limit = Infinity, waivers = []}) {
  const timeoutMs = budget.limits.timeoutMs;
  const actions = actionModel(program);
  const goal = orderedGoal(goalAlts);
  const normById = new Map(norms.map(n => [n.id, n]));
  const Hmax = Math.max(1, budget.limits.maxDepth);
  const minCost = actions.length ? Math.min(...actions.map(a => a.cost)) : 0;
  const hardNorms = norms.filter(n => n.severity === 'hard' && n.modality !== 'permit');
  const markov = isMarkov(norms, via);
  for (const a of program.aggregates) void a;
  if (program.aggregates.length) throw new NotExpressibleError(['aggregate_plan'], 'aggregates inside a planning problem are not lowered by z3-smt-bounded');
  try {
    const g = new PlanGround(program, facts, actions);
    try { g.saturate(budget.limits.maxCandidates); } catch (e) { if (e instanceof ProgramError && e.code === 'domain') return exhausted(budget, 'domain'); throw e; }
    const encodeAt = (H, goalRequired = true) => encode({H, g, actions, goal, norms, via, goalRequired});
    const hardVars = E => hardNorms.flatMap(n => E.violBy.get(n.id) ?? []);
    const stageA = E => [...hardVars(E).map(v => `(not ${v})`), ...E.confl.map(x => `(not ${x.v})`)];
    const objective = E => [E.terms.cost, E.terms.steps];
    const read = (E, values, extra) => summary(E, values, normById, extra);
    if (mode === 'abduce') return waiveAbduction({encodeAt, Hmax, waivers, hardNorms, normById, timeoutMs, limit, wanted: wantedNames});
    const horizons = [...new Set([Math.min(6, Hmax), Hmax])];
    let found = null;
    for (const H of horizons) {
      const E = encodeAt(H);
      const values = solve(E, {assertions: stageA(E), objectives: objective(E), wanted: wantedNames(E, [E.terms.cost, E.terms.soft ?? '0']), timeoutMs});
      if (!values) continue;
      const m = read(E, values);
      found = {m, H, E};
      if (costBoundProves({objective: m.cost + m.softViol.reduce((x, y) => x + y.cost, 0), H, minCost}) || H === Hmax) break;
    }
    if (found) {
      const {m, H, E} = found;
      const obj = m.cost + m.softViol.reduce((x, y) => x + y.cost, 0);
      let guarantee = 'exact', notes = [];
      if (!costBoundProves({objective: obj, H, minCost})) {
        const proved = markov && !looplessExists({E: encodeAt(H, false), stageA: stageA(encodeAt(H, false)), timeoutMs});
        if (!proved) { guarantee = 'bounded'; notes = ['optimality_bounded_by_horizon']; }
      }
      return planPacket({m, actions, normById, guarantee, notes});
    }
    const E = encodeAt(Hmax);
    const advisory = hardNorms.filter(n => n.binding === 'advisory');
    if (advisory.length) {
      const rx = new Map(advisory.map(n => [n.id, E.M.fresh('rx_')]));
      const lines = [];
      for (const n of hardNorms) for (const v of E.violBy.get(n.id) ?? []) lines.push(n.binding === 'advisory' ? `(=> ${v} ${rx.get(n.id)})` : `(not ${v})`);
      for (const x of E.confl) lines.push(normById.get(x.f).binding === 'advisory' ? `(=> ${x.v} (or ${rx.get(x.f)} ${rx.get(x.o)}))` : `(not ${x.v})`);
      const values = solve(E, {assertions: lines, objectives: [sum([...rx.values()].map(v => ite(v, 1))), E.terms.cost, E.terms.steps], wanted: wantedNames(E, [...rx.values()]), timeoutMs});
      if (values) {
        const m = read(E, values);
        return planPacket({m, actions, normById, relaxed: [...rx].filter(([, v]) => values.get(v) === 'true').map(([id]) => id).sort(), hard: 'relaxed', guarantee: 'bounded', notes: ['relaxed_within_horizon']});
      }
    }
    if (hardNorms.length) {
      const blk = new Map(), rel = new Map();
      const strict = hardNorms.filter(n => n.binding !== 'advisory'), adv = advisory;
      for (const n of strict) blk.set(n.id, E.M.as('blk_', disj([...(E.violBy.get(n.id) ?? []), ...E.confl.filter(x => x.f === n.id || x.o === n.id).map(x => x.v)])));
      for (const n of adv) rel.set(n.id, E.M.as('adv_', disj([...(E.violBy.get(n.id) ?? []), ...E.confl.filter(x => x.f === n.id || x.o === n.id).map(x => x.v)])));
      const values = solve(E, {assertions: [], objectives: [sum([...blk.values()].map(v => ite(v, 1))), sum([...rel.values()].map(v => ite(v, 1))), E.terms.cost, E.terms.steps], wanted: wantedNames(E, [...blk.values(), ...rel.values()]), timeoutMs});
      if (values) {
        const m = read(E, values);
        const by = [...new Set([...blk, ...rel].filter(([, v]) => values.get(v) === 'true').map(([id]) => id))].sort();
        return blockedPacket({by, normById, plan: m.steps.map(x => x.action)});
      }
    }
    if (markov && !via.length) {
      const L = encodeAt(Hmax, false);
      if (!looplessExists({E: L, stageA: stageA(L), timeoutMs})) return {status: 'no_plan', complete: true, used: []};
    }
    return exhausted(budget, 'horizon');
  } catch (e) {
    if (e instanceof SolverStop) return exhausted(budget, e.reason);
    throw e;
  }
}

/** Minimal sets of norms to waive (hypotheses `waive $norm`): all inclusion-minimal, found by blocking supersets round by round. */
function waiveAbduction({encodeAt, Hmax, waivers, hardNorms, normById, timeoutMs, limit}) {
  if (!waivers.length) throw new ProgramError('no_waive_hypothesis', 'abduction over a plan needs hypothesis wires with waive $norm');
  const E = encodeAt(Hmax);
  const w = new Map(waivers.map(x => [x.norm, E.M.fresh('w_')]));
  const lines = [];
  for (const n of hardNorms) for (const v of E.violBy.get(n.id) ?? []) lines.push(w.has(n.id) ? `(=> ${v} ${w.get(n.id)})` : `(not ${v})`);
  for (const x of E.confl) lines.push(`(=> ${x.v} (or ${w.get(x.f) ?? 'false'} ${w.get(x.o) ?? 'false'}))`);
  const found = [];
  for (;;) {
    const blocks = found.map(set => `(not (and true ${set.map(id => w.get(id)).join(' ')}))`);
    const values = solve(E, {assertions: [...lines, ...blocks], objectives: [sum(waivers.map(x => ite(w.get(x.norm), x.cost)))], wanted: [...w.values()], timeoutMs});
    if (!values) break;
    const set = [...w].filter(([, v]) => values.get(v) === 'true').map(([id]) => id).sort();
    found.push(set);
    if (!set.length) break;
  }
  const sets = found.map(sx => sx.map(n => `waive ${n}`)).sort((a, b) => a.length - b.length || (a.join() < b.join() ? -1 : 1));
  void normById;
  if (!sets.length) return {status: 'unknown', complete: true, reason: 'no_explanation', hypotheses: [], explanations: []};
  const shown = sets.slice(0, limit);
  return {status: 'supported', complete: shown.length === sets.length, hypotheses: shown, ...(shown.length < sets.length ? {truncated: true} : {})};
}
