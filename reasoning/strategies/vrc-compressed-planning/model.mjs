/**
 * The planning model of a numeric-action circuit: a finite logical state (ground flags, closed) times an exact-rational numeric
 * state, unit-cost actions with a relational part (requires, adds, removes) and a numeric part (guard, next), and a goal that
 * combines ground logical atoms and one numeric observation. Anything outside that fragment is `not_expressible`.
 */
import {parse, tokens, atomFrom, selectInForce} from '../../../sop/knowledge/index.mjs';
import {parseNumericAction, parseNumericGoal, stateVariables, NUMERIC_STATE_RELATION} from '../../../sop/knowledge/numeric-action.mjs';
import {ProgramError, NotExpressibleError} from '../js-reference/values.mjs';
import {Rat} from './vendor/vrc/rational.mjs';
import {Poly} from './vendor/vrc/poly.mjs';
import {astToPoly, guardPoly, OPERATOR} from './polynomial.mjs';

const f1 = (w, k) => w.fields.find(f => f.key === k);
const fAll = (w, k) => w.fields.filter(f => f.key === k);
const ALLOWED = new Set(['predicate', 'fact', 'action', 'policy', 'query', 'goal']);

/** A ground logical atom as {neg, key} (key `p a b`); throws NotExpressibleError for a variable. */
function groundAtom(text, where) {
  const a = atomFrom(tokens(text), {allowNeg: true});
  if (a.error) throw new ProgramError('bad_atom', `${a.error} in "${text}"`, where);
  if (a.terms.some(t => t.startsWith('?'))) throw new NotExpressibleError(['numeric_action'], `${where}: a numeric action is ground (no ?variables in its relational part)`);
  return {neg: a.neg === 'not', key: [a.p, ...a.terms].join(' ')};
}

export function readProgram(text, what) {
  const {wires, errors} = parse(text ?? '');
  if (errors.length) throw new ProgramError(errors[0].code, `${what}: ${errors[0].message} (line ${errors[0].line})`);
  return wires;
}

/** Build the model from knowledge wires (already read) and the query wire. */
export function buildModel(knowledgeWires, queryWires) {
  const wires = selectInForce(knowledgeWires, {asof: null, include: []});
  for (const w of wires) if (!ALLOWED.has(w.type)) throw new NotExpressibleError(['rules', w.type], `wire type ${w.type} is outside the numeric-planning fragment`);
  const q = queryWires.find(w => w.type === 'query');
  if (!q || (f1(q, 'mode')?.value.trim() ?? 'select') !== 'plan') throw new NotExpressibleError(['plan'], 'only mode plan is answered');
  const goal = parseNumericGoal(q);
  if (!goal) throw new NotExpressibleError(['numeric_action'], 'no numeric observation in the query');

  const variables = stateVariables(wires);
  if (!variables.length) throw new NotExpressibleError(['numeric_action'], 'no numeric action');
  const n = variables.length;
  const identity = variables.map((_, i) => Poly.variable(n, i));

  const actions = [];
  for (const w of wires.filter(x => x.type === 'action')) {
    if (tokens(f1(w, 'params')?.value ?? '').filter(t => t !== 'none').length) throw new NotExpressibleError(['numeric_action'], `${w.id}: parameters are not supported in a numeric plan`);
    if (f1(w, 'cost') && Number(f1(w, 'cost').value) !== 1) throw new NotExpressibleError(['numeric_action'], `${w.id}: only unit cost (a non-unit cost is rejected, never ignored)`);
    const num = parseNumericAction(w);
    const byVar = new Map(num.nexts.map(x => [x.variable, x.ast]));
    if (num.nexts.length && variables.some(v => !byVar.has(v))) throw new ProgramError('missing_next', `${w.id}: every state variable needs a next line`, w.id);
    actions.push({
      id: w.id,
      requires: fAll(w, 'requires').map(f => groundAtom(f.value, w.id)),
      adds: fAll(w, 'adds').map(f => groundAtom(f.value, w.id)),
      removes: fAll(w, 'removes').map(f => groundAtom(f.value, w.id)),
      T: num.nexts.length ? variables.map(v => astToPoly(byVar.get(v), variables)) : identity,
      guards: num.guards.map(g => guardPoly(g, variables))
    });
  }

  // initial state: logical atoms and the numeric facts `state ENTITY VAR VALUE` of the observed entity
  const logic = new Set(), values = new Map();
  for (const w of wires.filter(x => x.type === 'fact')) {
    const t = tokens(f1(w, 'holds').value);
    if (t[0] === 'not') throw new NotExpressibleError(['numeric_action'], 'negative facts are outside the numeric-planning fragment');
    if (t[0] === NUMERIC_STATE_RELATION && t.length === 4) {
      if (t[1] !== goal.entity) continue;
      if (values.has(t[2])) throw new ProgramError('duplicate_state', `two facts give ${goal.entity} ${t[2]} a value`, w.id);
      values.set(t[2], {rat: Rat.of(t[3]), claim: w.id});
    } else logic.add(groundAtom(f1(w, 'holds').value, w.id).key);
  }
  const missing = variables.filter(v => !values.has(v));

  const where = fAll(q, 'where').map(f => groundAtom(f.value, q.id));
  const horizonAsked = goal.horizon;
  return {
    variables, actions, logic, evidence: variables.map(v => values.get(v)?.claim).filter(Boolean), missing,
    initial: variables.map(v => values.get(v)?.rat),
    goal: {atoms: where, entity: goal.entity, op: OPERATOR[goal.word], H: astToPoly(goal.ast, variables), threshold: Rat.of(`${goal.threshold.n}/${goal.threshold.d}`)},
    horizon: horizonAsked, queryId: q.id,
    policy: Object.fromEntries([...wires, ...queryWires].filter(x => x.type === 'policy').flatMap(x => x.fields).map(f => [f.key, Number(f.value)]))
  };
}
