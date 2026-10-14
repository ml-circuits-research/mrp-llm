/**
 * The chat client of ingestion v2: one non-streamed chat call through the Ploinky proxy by tier name (owner, 2026-10-02: clients
 * name a tier, never a concrete model), tagged with the purpose and the run id, with the plan credits of the call and the model that
 * served it (a fallback marked). Never throws on a provider failure; a 429 or 5xx is retried twice with a pause. `ta`: a caller's
 * Ploinky client (a task adapter's, tagged with the task's purpose, run and budget); otherwise one is made from `purpose`, `run`,
 * `cache` (use | strict | record | off) and `fetchImpl` (the transport; tests pass a fake).
 */
import {pworker} from '../../pworker.mjs';

export const PURPOSE = 'job:ingest-document';
/** Extra request fields per tier: Qwen3.8 27b (small) and the local MoE (tiny) answer without a thinking block. */
const TIER_BODY = {tiny: {chat_template_kwargs: {enable_thinking: false}}, small: {chat_template_kwargs: {enable_thinking: false}}};

const strip = text => String(text ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/g, '').trim();

export function tierChat({ta = null, purpose = PURPOSE, run = null, cache = null, fetchImpl = null, timeoutMs = 300_000, pauseMs = 5000} = {}) {
  const agent = ta ?? pworker({purpose: purpose ?? PURPOSE, run, cache, fetchImpl});
  const ledger = {calls: 0, failed: 0, credits: 0, input_tokens: 0, output_tokens: 0, by_tier: {}, fallbacks: 0, cached: 0};
  const chat = async ({tier, messages, maxTokens = 4000, temperature = 0, extraBody = {}}) => {
    const started = Date.now();
    const r = await agent.chat({tier, messages, maxTokens, temperature, extraBody: {...(TIER_BODY[tier] ?? {}), ...extraBody}, timeoutMs, retries: 2, retryPauseMs: pauseMs});
    if (!r.ok) { ledger.failed++; return {ok: false, text: '', reason: r.reason ?? 'the call failed', ms: Date.now() - started}; }
    const credits = r.credits ?? 0;
    const t = (ledger.by_tier[tier] ??= {calls: 0, credits: 0, output_tokens: 0, ms: 0});
    ledger.calls++; t.calls++; ledger.credits += credits; t.credits += credits;
    ledger.input_tokens += r.usage.in; ledger.output_tokens += r.usage.out; t.output_tokens += r.usage.out; t.ms += Date.now() - started;
    if (r.fallback) ledger.fallbacks++;
    if (r.cached) ledger.cached++;
    return {ok: true, text: strip(r.raw), finish: r.finish, credits, model: r.served ?? tier, fallback: r.fallback ?? null, ms: Date.now() - started};
  };
  return Object.assign(chat, {ledger});
}

/** The JSON object of a reply (fences stripped), or null. */
export function jsonOf(text) {
  const s = strip(text).replace(/```(?:json)?/g, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}
