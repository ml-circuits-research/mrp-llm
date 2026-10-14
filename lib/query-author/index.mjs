/**
 * The query author library (DS022 "Formalization strategies"): what the step-by-step formalizers share: retrieval of the memory
 * vocabulary, its rendering, and the validator that admits a circuit. The one-shot author (the prompt/context builder, the
 * validate-and-repair loop `authorQuery` and the completion backend) was archived on 2026-10-02 (owner: formalization is step by step
 * only; probably_obsolete/one-shot-formalization/).
 */
export {renderVocabulary, renderCandidates, renderEntityHints, renderIndex} from './vocabulary.mjs';
export {candidatePredicates, entityHints, predicateRecall, nearestPredicates, CORE_PREDICATES, stem} from './retrieval.mjs';
export {validateQuery, unclearKind, defaultAdmit, AUTHOR_TYPES} from './validate.mjs';
