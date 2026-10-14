/**
 * Compatibility entry of the oracle's grammar: the parser, validator, governance and desugarer of the knowledge language now
 * live in `sop/knowledge/` (the single grammar source, DS004). Strategies import from here or from `sop/knowledge/index.mjs`.
 */
export * from '../../../sop/knowledge/index.mjs';
