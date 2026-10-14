/**
 * Norm wires (proposal 8.2) read into one model for the planning encoders of both solver strategies.
 *
 *   {id, version, modality: forbid|oblige|permit, pattern: {kind: 'action', name, args} | {kind: 'state', neg, p, args},
 *    alts: the `when` condition in disjunctive normal form (ordered leaves), qualifier: {kind, n?, ref?}, standing, severity,
 *    cost, binding, overrides: [ids], predicates: [names the norm reads]}
 *
 * Qualifiers: forbid always (default) | before ~b | after ~b | at_most_once; oblige sometime (default) | within N | always.
 * `oblige ... before ~b` / `after ~b` and a norm `priority` are not lowered by the solver strategies (`not_expressible`).
 */
import {tokens, atomFrom} from '../../../sop/knowledge/index.mjs';
import {conditionAlts, orderLeaves} from '../js-reference/program.mjs';
import {toTerm, isVarTerm, ProgramError, NotExpressibleError} from '../js-reference/values.mjs';

const f1 = (w, k) => w.fields.find(f => f.key === k);
const fAll = (w, k) => w.fields.filter(f => f.key === k);

export function parsePattern(text, wire) {
  const t = tokens(text);
  if (t[0]?.startsWith('~')) return {kind: 'action', name: t[0].slice(1), args: t.slice(1).map(toTerm)};
  const a = atomFrom(t, {allowNeg: true});
  if (a.error) throw new ProgramError('bad_atom', `${a.error} in "${text}"`, wire);
  return {kind: 'state', neg: a.neg === 'not', p: a.p, args: a.terms.map(toTerm)};
}

const varsOf = ts => ts.filter(isVarTerm).map(t => t.var);

function qualifierOf(w, modality) {
  const has = k => Boolean(f1(w, k));
  const found = ['always', 'sometime', 'at_most_once', 'within', 'before', 'after'].filter(has);
  if (found.length > 1) throw new ProgramError('qualifier_conflict', `a norm has at most one temporal qualifier, found ${found.join(', ')}`, w.id);
  const k = found[0] ?? (modality === 'forbid' ? 'always' : 'sometime');
  if (k === 'within') return {kind: 'within', n: Number(f1(w, 'within').value.trim())};
  if (k === 'before' || k === 'after') {
    const t = tokens(f1(w, k).value);
    if (!t[0]?.startsWith('~')) throw new ProgramError('bad_qualifier', `${k} needs an action reference ~name`, w.id);
    return {kind: k, ref: {name: t[0].slice(1), args: t.slice(1).map(toTerm)}};
  }
  return {kind: k};
}

export function parseNorms(wires, program) {
  const norms = [];
  for (const w of wires.filter(x => x.type === 'norm')) {
    const modality = ['forbid', 'oblige', 'permit'].find(k => f1(w, k));
    if (!modality) throw new ProgramError('norm_without_modality', 'a norm has one of forbid, oblige, permit', w.id);
    if (f1(w, 'priority') && Number(f1(w, 'priority').value) !== 0) throw new NotExpressibleError(['norm_priority'], 'norm priority is not lowered; use overrides');
    const pattern = parsePattern(f1(w, modality).value, w.id);
    const qualifier = qualifierOf(w, modality);
    if (modality === 'oblige' && ['before', 'after'].includes(qualifier.kind)) throw new NotExpressibleError(['oblige_order'], `oblige ${qualifier.kind} ~b is not lowered by the solver strategies`);
    const whenFields = fAll(w, 'when');
    const bound = new Set(modality === 'oblige' ? [] : varsOf(pattern.args));
    const alts = (whenFields.length ? conditionAlts(whenFields, w.id) : [[]]).map(a => orderLeaves(a, w.id, bound));
    if (modality === 'oblige' && !f1(w, 'standing')) {
      for (const a of alts) for (const v of varsOf(pattern.args)) if (!a.bound.has(v)) throw new ProgramError('unsafe_variable', `a variable of the oblige pattern of ${w.id} is bound by no when atom`, w.id);
    }
    const predicates = [...(pattern.kind === 'state' ? [pattern.p] : []), ...alts.flatMap(a => a.leaves.filter(l => l.kind === 'atom').map(l => l.p))];
    norms.push({
      id: w.id, version: Number(f1(w, 'version')?.value ?? 1), modality, pattern, alts: alts.map(a => ({leaves: a.leaves})), qualifier,
      standing: Boolean(f1(w, 'standing')), severity: f1(w, 'severity')?.value.trim() ?? 'hard', cost: Number(f1(w, 'cost')?.value ?? 0),
      binding: f1(w, 'binding')?.value.trim() ?? 'strict', overrides: fAll(w, 'overrides').map(f => f.value.trim().replace(/^\$/, '')), predicates
    });
  }
  const ids = new Set(norms.map(n => n.id));
  for (const n of norms) for (const o of n.overrides) if (!ids.has(o)) throw new ProgramError('overrides_unknown', `${n.id} overrides ${o}, which is not in force`, n.id);
  return norms;
}

/** `hypothesis` wires with `waive $norm`: the relaxation of a norm offered as a candidate assumption (8.4). */
export function parseWaivers(wires) {
  return wires.filter(w => w.type === 'hypothesis' && f1(w, 'waive')).map(w => ({id: w.id, norm: f1(w, 'waive').value.trim().replace(/^\$/, ''), cost: Number(f1(w, 'cost')?.value ?? 1)}));
}
