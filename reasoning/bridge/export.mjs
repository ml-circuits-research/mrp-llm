/**
 * Inspectable programs of the external backends (the `compile-prolog` and `compile-smt` commands of server/cli.mjs and the linker
 * demonstration): the SWI-Prolog program that the `prolog-tabling` strategy runs for typed facts and rules, and the SMT-LIB script
 * that `z3-smt-bounded` runs for a typed integer constraint. Nothing is executed here.
 */
import {compileProgram} from '../strategies/js-reference/program.mjs';
import {registry, programText} from '../strategies/prolog-tabling/codegen.mjs';
import {compile} from '../strategies/z3-smt-bounded/ast.mjs';
import {Program} from './reason.mjs';

/** The Prolog text for facts and rules; with `at`, only the facts valid at that instant. */
export function compileProlog(facts, rules, {at} = {}) {
  const prog = new Program(facts.map((f, i) => ({id: 'f' + i, valid: {from: -Infinity, until: Infinity}, ...(f.atom ? f : {atom: f})})), rules);
  const program = compileProgram([...prog.factWires, ...prog.ruleWires], {origin: new Map()});
  const view = at === undefined ? program.facts : program.facts.filter(f => f.valid === null || (f.valid.from <= at && at < f.valid.to));
  return programText({program, view, reg: registry(program, []), heights: null});
}

/** The SMT-LIB prefix (logic, declarations, requirements) and the claim of a typed constraint problem. */
export function compileSMT(problem) {
  const {term, decl} = compile(problem);
  const prefix = ['(set-logic QF_LIA)', ...decl, ...problem.constraints.map(c => `(assert ${term(c)})`)].join('\n') + '\n';
  return {prefix, claim: problem.claim === undefined ? null : term(problem.claim)};
}
