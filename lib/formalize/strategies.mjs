/**
 * The named formalization strategies of the request parser (DS022 "Formalization strategies"): how a chat message becomes a
 * model-surface SOP circuit. All return the same result shape (status validated | invalid | failed, sop, validation, unclear, usage,
 * steps) and feed the same symbolic path (validator, KnowledgeLinker, StrategyRouter, oracle verification, rendering).
 *
 * Owner decision 2026-10-02: the chat formalizes step by step. The system asks short questions and assembles the circuit itself; a
 * model only answers the questions. Larger tiers answer the SAME questions (like with like), never write a whole circuit. The MRP
 * formalize slot (DS025) adds two one-shot strategies, DirectSOP and SchemaGuidedLLM, chosen per Model and measured against them.
 *
 *   LocalLLMStepByStep  the default: the protocol of lib/query-author/step-by-step (method B) asks short questions and numbered choices.
 *   InternalReasoningStepByStep  the same kind of short questions, but the protocol is wires in a base memory
 *                       (config/knowledge/formalizer-protocol-v1) and the JS oracle plans the next question (lib/formalize/internal-reasoning).
 *
 * Who answers: a ladder of Ploinky tiers (`queryParser.local.ladder`, default `[tier]`; the product configures tiny, small, good). Each
 * question goes to the first tier and escalates to the next only when the answer cannot be read or the tier does not answer
 * (createOracle in lib/query-author/step-by-step/index.mjs). The one-shot strategy LLMDirect (a model writes the whole circuit) is
 * archived in probably_obsolete/one-shot-formalization/; the names LLMDirect, CodingAgent and LocalLLMDirect resolve to the default
 * step-by-step strategy with a note in the trace. Every question is one chat request to the Ploinky proxy (lib/pworker.mjs); none
 * runs through omp, and no strategy starts a model server itself (Ploinky manages the local models, owner 2026-10-03).
 */
import {stepByStepQuery, createOracle} from '../query-author/step-by-step/index.mjs';
import {FIRST_TURN_PREFIX} from '../query-author/step-by-step/prompts.mjs';
import {protocolQuery, PROTOCOL_PREFIX, METHODS as STEP_METHODS} from '../query-author/step-by-step/protocol.mjs';
import {internalReasoningQuery, createReasoningOracle, CONTROLS as REASONING_CONTROLS} from './internal-reasoning/index.mjs';
import {pworker, tierReadiness} from '../pworker.mjs';
import {replayChat, modelIdentity} from './replay-cache.mjs';
import {authorQuery} from '../query-author/one-shot/loop.mjs';
import {tierBackend} from '../query-author/one-shot/tier-backend.mjs';
import {dependencyScaffold} from './scaffold.mjs';
import {routedExtractors} from './routed-extractors.mjs';
import {frameGuided} from '../mrp/frames.mjs';

export const FORMALIZATION_STRATEGIES = Object.freeze(['LocalLLMStepByStep', 'InternalReasoningStepByStep', 'DirectSOP', 'SchemaGuidedLLM', 'SchemaOrDirect', 'Ensemble', 'EnsembleOneShot', 'DependencyScaffold', 'SpladeRouted', 'SaeRouted', 'FrameGuided']);
/** The default strategy of the chat and the API (owner decision 2026-10-02). */
export const DEFAULT_STRATEGY = 'LocalLLMStepByStep';
/** Archived one-shot strategy names (stored session settings, older run commands): read as the default step-by-step strategy. */
export const ARCHIVED_STRATEGIES = Object.freeze(['LLMDirect', 'CodingAgent', 'LocalLLMDirect']);
export const LOCAL_STRATEGIES = Object.freeze(['LocalLLMStepByStep', 'InternalReasoningStepByStep']);
/**
 * The one-shot strategies of the MRP formalize slot (DS025 "The catalog", DS028 "Routed formalizers"): one call writes the whole
 * circuit, validated and repaired in at most three rounds. DirectSOP offers the retrieved candidate predicates (the baseline of what a
 * model does without the protocol); SchemaGuidedLLM closes the vocabulary to the predicates of the memory and admits no session
 * definition. They are measured against the step-by-step strategies; the step-by-step default of the chat stays (owner 2026-10-02).
 */
