/**
 * The executor of ChatSOPAdapter: the product's engines over a scratch memory (core-min in a temporary repository). `run(sop,
 * literals)` executes one circuit as one Agent turn whose formalizer returns that circuit (the route every formalization takes:
 * admission, KnowledgeLinker, StrategyRouter, oracle verification, rendering) and returns the result packet with the rendered answer
 * text attached as `packet.answer_text`. The message of the turn lists the circuit's literals, so the validator's "a stated value is
 * mentioned" guard admits them: the circuits of the routed paths state the problem's own numbers (registry values), never other ones.
 *
 * A problem circuit brings its own vocabulary (session predicates), so a scratch memory answers it exactly as the chat's base memory
 * would; nothing of a problem is written to any memory (each circuit runs in a fresh session that is discarded).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** A scratch executor: {run(sop, literals) → packet, lexicon, dispose()}. `memory` overrides config/runtime.json's memory settings. */
export async function scratchExecutor({memory = null, lexiconName = 'core-min'} = {}) {
  const [{Repository}, {Agent}, {seedLexicon}] = await Promise.all([import('../../memory/repository.mjs'), import('../../server/agent.mjs'), import('../knowledge-seeds.mjs')]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatsop-adapter-'));
  const repo = new Repository(root, {memory: memory ?? JSON.parse(fs.readFileSync(path.join(ROOT, 'config/runtime.json'), 'utf8')).memory});
  repo.init('base');
  const lexicon = seedLexicon(lexiconName);
  let n = 0, disposed = false;
  const run = async (sop, literals = []) => {
    const session = repo.session('base', 'pl', `c${++n}`);
    try {
      const message = `values: ${[...new Set(literals.map(String))].join(' ; ') || 'none'}`;
      const r = await new Agent({repo, session, lexicon, config: {}}).turn(message, {language: 'en', formalizer: {formalize: async () => sop}});
      return r.packet ? Object.assign(r.packet, {answer_text: r.text ?? null}) : {status: 'error', error: 'no packet'};
    } catch (error) { return {status: 'error', error: error.message}; }
    finally { try { repo.discard(session); } catch { /* gone */ } }
  };
  const dispose = () => { if (!disposed) { disposed = true; fs.rmSync(root, {recursive: true, force: true}); } };
  return {run, lexicon, dispose};
}

/** The values a packet answers: the first binding value of each answer row. */
export const packetValues = packet => (packet?.answers ?? []).map(a => Object.values(a.binding ?? a)[0]).filter(v => v !== undefined);
