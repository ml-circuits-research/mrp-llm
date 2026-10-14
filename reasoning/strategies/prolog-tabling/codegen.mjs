/**
 * Code generation of the prolog-tabling strategy: a compiled circuit program (js-reference `compileProgram`, governance applied,
 * sugar desugared) becomes one SWI-Prolog source text.
 *
 *   polarity   two predicates per relation: p_<rel> (positive evidence P) and n_<rel> (negative evidence N); `both` is a reported
 *              status, so the two are independent (a conflict is p and n, never an explosion);
 *   tabling    EVERY relation predicate is tabled (SLG resolution), so left recursion and cycles terminate and `tnot` is allowed on
 *              any of them; `absent p` is `tnot(p_p(...))` (well-founded negation; under the stratified programs the validator
 *              admits it equals the perfect model);
 *   rules      one clause per alternative of the body (an `any` group is several clauses); compare / compute / order are arithmetic
 *              helpers of runtime.pl; start_of / end_of read the `st_<rel>` facts of the time view;
 *   aggregates findall over the body, `sort` for set semantics, group, and fold (count, sum, min, max, collect);
 *   data       rt_fact/7, rt_rule/8, rt_agg/6, rt_agg_rows/3 describe the same program as DATA for the proof search, the height
 *              computation and the abductive meta-interpreter (runtime.pl);
 *   heights    with a round ceiling (maxRounds) every derived predicate carries a derivation HEIGHT as its last argument, tabled with the
 *              `min` mode: the height of an atom is the round of the oracle's naive evaluation at which it is derived (counted inside
 *              its stratum), so a ceiling N keeps exactly the atoms of rounds 1..N. This is how a round budget is honoured by a
 *              top-down engine without any rounds.
 */
import {isVarTerm, NotExpressibleError} from '../js-reference/values.mjs';

export const q = s => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n') + "'";
/** A number as Prolog text: an integer as is, a decimal as the exact rational literal `1r10` (0.1), never a binary float. */
export function numberText(n) {
  if (Number.isInteger(n)) return String(n);
  const [mantissa, e] = Math.abs(n).toString().split('e');
  const [whole, frac = ''] = mantissa.split('.');
  let num = BigInt(whole + frac), den = 1n;
  const shift = Number(e ?? 0) - frac.length;
  if (shift >= 0) num *= 10n ** BigInt(shift); else den = 10n ** BigInt(-shift);
  const g = ((a, b) => { while (b) [a, b] = [b, a % b]; return a; })(num, den);
  return `${n < 0 ? '-' : ''}${num / g}r${den / g}`;
}
export const termText = t => (isVarTerm(t) ? 'V_' + t.var.slice(1) : typeof t === 'number' ? numberText(t) : q(t));
export const listText = xs => '[' + xs.join(',') + ']';
const argsText = args => listText(args.map(termText));
const varName = v => 'V_' + v.slice(1);

const ARITH = Object.fromEntries(['plus', 'minus', 'times', 'divided_by', 'whole_divided_by', 'modulo', 'power', 'rounded_to', 'rounded_up_to', 'rounded_down_to', 'minimum_with', 'maximum_with'].map(w => [w, w]));

/** Registry of the relations of a program: arity, stratum and which polarities are DERIVED (have a rule or aggregate head). */
export function registry(program, extraAtoms = []) {
  const arity = new Map();
  const note = (p, n) => { if (!arity.has(p)) arity.set(p, n); };
  for (const [id, d] of program.predicates) note(id, d.args.length);
  for (const f of program.facts) note(f.p, f.args.length);
  const leafAtoms = leaf => { if (leaf.kind === 'atom' || leaf.kind === 'timeof') note(leaf.p, leaf.args.length); };
  for (const r of program.rules) { note(r.head.p, r.head.args.length); for (const a of r.alts) a.leaves.forEach(leafAtoms); }
  for (const a of program.aggregates) { note(a.yields.p, a.yields.args.length); for (const alt of a.alts) alt.leaves.forEach(leafAtoms); }
  for (const h of program.hypotheses) for (const a of h.atoms) note(a.p, a.args.length);
  for (const a of extraAtoms) note(a.p, a.args.length);
  const derived = new Set();
  for (const r of program.rules) derived.add((r.head.neg ? 'neg' : 'pos') + '|' + r.head.p);
  for (const a of program.aggregates) derived.add('pos|' + a.yields.p);
  const stratum = new Map();
  (program.strata ?? []).forEach((s, i) => { for (const p of s.preds) stratum.set(p, i); });
  return {arity, derived, stratum};
}

