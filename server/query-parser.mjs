/**
 * The request parser of a chat turn (DS009 "Request parser", DS014 "The circuit author"): the formalizer turns the user's message into
 * the model-surface SOP that the shared symbolic path (admission, KnowledgeLinker, slice retrieval, StrategyRouter, oracle verification,
 * completeness guard, rendering) executes.
 *
 * Owner decision 2026-10-02: formalization is step by step. The default strategy LocalLLMStepByStep (or InternalReasoningStepByStep)
 * asks short questions about the message and assembles the circuit itself; a model only answers the questions. The answering model is a
 * ladder of proxy tiers (`queryParser.local.ladder`, product: tiny, then small, then good): each question goes to the smallest tier and
 * escalates only when its answer cannot be read or the tier does not answer. The one-shot strategy LLMDirect is archived
 * (probably_obsolete/one-shot-formalization/); a session or a caller that names it (or CodingAgent, LocalLLMDirect) gets the default
 * step-by-step strategy and a `strategy_note` in the parse record. The MRP formalize slot adds DirectSOP, SchemaGuidedLLM and Ensemble
 * (lib/formalize/strategies.mjs, DS028), run through this same parser. There is no fallback parser: when the first
 * tier cannot run, the turn fails with the honest code `parse_unavailable` (503); a run that ended without a valid circuit fails with
 * `parse_failed` (422). Both errors carry the `parse` record for the trace.
 *
 * The packet carries `parse: {parser, strategy, model, ladder, tiers?, steps, dialog, ms, cache, ...}`. Identical requests are cached per
 * memory version, strategy and ladder. One formalization per turn (owner 2026-10-02: no voting); quality control is offline (the
 * proxy's request log, reviewed in batch).
 */
import {createHash} from 'node:crypto';
import {reportFormalizationError} from '../lib/formalization-errors.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {authorExecution} from '../lib/query-author/execution-context.mjs';
import {resolveStrategy, localStrategy, localReadiness, usesTier, ladderOf, DEFAULT_LOCAL, DEFAULT_STRATEGY, PARSER_NAMES} from '../lib/formalize/strategies.mjs';
import {FORMALIZATION_STRATEGIES as FORMALIZATION_STRATEGY_LABELS} from './status.mjs';
import {providerSettings} from '../lib/llm-providers.mjs';

export const DEFAULT_QUERY_PARSER = Object.freeze({
  strategy: DEFAULT_STRATEGY, timeoutSeconds: 120, maxConcurrent: 4, cacheEntries: 500, local: DEFAULT_LOCAL,
});

/**
 * The settings of the request parser: the defaults and `config.queryParser`. `strategy` names the formalization strategy
 * (LocalLLMStepByStep | InternalReasoningStepByStep; an archived one-shot name reads as the default, with `strategyNote`; environment
 * CHATSOP_FORMALIZER overrides it); `local` configures who answers the questions: the Ploinky tier ladder (`ladder`, default
 * `[tier]`). `models` lists the tiers of the ladder (status pages).
 */
export function queryParserSettings(config = {}, env = process.env) {
  const merged = {...DEFAULT_QUERY_PARSER, ...(config.queryParser ?? {})};
  const {strategy, note} = resolveStrategy(env.CHATSOP_FORMALIZER || merged.strategy);
  merged.strategy = strategy;
  if (note) merged.strategyNote = note;
  merged.local = {...DEFAULT_LOCAL, ...(config.queryParser?.local ?? {})};
  merged.providers = providerSettings(config);
  merged.models = ladderOf(merged.local).map(r => r.tier);
  return merged;
}

const normalize = text => String(text).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

class Lru {
  constructor(max) { this.max = max; this.map = new Map(); }
  get(key) { if (!this.map.has(key)) return undefined; const value = this.map.get(key); this.map.delete(key); this.map.set(key, value); return value; }
  set(key, value) { if (this.max <= 0) return; this.map.delete(key); this.map.set(key, value); while (this.map.size > this.max) this.map.delete(this.map.keys().next().value); }
  get size() { return this.map.size; }
}

/**
 * `chatData`: for the gap log; `fetchImpl`: the HTTP client of the model calls and the readiness probes; `localFactory(name, local,
 * options)` builds a step-by-step strategy (tests inject a stub).
 */
