// The base-memory composer (DS022 "Composing a base memory"): a base memory is built or refreshed from chosen layers through the
// ordinary import path; seeds and memories with circuits of their own are never replaced; the chat's reply memory is composed from
// config conversation.layers when missing, its conversation layers are the reply layer, and rebuilding it reloads the reply layer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {ChatData} from '../../lib/chat-data/index.mjs';
import {BaseMemories, DEFAULT_STRATEGY} from '../../lib/chat-data/memories.mjs';
import {ensureSeedMemories} from '../../lib/knowledge-seeds.mjs';
import {composableLayers, compose, conversationCircuits, ensureReplyMemory, isConversationLayer} from '../../lib/chat-data/composer.mjs';
import {replyLayer, setReplyLayer, shippedCircuits} from '../../sop/replies.mjs';
import {productServer} from '../product-helpers.mjs';
import {seedMemoriesRoot, tempDir} from '../helpers.mjs';

// The seed memories take most of a minute to build: they are built once per content of what shapes them and shared by the tests
// (tests/helpers.mjs seedMemoriesRoot, the default strategy), then copied into each test's own chat data root.
function memoriesIn(t) {
  const root = path.join(tempDir(t, 'chatsop-composer-'), 'chat_data');
  fs.cpSync(path.join(seedMemoriesRoot({strategy: DEFAULT_STRATEGY}), 'chat_data'), root, {recursive: true});
  const chatData = ChatData.open({chatData: {root}}, {});
  const memories = new BaseMemories({chatData});
  assert.equal(ensureSeedMemories(memories).length, 0, 'the copied root holds every seed');
  return memories;
}

test('the composer lists the layers and builds a memory from them; a composed memory is refreshed, seeds and own circuits are protected', t => {
  const memories = memoriesIn(t);
  const layers = composableLayers(memories);
  const core = layers.find(l => l.id === 'core-min');
  assert.ok(core.seed && !core.replaceable && core.role === 'knowledge');
  assert.equal(layers.find(l => l.id === 'conversation-v1').role, 'conversation');
  const built = compose(memories, {id: 'composed-a', name: 'Composed A', layers: ['demo']});
  assert.equal(built.replaced, false);
  assert.ok(built.validated);
  assert.deepEqual(built.memory.imports.map(l => l.id), ['core-min', 'demo'], 'the layers are flattened in import order');
  assert.deepEqual(built.memory.composition.layers, ['demo']);
  assert.ok(memories.lexicon('composed-a').predicates, 'the composed memory has a lexicon over its layers');
  const again = compose(memories, {id: 'composed-a', layers: ['core-min']});
  assert.equal(again.replaced, true);
  assert.equal(again.memory.name, 'Composed A', 'a refresh keeps the name');
  assert.deepEqual(again.memory.imports.map(l => l.id), ['core-min']);
  assert.ok(composableLayers(memories).find(l => l.id === 'composed-a').replaceable);
  assert.throws(() => compose(memories, {id: 'core-min', layers: ['demo']}), e => e.code === 'seed_memory' && e.status === 409);
  memories.addKnowledge('composed-a', {circuits: [{name: 'own', text: '@thing_x entity\n  kind class\n  label en "thing x"\n'}], approvedBy: 'test'});
  assert.throws(() => compose(memories, {id: 'composed-a', layers: ['demo']}), e => e.code === 'memory_has_circuits' && e.status === 409);
  assert.throws(() => compose(memories, {id: 'composed-b', layers: ['no-such-layer']}), e => e.code === 'unknown_layer' && e.status === 404);
  assert.throws(() => compose(memories, {id: 'composed-b', layers: ['demo', 'demo']}), e => e.code === 'invalid_layers');
  assert.throws(() => compose(memories, {id: 'composed-b', layers: []}), e => e.code === 'invalid_layers');
});

test('the reply memory is composed from the configured layers when missing; only its conversation layers form the reply layer', t => {
  const memories = memoriesIn(t);
  assert.deepEqual(ensureReplyMemory(memories, {}), {id: 'conversation-v1', created: false, stale: []}, 'without configuration the seed conversation-v1 is the reply memory');
  const first = ensureReplyMemory(memories, {conversation: {memory: 'conv-test', layers: ['conversation-v1', 'smalltalk-core-v1', 'smalltalk-empathy-v1']}});
  assert.deepEqual(first, {id: 'conv-test', created: true, stale: []});
  assert.equal(ensureReplyMemory(memories, {conversation: {memory: 'conv-test', layers: ['conversation-v1']}}).created, false, 'an existing reply memory is kept (the composer is the authority)');
  assert.ok(isConversationLayer('smalltalk-core-v1') && !isConversationLayer('core-min'));
  const circuits = conversationCircuits(memories, 'conv-test');
  assert.ok(circuits.every(c => /^(conversation-v1|smalltalk-core-v1|smalltalk-empathy-v1):/.test(c.name)), 'core-min, imported by conversation-v1, is not part of the reply layer');
  assert.ok(circuits.some(c => c.name.startsWith('smalltalk-core-v1:')));
  assert.deepEqual(conversationCircuits(memories, 'conversation-v1').map(c => c.text), shippedCircuits().map(c => c.text), 'the seed alone is its own circuits');
});

test('GET and POST /v1/memory-composer: list, build, refresh, protect; rebuilding the reply memory reloads the reply layer', async t => {
  t.after(() => setReplyLayer(shippedCircuits(), 'shipped'));
  const s = await productServer(t, {config: {conversation: {memory: 'conv-api', layers: ['conversation-v1', 'smalltalk-core-v1']}}});
  const list = await s.user('/v1/memory-composer');
  assert.equal(list.status, 200);
  assert.equal(list.body.object, 'memory.composer');
  assert.equal(list.body.reply_memory, 'conv-api');
  assert.ok(list.body.layers.some(l => l.id === 'smalltalk-core-v1' && l.role === 'conversation' && l.counts?.replies > 0));
  assert.ok([...replyLayer().replies.keys()].some(id => id.startsWith('stc_')), 'the server replies from the composed reply memory');
  const built = await s.user('/v1/memory-composer', 'POST', {id: 'composed-api', name: 'API composed', layers: ['demo']});
  assert.equal(built.status, 201, built.text);
  assert.equal(built.body.object, 'memory.composed');
  assert.equal(built.body.replaced, false);
  assert.equal(built.body.reply_layer, undefined);
  assert.equal((await s.user('/v1/memory-composer', 'POST', {id: 'composed-api', layers: ['core-min']})).body.replaced, true);
  assert.equal((await s.user('/v1/memory-composer', 'POST', {id: 'core-min', layers: ['demo']})).status, 409);
  assert.equal((await s.user('/v1/memory-composer', 'POST', {id: 'composed-api', layers: ['nope']})).status, 404);
  assert.equal((await s.user('/v1/memory-composer', 'POST', {id: 'composed-api', layers: ['demo'], extra: 1})).status, 400);
  const reply = await s.admin('/v1/memory-composer', 'POST', {id: 'conv-api', layers: ['conversation-v1']});
  assert.equal(reply.status, 201, reply.text);
  assert.equal(reply.body.reply_layer.memory, 'conv-api');
  assert.ok(![...replyLayer().replies.keys()].some(id => id.startsWith('stc_')), 'the reply layer was reloaded without the collection');
  assert.equal((await s.call('/v1/memory-composer')).status, 401, 'authentication is required');
});
