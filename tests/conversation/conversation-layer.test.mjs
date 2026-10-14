// The conversation layer (DS023 "Conversation layer"): the chat's phrasing is data (reply wires of config/knowledge/conversation-v1),
// the reply of a turn is chosen by the JS oracle over the layer's rules, and the self layer (assistant-v1) answers questions about the
// assistant. Owner rules of 2026-10-02: no user-facing text in code; the choice of a reply is made by reasoning, not by if/else.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {validateProgram, parse} from '../../sop/knowledge/index.mjs';
import {seedLayers, seedCircuits} from '../../lib/knowledge-seeds.mjs';
import {replyLayer, say, fill, indexLayer} from '../../sop/replies.mjs';
import {composeReply, chooseReplies, turnFacts} from '../../lib/conversation/index.mjs';
import {statisticsCircuit, topicsOf, plural} from '../../lib/assistant/statistics.mjs';
import {Lexicon} from '../../sop/lexicon.mjs';
import {createWorld} from '../../tools/eval/symbolic-vs-llm/world.mjs';
import {createOracle} from '../../lib/query-author/step-by-step/index.mjs';
import {protocolQuery} from '../../lib/query-author/step-by-step/protocol.mjs';
import {KINDS, SELF_ASPECTS} from '../../lib/query-author/step-by-step/questions.mjs';
import {createAnswerFormulator} from '../../server/answer-language.mjs';
import {repoPath} from '../helpers.mjs';

const read = rel => fs.readFileSync(repoPath(rel), 'utf8');

test('the conversation and self layers pass the knowledge validator', () => {
  for (const id of ['conversation-v1', 'assistant-v1']) {
    const r = validateProgram(seedLayers(id).map(c => ({...c, role: 'knowledge'})), {authoring: true, linking: true});
    assert.deepEqual(r.problems.filter(p => p.severity !== 'warning'), [], id);
  }
});