export const ONE_SHOT_STRATEGIES = Object.freeze(['DirectSOP', 'SchemaGuidedLLM']);
/**
 * The small model of the step-by-step strategies: a Ploinky tier, by default `tiny` (owner 2026-10-03: the local Qwen3.6-35B-A3B MoE,
 * always on, managed by Ploinky, falling back to DeepSeek v4 flash), escalating along `ladder`. Ploinky starts and manages local
 * models; a strategy never starts a model server itself (owner 2026-10-03: no direct model calls outside Ploinky).
 */
export const DEFAULT_LOCAL = Object.freeze({tier: 'tiny', ladder: null, maxTokens: 1500, thinking: false, method: 'B', reasoningControl: 'plan'});
/** The step-by-step model is always a Ploinky tier (an explicit endpoint or GGUF of earlier versions is refused). */
export const usesTier = local => Boolean(local?.tier) && !local?.endpoint && !local?.gguf;
/** The purpose tag of every formalization call. */
export const FORMALIZE_PURPOSE = 'formalize';
/** The question protocols of LocalLLMStepByStep: A (the first protocol) and the generic protocol's methods (DS022 "LocalLLMStepByStep"). */
export const STEP_BY_STEP_METHODS = Object.freeze(['A', ...Object.keys(STEP_METHODS)]);
/** The byte-identical first-turn prefix of a step-by-step method (cached with the system message). */
export const stepPrefix = method => (method ?? 'A') === 'A' ? FIRST_TURN_PREFIX : PROTOCOL_PREFIX;
/** The parser name a strategy writes into the parse record of a turn. */
export const PARSER_NAMES = Object.freeze({LocalLLMStepByStep: 'local_llm_step_by_step', InternalReasoningStepByStep: 'internal_reasoning_step_by_step', DirectSOP: 'direct_sop', SchemaGuidedLLM: 'schema_guided_llm', SchemaOrDirect: 'schema_or_direct', Ensemble: 'ensemble', EnsembleOneShot: 'ensemble_one_shot', DependencyScaffold: 'dependency_scaffold', SpladeRouted: 'splade_routed', SaeRouted: 'sae_routed', FrameGuided: 'frame_guided'});

const noThinking = local => local.thinking ? {} : {chat_template_kwargs: {enable_thinking: false}};

/** Whether the step-by-step strategies can run, without starting anything: the first tier must be served by Ploinky. */
export async function localReadiness(local = {}, fetchImpl = null) {
  const s = {...DEFAULT_LOCAL, ...local};
  if (!usesTier(s)) return {available: false, running: null, reason: 'the step-by-step model must be a Ploinky tier (configure a local GGUF as a Ploinky provider)'};
  return {...await tierReadiness(s.tier, {fetchImpl}), running: null};
}

/**
 * The strategy a name asks for: `{strategy, note}`. An archived one-shot name resolves to `fallback` (the configured default) with a
 * note for the trace; an unknown name is an error (400 `invalid_strategy`).
 */
export function resolveStrategy(name, fallback = DEFAULT_STRATEGY) {
  if (ARCHIVED_STRATEGIES.includes(name)) return {strategy: fallback, note: `the one-shot strategy ${name} is archived (owner decision 2026-10-02); the step-by-step strategy ${fallback} ran instead`};
  if (!FORMALIZATION_STRATEGIES.includes(name)) throw Object.assign(new Error(`unknown formalization strategy ${JSON.stringify(name)}; use one of ${FORMALIZATION_STRATEGIES.join(', ')}`), {code: 'invalid_strategy', status: 400});
  return {strategy: name, note: null};
}

