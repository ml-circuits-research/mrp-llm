/**
 * The system under test of the books evaluation: the product chat turn (server/agent.mjs) over the default chat base memory, with the
 * request parser of the step-by-step strategy LocalLLMStepByStep (method B; or InternalReasoningStepByStep) whose questions go to one
 * Ploinky tier (`tier`, like with like: every tier answers the same questions; default `micro`, the local Qwen3-4B-Instruct that
 * Ploinky starts on demand) or to the product's tier ladder (`ladder: true`). Every model call goes through Ploinky
 * (lib/pworker.mjs), which manages the local model servers and their GPU locks. One-shot formalization (LLMDirect) was archived on
 * 2026-10-02 (probably_obsolete/one-shot-formalization/). One session, one fresh conversation entry per problem: the facts a problem
 * states are turn evidence of that entry only (caller-owned context), never written to the memory.
 */
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SessionStore} from '../../../server/session-store.mjs';
import {ChatData} from '../../../lib/chat-data/index.mjs';
import {BaseMemories, BASE_NAME} from '../../../lib/chat-data/memories.mjs';
import {Sessions} from '../../../lib/chat-data/sessions.mjs';
import {TheoryCache} from '../../../reasoning/slice/index.mjs';
import {createQueryParser, queryParserSettings} from '../../../server/query-parser.mjs';
import {DEFAULT_LOCAL} from '../../../lib/formalize/strategies.mjs';
import {createChatSOPAdapter, parserFormalizer} from '../../../lib/adapter/index.mjs';
import {chatTurn} from '../../../lib/adapter/chat-turn.mjs';
import fs from 'node:fs';
import {pworker} from '../../../lib/pworker.mjs';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
/** The tier of a run that names none: the local Qwen3-4B-Instruct (Ploinky tier `micro`), the model of the earlier llama-server runs. */
export const DEFAULT_TIER = 'micro';
export const LOCAL = {...DEFAULT_LOCAL, tier: DEFAULT_TIER, maxTokens: 1500, thinking: false, method: 'B'};

