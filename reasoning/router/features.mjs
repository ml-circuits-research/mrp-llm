/**
 * The features of a circuit that the StrategyRouter chooses by (DS006 "Routing rules"): read from the SAME compiled program the
 * oracle and the wire engines compile (governance, supposed wires, desugaring of defaults and integrity, dependency slice of the
 * query), so a feature is never a second reading of the wires.
 *
 * `required` is the feature list in the vocabulary of the strategies' `capabilities` (`reasoning/strategies/*`); a strategy is
 * eligible only when it declares all of them and none of its `notExpressible`.
 */
import {selectInForce, supposedWireIds, desugar} from '../../sop/knowledge/index.mjs';
import {compileProgram, sliceProgram, conditionAlts} from '../strategies/js-reference/program.mjs';
import {ProgramError, NotExpressibleError} from '../strategies/js-reference/values.mjs';
import {planFixedPoint, maxScaled} from '../strategies/solver-common/fixed-point.mjs';

const f1 = (w, k) => w.fields.find(f => f.key === k);
const TIME_WORDS = ['at', 'during', 'overlaps', 'asof'];
/** Query modes of the relational readers; every other mode is a mode of work (plan, abduce, why_not, conform, procedure, effect). */
const READ_MODES = ['select', 'exists', 'count', 'every', 'explain'];
const MODES_OF_WORK = ['plan', 'abduce', 'why_not', 'conform', 'procedure', 'effect'];
/** Value forms are evaluated by the oracle after an eligible engine computes the relational core; interval forms need the typed runtime. */
const HOST_FORMS = ['compare', 'order', 'rank', 'filter', 'quantifier', 'except', 'measure', 'limit'];

/**
 * @param handle      {wires}: the knowledge wires (the slice) the engine would read
 * @param queryWires  the parsed query circuit (a `query` wire, optional `policy` and supposed `fact` wires)
 * @returns the features, or `{invalid: message}` when the circuit does not compile (the oracle then reports the error itself)
 */
