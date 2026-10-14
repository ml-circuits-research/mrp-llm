/**
 * Bounded planning in ASP with norms over a horizon (proposal 4.3 `action`/`goal`, 8.2 `norm`, 7.1 ASP column).
 *
 * Encoding. A step T = 0..H-1 either holds exactly one action instance (`occ_<action>(params, T)`) or the plan has ended
 * (`end(E)`: the goal holds in the state E, every step before E holds an action, none after). A state is a set of literals
 * `sp_<p>(args, T)` / `sn_<p>(args, T)` (polarity-explicit, as in the oracle: an open fluent's removed atom is recorded as negative
 * evidence, a closed fluent's is simply absent); the derived relations of the program are re-closed at every T by the lowered
 * rules (`pos_<p>(args, T)`), so preconditions, goals and norms may use rules. The objective is the plan cost plus the cost of the
 * soft violations; a second criterion prefers fewer steps.
 *
 * Norms are VIOLATION ATOMS, never hard integrity constraints inside the encoding: `viol(Norm, Instance)`. Hard norms are enforced
 * by a "no violation" requirement. When that makes the horizon unsatisfiable the requirement is LIFTED and the violations are
 * minimised, which names the blockers (`blocked_by`); an unsat core cannot name them. Three stages:
 *   A  every hard norm enforced                                  -> plan_found, compliance.hard ok
 *   B  hard advisory norms relaxable (fewest relaxations first)  -> plan_found, `relaxed` lists them, compliance.hard relaxed
 *   C  hard strict norms lifted, their violations minimised      -> blocked, `blocked_by`
 * A deontic conflict (a forbid and an oblige of the same action, equal strength, no override) marks BOTH norms when the forbidden
 * instance is executed and the obligation is triggered, so under `strict` binding both are named (case 39b).
 *
 * Bounded negatives. Unsat within the horizon is never `no_plan`: it is `budget_exhausted` with `reason horizon` unless it is PROVED
 * complete: when every norm is Markov (a state or action `forbid ... always`, or a permit) and nothing forces steps (`via`), a plan
 * can be shortened to a loopless path, so an unsat search together with an unsat search for a loopless path of H actions (all states
 * distinct) proves that no plan exists at all. The optimum is proved the same way, or by the cost bound: a plan of more than H steps costs
 * at least (H + 1) times the cheapest action.
 */
import {runClingo, parseAtom, SolverStop} from './clingo.mjs';
import {enc, aspVar, term, lowerBody, lowerRule, lowerAggregate, Shown, assertIntegerRange, assertNoTimeValues} from './lower.mjs';
import {orderLeaves} from '../js-reference/program.mjs';
import {isVarTerm, ProgramError, NotExpressibleError, showValue} from '../js-reference/values.mjs';
import {actionModel, isMarkov, orderedGoal, planPacket, blockedPacket, costBoundProves} from '../solver-common/planmodel.mjs';
import {tokens} from '../../../sop/knowledge/index.mjs';

const tup = items => (items.length === 0 ? '()' : items.length === 1 ? `(${items[0]},)` : `(${items.join(',')})`);
const at = (name, args, T) => `${name}(${[...args, T].join(',')})`;
const vars = (n, prefix = 'X') => Array.from({length: n}, (_, i) => `${prefix}${i}`);
function collectPredicates({program, facts, actions, goal, norms}) {
  const preds = new Map();
  const see = (p, n) => preds.set(p, n);
  for (const f of facts) see(f.p, f.args.length);
  const fromLeaves = ls => { for (const l of ls) if (l.kind === 'atom') see(l.p, l.args.length); };
  for (const r of program.rules) { see(r.head.p, r.head.args.length); r.alts.forEach(a => fromLeaves(a.leaves)); }
  for (const a of program.aggregates) { see(a.yields.p, a.yields.args.length); a.alts.forEach(x => fromLeaves(x.leaves)); }
  for (const a of actions) { fromLeaves(a.leaves); for (const e of [...a.adds, ...a.removes]) see(e.p, e.args.length); }
  goal.forEach(fromLeaves);
  for (const n of norms) { n.alts.forEach(a => fromLeaves(a.leaves)); if (n.pattern.kind === 'state') see(n.pattern.p, n.pattern.args.length); }
  const fluents = new Set(facts.map(f => f.p));
  for (const a of actions) for (const e of [...a.adds, ...a.removes]) fluents.add(e.p);
  return {preds, fluents};
}

