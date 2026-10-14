/**
 * Adapters for the BASELINE strategy `llm-agent` (reasoning/strategies/llm-agent/): an LLM called through Ploinky Workers that works through the problem.
 * Two variants, `llm-agent-sop` (the knowledge and query circuits as SOP text with the semantics attached) and `llm-agent-nl` (the
 * natural-language `source.md` of the case; cases without one are not expressible for it). Both are registered but run ONLY when
 * `SMOKE_LLM=1` is set, so the default smoke stays free and deterministic. The model is `LLM_AGENT_MODEL` (default: config/llm-agent.json).
 *
 * Its answers are advisory: the harness compares them with the oracle, they are never ground truth. The adapter is `raw`: the harness does not
 * wrap it in the two-run conditional list, the closed-world policy or the retrieval widening, because the model is asked for the final answer itself
 * (wrapping would repair or multiply its answers and mask its errors). On retrieval cases it sees the needed slice, not the distractors (perfect retrieval).
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {llmAgent, NotExpressibleError} from '../../../reasoning/strategies/llm-agent/index.mjs';
import {NotExpressible} from './common.mjs';

const casesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../cases');

export const sourceOf = dir => { const f = path.join(casesRoot, dir, 'source.md'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null; };

const variant = presentation => ({
  id: 'llm-agent-' + presentation, status: 'available', raw: true, advisory: true, timeoutMs: 180000,
  origin: 'reasoning/strategies/llm-agent/ (an LLM through Ploinky Workers; baseline, advisory answers)',
  description: presentation === 'sop'
    ? 'Baseline: an LLM reads the knowledge and query circuits as SOP text with the language semantics and answers in the packet shape. Advisory, never ground truth. Runs only with SMOKE_LLM=1.'
    : 'Baseline: an LLM reads the natural-language source text of the case (source.md) and answers in the packet shape. Advisory, never ground truth. Runs only with SMOKE_LLM=1.',
  supports: new Set(llmAgent.features),
  async available() {
    if (process.env.SMOKE_LLM !== '1') return {ok: false, reason: 'set SMOKE_LLM=1 to run the LLM baseline (it calls a model through Ploinky Workers)'};
    return llmAgent.available();
  },
  async run(c, ctx) {
    try {
      const packet = await llmAgent.ask({theory: {knowledge: c.knowledge}, query: c.query, source: sourceOf(c.dir)}, {}, {presentation, model: process.env.LLM_AGENT_MODEL || undefined, verify: process.env.LLM_AGENT_VERIFY === '1'});
      ctx.packet = packet;
      return packet;
    } catch (e) {
      if (e instanceof NotExpressibleError) throw new NotExpressible(e.message);
      throw e;
    }
  }
});

export const llmAgentSop = variant('sop');
export const llmAgentNl = variant('nl');
export const llmAgentAdapters = [llmAgentSop, llmAgentNl];
