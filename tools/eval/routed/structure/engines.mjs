/**
 * The product's engines over a scratch memory, for evaluation: ChatSOPAdapter's executor (lib/adapter/executor.mjs), shared by the
 * harnesses of one process. `run(sop, literals)` → the result packet of one Agent turn whose formalizer returns the given circuit.
 * Evaluation harness only.
 */
import {scratchExecutor} from '../../../../lib/adapter/executor.mjs';

let world = null;

export async function engines() {
  if (world) return world;
  const x = await scratchExecutor();
  world = {run: x.run, lexicon: x.lexicon, dispose: () => { x.dispose(); world = null; }};
  return world;
}
