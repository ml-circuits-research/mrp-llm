/**
 * The knowledge surface of SOP (DS004 "Knowledge wires"): the wires a coding agent or the owner writes from a source and that
 * the host stores as knowledge (`predicate`, `fact`, `rule`, `default`, `integrity`, `aggregate`, `constraint`, `action`,
 * `method`, `norm`, `procedure`, `amendment`, `argument`, `trace`, `goal`, `hypothesis`, `policy`), their governance, the query
 * modes and the arity, role and closed rules. One module graph, imported by the reasoning strategies, the smoke harness and the
 * wire help tests:
 *
 *   grammar.mjs         vocabularies and the wire-type table (the generated grammar tables of the docs)
 *   lexical.mjs         text parser: headers, fields, blocks, atoms, condition leaves
 *   validate*.mjs       per-wire and whole-program validator (`validateProgram`)
 *   cross-checks.mjs    types, closed-world warnings, governance, overrides, procedures, stratification
 *   governance.mjs      which wires are in force (`selectInForce`, `supposedWireIds`, `contestedIds`)
 *   desugar.mjs         `default` and `integrity` rewritten into core rules
 *
 * The model surface (what SymbolicLM emits) is not here: it stays in `sop/enums.mjs`, `sop/parser.mjs` and `sop/declarative.mjs`,
 * and the model-origin compiler rejects every knowledge wire.
 */
export * from './grammar.mjs';
export * from './lexical.mjs';
export {validateWires, validateProgram} from './validate.mjs';
export {crossChecks, negativeCycle} from './cross-checks.mjs';
export * from './governance.mjs';
export * from './desugar.mjs';
