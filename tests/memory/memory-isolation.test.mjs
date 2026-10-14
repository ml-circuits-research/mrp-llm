// Fork and session-clone isolation (DS022, DS018, DS021): a child never shares a mutable file with its parent, for every memory strategy.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {ChatData} from '../../lib/chat-data/index.mjs';
import {BaseMemories, STRATEGIES, DEFAULT_STRATEGY, cloneRepository, ensureDefaultBase} from '../../lib/chat-data/memories.mjs';
import {Sessions} from '../../lib/chat-data/sessions.mjs';
import {FAMILY, runtimeConfig} from '../product-helpers.mjs';
import {seedMemoriesRoot, tempDir} from '../helpers.mjs';

const memory = runtimeConfig().memory;
// `seeds`: the root starts with the seed memories ensureDefaultBase would build (same strategy), copied from the shared fixture built
// once per content of what shapes them (tests/helpers.mjs seedMemoriesRoot), so the test does not pay most of a minute for them.
const SEED_STRATEGY = STRATEGIES.includes(memory.engine) ? memory.engine : DEFAULT_STRATEGY;
const open = (t, {seeds = false} = {}) => {
  const root = tempDir(t, 'iso-') + '/cd';
  if (seeds) fs.cpSync(path.join(seedMemoriesRoot({strategy: SEED_STRATEGY}), 'chat_data'), root, {recursive: true});
  const chatData = ChatData.open({chatData: {root}}, {});
  const memories = new BaseMemories({chatData, memory});
  return {chatData, memories, sessions: new Sessions({chatData, memories, memory})};
};
const parents = (memories, id) => (memories.facts(id).parent ?? []).map(r => r.args.join('>')).sort();
const sessionParents = (sessions, id) => {
  const repo = sessions.repository(id);
  const s = repo.session('main', 'reader', 'probe');
  const rows = repo.recall(s, {p: 'parent', a: ['?x', '?y'], neg: false}, {asof: Infinity}, {limit: 100}).rows.map(r => r.atom.a.join('>')).sort();
  repo.closeSession(s);
  return rows;
};
const fact = (id, a, b) => `@${id} fact\n  holds parent ${a} ${b}\n  source "t"\n`;
const snapshotOf = dir => Object.fromEntries(['snapshots', 'shards'].flatMap(d => fs.existsSync(path.join(dir, d)) ? fs.readdirSync(path.join(dir, d)).map(n => [`${d}/${n}`, fs.readFileSync(path.join(dir, d, n), 'utf8')]) : []));

test('the default strategy is sqlite', t => {
  assert.equal(DEFAULT_STRATEGY, 'sqlite');
  assert.equal(memory.engine, 'sqlite');
  const {memories} = open(t);
  assert.equal(memories.create({name: 'x'}).strategy, 'sqlite');
  assert.equal(memories.importMemory({name: 'y', approvedBy: 'admin'}).strategy, 'sqlite');
});

test('the default base memory is sqlite; a filled one is kept', t => {
  const {memories} = open(t, {seeds: true});
  memories.create({id: 'default', name: 'Default (empty)'});
  assert.equal(ensureDefaultBase(memories, {memory}), 'default');
  assert.equal(memories.manifest('default').strategy, 'sqlite');
  assert.throws(() => memories.create({id: 'assoc', name: 'Assoc', strategy: 'holo-memory'}), /strategy must be one of sqlite/);
  memories.create({id: 'filled', name: 'Filled'});
  memories.addKnowledge('filled', {circuits: [{name: 'family', text: FAMILY}], approvedBy: 'admin'});
  assert.equal(ensureDefaultBase(memories, {memory, chatData: {defaultBase: 'filled'}}), 'filled');
  assert.equal(memories.manifest('filled').strategy, 'sqlite');
});