/** The transition system and goal, shared by the plan, loopless and proof searches. */
function systemLines({H, program, facts, actions, goal, preds, fluents, via, closedSet, goalRequired = true}) {
  const L = [`time(0..${H}).`, `step(0..${H - 1}).`];
  const shown = new Shown();
  for (const f of facts) L.push(`${f.neg ? 'sn_' : 'sp_'}${f.p}(${[...f.args.map(enc), 0].join(',')}).`);
  for (const [p, n] of preds) {
    const xs = vars(n);
    L.push(`#defined sp_${p}/${n + 1}.`, `#defined sn_${p}/${n + 1}.`, `#defined ap_${p}/${n + 1}.`, `#defined an_${p}/${n + 1}.`, `#defined dp_${p}/${n + 1}.`, `#defined dn_${p}/${n + 1}.`);
    L.push(`${at('pos_' + p, xs, 'T')} :- ${at('sp_' + p, xs, 'T')}.`, `${at('neg_' + p, xs, 'T')} :- ${at('sn_' + p, xs, 'T')}.`);
    if (fluents.has(p)) {
      L.push(`${at('sp_' + p, xs, 'T+1')} :- ${at('sp_' + p, xs, 'T')}, step(T), not ${at('dp_' + p, xs, 'T')}, not ${at('an_' + p, xs, 'T')}.`);
      L.push(`${at('sp_' + p, xs, 'T+1')} :- ${at('ap_' + p, xs, 'T')}, step(T).`);
      L.push(`${at('sn_' + p, xs, 'T+1')} :- ${at('sn_' + p, xs, 'T')}, step(T), not ${at('dn_' + p, xs, 'T')}, not ${at('ap_' + p, xs, 'T')}.`);
      L.push(`${at('sn_' + p, xs, 'T+1')} :- ${at('an_' + p, xs, 'T')}, step(T).`);
      if (!closedSet.has(p)) L.push(`${at('sn_' + p, xs, 'T+1')} :- ${at('dp_' + p, xs, 'T')}, step(T), not ${at('ap_' + p, xs, 'T')}.`);
    }
  }
  for (const r of program.rules) L.push(...lowerRule(r, shown, 'T'));
  for (const a of program.aggregates) L.push(...lowerAggregate(a, shown, 'T'));
  // actions
  for (const a of actions) {
    const ps = a.params.map(aspVar);
    const occ = at('occ_' + a.id, ps, 'T');
    L.push(`{ ${occ} } :- step(T), ${lowerBody(a.leaves, 'T').join(', ')}.`);
    L.push(`actinst(T,${enc(a.id)},${tup(ps)}) :- ${occ}.`, `cost(${enc(a.id)},${a.cost}).`);
    for (const p of a.params) L.push(`paramused(${aspVar(p)},T) :- ${occ}.`);
    const eff = (list, cls) => { for (const e of list) L.push(`${at(cls + '_' + e.p, e.args.map(term), 'T')} :- ${occ}.`); };
    eff(a.adds.filter(e => !e.neg), 'ap'); eff(a.adds.filter(e => e.neg), 'an'); eff(a.removes.filter(e => !e.neg), 'dp'); eff(a.removes.filter(e => e.neg), 'dn');
  }
  L.push('any(T) :- actinst(T,_,_).', '1 { end(E) : time(E) } 1.', 'used(T) :- end(E), step(T), T < E.',
    ':- used(T), not any(T).', ':- any(T), not used(T).', ':- step(T), #count { N,A : actinst(T,N,A) } > 1.');
  for (const alt of goal) L.push(`goal(T) :- time(T), ${lowerBody(alt, 'T').join(', ')}.`);
  if (goalRequired) L.push(':- end(E), not goal(E).');
  const goalConsts = new Set(goal.flatMap(alt => alt.filter(l => l.kind === 'atom').flatMap(l => l.args.filter(t => !isVarTerm(t)))));
  for (const c of goalConsts) L.push(`goalc(${enc(c)}).`);
  L.push('boundc(C,S) :- goalc(C), time(S).', 'boundc(C,S) :- paramused(C,S0), time(S), S0 <= S.', '#defined goalc/1.', '#defined paramused/2.');
  via.forEach((v, i) => {
    const t = tokens(v);
    if (!t[0]?.startsWith('~')) throw new ProgramError('bad_via', `via needs ~action terms, got ${v}`);
    const args = t.slice(1).map(x => (x.startsWith('?') ? aspVar(x) : /^-?\d+$/.test(x) ? x : x.startsWith('"') ? x : enc(x)));
    L.push(`via${i} :- step(T), ${at('occ_' + t[0].slice(1), args, 'T')}.`, `:- not via${i}.`);
  });
  return L;
}

