/** The runtime's view of the oracle: Horn deduction (`reason`), the closure the controllers search with, and the lowering. */
export {reason, evaluate as evaluateTyped, admissibleAssumptions, spanValue, Program} from './reason.mjs';
export {closure, evaluate} from './closure.mjs';
export {quantifiedStatus, numericValue} from '../strategies/js-reference/forms.mjs';
export {Lowering} from './lower.mjs';
