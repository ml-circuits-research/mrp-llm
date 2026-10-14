// One chat turn through ChatSOPAdapter (lib/adapter/chat-turn.mjs), the glue the HTTP chat and every evaluation harness share
// (tools/eval/lib/chat-turn.mjs): the circuit author is the chat's (the request parser with the message language), the stepwise result is
// the agent's own turn with the adapter summary and the parse record on its packet, a parser failure carries its parse record, and a
// harness's own circuit author (stored circuits) replaces the parser without another code path. Offline: stub parser, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Repository} from '../../memory/repository.mjs';
import {demoLexicon} from '../../lib/knowledge-seeds.mjs';
import {Agent} from '../../server/agent.mjs';
import {createChatSOPAdapter} from '../../lib/adapter/index.mjs';
import {chatTurn} from '../../lib/adapter/chat-turn.mjs';
import {harnessChat, parserFailed} from '../../tools/eval/lib/chat-turn.mjs';
import {STUB_QUERY, stubQueryParser, tempDir} from '../helpers.mjs';

const agentIn = t => {
  const repo = new Repository(tempDir(t, 'chat-turn-'));
  repo.init('base');
  return new Agent({repo, session: repo.session('base', 'u', 'c'), lexicon: demoLexicon(), config: {}});
};

test('stepwise: the result is the agent turn with the adapter summary and the parse record; the parser sees the message language', async t => {
  const agent = agentIn(t), lexicon = demoLexicon();
  const seen = [];
  const parser = stubQueryParser();
  const queryParser = {...parser, parse: async request => { seen.push(request); return parser.parse(request); }};
  const adapter = createChatSOPAdapter({config: {}});
  const {result, parse, mode, summary} = await chatTurn({adapter, agent, queryParser, lexicon, message: 'Does Ana like Alpha Lab?', source: 'eval:test'});
  assert.equal(mode, 'stepwise');
  assert.equal(result.sop, STUB_QUERY);
  assert.equal(result.packet.adapter.mode, 'stepwise');
  assert.equal(result.packet.adapter.path, 'stepwise');
  assert.equal(result.packet.parse, parse);
  assert.equal(parse.model, 'stub/model');
  assert.equal(summary.verification.status, 'unverified');
  assert.deepEqual(seen.map(r => [r.source, r.messageLanguage]), [['eval:test', 'en']]);
});

test('a parser that writes no circuit fails the turn with its parse record (a harness records parser_failed)', async t => {
  const agent = agentIn(t);
  const adapter = createChatSOPAdapter({config: {}});
  const error = await chatTurn({adapter, agent, queryParser: stubQueryParser({available: false}), lexicon: demoLexicon(), message: 'Does Ana like Alpha Lab?'}).catch(e => e);
  assert.equal(error.code, 'parse_unavailable');
  assert.equal(error.parse.failed, 'switched off');
  assert.ok(parserFailed(error));
  assert.ok(!parserFailed(new Error('engine')));
});

test('harnessChat: a stored circuit replaces the parser and runs the same chat turn (no model call)', async t => {
  const agent = agentIn(t);
  const chat = harnessChat({config: {}, source: 'eval:test'});
  t.after(() => chat.close());
  const {result, parse} = await chat.turn({agent}, 'Does Ana like Alpha Lab?', {lexicon: demoLexicon(), author: {id: 'replay', formalize: async () => STUB_QUERY}});
  assert.equal(result.sop, STUB_QUERY);
  assert.equal(result.packet.adapter.mode, 'stepwise');
  assert.equal(parse, null, 'a stored circuit has no parse record');
  assert.equal(chat.adapter.settings.mode, 'stepwise');
});
