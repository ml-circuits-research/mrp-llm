/**
 * Wire text parser of the js-reference strategy. The implementation moved to `sop/knowledge/` (the single grammar source,
 * DS004); this module keeps the lexical exports the oracle's modules and the other strategies import.
 */
export {COMPARATORS, ARITHMETIC, ORDER_WORDS, ROLE_NAMES, LINK_KEYWORDS, MAX_ARITY, STEP_BLOCKS} from '../../../sop/knowledge/grammar.mjs';
export {ID, VAR, SYMBOL, INTEGER, NUMBER, REF, DATE, tokens, termError, parse, atomFrom, parseCondition, leaves} from '../../../sop/knowledge/lexical.mjs';