/** The default chat base memory (config chatData.defaultBase, world-v1 over core-en and commonsense-v1) in a private session. */
// `sessionId` lets several turn systems run side by side (one session each); `parserOptions` adds query-parser settings (for example
// `reportErrors: false` for a harness that reports by itself) and `tags` ({purpose, run, noFallback}) tag the Ploinky calls of the
// steps and the direct baseline (a run's budget; noFallback keeps every answer on the named tier's first model).
export async function openChatTurn({base = null, wallMs = 300_000, strategy = 'LocalLLMStepByStep', tier = null, ladder = false, sessionId = null, parserOptions = {}, tags = null, replay = null, localExtra = {}, mode = 'stepwise'} = {}) {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'runtime.json'), 'utf8'));
  const chatData = ChatData.open(config, {}, ROOT);
  const memories = new BaseMemories({chatData, memory: config.memory});
  const sessions = new Sessions({chatData, memories, memory: config.memory});
  const baseId = base ?? config.chatData?.defaultBase ?? 'world-v1';
  const id = sessionId ?? `books-eval-${process.pid}`;
  fs.rmSync(sessions.dir(id), {recursive: true, force: true});
  sessions.create({base: baseId, user: 'books-eval', id, name: 'books evaluation'});
  const theories = new TheoryCache();
  const lexicon = sessions.lexicon(id);
  const store = new SessionStore({repo: sessions.repository(id), lexicon, config: {...config, policy: {...(config.policy ?? {}), reinforce: false}}, root: path.join(sessions.dir(id), 'agent'),
    circuitRules: () => theories.get([...sessions.baseCircuits(id), ...sessions.circuits(id)]).chatRules()});
  // `tier`: the step-by-step questions go to one Ploinky tier (`micro`, `tiny`, `small`, `good`, ...; default DEFAULT_TIER); `ladder`:
  // to the product's configured ladder (queryParser.local.ladder), escalating per question.
  const stepTier = ladder ? tier ?? config.queryParser?.local?.tier ?? 'tiny' : tier ?? DEFAULT_TIER;
  const local = {method: 'B', tier: stepTier, ladder: ladder ? config.queryParser?.local?.ladder ?? null : tierRung(config, stepTier),
    maxTokens: LOCAL.maxTokens, thinking: false, ...(tags ? {tags} : {}), ...(replay ? {replay} : {}), ...localExtra};
  const settings = queryParserSettings({queryParser: {...(config.queryParser ?? {}), ...parserOptions, strategy, local, cacheEntries: 0, timeoutSeconds: wallMs / 1000}});
  const parser = createQueryParser({settings});
  // ChatSOPAdapter (lib/adapter): the same backend as the chat; `mode` stepwise unless a harness asks for routed or direct-verified.
  const adapter = createChatSOPAdapter({config});
  // The direct baseline asks the same tier through Ploinky, tagged like the steps calls.
  const ta = pworker({purpose: tags?.purpose ?? 'job:books-eval', run: tags?.run ?? null});
  let n = 0;
  return {
    baseId, sessionId: id, lexicon, local, memoryDigest: lexicon.circuitsSha256 ?? null,
    /**
     * One chat turn: the problem is the user message. Never throws: `error` carries code and message of a failed turn. `sop` replays a
     * stored circuit instead of formalizing (no model call); `authored` is the circuit the formalizer returned, as it returned it.
     */
    async ask(message, {sop = null} = {}) {
      const entry = store.get('books', `c${++n}`, BASE_NAME);
      let steps = null, authored = null;
      // The circuit author of the chat (ChatSOPAdapter's parserFormalizer); `sop` replays a stored circuit without a model call.
      // `formalizer.parse` is the parse record chatTurn reads (also on a failed turn).
      const author = parserFormalizer(parser, {lexicon, source: 'eval:books', request: {strategy}});
      const formalizer = {id: 'books-eval', parse: null, formalize: async text => {
        if (sop != null) { formalizer.parse = {strategy: 'replay'}; authored = sop; return sop; }
        authored = await author.formalize(text); formalizer.parse = author.parse; return authored;
      }};
      const started = Date.now();
      // Problems are independent: a session definition one problem adds to the session layer is removed after it (no carry-over).
      const circuitsDir = path.join(sessions.dir(id), 'circuits');
      const before = new Set(fs.existsSync(circuitsDir) ? fs.readdirSync(circuitsDir) : []);
      try {
        // The turn of the chat itself (lib/adapter/chat-turn.mjs, through ChatSOPAdapter): `mode` stepwise is the chat turn above, its
        // packet carries `adapter` and `parse` like the chat's; routed and direct-verified answer the problem as the chat does in those modes.
        const {result: res, answered, summary} = await chatTurn({adapter, agent: entry.agent, queryParser: parser, lexicon, message, mode, source: 'eval:books', author: formalizer});
        if (answered.mode !== 'stepwise') {
          const {packet} = answered;
          return {ok: true, ms: Date.now() - started, sop: answered.circuits.map(c => c.sop).join('\n\n') || null, authored: null, executionSop: null, text: answered.answer.text, packet: {...(packet ?? {}), adapter: summary}, trace: [], parse: null, userStatements: [], unclear: null, steps, adapter: summary};
        }
        return {ok: true, ms: Date.now() - started, sop: res.sop, authored, executionSop: res.executionSop, text: res.text, packet: res.packet, trace: res.trace, parse: formalizer.parse,
          userStatements: res.userStatements, unclear: res.unclear, steps};
      } catch (e) {
        return {ok: false, ms: Date.now() - started, authored, error: {code: e.code ?? e.name, message: String(e.message).slice(0, 400), ...(e.attempt ? {problems: e.attempt.problems} : {})}, parse: e.parse ?? formalizer.parse, sop: e.modelSop ?? e.attempt?.sop ?? null};
      } finally {
        // Each problem is its own conversation: release its repository session (a clone of the base memory is large) and its state.
        store.agents.delete(entry.key);
        try { store.repo.discard(entry.agent.session); } catch { /* already gone */ }
        if (fs.existsSync(circuitsDir)) for (const f of fs.readdirSync(circuitsDir)) if (!before.has(f)) fs.rmSync(path.join(circuitsDir, f), {recursive: true, force: true});
      }
    },
    /** The baseline: the same tier answers directly (short working, then a final line). Never throws: {ok, text, ms, finish, usage} or {ok: false, reason}. */
    async direct(message, {maxTokens = 1024} = {}) {
      // The request body of the earlier local client (prompt cache on, greedy, not streamed), so Ploinky's cache replays its answers.
      const r = await ta.chat({tier: local.tier, maxTokens, temperature: 0, stream: false, timeoutMs: wallMs, noFallback: Boolean(tags?.noFallback),
        extraBody: {cache_prompt: true, timings_per_token: false, chat_template_kwargs: {enable_thinking: false}},
        messages: [{role: 'system', content: DIRECT_SYSTEM}, {role: 'user', content: message}]});
      const usage = {input_tokens: r.usage?.in ?? 0, output_tokens: r.usage?.out ?? 0, reasoning_tokens: r.usage?.reasoning ?? 0, cache_read_tokens: r.usage?.cached ?? 0};
      if (!r.ok) return {ok: false, text: '', ms: r.ms, reason: `the model answered ${r.reason}`};
      // A reply cut by the token limit before any answer is a budget failure, never an empty answer to read (owner, 2026-10-02).
      if (r.finish === 'length' && !r.text) return {ok: false, text: '', ms: r.ms, finish: r.finish, reason: `budget_exhausted: the reply reached max_tokens ${maxTokens} before an answer`, usage};
      return {ok: true, text: r.text, ms: r.ms, finish: r.finish, usage, served: r.served ?? null, cached: r.cached};
    },
    async close() { fs.rmSync(sessions.dir(id), {recursive: true, force: true}); adapter.dispose(); await parser.stop(); },
  };
}

/**
 * The single-rung ladder of one tier, with the request settings the product ladder gives that tier (for example reasoning off on
 * `good`), so a tier answers exactly as it would inside the product ladder; null when the product ladder does not name it.
 */
export function tierRung(config, tier) {
  const rung = (config.queryParser?.local?.ladder ?? []).find(r => (typeof r === 'string' ? r : r?.tier) === tier);
  return rung && typeof rung === 'object' ? [rung] : null;
}

export const DIRECT_SYSTEM = 'You solve reasoning problems. Use only the facts and rules given in the problem. Work briefly step by step, then finish with one line that starts with "Final answer:" and states the answer concisely (numbers with units, a name, yes or no, or "not enough information" when the data do not decide).';
