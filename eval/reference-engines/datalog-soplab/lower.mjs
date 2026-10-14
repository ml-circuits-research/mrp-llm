/**
 * Lowering of the compiled core to soplab's controlled natural language (`@id claim`, `@id rule`, `@id all`, `@id reduce`, `@id transition`,
 * `@id goal`; proposal 7.1, Datalog column). soplab parses it with its own parser (vendored).
 *
 *   fact holds p a            @fK claim  VALUE p a            fact holds not p a   VALUE NOT p a   (a separate sign of the relation)
 *   rule alternative          @rK rule  WHEN/AND atoms, NONE p ... (absent), TEST a op b, THEN [NOT] p ...
 *   aggregate (grouped)       an `all` wire for the distinct bindings of `over`, a `reduce` wire (GROUP, COUNT/SUM/MIN/MAX AS ?out) and a rule
 *   action                    @id transition  WHEN requires  REMOVE ...  ADD ...  COST n   (positive literals only)
 * Not lowered (`not_expressible`): `compute` (soplab has no arithmetic builtin), `collect`, an aggregate without `group` (soplab makes a group
 * for an empty relation, the oracle does not), several alternatives of one aggregate, ordering over text, negative literals in actions.
 * A symbol is written bare when soplab reads it back as the same string, otherwise quoted (`true`, `false`, `null` and numeric-looking text are quoted).
 */
import {isVarTerm, NotExpressibleError} from '../../../reasoning/strategies/js-reference/values.mjs';

const OPS = {above: '>', below: '<', at_least: '>=', at_most: '<=', equal: '==', not_equal: '!='};
const BARE = /^[A-Za-z_][\w./:+-]*$/;

export const termText = t => {
  if (isVarTerm(t)) return t.var;
  if (typeof t === 'number') return String(t);
  return BARE.test(t) && !['true', 'false', 'null'].includes(t) ? t : JSON.stringify(t);
};

const atomText = (neg, p, args) => [neg ? 'NOT' : null, p, ...args.map(termText)].filter(x => x !== null).join(' ');

/** Condition lines of one alternative. `first` is the keyword of the first positive atom, `rest` the one of the later atoms. */
export function conditionLines(leaves, first = 'WHEN', rest = 'AND') {
  const out = [];
  let head = true;
  for (const l of leaves) {
    if (l.kind === 'atom' && l.mode === 'absent') out.push(`NONE ${atomText(false, l.p, l.args)}`);
    else if (l.kind === 'atom') { out.push(`${head ? first : rest} ${atomText(l.mode === 'not', l.p, l.args)}`); head = false; }
    else if (l.kind === 'compare') {
      if (!['equal', 'not_equal'].includes(l.word) && [l.left, l.right].some(t => !isVarTerm(t) && typeof t !== 'number')) throw new NotExpressibleError(['compare_on_text'], 'ordering over text is not available in soplab');
      out.push(`TEST ${termText(l.left)} ${OPS[l.word]} ${termText(l.right)}`);
    } else throw new NotExpressibleError([l.kind], `${l.kind} in a condition is not available in soplab`);
  }
  return out;
}

/** The knowledge part (claims, rules, aggregates) as soplab CNL. */
export function lowerProgram(program, facts) {
  const lines = [];
  facts.forEach((f, i) => lines.push(`@f${i} claim`, `VALUE ${atomText(f.neg, f.p, f.args)}`));
  let n = 0;
  for (const r of program.rules) {
    for (const alt of r.alts) {
      if (alt.leaves.some(l => l.kind === 'compute')) throw new NotExpressibleError(['compute_in_rules'], 'soplab has no arithmetic builtin');
      lines.push(`@r${n++} rule`, ...conditionLines(alt.leaves), `THEN ${atomText(r.head.neg, r.head.p, r.head.args)}`);
    }
  }
  for (const a of program.aggregates) {
    if (a.fn === 'collect') throw new NotExpressibleError(['collect'], 'aggregate collect is not lowered to soplab');
    if (!a.group.length) throw new NotExpressibleError(['aggregate_ungrouped'], 'an ungrouped aggregate over an empty relation differs in soplab (one group of zero rows)');
    if (a.alts.length !== 1) throw new NotExpressibleError(['aggregate_alternatives'], 'an aggregate with several alternatives is not lowered to soplab');
    const id = `agg_${a.id}`, vars = a.rowVars.join(' ');
    lines.push(`@${id}_rows all`, `GIVES ${vars}`, ...conditionLines(a.alts[0].leaves, 'MATCH', 'MATCH'));
    lines.push(`@${id} reduce`, `GIVES ${[...a.group, a.out].join(' ')}`, `FROM $${id}_rows ${vars}`, `GROUP ${a.group.join(' ')}`, `${a.fn.toUpperCase()}${a.fn === 'count' ? '' : ' ' + a.field} AS ${a.out}`);
    lines.push(`@${id}_rule rule`, `WHEN $${id} ${[...a.group, a.out].join(' ')}`, `THEN ${atomText(false, a.yields.p, a.yields.args)}`);
  }
  return lines.join('\n') + '\n';
}

/** Actions as transitions and the goal, for the planner (positive literals only; the oracle's polarity-explicit states are not lowered). */
export function lowerPlanning(program, goalAlts) {
  const lines = [];
  for (const a of program.actions) {
    for (const x of [...a.requires, ...a.adds, ...a.removes]) if (x.neg) throw new NotExpressibleError(['plan_polarity'], 'negative literals in actions are not lowered to soplab (its states are positive sets)');
    lines.push(`@${a.id} transition`, ...a.requires.map((x, i) => `${i === 0 ? 'WHEN' : 'AND'} ${atomText(false, x.p, x.args)}`));
    for (const x of a.removes) lines.push(`REMOVE ${atomText(false, x.p, x.args)}`);
    for (const x of a.adds) lines.push(`ADD ${atomText(false, x.p, x.args)}`);
    lines.push(`COST ${a.cost}`);
  }
  if (goalAlts.length !== 1) throw new NotExpressibleError(['plan_goal'], 'a goal with alternatives is not lowered to soplab');
  lines.push('@goal goal', ...conditionLines(goalAlts[0].leaves, 'WHERE', 'AND'));
  return lines.join('\n') + '\n';
}