for (const strategy of STRATEGIES) {
  test(`isolation (${strategy}): a fork and a session clone never change their parent`, t => {
    const {memories, sessions} = open(t);
    const parent = memories.create({id: 'p', name: 'p', strategy});
    memories.addKnowledge('p', {circuits: [{name: 'family', text: FAMILY}], approvedBy: 'admin'});
    const before = snapshotOf(path.join(memories.dir('p'), 'repo'));
    const circuitsBefore = memories.circuits('p').length;

    const {memory: child, method} = memories.fork('p', {name: 'child'});
    assert.equal(method, 'clone');
    memories.addKnowledge(child.id, {circuits: [{name: 'more', text: fact('f9', 'di', 'eve')}], approvedBy: 'admin'});
    assert.deepEqual(parents(memories, child.id), ['ann>bob', 'bob>cy', 'cy>di', 'di>eve']);
    assert.deepEqual(parents(memories, parent.id), ['ann>bob', 'bob>cy', 'cy>di'], 'the parent did not change');
    assert.deepEqual(snapshotOf(path.join(memories.dir('p'), 'repo')), before, 'the parent repository files are byte-identical');
    assert.equal(memories.circuits('p').length, circuitsBefore);

    // a write to the parent after the fork does not reach the child either
    memories.addKnowledge('p', {circuits: [{name: 'later', text: fact('f8', 'zed', 'yan')}], approvedBy: 'admin'});
    assert.equal(parents(memories, child.id).includes('zed>yan'), false, 'the child did not change');

    // a session clone: session circuits and facts written in the session never reach the base memory
    const s = sessions.create({base: 'p', user: 'alice'});
    const baseBefore = snapshotOf(path.join(memories.dir('p'), 'repo'));
    sessions.addCircuit(s.id, {name: 'extra', text: fact('f7', 'sam', 'tom'), by: 'alice'});
    assert.ok(sessionParents(sessions, s.id).includes('sam>tom'));
    assert.equal(parents(memories, 'p').includes('sam>tom'), false, 'the base memory did not change');
    assert.deepEqual(snapshotOf(path.join(memories.dir('p'), 'repo')), baseBefore, 'the base repository files are byte-identical');
    const s2 = sessions.create({base: 'p', user: 'bob'});
    assert.equal(sessionParents(sessions, s2.id).includes('sam>tom'), false, 'a second session does not see the first');
  });
}

test('cloneRepository: only content-addressed files are hard-linked; a mutable SQLite file is copied by VACUUM INTO without -wal and -shm', t => {
  const dir = tempDir(t, 'clone-');
  const from = path.join(dir, 'from');
  fs.mkdirSync(path.join(from, 'snapshots'), {recursive: true});
  const hash = 'a'.repeat(64);
  fs.writeFileSync(path.join(from, 'snapshots', hash + '.json'), '{}');
  fs.writeFileSync(path.join(from, 'snapshots', 'mutable.json'), '{"a":1}');
  const {DatabaseSync} = createRequire(import.meta.url)('node:sqlite');
  const db = new DatabaseSync(path.join(from, 'bank.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES(1)');
  assert.ok(fs.existsSync(path.join(from, 'bank.sqlite-wal')), 'the source has a write-ahead log');
  cloneRepository(from, path.join(dir, 'to'));
  assert.equal(fs.statSync(path.join(from, 'snapshots', hash + '.json')).nlink, 2, 'the content-addressed file is linked');
  assert.equal(fs.statSync(path.join(from, 'snapshots', 'mutable.json')).nlink, 1, 'a file not named by its digest is copied');
  assert.equal(fs.existsSync(path.join(dir, 'to', 'bank.sqlite-wal')), false);
  db.exec('INSERT INTO t VALUES(2)');
  const copy = new DatabaseSync(path.join(dir, 'to', 'bank.sqlite'));
  assert.equal(copy.prepare('SELECT count(*) n FROM t').get().n, 1, 'the copy holds the state at clone time and is independent');
  db.exec('INSERT INTO t VALUES(3)');
  assert.equal(copy.prepare('SELECT count(*) n FROM t').get().n, 1);
  copy.close(); db.close();
});
