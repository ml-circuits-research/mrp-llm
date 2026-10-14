/**
 * Adapter for the product strategy `datalog-e10` (reasoning/strategies/datalog-e10/): the desugared core lowered to the vendored E10
 * engine (sop-verified-reasoner 0.3.0). Replaces the read-only adapter on the unpacked zip (`zip-e10.mjs`, kept as the legacy
 * `zip-datalog-e10` column only for a side-by-side comparison, not registered by default).
 */
import {datalogE10, NotExpressibleError} from '../../../reasoning/strategies/datalog-e10/index.mjs';
import {NotExpressible} from './common.mjs';

export const datalogE10Adapter = {
  id: 'datalog-e10', status: 'available', origin: 'reasoning/strategies/datalog-e10/ (vendored E10: semi-naive, greedy joins, magic sets, INCOMPLETE on budget overrun)',
  description: 'E10: bottom-up Datalog, stratified NONE, explicit negation as a separate relation, semi-naive, magic sets, INCOMPLETE (never a negative answer) on budget overrun. Vendored, plain Node.',
  supports: new Set(datalogE10.features),
  available: () => datalogE10.available(),
  async run(c, ctx) {
    try {
      const packet = datalogE10.ask({theory: {knowledge: c.knowledge}, query: c.query}, {}, {conditional: false});
      ctx.packet = packet;
      return packet;
    } catch (e) {
      if (e instanceof NotExpressibleError) throw new NotExpressible(e.message);
      throw e;
    }
  }
};
