/**
 * Adapter for the `golog-swi` strategy (reasoning/strategies/golog-swi/): a Golog interpreter in the private SWI-Prolog for the strict
 * procedures (methods) of the modes of work. It lowers nothing: the circuits go, as text, to the strategy. A circuit it does not
 * cover (blind planning, a relational mode) is `not_expressible`, never weakened.
 */
import {gologSwi, NotExpressibleError} from '../../../reasoning/strategies/golog-swi/index.mjs';
import {NotExpressible} from './common.mjs';

export const gologSwiAdapter = {
  id: 'golog-swi', status: 'available', origin: 'reasoning/strategies/golog-swi/ (Golog interpreter, private swipl)',
  description: 'Methods as Golog programs (choice, tests, bounded loops, sub-tasks), norms as tests on the primitive actions of a run, conformance of a trace to the strict procedures, procedure rendering; no blind planning.',
  supports: new Set(gologSwi.features),
  available: async () => gologSwi.available(),
  run(c, ctx) {
    try {
      const packet = gologSwi.ask({theory: {knowledge: c.knowledge}, query: c.query});
      ctx.packet = packet;
      return packet;
    } catch (e) {
      if (e instanceof NotExpressibleError) throw new NotExpressible(e.message);
      throw e;
    }
  }
};