const predName = (pol, p) => (pol === 'pos' ? 'p_' : 'n_') + p;

/** Builds goals; `heights` adds the derivation-height argument to derived predicates. */
export function goals(reg, heights) {
  const withH = (pol, p) => heights !== null && reg.derived.has(pol + '|' + p);
  return {
    withH,
    call(pol, p, args, hv = '_') {
      const a = args.map(termText);
      if (withH(pol, p)) a.push(hv);
      return a.length ? `${predName(pol, p)}(${a.join(',')})` : predName(pol, p);
    },
    /** the head of a clause or fact with an explicit height */
    head(pol, p, args, h) {
      const a = args.map(termText);
      if (withH(pol, p)) a.push(h);
      return a.length ? `${predName(pol, p)}(${a.join(',')})` : predName(pol, p);
    }
  };
}

export const leafData = l => {
  switch (l.kind) {
    case 'atom': return `l(${l.mode},${q(l.p)},${argsText(l.args)})`;
    case 'compare': return `l(cmp,${l.word},${termText(l.left)},${termText(l.right)})`;
    case 'compute': return `l(compute,${l.word},${varName(l.out)},${termText(l.left)},${termText(l.right)})`;
    case 'order': return `l(order,${l.word},${varName(l.left)},${varName(l.right)})`;
    case 'timeof': return `l(timeof,${l.which},${varName(l.out)},${q(l.p)},${argsText(l.args)})`;
    default: throw new Error('unknown leaf ' + l.kind);
  }
};

/** Executable goals of one ordered alternative. `hv(i)` names the height variable of an atom leaf (heights mode only). */
export function leafGoals(g, leaves, sameStratumAs = null, reg = null) {
  const out = [], hvars = [];
  // which derived body atoms count towards the height of the head: those of the head's own stratum (round ceiling), or all (proofs)
  const counts = typeof sameStratumAs === 'function' ? sameStratumAs : p => sameStratumAs !== null && reg.stratum.get(p) === sameStratumAs;
  for (const l of leaves) {
    switch (l.kind) {
      case 'atom': {
        if (l.mode === 'absent') {
          const inner = g.call('pos', l.p, l.args, '_');
          out.push(g.withH('pos', l.p) ? `\\+ ${inner}` : `tnot(${inner})`);
        } else {
          const pol = l.mode === 'pos' ? 'pos' : 'neg';
          let hv = '_';
          if (g.withH(pol, l.p) && counts(l.p)) { hv = 'H' + hvars.length; hvars.push(hv); }
          out.push(g.call(pol, l.p, l.args, hv));
        }
        break;
      }
      case 'compare': out.push(`rt_cmp(${l.word},${termText(l.left)},${termText(l.right)})`); break;
      case 'compute': if (!ARITH[l.word]) throw new NotExpressibleError(['exact_arithmetic'], `compute ${l.word} is not a compute word`); out.push(`rt_compute(${ARITH[l.word]},${termText(l.left)},${termText(l.right)},T_${l.out.slice(1)}), ${varName(l.out)} = T_${l.out.slice(1)}`); break;
      case 'order': out.push(`rt_order(${l.word},${varName(l.left)},${varName(l.right)})`); break;
      case 'timeof': {
        const a = [...l.args.map(termText), `F_${l.out.slice(1)}`, `E_${l.out.slice(1)}`];
        out.push(`st_${l.p}(${a.join(',')}), ${varName(l.out)} = ${l.which === 'start_of' ? 'F_' : 'E_'}${l.out.slice(1)}`);
        break;
      }
      default: throw new Error('unknown leaf ' + l.kind);
    }
  }
  return {goals: out, hvars};
}

/** The premise list (a Prolog list expression) of one alternative: literals of the evidence the leaves rest on, absent markers. */
export function premText(leaves) {
  const items = [];
  for (const l of leaves) {
    if (l.kind === 'atom') items.push(l.mode === 'absent' ? `absent(${q(l.p)},${argsText(l.args)})` : `l(${l.mode === 'pos' ? 'pos' : 'neg'},${q(l.p)},${argsText(l.args)})`);
    else if (l.kind === 'timeof') items.push(`l(pos,${q(l.p)},${argsText(l.args)})`);
  }
  return listText(items);
}

