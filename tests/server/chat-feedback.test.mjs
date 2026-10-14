// Chat feedback (DS022 "Chat feedback", server/feedback.mjs): POST /v1/feedback validation, the join to the recorded turn, the routing of
// a down vote by its cause, append-only storage, the admin list and the counts. The request parser is the stub; no model is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {productServer, FAMILY} from '../product-helpers.mjs';
import {checkFeedback, feedbackStats, FEEDBACK_CAUSES} from '../../server/feedback.mjs';

const lines = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);

async function withTurn(t) {
  const s = await productServer(t);
  await s.admin('/v1/memories', 'POST', {name: 'Family', id: 'family', circuits: [{name: 'family', text: FAMILY}]});
  const session = (await s.user('/v1/sessions', 'POST', {base: 'family'})).body.id;
  const chat = await s.user('/v1/chat/completions', 'POST', {model: 'chatsop-local', messages: [{role: 'user', content: 'Does Ana like Alpha Lab?'}], session_id: session});
  assert.equal(chat.status, 200, JSON.stringify(chat.body));
  const files = s.server.feedback.files;
  return {s, session, chat, files};
}

test('checkFeedback validates the vote body', () => {
  const ok = {session: 's1', turn: 1, vote: 'up'};
  assert.deepEqual(checkFeedback(ok), {...ok, cause: null, comment: null});
  assert.equal(checkFeedback({session: 's1', turn: 2, vote: 'down', cause: 'wrong_answer', comment: '  no  '}).comment, 'no');
  for (const [body, code] of [[null, 'invalid_request'], [{...ok, extra: 1}, 'unsupported_parameter'], [{...ok, session: 'Bad/Id'}, 'invalid_parameter'],
    [{...ok, turn: 0}, 'invalid_parameter'], [{...ok, turn: '1'}, 'invalid_parameter'], [{...ok, vote: 'meh'}, 'invalid_parameter'],
    [{...ok, vote: 'down'}, 'invalid_parameter'], [{...ok, vote: 'down', cause: 'other'}, 'invalid_parameter'], [{...ok, cause: 'wrong_answer'}, 'invalid_parameter'],
    [{...ok, comment: 'x'.repeat(2001)}, 'invalid_parameter']]) {
    assert.throws(() => checkFeedback(body), e => e.status === 400 && e.code === code, JSON.stringify(body)?.slice(0, 80));
  }
});

test('feedbackStats counts the latest vote of each turn', () => {
  const st = feedbackStats([
    {session: 'a', turn: 1, user: 'u', vote: 'down', cause: 'wrong_answer'},
    {session: 'a', turn: 1, user: 'u', vote: 'up', cause: null},
    {session: 'a', turn: 2, user: 'u', vote: 'down', cause: 'bad_wording'},
  ]);
  assert.deepEqual(st.votes, {up: 1, down: 1});
  assert.equal(st.causes.bad_wording, 1);
  assert.equal(st.causes.wrong_answer, 0);
  assert.equal(st.turns, 2);
  assert.equal(st.records, 3);
});

test('the chat answer carries the turn and the trace id, and the turn record is stored', async t => {
  const {s, session, chat} = await withTurn(t);
  assert.equal(chat.body.chatSop.turn, 1);
  assert.equal(chat.body.chatSop.trace_id, chat.body.id);
  const turn = await s.user(`/v1/sessions/${session}/turns/1`);
  assert.equal(turn.status, 200);
  assert.equal(turn.body.message, 'Does Ana like Alpha Lab?');
  assert.equal(turn.body.trace_id, chat.body.id);
  assert.equal(turn.body.model, 'stub/model');
  assert.ok(turn.body.model_sop.includes('@q query'));
  assert.equal(typeof turn.body.text, 'string');
  assert.equal((await s.user(`/v1/sessions/${session}/turns/2`)).status, 404);
  const second = await s.user('/v1/chat/completions', 'POST', {model: 'chatsop-local', messages: [{role: 'user', content: 'Does Ana like Alpha Lab?'}], session_id: session});
  assert.equal(second.body.chatSop.turn, 2);
});

