/**
 * Warming of base memories at server start (DS009 "Warm memories", setting `server.warmMemories` of config/runtime.json).
 *
 * The first question over a base memory decodes its snapshot chain and builds the SQL view of each layer lazily (about 4 s for a
 * large memory, measured by the slice-path task). Doing that once at start moves the cost out of the first turn: the decoded
 * snapshots are shared by every repository of the process (memory/repository.mjs `SHARED`, keyed by snapshot id), so the session
 * repositories cloned from the base memory find them decoded. Read only: a temporary repository session is opened and closed.
 */
import {BASE_NAME} from '../lib/chat-data/memories.mjs';

/** @returns [{id, ms, layers, facts} | {id, skipped}] per requested id; a missing memory is skipped, never an error. */
export function warmMemories({memories, ids = []}) {
  const known = new Set(memories.list().map(m => m.id));
  return ids.map(id => {
    if (!known.has(id)) return {id, skipped: 'unknown base memory'};
    const t0 = performance.now();
    try {
      const repo = memories.repository(id);
      const session = repo.session(BASE_NAME, 'warmup', 'warmup-' + process.pid);
      try {
        const layers = repo.visible(session);
        // stats() opens the SQL database of each layer (the lazy rebuild); nothing is written
        const facts = layers.reduce((n, x) => n + (x.layer.stats().claims ?? x.layer.stats().receipts ?? 0), 0);
        return {id, ms: Math.round(performance.now() - t0), layers: layers.length, facts};
      } finally { repo.closeSession(session); }
    } catch (error) { return {id, skipped: String(error.message).slice(0, 120)}; }
  });
}
