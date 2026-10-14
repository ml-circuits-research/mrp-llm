#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {validateQuery, unclearKind} from '../../../lib/query-author/index.mjs';
import {chainEntry} from '../../../lib/llm-providers.mjs';
import {splitCircuits} from '../../../lib/query-author/session.mjs';
import {parse as parseRuntime} from '../../../sop/parser.mjs';
import {parse as parseKnowledge} from '../../../sop/knowledge/lexical.mjs';
import {runCompletion} from '../../../reasoning/strategies/llm-agent/completion.mjs';
import {nlPrompt, SYSTEM_PROMPT, ANSWER_MARKER, PROMPT_VERSION} from '../../../reasoning/strategies/llm-agent/prompt.mjs';
import {parseAnswer} from '../../../reasoning/strategies/llm-agent/packet.mjs';
import {verifyUsed} from '../../../reasoning/strategies/llm-agent/verify.mjs';
import {renderEnglish} from '../../../reasoning/slice/render-english.mjs';
import {wireText} from '../../../sop/knowledge/index.mjs';
import {LIMITS, createWorld, execute, linkCircuit, withDefinitions, goldSlice, oracleOverSlice} from './world.mjs';
import {score, equivalent, failureLayer} from './score.mjs';
import {writeReport, stopDecision} from './report.mjs';
import {openSession, defaultRoot} from '../lib/session.mjs';
import {readExperiments} from '../../../lib/journal.mjs';
import {tierLadder} from '../lib/tier-parser.mjs';
import {createQueryParser, queryParserSettings} from '../../../server/query-parser.mjs';
import {createChatSOPAdapter} from '../../../lib/adapter/index.mjs';
import {chatTurn} from '../../../lib/adapter/chat-turn.mjs';
import {BASE_NAME} from '../../../lib/chat-data/memories.mjs';
import {SessionStore} from '../../../server/session-store.mjs';
/**
 * The symbolic-vs-LLM benchmark harness (experiments/proposal/symbolic-vs-llm-benchmark.md): every arm answers the same question of a
 * generated world with oracle gold, under one wall and output-token ceiling.
 *
 *   A, A'          the local tier `settings.localTier` (default micro) answers from the gold slice rendered as English evidence
 *                  (direct, or with reasoning before a marked answer); D: a subscription model the same way. Direct model answers,
 *                  not chat turns; every call goes through Ploinky (lib/pworker.mjs).
 *   C, B-stepbystep  a chat turn through ChatSOPAdapter (lib/adapter/chat-turn.mjs, the glue server/http.mjs uses), mode stepwise, in
 *                  a fresh conversation of the world's chat session (world.mjs `createWorld`, or the shared world-v1 session): the
 *                  request parser (server/query-parser.mjs) asks the step-by-step questions (`settings.strategy`, default
 *                  LocalLLMStepByStep, method `settings.stepMethod`, default B for C and A for B-stepbystep, `settings.reasoningControl`)
 *                  on one tier (C: `settings.tier`, default small; B-stepbystep: `settings.localTier`), and the chat turn
 *                  (server/agent.mjs) admits, links, routes, verifies and renders the answer. The scored packet and the rendered text
 *                  are the chat turn's (AGENTS.md "ChatSOPAdapter": no evaluation keeps its own formalization and solving glue).
 *                  `settings.replayCircuit` (or an `authorBackend` of kind replay) replaces the circuit author of arm C with a
 *                  reviewed circuit, checked by the same validator, through the same chat turn (zero model calls).
 *                  An additional offline check runs the oracle (js-reference) over the gold slice with the turn's circuit, linked
 *                  by the product compiler (`verified`, `oracle_equivalent`, `offline_verification`); when it cannot be computed the
 *                  record says why and `verified` is false. It never supplies the answer.
 *
 * Owner decision 2026-10-02: formalization is step by step only; the one-shot author arms (B: a local model writes free SOP with repair
 * rounds; B-grammar and B-structured: its constrained decoders; B-local: the same loop on the strategy slot) are archived in
 * probably_obsolete/one-shot-formalization/.
 */
