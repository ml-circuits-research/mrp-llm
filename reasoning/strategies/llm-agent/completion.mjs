/**
 * One bounded chat completion through Ploinky (lib/pworker.mjs). No retries and no alternate-model substitution: a concrete model
 * (`upstream` + `model`) is asked with the provider's fallback off, and a tier (`model` a tier name, no `upstream`) with the tier's
 * fallback off unless `fallback` is true. `fetchImpl` is the transport to the Ploinky proxy (tests pass a fake).
 */
import {pworker} from '../../../lib/pworker.mjs';

export async function runCompletion({model, prompt, system, timeoutMs = 120000, maxTokens = 1024, upstream = null, fallback = false, purpose = 'answer-llm-agent', signal, fetchImpl = null} = {}) {
  const started = performance.now();
  const result = extra => ({ok: false, text: null, cost: 0, usage: null, ms: Math.round(performance.now() - started), timedOut: false, error: null, ...extra});
  if (typeof model !== 'string' || !model || typeof prompt !== 'string')
    return result({error: 'model and prompt are required'});
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxTokens) || maxTokens <= 0)
    return result({error: 'timeoutMs and maxTokens must be positive safe integers'});
  if (signal?.aborted) return result({error: 'completion request failed: aborted'});
  const ta = pworker({purpose, fetchImpl});
  // The request body of the earlier OpenAI-compatible client: greedy, thinking off, not streamed.
  const r = await ta.chat({...(upstream ? {upstream, model} : {tier: model}), messages: [...(system ? [{role: 'system', content: system}] : []), {role: 'user', content: prompt}],
    maxTokens, temperature: 0, extraBody: {chat_template_kwargs: {enable_thinking: false}}, noFallback: !fallback, timeoutMs,
    ...(signal ? {signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])} : {})});
  if (!r.ok) {
    const timedOut = /no answer within/.test(r.reason ?? '');
    // A 2xx answer that failed is a body that is not completion JSON (the client parses every 2xx body).
    const malformed = r.status >= 200 && r.status < 300;
    return result({timedOut, error: timedOut ? 'wall timeout' : malformed ? `malformed completion JSON: ${String(r.reason ?? '').slice(0, 500)}` : r.status ? `completion HTTP ${r.status}: ${String(r.reason ?? '').slice(0, 500)}` : `completion request failed: ${r.reason}`});
  }
  const text = r.raw;
  if (typeof text !== 'string' || !text.trim()) return result({error: 'malformed completion response: missing assistant text'});
  const u = r.body?.usage;
  const usage = u && typeof u === 'object' ? {input: u.prompt_tokens ?? null, output: u.completion_tokens ?? null, cacheRead: u.prompt_tokens_details?.cached_tokens ?? null, ...u} : null;
  return result({ok: true, text, usage, served: r.served ?? null});
}
