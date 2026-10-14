// The small-talk collections (config/knowledge/smalltalk-*-v1, tools/smalltalk/build.mjs; DS022 "Composing a base memory"): each
// loads alone (it imports conversation-v1) or with the others, passes the knowledge validator, uses only the slots its situations get,
// and the JS oracle chooses its replies by the layer's own data: new situations by pragmatic kind and priority, the variants that name
// the memory's topics, the formal and playful registers (only while the conversation's register is theirs), data tie-breaks, and the
// answer still first.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {SEEDS_DIR, seedCircuits, seedInfo} from '../../lib/knowledge-seeds.mjs';
import {indexLayer, fill} from '../../sop/replies.mjs';
import {chooseReplies, turnFacts} from '../../lib/conversation/index.mjs';
import {COLLECTIONS, TAXONOMY, checkCollections, items, nearDuplicate, distinct, diverse} from '../../tools/smalltalk/build.mjs';

const ids = Object.values(COLLECTIONS).map(c => c.id);
const layerOf = list => indexLayer(['conversation-v1', ...list].flatMap(id => seedCircuits(id).map(c => ({name: `${id}:${c.file}`, text: c.text}))), list.join('+') || 'conversation-v1');
const DEFAULT = ['smalltalk-core-v1', 'smalltalk-empathy-v1', 'smalltalk-self-v1', 'smalltalk-playful-v1'];
const courtesy = (...kinds) => turnFacts({status: 'courtesy', pragmatic: kinds.map(kind => ({kind, score: 1}))}, {});

test('the collections pass the knowledge validator alone and together, use only their slots and have no priority ties', () => {
  assert.deepEqual(checkCollections(), []);
});

test('every collection has a manifest with licence, provenance (inspired-by, no text copied) and counts that match its wires', () => {
  for (const id of ids) {
    assert.ok(fs.existsSync(path.join(SEEDS_DIR, id, 'seed.json')), id);
    const info = seedInfo(id);
    assert.deepEqual(info.imports, ['conversation-v1'], `${id} loads alone over conversation-v1`);
    assert.equal(info.role, 'conversation');
    assert.ok(info.licence && info.provenance?.inspired_by?.length && info.provenance.inspired_by.every(x => x.text_copied === false), id);
    const replies = seedCircuits(id).flatMap(c => [...c.text.matchAll(/^@\S+ reply$/gm)]).length;
    assert.equal(info.counts.replies, replies, `${id} counts its replies`);
    assert.ok(replies > 0, `${id} holds replies`);
  }
  assert.equal(seedInfo('smalltalk-professional-v1').group, 'register');
});

test('the oracle picks the collections\' situations by the layer\'s data: kinds, priorities, topics variants, the answer first', () => {
  const layer = layerOf(DEFAULT);
  assert.equal(chooseReplies(courtesy('grief'), {layer, seed: 1}).body.situation, 'empathy_grief');
  assert.equal(chooseReplies(courtesy('greeting', 'grief'), {layer, seed: 1}).body.situation, 'empathy_grief', 'grief outranks a greeting');
  assert.equal(chooseReplies(courtesy('greeting', 'how_are_you'), {layer, seed: 1}).body.situation, 'smalltalk_how_are_you');
  assert.equal(chooseReplies(courtesy('crisis', 'sadness'), {layer, seed: 1}).body.situation, 'empathy_crisis');
  assert.equal(chooseReplies(courtesy('ask_abilities'), {layer, seed: 1}).body.situation, 'self_abilities');
  const withTopics = turnFacts({status: 'courtesy', pragmatic: [{kind: 'ask_abilities'}]}, {topics: ['cities']});
  assert.equal(chooseReplies(withTopics, {layer, seed: 1}).body.situation, 'self_abilities_topics');
  assert.equal(chooseReplies(courtesy('greeting'), {layer, seed: 1}).body.situation, 'courtesy_greeting', 'without the professional collection the base situation is used');
  const answered = chooseReplies(turnFacts({status: 'supported', rows: [{x: 'paris'}], pragmatic: [{kind: 'how_are_you'}]}, {answerText: 'A.'}), {layer, seed: 1});
  assert.equal(answered.body.situation, 'answer_found', 'an answer still outranks small talk');
  assert.equal(answered.opening.situation, 'open_how_are_you');
  assert.equal(chooseReplies(turnFacts({status: 'unclear', unclear_kind: 'relation_not_in_memory'}, {}), {layer, seed: 1}).body.situation, 'relation_missing');
});

