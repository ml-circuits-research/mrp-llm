/**
 * Adapter for the `prolog-tabling` strategy (reasoning/strategies/prolog-tabling/): SLG resolution in the private SWI-Prolog.
 * It lowers nothing: the knowledge and query circuits go, as text, to the strategy, which compiles the desugared core to a tabled
 * Prolog program. A circuit that needs a feature the strategy declares unsupported is `not_expressible`, never weakened.
 */
import {prologTabling, NotExpressibleError} from '../../../reasoning/strategies/prolog-tabling/index.mjs';
import {NotExpressible} from './common.mjs';

export const prologTablingAdapter = {
  id: 'prolog-tabling', status: 'available', origin: 'reasoning/strategies/prolog-tabling/ (SWI-Prolog 9 tabling, private swipl)',
  description: 'SLG resolution with well-founded negation: two tabled predicates per relation, tnot for absent, arithmetic for compare and compute, findall aggregates, proofs by derivation height, why_not by an abductive meta-interpreter, all-minimal abduction, wall and probe budgets.',
  supports: new Set(prologTabling.features),
  available: async () => prologTabling.available(),
  run(c, ctx) {
    try {
      const packet = prologTabling.ask({theory: {knowledge: c.knowledge}, query: c.query});
      ctx.packet = packet;
      return packet;
    } catch (e) {
      if (e instanceof NotExpressibleError) throw new NotExpressible(e.message);
      throw e;
    }
  }
};