// ---------------------------------------------------------------------------------------------------------------- norms

function normLines(norms, actionNames, actionParams) {
  const L = ['#defined permitted/3.', '#defined hard/1.', '#defined strict/1.', '#defined adv/1.', '#defined softc/2.', '#defined viol/2.', '#defined firsttrig/3.', '#defined active/1.'];
  const hard = n => n.severity === 'hard';
  for (const n of norms) {
    const id = enc(n.id), p = n.pattern;
    const pat = p.args.map(term);
    const patVars = [...new Set(p.args.filter(isVarTerm).map(t => aspVar(t.var)))];
    if (n.modality !== 'permit' && p.kind === 'action' && !actionNames.has(p.name)) throw new ProgramError('norm_unknown_action', `norm ${n.id} names the action ${p.name}, which is not defined`, n.id);
    if (hard(n)) L.push(`hard(${id}).`, n.binding === 'advisory' ? `adv(${id}).` : `strict(${id}).`);
    else L.push(`softc(${id},${n.cost}).`);
    const whenAt = (alt, T) => lowerBody(n.alts[alt].leaves, T);
    if (n.modality === 'permit') {
      for (const target of n.overrides) for (let i = 0; i < n.alts.length; i++) L.push(`permitted(${enc(target)},${tup(pat)},T) :- step(T)${whenAt(i, 'T').length ? ', ' + whenAt(i, 'T').join(', ') : ''}.`);
    }
    const notPermitted = T => `not permitted(${id},${tup(pat)},${T})`;
    const stateAtom = (T, neg = p.neg) => `${neg ? 'neg_' : 'pos_'}${p.p}${p.args.length || T ? `(${[...pat, T].join(',')})` : ''}`;
    if (n.modality === 'forbid') {
      const q = n.qualifier;
      for (let i = 0; i < n.alts.length; i++) {
        const w = (T) => whenAt(i, T);
        if (p.kind === 'state') {
          L.push(`viol(${id},${tup([...pat, 'T'])}) :- time(T), end(E), T <= E, ${[stateAtom('T'), ...w('T'), notPermitted('T')].join(', ')}.`);
          continue;
        }
        const occ = T => at('occ_' + p.name, pat, T);
        if (q.kind === 'always') L.push(`viol(${id},${tup([...pat, 'T'])}) :- step(T), used(T), ${[occ('T'), ...w('T'), notPermitted('T')].join(', ')}.`);
        else if (q.kind === 'at_most_once') L.push(`viol(${id},${tup([...pat, 'T2'])}) :- step(T2), used(T2), step(T1), T1 < T2, ${[occ('T2'), occ('T1'), ...w('T2'), notPermitted('T2')].join(', ')}.`);
        else if (q.kind === 'before' || q.kind === 'after') {
          const refArgs = [...q.ref.args.map(term), ...Array.from({length: Math.max(0, (actionParams.get(q.ref.name) ?? q.ref.args.length) - q.ref.args.length)}, () => '_')];
          const shared = [...new Set(q.ref.args.filter(isVarTerm).map(t => aspVar(t.var)).filter(v => patVars.includes(v)))];
          const prior = `prior_${n.id}`;
          if (i === 0) L.push(`${prior}(${[...shared, 'T'].join(',')}) :- step(T), step(T0), T0 < T, ${at('occ_' + q.ref.name, refArgs, 'T0')}.`);
          const priorAtom = `${prior}(${[...shared, 'T'].join(',')})`;
          L.push(`viol(${id},${tup([...pat, 'T'])}) :- step(T), used(T), ${[occ('T'), ...w('T'), q.kind === 'before' ? `not ${priorAtom}` : priorAtom, notPermitted('T')].join(', ')}.`);
        } else throw new ProgramError('qualifier_unsupported', `forbid ${q.kind} is not lowered`, n.id);
      }
    }
    if (n.modality === 'oblige') {
      const q = n.qualifier;
      for (let i = 0; i < n.alts.length; i++) {
        const checks = n.standing ? [] : patVars.map(v => `boundc(${v},S)`);
        L.push(`trig(${id},${tup(pat)},S) :- step(S), used(S), ${[...whenAt(i, 'S'), ...checks].join(', ') || '#true'}.`);
      }
      L.push(`#defined trig/3.`);
      const window = q.kind === 'within' ? [`S2 <= S + ${p.kind === 'action' ? q.n - 1 : q.n}`] : [];
      if (q.kind === 'always') {
        if (p.kind !== 'state') throw new ProgramError('qualifier_unsupported', 'oblige always needs a state pattern', n.id);
        L.push(`viol(${id},${tup([...pat, 'S2'])}) :- firsttrig(${id},${tup(pat)},S), time(S2), S2 >= S, end(E), S2 <= E, not ${stateAtom('S2')}.`);
      } else {
        const done = p.kind === 'action'
          ? [at('occ_' + p.name, pat, 'S2'), 'used(S2)', 'S2 >= S', ...window]
          : ['time(S2)', 'S2 >= S', 'end(E)', 'S2 <= E', stateAtom('S2'), ...window];
        L.push(`dischok(${id},${tup(pat)},S) :- firsttrig(${id},${tup(pat)},S), ${done.join(', ')}.`);
        L.push(`viol(${id},${tup(pat)}) :- firsttrig(${id},${tup(pat)},S), not dischok(${id},${tup(pat)},S).`);
      }
    }
    // the norm took part when its `when` held at some state of the run
    for (let i = 0; i < n.alts.length; i++) L.push(`active(${id}) :- time(T), end(E), T <= E${whenAt(i, 'T').length ? ', ' + whenAt(i, 'T').join(', ') : ''}.`);
  }
  L.push('trigbefore(N,A,S) :- trig(N,A,S0), step(S0), S0 < S, step(S).', 'firsttrig(N,A,S) :- trig(N,A,S), not trigbefore(N,A,S).', '#defined dischok/3.');
  // deontic conflicts: a forbidden instance executed while an equal-strength obligation on the same action is triggered
  for (const f of norms.filter(x => x.modality === 'forbid' && x.pattern.kind === 'action' && x.severity === 'hard')) {
    for (const o of norms.filter(x => x.modality === 'oblige' && x.pattern.kind === 'action' && x.pattern.name === f.pattern.name && x.severity === f.severity && x.binding === f.binding)) {
      if (f.overrides.includes(o.id) || o.overrides.includes(f.id)) continue;
      const ys = vars(f.pattern.args.length, 'Y');
      L.push(`confl(${enc(f.id)},${enc(o.id)}) :- viol(${enc(f.id)},${tup([...ys, 'T'])}), firsttrig(${enc(o.id)},${tup(ys)},S).`);
    }
  }
  L.push('#defined confl/2.');
  return L;
}

