/**
 * The model clients of ChatSOPAdapter (owner decision 2026-10-03): every call names a Ploinky tier, never a model.
 *
 *   tierChat(tier, options)      a chat client of a tier for the closed questions (path B, jsEval, engineCode, the direct answer): greedy,
 *                                thinking off, tagged with a purpose and a run, counting cache hits and token usage. A reply cut by its
 *                                budget is asked again with four times the budget (at most 32000 tokens), else reported, never used.
 *   structureClient / folClient  the prompted JSON roles `structure` (POST /v1/structure) and `formalizer` (POST /v1/fol), through
 *                                lib/formalize/small-models.mjs.
 *
 * The request bodies are exactly those of the evaluation harnesses of 2026-10-03, so Ploinky's response cache (keyed by the body)
 * replays their answers. `fetchImpl` is the transport to the Ploinky proxy (tests pass fake tiers). `thinking`: 'think' (a local
 * thinking model with its recommended sampling), 'reason' (a cloud tier's reasoning, effort medium), or null.
 */
import {extractStructure, formalizeFol} from '../formalize/small-models.mjs';
import {pworker} from '../pworker.mjs';

/** A chat client of a tier: `await chat(messages, maxTokens)` → {ok, text, finish} or {ok: false, reason}. */
export function tierChat(tier, {purpose = 'formalize', run = null, cache = null, priority = null, timeoutMs = 300_000, thinking = null, noFallback = true, url = null, fetchImpl = null} = {}) {
  const ta = pworker({purpose, run, cache, priority, fetchImpl, url});
  const sampling = thinking === 'think' ? {temperature: 0.6, top_p: 0.95, top_k: 20, chat_template_kwargs: {enable_thinking: true}}
    : thinking === 'reason' ? {temperature: 0, reasoning: {effort: 'medium'}} : {temperature: 0, chat_template_kwargs: {enable_thinking: false}};
  const once = async (messages, maxTokens) => {
    chat.calls++;
    const r = await ta.chat({tier, messages, maxTokens, stream: false, extraBody: sampling, noFallback, timeoutMs});
    if (r.cached) chat.hits++;
    if (!r.ok) return {ok: false, reason: `${r.status ?? ''} ${r.error ? JSON.stringify(r.error).slice(0, 200) : r.reason ?? ''}`.trim()};
    chat.usage.output_tokens += r.usage.out; chat.usage.reasoning_tokens += r.usage.reasoning;
    chat.usage.reasoning_chars += (r.reasoning ?? '').length; chat.usage.content_chars += r.raw.length;
    return {ok: true, finish: r.finish, text: r.text};
  };
  const chat = async (messages, maxTokens) => {
    let budget = thinking === 'reason' ? 32000 : thinking ? Math.max(maxTokens, 8000) : maxTokens;
    for (;;) {
      const r = await once(messages, budget);
      if (!r.ok || r.finish !== 'length') return r;
      if (budget >= 32000) { chat.usage.cut++; return {ok: false, reason: `budget_exhausted: cut at ${budget} tokens`}; }
      budget = Math.min(32000, budget * 4); chat.usage.budget_retries++;
    }
  };
  chat.tier = tier; chat.calls = 0; chat.hits = 0;
  chat.usage = {output_tokens: 0, reasoning_tokens: 0, reasoning_chars: 0, content_chars: 0, budget_retries: 0, cut: 0};
  return chat;
}

/** Whether every call of a client was served from Ploinky's cache. */
export const allCached = chat => chat.calls > 0 && chat.hits === chat.calls;

/** The structure tier: `await structure(request)` with {text, entities, relations?, threshold?} → {ok, body, ms, cached} | {ok: false, reason}. */
export const structureClient = (tier, {purpose = 'formalize', run = null, cache = null, priority = null, timeoutMs = 300_000, fetchImpl = null, url = null} = {}) =>
  request => extractStructure({...request, model: tier}, {purpose, run, cache, priority, timeoutMs, fetchImpl, url});

/** The formalizer (FOL) tier: `await fol(request)` with {inputs, candidates?, context?} → {ok, body: {results}, ms, cached} | {ok: false, reason}. */
export const folClient = (tier, {purpose = 'formalize', run = null, cache = null, priority = null, timeoutMs = 300_000, fetchImpl = null, url = null} = {}) =>
  request => formalizeFol({model: tier, ...request}, {purpose, run, cache, priority, timeoutMs, fetchImpl, url});
