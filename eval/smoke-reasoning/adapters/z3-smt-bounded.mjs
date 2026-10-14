/**
 * Adapter for the product strategy `z3-smt-bounded` (reasoning/strategies/z3-smt-bounded/): the desugared core encoded for Z3 as completion over a finite domain and run by
* Z3 as a subprocess. The strategy parses the circuits itself; `conditional` is left to the harness (the same host rule
 * around every strategy). `used` is computed by the strategy's deletion method only for cases that state a support set, so the
 * harness replays it in the oracle.
 */
import {z3SmtBounded} from '../../../reasoning/strategies/z3-smt-bounded/index.mjs';
import {NotExpressibleError} from '../../../reasoning/strategies/js-reference/index.mjs';
import {NotExpressible} from './common.mjs';

export const z3SmtBoundedAdapter = {
  id: 'z3-smt-bounded', status: 'available', origin: 'reasoning/strategies/z3-smt-bounded/ (Z3 4.15.8 subprocess, private binary under tools/.solvers/z3)',
  description: 'Z3: two Booleans per ground atom, completion of non-recursive rules, bounded aggregates, arithmetic constraints and optimisation, abduction and why_not as cardinality-minimal choices, bounded planning with norms as violation Booleans; recursion is not expressible.',
  supports: new Set(z3SmtBounded.features),
  available: () => z3SmtBounded.available(),
  async run(c, ctx) {
    try {
      const packet = z3SmtBounded.ask({theory: {knowledge: c.knowledge}, query: c.query}, {}, {conditional: false, used: Boolean(c.expected.used_support)});
      ctx.packet = packet;
      return packet;
    } catch (e) {
      if (e instanceof NotExpressibleError) throw new NotExpressible(e.message);
      throw e;
    }
  }
};
