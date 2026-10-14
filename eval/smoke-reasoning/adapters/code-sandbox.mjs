/**
 * Adapter of the `code-sandbox` strategy (reasoning/strategies/code-sandbox/): runs the `code` wire of the case on its `test` wires in a worker thread and
 * answers verified, failed or budget_exhausted. It is not a reasoning engine: it declares only the feature `code_sandbox`, so every other strategy reports
 * these cases (85 to 89) as not expressible and this adapter reports every other case as not expressible. `raw`: the harness adds no conditional re-runs,
 * closed-world policy or retrieval widening, because the sandbox gives the final answer itself.
 */
import {codeSandbox, NotExpressibleError} from '../../../reasoning/strategies/code-sandbox/index.mjs';
import {NotExpressible} from './common.mjs';

export const codeSandboxAdapter = {
  id: 'code-sandbox', status: 'available', raw: true, timeoutMs: 30000,
  origin: 'reasoning/strategies/code-sandbox/ (worker_threads + vm context; JavaScript)',
  description: 'Verifier of the programming path: runs a code wire on test wires with wall, memory and per-test limits and returns verified (guarantee bounded), failed or budget_exhausted with a closed-fact trace.',
  supports: new Set(codeSandbox.features),
  async available() { return codeSandbox.available(); },
  async run(c, ctx) {
    try {
      const packet = await codeSandbox.ask({code: c.knowledge, tests: c.knowledge}, {wallMs: 5000, perTestMs: 800, heapMb: 128});
      ctx.packet = packet;
      return packet;
    } catch (e) {
      if (e instanceof NotExpressibleError) throw new NotExpressible(e.message);
      throw e;
    }
  }
};
