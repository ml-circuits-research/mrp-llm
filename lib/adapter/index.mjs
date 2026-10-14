/**
 * ChatSOPAdapter (owner decision 2026-10-03; AGENTS.md "ChatSOPAdapter"): the one module through which the chat, the API and every
 * evaluation answer a message, so a result measured offline is the result the chat gives. A mode is a behaviour, chosen in
 * config/runtime.json `adapter.mode` (default), per chat session (setting `adapter_mode`) or per request (`adapter: {mode, options}`):
 *
 *   stepwise          the step-by-step formalizer and the chat turn (./modes/stepwise.mjs), the chat default
 *   routed            structure → route → compute path B with jsEval / engineCode as second formalizations, FOL v2 otherwise; two
 *                     formalizations that agree verify the answer (./modes/routed.mjs)
 *   direct-verified   the model answers directly; the routed formalizations try to verify that answer (./modes/direct-verified.mjs)
 * More modes register with `registerMode(name, fn)` (e.g. an ensemble); a mode is `async (ctx, message) → {results, chosen,
 * verification, route?, timings, tiers, ...}`.
 *
 * The answer packet of every mode ({object: 'chatsop.answer'}):
 *   mode, path            the mode and the path that produced the answer (stepwise, B, jsEval, engineCode:<lang>, fol, direct)
 *   answer                {values, answers, text}: the answered values, the path's answers, the rendered answer text
 *   verification          {status: verified|unverified|contradicted|unresolved, paths (agreeing), alternatives, ...}
 *   route                 the structure route (routed modes)
 *   paths                 every path that ran: status, values, circuits, proofs, ms, tier, calls, cached, detail
 *   circuits, proofs      [{path, sop}] and [{path, proof}] of the answering path
 *   timings, tiers        ms per stage (and total) and the proxy tier of each role used
 *   packet                the runtime's result packet of the answering path (not for serialization)
 *   turn                  stepwise only: the chat turn's full result (server/agent.mjs; not for serialization)
 * The chat renders the status through the conversation layer's reply wires (./reply.mjs); no phrasing is in code.
 */
import {adapterSettings, KNOWN_MODES} from './settings.mjs';
import {tierChat, structureClient, folClient} from './clients.mjs';
import {scratchExecutor} from './executor.mjs';
import {pathSummary} from './paths/result.mjs';
import {stepwise} from './modes/stepwise.mjs';
import {routed} from './modes/routed.mjs';
import {directVerified} from './modes/direct-verified.mjs';

export {adapterSettings, checkAdapterOptions, MODE_NAMES, KNOWN_MODES, DEFAULT_ADAPTER} from './settings.mjs';
export {parserFormalizer} from './modes/stepwise.mjs';
export {scratchExecutor, packetValues} from './executor.mjs';
export {tierChat, structureClient, folClient} from './clients.mjs';
export {pathResult, pathSummary} from './paths/result.mjs';
export {pathB, pathJsEval, executeCircuit, executeJs} from './paths/compute.mjs';
export {pathEngineCode, runProgram, codeBlocks, engineCodePrompt, ENGINE_CODE_LANGUAGES, ENGINE_CODE_SYSTEM} from './paths/engine-code.mjs';
export {pathFol, compileFol, executeFol, chooseUnits} from './paths/fol.mjs';
export {pathDirect, finalAnswerOf} from './paths/direct.mjs';
export {structureRoute} from './paths/structure.mjs';
export {symbolicPaths} from './modes/routed.mjs';
export {decideAgreement, valuesAgree, sameValue, directVerdict, agreementGroups} from './agreement.mjs';

const MODES = new Map([['stepwise', stepwise], ['routed', routed], ['direct-verified', directVerified]]);

/** Adds a mode (e.g. `ensemble`): `fn(ctx, message)` returns the mode fields described above. */
export function registerMode(name, fn) {
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(name) || typeof fn !== 'function') throw new Error('a mode is a name and an async function');
  MODES.set(name, fn);
  KNOWN_MODES.add(name);
}
export const modeNames = () => [...MODES.keys()];

