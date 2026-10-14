/**
 * Lowering of the state of a trace: the facts that name its steps and states, and, for every predicate a norm or a method looks at,
 * the step-indexed relation `x_c_s_<p> i args` (does `p args` hold in state i) with its frame axioms as core rules.
 *
 *   x_c_state i, x_c_succ h i, x_c_last n      the step and state indices (a step i goes from state i-1 to state i)
 *   x_c_did_<a> i args                          step i performed action a with these arguments
 *   x_c_inforce "id" i                          the governed wire `id` is in force at step i (state 0 takes the time of step 1)
 *   x_c_dom v                                   every constant of the trace (existential method variables range over it)
 *   x_c_s_<p> i args                            the state relation of p, by kind:
 *     static    p no action changes: its facts hold in every state (a fact with `valid` only where it is valid);
 *     fluent    p some step adds or removes: step-0 facts, then the inertia rules  s(i) <- s(h), succ(h,i), absent gone(i)  and
 *               s(i) <- added(i), with the effects of the steps as ground tables x_c_add_<p>, x_c_gone_<p> (and the negative-evidence
 *               tables x_c_addn_<p>, x_c_gonen_<p> for an open fluent, the same polarity rules as the planner's world);
 *     derived   p the head of a rule: its facts in every state and a copy of each rule in force, guarded by x_c_inforce and
 *               evaluated at the same state index.
 * The effects of a step are applied whatever its preconditions (a trace is a record).
 */
import {groundArgs, validAt, parseInstant, NotExpressibleError} from '../js-reference/values.mjs';
import {sym, T, Q, atom} from './emit.mjs';

export const S = p => 'x_c_s_' + sym(p);
export const DID = a => 'x_c_did_' + sym(a);
export const I = '?c_i', H = '?c_h';

/** The text of one condition leaf evaluated at the state variable `at`; start_of/end_of cannot be lowered. */
export function leafText(l, at) {
  switch (l.kind) {
    case 'atom': return atom(S(l.p), [at, ...l.args], l.mode);
    case 'compare': return `compare ${T(l.left)} ${l.word} ${T(l.right)}`;
    case 'compute': return `compute ${l.out} ${T(l.left)} ${l.word} ${T(l.right)}`;
    case 'order': return `order ${l.left} ${l.word} ${l.right}`;
    default: throw new NotExpressibleError(['check_plan'], `a ${l.kind} condition is not lowered to the step-indexed state`);
  }
}

/**
 * Predicates the norms and methods read (state patterns, when conditions, step conditions) and, through the rules, everything they
 * depend on; `use` holds the number of arguments each is used with.
 */
export function neededPredicates({norms, methods, program}) {
  const need = new Set(), use = new Map();
  const addPred = (p, k) => { need.add(p); if (use.has(p) && use.get(p) !== k) throw new Error(`${p} is used with arities ${use.get(p)} and ${k}`); use.set(p, k); };
  const addAlts = alts => alts.forEach(a => a.forEach(l => { if (l.kind === 'atom') addPred(l.p, l.args.length); else if (l.kind === 'timeof') throw new NotExpressibleError(['check_plan'], 'start_of and end_of conditions are not lowered'); }));
  for (const n of norms) { if (n.pat.kind === 'state') addPred(n.pat.p, n.pat.terms.length); addAlts(n.whenAlts); }
  const walk = nodes => nodes.forEach(x => {
    if (x.p && ['if', 'until', 'pick'].includes(x.kind)) addPred(x.p, x.terms.length);
    if (x.item) walk([x.item]);
    for (const k of ['branches', 'items', 'then', 'otherwise', 'body']) if (x[k]) walk(x[k]);
  });
  for (const m of methods) { addAlts(m.whenAlts); walk(m.steps); }
  for (let grew = true; grew;) {
    grew = false;
    for (const r of program.rules) {
      if (!need.has(r.head.p)) continue;
      for (const alt of r.alts) for (const l of alt.leaves) if (l.kind === 'atom' && !need.has(l.p)) { addPred(l.p, l.args.length); grew = true; }
    }
  }
  for (const a of program.aggregates) if (need.has(a.yields.p)) throw new NotExpressibleError(['aggregate'], `the aggregate ${a.id} lies in the cone of a norm or method condition`);
  return {need, use};
}