export const checkStrategy = (name, fallback = DEFAULT_STRATEGY) => resolveStrategy(name, fallback).strategy;

/**
 * The tier ladder of a step-by-step run: `[{tier, extraBody}]`, smallest first. `local.ladder` entries are tier names or
 * `{tier, extraBody}`; without a ladder the single `local.tier` answers. `first` (a session's preferred tier) starts the ladder at that
 * rung when it is on it, and is the only rung otherwise; that rung sends the request fields of the ladder's first rung (for example
 * thinking disabled), so a tier chosen by a model or session is asked the same way as the configured ones.
 */
export function ladderOf(local = {}, first = null) {
  const rungs = (Array.isArray(local.ladder) && local.ladder.length ? local.ladder : [local.tier]).filter(Boolean)
    .map(r => typeof r === 'string' ? {tier: r, extraBody: {}} : {tier: r.tier, extraBody: r.extraBody ?? {}, ...(r.minTokens ? {minTokens: r.minTokens} : {})});
  if (!first) return rungs;
  const at = rungs.findIndex(r => r.tier === first);
  return at >= 0 ? rungs.slice(at) : [{tier: first, extraBody: {...(rungs[0]?.extraBody ?? {})}}];
}

/**
 * A runnable step-by-step strategy: `run({message, lexicon, circuits, repo, session, execute, selfCheck, onProgress, ...authorOptions})`.
 * `fetchImpl` is the transport to the Ploinky proxy (tests inject fake tiers).
 */
export function localStrategy(name, local = {}, {fetchImpl = null, timeoutMs = 180_000} = {}) {
  const checked = checkStrategy(name);
  const settings = {...DEFAULT_LOCAL, ...local};
  if (!usesTier(settings)) throw Object.assign(new Error('the step-by-step model must be a Ploinky tier; an explicit endpoint or GGUF is no longer started here (configure it as a Ploinky provider and tier)'), {code: 'invalid_strategy'});
  if (ONE_SHOT_STRATEGIES.includes(checked)) return oneShotStrategy(checked, settings, {fetchImpl, timeoutMs});
  if (checked === 'Ensemble') return ensembleStrategy(settings, {fetchImpl, timeoutMs});
  if (checked === 'EnsembleOneShot') return ensembleStrategy(settings, {fetchImpl, timeoutMs, name: 'EnsembleOneShot', names: ENSEMBLE_ONE_SHOT_MEMBERS});
  if (checked === 'SchemaOrDirect') return schemaOrDirect(settings, {fetchImpl, timeoutMs});
  if (checked === 'SpladeRouted' || checked === 'SaeRouted') return routedExtractors({kind: checked === 'SpladeRouted' ? 'splade' : 'sae', schemaGuided: oneShotStrategy('SchemaGuidedLLM', settings, {fetchImpl, timeoutMs})});
  if (checked === 'FrameGuided') return frameGuided({schemaGuided: oneShotStrategy('SchemaGuidedLLM', settings, {fetchImpl, timeoutMs})});
  if (checked === 'DependencyScaffold') {
    const tier = ladderOf(settings)[0]?.tier ?? settings.tier, tags = settings.tags ?? {};
    return {...dependencyScaffold({tier, client: pworker({purpose: tags.purpose ?? FORMALIZE_PURPOSE, run: tags.run ?? null, fetchImpl, priority: tags.priority ?? null}),
      tierReadiness: async first => { const st = await tierReadiness(first, {fetchImpl}); return st.available ? {available: true, models: [first], skipped: []} : {available: false, reason: `the Ploinky tier ${first} is not available: ${st.reason}`, models: [], skipped: [{model: first, reason: st.reason}]}; }}), settings};
  }
  if (!LOCAL_STRATEGIES.includes(checked)) throw new TypeError(`${name} is not a local strategy`);
  return tierStrategy(name, settings, {fetchImpl, timeoutMs});
}

