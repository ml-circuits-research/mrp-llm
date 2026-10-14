/**
 * Slice retrieval and the completeness guard of the product path from memory to the reasoner (DS005, DS006 "Completeness under partial
 * retrieval", proposal section 11, rules R-P1 to R-P5).
 *
 *   retrieval.mjs  SliceRetrieval: demand-driven keyed lookups, incremental widening, the slice report
 *   demand.mjs     the join-propagation analysis that decides which lookups a question needs
 *   source.mjs     RepositorySource (memory strategies) and ArraySource (fixtures)
 *   guard.mjs      judge: which answers over a partial slice may be given
 *   answer.mjs     answerOverSlice: ask, judge, widen, report
 */
export {SliceRetrieval, SLICE_DEFAULTS, lookupPattern} from './retrieval.mjs';
export {Demand, alternatives, equalityDomains, bindDomains} from './demand.mjs';
export {RepositorySource, ArraySource, isExactCoverage} from './source.mjs';
export {judge, sensitivityOf} from './guard.mjs';
export {answerOverSlice, retrievalReport, MAX_WIDENING_STEPS} from './answer.mjs';
export {Theory, TheoryCache, askMemory, judgeWire, SLICED_MODES, termValue} from './wire.mjs';
