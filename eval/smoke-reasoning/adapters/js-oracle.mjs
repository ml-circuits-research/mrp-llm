/**
 * Adapter for the oracle `js-reference` (reasoning/strategies/js-reference/): the complete, deliberately naive implementation of the
 * proposed core, which is also the `reference` route of the runtime. Unlike the runtime it lowers nothing: it hands the knowledge and
 * query circuits of the case, as text, to the strategy, which parses them itself. The strategy declares its capabilities; a circuit that
 * needs a feature it declares unsupported is reported `not_expressible`, never weakened.
 *
 * The oracle has the `conform` capability: a query with `mode conform` and a trace is lowered to core rules and answered by the oracle
 * on the lowered program (reasoning/strategies/conform/, the former separate column `conform-core`, merged on 2026-10-01); every other
 * query goes to the oracle unchanged. The other modes of work (plans with methods, procedures) stay with the planner.
 */
import {conformCore, NotExpressibleError} from '../../../reasoning/strategies/conform/index.mjs';
import {NotExpressible} from './common.mjs';

export const jsOracle = {
  id: 'js-oracle', status: 'available', origin: 'reasoning/strategies/js-reference/ (the oracle and the runtime `reference` route), with the conform capability of reasoning/strategies/conform/',
  description: 'The complete naive oracle of the proposed core: four-valued evidence, NAF, aggregates, defaults, integrity, intervals, plan, all-minimal abduce, why_not, verified per-row conditional, used and proofs, honest budgets, the query forms of the host language, and conformance of a trace by lowering to core rules.',
  lowering: conformCore.lowering,
  supports: new Set(conformCore.features),
  async available() { return {ok: true}; },
  run(c, ctx) {
    try {
      const packet = conformCore.ask({theory: {knowledge: c.knowledge}, query: c.query});
      ctx.packet = packet;
      return packet;
    } catch (e) {
      if (e instanceof NotExpressibleError) throw new NotExpressible(e.message);
      throw e;
    }
  }
};
