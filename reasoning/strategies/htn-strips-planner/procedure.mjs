/**
 * `mode procedure`: render the approved method for a task as of `asof`, without planning (proposal 8.4): the steps as written, the
 * version, and the norms in force. Most SOP questions want the text of the manual, not a plan, and an audit asks which version applied
 * on a date: only the methods in force at that date are candidates (the governance filter already applied by the context).
 */
import {unify} from '../js-reference/join.mjs';
import {isVarTerm} from '../js-reference/values.mjs';
import {stepLines} from '../modes/model.mjs';

export function procedureAnswer(ctx, goal) {
  const task = goal.single;
  if (!task) return {status: 'unknown', complete: true, reason: 'no_task', used: [], notes: ['procedure_needs_one_task_atom']};
  const wild = task.args.some(isVarTerm);
  const matching = ctx.methods.filter(m => m.achieves.p === task.p && m.achieves.terms.length === task.args.length && (wild || unify(m.achieves.terms, task.args, {}) !== null));
  if (!matching.length) return {status: 'unknown', complete: true, reason: 'no_procedure', used: []};
  matching.sort((a, b) => b.version - a.version || (a.id < b.id ? -1 : 1));
  const m = matching[0];
  const norms = ctx.norms.map(n => ({id: n.id, version: n.version, modality: n.modality, severity: n.severity, binding: n.binding}));
  return {
    status: 'procedure_found', complete: true,
    procedure: {id: m.id, version: m.version, binding: m.binding, steps: stepLines(m.wire), ...(m.onFailure ? {on_failure: m.onFailure.method ? '$' + m.onFailure.method : m.onFailure} : {}), norms},
    ...(matching.length > 1 ? {alternatives: matching.slice(1).map(x => ({id: x.id, version: x.version}))} : {}),
    used: [{id: m.id, version: m.version}]
  };
}