test('every situation the rules or the renderer can reach has a reply, and every body, opening or closing situation a priority', () => {
  const layer = replyLayer();
  const text = layer.circuits.map(c => c.text).join('\n');
  const priorities = new Set([...text.matchAll(/holds cv_situation_priority (\w+) /g)].map(m => m[1]));
  const reached = new Set([...text.matchAll(/then cv_applies (\w+)/g)].map(m => m[1]).filter(s => !s.startsWith('?')));
  for (const m of text.matchAll(/holds cv_(?:courtesy|opening|closing)_situation \w+ (\w+)/g)) reached.add(m[1]);
  for (const s of reached) {
    assert.ok(layer.bySituation.has(s), `situation ${s} has a reply`);
    assert.ok(priorities.has(s), `situation ${s} has a priority`);
  }
  for (const rel of ['sop/answer-text.mjs', 'lib/conversation/index.mjs', 'sop/replies.mjs']) {
    for (const m of read(rel).matchAll(/\bline\('([a-z_]+)'/g)) if (!m[1].endsWith('_')) assert.ok(layer.bySituation.has('line_' + m[1]), `${rel} uses line_${m[1]}, which the layer phrases`);
  }
});

test('no phrasing in code: the former templates are gone from the renderer modules', () => {
  for (const rel of ['sop/pragmatic-text.mjs', 'sop/unclear.mjs', 'sop/answer-text.mjs', 'lib/conversation/index.mjs', 'server/agent.mjs']) {
    const code = read(rel).split('\n').filter(l => !/^\s*(\*|\/\/|\/\*\*)/.test(l)).join('\n');
    for (const phrase of ['What would you like to know', "You're welcome", 'Did you mean', 'Answer: ', 'Sources used', "I don't know", 'Goodbye']) assert.ok(!code.includes(phrase), `${rel} holds the phrase ${JSON.stringify(phrase)}`);
  }
});

test('a missing layer or slot is a configuration error, never a built-in sentence', () => {
  assert.throws(() => indexLayer([{name: 'empty.sop', text: '# nothing\n'}], 'test'), e => e.code === 'reply_layer_missing');
  assert.throws(() => say('no_such_situation'), e => e.code === 'reply_missing');
  assert.throws(() => fill('Did you mean {{candidate}}?', {}, 'near_candidate'), e => e.code === 'reply_slot_missing');
});

test('the oracle chooses by the layer: an answer outranks small talk, a near name replaces a dry "no answer", the derivation is reported', () => {
  const answered = chooseReplies(turnFacts({status: 'supported', rows: [{x: 'paris'}], pragmatic: [{kind: 'greeting'}]}, {answerText: 'A.'}), {seed: 1});
  assert.equal(answered.body.situation, 'answer_found');
  assert.equal(answered.opening.situation, 'open_greeting');
  const near = composeReply({packet: {status: 'unclear', unclear_kind: 'relation_not_in_memory'}, near: {candidates: [{label: 'Socrates', distance: 1, mention: 'Socrate', relations: []}]}, seed: 1});
  assert.equal(near.reply.body.situation, 'near_candidate');
  assert.match(near.text, /Socrate[\s\S]*Socrates/);
  assert.ok(near.reply.body.why[0].startsWith('cv_applies near_candidate ← rule cv_r_near_candidate'));
  assert.ok(near.reply.body.outranked.includes('relation_missing'));
  const known = composeReply({packet: {status: 'unknown', rows: []}, answerText: 'X.', near: {candidates: [{label: 'Bucharest', distance: 0, mention: 'Bucuresti', relations: [{label: 'capital of'}]}]}, seed: 1});
  assert.equal(known.reply.body.situation, 'answer_open', 'an exact name is known: the answer stays and the relations around it close the reply');
  assert.equal(known.reply.closing.situation, 'near_relations');
  const idle = composeReply({packet: {status: 'unclear', unclear_kind: 'no_request'}, topics: ['countries', 'cities'], seed: 1});
  assert.equal(idle.reply.body.situation, 'no_request_topics');
  assert.match(idle.text, /countries and cities/);
  assert.ok(near.reply.ms < 200, `the in-process oracle is fast (${near.reply.ms} ms)`);
});

test('the self layer statistics are generated deterministically from the lexicon; topics are the largest classes', () => {
  const lexicon = Lexicon.fromCircuits([...seedLayers('assistant-v1'), {name: 'x.sop', text: Array.from({length: 25}, (_, i) => `@city${i} entity\n  kind city\n  label en "City ${i}"\n`).join('\n') + '\n@city entity\n  kind class\n  label en "city"\n'}]);
  const manifest = {id: 'm', name: 'Test memory', facts: 12};
  const a = statisticsCircuit({lexicon, manifest, stats: {knowledge_files: 3, sop_wires: 99}, layers: ['Core (minimal)']});
  assert.equal(a, statisticsCircuit({lexicon, manifest, stats: {knowledge_files: 3, sop_wires: 99}, layers: ['Core (minimal)']}));
  assert.match(a, /holds entity_count city 25/);
  assert.match(a, /holds memory_size "facts" 12/);
  assert.match(a, /holds memory_layer mrp_llm "Test memory"/);
  const check = validateProgram([...seedLayers('assistant-v1'), {name: 'stats.sop', text: a}].map(c => ({...c, role: 'knowledge'})), {authoring: true, linking: true});
  assert.deepEqual(check.problems.filter(p => p.severity !== 'warning' && p.code !== 'unknown_entity'), []);
  assert.ok(topicsOf(lexicon, 10).includes('cities'));
  assert.deepEqual(['city', 'film', 'box', 'person'].map(plural), ['cities', 'films', 'boxes', 'persons']);
});

test('step-by-step kind `self`: one numbered question, then a circuit over the self layer (a random fact samples a relation)', async () => {
  const stats = '@ms1 fact\n  holds memory_size "facts" 7\n@c1 fact\n  holds capital_of paris france\n@c2 fact\n  holds capital_of rome italy\n';
  const world = createWorld(seedLayers('assistant-v1').map(c => c.text).join('\n') + '\n@paris entity\n  label en "Paris"\n@france entity\n  label en "France"\n@rome entity\n  label en "Rome"\n@italy entity\n  label en "Italy"\n' + stats);
  try {
    const run = async (message, aspect) => {
      const chat = async messages => {
        const q = messages.at(-1).content;
        const say = /Which kind of answer/.test(q) ? String(KINDS.findIndex(k => k[0] === 'self') + 1)
          : /What does it want\?/.test(q) ? String(SELF_ASPECTS.findIndex(a => a[0] === aspect) + 1) : '0';
        return {ok: true, text: say, ms: 1, usage: {input_tokens: 1, output_tokens: 1}};
      };
      return protocolQuery({message, lexicon: world.lexicon, repo: world.repo, session: world.session, oracle: createOracle({chat}), method: 'B'});
    };
    const abilities = await run('What can you do?', 'abilities');
    assert.equal(abilities.status, 'validated', JSON.stringify(abilities.validation?.problems));
    assert.match(abilities.sop, /relation "can_do"\n {4}role subject "mrp_llm"/);
    const fact = await run('Tell me a random fact', 'random_fact');
    assert.equal(fact.status, 'validated', JSON.stringify(fact.validation?.problems));
    assert.match(fact.sop, /order random\n {2}limit 1/);
  } finally { world.dispose(); }
});

test('natural phrasing of an English reply: the draft is rewritten by the model, and kept when a name or number is dropped', async () => {
  const replies = ['Paris is the capital of France.', 'It is the capital.'];
  const chat = async () => ({ok: true, text: replies.shift(), model: 'stub'});
  const f = createAnswerFormulator({settings: {mode: 'auto', natural: 'all', providers: ['stub'], timeoutSeconds: 5}, chat});
  const draft = 'The capital of France is Paris.\nParis is the capital of France (memory).';
  const good = await f.formulate({message: 'What is the capital of France?', english: draft, packet: {status: 'supported'}});
  assert.deepEqual([good.applied, good.natural, good.text], [true, true, 'Paris is the capital of France.']);
  const bad = await f.formulate({message: 'What is the capital of France?', english: draft, packet: {status: 'supported'}});
  assert.equal(bad.applied, false);
  assert.match(bad.tried[0].reason, /dropped France, Paris/);
  const off = createAnswerFormulator({settings: {mode: 'auto', natural: 'off', providers: ['stub'], timeoutSeconds: 5}, chat});
  assert.equal((await off.formulate({message: 'Who?', english: draft, packet: {}})).applied, false);
});

test('natural phrasing keeps the user\'s instructed prefix verbatim outside the reworded text', async () => {
  let seen = null;
  const f = createAnswerFormulator({settings: {mode: 'auto', natural: 'all', providers: ['stub'], timeoutSeconds: 5}, chat: async ({prompt}) => { seen = prompt; return {ok: true, text: 'Paris is the capital of France.', model: 'stub'}; }});
  const r = await f.formulate({message: 'What is the capital of France?', english: "I'm here: The capital of France is Paris.", packet: {status: 'supported', reply: {frame: {prefix: "I'm here:"}}}});
  assert.equal(r.text, "I'm here: Paris is the capital of France.");
  assert.ok(!seen.includes("I'm here:"), 'the model never sees the instructed prefix');
});
