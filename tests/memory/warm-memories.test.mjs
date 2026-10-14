// Warming of base memories at server start (server/warm-memories.mjs, setting `server.warmMemories` of config/runtime.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import {ChatData} from '../../lib/chat-data/index.mjs';
import {BaseMemories} from '../../lib/chat-data/memories.mjs';
import {Repository} from '../../memory/repository.mjs';
import {warmMemories} from '../../server/warm-memories.mjs';
import {FAMILY, runtimeConfig} from '../product-helpers.mjs';
import {tempDir} from '../helpers.mjs';

test('warmMemories decodes the named base memories read-only and skips a missing one', t => {
  const bm = new BaseMemories({chatData: ChatData.open({chatData: {root: tempDir(t, 'warm-') + '/cd'}}, {}), memory: runtimeConfig().memory});
  const m = bm.create({name: 'family', strategy: 'sqlite'});
  bm.addKnowledge(m.id, {circuits: [{name: 'family', text: FAMILY}], approvedBy: 'admin'});
  Repository.clearShared();
  const [warm, missing] = warmMemories({memories: bm, ids: [m.id, 'no-such-memory']});
  assert.equal(warm.id, m.id);
  assert.equal(warm.facts, 3);
  assert.ok(warm.layers >= 1 && warm.ms >= 0);
  assert.equal(missing.skipped, 'unknown base memory');
  assert.deepEqual(bm.facts(m.id).parent.length, 3, 'nothing was written');
  assert.deepEqual(warmMemories({memories: bm, ids: []}), []);
});
