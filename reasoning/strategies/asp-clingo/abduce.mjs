/**
 * Abduction and why_not in ASP: a choice rule over the candidates, the goal as a constraint, `#minimize` over the number of chosen
 * candidates, and an iteration that blocks every superset of an explanation already found.
 *
 * Abduction returns ALL inclusion-minimal explanations: each round asks for a minimum-cardinality model among those that contain no
 * explanation found before. Such a model is inclusion-minimal (a proper subset that is an explanation would be a smaller model of the
 * same constraints, so the optimum would have chosen it), and the loop ends when nothing is left, so the set is complete.
 * (clingo's own `--enum-mode=domRec` gives subset-minimal models too; the iteration keeps the result independent of heuristics.)
 *
 * why_not returns the MINIMUM-CARDINALITY sets of base (EDB) atoms whose addition makes the goal derivable, over the constants of the
 * slice and the declared argument types (the oracle returns the inclusion-minimal sets of the nearest explanations; the two agree
 * whenever the nearest explanation is also a smallest one, as in every smoke case).
 */
import {runClingo, parseAtom, SolverStop} from './clingo.mjs';
import {closureProgram, lowerBody, rel, enc} from './lower.mjs';
import {atomText, isVarTerm, NotExpressibleError} from '../js-reference/values.mjs';
import {planFixedPoint} from '../solver-common/fixed-point.mjs';

/**
 * The closure of abduction and why_not is not run through the fixed-point rewriting of solver-common/fixed-point.mjs: a program with a
 * decimal number or an exact compute word is refused honestly (capability battery 2026-10-02: clingo rejected the unscaled program).
 */
function refuseDecimals(program, facts, goalAlts, what) {
  if (planFixedPoint({...program, facts}, goalAlts.map(alt => ({leaves: alt.leaves ?? alt})))) throw new NotExpressibleError(['exact_arithmetic'], `${what} over decimal numbers is not run by asp-clingo`);
}

const goalRules = goalAlts => goalAlts.map(alt => `goal :- ${lowerBody(alt.leaves ?? alt).join(', ') || '#true'}.`);

const sortExplanations = xs => xs.sort((a, b) => a.cost - b.cost || a.atoms.length - b.atoms.length || (a.atoms.join() < b.atoms.join() ? -1 : 1));

export function aspAbduce({program, facts, goalAlts, hypotheses, budget, limit = Infinity}) {
  refuseDecimals(program, facts, goalAlts, 'abduce');
  const cands = hypotheses;
  if (cands.length > budget.limits.maxHypotheses) return {status: 'budget_exhausted', complete: false, reason: 'hypotheses', budget: {...budget.snapshot(false), exhausted: true, reason: 'hypotheses'}};
  const {lines, shown} = closureProgram(program, facts);
  const base = [...lines, ...shown.lines()];
  const choice = cands.length ? `{ ${cands.map(c => `hyp(${enc(c.id)})`).join('; ')} }.` : '';
  const effects = cands.flatMap(c => c.atoms.map(a => `${rel(a.neg, a.p, a.args)} :- hyp(${enc(c.id)}).`));
  const found = [];
  try {
    for (;;) {
      const blocks = found.map(s => `:- ${s.length ? s.map(id => `hyp(${enc(id)})`).join(', ') : '#true'}.`);
      const text = [...base, choice, ...effects, ...goalRules(goalAlts), ':- not goal.', ...blocks, '#minimize { 1,H : hyp(H) }.', '#show hyp/1.'].join('\n') + '\n';
      const r = runClingo(text, {optMode: 'opt', timeoutMs: budget.limits.timeoutMs});
      if (r.interrupted) throw new SolverStop('wall');
      if (r.result === 'UNSAT') break;
      const chosen = r.witnesses.at(-1).atoms.map(parseAtom).map(a => a.args[0]);
      const set = cands.filter(c => chosen.includes(c.id)).map(c => c.id);
      found.push(set);
      if (!set.length) break; // true without any hypothesis: every other set contains it
    }
  } catch (e) {
    if (e instanceof SolverStop) return {status: 'budget_exhausted', complete: false, reason: e.reason, budget: {...budget.snapshot(false), exhausted: true, reason: e.reason}};
    throw e;
  }
  const byId = new Map(cands.map(c => [c.id, c]));
  const explanations = sortExplanations(found.map(s => ({hypotheses: s, atoms: s.flatMap(id => byId.get(id).atoms.map(a => atomText(a.neg, a.p, a.args))), cost: s.reduce((c, id) => c + byId.get(id).cost, 0)})));
  if (!explanations.length) return {status: 'unknown', complete: true, reason: 'no_explanation', hypotheses: [], explanations: []};
  const shownList = explanations.slice(0, limit);
  return {status: 'hypotheses', complete: shownList.length === explanations.length, hypotheses: shownList.map(e => e.atoms), explanations: shownList, ...(shownList.length < explanations.length ? {truncated: true} : {})};
}