export const DEFAULT_LOCAL_TIER = 'micro';
export const ARCHIVED_ARMS = Object.freeze(['B', 'B-grammar', 'B-structured', 'B-local']);
export const CHAT_ARMS = Object.freeze(['C', 'B-stepbystep']);
const RUNTIME = JSON.parse(fs.readFileSync(new URL('../../../config/runtime.json', import.meta.url), 'utf8'));
/** A reviewed circuit replayed through the same validator as every formalizer (zero model calls): the author result shape. */
export function replayAuthor(sop, message, world) {
  const validation = validateQuery({sop, message, lexicon: world.lexicon, repo: world.repo ?? null, session: world.session ?? null});
  return {ok: validation.ok, status: validation.ok ? 'validated' : 'invalid', sop, validation, unclear: validation.ok ? unclearKind(validation.program) : null,
    usage: {input_tokens: 0, output_tokens: 0, cost_usd: 0}, runs: [{round: 0, ok: true, duration_ms: 0}], model: 'reviewed-circuit'};
}

/**
 * The circuit author of a replayed reviewed circuit in a chat turn: the validator checks it like a formalizer's circuit, and an invalid
 * one fails the turn as the request parser does (`parse_failed` with the attempt), never executed.
 */
export function replayFormalizer(sop, message, agent) {
  return {id: 'reviewed-circuit', label: 'reviewed circuit (replay)', parse: null, formalize: async () => {
    const replayed = replayAuthor(sop, message, {lexicon: agent.lexicon, repo: agent.repo, session: agent.session});
    if (!replayed.ok) throw Object.assign(new Error(`the reviewed circuit is invalid: ${replayed.validation.problems.map(p => p.code).join(', ')}`), {code: 'parse_failed', status: 422, parse: null, attempt: {sop, problems: replayed.validation.problems.slice(0, 12)}});
    return sop;
  }};
}

/**
 * The request-parser settings of a step-by-step arm: the chat's settings (config.queryParser) with the arm's strategy, question method,
 * reasoning control and single tier (C: `settings.tier`, default small; B-stepbystep: `settings.localTier`), with the request settings
 * the product ladder gives that tier, the calls tagged with the run's purpose, no parse cache and the shared wall budget as timeout.
 */
export function armParserSettings(arm, settings, config = RUNTIME) {
  const tier = arm === 'C' ? settings.tier ?? 'small' : settings.localTier ?? DEFAULT_LOCAL_TIER;
  const local = {...(config.queryParser?.local ?? {}), tier, ladder: tierLadder(config, tier), method: settings.stepMethod ?? (arm === 'C' ? 'B' : 'A'),
    reasoningControl: settings.reasoningControl ?? 'plan', tags: {purpose: settings.purpose ?? 'job:symbolic-vs-llm'}, ...(Number.isFinite(settings.maxTokens) ? {maxTokens: settings.maxTokens} : {})};
  return queryParserSettings({...config, queryParser: {...(config.queryParser ?? {}), strategy: settings.strategy ?? 'LocalLLMStepByStep', local, cacheEntries: 0,
    ...(Number.isFinite(settings.wallMs) ? {timeoutSeconds: settings.wallMs / 1000} : {})}});
}

/**
 * A fresh conversation of the world's chat session for one question of one arm: the session store of `world.chat` (createWorld, or
 * the shared world-v1 session of main()), else a session store over `world.repo` like the chat's (reads never reinforce) under
 * `root`. Closing it forgets the conversation, discards its repository session and removes the session definitions its turn added
 * (the session's `circuits` folder), so no question influences another.
 */
function conversation(world, id, root) {
  if (!world.chat?.store && !root) throw new Error('a step-by-step arm needs world.chat (a chat session) or a folder for its session store');
  const store = world.chat?.store ?? new SessionStore({repo: world.repo, lexicon: world.lexicon, config: {...RUNTIME, policy: {...(RUNTIME.policy ?? {}), reinforce: false}},
    root: path.join(root, 'agent'), circuitRules: () => world.theory.chatRules()});
  const entry = store.get('benchmark', id, BASE_NAME);
  const circuitsDir = path.join(path.dirname(store.repo.root), 'circuits');
  const before = new Set(fs.existsSync(circuitsDir) ? fs.readdirSync(circuitsDir) : []);
  return {entry, close() {
    store.agents.delete(entry.key);
    try { store.repo.discard(entry.agent.session); } catch { /* already discarded */ }
    if (fs.existsSync(circuitsDir)) for (const f of fs.readdirSync(circuitsDir)) if (!before.has(f)) fs.rmSync(path.join(circuitsDir, f), {recursive: true, force: true});
  }};
}

export const VERSION = 'symbolic-vs-llm-m1-v1';
const sha = value => createHash('sha256').update(value).digest('hex');
const opt = (args, name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };

