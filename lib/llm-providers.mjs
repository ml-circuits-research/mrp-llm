/**
 * Model entries of the project's components (owner decisions 2026-10-02 and 2026-10-03): every model call goes through the Ploinky
 * server (lib/pworker.mjs), by tier name; the openference plan's `Qwen3.8 27b` is the default model of the plain-text components (the
 * answer-language step, knowledge authoring, judges). `llmProviders` of config/runtime.json names, per Ploinky provider, its default
 * model and request settings (no endpoint: Ploinky knows where its providers are).
 *
 *   openference  the openference plan (Qwen3.8 27b)
 *   openrouter   OpenRouter, paid per token (DeepSeek flash)
 *   local        the local model of tier `tiny` (Qwen3.6-35B-A3B)
 *
 * A chain entry is a Ploinky tier (`nano`, `micro`, `tiny`, `small`, `medium`, `good`, `best`; the server serves the tier and falls
 * back down the tier's own chain, reporting the model it used), a string `<provider>/<model>` (a concrete model of a provider:
 * `openrouter/deepseek/deepseek-v4-flash`; calibrations and A/B arms only), a bare provider name (its configured model), or an object
 * `{provider?, model?, tier?}`; `chainEntry` resolves it to `{id, kind: 'completion', provider, model, upstream, extraBody, noFallback,
 * tier?}`. For a concrete model the server's own fallback is switched off per request (`noFallback`): the chain is explicit and every
 * switch is recorded by the caller. An unavailable entry is reported by `providerReadiness` with the reason; callers skip it and record
 * why (never a silent substitution).
 */
import {pworker, tierReadiness} from './pworker.mjs';

export const DEFAULT_PROVIDERS = Object.freeze({
  openference: Object.freeze({model: 'Qwen3.8 27b', requestsPerMinute: 15, timeoutSeconds: 120, maxTokens: 4000, thinking: false, proxyFallback: false}),
  openrouter: Object.freeze({model: 'deepseek/deepseek-v4-flash', timeoutSeconds: 120, maxTokens: 4000, thinking: false, proxyFallback: false}),
  local: Object.freeze({model: 'Qwen3.6-35B-A3B', timeoutSeconds: 120, maxTokens: 1500, thinking: false, proxyFallback: false}),
});
/** The model tiers Ploinky serves (`supertiny` is the earlier name of `micro`). */
export const TIERS = Object.freeze(['nano', 'micro', 'supertiny', 'tiny', 'small', 'medium', 'good', 'best']);

/** The providers: the defaults merged with `config.llmProviders`. */
export function providerSettings(config = {}) {
  const out = {};
  for (const name of new Set([...Object.keys(DEFAULT_PROVIDERS), ...Object.keys(config.llmProviders ?? {})])) out[name] = {...DEFAULT_PROVIDERS[name], ...(config.llmProviders?.[name] ?? {})};
  return out;
}

const noThinking = provider => provider.thinking === false ? {chat_template_kwargs: {enable_thinking: false}} : {};

/** The object form of a string chain entry: a tier, `<provider>/<model>` or a bare provider name; an unknown provider is the default provider's model id. */
export function parseEntry(text, providers = providerSettings()) {
  if (TIERS.includes(text)) return {provider: 'openference', model: text, tier: text};
  const slash = text.indexOf('/');
  const head = slash < 0 ? text : text.slice(0, slash);
  if (providers[head]) return {provider: head, ...(slash < 0 ? {} : {model: text.slice(slash + 1)})};
  return {provider: 'openference', model: text};
}

/** Resolves one chain entry (every model is called directly through Ploinky; there is no agentic backend). */
export function chainEntry(entry, {providers = providerSettings()} = {}) {
  if (typeof entry === 'string') entry = parseEntry(entry, providers);
  if (entry.kind && entry.kind !== 'completion') throw new Error(`the chain entry kind ${JSON.stringify(entry.kind)} is not supported; models are called directly (completion)`);
  const name = entry.provider ?? 'openference';
  const provider = providers[name];
  if (!provider && !entry.tier) throw new Error(`the chain entry names the unknown provider ${JSON.stringify(name)}; configure it under llmProviders`);
  const tier = entry.tier ?? null;
  const model = tier ?? entry.model ?? provider.model;
  return {id: tier ?? `${name}/${model}`, kind: 'completion', provider: name, model, upstream: tier ? null : name, timeoutMs: (entry.timeoutSeconds ?? provider?.timeoutSeconds ?? 120) * 1000,
    maxTokens: entry.maxTokens ?? provider?.maxTokens ?? 4000, extraBody: {...(provider && !tier ? noThinking(provider) : {}), ...(entry.extraBody ?? {})},
    noFallback: !tier && provider?.proxyFallback === false, ...(tier ? {tier} : {})};
}

/** Whether an entry (a tier, a chain entry or its id) can be served now: the tier is listed, or the provider has a key. Never starts anything. */
export async function providerReadiness(entry, {fetchImpl = null, tier = null} = {}) {
  const e = tier ? {tier} : typeof entry === 'string' ? (TIERS.includes(entry) ? {tier: entry} : chainEntry(entry)) : entry;
  if (e.tier) return tierReadiness(e.tier, {fetchImpl});
  try {
    const health = await pworker({purpose: 'chat', fetchImpl, autostart: false}).health();
    const up = health?.upstreams?.[e.upstream];
    if (up?.key_configured) return {available: true};
    return {available: false, reason: up ? `the Ploinky provider ${e.upstream} has no key configured` : `Ploinky has no provider ${e.upstream}`};
  } catch (error) { return {available: false, reason: error.message}; }
}

/**
 * One single-turn chat call through a provider entry or a tier, for components that need plain text (answer phrasing, judges,
 * labellers). Returns `{ok, text, usage, ms, model, reason?}`; never throws on a provider failure. `purpose` tags the call.
 */
export async function providerChat({system, prompt, provider = 'openference', config = {}, model = null, timeoutMs = null, maxTokens = null, purpose = 'chat', fetchImpl = null} = {}) {
  const providers = providerSettings(config);
  const entry = chainEntry(TIERS.includes(provider) && !model ? provider : {provider, ...(model ? {model} : {})}, {providers});
  const started = Date.now();
  const r = await pworker({purpose: purpose ?? 'chat', fetchImpl}).chat({...(entry.tier ? {tier: entry.tier} : {upstream: entry.upstream, model: entry.model}), system, prompt,
    temperature: 0, maxTokens: maxTokens ?? entry.maxTokens, stream: false, extraBody: entry.extraBody, noFallback: entry.noFallback, timeoutMs: timeoutMs ?? entry.timeoutMs});
  if (!r.ok) return {ok: false, text: '', ms: Date.now() - started, model: entry.id, reason: /not reachable|unreachable/.test(r.reason ?? '') ? `the model could not be reached: ${r.reason}` : `the model answered ${r.reason}`};
  return {ok: Boolean(r.text), text: r.text, ms: Date.now() - started, model: entry.id, usage: r.body?.usage ?? {}, ...(r.text ? {} : {reason: 'the reply is empty'})};
}