const STAGE_RULES = {
  A: [':- viol(N,_), hard(N).', ':- confl(F,O).'],
  B: [':- viol(N,_), strict(N).', '{ relax(N) : adv(N) }.', ':- viol(N,_), adv(N), not relax(N).', ':- confl(F,O), strict(F).', ':- confl(F,O), not relax(F), not relax(O).',
    '#minimize { 1@2,N : relax(N) }.'],
  C: ['blk(N) :- viol(N,_), strict(N).', 'blk(F) :- confl(F,_), strict(F).', 'blk(O) :- confl(_,O), strict(O).', 'advrel(N) :- viol(N,_), adv(N).', 'advrel(F) :- confl(F,_), adv(F).', 'advrel(O) :- confl(_,O), adv(O).',
    '#minimize { 1@3,N : blk(N) }.', '#minimize { 1@2,N : advrel(N) }.']
};

const OBJECTIVE = ['#minimize { C@1,act,T,N,A : actinst(T,N,A), cost(N,C) ; C@1,viol,N,I : viol(N,I), softc(N,C) }.', '#minimize { 1@0,T : used(T) }.',
  '#show ovf_arith/0.', '#show actinst/3.', '#show viol/2.', '#show relax/1.', '#show blk/1.', '#show advrel/1.', '#show firsttrig/3.', '#show active/1.', '#show end/1.', '#show confl/2.'];

