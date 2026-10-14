/**
 * The chat turn of an evaluation harness: the same request parser settings as the chat (or one tier of them, like with like) and the
 * same turn as the chat, through ChatSOPAdapter (lib/adapter/chat-turn.mjs, which server/http.mjs calls too). No harness keeps its own
 * copy of the formalization and solving glue (AGENTS.md "ChatSOPAdapter"), so a result measured offline is the result the chat gives.
 *
 *   const chat = harnessChat({config, tier: 'tiny', source: 'eval:kbqa'});
 *   const {result, parse} = await chat.turn(entry, question, {lexicon});   // entry: a SessionStore entry (tools/eval/lib/session.mjs)
 *   await chat.close();
 *
 * `tier` asks the step-by-step questions on one Ploinky tier (null: the product ladder); `strategy` the formalization strategy;
 * `tags` ({purpose, run, noFallback}) tag the Ploinky calls; `mode` the adapter mode (null: config adapter.mode, the chat default);
 * `parserSettings` replaces the settings outright. `turn(..., {author})` replaces the circuit author (stored or cached circuits).
 */
import {createQueryParser} from '../../../server/query-parser.mjs';
import {createChatSOPAdapter} from '../../../lib/adapter/index.mjs';
import {chatTurn} from '../../../lib/adapter/chat-turn.mjs';
import {tierParserSettings} from './tier-parser.mjs';

/** True when an error of a turn is the request parser's (no circuit could be written): the record's `parser_failed`. */
export const parserFailed = error => error?.code === 'parse_failed' || error?.code === 'parse_unavailable';

export function harnessChat({config, tier = null, strategy = null, tags = null, mode = null, source = 'eval', parserSettings = null, cacheEntries = 0} = {}) {
  const queryParser = createQueryParser({settings: parserSettings ?? tierParserSettings(config, {tier, strategy, cacheEntries, ...(tags ? {tags} : {})})});
  const adapter = createChatSOPAdapter({config});
  return {
    queryParser, adapter, settings: queryParser.settings,
    /** One chat turn of a SessionStore entry: {result, parse, summary, author, mode}; throws like the chat (error.parse set). */
    turn: (entry, message, {lexicon, author = null, options = {}} = {}) => chatTurn({adapter, agent: entry.agent, queryParser, lexicon, message, mode, options, source, author}),
    async close() { adapter.dispose(); await queryParser.stop(); },
  };
}