test('the register is per conversation: the formal and playful variants win only while the user\'s register instruction is active', () => {
  const all = layerOf([...DEFAULT, 'smalltalk-professional-v1']);
  assert.equal(chooseReplies(courtesy('greeting'), {layer: all, seed: 1}).body.situation, 'courtesy_greeting', 'no register: the base situation');
  const formal = chooseReplies([...courtesy('greeting'), 'cv_instruction_active formal'], {layer: all, seed: 1});
  assert.equal(formal.body.situation, 'courtesy_greeting_formal');
  assert.ok(formal.body.why.some(l => l.includes('stf_r_formal')) && formal.body.why.some(l => l.includes('cv_r_register')), 'the derivation names the register rules');
  assert.equal(chooseReplies([...courtesy('grief'), 'cv_instruction_active formal'], {layer: all, seed: 1}).body.situation, 'empathy_grief_formal');
  assert.equal(chooseReplies([...courtesy('greeting'), 'cv_instruction_active playful'], {layer: all, seed: 1}).body.situation, 'courtesy_greeting_playful');
  const plain = layerOf(['smalltalk-core-v1']), playful = layerOf(['smalltalk-core-v1', 'smalltalk-playful-v1']);
  assert.equal(playful.bySituation.get('courtesy_greeting').length, plain.bySituation.get('courtesy_greeting').length, 'playful variants are their own situation');
  assert.ok(playful.bySituation.get('courtesy_greeting_playful').length > 0);
});

test('ties between situations of one priority are broken by data (cv_situation_outranks), never by the order of the replies', () => {
  const layer = layerOf(DEFAULT);
  // ask_joke and out_of_scope_task both select a body at priority 78; the taxonomy's tie_rank puts the joke first.
  const joke = chooseReplies(courtesy('out_of_scope_task', 'ask_joke'), {layer, seed: 1});
  assert.equal(joke.body.situation, 'playful_joke');
  assert.equal(joke.body.tie, undefined, 'no tie left open');
  for (const seed of [1, 2, 3]) assert.equal(chooseReplies(courtesy('ask_joke', 'out_of_scope_task'), {layer, seed}).body.situation, 'playful_joke');
});

test('every reply of the collections fills from the slots its situation gets', () => {
  const slots = {topics: 'cities and rivers', readings: '(1) a\n(2) b', mention: 'Socrate', candidate: 'Socrates', candidate_description: 'a philosopher', relations: '"born in"', aside_fact: 'Paris is in France.'};
  for (const c of Object.values(COLLECTIONS)) for (const r of layerOf([c.id]).replies.values()) if (r.id.startsWith(c.prefix + '_')) assert.doesNotThrow(() => fill(r.text, slots, r.situation), `${r.id}`);
});

test('the build is deterministic structure: items name only allowed slots, the diversity filter drops near duplicates', () => {
  const its = items();
  assert.equal(its.length, TAXONOMY.situations.length);
  for (const it of its) for (const s of it.required) assert.ok(it.allowed.includes(s), `${it.id}: required slot ${s} is allowed`);
  assert.ok(nearDuplicate('Hello! What can I do for you?', 'Hello! What can I do for you today?'));
  assert.ok(!nearDuplicate('Hello! What can I do for you?', 'Good to see you. Ask me anything.'));
  assert.deepEqual(diverse(['Hi there, what can I look up?', 'Hi there, what can I look up for you?', 'Good evening.'], {cap: 5}).kept, ['Hi there, what can I look up?', 'Good evening.']);
  assert.ok(distinct(['a b c', 'a b d'], 1) < 1 && distinct(['a b c', 'd e f'], 2) === 1);
});