/** The members of Ensemble, in order of preference when two agree (DS028 "Routed formalizers"). */
export const ENSEMBLE_MEMBERS = Object.freeze(['DirectSOP', 'SchemaGuidedLLM', 'LocalLLMStepByStep']);
/** The members of EnsembleOneShot: the two one-shot authors only (two calls, no step-by-step protocol). */
export const ENSEMBLE_ONE_SHOT_MEMBERS = Object.freeze(['DirectSOP', 'SchemaGuidedLLM']);

/**
 * SchemaOrDirect: SchemaGuidedLLM when the memory has a reviewed value schema, DirectSOP otherwise. The choice follows from the memory,
 * is part of the strategy's definition (not a fallback after a failure) and is recorded as `chosen` in the parse record.
 */
function schemaOrDirect(settings, {fetchImpl, timeoutMs}) {
  const schema = oneShotStrategy('SchemaGuidedLLM', settings, {fetchImpl, timeoutMs}), direct = oneShotStrategy('DirectSOP', settings, {fetchImpl, timeoutMs});
  return {...direct, name: 'SchemaOrDirect', tag: direct.tag.replace('#DirectSOP', '#SchemaOrDirect'),
    async run(args) {
      const withSchema = (args.lexicon?.reviewedSchemaPredicates?.() ?? []).length > 0;
      const r = await (withSchema ? schema : direct).run(args);
      return {...r, chosen: withSchema ? 'SchemaGuidedLLM' : 'DirectSOP'};
    }};
}

/**
 * The signature of a circuit for agreement: its wire lines with wire names, variables and references renamed by order of appearance,
 * comments and blank lines dropped, sorted. Two circuits agree when their signatures are equal (the same wires, predicates, roles,
 * values and modes, whatever the names).
 */
export function circuitSignature(sop) {
  const names = new Map(), rename = (kind, name) => { const k = kind + name; if (!names.has(k)) names.set(k, `${kind}${names.size}`); return names.get(k); };
  return String(sop ?? '').split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l.trim() && !l.trim().startsWith('#'))
    .map(l => l.replace(/^@([A-Za-z][\w]*)/, (_, n) => '@' + rename('w', n)).replace(/\$([A-Za-z][\w]*)/g, (_, n) => '$' + rename('w', n)).replace(/\?([A-Za-z][\w]*)/g, (_, n) => '?' + rename('v', n)))
    .sort().join('\n');
}

/**
 * Ensemble: the member strategies formalize the same message on the same tier, in parallel; the circuits are compared by signature.
 * When at least two valid circuits agree, the first agreeing member's result is the answer (`ensemble.agreement` `majority` or
 * `unanimous`). When none agree, the first valid member's result is returned with `ensemble.agreement` `none`, a doubt signal the
 * roundtrip slot's `on-doubt` strategy checks (lib/mrp/pipeline.mjs `doubted`); with no valid circuit the run fails like a member.
 */
function ensembleStrategy(settings, {fetchImpl, timeoutMs, name = 'Ensemble', names = ENSEMBLE_MEMBERS}) {
  const members = names.map(member => localStrategy(member, settings, {fetchImpl, timeoutMs}));
  const tier = members[0].tier;
  return {
    name, settings, tier, ladder: [tier], tag: `tier:${tier}@pworker#${name}`,
    server: {stop: async () => {}},
    availability: firstTier => members[0].availability(firstTier),
    async run(args) {
      const t0 = Date.now();
      const results = await Promise.all(members.map(m => m.run(args).catch(e => ({ok: false, status: 'failed', reason: e.message}))));
      const rows = results.map((r, i) => ({strategy: names[i], ok: Boolean(r.ok), signature: r.ok ? circuitSignature(r.sop) : null, ...(r.ok ? {} : {reason: r.reason ?? r.status ?? 'invalid'})}));
      const valid = rows.filter(r => r.ok);
      const counts = new Map();
      for (const r of valid) counts.set(r.signature, (counts.get(r.signature) ?? 0) + 1);
      const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
      const agreed = best && best[1] >= 2 ? rows.findIndex(r => r.ok && r.signature === best[0]) : -1;
      const chosen = agreed >= 0 ? agreed : rows.findIndex(r => r.ok);
      const agreement = agreed >= 0 ? (best[1] === rows.length ? 'unanimous' : 'majority') : 'none';
      const ensemble = {agreement, members: rows.map(({signature, ...r}) => ({...r, ...(signature ? {agrees: best?.[1] >= 2 && signature === best[0]} : {})})), chosen: chosen >= 0 ? names[chosen] : null};
      const base = chosen >= 0 ? results[chosen] : results.find(r => r.status === 'invalid') ?? results[0];
      return {...base, ensemble, model: tier, ladder: [tier], ms: Date.now() - t0};
    },
  };
}