function solve(lines, timeoutMs) {
  const r = runClingo(lines.join('\n') + '\n', {optMode: 'opt', timeoutMs});
  if (r.interrupted) throw new SolverStop('wall');
  return r.result === 'UNSAT' ? null : r.witnesses.at(-1);
}

const val = t => (typeof t === 'object' && t?.tuple ? t.tuple : t);

function readModel(w, actionById, normById) {
  const atoms = w.atoms.map(parseAtom);
  const of = n => atoms.filter(a => a.name === n);
  const steps = of('actinst').map(a => ({T: a.args[0], action: a.args[1], params: val(a.args[2])})).sort((x, y) => x.T - y.T);
  const cost = steps.reduce((s, x) => s + (actionById.get(x.action)?.cost ?? 1), 0);
  const viols = of('viol').map(a => a.args[0]);
  const softViol = viols.filter(id => normById.get(id)?.severity === 'soft').map(id => ({id, cost: normById.get(id).cost}));
  return {
    steps, cost, softViol, relax: of('relax').map(a => a.args[0]).sort(), blocked: [...new Set(of('blk').map(a => a.args[0]))].sort(), advrel: [...new Set(of('advrel').map(a => a.args[0]))].sort(),
    obligations: of('firsttrig').map(a => `${a.args[0]} ${val(a.args[1]).map(showValue).join(' ')}`.trim()), active: [...new Set(of('active').map(a => a.args[0]))],
    conflicts: of('confl').map(a => [a.args[0], a.args[1]])
  };
}

export function aspPlan({program, facts, goalAlts, norms, via, mode, budget, limit = Infinity, waivers, inForce}) {
  const timeoutMs = budget.limits.timeoutMs;
  const actions = actionModel(program);
  const goal = orderedGoal(goalAlts);
  if (program.aggregates.some(a => a.fn === 'sum')) throw new NotExpressibleError(['integer_range'], 'a sum aggregate inside a planning problem is not lowered (the 32-bit range of the sum is checked only for closure queries)');
  assertIntegerRange(program, facts, [...goal.flat(), ...actions.flatMap(a => a.leaves)]);
  assertNoTimeValues(program, facts, [...goal.flat(), ...actions.flatMap(a => a.leaves)]);
  const {preds, fluents} = collectPredicates({program, facts, actions, goal, norms});
  const actionById = new Map(actions.map(a => [a.id, a])), normById = new Map(norms.map(n => [n.id, n]));
  const actionNames = new Set(actions.map(a => a.id));
  const Hmax = Math.max(1, budget.limits.maxDepth);
  const minCost = actions.length ? Math.min(...actions.map(a => a.cost)) : 0;
  const hardNorms = norms.filter(n => n.severity === 'hard' && n.modality !== 'permit');
  const markov = isMarkov(norms, via);
  const exhausted = reason => ({status: 'budget_exhausted', complete: false, reason, budget: {...budget.snapshot(false), exhausted: true, reason}});
  const text = (H, extra, goalRequired = true) => [...systemLines({H, program, facts, actions, goal, preds, fluents, via, closedSet: program.closed, goalRequired}), ...normLines(norms, actionNames, new Map(actions.map(a => [a.id, a.params.length]))), ...extra, ...OBJECTIVE];
  try {
    if (mode === 'abduce') return waiveAbduction({text, Hmax, waivers, timeoutMs, limit});
    // stage A over growing horizons
    const horizons = [...new Set([Math.min(6, Hmax), Hmax])];
    let found = null, Hused = 0;
    for (const H of horizons) {
      const w = solve(text(H, STAGE_RULES.A), timeoutMs);
      Hused = H;
      if (!w) continue;
      const m = readModel(w, actionById, normById);
      const objective = m.cost + m.softViol.reduce((s, x) => s + x.cost, 0);
      found = {m, H};
      if (costBoundProves({objective, H, minCost})) break; // no longer plan can be strictly cheaper
      if (H === Hmax) break;
    }
    if (found) return planPacket({m: found.m, actions, normById, relaxed: [], hard: 'ok', ...certify({found, minCost, markov, text, timeoutMs, preds, fluents, hard: 'ok'})});
    // stage B: relax hard advisory norms
    if (norms.some(n => n.severity === 'hard' && n.binding === 'advisory')) {
      const w = solve(text(Hmax, STAGE_RULES.B), timeoutMs);
      if (w) { const m = readModel(w, actionById, normById); return planPacket({m, actions, normById, relaxed: m.relax, hard: 'relaxed', guarantee: 'bounded', notes: ['relaxed_within_horizon']}); }
    }
    // stage C: lift the strict norms and name the blockers
    if (hardNorms.length) {
      const w = solve(text(Hmax, STAGE_RULES.C), timeoutMs);
      if (w) {
        const m = readModel(w, actionById, normById);
        const by = [...new Set([...m.blocked, ...m.advrel])];
        return blockedPacket({by, normById, plan: m.steps.map(x => x.action)});
      }
    }
    // nothing within the horizon, with or without the norms
    if (markov && !via.length) {
      if (!looplessExists({text, preds, fluents, H: Hmax, timeoutMs})) return {status: 'no_plan', complete: true, used: []};
    }
    return exhausted('horizon');
  } catch (e) {
    if (e instanceof SolverStop) return exhausted(e.reason);
    throw e;
  }
}

