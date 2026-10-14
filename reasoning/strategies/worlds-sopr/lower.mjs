/**
 * Lowering of the compiled core to sop-r text (the language of the vendored engine): statements are exactly three terms
 * `subject relation object`, so a relation of arity 2 is `a p b` and a relation of arity 1 is `a p x-unit`; arity 0 and arity 3 or
 * more are `not_expressible` (reification of arity above 3 is not done: the honest weak column of the proposal).
 * The engine is a closed-world engine: the host reads `refuted` from closed predicates exactly as the oracle does (`index.mjs`).
 * Declared unsupported (never weakened): classical negation, validity intervals, time, aggregates, `divided_by`, ordering words
 * over non-numbers are not checked here (sop-r compares strings lexicographically, the oracle returns false: documented limit).
 */
import {isVarTerm, NotExpressibleError} from '../js-reference/values.mjs';

export const UNIT = 'x-unit';
const OPS = {above: '>', below: '<', at_least: '>=', at_most: '<=', equal: '=', not_equal: '!='};
const ARITH = {plus: '+', minus: '-', times: '*'};
const ATOM = /^[a-z][a-z0-9_.-]*$/;

const decline = (features, message) => { throw new NotExpressibleError(features, `worlds-sopr: ${message}`); };

/** One ground value or variable as a sop-r token. The same value always yields the same token. */
export function tok(t) {
  if (isVarTerm(t)) return t.var;
  if (typeof t === 'number') return String(t);
  if (ATOM.test(t) && !/^-?\d+(\.\d+)?$/.test(t)) return t;
  return JSON.stringify(t);
}

/** The three terms of an atom of arity 1 or 2, or a refusal. */
export function triple(p, args) {
  if (args.length === 1) return [tok(args[0]), p, UNIT];
  if (args.length === 2) return [tok(args[0]), p, tok(args[1])];
  return decline(['zero_arity'], `a relation of arity ${args.length} (${p}) is not a three-term statement`);
}

const stmt = parts => parts.join(' ');

/** A body leaf as sop-r lines (`when`, `unless`, `test`, `let`). */
function leafLines(l) {
  switch (l.kind) {
    case 'atom':
      if (l.mode === 'not') return decline(['classical_negation'], 'explicit negation in a body');
      return [`  ${l.mode === 'absent' ? 'unless' : 'when'} ${stmt(triple(l.p, l.args))}`];
    case 'compare': return [`  test ${tok(l.left)} ${OPS[l.word]} ${tok(l.right)}`];
    case 'compute':
      if (!ARITH[l.word]) return decline(['compute_in_rules'], `${l.word} (sop-r divides exactly, the core truncates)`);
      return [`  let ${l.out} = ${tok(l.left)} ${ARITH[l.word]} ${tok(l.right)}`];
    default: return decline(['temporal'], `condition ${l.kind}`);
  }
}

/** The facts of a program as sop-r wires (one `say` per fact), chunked so wire names stay small. */
export function factsText(facts, chunk = 500) {
  const lines = [];
  for (let i = 0; i < facts.length; i += chunk) {
    lines.push(`@facts_${i / chunk} fact`);
    for (const f of facts.slice(i, i + chunk)) {
      if (f.neg) decline(['classical_negation'], 'a negative fact');
      if (f.valid !== null) decline(['temporal'], 'a fact with a validity interval');
      lines.push('  say ' + stmt(triple(f.p, f.args)));
    }
  }
  return lines.join('\n') + '\n';
}

/** The rules of a program as sop-r rule wires (one wire per alternative of a body). */
export function rulesText(program) {
  if (program.aggregates.length) decline(['aggregate'], 'aggregates are not lowered');
  const out = [];
  for (const r of program.rules) {
    if (r.head.neg) decline(['classical_negation'], 'a rule with a negative head');
    r.alts.forEach((alt, k) => {
      out.push(`@${r.id.replace(/[^A-Za-z0-9_-]/g, '_')}__${k} rule`);
      for (const l of alt.leaves) out.push(...leafLines(l));
      out.push(`  then ${stmt(triple(r.head.p, r.head.args))}`);
    });
  }
  return out.join('\n') + '\n';
}

/** The conjunction of one query alternative as `find` lines. `absent` becomes `not`. */
export function findLines(leaves) {
  const out = [];
  for (const l of leaves) {
    if (l.kind === 'atom' && l.mode === 'absent') out.push(`  not ${stmt(triple(l.p, l.args))}`);
    else out.push(...leafLines(l).map(x => x.replace(/^ {2}when /, '  match ')));
  }
  return out;
}

/** `assume` lines of facts added to a world. */
export const addLines = facts => facts.map(f => {
  if (f.neg) decline(['classical_negation'], 'a negative supposed fact');
  return `  add ${stmt(triple(f.p, f.args))}`;
});
