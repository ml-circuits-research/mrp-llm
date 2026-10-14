/**
 * The relational core in ASP: the closure of a (non-recursive or recursive) STRATIFIED program is its unique stable model, so one
 * clingo call returns every positive and negative atom the oracle's naive evaluation derives. Brave and cautious reasoning coincide
 * here: with one model there is nothing to choose between. Statuses of a query are read from the oracle's reader over those atoms.
 *
 * How several stable models would map to statuses (they cannot occur in a stratified program, and `compileProgram` rejects the rest):
 *   supported = true in every model (cautious), unknown = true in some model only (brave but not cautious),
 *   refuted = the negative relation true in every model, both = the positive and negative relations both cautious.
 * The strategy never has to apply this mapping; it is the declared reading if an unstratified extension is ever added.
 */
import {runClingo, parseAtom, SolverStop} from './clingo.mjs';
import {closureProgram, sumsInRange} from './lower.mjs';
import {ProgramError} from '../js-reference/values.mjs';
import {planFixedPoint, scaleProgram, scaleFacts, fromScaled, inexactError, INEXACT} from '../solver-common/fixed-point.mjs';

export const atomsOf = witness => witness.atoms.map(parseAtom).flatMap(({name, args}) => {
  const m = /^(pos|neg)_(.+)$/.exec(name);
  return m ? [{neg: m[1] === 'neg', p: m[2], args}] : [];
});

export function aspClosure({program: original, facts: stored, budget}) {
  // exact decimals: the program is run as integers scaled by 10^S and the atoms are divided back (solver-common/fixed-point.mjs)
  const fx = planFixedPoint(original);
  const program = fx ? scaleProgram(original, fx, {narrow: true}) : original;
  const facts = fx ? scaleFacts(stored, fx) : stored;
  const decode = args => (fx ? args.map(a => (typeof a === 'number' ? fromScaled(a, fx.scale) : a)) : args);
  const {lines, shown} = closureProgram(program, facts);
  try {
    const r = runClingo([...lines, ...shown.lines()].join('\n') + '\n', {timeoutMs: budget.limits.timeoutMs});
    if (r.interrupted) return {atoms: [], exhausted: {reason: 'wall'}};
    if (r.result === 'UNSAT') throw new ProgramError('no_model', 'a stratified program has a model; the lowering produced none');
    if (!sumsInRange(program, r.witnesses.at(-1).atoms)) return {atoms: [], exhausted: {reason: 'numeric_range'}};
    const atoms = atomsOf(r.witnesses.at(-1));
    if (fx?.flag && atoms.some(a => a.p === INEXACT)) throw inexactError(fx);
    return {atoms: atoms.filter(a => a.p !== INEXACT).map(a => ({...a, args: decode(a.args)})), exhausted: null, ...(fx ? {notes: [`fixed_point_scale_${fx.scale}`]} : {})};
  } catch (e) {
    if (e instanceof SolverStop) return {atoms: [], exhausted: {reason: e.reason}};
    throw e;
  }
}
