/**
 * Adapter for the product strategy `htn-strips-planner` (reasoning/strategies/htn-strips-planner/): forward state-space search with
 * method decomposition, hard and soft norms, governance, `waive` abduction, procedure rendering, `check` and `conform`. Like the oracle's
 * adapter it lowers nothing: the knowledge and query circuits go to the strategy as text. A circuit it does not run (a relational mode)
 * is reported `not_expressible`, never weakened.
 */
import {htnStripsPlanner, NotExpressibleError} from '../../../reasoning/strategies/htn-strips-planner/index.mjs';
import {NotExpressible} from './common.mjs';

export const htnPlanner = {
  id: 'htn-strips-planner', status: 'available', origin: 'reasoning/strategies/htn-strips-planner/ (product strategy)',
  description: 'Forward state-space search over polarity-explicit states with method decomposition (choose, pick, any_order, optional, if/else, until max, on_failure, achieve), hard norms that prune and soft norms that cost, governance, waive abduction, procedure rendering, check and conform.',
  supports: new Set(htnStripsPlanner.features),
  async available() { return {ok: true}; },
  run(c, ctx) {
    try {
      const packet = htnStripsPlanner.ask({theory: {knowledge: c.knowledge}, query: c.query});
      ctx.packet = packet;
      return packet;
    } catch (e) {
      if (e instanceof NotExpressibleError) throw new NotExpressible(e.message);
      throw e;
    }
  }
};
