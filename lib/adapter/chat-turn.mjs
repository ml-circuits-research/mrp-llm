/**
 * One chat turn through ChatSOPAdapter: the glue the HTTP chat (server/http.mjs) and every evaluation harness share, so a result
 * measured offline is the result the chat gives (AGENTS.md "ChatSOPAdapter", owner 2026-10-03). It builds the chat's circuit author
 * (`parserFormalizer` over the request parser, with the message language and the session's strategy), answers through the adapter in
 * the chosen mode and returns the chat turn's result:
 *
 *   stepwise          the agent's own turn result (server/agent.mjs) with `packet.adapter` (the answer packet without the runtime packet)
 *   routed, direct-verified   the reply of the conversation layer (lib/adapter/reply.mjs), recorded in the agent's recent turns like a
 *                     stepwise turn, with the circuits of the answering path
 * In every mode `packet.parse` is the request parser's parse record. The answer formulation in the user's language and the transcript
 * are the HTTP layer's (server/http.mjs); a harness compares the deterministic English answer.
 *
 * `author` replaces the chat's circuit author (a harness that replays stored circuits or caches formalizations); `strategy` is the
 * session's formalization strategy setting (null: the request parser's own).
 */
import {parserFormalizer} from './modes/stepwise.mjs';
import {adapterReply} from './reply.mjs';
import {strategyRequest} from '../../server/status.mjs';
import {looksEnglish} from '../../server/answer-language.mjs';

export async function chatTurn({adapter, agent, queryParser = null, lexicon, message, mode = null, options = {}, source = 'chat', preferredModel = null, strategy = null, author = null, run = null, cache = null}) {
  const formalizer = author ?? parserFormalizer(queryParser, {lexicon, source, preferredModel, request: {messageLanguage: looksEnglish(message) ? 'en' : 'other', ...strategyRequest(queryParser, strategy)}});
  const answered = await adapter.answer({message, mode: mode ?? adapter.settings.mode, options, stepwise: {agent, formalizer}, lexicon, run, cache})
    .catch(error => { error.parse = error.parse ?? formalizer.parse ?? null; throw error; });
  const parse = formalizer.parse ?? null;
  if (answered.mode !== 'stepwise') { formalizer.id = 'adapter:' + answered.mode; formalizer.label = 'ChatSOPAdapter ' + answered.mode; }
  const {packet: _runtimePacket, turn: _turn, ...summary} = answered;
  let result;
  if (answered.mode === 'stepwise') {
    result = answered.turn;
    if (result.packet) result.packet.adapter = summary;
  } else {
    const out = adapterReply(agent, answered, {text: message});
    const circuits = answered.circuits.map(c => c.sop).join('\n\n');
    agent.last = out;
    agent.recent.push({user: message.slice(0, 400), response: out.text.slice(0, 500)});
    agent.recent = agent.recent.slice(-3);
    result = {sop: circuits, executionSop: circuits, cnl: out.text, text: out.text, englishText: out.text, packet: out.packet, trace: [], userStatements: [], carriedStatements: [], modelAssumptions: [], answerLanguage: 'en',
      formalization: {model: 'adapter:' + answered.mode, ms: answered.timings.total}};
  }
  if (parse && result.packet) result.packet.parse = parse;
  return {result, answered, summary, author: formalizer, parse, mode: answered.mode};
}