/**
 * DirectSOP and SchemaGuidedLLM on a Ploinky tier: the first tier of the ladder (or a session's preferred tier) writes the circuit in one
 * completion (lib/query-author/one-shot), the validator's problems go back for at most `maxFixRounds` repair rounds. The ladder is not
 * climbed: a one-shot strategy is measured on one tier. The prompt is the Ploinky task config/tasks/mrp-formalize-one-shot.md (its
 * request bounds the reply to 2500 tokens).
 */
function oneShotStrategy(name, settings, {fetchImpl, timeoutMs}) {
  const tier = ladderOf(settings)[0]?.tier ?? settings.tier;
  return {
    name, settings, tier, ladder: [tier], tag: `tier:${tier}@pworker#${name}`,
    server: {stop: async () => {}},
    async availability(firstTier = null) {
      const first = firstTier ?? tier;
      const state = await tierReadiness(first, {fetchImpl});
      return state.available ? {available: true, models: [first], skipped: []} : {available: false, reason: `the Ploinky tier ${first} is not available: ${state.reason}`, models: [], skipped: [{model: first, reason: state.reason}]};
    },
    async run({message, lexicon, onProgress = () => {}, maxFixRounds = 3, firstTier = null, circuits = [], repo = null, session = null, addressee = null, execute = null, retrieval = null, only = null}) {
      const rung = ladderOf(settings, firstTier)[0];
      const tags = settings.tags ?? {};
      const client = pworker({purpose: tags.purpose ?? FORMALIZE_PURPOSE, run: tags.run ?? null, fetchImpl, priority: tags.priority ?? null, cache: tags.cache ?? null});
      const closed = name === 'SchemaGuidedLLM';
      // SchemaGuidedLLM reads only the predicates of the memory's reviewed value schemas (schema wires, DS028): a view of the lexicon
      // whose predicates are those, so the prompt offers them and the validator refuses any other predicate id.
      let view = lexicon;
      if (closed) {
        const allowed = only ?? lexicon?.reviewedSchemaPredicates?.() ?? [];
        if (!allowed.length) return {ok: false, status: 'failed', reason: 'SchemaGuidedLLM needs a reviewed value schema in the memory (a schema wire with status reviewed, DS028); the memory has none', backend: 'completion', ladder: [rung.tier], model: rung.tier};
        view = Object.create(lexicon);
        view.predicates = Object.fromEntries(allowed.map(id => [id, lexicon.predicates[id]]));
      }
      const result = await authorQuery({message, lexicon: view, circuits, repo, session, addressee, execute, backend: tierBackend({client, model: rung.tier, extraBody: {...noThinking(settings), ...rung.extraBody}}),
        maxFixRounds, closed, vocabularyDialog: !closed, retrieval, onProgress});
      return {...result, backend: 'completion', ladder: [rung.tier], model: rung.tier};
    },
  };
}

