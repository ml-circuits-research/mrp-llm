/**
 * Adapter of the native closure template (`reasoning/strategies/closure-template/`), a router-rule component that passes the shadow
 * gate like a strategy. A circuit that is not a recognised closure with a bound argument is `not_expressible`.
 */
import {closureTemplate as strategy, NotExpressibleError} from '../../../reasoning/strategies/closure-template/index.mjs';
import {NotExpressible} from './common.mjs';

export const closureTemplate = {
  id: 'closure-template', status: 'available', origin: 'reasoning/strategies/closure-template/ (VRC reach template, soplab graph wire)',
  description: 'Router-rule component: a transitive-closure rule pair with a bound argument is answered by one BFS with a witness path.',
  supports: new Set(strategy.features),
  async available() { return strategy.available(); },
  run(c, ctx) {
    try {
      const packet = strategy.ask({theory: {knowledge: c.knowledge}, query: c.query});
      ctx.packet = packet;
      return packet;
    } catch (e) {
      if (e instanceof NotExpressibleError) throw new NotExpressible(e.message);
      throw e;
    }
  }
};