function sourceHashes() {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const hashes = {};
  const visit = relative => {
    const absolute = path.join(root, relative);
    if (fs.statSync(absolute).isFile()) {
      if (/\.(mjs|md|json)$/.test(relative)) hashes[relative] = sha(fs.readFileSync(absolute));
      return;
    }
    for (const entry of fs.readdirSync(absolute).sort()) visit(path.join(relative, entry));
  };
  // Code and author guides only: never evaluation cases, sealed suites or session data.
  // The chat turn of the step-by-step arms: the request parser, the agent and its session store, and the shared harness glue.
  for (const directory of ['lib', 'sop', 'memory', 'reasoning', 'config/knowledge/formalizer-protocol-v1', 'tools/eval/symbolic-vs-llm', 'tools/eval/lib',
    'server/agent.mjs', 'server/query-parser.mjs', 'server/session-store.mjs', 'config/runtime.json']) visit(directory);
  return hashes;
}

export function alignProjection(packet, authoredQuery, goldQuery) {
  const columns = q => /^\s*select\s+([^\n]+)/m.exec(q)?.[1]?.match(/\?[a-z][a-z0-9_]*/g)?.map(v => v.slice(1)) ?? [];
  const from = columns(authoredQuery), to = columns(goldQuery);
  if (from.length !== to.length || !from.length) return packet;
  const names = new Map(from.map((name, i) => [name, to[i]]));
  const rename = row => Object.fromEntries(Object.entries(row).map(([k, v]) => [names.get(k) ?? k, v]));
  return {...packet, ...(packet.rows ? {rows: packet.rows.map(rename)} : {}), ...(packet.witness ? {witness: rename(packet.witness)} : {})};
}