/**
 * One question to a Ploinky tier, with the request body of the earlier local client (prompt cache on, greedy, not streamed), so
 * Ploinky's response cache replays earlier answers. A reply cut by its token limit (a reasoning model that spent the budget thinking,
 * or a partial answer) is a budget failure, never an answer to read (owner, 2026-10-02).
 */
export function tierChat({tier, fetchImpl = null, timeoutMs = 180_000, extraBody = {}, headers = {}, purpose = FORMALIZE_PURPOSE, run = null, noFallback = false, priority = null, cache = null}) {
  const ta = pworker({purpose, run, fetchImpl, priority, cache});
  return async (messages, maxTokens = 256) => {
    const r = await ta.chat({tier, messages, maxTokens, temperature: 0, stream: false, extraBody: {cache_prompt: true, timings_per_token: false, ...extraBody}, timeoutMs, headers, noFallback});
    if (!r.ok) return {ok: false, text: '', ms: r.ms, reason: /timed out|no answer within/.test(r.reason ?? '') ? `the model exceeded the ${Math.round(timeoutMs / 1000)} s limit` : `the model answered ${r.reason}`};
    const u = r.body?.usage ?? {}, timings = r.body?.timings ?? {};
    const usage = {input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0, reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? 0, cache_read_tokens: timings.cache_n ?? u.prompt_tokens_details?.cached_tokens ?? 0};
    // A cut reply is never read as an answer, empty or partial (owner rule: never use a cut reply silently): the question escalates
    // up the ladder, and the replay cache (which stores only `ok` answers) never keeps it.
    if (r.cut) return {ok: false, text: '', ms: r.ms, finish: r.finish, reason: `budget_exhausted: the reply reached max_tokens ${maxTokens}${r.text ? ' before its end' : ' before an answer'}`, usage};
    return {ok: true, text: r.text, ms: r.ms, finish: r.finish, usage, cached: timings.cache_n ?? null, evaluated: timings.prompt_n ?? null, prompt_ms: timings.prompt_ms ?? null, predicted_ms: timings.predicted_ms ?? null, predicted_per_second: timings.predicted_per_second ?? null};
  };
}

/** The question protocol of a step-by-step strategy over a `chat(messages, maxTokens)` client, or a tier `ladder` of `[{tier, chat}]`. */
async function stepQuery(name, settings, {message, lexicon, onProgress, chat, ladder = null, model, circuits, repo, session, derived = null}) {
  if (name === 'InternalReasoningStepByStep') {
    const control = settings.reasoningControl ?? 'plan';
    if (!REASONING_CONTROLS.includes(control)) throw Object.assign(new Error(`unknown reasoning control ${JSON.stringify(control)}; use one of ${REASONING_CONTROLS.join(', ')}`), {code: 'invalid_strategy'});
    return internalReasoningQuery({message, lexicon, circuits, repo, session, derived, oracle: createReasoningOracle({chat, ladder}), model, control, onProgress});
  }
  const method = settings.method ?? 'A';
  if (!STEP_BY_STEP_METHODS.includes(method)) throw Object.assign(new Error(`unknown step-by-step method ${JSON.stringify(method)}; use one of ${STEP_BY_STEP_METHODS.join(', ')}`), {code: 'invalid_strategy'});
  const query = method === 'A' ? stepByStepQuery : protocolQuery;
  // `settings.expression` (queryParser.local.expression): a numeric problem is formalized first by the expression path
  // (lib/formalize/expression-program.mjs), asked on the first rung; the problem questions are its fallback.
  return query({message, lexicon, circuits, repo, session, derived, oracle: createOracle({chat, ladder}), model, method, onProgress,
    ...(settings.expression ? {expression: {chat: ladder?.[0]?.chat ?? chat}} : {})});
}

/** How many questions each tier answered and which questions escalated (from the oracle steps of a run). */
export function ladderUsage(steps = []) {
  const answered = {};
  for (const s of steps) if (s.tier && s.ok && !s.escalated) answered[s.tier] = (answered[s.tier] ?? 0) + 1;
  return {answered, escalated: steps.filter(s => s.escalated).map(s => ({question: s.name, tier: s.tier}))};
}