export const vars = leaves => {
  const out = new Set();
  const add = t => { if (isVarTerm(t)) out.add(t.var); };
  for (const l of leaves) {
    if (l.kind === 'atom' || l.kind === 'timeof') l.args.forEach(add);
    if (l.kind === 'compare') [l.left, l.right].forEach(add);
    if (l.kind === 'compute') { [l.left, l.right].forEach(add); out.add(l.out); }
    if (l.kind === 'order') { out.add(l.left); out.add(l.right); }
    if (l.kind === 'timeof') out.add(l.out);
  }
  return out;
};
const bindingText = (names) => listText([...names].sort().map(v => `${q(v.slice(1))}=${varName(v)}`));

/**
 * The text of the program (everything except the task): tables, facts, rules, aggregates, data, domains.
 *   view   the stored facts of the time view {neg, p, args, claim:{id,version}, status, speaker, valid}
 */
export function programText({program, view, reg, heights, extraTimeof = [], stateMode = false}) {
  const g = goals(reg, heights);
  const out = [];
  const clauses = new Map(); // predicate name -> clause texts
  const add = (name, text) => { if (!clauses.has(name)) clauses.set(name, []); clauses.get(name).push(text); };
  const data = [];

  // facts
  const seen = new Set(), timeofPreds = new Set(extraTimeof);
  for (const r of program.rules) for (const a of r.alts) for (const l of a.leaves) if (l.kind === 'timeof') timeofPreds.add(l.p);
  for (const a of program.aggregates) for (const alt of a.alts) for (const l of alt.leaves) if (l.kind === 'timeof') timeofPreds.add(l.p);
  const stored = new Map();
  // state mode (golog-swi): the facts are read from the current state, rt_st(Polarity, Relation, Args), not compiled in
  if (stateMode) {
    for (const [p, n] of reg.arity) {
      for (const pol of ['pos', 'neg']) {
        const vs = Array.from({length: n}, (_, i) => `S${i}`);
        add(predName(pol, p), `${vs.length ? `${predName(pol, p)}(${vs.join(',')})` : predName(pol, p)} :- rt_st(${pol},${q(p)},${listText(vs)}).`);
      }
    }
  }
  for (const f of stateMode ? [] : view) {
    const pol = f.neg ? 'neg' : 'pos';
    add(predName(pol, f.p), g.head(pol, f.p, f.args, '0') + '.');
    const k = pol + '|' + f.p + '|' + JSON.stringify(f.args);
    if (!seen.has(k)) {
      seen.add(k);
      data.push(`rt_fact(${pol},${q(f.p)},${argsText(f.args)},${q(f.claim.id)},${f.claim.version},${q(f.status)},${f.speaker ? q(f.speaker) : 'null'}).`);
    }
    if (!f.neg && timeofPreds.has(f.p)) {
      if (!stored.has(f.p)) stored.set(f.p, []);
      stored.get(f.p).push(`st_${f.p}(${[...f.args.map(termText), q(f.valid?.fromText ?? 'beginning'), q(f.valid?.toText ?? 'open')].join(',')}).`);
    }
  }
  for (const p of timeofPreds) {
    const n = reg.arity.get(p) ?? 0;
    const text = (stored.get(p) ?? []).join('\n') || `st_${p}(${Array(n + 2).fill('_').join(',')}) :- fail.`;
    out.push(`:- dynamic st_${p}/${n + 2}.\n${text}`);
  }
  if (stateMode) out.push(':- dynamic rt_st/3.');

  // hypotheses: a candidate atom holds only while rt_on(Id) is asserted (abduction)
  for (const h of program.hypotheses) for (const a of h.atoms) {
    const pol = a.neg ? 'neg' : 'pos';
    add(predName(pol, a.p), `${g.head(pol, a.p, a.args, '1')} :- rt_on(${q(h.id)}).`);
  }
  if (program.hypotheses.length) out.push(`:- dynamic rt_on/1.`);

  // rules
  for (const r of program.rules) {
    const pol = r.head.neg ? 'neg' : 'pos';
    const hs = reg.stratum.get(r.head.p) ?? null;
    for (const alt of r.alts) {
      const {goals: gs, hvars} = leafGoals(g, alt.leaves, heights !== null ? hs : null, reg);
      let body = gs.join(', ');
      let h = '_';
      if (g.withH(pol, r.head.p)) {
        h = 'H';
        body += `${body ? ', ' : ''}rt_hmax(${listText(hvars)},HM), H is HM+1, rt_bound(B), H =< B`;
      }
      add(predName(pol, r.head.p), `${g.head(pol, r.head.p, r.head.args, h)}${body ? ' :- ' + body : ''}.`);
      const names = new Set([...vars(alt.leaves), ...r.head.args.filter(isVarTerm).map(t => t.var)]);
      data.push(`rt_rule(${q(r.source.id)},${r.source.version},${q(r.id)},${r.head.neg},${q(r.head.p)},${argsText(r.head.args)},${listText(alt.leaves.map(leafData))},${bindingText(names)}).`);
    }
  }

  // aggregates
  for (const a of program.aggregates) {
    const rowIdx = new Map(a.rowVars.map((v, i) => [v, i]));
    const alts = a.alts.map(alt => {
      const {goals: gs} = leafGoals(g, alt.leaves, null, reg);
      const row = a.rowVars.map(v => (alt.leaves && vars(alt.leaves).has(v) ? varName(v) : "'$unbound'"));
      return `( ${gs.join(', ')}${gs.length ? ', ' : ''}Row = ${listText(row)} )`;
    });
    const gidx = a.group.map(v => rowIdx.get(v));
    const fieldIdx = a.field ? rowIdx.get(a.field) : -1;
    const gv = listText(a.group.map(varName));
    const hAnd = g.withH('pos', a.yields.p) ? ', rt_bound(B), 1 =< B' : '';
    add(predName('pos', a.yields.p), `${g.head('pos', a.yields.p, a.yields.args, '1')} :- findall(Row, ( ${alts.join(' ; ')} ), L0), sort(L0, Rows), rt_groups(Rows, ${listText(gidx)}, Groups), member(GK-Members, Groups), GK = ${gv}, rt_agg_fn(${a.fn}, ${fieldIdx}, Members, AggOut), ${varName(a.out)} = AggOut${hAnd}.`);
    const names = new Set([...a.group, a.out]);
    data.push(`rt_agg(${q(a.source.id)},${a.source.version},${q(a.yields.p)},${argsText(a.yields.args)},${gv},${bindingText(names)}).`);
    const premAlts = a.alts.map(alt => {
      const {goals: gs} = leafGoals(g, alt.leaves, null, reg);
      return `( ${gs.join(', ')}${gs.length ? ', ' : ''}Pr = ${premText(alt.leaves)} )`;
    });
    data.push(`rt_agg_rows(${q(a.id)},${gv},Prems) :- findall(Pr, ( ${premAlts.join(' ; ')} ), PL), append(PL, P0), sort(P0, Prems).`);
  }

  // domains and closedness (for why_not)
  const constants = new Set();
  for (const f of program.facts) f.args.forEach(a => constants.add(a));
  for (const r of program.rules) for (const t of r.head.args) if (!isVarTerm(t)) constants.add(t);
  const typed = type => [...constants].filter(c => (type === 'integer' ? typeof c === 'number' : type === 'entity' || type === 'text' ? typeof c === 'string' : true));
  for (const [p, n] of reg.arity) {
    for (let i = 0; i < n; i++) data.push(`rt_domain(${q(p)},${i},${listText(typed(program.predicates.get(p)?.args[i]?.type).map(termText))}).`);
  }
  const derivedRel = new Set([...program.rules.map(r => r.head.p), ...program.aggregates.map(a => a.yields.p)]);
  for (const p of derivedRel) data.push(`rt_derived(${q(p)}).`);
  for (const p of program.closed) data.push(`rt_closed(${q(p)}).`);

  // tables and dummy clauses
  const decls = [];
  for (const [p, n] of reg.arity) {
    for (const pol of ['pos', 'neg']) {
      const name = predName(pol, p);
      const withH = g.withH(pol, p);
      const arity = n + (withH ? 1 : 0);
      decls.push(withH ? `:- table ${name}(${[...Array(n).fill('_'), 'min'].join(',')}).` : `:- table ${name}/${arity}.`);
      if (!clauses.has(name)) add(name, `${arity ? `${name}(${Array(arity).fill('_').join(',')})` : name} :- fail.`);
    }
  }
  const bodyClauses = [...clauses.entries()].map(([name, cs]) => cs.join('\n')).join('\n');
  return [...decls, ...out, bodyClauses, ...data].join('\n') + '\n';
}
