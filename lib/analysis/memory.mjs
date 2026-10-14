/**
 * The analysis library as a base memory: `ensureAnalysisMemory(memories)` creates the seed memory analysis-core-v1 (and the seeds it
 * imports) in a chat data root that lacks it, exactly as the server's seed step does (lib/knowledge-seeds.mjs ensureSeedMemories), but
 * only for that library, so a job or a tool can start a session on it without creating every seed.
 */
import {seedOrder, seedInfo, seedCircuits} from '../knowledge-seeds.mjs';

export const ANALYSIS_LIBRARY = 'analysis-core-v1';

export function ensureAnalysisMemory(memories, {id = ANALYSIS_LIBRARY, strategy} = {}) {
  const have = new Set(memories.list().map(m => m.id));
  const created = [];
  for (const seed of seedOrder([id])) {
    if (have.has(seed)) continue;
    const info = seedInfo(seed);
    memories.create({id: seed, name: info.name, description: info.description, imports: info.imports ?? [], ...(strategy ? {strategy} : {})});
    memories.addKnowledge(seed, {circuits: seedCircuits(seed).map(({name, text}) => ({name, text})), approvedBy: 'seed', reason: `seed ${seed} (config/knowledge/${seed})`, source: `config/knowledge/${seed}`});
    created.push(seed);
  }
  return {id, created};
}