/** All states of the path pairwise different: a plan can be shortened to one, so no such path of H actions means no plan. */
function looplessExists({text, preds, fluents, H, timeoutMs, enforce = STAGE_RULES.A}) {
  const L = ['#defined diff/2.', ...enforce];
  for (const [p, n] of preds) {
    if (!fluents.has(p)) continue;
    const xs = vars(n);
    for (const pol of ['sp_', 'sn_']) {
      L.push(`diff(T1,T2) :- time(T1), time(T2), T1 < T2, ${at(pol + p, xs, 'T1')}, not ${at(pol + p, xs, 'T2')}.`);
      L.push(`diff(T1,T2) :- time(T1), time(T2), T1 < T2, ${at(pol + p, xs, 'T2')}, not ${at(pol + p, xs, 'T1')}.`);
    }
  }
  L.push(':- time(T1), time(T2), T1 < T2, not diff(T1,T2).', `:- not end(${H}).`);
  return solve(text(H, L, false), timeoutMs) !== null;
}

function certify({found, minCost, markov, text, timeoutMs, preds, fluents, hard}) {
  const {m, H} = found;
  const objective = m.cost + m.softViol.reduce((s, x) => s + x.cost, 0);
  if (costBoundProves({objective, H, minCost})) return {guarantee: 'exact', notes: []};
  // the optimum is proved only if no loopless path of H actions satisfies the norms either
  const proved = markov && hard === 'ok' && !looplessExists({text, preds, fluents, H, timeoutMs});
  return proved ? {guarantee: 'exact', notes: []} : {guarantee: 'bounded', notes: ['optimality_bounded_by_horizon']};
}

/** Minimal sets of norms to waive (hypotheses `waive $norm`): all inclusion-minimal, found by blocking supersets round by round. */
function waiveAbduction({text, Hmax, waivers, timeoutMs, limit}) {
  if (!waivers.length) throw new ProgramError('no_waive_hypothesis', 'abduction over a plan needs hypothesis wires with waive $norm');
  const found = [];
  for (;;) {
    const blocks = found.map(s => `:- ${s.length ? s.map(n => `waive(${enc(n)})`).join(', ') : '#true'}.`);
    const lines = [
      '{ waive(N) : cand(N) }.', ...waivers.map(w => `cand(${enc(w.norm)}). wcost(${enc(w.norm)},${w.cost}).`),
      ':- viol(N,_), hard(N), not waive(N).', ':- confl(F,O), not waive(F), not waive(O).', '#minimize { C@4,N : waive(N), wcost(N,C) }.', '#show waive/1.', ...blocks
    ];
    const w = solve(text(Hmax, lines), timeoutMs);
    if (!w) break;
    const set = w.atoms.map(parseAtom).filter(a => a.name === 'waive').map(a => a.args[0]).sort();
    found.push(set);
    if (!set.length) break;
  }
  const sets = found.map(s => s.map(n => `waive ${n}`)).sort((a, b) => a.length - b.length || (a.join() < b.join() ? -1 : 1));
  if (!sets.length) return {status: 'unknown', complete: true, reason: 'no_explanation', hypotheses: [], explanations: []};
  const shown = sets.slice(0, limit);
  return {status: 'supported', complete: shown.length === sets.length, hypotheses: shown, ...(shown.length < sets.length ? {truncated: true} : {})};
}