/** The rendered text of a path's answer: the runtime's rendered answers of its packets, else its values joined. */
function answerText(chosen) {
  if (!chosen) return null;
  if (chosen.path === 'direct') return chosen.detail?.text ?? chosen.answers.map(a => a.value).join('; ');
  const texts = chosen.packets.map(p => p?.answer_text).filter(t => typeof t === 'string' && t.trim());
  return texts.length ? texts.join('\n') : chosen.values.length ? chosen.values.map(String).join(', ') : null;
}

/** The answer packet of a mode's fields (see the header). */
export function answerPacket(mode, fields, totalMs) {
  const chosen = fields.chosen ?? null;
  return {
    object: 'chatsop.answer', mode, path: chosen?.path ?? null,
    answer: {values: chosen?.values ?? [], answers: chosen?.answers ?? [], text: fields.turn?.text ?? answerText(chosen)},
    verification: fields.verification,
    route: fields.route ?? null,
    paths: Object.fromEntries((fields.results ?? []).map(r => [r.path, pathSummary(r)])),
    circuits: (chosen?.circuits ?? []).map(sop => ({path: chosen.path, sop})),
    proofs: (chosen?.proofs ?? []).map(proof => ({path: chosen.path, proof})),
    timings: {...fields.timings, total: totalMs},
    tiers: fields.tiers ?? {},
    ...(fields.direct ? {direct: fields.direct} : {}),
    ...(fields.parse ? {parse: fields.parse} : {}),
    packet: chosen?.packets?.[0] ?? null,
    ...(fields.turn ? {turn: fields.turn} : {}),
  };
}

/**
 * Creates the adapter. `config`: the runtime configuration (its `adapter` section); `fetchImpl`: the transport to the Ploinky proxy
 * (tests inject fake tiers); `url`: the server (default lib/pworker.mjs); `executor`: the engines of the routed paths (default: a scratch memory, ./executor.mjs), shared by calls.
 */
export function createChatSOPAdapter({config = {}, settings: given = null, fetchImpl = null, executor = null, url = null} = {}) {
  const defaults = given ?? adapterSettings(config);
  let engines = executor, owned = false;
  const ensureExecutor = async () => { if (!engines) { engines = await scratchExecutor(); owned = true; } return engines; };

  /**
   * Answers one message. `mode` and `options` override the defaults (a session's or a request's choice); `stepwise` = {agent,
   * formalizer, turnOptions} for mode stepwise; `lexicon` lets the equivalence check read units and names. Returns the answer packet.
   */
  async function answer({message, mode = null, options = {}, stepwise: turn = null, lexicon = null, run = null, cache = null, priority = null}) {
    const settings = adapterSettings({adapter: defaults}, {...options, ...(mode ? {mode} : {})});
    const fn = MODES.get(settings.mode);
    if (!fn) throw Object.assign(new Error(`unknown adapter mode ${settings.mode}`), {code: 'invalid_parameter', status: 400});
    // `priority` (interactive | normal | background): a batch harness runs in Ploinky's background class (held in busy periods).
    const tags = {purpose: settings.purpose, run: run ?? settings.run, cache: cache ?? settings.cache, priority: priority ?? settings.priority ?? null, timeoutMs: settings.timeoutSeconds * 1000, fetchImpl, url};
    const clients = {
      chat: tier => tierChat(tier, {...tags, noFallback: settings.noFallback}),
      structure: tier => structureClient(tier, tags),
      fol: tier => folClient(tier, tags),
    };
    const t0 = performance.now();
    const ctx = {settings, clients, executor: settings.mode === 'stepwise' ? null : await ensureExecutor(), stepwise: turn, lexicon};
    const fields = await fn(ctx, String(message));
    return answerPacket(settings.mode, fields, Math.round(performance.now() - t0));
  }

  return {answer, settings: defaults, modes: modeNames, dispose: () => { if (owned) engines?.dispose(); engines = null; }};
}

