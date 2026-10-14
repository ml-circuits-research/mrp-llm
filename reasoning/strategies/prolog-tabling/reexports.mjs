/**
 * The pieces of the js-reference front end that the Prolog strategies reuse unchanged (one place for the imports, so that the day
 * the grammar moves to `sop/` only this file changes).
 */
export {parse, tokens} from '../js-reference/wires.mjs';
export {conditionAlts, sliceProgram} from '../js-reference/program.mjs';
export {planQuery, combineParts} from '../js-reference/query.mjs';
export {timeParts, viewAt} from '../js-reference/timeview.mjs';
export {proofOf, usedOf, explainOf} from '../js-reference/support.mjs';
export {withConditional} from '../js-reference/conditional.mjs';
export {Budget, CEILINGS, BudgetStop} from '../js-reference/budget.mjs';
export {atomText} from '../js-reference/values.mjs';
