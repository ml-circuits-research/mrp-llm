/**
 * Adapter for the product strategy `asp-clingo` (reasoning/strategies/asp-clingo/): the desugared core lowered to ASP and run by
 * clingo 5.8.2 as a subprocess. The strategy parses the circuits itself; `conditional` is left to the harness (the same host rule
 * around every strategy). `used` is computed by the strategy's deletion method only for cases that state a support set, so the
 * harness replays it in the oracle.
 */
import {aspClingo} from '../../../reasoning/strategies/asp-clingo/index.mjs';
import {NotExpressibleError} from '../../../reasoning/strategies/js-reference/index.mjs';
import {NotExpressible} from './common.mjs';

export const aspClingoAdapter = {
  id: 'asp-clingo', status: 'available', origin: 'reasoning/strategies/asp-clingo/ (clingo 5.8.2 subprocess, private binary under tools/.solvers/clingo)',
  description: 'clingo: polarity as two relations, absent as not, arithmetic and #count/#sum aggregates, defaults through the desugaring, abduction and why_not by choice rules and #minimize, bounded planning with norms as violation atoms.',
  supports: new Set(aspClingo.features),
  available: () => aspClingo.available(),
  async run(c, ctx) {
    try {
      const packet = aspClingo.ask({theory: {knowledge: c.knowledge}, query: c.query}, {}, {conditional: false, used: Boolean(c.expected.used_support)});
      ctx.packet = packet;
      return packet;
    } catch (e) {
      if (e instanceof NotExpressibleError) throw new NotExpressible(e.message);
      throw e;
    }
  }
};