/**
 * A step-by-step strategy on Ploinky tiers: every short question is one chat request to a tier, first to the smallest tier of the
 * ladder (`ladderOf(settings)`), escalating per question (createOracle). Ploinky starts the local model on demand; the stable system
 * prefix is byte-identical, so the serving model's prefix cache can reuse it. `run({firstTier})` starts the ladder at a session's
 * preferred tier.
 */
function tierStrategy(name, settings, {fetchImpl, timeoutMs}) {
  const rungs = ladderOf(settings);
  const tiers = rungs.map(r => r.tier);
  return {
    name, settings, tier: tiers[0], ladder: tiers, tag: `tier:${tiers.join('>')}@pworker#${settings.method ?? 'A'}`,
    server: {stop: async () => {}},
    /** Available when the first tier of the ladder answers (the higher tiers are tried per question; a missing one only stops escalation). */
    async availability(firstTier = null) {
      const first = ladderOf(settings, firstTier)[0]?.tier ?? tiers[0];
      // A strict replay needs no model: every answer comes from the cache.
      if (settings.replay?.mode === 'replay') return {available: true, models: tiers, skipped: []};
      const state = await tierReadiness(first, {fetchImpl});
      return state.available ? {available: true, models: ladderOf(settings, firstTier).map(r => r.tier), skipped: []} : {available: false, reason: `the Ploinky tier ${first} is not available: ${state.reason}`, models: [], skipped: [{model: first, reason: state.reason}]};
    },
    async run({message, lexicon, onProgress = () => {}, maxFixRounds = 2, firstTier = null, ...rest}) {
      void maxFixRounds;
      const ladder = ladderOf(settings, firstTier).map(rung => {
        const extraBody = {...noThinking(settings), ...rung.extraBody};
        // A reasoning tier needs room to think before its short answer: `minTokens` (a ladder entry's, or the settings') is a floor of
        // max_tokens, so a question's small budget never cuts the thinking (owner, 2026-10-02).
        const floor = rung.minTokens ?? settings.minTokens ?? 0;
        // `settings.tags` {purpose, run, noFallback, priority, cache (use | strict | record | off)}: an evaluation harness tags its calls (its run's budget), keeps each on one
        // model, and may run in the background priority class.
        const tags = settings.tags ?? {};
        const ask = tierChat({tier: rung.tier, fetchImpl, timeoutMs, extraBody, headers: settings.headers ?? {}, purpose: tags.purpose ?? FORMALIZE_PURPOSE, run: tags.run ?? null, noFallback: Boolean(tags.noFallback), priority: tags.priority ?? null, cache: tags.cache ?? null});
        const live = (messages, maxTokens) => ask(messages, Math.max(maxTokens ?? 0, floor) || maxTokens);
        // `settings.replay` {mode, dir}: the answers come from (and go to) the record/replay cache (lib/formalize/replay-cache.mjs).
        return {tier: rung.tier, chat: settings.replay ? replayChat(live, {...settings.replay, model: modelIdentity(rung.tier), sampling: {temperature: 0, extraBody, ...(floor ? {minTokens: floor} : {})}}) : live};
      });
      const result = await stepQuery(name, settings, {message, lexicon, onProgress, chat: ladder[0].chat, ladder: ladder.length > 1 ? ladder : null, model: ladder[0].tier, ...rest});
      const usage = ladderUsage(result.steps);
      return {...result, backend: 'completion', ladder: ladder.map(r => r.tier), ...(Object.keys(usage.answered).length > 1 || usage.escalated.length ? {tiers: usage} : {}),
        model: usage.escalated.length ? Object.keys(usage.answered).join('+') || ladder[0].tier : ladder[0].tier};
    },
  };
}