/** Emit the step and state facts, the in-force facts and the state relations of the needed predicates. */
export function lowerState({out, program, world, steps, tl, need, use}) {
  const n = steps.length;
  out.declare('x_c_state', 1); out.declare('x_c_succ', 2); out.declare('x_c_last', 1); out.declare('x_c_inforce', 2); out.declare('x_c_dom', 1);
  for (let i = 0; i <= n; i++) out.fact(`x_c_state ${i}`);
  for (let i = 1; i <= n; i++) out.fact(`x_c_succ ${i - 1} ${i}`);
  out.fact(`x_c_last ${n}`);
  for (const c of new Set(steps.flatMap(s => s.args))) out.fact(`x_c_dom ${T(c)}`);
  const guarded = new Set([...tl.norms.map(x => x.id), ...tl.methods.map(x => x.id), ...program.rules.filter(r => need.has(r.head.p)).map(r => r.source.id)]);
  for (const id of guarded) for (let i = 0; i <= n; i++) if (tl.idInForceAt(id, i)) out.fact(`x_c_inforce ${Q(id)} ${i}`);
  steps.forEach((s, k) => { out.declare(DID(s.action), 1 + s.args.length); out.fact(`${DID(s.action)} ${k + 1} ${s.args.map(T).join(' ')}`.trim()); });

  const arity = new Map();
  const note = (p, k) => { if (arity.has(p) && arity.get(p) !== k) throw new Error(`${p} is used with arities ${arity.get(p)} and ${k}`); arity.set(p, k); };
  for (const [p, k] of use) note(p, k);
  for (const [p, d] of program.predicates) note(p, d.args.length);
  for (const f of program.facts) note(f.p, f.args.length);
  for (const r of program.rules) { note(r.head.p, r.head.args.length); for (const a of r.alts) for (const l of a.leaves) if (l.kind === 'atom') note(l.p, l.args.length); }

  const derived = new Set(program.rules.map(r => r.head.p));
  const fluent = new Set();
  const effects = {add: new Map(), addn: new Map(), gone: new Map(), gonen: new Map()};
  const put = (kind, p, row) => { if (!effects[kind].has(p)) effects[kind].set(p, []); effects[kind].get(p).push(row); };
  steps.forEach((s, k) => {
    const a = world.actions.get(s.action);
    const env = Object.fromEntries(a.params.map((v, i) => [v, s.args[i]]));
    for (const e of [...a.adds.map(x => ({x, add: true})), ...a.removes.map(x => ({x, add: false}))]) {
      const {x, add} = e;
      if (!need.has(x.p)) continue;
      const args = groundArgs(x.args, env);
      note(x.p, args.length);
      fluent.add(x.p);
      const row = [k + 1, ...args];
      if (add && !x.neg) { put('add', x.p, row); put('gonen', x.p, row); }
      else if (add && x.neg) { put('addn', x.p, row); put('gone', x.p, row); }
      else if (!x.neg) { put('gone', x.p, row); if (!world.closed.has(x.p)) put('addn', x.p, row); }
      else put('gonen', x.p, row);
    }
  });
  for (const p of fluent) if (derived.has(p)) throw new NotExpressibleError(['check_plan'], `${p} is derived by a rule and also changed by an action`);

  const instantOf = i => { const t = tl.timeOf(i); return t ? parseInstant(t) : Date.now(); };
  for (const p of need) {
    if (!arity.has(p)) throw new NotExpressibleError(['check_plan'], `the predicate ${p} is neither declared nor used with a fixed number of arguments`);
    const k = arity.get(p), V = Array.from({length: k}, (_, j) => `?c_v${j + 1}`);
    out.declare(S(p), k + 1);
    const facts = program.facts.filter(f => f.p === p);
    const put0 = (f, i) => out.fact(`${f.neg ? 'not ' : ''}${S(p)} ${i} ${f.args.map(T).join(' ')}`.trim());
    if (fluent.has(p)) {
      for (const f of facts) put0(f, 0);
      const names = {};
      for (const kind of ['add', 'addn', 'gone', 'gonen']) { names[kind] = out.declare(`x_c_${kind}_${sym(p)}`, k + 1); for (const row of effects[kind].get(p) ?? []) out.fact(`${names[kind]} ${row.map(T).join(' ')}`); }
      const vs = V.join(' ');
      out.rule(`${S(p)} ${I} ${vs}`.trim(), [`${names.add} ${I} ${vs}`.trim()]);
      out.rule(`${S(p)} ${I} ${vs}`.trim(), [`${S(p)} ${H} ${vs}`.trim(), `x_c_succ ${H} ${I}`, `absent ${names.gone} ${I} ${vs}`.trim()]);
      if ((effects.addn.get(p) ?? []).length || facts.some(f => f.neg)) {
        out.rule(`not ${S(p)} ${I} ${vs}`.trim(), [`${names.addn} ${I} ${vs}`.trim()]);
        out.rule(`not ${S(p)} ${I} ${vs}`.trim(), [`not ${S(p)} ${H} ${vs}`.trim(), `x_c_succ ${H} ${I}`, `absent ${names.gonen} ${I} ${vs}`.trim()]);
      }
    } else {
      for (const f of facts) for (let i = 0; i <= n; i++) if (!f.valid || validAt(f.valid, instantOf(i))) put0(f, i);
    }
  }
  for (const r of program.rules) {
    if (!need.has(r.head.p)) continue;
    for (const alt of r.alts) {
      const body = [`x_c_inforce ${Q(r.source.id)} ${I}`, ...alt.leaves.map(l => leafText(l, I))];
      out.rule(`${r.head.neg ? 'not ' : ''}${S(r.head.p)} ${[I, ...r.head.args.map(T)].join(' ')}`, body);
    }
  }
  return {arity, derived, fluent};
}

