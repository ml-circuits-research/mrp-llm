/**
 * Adapter of the product strategy `reasoning/strategies/worlds-sopr/` (vendored sop-r engine). The base engine is cached per knowledge
 * text, so the host's conditional lowering (one run per assumption: full, leave-one-out, observed, verification) is asked as sibling
 * WORLDS of one base: the fact wires of the query circuit are the hypothetical additions of the world.
 */
import {worldsSopr as strategy, NotExpressibleError} from '../../../reasoning/strategies/worlds-sopr/index.mjs';
import {NotExpressible} from './common.mjs';

const handles = new Map();

export const worldsSopr = {
  id: 'worlds-sopr', status: 'available', origin: 'reasoning/strategies/worlds-sopr/ (vendored sop-r engine)',
  description: 'sop-r copy-on-write hypothetical worlds with lazy cone saturation: many what-if queries over one base; closed-world engine, statements of arity 1 or 2.',
  supports: new Set(strategy.features),
  async available() { return strategy.available(); },
  run(c, ctx) {
    try {
      let handle = handles.get(c.knowledge);
      if (!handle) { handle = strategy.prepare(c.knowledge); handles.clear(); handles.set(c.knowledge, handle); }
      const packet = strategy.ask({handle, query: c.query});
      ctx.packet = packet;
      return packet;
    } catch (e) {
      if (e instanceof NotExpressibleError) throw new NotExpressible(e.message);
      throw e;
    }
  }
};
