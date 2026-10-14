import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {ChatData, chatDataSettings, dropLegacyStorage, legacyStorage, assertFolderId} from '../../lib/chat-data/index.mjs';
import {repoPath, tempDir} from '../helpers.mjs';

const open = (t, extra = {}) => ChatData.open({chatData: {root: tempDir(t, 'chat-data-') + '/cd', ...extra}}, {});

test('chat data: layout is created under the configured root and env overrides it', t => {
  const data = open(t);
  for (const dir of ['base_memories', 'sessions', 'tmp']) assert.ok(fs.statSync(path.join(data.root, dir)).isDirectory());
  assert.equal(chatDataSettings({}, {}).root, repoPath('chat_data').replace(/\/$/, ''));
  assert.equal(chatDataSettings({}, {CHATSOP_CHAT_DATA: '/x/y'}).root, '/x/y');
  assert.throws(() => chatDataSettings({chatData: {tmpTtlHours: 0}}, {}), /tmpTtlHours/);
});

test('chat data: the root is gitignored and configured in config/runtime.json', () => {
  assert.match(fs.readFileSync(repoPath('.gitignore'), 'utf8'), /^chat_data\/$/m);
  assert.equal(JSON.parse(fs.readFileSync(repoPath('config/runtime.json'), 'utf8')).chatData.root, 'chat_data');
});

test('chat data: folder identifiers never name a path', () => {
  assert.equal(assertFolderId('ok-1_a'), 'ok-1_a');
  for (const bad of ['../x', 'a/b', '', 'A', '.hidden', 'x'.repeat(65), 5]) assert.throws(() => assertFolderId(bad), /Invalid/);
});

test('chat data: cleanup removes expired tmp folders and abandoned sessions, keeps live and kept ones, never base memories', t => {
  const data = open(t, {tmpTtlHours: 1, sessionTtlDays: 1});
  const now = Date.now();
  const old = new Date(now - 3 * 86400_000);
  const stale = data.tmpFolder('req');
  const fresh = data.tmpFolder('req');
  fs.utimesSync(stale, old, old);
  const session = (id, info) => {
    const dir = path.join(data.sessionsDir, id);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(info));
    fs.utimesSync(dir, new Date(now), new Date(now));
  };
  session('abandoned', {last_active_at: old.toISOString()});
  session('active', {last_active_at: new Date(now).toISOString()});
  session('pinned', {last_active_at: old.toISOString(), kept: true});
  fs.mkdirSync(path.join(data.baseMemoriesDir, 'base-a'));
  const dry = data.cleanup({now, dryRun: true});
  assert.deepEqual(dry.sessions, ['abandoned']);
  assert.equal(dry.tmp.length, 1);
  assert.ok(fs.existsSync(stale), 'a dry run deletes nothing');
  const report = data.cleanup({now});
  assert.deepEqual(report.kept, ['pinned']);
  assert.ok(!fs.existsSync(stale) && fs.existsSync(fresh));
  assert.ok(!fs.existsSync(path.join(data.sessionsDir, 'abandoned')));
  assert.ok(fs.existsSync(path.join(data.sessionsDir, 'active')) && fs.existsSync(path.join(data.sessionsDir, 'pinned')));
  assert.ok(fs.existsSync(path.join(data.baseMemoriesDir, 'base-a')));
});

test('chat data: a folder whose files changed recently is not an expired tmp folder', t => {
  const data = open(t, {tmpTtlHours: 1});
  const dir = data.tmpFolder('req');
  const old = new Date(Date.now() - 5 * 3600_000);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  fs.utimesSync(dir, old, old);
  assert.deepEqual(data.cleanup({dryRun: true}).tmp, [], 'the new file is newer than the folder');
});

test('chat data: drop-legacy removes only the old chat storage under state/', t => {
  const state = tempDir(t, 'state-');
  for (const name of ['snapshots', 'shards', 'sessions', 'http-conversations', 'cache', 'formalizer-logs']) fs.mkdirSync(path.join(state, name));
  fs.writeFileSync(path.join(state, 'index.json'), '{}');
  fs.writeFileSync(path.join(state, 'auth.json'), '{}');
  assert.equal(legacyStorage(state).length, 5);
  const dry = dropLegacyStorage(state, {dryRun: true});
  assert.equal(dry.removed.length, 5);
  assert.ok(fs.existsSync(path.join(state, 'snapshots')));
  dropLegacyStorage(state);
  assert.deepEqual(fs.readdirSync(state).sort(), ['auth.json', 'cache', 'formalizer-logs']);
});
