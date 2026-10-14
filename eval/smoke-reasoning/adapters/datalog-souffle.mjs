/**
 * Adapter for the product strategy `datalog-souffle` (reasoning/strategies/datalog-souffle/): the desugared core lowered to
 * Soufflé 2.5. It lowers nothing itself: the strategy parses the circuits, applies governance and desugaring, and runs the engine.
 * `conditional` is left to the harness (the same host rule around every strategy), `used` to the harness' deletion method.
 */
import {datalogSouffle, NotExpressibleError} from '../../../reasoning/strategies/datalog-souffle/index.mjs';
import {NotExpressible} from './common.mjs';

export const datalogSouffleAdapter = {
  id: 'datalog-souffle', status: 'available', origin: 'reasoning/strategies/datalog-souffle/ (Soufflé 2.5 subprocess, private build under tools/.solvers/souffle)',
  description: 'Soufflé: two relations per predicate, stratified negation, 32-bit arithmetic with overflow guards, set-semantics aggregates; select, exists and count pushed into the program; wall-clock timeout.',
  supports: new Set(datalogSouffle.features),
  available: () => datalogSouffle.available(),
  async run(c, ctx) {
    try {
      const packet = datalogSouffle.ask({theory: {knowledge: c.knowledge}, query: c.query}, {}, {conditional: false});
      ctx.packet = packet;
      return packet;
    } catch (e) {
      if (e instanceof NotExpressibleError) throw new NotExpressible(e.message);
      throw e;
    }
  }
};