/** Stable round-robin size/depth strata; every stage is a prefix of the next. */
export function stageRows(rows, count, seed = 20261001) {
  const buckets = new Map();
  for (const row of rows) {
    const key = `${row.facts}/${row.depth}/${row.variant ?? row.form ?? ''}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  const groups = [...buckets].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => group.sort((a, b) => sha(seed + a.id).localeCompare(sha(seed + b.id))));
  const picked = [];
  for (let i = 0; picked.length < Math.min(count, rows.length); i++) for (const group of groups) if (group[i] && picked.length < count) picked.push(group[i]);
  return picked;
}

export function evidenceFor(slice, question, {maxChars = 90000, sampleFacts = 450} = {}) {
  const complete = renderEnglish(slice);
  if (complete.length <= maxChars) return {source: complete, evidence_does_not_fit: false, facts: slice.facts.length, original_chars: complete.length};
  const mentions = new Set(question.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
  const rank = f => f.atom.a.some(a => mentions.has(String(a).toLowerCase())) ? 0 : mentions.has(f.atom.p) ? 1 : 2;
  const sampled = [...slice.facts].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id)).slice(0, sampleFacts);
  const factIds = new Set(sampled.map(f => f.id));
  let wires = slice.wires.filter(w => w.type !== 'fact' || factIds.has(w.id));
  // Completeness declarations must not turn a capped sample into a closed world.
  wires = wires.map(w => w.type === 'predicate' ? {...w, fields: w.fields.filter(f => f.key !== 'closed')} : w);
  let source = renderEnglish({facts: sampled, wires});
  while (source.length > maxChars && sampled.length) {
    const removed = sampled.pop(); wires = wires.filter(w => w.id !== removed.id); source = renderEnglish({facts: sampled, wires});
  }
  if (source.length > maxChars) throw new Error('evidence rules alone exceed context budget');
  return {source: 'This is a partial keyed sample. The lists below are not complete; do not infer absence from missing facts.\n' + source,
    evidence_does_not_fit: true, facts: sampled.length, original_chars: complete.length};
}


// Broken-arm admission is syntax/non-delivery, not a semantic validator refusal or engine failure.
function unparsableCircuit(sop) {
  try {
    const split = splitCircuits(sop);
    parseRuntime(split.model);
    return parseKnowledge(split.definitions).errors.length > 0;
  } catch { return true; }
}

/**
 * A step-by-step arm (C, B-stepbystep): one chat turn through ChatSOPAdapter in a fresh conversation of the world's chat session (see
 * the header). Returns the fields of the arm's record before scoring: `packet` the chat turn's result packet (with `adapter`, the
 * answer packet of ChatSOPAdapter, and `parse`, the request parser's parse record), `rendered` the turn's text, `author` what the
 * formalization produced, and the offline gold-slice check.
 */
async function chatArm({row, arm, world, gold, slice, query, settings, start, folder}) {
  const replay = arm !== 'C' ? null : settings.replayCircuit ?? (settings.authorBackend?.kind === 'replay' ? (await settings.authorBackend.generate({})).sop : null);
  const parserSettings = armParserSettings(arm, settings);
  // `settings.localFactory` (tests): the step-by-step strategy factory of the request parser (server/query-parser.mjs).
  const queryParser = createQueryParser({settings: parserSettings, ...(settings.localFactory ? {localFactory: settings.localFactory} : {})});
  const adapter = createChatSOPAdapter({config: RUNTIME});
  const talk = conversation(world, 'q' + sha(`${row.id}\0${arm}`).slice(0, 24), folder);
  const agent = talk.entry.agent;
  let turn = null, failure = null, validation = null;
  const turnStart = Date.now();
  try {
    try {
      turn = await chatTurn({adapter, agent, queryParser, lexicon: world.lexicon, message: row.question, mode: 'stepwise', source: 'eval:symbolic-vs-llm',
        author: replay != null ? replayFormalizer(replay, row.question, agent) : null});
    } catch (error) { failure = error; }
    const authored = turn?.result?.sop ?? failure?.modelSop ?? failure?.attempt?.sop ?? null;
    // The admission of the circuit by the same validator, for the record (`parsed`, problems) and the offline check's linking.
    if (typeof authored === 'string' && authored.trim()) validation = validateQuery({sop: authored, message: row.question, lexicon: world.lexicon, repo: agent.repo, session: agent.session});
  } finally { talk.close(); adapter.dispose(); await queryParser.stop(); }
  const turnMs = Date.now() - turnStart;
  const parse = turn?.parse ?? failure?.parse ?? null;
  const result = turn?.result ?? null;
  const sop = result?.sop ?? failure?.modelSop ?? failure?.attempt?.sop ?? null;
  // The formalization's outcome: validated (a circuit reached the runtime), invalid (the validator refused the last circuit: parse_failed)
  // or failed (no circuit: parse_unavailable, or the turn failed before a circuit was written).
  let status = 'validated', reason = null, error = null, problems = null;
  if (failure) {
    if (failure.code === 'parse_failed') { status = 'invalid'; reason = failure.message; problems = failure.attempt?.problems ?? validation?.problems ?? null; }
    else if (failure.code === 'parse_unavailable') { status = 'failed'; reason = failure.message; }
    else if (failure.modelSop == null) { status = 'failed'; error = failure.message; }
    else error = failure.message;
  }
  const chatPacket = result?.packet ?? null;
  const unclear = status === 'validated' ? result?.unclear ?? parse?.unclear ?? null : null;
  const responseEmpty = status === 'invalid' && !sop?.trim();
  const fields = {packet: chatPacket, rendered: result?.text, error, parse, sop, status, reason, problems, unclear, validation, turnMs,
    responseEmpty, brokenModelOutput: responseEmpty || (status === 'invalid' && unparsableCircuit(sop)), linking: null, oracleEquivalent: null, verified: false,
    check: {policy: 'benchmark-offline-gold-slice', outcome: 'not_computable', reason: chatPacket ? 'the circuit was not admitted or asks for clarification' : 'the turn returned no packet', ms: 0}};
  if (status !== 'validated' || !chatPacket) return fields;
  if (settings.wallMs && Date.now() - start > settings.wallMs) fields.error = 'shared question wall budget exhausted';
  // The offline check: the turn's circuit linked by the product compiler and run by the oracle over the gold slice. It verifies the
  // chat's answer; it never replaces it.
  const verifyStart = Date.now();
  try {
    if (!validation?.ok || unclear) throw new Error(validation?.ok ? `unclear: ${unclear}` : `not admitted: ${(validation?.problems ?? []).map(p => p.code).join(', ') || 'no circuit'}`);
    const linking = fields.linking = linkCircuit(sop, row.question, world.lexicon, validation.program);
    if (!linking.query) throw new Error(linking.issue?.status ?? linking.plan?.issues?.[0]?.status ?? 'unresolved_circuit');
    const effectiveWorld = withDefinitions(world, validation.program, linking.context);
    const effectiveSlice = effectiveWorld.definitionWires?.length ? {...slice, wires: [...slice.wires, ...effectiveWorld.definitionWires]} : slice;
    const rawReplay = oracleOverSlice(effectiveSlice, linking.query);
    fields.oracleEquivalent = equivalent(gold, alignProjection(rawReplay, linking.query, query));
    // A question without `select` (yes/no) answers by its status; the oracle's witness rows of its inner variables are not an answer.
    // The chat names the suppositions of a conditional answer itself (assume_0, ...): conditions compare by number, not by id.
    let replayAnswer = /^\s*select\s/m.test(linking.query) ? rawReplay : (({rows: _rows, ...rest}) => rest)(rawReplay);
    const ids = value => value == null ? null : [value].flat();
    if (ids(replayAnswer.conditional)?.length && ids(replayAnswer.conditional).length === ids(chatPacket.conditional)?.length) replayAnswer = {...replayAnswer, conditional: chatPacket.conditional};
    fields.verified = chatPacket.complete !== false && rawReplay.complete !== false && equivalent(chatPacket, replayAnswer);
    fields.check = {policy: 'benchmark-offline-gold-slice', outcome: fields.verified ? 'agreed' : 'differs', reason: fields.verified ? null : 'the chat answer differs from the oracle over the gold slice', ms: 0};
  } catch (e) {
    fields.check = {policy: 'benchmark-offline-gold-slice', outcome: 'not_computable', reason: String(e.message).slice(0, 300), ms: 0};
  }
  fields.check.ms = Date.now() - verifyStart;
  // Scoring compares answer columns by the gold query's names: an alpha-renamed projection keeps its values.
  fields.packet = alignProjection(chatPacket, fields.linking?.query ?? sop, query);
  return fields;
}

/** One arm, same question, shared wall/output-token ceiling, no circuit or answer in the author prompt. */
export async function runArm({row, arm, world, gold, slice, evidence, knowledge, query, settings, folder}) {
  const start = Date.now();
  let author = null, packet = null, linking = null, error = null, oracleEquivalent = null, verified = false, rendered, offline;
  let tokensIn = 0, tokensOut = 0, cost = 0;
  let parseOk = null, responseEmpty = false, brokenModelOutput = false;
  const latency = {parse_ms: 0, retrieval_ms: 0, engine_ms: 0, verify_ms: 0, model_ms: 0};
  let authorRecord = null;
  try {
    if (ARCHIVED_ARMS.includes(arm)) throw new Error(`arm ${arm} (one-shot circuit authoring) is archived (owner decision 2026-10-02); use B-stepbystep or C`);
    if (CHAT_ARMS.includes(arm)) {
      const chat = await chatArm({row, arm, world, gold, slice, query, settings, start, folder});
      ({packet, rendered, error, oracleEquivalent, verified, responseEmpty, brokenModelOutput} = chat);
      // Linking failures are attributed when the chat itself asks for clarification of a name or relation it could not link.
      linking = packet?.status === 'clarify' ? {issue: {status: packet.reason ?? 'clarify'}, plan: chat.linking?.plan ?? null} : null;
      offline = chat.check;
      const parse = chat.parse;
      // The parse record carries no token counts (cost only); the step timings are not in it either.
      Object.assign(latency, {parse_ms: parse?.ms ?? null, turn_ms: chat.turnMs, linking_ms: null, retrieval_ms: null, engine_ms: packet?.timings?.total ?? null, verify_ms: chat.check.ms, model_ms: null});
      tokensIn = null; tokensOut = null; cost = parse?.cost_usd ?? 0;
      author = {status: chat.status, reason: chat.reason, unclear: chat.unclear, sop: chat.sop, model: replayed(arm, settings) ? 'reviewed-circuit' : parse?.model ?? null,
        validation: {problems: chat.problems ?? undefined, program: chat.validation?.program ?? null}, unlinked: parse?.unlinked ?? []};
      authorRecord = {status: chat.status, reason: chat.reason, rounds: null, sop: chat.sop, context_version: null, retrieval: parse?.retrieval ?? null, usage: parse ? {cost_usd: parse.cost_usd ?? 0} : null,
        model: author.model, strategy: parse?.strategy ?? null, unclear: chat.unclear,
        ...(arm === 'B-stepbystep' ? {steps: parse?.dialog ?? null, plan: parse?.report ?? null, confirmed: null, retried: null, problem: null, method: armParserSettings(arm, settings).local.method, contrast: null} : {}),
        problems: author.validation.problems, parsed: Boolean(chat.validation?.program)};
    } else {
      const reasoning = arm === "A'" ? 'cot' : 'direct';
      const projection = /^\s*select\s+([^\n]+)/m.exec(query)?.[1]?.match(/\?[a-z][a-z0-9_]*/g)?.map(v => v.slice(1)) ?? [];
      const schema = projection.length ? `\nFor an answer table, name its columns ${projection.join(', ')}. These are output column names, not facts.\n` : '';
      const prompt = nlPrompt({source: `${evidence.source}\n\nQuestion: ${row.question}${schema}\nInclude a used list of evidence identifiers that suffice for your answer, for example \"used\":[{\"id\":\"f1\",\"version\":1}]. Refer only to identifiers printed in the evidence.`, reasoning});
      // D: the subscription model (a tier, or a concrete model of a provider); A and A': the local tier. Both through Ploinky.
      const target = arm === 'D' ? (({upstream, model}) => ({upstream, model}))(chainEntry(settings.subscriptionModel)) : {model: settings.localTier ?? DEFAULT_LOCAL_TIER};
      const reply = await runCompletion({...target, prompt, system: SYSTEM_PROMPT, timeoutMs: settings.wallMs, maxTokens: settings.maxTokens, purpose: settings.purpose ?? 'job:symbolic-vs-llm'});
      latency.model_ms = reply.ms; tokensIn = reply.usage?.prompt_tokens ?? reply.usage?.input ?? 0; tokensOut = reply.usage?.completion_tokens ?? reply.usage?.output ?? 0; cost = arm === 'D' ? reply.cost ?? 0 : 0;
      if (!reply.ok || tokensOut > settings.maxTokens) error = tokensOut > settings.maxTokens ? 'subscription output exceeded shared question token budget' : reply.error ?? 'completion failed';
      else {
        const parsed = parseAnswer(reply.text, reasoning === 'cot' ? ANSWER_MARKER : null); packet = parsed.packet;
        parseOk = parsed.ok;
        responseEmpty = !reply.text?.trim();
        brokenModelOutput = responseEmpty || parseOk === false;
        const verifyStart = Date.now();
        // Verification uses the exact gold circuit and cited support; never sends either to the model.
        verified = verifyUsed({knowledge: slice.wires.map(wireText).join('\n\n'), query}, packet).verified === true; latency.verify_ms = Date.now() - verifyStart;
        rendered = reply.text;
      }
    }
  } catch (e) { error = e.message; }
  const verdict = score(row.expected, packet, {author, error});
  latency.wall_ms = Date.now() - start;
  return {id: row.id, family: row.family, facts: row.facts, depth: row.depth, split: row.split, arm, model: arm === 'C' ? (author?.model === 'reviewed-circuit' ? 'reviewed-circuit' : `tier:${settings.tier ?? 'small'}`) : arm === 'D' ? settings.subscriptionModel : settings.model ?? `tier:${settings.localTier ?? DEFAULT_LOCAL_TIER}`,
    parse_ok: parseOk, response_empty: responseEmpty, broken_model_output: brokenModelOutput,
    outcome: verdict.outcome, reasons: verdict.why, memory_sha256: world.theory.digest, gold_answerable: !['unknown', 'incomplete'].includes(row.expected.status), verified, proof_available: Boolean(packet?.used?.length || packet?.proof),
    evidence_does_not_fit: evidence.evidence_does_not_fit, evidence_facts: evidence.facts, evidence_chars: evidence.original_chars,
    latency, tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: arm === 'C' || arm === 'D' ? cost : 0,
    author: authorRecord, packet, rendered, oracle_equivalent: oracleEquivalent, ...(offline ? {offline_verification: offline} : {}), error,
    failure_layer: failureLayer({arm, parseOk, outcome: verdict.outcome, author, linking, packet, oracleEquivalent, rendered, error})};
}