test('POST /v1/feedback: validation, authorisation and the unknown turn', async t => {
  const {s, session} = await withTurn(t);
  assert.equal((await s.call('/v1/feedback', {method: 'POST', body: {session, turn: 1, vote: 'up'}})).status, 401, 'needs authentication');
  assert.equal((await s.user('/v1/feedback', 'POST', {session, turn: 1, vote: 'down'})).status, 400, 'a down vote needs a cause');
  assert.equal((await s.user('/v1/feedback', 'POST', {session, turn: 9, vote: 'up'})).status, 404);
  assert.equal((await s.user('/v1/feedback', 'POST', {session: 'nope', turn: 1, vote: 'up'})).status, 404);
  assert.equal((await s.user('/v1/feedback', 'GET')).status, 403, 'the list needs the administrator session');
  assert.equal((await s.user('/v1/feedback/stats')).status, 200);
});

test('a down vote is routed by its cause; the log is append-only and a repeated vote is routed once', async t => {
  const {s, session, files} = await withTurn(t);
  const vote = (cause, comment) => s.user('/v1/feedback', 'POST', {session, turn: 1, vote: 'down', cause, ...(comment ? {comment} : {})});

  const up = await s.user('/v1/feedback', 'POST', {session, turn: 1, vote: 'up'});
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(up.body.routed, null);

  const r1 = await vote('not_understood', 'it read Ana as a place');
  assert.deepEqual(r1.body.routed, {route: 'formalization', kind: 'wrong'});
  let inbox = lines(files.inbox);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].source, 'chat-feedback');
  assert.equal(inbox[0].kind, 'wrong');
  assert.equal(inbox[0].message, 'Does Ana like Alpha Lab?');
  assert.ok(inbox[0].circuit.includes('@q query'));
  assert.equal(inbox[0].detail, 'it read Ana as a place');
  assert.equal(inbox[0].ref, `${session}#1`);

  assert.deepEqual((await vote('unnecessary_question')).body.routed, {route: 'formalization', kind: 'unclear'});
  inbox = lines(files.inbox);
  assert.equal(inbox.at(-1).kind, 'unclear');

  assert.deepEqual((await vote('missing_knowledge')).body.routed, {route: 'knowledge-gap'});
  const gap = lines(files['knowledge-gap']).at(-1);
  assert.equal(gap.source, 'chat-feedback');
  assert.equal(gap.memory, 'family');
  assert.equal(files['knowledge-gap'], path.join(s.chatData.root, 'query-gaps.jsonl'), 'the queue logGap writes');

  assert.deepEqual((await vote('bad_wording')).body.routed, {route: 'reply-layer'});
  assert.equal(lines(files['reply-layer']).at(-1).trace_id.startsWith('chatcmpl-'), true);

  assert.deepEqual((await vote('wrong_answer')).body.routed, {route: 'answer-wrong'});
  assert.equal(lines(files['answer-wrong']).length, 1);

  const again = await vote('wrong_answer');
  assert.equal(again.body.duplicate, true);
  assert.equal(again.body.routed, null);
  assert.equal(lines(files['answer-wrong']).length, 1, 'routed once');

  const log = lines(files.log);
  assert.equal(log.length, 7, 'every vote is appended');
  assert.deepEqual(log.map(r => r.vote), ['up', 'down', 'down', 'down', 'down', 'down', 'down']);
  assert.equal(log[1].record.message, 'Does Ana like Alpha Lab?');
  assert.ok(log[1].record.trace_id);
  const before = fs.readFileSync(files.log, 'utf8');
  await s.user('/v1/feedback', 'POST', {session, turn: 1, vote: 'up'});
  assert.ok(fs.readFileSync(files.log, 'utf8').startsWith(before), 'earlier lines are never rewritten');

  const list = await s.admin('/v1/feedback');
  assert.equal(list.status, 200);
  assert.equal(list.body.data[0].vote, 'up', 'newest first');
  assert.deepEqual(Object.keys(list.body.groups).sort(), ['up', ...Object.keys(FEEDBACK_CAUSES)].sort());
  assert.equal(list.body.groups.wrong_answer.length, 2);
  const stats = await s.user('/v1/feedback/stats');
  assert.deepEqual(stats.body.votes, {up: 1, down: 0}, 'the latest vote of the turn counts');
  assert.equal(stats.body.records, 8);
});