export function createQueryParser({settings = queryParserSettings(), chatData = null, fetchImpl = undefined, localFactory = localStrategy, now = Date.now} = {}) {
  const cache = new Lru(settings.cacheEntries);
  const defaultStrategy = settings.strategy ?? DEFAULT_STRATEGY;
  const locals = new Map();
  // The step-by-step strategies ask their tiers through the Ploinky proxy (lib/pworker.mjs); `fetchImpl` is its transport in tests.
  const localFor = name => {
    if (!locals.has(name)) locals.set(name, localFactory(name, settings.local, {timeoutMs: settings.timeoutSeconds * 1000, ...(fetchImpl ? {fetchImpl} : {})}));
    return locals.get(name);
  };
  let running = 0;
  const stats = {requests: 0, cache_hits: 0, parsed: 0, failures: 0};

  /** Whether the strategy can run now (its first tier answers); `firstTier` is a session's preferred tier. */
  const availability = (firstTier = null, strategy = defaultStrategy) => localFor(resolveStrategy(strategy, defaultStrategy).strategy).availability(firstTier);

  /** A gap of the memory (a clear question no predicate expresses): material for core-en growth through the approved authoring path. Gitignored (chat_data/). */
  function logGap(entry) {
    if (!chatData?.root) return;
    try { fs.appendFileSync(path.join(chatData.root, 'query-gaps.jsonl'), JSON.stringify({ts: new Date(now()).toISOString(), ...entry}) + '\n'); } catch { /* a log never fails a turn */ }
  }

  const fail = (code, status, message, parse) => Object.assign(new Error(message), {code, status, parse});
  const recordOf = (r, extra = {}) => ({parser: PARSER_NAMES[r.strategy] ?? PARSER_NAMES[defaultStrategy], strategy: r.strategy ?? defaultStrategy,
    ...(r.steps ? {steps: r.steps.length, dialog: r.steps.map(s => ({name: s.name, answer: s.answer, ...(s.qsha ? {qsha: s.qsha} : {}), ...(s.tier ? {tier: s.tier} : {}), ...(s.escalated ? {escalated: true} : {}), ...(s.ok === false ? {failed: true, ...(s.finish ? {finish: s.finish} : {}), ...(s.reason ? {reason: s.reason} : {})} : {})}))} : {}),
    ...(typeof r.report === 'string' && r.report.startsWith('{') ? {report: r.report} : {}), model: r.model ?? null, ...(r.ladder ? {ladder: r.ladder} : {}), ...(r.tiers ? {tiers: r.tiers} : {}),
    backend: r.backend ?? 'completion', cost_usd: r.usage?.cost_usd ?? r.cost_usd ?? 0, ms: r.ms ?? r.duration_ms ?? 0, cache: r.cache ?? 'miss',
    ...(r.usage?.cache_read_tokens ? {cache_read_tokens: r.usage.cache_read_tokens} : {}),
    ...(r.unlinked?.length ? {unlinked: r.unlinked} : {}), ...(r.mode ? {mode: r.mode, retrieval: {predicates: r.retrieval?.predicates?.length ?? 0, entity_mentions: r.retrieval?.entities?.length ?? 0, neighbourhood: r.retrieval?.neighbourhood ?? null}} : {}),
    ...(r.closest ? {closest: r.closest} : {}), ...(r.repairs?.length ? {repairs: r.repairs} : {}), ...(r.ensemble ? {ensemble: r.ensemble} : {}), ...(r.chosen ? {chosen: r.chosen} : {}), ...(r.routing ? {routing: r.routing} : {}), ...extra});

  // Every formalization of every caller (chat, evaluations, jobs) reports its failures to the formalization error inbox
  // (AGENTS.md "Formalization improvement"): an invalid circuit, and an `unclear` other than a missing relation (a knowledge gap). Off
  // under `node --test` unless settings.reportErrors is true; a wrong answer needs gold and is reported by the evaluations.
  const reporting = settings.reportErrors ?? !process.env.NODE_TEST_CONTEXT;
  const report = (row) => { if (reporting) try { reportFormalizationError(row); } catch { /* the inbox never breaks a turn */ } };

  /**
   * Parses one message. Returns `{sop, parse}`; throws `parse_unavailable` (the first tier cannot run, or no tier answered) or
   * `parse_failed` (the questions ran, no valid circuit came back), each with `error.parse`. `preferredModel` is a session's preferred
   * first tier (session setting `formalizer_model`); `strategy` a session's strategy (an archived one-shot name runs the default, noted).
   */
  async function parse({message, lexicon, memoryKey, onProgress, preferredModel = null, strategy = null, source = 'formalizer'}) {
    stats.requests++;
    const started = now();
    const resolved = resolveStrategy(strategy ?? defaultStrategy, defaultStrategy);
    strategy = resolved.strategy;
    const noted = resolved.note ? {strategy_note: resolved.note} : {};
    const parser = localFor(strategy);
    const firstTier = preferredModel && usesTier(settings.local) ? preferredModel : null;
    const free = await parser.availability(firstTier);
    if (!free.available) { stats.failures++; throw fail('parse_unavailable', 503, free.reason, {parser: PARSER_NAMES[strategy], strategy, model: null, ms: now() - started, failed: free.reason, tried: free.skipped ?? [], ...noted}); }
    const store = authorExecution.getStore();
    const key = createHash('sha256').update([memoryKey ?? '', store?.key ?? '', settings.runTag ?? '', String(store?.selfCheck ?? false), strategy, (store?.retrieval?.predicates ?? []).map(p => p.id).join(','), store?.link ?? '',
      parser.tag ?? `${settings.local.alias}@${settings.local.endpoint ?? settings.local.gguf ?? ''}#${settings.local.method ?? 'A'}`, firstTier ?? '', normalize(message)].join('\0')).digest('hex');
    const hit = cache.get(key);
    if (hit && (!hit.fragment || hit.contextKey === store?.contextKey)) { stats.cache_hits++; stats.parsed++; return {sop: hit.sop, parse: recordOf({...hit.result, strategy, cache: 'hit', ms: now() - started, cost_usd: 0, usage: {cost_usd: 0}}, noted)}; }
    if (running >= settings.maxConcurrent) { stats.failures++; throw fail('parse_unavailable', 503, 'the formalizer is busy', {parser: PARSER_NAMES[strategy], strategy, model: null, ms: now() - started, failed: 'the formalizer is busy', status: 'busy', ...noted}); }
    running++;
    let result;
    try { result = {...await parser.run({message, lexicon, ...store, firstTier, onProgress}), strategy}; }
    finally { running--; }
    if (result.ok) {
      cache.set(key, {sop: result.sop, result: {...result, usage: {cost_usd: 0}}, fragment: result.program?.wires.some(w => w.fields.fragment), contextKey: store?.contextKey});
      if (result.unclear === 'relation_not_in_memory') logGap({message, memory: memoryKey, closest: result.closest, model: result.model});
      else if (result.unclear) report({source, kind: 'unclear', message, strategy, tier: result.model ?? null, circuit: result.sop, detail: result.unclear, ref: memoryKey ?? null});
      stats.parsed++;
      return {sop: result.sop, parse: recordOf({...result, ms: now() - started}, {...noted, ...(result.unclear ? {unclear: result.unclear} : {})})};
    }
    stats.failures++;
    const reason = result.reason ?? `the formalizer's circuit was invalid: ${(result.validation?.problems ?? []).map(p => p.code).join(', ') || 'no output'}`;
    const record = recordOf({...result, ms: now() - started}, {failed: reason, ...noted});
    if (result.status === 'failed') throw fail('parse_unavailable', 503, reason, record);
    report({source, kind: 'invalid', message, strategy, tier: result.model ?? null, circuit: result.sop ?? null, detail: (result.validation?.problems ?? []).slice(0, 12).map(p => p.code), ref: memoryKey ?? null});
    // The last invalid circuit and its problems stay on the error for the trace and the evaluations (never executed).
    throw Object.assign(fail('parse_failed', 422, reason, record), {attempt: {sop: result.sop ?? null, problems: (result.validation?.problems ?? []).slice(0, 12)}});
  }

  /**
   * The formalization strategies of this parser with their availability (server/status.mjs): available when Ploinky serves the
   * first tier of the ladder.
   */
  async function strategies() {
    const localState = await localReadiness(settings.local, fetchImpl);
    return FORMALIZATION_STRATEGY_LABELS.map(s => ({...s, ...localState, backend: 'completion', model: settings.models[0], ladder: settings.models, endpoint: 'pworker'}));
  }

  /** Nothing to stop: Ploinky manages the model servers (kept for the chat server's shutdown sequence). */
  const stop = async () => {};
  return {parse, availability, strategies, defaultStrategy, stop, stats: () => ({...stats, cache_size: cache.size, running}), settings, clearCache: () => cache.map.clear()};
}
