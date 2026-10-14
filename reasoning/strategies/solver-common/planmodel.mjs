/**
 * What the two planning encoders share: the reading of `action` wires into preconditions with oracle leaves, the Markov test for
 * the completeness proofs, and the packet built from the summary of a model (the same fields as the oracle's plan packet plus the
 * norm information of 8.4: `compliance`, `relaxed`, `obligations_triggered`, `used` with versions).
 */
import {orderLeaves} from '../js-reference/program.mjs';
import {isVarTerm, ProgramError, atomText} from '../js-reference/values.mjs';

/** Preconditions as oracle leaves: `not` over a closed fluent means absence, over an open fluent negative evidence. */
export function actionModel(program) {
  const closed = program.closed;
  const pre = a => ({kind: 'atom', mode: a.neg ? (closed.has(a.p) ? 'absent' : 'not') : 'pos', p: a.p, args: a.args});
  return program.actions.map(a => {
    const leaves = orderLeaves(a.requires.map(pre), a.id);
    for (const v of a.params) if (!leaves.bound.has(v)) throw new ProgramError('action_parameter_unbound', `parameter ${v} of ${a.id} is not bound by a positive precondition`, a.id);
    for (const e of [...a.adds, ...a.removes]) for (const t of e.args) if (isVarTerm(t) && !a.params.includes(t.var)) throw new ProgramError('unsafe_action', `an effect of ${a.id} uses a variable that is not a parameter`, a.id);
    return {...a, leaves: leaves.leaves};
  });
}

/**
 * A norm set is MARKOV when the violation of a step depends only on the state and the action of that step (a `forbid ... always`, a
 * `permit`): a plan can then be shortened to a loopless path without changing its violations, which is what the completeness proofs need.
 */
export const isMarkov = (norms, via) => !via.length && norms.every(n => n.modality === 'permit' || (n.modality === 'forbid' && n.qualifier.kind === 'always'));

/** The goal alternatives as ordered leaf lists. */
export const orderedGoal = goalAlts => goalAlts.map(alt => orderLeaves(alt, 'goal').leaves);

/**
 * The plan packet of a model summary m = {steps: [{action, params}], cost, softViol: [{id, cost}], obligations: [text], active: [norm ids]}.
 */
export function planPacket({m, actions, normById, relaxed = [], hard = 'ok', guarantee = 'exact', notes = []}) {
  const unscoped = [...new Set(m.obligations.map(o => o.split(' ')[0]))].filter(id => normById.get(id)?.standing);
  if (unscoped.length) notes = [...notes, 'obligation_unscoped'];
  const names = m.steps.map(s => s.action);
  const version = id => actions.find(a => a.id === id)?.source.version ?? 1;
  const used = [...new Map([...m.steps.map(s => [s.action, {id: s.action, version: version(s.action)}]), ...m.active.filter(id => normById.has(id)).map(id => [id, {id, version: normById.get(id).version}])]).values()];
  const sequence = m.steps.map(s => ({action: s.action, args: s.params.map(String), text: atomText(false, s.action, s.params)}));
  const soft = [...m.softViol].sort((a, b) => (a.id < b.id ? -1 : 1));
  return {
    status: 'plan_found', complete: true, guarantee, plan: {steps: names.length, cost: m.cost, names, sequence}, used,
    compliance: {hard, soft_violations: soft, total_cost: m.cost + soft.reduce((x, y) => x + y.cost, 0)},
    ...(relaxed.length ? {relaxed} : {}), ...(m.obligations.length ? {obligations_triggered: [...new Set(m.obligations)]} : {}), ...(unscoped.length ? {obligation_unscoped: unscoped} : {}), ...(notes.length ? {notes} : {})
  };
}

export const blockedPacket = ({by, normById, plan}) => ({
  status: 'blocked', complete: true, blocked_by: by, blocked: {norm: by[0], requirement: normById.get(by[0])?.message ?? null, plan}, guarantee: 'bounded', notes: ['blocked_within_horizon']
});

/** Can the optimum be certified by the cost bound? A plan of more than H steps costs at least (H + 1) times the cheapest action. */
export const costBoundProves = ({objective, H, minCost}) => minCost > 0 && objective <= (H + 1) * minCost;
