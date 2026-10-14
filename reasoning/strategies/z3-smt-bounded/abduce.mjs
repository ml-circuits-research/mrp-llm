/**
 * Abduction and why_not in Z3: a Boolean per candidate, the goal as an assertion over the completion, and a cardinality objective.
 *
 * Abduction returns ALL inclusion-minimal explanations: each round minimises the number of chosen hypotheses among the models that
 * contain no explanation found before (supersets are blocked), so every model found is inclusion-minimal and none is missed.
 * why_not returns the minimum-cardinality sets of fresh EDB literals whose addition derives the goal (MaxSAT over the candidate
 * literals: the optimum is found by `minimize`, the other optimal sets by blocking, with the cardinality fixed).
 */
import {Grounder} from './ground.mjs';
import {runZ3, valuesOf, intOf, SolverStop} from './z3.mjs';
import {candidateAtoms} from '../solver-common/candidates.mjs';
import {atomText} from '../js-reference/values.mjs';

const card = vars => `(+ 0 ${vars.map(v => `(ite ${v} 1 0)`).join(' ')})`;
const sortExplanations = xs => xs.sort((a, b) => a.cost - b.cost || a.atoms.length - b.atoms.length || (a.atoms.join() < b.atoms.join() ? -1 : 1));

function freeGround(program, facts, choices, budget) {
  const g = new Grounder(program, facts, {free: true, timeoutMs: budget.limits.timeoutMs});
  for (const f of facts) g.addFact(f);
  choices.forEach(c => g.addChoice(c.neg, c.p, c.args, c.v));
  g.run();
  return g;
}

const exhausted = (budget, reason) => ({status: 'budget_exhausted', complete: false, reason, budget: {...budget.snapshot(false), exhausted: true, reason}});

export function z3Abduce({program, facts, goalAlts, hypotheses, budget, limit = Infinity}) {
  if (hypotheses.length > budget.limits.maxHypotheses) return exhausted(budget, 'hypotheses');
  const choices = hypotheses.flatMap((h, i) => h.atoms.map(a => ({neg: a.neg, p: a.p, args: a.args, v: `h${i}`})));
  const vars = hypotheses.map((_, i) => `h${i}`);
  try {
    const g = freeGround(program, facts, choices, budget);
    const base = [...vars.map(v => `(declare-const ${v} Bool)`), ...g.declarations(), ...g.assertions(), `(assert ${g.goalFormula(goalAlts)})`];
    const found = [];
    for (;;) {
      const blocks = found.map(s => `(assert (not (and true ${s.map(i => vars[i]).join(' ')})))`);
      const script = [...base, ...blocks, `(minimize ${card(vars)})`, '(check-sat)', vars.length ? `(get-value (${vars.join(' ')}))` : ''].join('\n') + '\n';
      const r = runZ3(script, {timeoutMs: budget.limits.timeoutMs});
      if (r.interrupted) throw new SolverStop('wall');
      if (r.results[0] === 'unsat') break;
      if (r.results[0] !== 'sat') throw new SolverStop('wall');
      const values = valuesOf(r.results[1]);
      const set = vars.map((v, i) => (values.get(v) === 'true' ? i : -1)).filter(i => i >= 0);
      found.push(set);
      if (!set.length) break;
    }
    const explanations = sortExplanations(found.map(s => ({
      hypotheses: s.map(i => hypotheses[i].id), atoms: s.flatMap(i => hypotheses[i].atoms.map(a => atomText(a.neg, a.p, a.args))), cost: s.reduce((c, i) => c + hypotheses[i].cost, 0)
    })));
    if (!explanations.length) return {status: 'unknown', complete: true, reason: 'no_explanation', hypotheses: [], explanations: []};
    const shown = explanations.slice(0, limit);
    return {status: 'hypotheses', complete: shown.length === explanations.length, hypotheses: shown.map(e => e.atoms), explanations: shown, ...(shown.length < explanations.length ? {truncated: true} : {})};
  } catch (e) {
    if (e instanceof SolverStop) return exhausted(budget, e.reason);
    throw e;
  }
}

export function z3WhyNot({program, facts, goalAlts, budget, limit = Infinity}) {
  const {atoms, truncated} = candidateAtoms(program, facts, goalAlts, {maxCandidates: budget.limits.maxCandidates});
  if (truncated) return exhausted(budget, 'candidates');
  const choices = atoms.map((a, i) => ({...a, v: `c${i}`}));
  const vars = choices.map(c => c.v);
  try {
    const g = freeGround(program, facts, choices, budget);
    const base = [...vars.map(v => `(declare-const ${v} Bool)`), ...g.declarations(), ...g.assertions(), `(assert ${g.goalFormula(goalAlts)})`];
    const first = runZ3([...base, `(minimize ${card(vars)})`, '(check-sat)', `(get-value (${vars.length ? card(vars) : '0'}))`].join('\n') + '\n', {timeoutMs: budget.limits.timeoutMs});
    if (first.interrupted) throw new SolverStop('wall');
    if (first.results[0] === 'unsat') return {complete: true, missing: [], blockers: []};
    if (first.results[0] !== 'sat') throw new SolverStop('wall');
    const k = intOf([...first.results[1]][0][1]);
    const sets = [];
    for (;;) {
      const blocks = sets.map(s => `(assert (not (and true ${s.map(i => vars[i]).join(' ')})))`);
      const r = runZ3([...base, `(assert (= ${card(vars)} ${k}))`, ...blocks, '(check-sat)', vars.length ? `(get-value (${vars.join(' ')}))` : ''].join('\n') + '\n', {timeoutMs: budget.limits.timeoutMs});
      if (r.interrupted) throw new SolverStop('wall');
      if (r.results[0] === 'unsat') break;
      const values = valuesOf(r.results[1]);
      sets.push(vars.map((v, i) => (values.get(v) === 'true' ? i : -1)).filter(i => i >= 0));
      if (!sets.at(-1).length) break;
      if (sets.length > 256) break;
    }
    const texts = sets.map(s => s.map(i => atomText(choices[i].neg, choices[i].p, choices[i].args)).sort()).sort((a, b) => a.length - b.length || (a.join() < b.join() ? -1 : 1));
    return {complete: texts.length <= limit, missing: texts.slice(0, limit), blockers: [], ...(texts.length > limit ? {truncated: true} : {})};
  } catch (e) {
    if (e instanceof SolverStop) return exhausted(budget, e.reason);
    throw e;
  }
}
