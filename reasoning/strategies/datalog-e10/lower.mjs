/**
 * Lowering of the compiled core to the E10 dialect (`@name facts`, `@name rule`, `@name query` wires; proposal 7.1, Datalog column).
 *
 *   fact holds p a            FACT p a            fact holds not p a   FACT NOT p a   (relation `negative:p`, a separate relation)
 *   rule alternative          @rK rule  WHEN/AND atoms, NONE p ... (absent, stratified), TEST a op b (compare), THEN [NOT] p ...
 *   query alternatives        @q query  GIVES ?v ...  MATCH/AND ... with `OR MATCH ...` between the alternatives
 * E10 has no arithmetic terms, no decimal numbers and no aggregate: `compute` and `aggregate` are not lowered (`not_expressible`).
 * A symbol is written bare when E10 reads it back as the same string, otherwise quoted (the booleans `true`/`false` are quoted: E10
 * would read them as booleans); an integer is written bare.
 */
import {isVarTerm, NotExpressibleError} from '../js-reference/values.mjs';

const OPS = {above: '>', below: '<', at_least: '>=', at_most: '<=', equal: '==', not_equal: '!='};
const BARE = /^[A-Za-z_][\w.:/-]*$/;

export const termText = t => {
  if (isVarTerm(t)) return t.var;
  // E10 reads integers only: a decimal constant is refused honestly (capability battery, 2026-10-02: it crashed with "Invalid constant")
  if (typeof t === 'number') { if (!Number.isInteger(t)) throw new NotExpressibleError(['exact_arithmetic'], 'E10 has no decimal numbers (' + t + ')'); return String(t); }
  return BARE.test(t) && t !== 'true' && t !== 'false' ? t : JSON.stringify(t);
};

const atomText = (neg, p, args) => [neg ? 'NOT' : null, p, ...args.map(termText)].filter(x => x !== null).join(' ');

/** Condition lines of one alternative: the first positive atom starts with `first`, later atoms with AND. */
export function conditionLines(leaves, first = 'WHEN') {
  const out = [];
  let started = false;
  for (const l of leaves) {
    if (l.kind === 'atom' && l.mode === 'absent') out.push(`NONE ${atomText(Boolean(l.negRel), l.p, l.args)}`);
    else if (l.kind === 'atom') { out.push(`${started ? 'AND' : first} ${atomText(l.mode === 'not', l.p, l.args)}`); started = true; }
    else if (l.kind === 'compare') {
      if (!['equal', 'not_equal'].includes(l.word) && [l.left, l.right].some(t => !isVarTerm(t) && typeof t !== 'number')) throw new NotExpressibleError(['compare_on_text'], 'ordering over text is not available in E10 (TEST needs integers)');
      out.push(`TEST ${termText(l.left)} ${OPS[l.word]} ${termText(l.right)}`);
    } else throw new NotExpressibleError([l.kind], `${l.kind} in a condition is not available in E10`);
  }
  return out;
}

/** Facts and rules of a program as E10 text; `compute` and aggregates are refused. */
export function lowerProgram(program, facts) {
  if (program.aggregates.length) throw new NotExpressibleError(['aggregate'], 'E10 has no aggregate');
  const lines = ['@facts facts'];
  for (const f of facts) lines.push(`FACT ${atomText(f.neg, f.p, f.args)}`);
  let n = 0;
  for (const r of program.rules) {
    for (const alt of r.alts) {
      if (alt.leaves.some(l => l.kind === 'compute')) throw new NotExpressibleError(['compute_in_rules'], 'E10 has no arithmetic terms');
      lines.push('', `@r${n++} rule`, ...conditionLines(alt.leaves), `THEN ${atomText(r.head.neg, r.head.p, r.head.args)}`);
    }
  }
  return lines.join('\n') + '\n';
}

/** A query wire over the alternatives of a `where` part, projecting `vars` (alternatives are joined by OR). */
export function queryText(name, alts, vars, extraLeaves = () => []) {
  const lines = [`@${name} query`, `GIVES ${vars.join(' ')}`.trim()];
  alts.forEach((alt, i) => {
    const body = conditionLines([...alt.leaves, ...extraLeaves(alt)], 'MATCH');
    lines.push(...(i === 0 ? body : [`OR ${body[0]}`, ...body.slice(1)]));
  });
  return lines.join('\n') + '\n';
}
