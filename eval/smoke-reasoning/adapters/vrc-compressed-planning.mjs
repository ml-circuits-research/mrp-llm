/**
 * Adapter of the product strategy `reasoning/strategies/vrc-compressed-planning/` (vendored VRC kernel, numeric action E2).
 * The harness runs it with learning on demand and the shadow option, so every smoke answer is the compressed search compared with
 * the uncompressed exact search (a disagreement would revoke the artifact and fail the case).
 */
import {vrcCompressedPlanning as strategy, NotExpressibleError} from '../../../reasoning/strategies/vrc-compressed-planning/index.mjs';
import {NotExpressible} from './common.mjs';

export const vrcCompressedPlanning = {
  id: 'vrc-compressed-planning', status: 'available', origin: 'reasoning/strategies/vrc-compressed-planning/ (vendored vrc03r kernel)',
  description: 'Exact-rational numeric planning: BFS over (flags, rational state) with certified state compression, shadow-checked against the full search, plans replayed in the original laws.',
  supports: new Set(strategy.features),
  async available() { return strategy.available(); },
  run(c, ctx) {
    try {
      const handle = strategy.prepare(c.knowledge, {learning: 'on-demand', query: c.query});
      const packet = strategy.ask({handle, query: c.query}, {}, {shadow: true});
      ctx.packet = packet;
      return packet;
    } catch (e) {
      if (e instanceof NotExpressibleError) throw new NotExpressible(e.message);
      throw e;
    }
  }
};