/** Candidate EDB atoms: predicates that are not derived (or have stored facts), over the constants of the slice, by declared type. */
function candidateDomains(program, facts, goalAlts) {
  const derived = new Set([...program.rules.map(r => r.head.p), ...program.aggregates.map(a => a.yields.p)]);
  const hasFacts = new Set(facts.map(f => f.p));
  const abducible = p => !p.startsWith('x_') && (!derived.has(p) || hasFacts.has(p));
  const constants = new Set();
  for (const f of facts) f.args.forEach(a => constants.add(a));
  for (const r of program.rules) for (const t of r.head.args) if (!isVarTerm(t)) constants.add(t);
  const leafConstants = leaves => { for (const l of leaves) if (l.kind === 'atom') for (const t of l.args) if (!isVarTerm(t)) constants.add(t); };
  for (const r of program.rules) for (const alt of r.alts) leafConstants(alt.leaves);
  for (const alt of goalAlts) leafConstants(alt.leaves ?? alt);
  const preds = new Map();
  const see = (p, arity) => { if (!preds.has(p)) preds.set(p, arity); };
  for (const f of facts) see(f.p, f.args.length);
  for (const r of program.rules) for (const alt of r.alts) for (const l of alt.leaves) if (l.kind === 'atom') see(l.p, l.args.length);
  for (const a of program.aggregates) for (const alt of a.alts) for (const l of alt.leaves) if (l.kind === 'atom') see(l.p, l.args.length);
  return {abducible, constants: [...constants], preds};
}

export function aspWhyNot({program, facts, goalAlts, budget, limit = Infinity}) {
  refuseDecimals(program, facts, goalAlts, 'why_not');
  const {lines, shown} = closureProgram(program, facts);
  const {abducible, constants, preds} = candidateDomains(program, facts, goalAlts);
  const negUsed = new Set();
  const scan = leaves => { for (const l of leaves) if (l.kind === 'atom' && l.mode === 'not') negUsed.add(l.p); };
  for (const r of program.rules) for (const alt of r.alts) scan(alt.leaves);
  for (const alt of goalAlts) scan(alt.leaves ?? alt);
  for (const a of program.aggregates) for (const alt of a.alts) scan(alt.leaves);
  const typeOf = (p, i) => program.predicates.get(p)?.args[i]?.type;
  const doms = new Set(), rules = [], showAdds = [];
  for (const [p, arity] of preds) {
    if (!abducible(p) || !program.slice?.has(p)) continue;
    const vars = Array.from({length: arity}, (_, i) => `D${i}`);
    const tuple = name => (arity ? `${name}(${vars.join(',')})` : name);
    const domain = vars.map((d, i) => {
      const ty = typeOf(p, i);
      for (const c of constants) if (ty === 'integer' ? typeof c === 'number' : ty === 'entity' || ty === 'text' ? typeof c === 'string' : true) doms.add(`dom_${p}_${i}(${enc(c)}).`);
      return `dom_${p}_${i}(${d})`;
    });
    for (const neg of negUsed.has(p) ? [false, true] : [false]) {
      const add = `${neg ? 'addn_' : 'addp_'}${p}`;
      rules.push(`{ ${tuple(add)}${arity ? ' : ' + domain.join(', ') : ''} }.`);
      rules.push(`${tuple((neg ? 'neg_' : 'pos_') + p)} :- ${tuple(add)}.`);
      rules.push(`#minimize { 1,"${add}"${arity ? ',' + vars.join(',') : ''} : ${tuple(add)} }.`);
      showAdds.push(`#show ${add}/${arity}.`);
      shown.add(neg, p, arity, null);
    }
  }
  const text = [...lines, ...shown.lines(), ...showAdds, ...doms, ...rules, ...goalRules(goalAlts), ':- not goal.'].join('\n') + '\n';
  let r;
  try { r = runClingo(text, {optMode: 'optN', models: 0, timeoutMs: budget.limits.timeoutMs}); } catch (e) {
    if (e instanceof SolverStop) return {status: 'budget_exhausted', complete: false, reason: e.reason, budget: {...budget.snapshot(false), exhausted: true, reason: e.reason}};
    throw e;
  }
  if (r.interrupted) return {status: 'budget_exhausted', complete: false, reason: 'wall', budget: {...budget.snapshot(false), exhausted: true, reason: 'wall'}};
  if (r.result === 'UNSAT') return {complete: true, missing: [], blockers: []};
  const best = JSON.stringify(r.optimum);
  const sets = new Map();
  for (const w of r.witnesses.filter(x => JSON.stringify(x.costs) === best)) {
    const atoms = w.atoms.map(parseAtom).filter(a => /^add[pn]_/.test(a.name)).map(a => atomText(a.name.startsWith('addn_'), a.name.slice(5), a.args)).sort();
    sets.set(atoms.join('\u0000'), atoms);
  }
  const missing = [...sets.values()].sort((a, b) => a.length - b.length || (a.join() < b.join() ? -1 : 1));
  return {complete: missing.length <= limit, missing: missing.slice(0, limit), blockers: [], ...(missing.length > limit ? {truncated: true} : {})};
}