export function circuitFeatures(handle, queryWires) {
  const query = queryWires.find(w => w.type === 'query');
  const f = {mode: null, query: Boolean(query), wires: handle.wires.length, facts: 0, rules: 0, aggregates: 0, defaults: 0, integrity: 0, recursion: false, nonlinear: false, naf: false,
    aggregate: false, exact_arithmetic: false, compute_in_recursion: false, count: false, every: false, temporal: false, host_forms: [], mode_of_work: false, proof: false, constraint: false, budgeted: queryWires.some(w => w.type === 'policy'), monotone: true, required: []};
  if (queryWires.some(w => w.type === 'constraint')) { f.constraint = true; f.mode_of_work = true; }
  f.mode = query ? (f1(query, 'mode')?.value.trim() ?? 'select') : null;
  if (!query) return {...f, required: f.constraint ? ['constraint'] : []};
  // candidates (Q-LANG-10): runs with wires that are not in force elsewhere, which only the oracle makes
  f.candidate = query.fields.some(x => x.key === 'candidate');
  f.defaults = handle.wires.filter(w => w.type === 'default').length;
  f.integrity = handle.wires.filter(w => w.type === 'integrity').length;
  f.temporal = TIME_WORDS.some(k => f1(query, k)) || handle.wires.some(w => w.type === 'fact' && f1(w, 'valid') && f1(w, 'valid').value.trim() !== 'timeless');
  f.host_forms = HOST_FORMS.filter(k => f1(query, k));
  f.mode_of_work = MODES_OF_WORK.includes(f.mode) || handle.wires.some(w => ['action', 'method', 'norm', 'procedure', 'hypothesis', 'amendment', 'trace', 'code', 'test'].includes(w.type));
  f.proof = f.mode === 'explain' || f.mode === 'why_not';
  f.count = f.mode === 'count';
  f.every = f.mode === 'every';
  if (f.mode_of_work) return finish(f);
  try {
    const supposed = supposedWireIds([query], handle.wires);
    const inForce = selectInForce(handle.wires, {asof: f1(query, 'asof')?.value.trim() ?? null, include: supposed});
    const {wires, origin} = desugar([...inForce, ...queryWires.filter(w => w.type === 'fact')]);
    const program = compileProgram(wires, {origin});
    const seeds = conditionAlts(query.fields.filter(x => ['where', 'scope'].includes(x.key)), query.id).flatMap(alt => alt.filter(l => l.kind === 'atom' || l.kind === 'timeof').map(l => l.p));
    const sliced = sliceProgram(program, seeds);
    const sp = sliced.program;
    f.facts = sp.facts.length;
    f.rules = sp.rules.length;
    f.aggregates = sp.aggregates.length;
    f.aggregate = sp.aggregates.length > 0;
    f.recursion = sp.strata.some(s => s.recursive);
    f.compute_in_recursion = sp.strata.some(s => s.arithmetic);
    // nonlinear recursion: a rule of a recursive stratum with two or more body atoms of its own stratum (dense joins, e.g. reach . reach)
    f.nonlinear = sp.strata.some(s => s.recursive && s.rules.some(r => r.alts.some(a => a.leaves.filter(l => l.kind === 'atom' && s.preds.has(l.p)).length >= 2)));
    const absent = alts => alts.some(a => a.leaves.some(l => l.kind === 'atom' && l.mode === 'absent'));
    const queryAlts = conditionAlts(query.fields.filter(x => ['where', 'scope'].includes(x.key)), query.id);
    // Exact arithmetic (DS004): a decimal number or a compute word beyond the integer ones. The fixed-point plan says whether the integer engines
    // can carry it exactly (`fixed_point`: scale, largest scaled constant, or the reason they cannot); the exact-rational engines always can.
    try {
      const plan = planFixedPoint(sp, queryAlts.map(leaves => ({leaves})));
      f.exact_arithmetic = Boolean(plan);
      if (plan) f.fixed_point = {ok: true, scale: plan.scale, flag: plan.flag, max_scaled: maxScaled(plan)};
    } catch (e) {
      if (!(e instanceof NotExpressibleError)) throw e;
      f.exact_arithmetic = true;
      f.fixed_point = {ok: false, reason: e.message};
    }
    f.naf = sp.rules.some(r => absent(r.alts)) || sp.aggregates.some(a => absent(a.alts)) || queryAlts.some(alt => alt.some(l => l.kind === 'atom' && l.mode === 'absent'));
    // monotone: a positive answer over a partial slice stays valid (the oracle's `sensitivity`, guard rule R-P1)
    f.monotone = !sp.edges.some(e => e.strict && sp.slice.has(e.to)) && !f.naf && !f.count && !f.every && !f1(query, 'rank');
  } catch (e) {
    if (e instanceof ProgramError || e instanceof NotExpressibleError) return {...finish(f), invalid: e.message};
    throw e;
  }
  return finish(f);
}

/** The `required` list: the strategy features this circuit needs beyond the always-present core (facts, rules, conjunction, select). */
function finish(f) {
  const r = new Set(['facts', 'rules']);
  if (f.mode) r.add(f.mode === 'explain' ? 'explain' : f.mode);
  if (f.recursion) r.add('recursion');
  if (f.naf) r.add('naf');
  if (f.aggregate) r.add('aggregate');
  if (f.exact_arithmetic) r.add('exact_arithmetic');
  if (f.compute_in_recursion) r.add('compute_in_recursion');
  if (f.defaults) r.add('default');
  if (f.integrity) r.add('integrity');
  if (f.temporal) r.add('temporal');
  if (f.proof) r.add('used');
  if (f.constraint) r.add('constraint');
  if (MODES_OF_WORK.includes(f.mode)) r.add(f.mode);
  if (f.candidate) r.add('candidate');
  return {...f, required: [...r]};
}

export const sensitivityFor = features => ({monotone: features.monotone});