/** Whether arm `arm` replays a reviewed circuit (arm C with `settings.replayCircuit` or an `authorBackend` of kind replay). */
const replayed = (arm, settings) => arm === 'C' && (settings.replayCircuit != null || settings.authorBackend?.kind === 'replay');

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    console.log('node tools/eval/symbolic-vs-llm/run.mjs --manifest eval/smoke-reasoning/bench/manifest.jsonl --arms A,B-stepbystep[,C --tier small] [--local-tier micro] --pilot 20 --out eval/reports/current/symbolic-vs-llm/pilot [--stages 100,300,600]'); return;
  }
  const manifestFile = path.resolve(opt(args, '--manifest', 'eval/smoke-reasoning/bench/manifest.jsonl'));
  const manifestText = fs.readFileSync(manifestFile, 'utf8');
  const rows = manifestText.split('\n').filter(Boolean).map(JSON.parse);
  const pilot = Number(opt(args, '--pilot', 0));
  if (pilot && rows.some(r => r.split !== 'dev')) throw new Error('pilot accepts development cases only');
  if (rows.some(r => r.split !== 'dev')) {
    const preregistration = JSON.parse(fs.readFileSync(new URL('../../../status/preregistrations/eval-symbolic-vs-llm-v1.json', import.meta.url), 'utf8'));
    if (!preregistration.frozen) throw new Error('sealed execution requires a frozen preregistration');
  }
  const arms = opt(args, '--arms', 'A,B-stepbystep').split(',');
  if (arms.some(a => ARCHIVED_ARMS.includes(a))) throw new Error(`arms ${ARCHIVED_ARMS.join(', ')} (one-shot circuit authoring) are archived (owner decision 2026-10-02); use B-stepbystep or C --tier T`);
  if (arms.some(a => !['A', "A'", 'B-stepbystep', 'C', 'D'].includes(a))) throw new Error('unknown arm');
  if (rows.some(r => r.split !== 'dev') && arms.some(a => ['B-stepbystep', 'C'].includes(a))) throw new Error('the step-by-step authoring arms are dev-only until the sealed protocol is re-registered (its arms B and C were one-shot authoring, archived 2026-10-02)');
  for (const gone of ['--endpoint', '--port', '--model']) if (args.includes(gone)) throw new Error(`${gone} is gone: every model call goes through Ploinky; name the local tier with --local-tier (default ${DEFAULT_LOCAL_TIER})`);
  const localTier = opt(args, '--local-tier', DEFAULT_LOCAL_TIER);
  const settings = {model: `tier:${localTier}`, localTier, subscriptionModel: opt(args, '--subscription-model', 'openference/Qwen3.8 27b'), tier: opt(args, '--tier', 'small'), wallMs: Number(opt(args, '--wall-ms', 180000)), maxTokens: Number(opt(args, '--max-tokens', 4096))};
  if (/^openrouter\b/.test(settings.subscriptionModel) && !args.includes('--allow-paid')) throw new Error('openrouter is paid per token; pass --allow-paid for an explicitly authorized run');
  // Ploinky serves the tiers and reports the model that answered; the harness does not hash a model file.
  const modelManifest = {source: 'pworker-tier', local_tier: localTier, identity_verified: false};
  const out = path.resolve(opt(args, '--out', 'eval/reports/current/symbolic-vs-llm/pilot'));
  fs.mkdirSync(out, {recursive: true});
  const config = {version: VERSION, harness_sha256: sha(fs.readFileSync(new URL(import.meta.url), 'utf8')), world_sha256: sha(fs.readFileSync(new URL('./world.mjs', import.meta.url), 'utf8')), runtime: {node: process.version, arch: process.arch, platform: process.platform}, model_manifest: modelManifest, manifest_sha256: sha(manifestText), settings: {...settings, retrieval_limits: LIMITS, chat_arms: 'C and B-stepbystep answer through the chat turn (ChatSOPAdapter, mode stepwise) under the chat policy limits; retrieval_limits bound the gold and the offline check', subscription_token_budget: 'post-response usage admission of the remote model'}, arms, pilot, prompt_version: PROMPT_VERSION, prompt_sha256: sha(nlPrompt({source: '', reasoning: 'direct'}) + runArm.toString() + chatArm.toString()), renderer_sha256: sha(fs.readFileSync(new URL('../../../reasoning/slice/render-english.mjs', import.meta.url), 'utf8')), stages: pilot ? [pilot] : opt(args, '--stages', '100,300,600').split(',').map(Number)};
  config.runtime_sources = sourceHashes();
  config.runtime_source_sha256 = sha(JSON.stringify(config.runtime_sources));
  const configFile = path.join(out, 'run.json');
  if (fs.existsSync(configFile) && JSON.stringify(JSON.parse(fs.readFileSync(configFile, 'utf8'))) !== JSON.stringify(config)) throw new Error('run identity changed; use a fresh output directory');
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
  const recordFile = path.join(out, 'records.jsonl');
  const records = fs.existsSync(recordFile) ? fs.readFileSync(recordFile, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
  const done = new Set(records.map(r => `${r.id}/${r.arm}`));
  let sharedWorld = null;
  try {
    for (const family of [...new Set(rows.map(r => r.family))].sort()) {
      let activeArms = [...arms];
      for (const stage of config.stages) {
        const candidates = rows.filter(r => r.family === family);
        if (candidates.length < stage) throw new Error(`${family} has ${candidates.length} instances, fewer than requested stage ${stage}`);
        for (const row of stageRows(candidates, stage)) {
          if (activeArms.every(arm => done.has(`${row.id}/${arm}`))) continue;
          const dir = path.resolve(path.dirname(manifestFile), row.case_dir); const knowledge = fs.readFileSync(path.join(dir, 'knowledge.sop'), 'utf8'); const query = fs.readFileSync(path.join(dir, 'query.sop'), 'utf8');
          row.expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8'));
          let world;
          if (row.base_memory === 'world-v1') {
            if (row.world_root && path.resolve(row.world_root) !== path.resolve(defaultRoot(), 'base_memories', 'world-v1')) throw new Error('Requested world-v1 root differs from QF_CHAT_ROOT; no memory substitution');
            if (!sharedWorld) {
              const session = openSession({base: 'world-v1', id: `benchmark-${process.pid}-world`});
              try {
                const entry = session.store.get('qf', 'bench', 'main');
                sharedWorld = {repo: session.store.repo, session: entry.agent.session, lexicon: session.lexicon, theory: session.theories.get([...session.sessions.baseCircuits(session.id), ...session.sessions.circuits(session.id)]), chat: session, dispose: session.close};
              } catch (error) { session.close(); throw error; }
            }
            world = sharedWorld;
          } else world = createWorld(knowledge);
          try {
            const gold = execute(world, query);
            if (score(row.expected, gold).outcome !== 'correct') throw new Error(`${row.id}: gold fails on product path: ${JSON.stringify(score(row.expected, gold))}`);
            const slice = goldSlice(world, query, gold);
            if (!equivalent(gold, oracleOverSlice(slice, query))) throw new Error(`${row.id}: gold evidence replay differs`);
            const evidence = evidenceFor(slice, row.question);
            for (const arm of activeArms) {
              if (done.has(`${row.id}/${arm}`)) continue;
              const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'symbolic-bench-author-'));
              try {
                const record = await runArm({row, arm, world, gold, slice, evidence, knowledge, query, settings, folder});
                records.push(record); done.add(`${row.id}/${arm}`); fs.appendFileSync(recordFile, JSON.stringify(record) + '\n');
                console.error(`${row.id} ${arm} ${record.outcome} ${record.latency.wall_ms}ms`);
              } finally { fs.rmSync(folder, {recursive: true, force: true}); }
            }
          } finally { if (world !== sharedWorld) world.dispose(); }
        }
        const current = records.filter(r => r.family === family);
        const decision = stopDecision(current, stage);
        fs.appendFileSync(path.join(out, 'stages.jsonl'), JSON.stringify({family, stage, pilot: Boolean(pilot), ...decision}) + '\n');
        if (decision.stop) {
          const {execFileSync} = await import('node:child_process');
          const detail = JSON.stringify({family, stage, ...decision});
          const env = {...process.env, CHATSOP_ACTOR: process.env.CHATSOP_ACTOR ?? 'omp-t5-pilot'};
          execFileSync(process.execPath, ['tools/journal.mjs', 'add', '--area', 'eval', '--state', 'progress', '--title', 'Benchmark staged stop', '--detail', detail], {env});
          execFileSync(process.execPath, ['tools/notes.mjs', 'add', '--topic', 'evaluation', '--kind', 'result', '--title', 'Benchmark staged stop', '--body', detail], {env});
          const registryFile = new URL('../../../status/experiments.json', import.meta.url);
          const registry = readExperiments({file: registryFile});
          const experiment = registry.experiments.find(e => e.id === 'eval-symbolic-vs-llm-v1');
          if (!experiment) throw new Error('benchmark experiment is not registered');
          experiment.results ??= {};
          experiment.results.stage_stops ??= [];
          experiment.results.stage_stops.push({family, stage, ...decision, report: path.relative(process.cwd(), out)});
          fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2) + '\n');
          fs.appendFileSync(new URL('../../../PAS_TASK.md', import.meta.url), `\nBenchmark staged stop: ${detail}. Evidence: ${path.relative(process.cwd(), out)}/stages.jsonl.\n`);
          if (decision.reason === 'broken') { activeArms = activeArms.filter(a => !decision.dropped_arms.includes(a)); if (!activeArms.length) break; }
          else break;
        }
      }
    }
    return writeReport(out, {pilot: Boolean(pilot), provenance: config});
  } finally { sharedWorld?.dispose(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await main()));
